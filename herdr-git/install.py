#!/usr/bin/env python3
"""Install Herdr Enhanced Git mod into personal layout and keys.json.

Includes validation, safe backups, layout replacement (changes -> enhanced-git),
and shortcut registration (Ctrl+B g).
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

MOD_NAME = "enhanced-git"
SHORTCUT_KEY = "ctrl-b g"
ACTION_OPEN = f"mod.open:{MOD_NAME}"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Enhanced Git")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--layout",
        default="main-popup",
        help="Personal layout to enable enhanced git (default: main-popup)",
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


def update_layout_changes(layout_path: Path, backups_dir: Path, dry_run: bool) -> None:
    if not layout_path.exists():
        print(f"Layout file {layout_path} does not exist, skipping layout update")
        return

    try:
        data = json.loads(layout_path.read_text("utf-8"))
    except Exception as e:
        raise InstallError(f"Failed to parse layout {layout_path}: {e}")

    replaced = False

    def replace_node(node: Any) -> None:
        nonlocal replaced
        if isinstance(node, dict):
            if node.get("id") == "changes" and isinstance(node.get("content"), dict):
                content = node["content"]
                if content.get("mod") == "changes":
                    content["mod"] = MOD_NAME
                    replaced = True
            for v in node.values():
                replace_node(v)
        elif isinstance(node, list):
            for item in node:
                replace_node(item)

    replace_node(data)

    if replaced:
        if dry_run:
            print(f"[dry-run] Replace changes mod with {MOD_NAME} in {layout_path.name}")
        else:
            bk = backup_file(layout_path, backups_dir)
            print(f"Backed up layout {layout_path.name} to {bk}")
            layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            print(f"Updated layout {layout_path.name} with {MOD_NAME}")
    else:
        print(f"Layout {layout_path.name} already uses {MOD_NAME} or no changes block found")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    home = resolve_home(args.home)
    repo_root = Path(__file__).resolve().parent
    mod_src = repo_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: mod source directory {mod_src} not found", file=sys.stderr)
        return 1

    backups_dir = home / "backups"
    if not args.dry_run:
        backups_dir.mkdir(parents=True, exist_ok=True)

    print(f"Validating mod {MOD_NAME} with herdr-app check...")
    run_mod_check(mod_src, home)
    print("Mod check passed.")

    mod_dest = home / "mods" / MOD_NAME
    copy_mod(mod_src, mod_dest, args.dry_run)

    keys_path = home / "keys.json"
    update_keys_json(keys_path, backups_dir, args.dry_run)

    layout_path = home / "layouts" / f"{args.layout}.json"
    update_layout_changes(layout_path, backups_dir, args.dry_run)

    print("\nEnhanced Git installation complete!")
    print(f"- Panel: replaced 'changes' in layout {args.layout}")
    print(f"- Shortcut: {SHORTCUT_KEY} opens full Git Graph and Manager overlay")
    return 0


if __name__ == "__main__":
    sys.exit(main())
