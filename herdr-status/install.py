#!/usr/bin/env python3
"""Install Enhanced Workspace Status (with YouTube Music Now Playing in bottom-right corner)."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MOD_NAME = "workspace-status"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Enhanced Workspace Status")
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


def backup_dir(src: Path, backups_dir: Path) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = backups_dir / f"{src.name}-{ts}"
    shutil.copytree(src, dest)
    return dest


def copy_mod(src: Path, dest: Path, backups_dir: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] Copy mod {src.name} -> {dest}")
        return
    if dest.exists():
        bk = backup_dir(dest, backups_dir)
        print(f"Backed up existing mod to {bk}")
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    print(f"Installed mod: {dest}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on workspace-status mod...")
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
        print(f"Error: workspace-status mod failed check: {res.stdout} {res.stderr}", file=sys.stderr)
        return 1
    print("✔ workspace-status mod passed check")

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_src, mods_dir / MOD_NAME, backups_dir, args.dry_run)
    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Enhanced Workspace Status (YouTube Music bottom-right widget) installed successfully!")
    print("\nFeatures:")
    print("  - When YouTube Music plays, displays '▶ ♫ Song • Artist' in bottom-right status bar")
    print("  - Click on title to bring YouTube Music app to front")
    print("  - Click ⏸/▶ to toggle play/pause")
    return 0


if __name__ == "__main__":
    sys.exit(main())
