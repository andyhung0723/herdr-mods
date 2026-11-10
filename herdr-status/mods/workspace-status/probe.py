#!/usr/bin/env python3
"""YouTube Music (Edge PWA / Browser) Status Probe for Herdr."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

YTM_APP_PATH = "~/Applications/Edge Apps.localized/YouTube Music.app"


def get_pwa_status() -> dict | None:
    """Check Edge PWA window title via AppleScript."""
    ascript = """
    tell application "System Events"
        set pList to every process whose name is "YouTube Music"
        if (count of pList) > 0 then
            set ytm to item 1 of pList
            set wList to every window of ytm
            if (count of wList) > 0 then
                return "PWA:" & (name of item 1 of wList)
            end if
            return "PWA_OPEN_NO_WINDOW"
        end if
        return "NONE"
    end tell
    """
    try:
        res = subprocess.run(["osascript", "-e", ascript], capture_output=True, text=True, timeout=2)
        out = res.stdout.strip()
        if out.startswith("PWA:"):
            raw = out[4:].strip()
            return parse_ytm_title(raw, "Edge PWA")
        elif out == "PWA_OPEN_NO_WINDOW":
            return {
                "active": True,
                "title": "YouTube Music",
                "artist": "",
                "playing": False,
                "app": "YouTube Music",
                "source": "Edge PWA",
            }
    except Exception:
        pass
    return None


def get_browser_tab_status() -> dict | None:
    """Check Microsoft Edge or Chrome tabs as fallback."""
    ascript = """
    tell application "System Events"
        set edgeRunning to (count of (every process whose name is "Microsoft Edge")) > 0
        set chromeRunning to (count of (every process whose name is "Google Chrome")) > 0
    end tell

    if edgeRunning then
        tell application "Microsoft Edge"
            repeat with w in windows
                repeat with t in (every tab of w)
                    set tUrl to URL of t
                    if tUrl contains "music.youtube.com" then
                        return "EDGE:" & (title of t)
                    end if
                end repeat
            end repeat
        end tell
    end if

    if chromeRunning then
        tell application "Google Chrome"
            repeat with w in windows
                repeat with t in (every tab of w)
                    set tUrl to URL of t
                    if tUrl contains "music.youtube.com" then
                        return "CHROME:" & (title of t)
                    end if
                end repeat
            end repeat
        end tell
    end if

    return "NONE"
    """
    try:
        res = subprocess.run(["osascript", "-e", ascript], capture_output=True, text=True, timeout=2)
        out = res.stdout.strip()
        if out.startswith("EDGE:"):
            return parse_ytm_title(out[5:].strip(), "Edge Tab")
        elif out.startswith("CHROME:"):
            return parse_ytm_title(out[7:].strip(), "Chrome Tab")
    except Exception:
        pass
    return None


def parse_ytm_title(raw: str, source: str) -> dict:
    """Parse 'Song Title - Artist - YouTube Music' into structured data."""
    clean = raw
    is_playing = True

    # Strip suffix " - YouTube Music" or " - YouTube"
    if clean.endswith(" - YouTube Music"):
        clean = clean[:-16].strip()
    elif clean.endswith(" - YouTube"):
        clean = clean[:-10].strip()

    if not clean or clean == "YouTube Music":
        return {
            "active": True,
            "title": "YouTube Music",
            "artist": "Paused",
            "playing": False,
            "app": "YouTube Music",
            "source": source,
        }

    # Split title and artist: usually "Title - Artist"
    if " - " in clean:
        parts = clean.rsplit(" - ", 1)
        title = parts[0].strip()
        artist = parts[1].strip()
    else:
        title = clean.strip()
        artist = ""

    return {
        "active": True,
        "title": title,
        "artist": artist,
        "playing": is_playing,
        "app": "YouTube Music",
        "source": source,
    }


def activate_app() -> dict:
    """Bring YouTube Music PWA or browser to front."""
    if os.path.exists(YTM_APP_PATH):
        try:
            subprocess.run(["open", "-a", YTM_APP_PATH], check=False)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # Fallback to activating Edge
    ascript = """
    tell application "Microsoft Edge" to activate
    """
    try:
        subprocess.run(["osascript", "-e", ascript], check=False)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def toggle_play() -> dict:
    """Toggle play/pause in YouTube Music."""
    ascript = """
    tell application "System Events"
        set pList to every process whose name is "YouTube Music"
        if (count of pList) > 0 then
            tell application "YouTube Music" to activate
            delay 0.05
            key code 49
            return "OK"
        end if
    end tell
    return "NONE"
    """
    try:
        res = subprocess.run(["osascript", "-e", ascript], capture_output=True, text=True, timeout=2)
        if res.stdout.strip() == "OK":
            return {"ok": True}
    except Exception:
        pass
    return {"ok": False, "error": "YouTube Music not running"}


def main() -> int:
    parser = argparse.ArgumentParser(description="YouTube Music probe for Herdr")
    parser.add_argument("--action", default="status", choices=["status", "activate", "toggle"])
    args = parser.parse_args()

    if args.action == "activate":
        print(json.dumps(activate_app()))
        return 0

    if args.action == "toggle":
        print(json.dumps(toggle_play()))
        return 0

    # Action: status
    status = get_pwa_status() or get_browser_tab_status() or {
        "active": False,
        "title": "",
        "artist": "",
        "playing": False,
        "app": "YouTube Music",
        "source": None,
    }

    print(json.dumps(status, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
