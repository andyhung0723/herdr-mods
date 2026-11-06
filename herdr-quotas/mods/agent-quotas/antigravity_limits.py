#!/usr/bin/env python3
import base64
import json
import os
import shutil
import subprocess
import urllib.request


def get_antigravity_limits_from_cli(model_name):
    agy_bin = shutil.which("agy")
    if not agy_bin:
        home = os.path.expanduser("~")
        candidate = os.path.join(home, ".local/bin/agy")
        if os.path.exists(candidate):
            agy_bin = candidate

    if not agy_bin:
        return None

    try:
        proc = subprocess.run(
            [agy_bin, "-p", "/usage", "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None

        payload = json.loads(proc.stdout.strip())
        groups = payload.get("command", {}).get("data", {}).get("groups", [])
        if not groups:
            return None

        # Determine target group based on model_name
        is_3p = any(k in (model_name or "").lower() for k in ["claude", "opus", "sonnet", "gpt"])

        target_group = None
        for g in groups:
            g_name = g.get("name", "").lower()
            if is_3p and ("claude" in g_name or "gpt" in g_name):
                target_group = g
                break
            elif not is_3p and "gemini" in g_name and "argon" not in g_name:
                target_group = g
                break

        if not target_group:
            target_group = groups[0]

        five_hour = None
        weekly = None

        for b in target_group.get("buckets", []):
            win = b.get("window")
            rem_frac = b.get("remaining_fraction", 1.0)
            used_pct = max(0, min(100, round((1.0 - rem_frac) * 100)))
            rem_pct = max(0, min(100, round(rem_frac * 100)))
            reset_time = b.get("reset_time")

            bucket_info = {
                "percent": used_pct,
                "remainingPercent": rem_pct,
                "remainingFraction": rem_frac,
                "resetTime": reset_time,
                "displayName": b.get("name", ""),
            }

            if win == "5h":
                five_hour = bucket_info
            elif win == "weekly":
                weekly = bucket_info

        return {
            "source": "cli",
            "groupName": target_group.get("name", "Gemini Models"),
            "fiveHour": five_hour,
            "weekly": weekly,
        }
    except Exception:
        return None


def get_antigravity_limits():
    home = os.path.expanduser("~")

    # 1. Read configured model from settings.json
    model_name = "Gemini 3.8 Flash (Medium)"
    settings_path = os.path.join(home, ".gemini/antigravity-cli/settings.json")
    try:
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                if cfg.get("model"):
                    model_name = cfg["model"]
    except Exception:
        pass

    email = ""
    tier = "Antigravity"

    # Try fast CLI method first
    cli_data = get_antigravity_limits_from_cli(model_name)
    five_hour = cli_data.get("fiveHour") if cli_data else None
    weekly = cli_data.get("weekly") if cli_data else None

    # Retrieve account info / fallback from Keychain
    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            raw = proc.stdout.strip()
            if raw.startswith("go-keyring-base64:"):
                raw = raw[len("go-keyring-base64:"):]
            data = json.loads(base64.b64decode(raw).decode("utf-8"))
            email = data.get("id_token_email", email)
            token_info = data.get("token") or {}
            access_token = token_info.get("access_token")

            # Fallback if CLI did not provide limits
            if (not five_hour or not weekly) and access_token:
                headers = {
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "User-Agent": "antigravity/1.0",
                }
                quota_req = urllib.request.Request(
                    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                    headers=headers,
                    data=b"{}",
                )
                with urllib.request.urlopen(quota_req, timeout=5) as resp:
                    quota_resp = json.loads(resp.read().decode("utf-8"))
                    for b in quota_resp.get("buckets", []):
                        if "gemini" in b.get("modelId", ""):
                            rem_frac = b.get("remainingFraction", 1.0)
                            five_hour = {
                                "percent": max(0, min(100, round((1.0 - rem_frac) * 100))),
                                "remainingPercent": max(0, min(100, round(rem_frac * 100))),
                                "remainingFraction": rem_frac,
                                "resetTime": b.get("resetTime"),
                            }
                            break
    except Exception:
        pass

    return {
        "email": email,
        "tier": tier,
        "model": model_name,
        "fiveHour": five_hour,
        "weekly": weekly,
    }


if __name__ == "__main__":
    result = get_antigravity_limits()
    if result:
        print(json.dumps(result))
