#!/usr/bin/env python3
"""Install Enhanced Spaces Mod with Material Theme Icons."""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def resolve_home(user_home: Path | None) -> Path:
    if user_home is not None:
        return user_home.expanduser().resolve()
    env = os.environ.get("HERDR_APP_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".config" / "herdr-app").resolve()


def update_layout_node(node: dict, target_id: str, new_mod: str) -> bool:
    changed = False
    if node.get("id") == target_id and isinstance(node.get("content"), dict):
        if node["content"].get("mod") != new_mod:
            node["content"]["mod"] = new_mod
            changed = True
    for child in node.get("children", []):
        if isinstance(child, dict) and update_layout_node(child, target_id, new_mod):
            changed = True
    return changed


def main():
    home = resolve_home(None)
    source_mod = Path(__file__).resolve().parent / "mods" / "enhanced-spaces"
    target_mod = home / "mods" / "enhanced-spaces"

    print(f"Herdr app home: {home}")
    res = subprocess.run(["herdr-app", "check", str(source_mod)], capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Check failed: {res.stderr or res.stdout}")
        sys.exit(1)
    print("✔ enhanced-spaces passed check")

    if target_mod.exists():
        shutil.rmtree(target_mod)
    shutil.copytree(source_mod, target_mod)
    print(f"Installed mod: {target_mod}")

    # Ensure custom-icons/space.svg exists
    custom_icons = home / "custom-icons"
    custom_icons.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_mod / "space.svg", custom_icons / "space.svg")

    # Update layouts/main-popup.json
    layout_file = home / "layouts" / "main-popup.json"
    if layout_file.exists():
        try:
            data = json.loads(layout_file.read_text("utf-8"))
            if update_layout_node(data, "spaces", "enhanced-spaces"):
                layout_file.write_text(json.dumps(data, indent=2) + "\n", "utf-8")
                print("✔ Updated layout main-popup.json (spaces -> enhanced-spaces)")
            else:
                print("spaces block already configured or not found in main-popup.json")
        except Exception as e:
            print(f"Failed to update layout: {e}")

    print("\n✅ Enhanced Spaces installed successfully!")


if __name__ == "__main__":
    main()
