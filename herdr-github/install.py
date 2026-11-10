#!/usr/bin/env python3
"""Install Herdr GitHub Hub mod and configure shortcut and help cheatsheet."""

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

MOD_NAME = "github-hub"
SHORTCUT_KEY = "ctrl-b shift-g"
ACTION_OPEN = f"mod.open:{MOD_NAME}"
HELP_DESCRIPTION = "GitHub Hub (PRs, Actions CI, Issues)"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr GitHub Hub")
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
    existing = global_keys.get(SHORTCUT_KEY)
    if existing == ACTION_OPEN:
        print(f"Keys already configured for {SHORTCUT_KEY}")
        return
    if existing:
        raise InstallError(f"{SHORTCUT_KEY} is already bound to '{existing}'; pick another key")

    global_keys[SHORTCUT_KEY] = ACTION_OPEN
    if dry_run:
        print(f"[dry-run] Add keybinding '{SHORTCUT_KEY}': '{ACTION_OPEN}' in keys.json")
        return
    if keys_path.exists():
        bk = backup_file(keys_path, backups_dir)
        print(f"Backed up keys.json to {bk}")
    keys_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"Updated keys.json with shortcut {SHORTCUT_KEY} -> {ACTION_OPEN}")


def update_help_cheatsheet(help_main: Path, backups_dir: Path, dry_run: bool) -> None:
    if not help_main.exists():
        return
    content = help_main.read_text("utf-8")
    if ACTION_OPEN in content:
        print("Help cheatsheet already includes GitHub Hub action")
        return

    # Look for FRIENDLY_LABELS map in help-edited/main.js
    needle = "const FRIENDLY_LABELS = {"
    idx = content.find(needle)
    if idx == -1:
        print("Note: FRIENDLY_LABELS not found in help-edited/main.js; skipping help update")
        return

    insertion = f'\n  "{ACTION_OPEN}": "{HELP_DESCRIPTION}",'
    new_content = content[: idx + len(needle)] + insertion + content[idx + len(needle) :]

    if dry_run:
        print(f"[dry-run] Register action in {help_main}")
        return

    bk = backup_file(help_main, backups_dir)
    print(f"Backed up {help_main.name} to {bk}")
    help_main.write_text(new_content, "utf-8")
    print(f"Updated {help_main} with action description: {HELP_DESCRIPTION}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on github-hub mod...")
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
        print(f"Error: github-hub mod failed check: {res.stdout} {res.stderr}", file=sys.stderr)
        return 1
    print("✔ github-hub mod passed check")

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_src, mods_dir / MOD_NAME, args.dry_run)
        update_keys_json(home / "keys.json", backups_dir, args.dry_run)
        update_help_cheatsheet(home / "mods" / "help-edited" / "main.js", backups_dir, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Herdr GitHub Hub mod installed successfully!")
    print("\nFeatures:")
    print("  - Press [Ctrl+B Shift+G] to open GitHub Hub dialog")
    print("  - 🔀 Pull Requests: Browse, open in GitHub, or 'Review with Agent'")
    print("  - 🟢 Actions & CI: View build status, and 'Fix with Agent' on failures")
    print("  - 🎫 Issues: Browse open issues, and 'Start with Agent'")
    print("  - Registered in Help Cheatsheet [Ctrl+B H]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
