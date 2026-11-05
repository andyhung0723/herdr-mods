#!/usr/bin/env python3
"""Install Herdr Enhanced Files mod with VS Code file explorer capabilities.

Includes:
- Safe timestamped backups
- Copying mod to ~/.config/herdr-app/mods/enhanced-files
- Running herdr-app check validation
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MOD_NAME = "enhanced-files"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Enhanced Files (VS Code style)")
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


def run_mod_check(mod_dir: Path, home: Path) -> None:
    child_env = os.environ.copy()
    child_env["HERDR_APP_HOME"] = str(home)
    cmd = ["herdr-app", "check", str(mod_dir)]
    try:
        proc = subprocess.run(cmd, env=child_env, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return
    if proc.returncode != 0:
        details = (proc.stderr or proc.stdout).strip()
        raise InstallError(f"Mod check failed for {mod_dir}: {details}")


def create_backup(home: Path, target_dir: Path, dry_run: bool) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = home / ".backups" / f"files_install_{stamp}"
    if dry_run:
        print(f"[dry-run] create backup dir: {backup_dir}")
        if target_dir.exists():
            print(f"[dry-run] backup {target_dir} -> {backup_dir / target_dir.name}")
        return backup_dir

    backup_dir.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        shutil.copytree(target_dir, backup_dir / target_dir.name, dirs_exist_ok=True)
    return backup_dir


def copy_mod_files(source_dir: Path, target_dir: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] copy mod tree: {source_dir} -> {target_dir}")
        return

    target_dir.mkdir(parents=True, exist_ok=True)
    for src in source_dir.rglob("*"):
        if src.is_file() and not src.name.startswith("."):
            rel = src.relative_to(source_dir)
            dst = target_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    print(f"Copied mod files to {target_dir}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    home = resolve_home(args.home)
    repo_root = Path(__file__).resolve().parent

    source_mod_dir = repo_root / "mods" / MOD_NAME
    target_mod_dir = home / "mods" / MOD_NAME

    if not source_mod_dir.is_dir():
        raise InstallError(f"Source mod dir not found: {source_mod_dir}")

    # Validate source mod first
    run_mod_check(source_mod_dir, home)

    # Backup existing
    backup_dir = create_backup(home, target_mod_dir, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    # Copy files
    copy_mod_files(source_mod_dir, target_mod_dir, args.dry_run)

    # Validate target mod
    if not args.dry_run:
        run_mod_check(target_mod_dir, home)

    print(
        f"\nSuccessfully upgraded {MOD_NAME}!\n"
        f"- VS Code actions: New File, New Folder, Rename (F2), Delete (Trash), Move/Cut/Paste\n"
        f"- Path Finder integration: 'Reveal in Path Finder'"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InstallError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
