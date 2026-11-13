#!/usr/bin/env python3
"""Install enhanced Help mod into Herdr app home and ensure keybindings."""

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

MOD_NAME = "enhanced-help"
HELP_ACTION = f"mod.open:{MOD_NAME}"
AGENT_INSPECTOR_KEY = "ctrl-b shift-a"
AGENT_INSPECTOR_ACTION = "mod.open:enhanced-agent-context"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Enhanced Herdr Help")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
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
    data: dict[str, Any] = {}
    if keys_path.exists():
        try:
            data = json.loads(keys_path.read_text("utf-8"))
        except Exception as e:
            raise InstallError(f"Failed to read keys.json: {e}")

    global_keys = data.setdefault("global", {})
    
    # Bind ctrl-b h and ctrl-b ? to enhanced-help
    global_keys["ctrl-b h"] = HELP_ACTION
    global_keys["ctrl-b ?"] = HELP_ACTION

    existing = global_keys.get(AGENT_INSPECTOR_KEY)
    if not existing:
        global_keys[AGENT_INSPECTOR_KEY] = AGENT_INSPECTOR_ACTION

    if dry_run:
        print(f"[dry-run] Add keybindings for {HELP_ACTION} in keys.json")
        return
    if keys_path.exists():
        bk = backup_file(keys_path, backups_dir)
        print(f"Backed up keys.json to {bk}")
    keys_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"Updated keys.json: ctrl-b h -> {HELP_ACTION}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on enhanced-help mod...")
    child_env = os.environ.copy()
    child_env["HERDR_APP_HOME"] = str(home)
    res = subprocess.run(
        ["herdr-app", "check", str(mod_src)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        env=child_env,
    )
    if res.returncode != 0:
        print(f"Error: enhanced-help mod failed check: {res.stdout} {res.stderr}", file=sys.stderr)
        return 1
    print("✔ enhanced-help mod passed check")

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_src, mods_dir / MOD_NAME, args.dry_run)
        update_keys_json(home / "keys.json", backups_dir, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Enhanced Help & Agent Inspector shortcut installed successfully!")
    print("\nUsage:")
    print("  1. Press Ctrl+B H or Ctrl+B ? to view the enhanced cheat sheet with 'Custom Mods & Extensions' at the top")
    print(f"  2. Press {AGENT_INSPECTOR_KEY} to open Agent Inspector")
    return 0


if __name__ == "__main__":
    sys.exit(main())
