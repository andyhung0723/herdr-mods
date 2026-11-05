#!/usr/bin/env python3
"""Install Herdr Scratchpad mod and register shortcut (Ctrl+B s).

Includes validation, safe backups, copying mod to ~/.config/herdr-app/mods/scratchpad,
configuring controller in main-popup.json, and registering shortcut in keys.json.
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

MOD_NAME = "scratchpad"
SHORTCUT_KEY = "ctrl-b s"
ACTION_OPEN = f"{MOD_NAME}.toggle"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Scratchpad")
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
        raise InstallError(
            f"`herdr-app check {mod_dir}` failed (exit {proc.returncode}):\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )


def read_json_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise InstallError(f"Failed to parse JSON file {path}: {e}") from e

    if not isinstance(data, dict):
        raise InstallError(f"Expected top-level JSON object in {path}, got {type(data).__name__}")
    return data


def write_json_dict(path: Path, data: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] write {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(f".tmp.{os.getpid()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp_path.replace(path)


def create_backup(home: Path, files: list[Path], dry_run: bool) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = home / "backups" / f"{MOD_NAME}-{stamp}"
    if dry_run:
        print(f"[dry-run] create backup at {backup_dir}")
        return backup_dir

    backup_dir.mkdir(parents=True, exist_ok=True)
    for src in files:
        if src.is_file():
            dst = backup_dir / src.name
            shutil.copy2(src, dst)
        elif src.is_dir():
            dst = backup_dir / src.name
            shutil.copytree(src, dst)
    return backup_dir


def update_keys(home: Path, dry_run: bool) -> bool:
    keys_path = home / "keys.json"
    data = read_json_dict(keys_path)
    global_keys = data.setdefault("global", {})
    if not isinstance(global_keys, dict):
        raise InstallError("Expected 'global' in keys.json to be a dict")

    current_val = global_keys.get(SHORTCUT_KEY)
    if current_val == ACTION_OPEN:
        print(f"Shortcut `{SHORTCUT_KEY}` already points to `{ACTION_OPEN}`")
        return False

    global_keys[SHORTCUT_KEY] = ACTION_OPEN
    write_json_dict(keys_path, data, dry_run)
    print(f"Updated shortcut: `{SHORTCUT_KEY}` -> `{ACTION_OPEN}`")
    return True


def update_layout(home: Path, dry_run: bool) -> bool:
    layout_path = home / "layouts" / "main-popup.json"
    if not layout_path.exists():
        return False
    data = read_json_dict(layout_path)
    root = data if (data.get("id") == "root" or "children" in data) else data.get("root", data)
    if not isinstance(root, dict):
        return False
    children = root.get("children")
    if not isinstance(children, list):
        return False

    # 1. Remove any visible block with mod: "scratchpad"
    original_len = len(children)
    children = [c for c in children if not (isinstance(c, dict) and c.get("content", {}).get("mod") == MOD_NAME)]
    root["children"] = children
    removed = len(children) < original_len

    # 2. Inject 0px scratchpad-controller next to popup-terminal-controller
    controller_spec = {
        "id": "scratchpad-controller",
        "type": "block",
        "content": {
            "mod": MOD_NAME,
            "props": {
                "role": "controller"
            }
        },
        "size": {
            "px": 0
        },
        "min": 0,
        "max": 0
    }

    def inject_controller(node: Any) -> bool:
        if not isinstance(node, dict):
            return False
        sub_children = node.get("children")
        if isinstance(sub_children, list):
            for sc in sub_children:
                if isinstance(sc, dict) and sc.get("id") == "scratchpad-controller":
                    return False
            for idx, sc in enumerate(sub_children):
                if isinstance(sc, dict) and sc.get("id") == "popup-terminal-controller":
                    sub_children.insert(idx + 1, controller_spec)
                    return True
            for sc in sub_children:
                if inject_controller(sc):
                    return True
        return False

    injected = inject_controller(root)
    if removed or injected:
        write_json_dict(layout_path, data, dry_run)
        print(f"Updated layout {layout_path.name}: removed visible panel, injected 0px controller")
        return True
    return False


def copy_mod_files(source_dir: Path, target_dir: Path, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] copy mod tree: {source_dir} -> {target_dir}")
        return

    target_dir.mkdir(parents=True, exist_ok=True)
    for entry in source_dir.iterdir():
        dst = target_dir / entry.name
        if entry.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(entry, dst)
        else:
            shutil.copy2(entry, dst)
    print(f"Copied mod files to {target_dir}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    home = resolve_home(args.home)
    repo_root = Path(__file__).resolve().parent
    source_mod_dir = repo_root / "mods" / MOD_NAME

    if not source_mod_dir.is_dir():
        print(f"Error: source mod directory not found: {source_mod_dir}", file=sys.stderr)
        return 1

    target_mod_dir = home / "mods" / MOD_NAME

    print(f"Installing {MOD_NAME}...")
    print(f"  Herdr home: {home}")
    print(f"  Source mod: {source_mod_dir}")
    print(f"  Target mod: {target_mod_dir}")

    # Step 1: Pre-check source mod
    run_mod_check(source_mod_dir, home)

    # Step 2: Backup files
    files_to_backup: list[Path] = []
    keys_path = home / "keys.json"
    layout_path = home / "layouts" / "main-popup.json"
    if keys_path.exists():
        files_to_backup.append(keys_path)
    if layout_path.exists():
        files_to_backup.append(layout_path)
    if target_mod_dir.exists():
        files_to_backup.append(target_mod_dir)

    backup_dir = create_backup(home, files_to_backup, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    # Step 3: Copy mod files
    copy_mod_files(source_mod_dir, target_mod_dir, args.dry_run)

    # Step 4: Update keys.json
    update_keys(home, args.dry_run)

    # Step 5: Update layout (remove right-hand block, inject 0px controller)
    update_layout(home, args.dry_run)

    # Step 6: Post-check target mod
    if not args.dry_run:
        run_mod_check(target_mod_dir, home)

    print(f"Successfully installed {MOD_NAME}! Press `{SHORTCUT_KEY}` to open.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
