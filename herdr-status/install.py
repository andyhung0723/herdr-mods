#!/usr/bin/env python3
"""Install Enhanced Workspace Status (Unified AI Agent Status Bar & YouTube Music Now Playing)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MOD_NAME = "enhanced-status"
IME_WATCHER_SOURCE = "ime-watcher.swift"
IME_WATCHER_BINARY = "ime-watcher"
IME_WATCHER_LABEL = "com.herdr.ime-watcher"


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


def build_ime_watcher(mod_dest: Path, dry_run: bool) -> Path | None:
    source = mod_dest / IME_WATCHER_SOURCE
    binary = mod_dest / IME_WATCHER_BINARY
    if sys.platform != "darwin":
        print("Skip ime-watcher: macOS only")
        return None
    if shutil.which("swiftc") is None:
        print("Warning: swiftc not found (xcode-select --install); IME badge disabled", file=sys.stderr)
        return None
    if dry_run:
        print(f"[dry-run] swiftc -O {source.name} -o {binary}")
        return binary
    res = subprocess.run(
        ["swiftc", "-O", str(source), "-o", str(binary)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if res.returncode != 0:
        print(f"Warning: ime-watcher build failed; IME badge disabled\n{res.stderr}", file=sys.stderr)
        return None
    print(f"Built {binary}")
    return binary


def render_launch_agent(binary: Path) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{IME_WATCHER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
"""


def install_launch_agent(binary: Path, dry_run: bool) -> None:
    plist = Path.home() / "Library" / "LaunchAgents" / f"{IME_WATCHER_LABEL}.plist"
    domain = f"gui/{os.getuid()}"
    if dry_run:
        print(f"[dry-run] Write {plist} and (re)start {domain}/{IME_WATCHER_LABEL}")
        return
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_text(render_launch_agent(binary), encoding="utf-8")
    # bootout fails harmlessly when the agent is not loaded yet.
    subprocess.run(["launchctl", "bootout", f"{domain}/{IME_WATCHER_LABEL}"], capture_output=True, check=False)
    res = subprocess.run(["launchctl", "bootstrap", domain, str(plist)], capture_output=True, text=True, check=False)
    if res.returncode != 0:
        print(f"Warning: could not start ime-watcher agent: {res.stderr.strip()}", file=sys.stderr)
        return
    print(f"Started launch agent {IME_WATCHER_LABEL}")


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


def main() -> int:
    args = parse_args(sys.argv[1:])
    source_root = Path(__file__).resolve().parent
    mod_src = source_root / "mods" / MOD_NAME

    if not mod_src.exists():
        print(f"Error: Missing mod source folder {mod_src}", file=sys.stderr)
        return 1

    home = resolve_home(args.home)
    print(f"Herdr app home: {home}")

    print("Running herdr-app check on enhanced-status mod...")
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
        print(f"Error: enhanced-status mod failed check: {res.stdout} {res.stderr}", file=sys.stderr)
        return 1
    print("✔ enhanced-status mod passed check")

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

    ime_watcher = build_ime_watcher(mods_dir / MOD_NAME, args.dry_run)
    if ime_watcher is not None:
        install_launch_agent(ime_watcher, args.dry_run)

    # Update layout in main-popup.json
    layout_file = home / "layouts" / "main-popup.json"
    if layout_file.exists():
        try:
            with open(layout_file, "r", encoding="utf-8") as f:
                layout = json.load(f)
            if update_layout_node(layout, "status", MOD_NAME):
                if not args.dry_run:
                    with open(layout_file, "w", encoding="utf-8") as f:
                        json.dump(layout, f, indent=2)
                print(f"Updated layout {layout_file.name}: status -> {MOD_NAME}")
        except Exception as e:
            print(f"Warning: Could not update layout: {e}", file=sys.stderr)

    print("\n✅ Enhanced Workspace Status installed successfully!")
    print("\nFeatures:")
    print("  - Unified AI Agent Status Bar (Center):")
    print("    • Prioritizes current active agent (Claude Code, OpenAI Codex, Google Antigravity)")
    print("    • Expanded status for focused agent with live Model, Context %, Quota Limits, Cost/Tokens")
    print("    • Compact indicator badges for background agents")
    print("    • Click any agent badge to open full Quotas Dashboard (agent-quotas)")
    print("  - YouTube Music Widget (Right Corner):")
    print("    • Displays '▶ ♫ Song • Artist' when active")
    print("    • Click title to bring app to front, click ⏸/▶ to toggle playback")
    return 0


if __name__ == "__main__":
    sys.exit(main())
