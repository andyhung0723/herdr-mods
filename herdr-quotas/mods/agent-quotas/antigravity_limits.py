#!/usr/bin/env python3
import base64
import json
import os
import subprocess
import urllib.request


def normalize_model_name(name):
    if not name:
        return ""
    n = name.lower()
    if "flash" in n and "3.8" in n:
        return "gemini-3.8-flash-tiered"
    if "flash" in n and "3" in n:
        return "gemini-3-flash"
    if "flash" in n and "2.5" in n:
        return "gemini-2.5-flash"
    if "pro" in n and "2.5" in n:
        return "gemini-2.5-pro"
    if "sonnet" in n:
        return "claude-sonnet-5-5-medium"
    if "opus" in n:
        return "claude-opus-5-5-medium"
    if "gpt" in n:
        return "gpt-oss-120b-medium"
    return n


def get_antigravity_limits():
    try:
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

        # 2. Retrieve OAuth token from macOS Keychain (go-keyring base64 encoded)
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

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "User-Agent": "antigravity/1.0",
        }

        # 3. Query per-model quota (retrieveUserQuota)
        # This contains real-time remaining fractions for Gemini and individual models
        model_buckets = {}
        try:
            quota_req = urllib.request.Request(
                "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                headers=headers,
                data=b"{}",
            )
            with urllib.request.urlopen(quota_req, timeout=5) as resp:
                quota_resp = json.loads(resp.read().decode("utf-8"))
                for b in quota_resp.get("buckets", []):
                    mid = b.get("modelId")
                    if mid:
                        model_buckets[mid] = b
        except Exception:
            pass

        # 4. Query group quota summary (retrieveUserQuotaSummary)
        # This contains 3P (Claude/GPT) 5h and weekly pools
        summary_buckets = {}
        try:
            summary_req = urllib.request.Request(
                "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
                headers=headers,
                data=b"{}",
            )
            with urllib.request.urlopen(summary_req, timeout=5) as resp:
                summary_resp = json.loads(resp.read().decode("utf-8"))
                for g in summary_resp.get("groups", []):
                    for b in g.get("buckets", []):
                        bid = b.get("bucketId")
                        if bid:
                            summary_buckets[bid] = b
        except Exception:
            pass

        # 5. Determine active model quota
        target_mid = normalize_model_name(model_name)
        active_bucket = model_buckets.get(target_mid)

        # Fallback to any gemini bucket if active model is a gemini variant
        if not active_bucket and "gemini" in target_mid:
            for k, v in model_buckets.items():
                if "gemini" in k:
                    active_bucket = v
                    break

        five_hour = None
        if active_bucket:
            rem_frac = active_bucket.get("remainingFraction", 1.0)
            used_pct = max(0, min(100, round((1.0 - rem_frac) * 100)))
            rem_pct = max(0, min(100, round(rem_frac * 100)))
            five_hour = {
                "percent": used_pct,
                "remainingPercent": rem_pct,
                "remainingFraction": rem_frac,
                "resetTime": active_bucket.get("resetTime"),
                "modelId": active_bucket.get("modelId", target_mid),
            }
        elif "3p-5h" in summary_buckets:
            b3 = summary_buckets["3p-5h"]
            rem_frac = b3.get("remainingFraction", 1.0)
            used_pct = max(0, min(100, round((1.0 - rem_frac) * 100)))
            rem_pct = max(0, min(100, round(rem_frac * 100)))
            five_hour = {
                "percent": used_pct,
                "remainingPercent": rem_pct,
                "remainingFraction": rem_frac,
                "resetTime": b3.get("resetTime"),
                "modelId": "3p-5h",
            }

        weekly = None
        if "3p-weekly" in summary_buckets:
            bw = summary_buckets["3p-weekly"]
            rem_frac = bw.get("remainingFraction", 1.0)
            used_pct = max(0, min(100, round((1.0 - rem_frac) * 100)))
            rem_pct = max(0, min(100, round(rem_frac * 100)))
            weekly = {
                "percent": used_pct,
                "remainingPercent": rem_pct,
                "remainingFraction": rem_frac,
                "resetTime": bw.get("resetTime"),
                "displayName": bw.get("displayName", "Weekly Limit Remaining"),
            }

        # 6. Current Tier
        tier = "Antigravity"
        try:
            tier_req = urllib.request.Request(
                "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
                headers=headers,
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
            "model": model_name,
            "fiveHour": five_hour,
            "weekly": weekly,
        }
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    result = get_antigravity_limits()
    if result:
        print(json.dumps(result))
