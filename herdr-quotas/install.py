#!/usr/bin/env python3
"""Install Herdr Agent Quotas mod into personal layout and keys.json.

Includes validation, safe backups, layout insertion, and dry-run mode.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MOD_NAME = "agent-quotas"
SHORTCUT_KEY = "ctrl-b q"
ACTION_OPEN = f"mod.open:{MOD_NAME}"
WIDGET_ID = "agent-quotas-sidebar"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Agent Quotas")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--layout",
        default="main-popup",
        help="Personal layout to enable sidebar widget (default: main-popup)",
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


def update_keys_json(keys_path: Path, backups_dir: Path, dry_run: bool) -> None:
    data = {}
    if keys_path.exists():
        try:
            data = json.loads(keys_path.read_text("utf-8"))
        except Exception as e:
            raise InstallError(f"Failed to read keys.json: {e}")

    global_keys = data.setdefault("global", {})
    changed = False

    if SHORTCUT_KEY not in global_keys or global_keys[SHORTCUT_KEY] != ACTION_OPEN:
        global_keys[SHORTCUT_KEY] = ACTION_OPEN
        changed = True

    if changed:
        if dry_run:
            print(f"[dry-run] Add keybinding '{SHORTCUT_KEY}': '{ACTION_OPEN}' in keys.json")
        else:
            if keys_path.exists():
                bk = backup_file(keys_path, backups_dir)
                print(f"Backed up keys.json to {bk}")
            keys_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            print(f"Updated keys.json with shortcut {SHORTCUT_KEY} -> {ACTION_OPEN}")
    else:
        print(f"Keys already configured for {SHORTCUT_KEY}")


def update_layout_sidebar(layout_path: Path, backups_dir: Path, dry_run: bool) -> None:
    if not layout_path.exists():
        print(f"Layout file {layout_path} does not exist, skipping layout update")
        return

    try:
        data = json.loads(layout_path.read_text("utf-8"))
    except Exception as e:
        raise InstallError(f"Failed to parse layout {layout_path}: {e}")

    # Check if widget is already present
    widget_exists = False

    def check_node(node: Any) -> None:
        nonlocal widget_exists
        if isinstance(node, dict):
            if node.get("id") == WIDGET_ID:
                widget_exists = True
            for v in node.values():
                check_node(v)
        elif isinstance(node, list):
            for item in node:
                check_node(item)

    check_node(data)
    if widget_exists:
        print(f"Widget {WIDGET_ID} already present in {layout_path.name}")
        return

    # Find "sidebar-lists" and insert widget as last child
    inserted = False

    def insert_widget(node: Any) -> None:
        nonlocal inserted
        if isinstance(node, dict):
            if node.get("id") == "sidebar-lists" and isinstance(node.get("children"), list):
                widget_node = {
                    "id": WIDGET_ID,
                    "type": "block",
                    "content": {
                        "mod": MOD_NAME,
                        "props": {
                            "role": "widget"
                        }
                    },
                    "size": {
                        "px": 96
                    },
                    "min": 80,
                    "max": 130
                }
                node["children"].append(widget_node)
                inserted = True
                return
            for v in node.values():
                insert_widget(v)
        elif isinstance(node, list):
            for item in node:
                insert_widget(item)

    insert_widget(data)

    if inserted:
        if dry_run:
            print(f"[dry-run] Insert widget {WIDGET_ID} into {layout_path.name}")
        else:
            bk = backup_file(layout_path, backups_dir)
            print(f"Backed up {layout_path.name} to {bk}")
            layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            print(f"Updated {layout_path.name} with {WIDGET_ID}")
    else:
        print(f"Could not locate 'sidebar-lists' in {layout_path.name}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check...")
    try:
        run_mod_check(mod_src, home)
        print(f"✔ {MOD_NAME} passed check")
    except InstallError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_src, mods_dir / MOD_NAME, args.dry_run)

        keys_path = home / "keys.json"
        update_keys_json(keys_path, backups_dir, args.dry_run)

        layout_path = home / "layouts" / f"{args.layout}.json"
        update_layout_sidebar(layout_path, backups_dir, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Agent Quotas installed successfully!")
    print("\nUsage:")
    print("  1. Sidebar Widget: Appears in the left sidebar under Agents (click to expand)")
    print("  2. Popup Dashboard: Press Ctrl+B Q (or run: herdr-app do mod.open '{\"name\":\"agent-quotas\"}')")
    return 0


if __name__ == "__main__":
    sys.exit(main())
