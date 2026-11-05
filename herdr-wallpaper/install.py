#!/usr/bin/env python3
"""Install Herdr Wallpaper Carousel mod, register controller and shortcuts (Ctrl+B Shift+B).

Includes:
- Safe timestamped backups
- Copying mod to ~/.config/herdr-app/mods/wallpaper-carousel
- Registering 0px controller in layouts/main-popup.json
- Registering shortcuts in keys.json
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

MOD_NAME = "wallpaper-carousel"
SHORTCUT_NEXT = "ctrl-b shift-b"
SHORTCUT_TOGGLE = "ctrl-b alt-b"
ACTION_NEXT = f"{MOD_NAME}.next"
ACTION_TOGGLE = f"{MOD_NAME}.toggle"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Wallpaper Carousel")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=10000,
        help="Rotation interval in milliseconds (default: 10000ms)",
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
    backup_dir = home / ".backups" / f"wallpaper_install_{stamp}"
    if dry_run:
        print(f"[dry-run] create backup dir: {backup_dir}")
        for f in files:
            if f.exists():
                print(f"[dry-run] backup {f} -> {backup_dir / f.name}")
        return backup_dir

    backup_dir.mkdir(parents=True, exist_ok=True)
    for src in files:
        if src.exists():
            shutil.copy2(src, backup_dir / src.name)
    return backup_dir


def update_keys(home: Path, dry_run: bool) -> bool:
    keys_path = home / "keys.json"
    data = read_json_dict(keys_path)
    global_keys = data.setdefault("global", {})
    if not isinstance(global_keys, dict):
        raise InstallError(f"keys.json: 'global' must be a JSON object, got {type(global_keys)}")

    changed = False
    if global_keys.get(SHORTCUT_NEXT) != ACTION_NEXT:
        global_keys[SHORTCUT_NEXT] = ACTION_NEXT
        changed = True
    if global_keys.get(SHORTCUT_TOGGLE) != ACTION_TOGGLE:
        global_keys[SHORTCUT_TOGGLE] = ACTION_TOGGLE
        changed = True

    if changed:
        write_json_dict(keys_path, data, dry_run)
        print(f"Updated {keys_path.name}: {SHORTCUT_NEXT} -> {ACTION_NEXT}, {SHORTCUT_TOGGLE} -> {ACTION_TOGGLE}")
    else:
        print(f"Keys already registered in {keys_path.name}")
    return changed


def update_layout(home: Path, interval_ms: int, dry_run: bool) -> bool:
    layout_path = home / "layouts" / "main-popup.json"
    if not layout_path.is_file():
        raise InstallError(f"Layout not found: {layout_path}")

    data = read_json_dict(layout_path)
    root = data

    controller_id = f"{MOD_NAME}-controller"
    controller_spec = {
        "id": controller_id,
        "type": "block",
        "content": {
            "mod": MOD_NAME,
            "props": {
                "intervalMs": interval_ms,
            },
        },
        "size": {
            "px": 0,
        },
        "min": 0,
        "max": 0,
    }

    def inject_controller(node: Any) -> bool:
        if not isinstance(node, dict):
            return False
        sub_children = node.get("children")
        if isinstance(sub_children, list):
            # Check if already present
            for sc in sub_children:
                if isinstance(sc, dict) and sc.get("id") == controller_id:
                    # Update props if changed
                    if sc.get("content", {}).get("props", {}).get("intervalMs") != interval_ms:
                        sc["content"]["props"] = {"intervalMs": interval_ms}
                        return True
                    return False

            # Insert after scratchpad-controller or popup-terminal-controller
            for idx, sc in enumerate(sub_children):
                if isinstance(sc, dict) and sc.get("id") in ("scratchpad-controller", "popup-terminal-controller"):
                    sub_children.insert(idx + 1, controller_spec)
                    return True

            # Recurse
            for sc in sub_children:
                if inject_controller(sc):
                    return True
        return False

    injected = inject_controller(root)
    if injected:
        write_json_dict(layout_path, data, dry_run)
        print(f"Updated layout {layout_path.name}: registered {controller_id} ({interval_ms}ms)")
        return True
    else:
        print(f"Controller {controller_id} already up to date in {layout_path.name}")
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

    # Backup targets
    files_to_backup = [
        home / "keys.json",
        home / "layouts" / "main-popup.json",
    ]
    backup_dir = create_backup(home, files_to_backup, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    # Copy mod files
    copy_mod_files(source_mod_dir, target_mod_dir, args.dry_run)

    # Update keys.json
    update_keys(home, args.dry_run)

    # Update layout
    update_layout(home, args.interval, args.dry_run)

    # Validate installed mod
    if not args.dry_run:
        run_mod_check(target_mod_dir, home)

    print(
        f"\nSuccessfully installed {MOD_NAME}!\n"
        f"- Carousel interval: {args.interval / 1000:.1f}s\n"
        f"- Next wallpaper shortcut: `{SHORTCUT_NEXT}`\n"
        f"- Pause/Resume shortcut: `{SHORTCUT_TOGGLE}`"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InstallError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
