#!/usr/bin/env python3
"""Install Herdr Agent Browser Hub: Mods, Layout, and MCP Configuration.

Includes validation, safe backups, layout stack insertion, and dry-run mode.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MOD_SIDEBAR = "agent-browser-sidebar"
MOD_MAIN = "agent-browser-main"
MCP_NAME = "herdr-browser"
SHARED_MOD_FILES = ["daemon-client.js"]

SIDEBAR_BLOCK_SIZE = {"size": {"px": 132}, "min": 70, "max": 280}
LEGACY_SIDEBAR_BLOCK_SIZE = {"size": {"px": 92}, "min": 70, "max": 140}


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Agent Browser Hub")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--layout",
        default="main-popup",
        help="Personal layout to configure (default: main-popup)",
    )
    parser.add_argument(
        "--skip-mcp",
        action="store_true",
        help="Do not register the herdr-browser MCP server",
    )
    parser.add_argument(
        "--loadout-manifest",
        type=Path,
        help="agent-loadout manifest (default: $LOADOUT_MANIFEST or ~/.config/agent-loadout/loadout.toml)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print plan without writing",
    )
    return parser.parse_args(argv)


def resolve_home(user_home: Path | None) -> Path:
    if user_home is not None:
        return user_home.expanduser().resolve()
    env = os.environ.get("HERDR_APP_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".config" / "herdr-app").resolve()


def run_mod_check(mod_dir: Path, home: Path) -> None:
    child_env = os.environ.copy()
    child_env["HERDR_APP_HOME"] = str(home)
    try:
        res = subprocess.run(
            ["herdr-app", "check", str(mod_dir)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env=child_env,
        )
    except FileNotFoundError:
        raise InstallError("Cannot find herdr-app CLI in PATH")
    if res.returncode != 0:
        details = (res.stdout + res.stderr).strip()
        raise InstallError(f"Mod {mod_dir.name} failed herdr-app check: {details}")


def backup_file(path: Path, backups_dir: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = backups_dir / f"{path.stem}-{ts}{path.suffix}"
    shutil.copy2(path, dest)
    return dest


def assert_shared_files_in_sync(mods_root: Path) -> None:
    for name in SHARED_MOD_FILES:
        sidebar = (mods_root / MOD_SIDEBAR / name).read_bytes()
        main = (mods_root / MOD_MAIN / name).read_bytes()
        if sidebar != main:
            raise InstallError(f"{name} differs between {MOD_SIDEBAR} and {MOD_MAIN}; keep both copies identical")


def copy_mod(src: Path, dest: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] Copy mod {src.name} -> {dest}")
        return
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    print(f"Installed mod: {dest}")


def update_layout(layout_path: Path, backups_dir: Path, dry_run: bool) -> None:
    if not layout_path.exists():
        print(f"Layout file {layout_path} does not exist, skipping")
        return

    try:
        data = json.loads(layout_path.read_text("utf-8"))
    except Exception as e:
        raise InstallError(f"Failed to parse layout {layout_path}: {e}")

    changed = False

    # 1. Insert agent-browser-sidebar into sidebar-lists
    def update_sidebar(node: Any) -> None:
        nonlocal changed
        if isinstance(node, dict):
            if node.get("id") == "sidebar-lists" and isinstance(node.get("children"), list):
                children = node["children"]
                existing = next((c for c in children if isinstance(c, dict) and c.get("id") == "agent-browser"), None)
                if existing is None:
                    children.append({"id": "agent-browser", "type": "block", "content": {"mod": MOD_SIDEBAR}, **SIDEBAR_BLOCK_SIZE})
                    changed = True
                elif all(existing.get(k) == v for k, v in LEGACY_SIDEBAR_BLOCK_SIZE.items()):
                    # Session rows grew to three lines; only resize blocks still at the old defaults.
                    existing.update(SIDEBAR_BLOCK_SIZE)
                    changed = True
            for v in node.values():
                update_sidebar(v)
        elif isinstance(node, list):
            for item in node:
                update_sidebar(item)

    update_sidebar(data)

    # 2. Wrap main into work-main-stack if not already wrapped
    def update_work_body(node: Any) -> None:
        nonlocal changed
        if isinstance(node, dict):
            if node.get("id") == "work-body" and isinstance(node.get("children"), list):
                children = node["children"]
                for i, child in enumerate(children):
                    if isinstance(child, dict):
                        # If already a stack, ensure browser-main is inside
                        if child.get("id") == "work-main-stack" and isinstance(child.get("children"), list):
                            stack_children = child["children"]
                            if not any(sc.get("id") == "browser-main" for sc in stack_children if isinstance(sc, dict)):
                                stack_children.append({
                                    "id": "browser-main",
                                    "type": "block",
                                    "content": {
                                        "mod": MOD_MAIN
                                    }
                                })
                                changed = True
                        # If still plain main, wrap it into stack
                        elif child.get("id") == "main":
                            wrapped_stack = {
                                "id": "work-main-stack",
                                "type": "stack",
                                "active": "main-terminals",
                                "children": [
                                    {
                                        "id": "main-terminals",
                                        "type": "block",
                                        "content": child.get("content", {})
                                    },
                                    {
                                        "id": "browser-main",
                                        "type": "block",
                                        "content": {
                                            "mod": MOD_MAIN
                                        }
                                    }
                                ]
                            }
                            children[i] = wrapped_stack
                            changed = True
            for v in node.values():
                update_work_body(v)
        elif isinstance(node, list):
            for item in node:
                update_work_body(item)

    update_work_body(data)

    if changed:
        if dry_run:
            print(f"[dry-run] Update layout {layout_path.name} with browser stack and sidebar widget")
        else:
            bk = backup_file(layout_path, backups_dir)
            print(f"Backed up {layout_path.name} to {bk}")
            layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            try:
                subprocess.run(
                    ["herdr-app", "do", "layout.set", json.dumps({"layout": data})],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
            except Exception:
                pass
            print(f"Updated {layout_path.name} with work-main-stack and agent-browser-sidebar")
    else:
        print(f"Layout {layout_path.name} already configured for browser hub")


def loadout_manifest_path(override: Path | None) -> Path:
    if override is not None:
        return override.expanduser()
    env = os.environ.get("LOADOUT_MANIFEST")
    return Path(env).expanduser() if env else Path.home() / ".config" / "agent-loadout" / "loadout.toml"


def mcp_manifest_entry(mcp_script: Path) -> str:
    # Codex forwards only listed env vars to MCP servers; HC_TERMINAL_ID gives
    # each agent pane its own browser session. Claude Code inherits the env.
    return (
        "\n[[mcp]]\n"
        f'name = "{MCP_NAME}"\n'
        'command = "node"\n'
        f"args = [{json.dumps(str(mcp_script))}]\n"
        'to = ["tool:claude", "tool:codex"]\n'
        "[mcp.codex]\n"
        'env_vars = ["HC_TERMINAL_ID"]\n'
    )


def register_mcp(source_root: Path, manifest: Path, backups_dir: Path, dry_run: bool) -> None:
    mcp_script = source_root / "daemon" / "mcp-server.mjs"
    if shutil.which("loadout") is None or not manifest.exists():
        print("loadout not found; register the MCP server manually:")
        print(f"  claude mcp add -s user {MCP_NAME} -- node {mcp_script}")
        print(f"  codex: [mcp_servers.{MCP_NAME}] command = \"node\", args = [\"{mcp_script}\"], env_vars = [\"HC_TERMINAL_ID\"]")
        return

    entries = tomllib.loads(manifest.read_text("utf-8")).get("mcp", [])
    existing = next((e for e in entries if e.get("name") == MCP_NAME), None)
    if existing is None:
        if dry_run:
            print(f"[dry-run] Append mcp:{MCP_NAME} to {manifest}:{mcp_manifest_entry(mcp_script)}")
            return
        bk = backup_file(manifest, backups_dir)
        print(f"Backed up {manifest.name} to {bk}")
        with manifest.open("a", encoding="utf-8") as f:
            f.write(mcp_manifest_entry(mcp_script))
        print(f"Added mcp:{MCP_NAME} to {manifest}")
    elif existing.get("args") != [str(mcp_script)]:
        print(f"Notice: mcp:{MCP_NAME} already in {manifest} with args {existing.get('args')}; leaving it as is")

    cmd = ["loadout", "--manifest", str(manifest), "plan" if dry_run else "apply", "--only", f"mcp:{MCP_NAME}"]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    print((res.stdout + res.stderr).strip())
    if res.returncode != 0:
        raise InstallError(f"{' '.join(cmd)} failed")


def warn_legacy_claude_json(source_root: Path) -> None:
    # Older installers wrote ~/.claude.json directly, which loadout-managed
    # setups (CLAUDE_CONFIG_DIR) never read.
    legacy = Path.home() / ".claude.json"
    try:
        servers = json.loads(legacy.read_text("utf-8")).get("mcpServers", {})
    except (OSError, ValueError):
        return
    if MCP_NAME in servers and str(source_root) in json.dumps(servers[MCP_NAME]):
        print(f"Notice: stale {MCP_NAME} entry from an older installer remains in {legacy} (safe to remove).")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_sidebar_src = source_root / "mods" / MOD_SIDEBAR
    mod_main_src = source_root / "mods" / MOD_MAIN

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on browser mods...")
    try:
        assert_shared_files_in_sync(source_root / "mods")
        run_mod_check(mod_sidebar_src, home)
        print(f"✔ {MOD_SIDEBAR} passed check")
        run_mod_check(mod_main_src, home)
        print(f"✔ {MOD_MAIN} passed check")
    except InstallError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_sidebar_src, mods_dir / MOD_SIDEBAR, args.dry_run)
        copy_mod(mod_main_src, mods_dir / MOD_MAIN, args.dry_run)

        layout_path = home / "layouts" / f"{args.layout}.json"
        update_layout(layout_path, backups_dir, args.dry_run)

        if not args.skip_mcp:
            register_mcp(source_root, loadout_manifest_path(args.loadout_manifest), backups_dir, args.dry_run)
            warn_legacy_claude_json(source_root)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Herdr Agent Browser Hub installed successfully!")
    print("\nNext steps:")
    print("  1. Restart Claude Code / Codex sessions so they load the herdr-browser MCP server.")
    print("  2. Ask an agent to use browser_navigate; the daemon starts on the first call.")
    print("  3. Click the agent's card in Herdr's 'Agent Browser' sidebar widget to watch or take over.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
