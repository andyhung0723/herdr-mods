#!/usr/bin/env python3
"""Install Herdr Services Inspector mod into right-side panel-body stack and keys.json.

Includes validation, safe backups, layout insertion, tabs update, and dry-run mode.
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

MOD_NAME = "services-inspector"
SHORTCUT_KEY = "ctrl-b shift-e"
ACTION_OPEN = f"mod.open:{MOD_NAME}"
PANEL_CHILD_ID = "services"


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr Services Inspector")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument(
        "--layout",
        default="main-popup",
        help="Personal layout to enable right-side panel (default: main-popup)",
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


def find_node(node: Any, node_id: str) -> dict | None:
    if isinstance(node, dict):
        if node.get("id") == node_id:
            return node
        for v in node.values():
            found = find_node(v, node_id)
            if found is not None:
                return found
    elif isinstance(node, list):
        for item in node:
            found = find_node(item, node_id)
            if found is not None:
                return found
    return None


def update_layout_panel(layout_path: Path, backups_dir: Path, dry_run: bool) -> None:
    if not layout_path.exists():
        print(f"Layout file {layout_path} does not exist, skipping layout update")
        return

    try:
        data = json.loads(layout_path.read_text("utf-8"))
    except Exception as e:
        raise InstallError(f"Failed to parse layout {layout_path}: {e}")

    changed = False

    # Ensure 'services' block is present in right-side 'panel-body' stack
    panel_body = find_node(data, "panel-body")
    if panel_body is not None and isinstance(panel_body.get("children"), list):
        children = panel_body["children"]
        if not any(c.get("id") == PANEL_CHILD_ID for c in children):
            children.append({
                "id": PANEL_CHILD_ID,
                "type": "block",
                "content": {
                    "mod": MOD_NAME,
                },
            })
            changed = True
            print(f"Added '{PANEL_CHILD_ID}' block to panel-body stack")
        else:
            print(f"'{PANEL_CHILD_ID}' block already present in panel-body")
    else:
        print(f"Could not locate 'panel-body' stack in {layout_path.name}")

    if not changed:
        return

    if dry_run:
        print(f"[dry-run] Update {layout_path.name}")
        return

    bk = backup_file(layout_path, backups_dir)
    print(f"Backed up {layout_path.name} to {bk}")
    layout_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    try:
        subprocess.run(
            ["herdr-app", "do", "layout.set", json.dumps({"layout": data})],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        pass
    print(f"Updated {layout_path.name} successfully")


def update_enhanced_tabs(tabs_files: list[Path], dry_run: bool) -> None:
    target_needle = '.when(enabled.includes("spectra"), el => el.child(panelButton("spectra", "Spectra", "mods/spectra-status/spectra.svg")))'
    replacement = target_needle + '\n      .when(enabled.includes("services"), el => el.child(panelButton("services", "Services", "mods/services-inspector/services.svg")))'

    for tabs_file in tabs_files:
        if not tabs_file.exists():
            continue
        content = tabs_file.read_text("utf-8")
        if 'panelButton("services"' in content:
            print(f"Tabs button already present in {tabs_file}")
            continue

        if target_needle not in content:
            print(f"Warning: needle not found in {tabs_file}, skipping tabs button injection")
            continue

        # Also update enabled list: ["files", "changes", "context", "spectra"] -> ["files", "changes", "context", "spectra", "services"]
        new_content = content.replace(
            '["files", "changes", "context", "spectra"]',
            '["files", "changes", "context", "spectra", "services"]',
        ).replace(
            '[...rawPanels, "context", "spectra"]',
            '[...rawPanels, "context", "spectra", "services"]',
        ).replace(
            target_needle,
            replacement,
        )

        if dry_run:
            print(f"[dry-run] Inject Services button into {tabs_file}")
            continue

        tabs_file.write_text(new_content, "utf-8")
        print(f"Updated tabs file: {tabs_file}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check...")
    try:
        run_mod_check(mod_src, home)
        print(f"✔ {MOD_NAME} passed check")
    except InstallError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    mods_dir = home / "mods"
    backups_dir = home / "backups"
    if not args.dry_run:
        mods_dir.mkdir(parents=True, exist_ok=True)
        backups_dir.mkdir(parents=True, exist_ok=True)

    try:
        copy_mod(mod_src, mods_dir / MOD_NAME, args.dry_run)
        update_keys_json(home / "keys.json", backups_dir, args.dry_run)
        update_layout_panel(home / "layouts" / f"{args.layout}.json", backups_dir, args.dry_run)

        # Update tabs in workspace and ~/.config/herdr-app
        workspace_tabs = Path("herdr-tabs/mods/enhanced-tabs/main.js")
        installed_tabs = home / "mods" / "enhanced-tabs" / "main.js"
        update_enhanced_tabs([workspace_tabs, installed_tabs], args.dry_run)

    except InstallError as e:
        print(f"Install failed: {e}", file=sys.stderr)
        return 1

    print("\n✅ Services Inspector installed successfully!")
    print("\nUsage:")
    print("  1. Right-Side Panel: Click the 'Services' button in the top-right tab bar")
    print("  2. Popup Dashboard: Press Ctrl+B Shift+E (or run: herdr-app do mod.open '{\"name\":\"services-inspector\"}')")
    return 0


if __name__ == "__main__":
    sys.exit(main())
