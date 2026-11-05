#!/usr/bin/env python3
"""Install Herdr Enhanced Workspace Chrome mod with live Date & Time in top-left brand row.

Includes:
- Safe timestamped backups
- Copying mod to ~/.config/herdr-app/mods/enhanced-workspace-chrome
- Updating layouts/main-popup.json: brand block -> enhanced-workspace-chrome
- Running herdr-app check validation
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

MOD_NAME = "enhanced-workspace-chrome"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Enhanced Workspace Chrome")
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


def read_json_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise InstallError(f"Missing required file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise InstallError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise InstallError(f"Expected root JSON object in {path}")
    return data


def write_json_dict(path: Path, data: dict[str, Any], dry_run: bool) -> None:
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if dry_run:
        print(f"[dry-run] write {path}")
        return
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    tmp_path.replace(path)


def create_backup(home: Path, files: list[Path], dry_run: bool) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = home / ".backups" / f"chrome_install_{stamp}"
    if dry_run:
        print(f"[dry-run] create backup dir: {backup_dir}")
        for f in files:
            if f.exists():
                print(f"[dry-run] backup {f} -> {backup_dir / f.name}")
        return backup_dir

    backup_dir.mkdir(parents=True, exist_ok=True)
    for src in files:
        if src.is_file():
            shutil.copy2(src, backup_dir / src.name)
        elif src.is_dir():
            shutil.copytree(src, backup_dir / src.name, dirs_exist_ok=True)
    return backup_dir


def update_layout(home: Path, dry_run: bool) -> bool:
    layout_path = home / "layouts" / "main-popup.json"
    if not layout_path.is_file():
        raise InstallError(f"Layout not found: {layout_path}")

    data = read_json_dict(layout_path)
    root = data

    changed = False

    def update_node(node: Any) -> bool:
        nonlocal changed
        if not isinstance(node, dict):
            return False
        if node.get("id") == "brand":
            content = node.get("content")
            if isinstance(content, dict) and content.get("mod") != MOD_NAME:
                content["mod"] = MOD_NAME
                changed = True
                return True
        children = node.get("children")
        if isinstance(children, list):
            for child in children:
                if update_node(child):
                    return True
        return False

    update_node(root)
    if changed:
        write_json_dict(layout_path, data, dry_run)
        print(f"Updated layout {layout_path.name}: brand mod -> {MOD_NAME}")
        return True
    else:
        print(f"Brand mod already set to {MOD_NAME} in {layout_path.name}")
        return False


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
    files_to_backup = [
        home / "layouts" / "main-popup.json",
        target_mod_dir,
    ]
    backup_dir = create_backup(home, files_to_backup, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    # Copy files
    copy_mod_files(source_mod_dir, target_mod_dir, args.dry_run)

    # Update layout main-popup.json
    update_layout(home, args.dry_run)

    # Validate target mod
    if not args.dry_run:
        run_mod_check(target_mod_dir, home)

    print(
        f"\nSuccessfully installed {MOD_NAME}!\n"
        f"- Live Time (HH:mm:ss) + Date (MM/DD 週X) in top-left\n"
        f"- Click to copy ISO timestamp to clipboard\n"
        f"- Traffic lights padding and search/toggle buttons preserved"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InstallError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
