#!/usr/bin/env python3
"""Install Herdr Agents mod with Subagent activity badges (e.g. ⚡ 2/3).

Includes:
- Safe timestamped backups
- Copying mod to ~/.config/herdr-app/mods/agents
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

SOURCE_MOD_NAME = "agents"
TARGET_MOD_NAME = "enhanced-agents"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Agents mod")
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


def create_backup(home: Path, files: list[Path], dry_run: bool) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_dir = home / ".backups" / f"agents_install_{stamp}"
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


def bind_agents_in_layout(layout_path: Path, dry_run: bool) -> None:
    if not layout_path.is_file():
        return
    data = json.loads(layout_path.read_text(encoding="utf-8"))

    def walk(node: object) -> bool:
        changed = False
        if isinstance(node, dict):
            if node.get("id") == "agents":
                content = node.get("content")
                if isinstance(content, dict) and content.get("mod") in ("agents", TARGET_MOD_NAME):
                    if content.get("mod") != TARGET_MOD_NAME:
                        content["mod"] = TARGET_MOD_NAME
                        changed = True
                elif node.get("mod") in ("agents", TARGET_MOD_NAME):
                    if node.get("mod") != TARGET_MOD_NAME:
                        node["mod"] = TARGET_MOD_NAME
                        changed = True
            for child in node.get("children", []):
                if walk(child):
                    changed = True
        return changed

    if walk(data):
        if dry_run:
            print(f"[dry-run] bind 'agents' -> '{TARGET_MOD_NAME}' in {layout_path}")
        else:
            layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"Bound 'agents' pane to '{TARGET_MOD_NAME}' in {layout_path}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    home = resolve_home(args.home)
    repo_root = Path(__file__).resolve().parent

    source_mod_dir = repo_root / "mods" / SOURCE_MOD_NAME
    target_mod_dir = home / "mods" / TARGET_MOD_NAME
    layout_path = home / "layouts" / "main-popup.json"

    if not source_mod_dir.is_dir():
        raise InstallError(f"Source mod dir not found: {source_mod_dir}")

    # Validate source mod first
    run_mod_check(source_mod_dir, home)

    # Backup existing
    files_to_backup = [target_mod_dir, layout_path]
    backup_dir = create_backup(home, files_to_backup, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    # Copy files to both enhanced-agents (persistent across restarts) and agents (immediate fallback)
    copy_mod_files(source_mod_dir, target_mod_dir, args.dry_run)
    copy_mod_files(source_mod_dir, home / "mods" / SOURCE_MOD_NAME, args.dry_run)
    bind_agents_in_layout(layout_path, args.dry_run)

    # Validate target mod
    if not args.dry_run:
        run_mod_check(target_mod_dir, home)

    print("\nSuccessfully installed enhanced agents mod!")
    print("- Displays active subagents count badge (⚡ working/total)")
    print("- Shows warning badge (! blocked/total) when subagents require user attention")
    print("- Provides rich tooltip breakdown upon hover")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InstallError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
