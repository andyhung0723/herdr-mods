#!/usr/bin/env python3
"""Install Herdr Markdown Preview mods (Pane, Overlay, and Enhanced Files).

Performs herdr-app check validation, backups, and safe installation.
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

MOD_PREVIEW = "markdown-preview"
MOD_FILES = "enhanced-files"
SHORTCUT_TMUX = "ctrl-b m"
SHORTCUT_CMD = "cmd-shift-m"
ACTION_OPEN = "mod.open:markdown-preview"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Markdown Preview")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--layout",
        default="main-popup",
        help="Personal layout to enable enhanced files (default: main-popup)",
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

    if SHORTCUT_TMUX not in global_keys or global_keys[SHORTCUT_TMUX] != ACTION_OPEN:
        global_keys[SHORTCUT_TMUX] = ACTION_OPEN
        changed = True

    if changed:
        if dry_run:
            print(f"[dry-run] Add keybinding '{SHORTCUT_TMUX}': '{ACTION_OPEN}' in keys.json")
        else:
            if keys_path.exists():
                bk = backup_file(keys_path, backups_dir)
                print(f"Backed up keys.json to {bk}")
            keys_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            print(f"Updated keys.json with shortcut {SHORTCUT_TMUX} -> {ACTION_OPEN}")
    else:
        print(f"Keys already configured for {SHORTCUT_TMUX}")


def update_layout_files(layout_path: Path, backups_dir: Path, dry_run: bool) -> None:
    if not layout_path.exists():
        print(f"Layout file {layout_path} does not exist, skipping layout update")
        return

    try:
        data = json.loads(layout_path.read_text("utf-8"))
    except Exception as e:
        raise InstallError(f"Failed to parse layout {layout_path}: {e}")

    # Walk layout to replace mod "files" with "enhanced-files"
    changed = False

    def replace_files_mod(node: Any) -> None:
        nonlocal changed
        if isinstance(node, dict):
            content = node.get("content")
            if isinstance(content, dict) and content.get("mod") == "files":
                content["mod"] = MOD_FILES
                changed = True
            for v in node.values():
                replace_files_mod(v)
        elif isinstance(node, list):
            for item in node:
                replace_files_mod(item)

    replace_files_mod(data)

    if changed:
        if dry_run:
            print(f"[dry-run] Update layout {layout_path.name} to use mod '{MOD_FILES}'")
        else:
            bk = backup_file(layout_path, backups_dir)
            print(f"Backed up {layout_path.name} to {bk}")
            layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
            print(f"Updated {layout_path.name} with {MOD_FILES}")
    else:
        print(f"Layout {layout_path.name} already references {MOD_FILES} or has no files mod")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    preview_src = source_root / "mods" / MOD_PREVIEW
    files_src = source_root / "mods" / MOD_FILES

    if not preview_src.exists() or not files_src.exists():
        print("Error: Missing mod source folders in repository", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check...")
    try:
        run_mod_check(preview_src, home)
        print(f"✔ {MOD_PREVIEW} passed check")
        run_mod_check(files_src, home)
        print(f"✔ {MOD_FILES} passed check")
    except InstallError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(preview_src, mods_dir / MOD_PREVIEW, args.dry_run)
        copy_mod(files_src, mods_dir / MOD_FILES, args.dry_run)

        keys_path = home / "keys.json"
        update_keys_json(keys_path, backups_dir, args.dry_run)

        layout_path = home / "layouts" / f"{args.layout}.json"
        update_layout_files(layout_path, backups_dir, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Markdown Preview installed successfully!")
    print("\nUsage:")
    print("  1. Overlay / Popup: Press Ctrl+B M (or run: herdr-app do mod.open '{\"name\":\"markdown-preview\"}')")
    print("  2. Split Pane: Run: herdr-app do pane.split '{\"direction\":\"right\",\"mod\":\"markdown-preview\"}'")
    print("  3. Enhanced Files: Click any .md file in the Files panel to preview with toggle and split buttons!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
