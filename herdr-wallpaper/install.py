#!/usr/bin/env python3
"""Install static Liquid Glass wallpaper and theme for Herdr.

Includes:
- Safe timestamped backups
- Copying assets/liquid_glass.jpg to ~/.config/herdr-app/backgrounds/liquid_glass.jpg
- Copying ../themes/liquid-glass.json to ~/.config/herdr-app/themes/liquid-glass.json
- Updating layouts/main-popup.json background and theme (and removing any legacy wallpaper-carousel-controller)
- Cleaning legacy wallpaper-carousel.* shortcuts from keys.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LEGACY_MOD_NAME = "wallpaper-carousel"
LEGACY_SHORTCUTS = ("ctrl-b shift-b", "ctrl-b alt-b")


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install static Liquid Glass wallpaper and theme")
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


def cleanup_keys(home: Path, dry_run: bool) -> bool:
    keys_path = home / "keys.json"
    if not keys_path.is_file():
        return False
    data = read_json_dict(keys_path)
    global_keys = data.get("global")
    if not isinstance(global_keys, dict):
        return False

    changed = False
    for shortcut in LEGACY_SHORTCUTS:
        if shortcut in global_keys:
            del global_keys[shortcut]
            changed = True
    for k in [k for k, v in global_keys.items() if isinstance(v, str) and v.startswith(f"{LEGACY_MOD_NAME}.")]:
        del global_keys[k]
        changed = True

    if changed:
        write_json_dict(keys_path, data, dry_run)
        print(f"Cleaned legacy {LEGACY_MOD_NAME}.* shortcuts from {keys_path.name}")
    return changed


def update_layout(home: Path, dry_run: bool) -> bool:
    layout_path = home / "layouts" / "main-popup.json"
    if not layout_path.is_file():
        raise InstallError(f"Layout not found: {layout_path}")

    data = read_json_dict(layout_path)
    changed = False

    desired_bg = {
        "image": "backgrounds/liquid_glass.jpg",
        "fit": "cover",
    }
    if data.get("background") != desired_bg:
        data["background"] = desired_bg
        changed = True

    desired_theme = {"light": "liquid-glass", "dark": "liquid-glass"}
    if data.get("theme") != desired_theme:
        data["theme"] = desired_theme
        changed = True

    def strip_controller(node: Any) -> bool:
        removed = False
        if not isinstance(node, dict):
            return False
        children = node.get("children")
        if isinstance(children, list):
            kept: list[Any] = []
            for child in children:
                is_legacy = (
                    isinstance(child, dict)
                    and (
                        child.get("id") == f"{LEGACY_MOD_NAME}-controller"
                        or (isinstance(child.get("content"), dict) and child["content"].get("mod") == LEGACY_MOD_NAME)
                    )
                )
                if is_legacy:
                    removed = True
                else:
                    if strip_controller(child):
                        removed = True
                    kept.append(child)
            if removed:
                node["children"] = kept
        return removed

    if strip_controller(data):
        changed = True

    if changed:
        write_json_dict(layout_path, data, dry_run)
        print(f"Updated layout {layout_path.name}: static Liquid Glass wallpaper + theme")
    else:
        print(f"Layout {layout_path.name} already configured for static Liquid Glass wallpaper")
    return changed


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    home = resolve_home(args.home)
    repo_root = Path(__file__).resolve().parent

    source_bg = repo_root / "assets" / "liquid_glass.jpg"
    source_theme = repo_root.parent / "themes" / "liquid-glass.json"

    if not source_bg.is_file():
        raise InstallError(f"Wallpaper asset not found: {source_bg}")

    files_to_backup = [
        home / "keys.json",
        home / "layouts" / "main-popup.json",
    ]
    backup_dir = create_backup(home, files_to_backup, args.dry_run)
    print(f"Backup created at: {backup_dir}")

    target_bg = home / "backgrounds" / "liquid_glass.jpg"
    if args.dry_run:
        print(f"[dry-run] copy wallpaper: {source_bg} -> {target_bg}")
    else:
        target_bg.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_bg, target_bg)
        print(f"Copied wallpaper to {target_bg}")

    if source_theme.is_file():
        target_theme = home / "themes" / "liquid-glass.json"
        if args.dry_run:
            print(f"[dry-run] copy theme: {source_theme} -> {target_theme}")
        else:
            target_theme.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_theme, target_theme)
            print(f"Copied theme to {target_theme}")

    legacy_mod_dir = home / "mods" / LEGACY_MOD_NAME
    if legacy_mod_dir.exists():
        if args.dry_run:
            print(f"[dry-run] remove legacy mod: {legacy_mod_dir}")
        else:
            shutil.rmtree(legacy_mod_dir)
            print(f"Removed legacy mod: {legacy_mod_dir}")

    cleanup_keys(home, args.dry_run)
    update_layout(home, args.dry_run)

    print("\nSuccessfully installed static Liquid Glass wallpaper and theme!")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InstallError as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
