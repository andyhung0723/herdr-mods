#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import time
import urllib.request

CACHE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "herdr")
CACHE_PATH = os.path.join(CACHE_DIR, "claude-limits.json")
CACHE_TTL_SEC = 45


def write_private_cache(payload: dict) -> None:
    os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
    tmp_path = f"{CACHE_PATH}.{os.getpid()}.tmp"
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp_path, CACHE_PATH)


def get_keychain_token(config_dir: str) -> str | None:
    suffix = hashlib.sha256(config_dir.encode("utf-8")).hexdigest()[:8]
    services = [f"Claude Code-credentials-{suffix}", "Claude Code-credentials"]
    for service in services:
        try:
            res = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-w"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if res.returncode == 0 and res.stdout.strip():
                creds = json.loads(res.stdout.strip())
                token = (creds.get("claudeAiOauth") or {}).get("accessToken")
                if token:
                    return token
        except Exception:
            pass
    return None


def fetch_live_usage(token: str) -> dict | None:
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "claude-code/2.1.319",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass
    return None


def load_best_local_profile() -> tuple[str | None, dict | None, int]:
    home = os.path.expanduser("~")
    candidates = [
        (f"{home}/.claude-work", f"{home}/.claude-work/.claude.json"),
        (f"{home}/.claude", f"{home}/.claude.json"),
        (f"{home}/.claude", f"{home}/.claude/.claude.json"),
    ]
    best_dir = None
    best_data = None
    best_fetched_at = -1

    for cfg_dir, path in candidates:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            cu = parsed.get("cachedUsageUtilization") or {}
            fetched_at = cu.get("fetchedAtMs") or 0
            if cu.get("utilization") or parsed.get("oauthAccount"):
                if best_data is None or fetched_at > best_fetched_at:
                    best_dir = cfg_dir
                    best_data = parsed
                    best_fetched_at = fetched_at
        except Exception:
            pass

    return best_dir, best_data, best_fetched_at


def get_claude_limits() -> dict | None:
    best_dir, best_data, best_fetched_at = load_best_local_profile()
    oauth_account = (best_data or {}).get("oauthAccount") or {}
    local_utilization = ((best_data or {}).get("cachedUsageUtilization") or {}).get(
        "utilization"
    )

    now_ms = int(time.time() * 1000)

    # 1. Check recent cache to avoid spamming Anthropic OAuth endpoint every 20s
    try:
        if os.path.exists(CACHE_PATH):
            with open(CACHE_PATH, "r", encoding="utf-8") as f:
                cached = json.load(f)
            cached_at = cached.get("fetchedAtMs") or 0
            if (
                cached.get("utilization")
                and (now_ms - cached_at) < CACHE_TTL_SEC * 1000
                and cached_at >= best_fetched_at
            ):
                return {
                    "oauthAccount": oauth_account or {},
                    "utilization": cached["utilization"],
                    "fetchedAtMs": cached_at,
                    "source": "cache",
                }
    except Exception:
        pass

    # 2. Fetch live usage from Anthropic OAuth Usage API using Keychain credentials
    home = os.path.expanduser("~")
    search_dirs = []
    if best_dir:
        search_dirs.append(best_dir)
    for d in [f"{home}/.claude-work", f"{home}/.claude"]:
        if d not in search_dirs and os.path.exists(d):
            search_dirs.append(d)

    for cfg_dir in search_dirs:
        token = get_keychain_token(cfg_dir)
        if not token:
            continue
        live_u = fetch_live_usage(token)
        if live_u and isinstance(live_u, dict) and ("five_hour" in live_u or "seven_day" in live_u):
            result = {
                "oauthAccount": oauth_account,
                "utilization": live_u,
                "fetchedAtMs": now_ms,
                "source": "live",
            }
            try:
                write_private_cache({"utilization": live_u, "fetchedAtMs": now_ms})
            except OSError:
                pass
            return result

    # 3. Fallback to local .claude.json cachedUsageUtilization
    if local_utilization:
        return {
            "oauthAccount": oauth_account,
            "utilization": local_utilization,
            "fetchedAtMs": best_fetched_at if best_fetched_at > 0 else None,
            "source": "local",
        }

    return None


if __name__ == "__main__":
    data = get_claude_limits()
    if data:
        print(json.dumps(data))
