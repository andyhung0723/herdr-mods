#!/usr/bin/env python3
"""Scanner for local listening ports, running dev processes, and Docker containers.

Outputs JSON for Herdr services-inspector mod.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

DEV_PROCESS_NAMES = {
    "node", "npm", "pnpm", "yarn", "bun", "deno",
    "vite", "next", "astro", "nuxt", "webpack", "esbuild",
    "python", "python3", "uvicorn", "gunicorn", "flask", "django", "fastapi",
    "ruby", "rails", "puma",
    "go", "air", "gin",
    "cargo", "rust",
    "php", "artisan",
    "postgres", "postgresd", "redis-server", "mongod", "mysqld",
    "caddy", "nginx", "httpd", "live-server", "serve",
}

DEV_PORT_RANGES = [
    (3000, 3100),   # Node, React, Next.js, Rails
    (4000, 4200),   # Hexo, Jekyll, Angular
    (5000, 5200),   # Flask, macOS AirPlay (5000)
    (5173, 5180),   # Vite
    (8000, 8100),   # Django, FastAPI, HTTP dev
    (8080, 8090),   # Vue, Spring, TomCat, proxy
    (9000, 9100),   # PHP, SonarQube, Prometheus
    (5432, 5433),   # PostgreSQL
    (6379, 6380),   # Redis
    (27017, 27018), # MongoDB
    (3306, 3307),   # MySQL
]

PROTECTED_PROCESSES = {
    "launchd", "kernel_task", "ControlCenter", "ControlCe", "rapportd",
    "identityservicesd", "sharingd", "AirPlayXPCHelper",
    "mDNSResponder", "syslogd", "opendirectoryd", "trustd",
}


def is_dev_port(port: int, cmd_name: str) -> bool:
    cmd_lower = cmd_name.lower()
    for prot in PROTECTED_PROCESSES:
        if prot.lower() in cmd_lower or cmd_lower in prot.lower():
            return False
    for dev_name in DEV_PROCESS_NAMES:
        if dev_name in cmd_lower:
            return True
    for start, end in DEV_PORT_RANGES:
        if start <= port <= end:
            return True
    return False


def is_protected_process(pid: int, cmd_name: str, user: str, full_cmd: str = "") -> bool:
    if pid <= 100:
        return True
    cmd_lower = cmd_name.lower()
    full_lower = full_cmd.lower() if full_cmd else ""
    for prot in PROTECTED_PROCESSES:
        p_low = prot.lower()
        if p_low in cmd_lower or (len(cmd_lower) >= 5 and cmd_lower in p_low):
            return True
        if full_lower and p_low in full_lower:
            return True
    if user == "root":
        return True
    return False


def scan_ports() -> list[dict]:
    try:
        out = subprocess.check_output(
            ["lsof", "-iTCP", "-sTCP:LISTEN", "-n", "-P"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
    except Exception:
        return []

    lines = out.strip().split("\n")
    if len(lines) <= 1:
        return []

    ports_map: dict[str, dict] = {}
    pids_to_query: set[str] = set()

    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 9:
            continue
        cmd = parts[0]
        pid_str = parts[1]
        user = parts[2]
        proto = parts[4]
        name = parts[8]

        m = re.search(r":(\d+)$", name)
        if not m:
            continue
        try:
            port = int(m.group(1))
            pid = int(pid_str)
        except ValueError:
            continue

        key = f"{port}:{pid}"
        pids_to_query.add(pid_str)

        if key not in ports_map:
            ports_map[key] = {
                "port": port,
                "pid": pid,
                "name": cmd,
                "user": user,
                "address": name,
                "proto": proto,
                "command": cmd,
                "isDev": is_dev_port(port, cmd),
                "isProtected": is_protected_process(pid, cmd, user),
                "url": f"http://localhost:{port}" if port not in (5000, 7000) or not is_protected_process(pid, cmd, user) else "",
            }
        else:
            # Append protocol if dual-stack (IPv4 & IPv6)
            existing_proto = ports_map[key].get("proto", "")
            if proto not in existing_proto:
                ports_map[key]["proto"] = f"{existing_proto}/{proto}"

    # Batch query full command args with ps
    if pids_to_query:
        try:
            ps_out = subprocess.check_output(
                ["ps", "-p", ",".join(pids_to_query), "-o", "pid=,args="],
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=5,
            )
            for ps_line in ps_out.strip().split("\n"):
                parts = ps_line.strip().split(maxsplit=1)
                if len(parts) == 2:
                    p_id_str, full_args = parts[0], parts[1]
                    try:
                        p_id = int(p_id_str)
                    except ValueError:
                        continue
                    # Update all port entries with this pid
                    for entry in ports_map.values():
                        if entry["pid"] == p_id:
                            entry["command"] = full_args
                            entry["isProtected"] = is_protected_process(entry["pid"], entry["name"], entry["user"], full_args)
                            if entry["isProtected"]:
                                entry["isDev"] = False
                                entry["url"] = ""
                            else:
                                entry["isDev"] = is_dev_port(entry["port"], full_args)
                                if entry["isDev"] and not entry["url"]:
                                    entry["url"] = f"http://localhost:{entry['port']}"
        except Exception:
            pass

    # Sort: Dev ports first (by port), then others (by port)
    res = list(ports_map.values())
    res.sort(key=lambda x: (0 if x["isDev"] else 1, x["port"]))
    return res


def scan_docker() -> dict:
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return {
            "installed": False,
            "running": False,
            "containers": [],
            "error": "Docker CLI not found in PATH",
        }

    try:
        proc = subprocess.run(
            [docker_bin, "ps", "-a", "--format", "{{json .}}"],
            capture_output=True,
            text=True,
            timeout=4,
        )
        if proc.returncode != 0:
            err = proc.stderr.strip() or "Docker daemon not reachable"
            return {
                "installed": True,
                "running": False,
                "containers": [],
                "error": err,
            }

        containers = []
        for line in proc.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
                name = c.get("Names", "").lstrip("/")
                state = c.get("State", "").lower()
                containers.append({
                    "id": c.get("ID", "")[:12],
                    "names": name,
                    "image": c.get("Image", ""),
                    "status": c.get("Status", ""),
                    "state": state,
                    "ports": c.get("Ports", ""),
                    "created": c.get("CreatedAt", ""),
                })
            except Exception:
                continue

        # Sort: running first, then exited
        containers.sort(key=lambda x: (0 if x["state"] == "running" else 1, x["names"]))
        return {
            "installed": True,
            "running": True,
            "containers": containers,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {
            "installed": True,
            "running": False,
            "containers": [],
            "error": "Docker command timed out",
        }
    except Exception as e:
        return {
            "installed": True,
            "running": False,
            "containers": [],
            "error": str(e),
        }


def kill_pid(pid: int, sig_num: int = 15) -> dict:
    my_pid = os.getpid()
    if pid == my_pid or pid <= 100:
        return {"ok": False, "error": f"Cannot kill system or self PID {pid}"}

    # Verify process exists
    try:
        os.kill(pid, 0)
    except OSError:
        return {"ok": False, "error": f"Process PID {pid} does not exist"}

    try:
        target_sig = signal.SIGKILL if sig_num == 9 else signal.SIGTERM
        os.kill(pid, target_sig)
        return {"ok": True, "pid": pid, "signal": sig_num}
    except PermissionError:
        return {"ok": False, "error": f"Permission denied killing PID {pid}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def docker_action(container_id: str, action: str) -> dict:
    docker_bin = shutil.which("docker")
    if not docker_bin:
        return {"ok": False, "error": "Docker CLI not found"}

    if action not in ("start", "stop", "restart"):
        return {"ok": False, "error": f"Unsupported docker action: {action}"}

    try:
        proc = subprocess.run(
            [docker_bin, action, container_id],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            return {"ok": True, "container": container_id, "action": action}
        else:
            return {"ok": False, "error": proc.stderr.strip() or f"Failed to {action} {container_id}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Services & Ports scanner for Herdr")
    parser.add_argument("--action", default="scan", choices=["scan", "kill-pid", "docker-action"])
    parser.add_argument("--mode", default="all", choices=["all", "ports", "docker"])
    parser.add_argument("--pid", type=int, help="PID to kill")
    parser.add_argument("--signal", type=int, default=15, choices=[9, 15], help="Signal to send (15=SIGTERM, 9=SIGKILL)")
    parser.add_argument("--container", type=str, help="Container ID or name")
    parser.add_argument("--docker-action", default="restart", choices=["start", "stop", "restart"])

    args = parser.parse_args()

    if args.action == "kill-pid":
        if not args.pid:
            print(json.dumps({"ok": False, "error": "Missing --pid"}))
            return 1
        res = kill_pid(args.pid, args.signal)
        print(json.dumps(res))
        return 0 if res["ok"] else 1

    if args.action == "docker-action":
        if not args.container:
            print(json.dumps({"ok": False, "error": "Missing --container"}))
            return 1
        res = docker_action(args.container, args.docker_action)
        print(json.dumps(res))
        return 0 if res["ok"] else 1

    # Scan mode
    data: dict = {
        "timestamp": time.time(),
        "ports": scan_ports() if args.mode in ("all", "ports") else [],
        "docker": scan_docker() if args.mode in ("all", "docker") else None,
    }
    print(json.dumps(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
