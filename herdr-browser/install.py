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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MOD_SIDEBAR = "agent-browser-sidebar"
MOD_MAIN = "agent-browser-main"


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
                if not any(c.get("id") == "agent-browser" for c in children if isinstance(c, dict)):
                    children.append({
                        "id": "agent-browser",
                        "type": "block",
                        "content": {
                            "mod": MOD_SIDEBAR
                        },
                        "size": {
                            "px": 92
                        },
                        "min": 70,
                        "max": 140
                    })
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


def update_mcp_configs(source_root: Path, dry_run: bool) -> None:
    # Update Claude Code config in ~/.claude.json
    claude_json_path = Path.home() / ".claude.json"
    mcp_script = source_root / "daemon" / "mcp-server.mjs"

    if claude_json_path.exists():
        try:
            cfg = json.loads(claude_json_path.read_text("utf-8"))
            mcp_servers = cfg.setdefault("mcpServers", {})
            mcp_servers["herdr-browser"] = {
                "command": "node",
                "args": [str(mcp_script), "--agent=claude"],
            }
            if dry_run:
                print(f"[dry-run] Configure herdr-browser MCP in {claude_json_path}")
            else:
                claude_json_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", "utf-8")
                print(f"Configured herdr-browser MCP server in {claude_json_path}")
        except Exception as e:
            print(f"Notice: Could not update {claude_json_path}: {e}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_sidebar_src = source_root / "mods" / MOD_SIDEBAR
    mod_main_src = source_root / "mods" / MOD_MAIN

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on browser mods...")
    try:
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

        update_mcp_configs(source_root, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Herdr Agent Browser Hub installed successfully!")
    print("\nNext steps:")
    print("  1. Start the Browser Hub Daemon in a background terminal:")
    print(f"     node {source_root / 'daemon' / 'server.mjs'}")
    print("  2. In Claude Code, run:")
    print("     claude --mcp herdr-browser")
    print("  3. Check the left sidebar in Herdr for the 'Agent Browser' card and click to open!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
