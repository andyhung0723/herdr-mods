#!/usr/bin/env python3
import base64
import json
import os
import subprocess
import urllib.request


def get_antigravity_limits():
    try:
        # 1. Retrieve OAuth token from macOS Keychain (go-keyring base64 encoded)
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None

        raw = proc.stdout.strip()
        if raw.startswith("go-keyring-base64:"):
            raw = raw[len("go-keyring-base64:"):]

        data = json.loads(base64.b64decode(raw).decode("utf-8"))
        token_info = data.get("token") or {}
        access_token = token_info.get("access_token")
        email = data.get("id_token_email", "")

        if not access_token:
            return None

        # 2. Query quota summary endpoint
        endpoint = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
        req = urllib.request.Request(
            endpoint,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "User-Agent": "antigravity/1.0",
            },
            data=b"{}",
        )

        with urllib.request.urlopen(req, timeout=5) as resp:
            quota_data = json.loads(resp.read().decode("utf-8"))

        five_hour = None
        weekly = None

        # Extract buckets from groups
        groups = quota_data.get("groups", [])
        for group in groups:
            for bucket in group.get("buckets", []):
                window = bucket.get("window")
                rem_frac = bucket.get("remainingFraction", 1)
                used_pct = max(0, min(100, round((1.0 - rem_frac) * 100)))
                reset_time = bucket.get("resetTime")

                if window == "5h":
                    five_hour = {
                        "percent": used_pct,
                        "remainingFraction": rem_frac,
                        "resetTime": reset_time,
                    }
                elif window == "weekly":
                    weekly = {
                        "percent": used_pct,
                        "remainingFraction": rem_frac,
                        "resetTime": reset_time,
                    }

        # 3. Optional: check current tier via loadCodeAssist
        tier = "Antigravity"
        try:
            tier_req = urllib.request.Request(
                "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "User-Agent": "antigravity/1.0",
                },
                data=b"{}",
            )
            with urllib.request.urlopen(tier_req, timeout=4) as t_resp:
                tier_data = json.loads(t_resp.read().decode("utf-8"))
                current_tier = tier_data.get("currentTier", {})
                tier = current_tier.get("name") or current_tier.get("id") or tier
        except Exception:
            pass

        return {
            "email": email,
            "tier": tier,
            "fiveHour": five_hour,
            "weekly": weekly,
        }
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    result = get_antigravity_limits()
    if result:
        print(json.dumps(result))
