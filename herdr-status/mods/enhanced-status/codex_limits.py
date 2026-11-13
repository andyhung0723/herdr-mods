#!/usr/bin/env python3
import glob
import json
import os
import subprocess
import time


def get_codex_limits():
    # 1. Try real-time RPC to codex app-server
    try:
        proc = subprocess.Popen(
            ["codex", "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        init_req = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "herdr", "version": "1.0.0"}},
        }
        req = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "account/rateLimits/read",
            "params": {},
        }
        proc.stdin.write(json.dumps(init_req) + "\n" + json.dumps(req) + "\n")
        proc.stdin.flush()

        start = time.time()
        for line in proc.stdout:
            if time.time() - start > 3.0:
                break
            try:
                msg = json.loads(line)
                if msg.get("id") == 2:
                    res = msg.get("result", {})
                    rl = res.get("rateLimits", {}).get("primary") or {}
                    credits_info = res.get("rateLimitResetCredits", {})
                    avail = credits_info.get("availableCount", 0)
                    proc.kill()
                    return {
                        "usedPercent": rl.get("usedPercent", 0),
                        "resetsAt": rl.get("resetsAt"),
                        "windowDurationMins": rl.get("windowDurationMins", 10080),
                        "resetCredits": avail,
                    }
            except Exception:
                pass
        proc.kill()
    except Exception:
        pass

    # 2. Fallback to latest session rollout file
    try:
        home = os.path.expanduser("~")
        files = glob.glob(f"{home}/.codex/sessions/**/rollout-*.jsonl", recursive=True)
        if files:
            latest = max(files, key=os.path.getmtime)
            with open(latest, "r", encoding="utf-8") as f:
                for line in reversed(f.readlines()[-200:]):
                    if "rate_limits" in line:
                        d = json.loads(line)
                        p = d.get("payload", {}).get("rate_limits", {}).get("primary", {})
                        if p:
                            return {
                                "usedPercent": int(p.get("used_percent", 0)),
                                "resetsAt": p.get("resets_at"),
                                "windowDurationMins": p.get("window_minutes", 10080),
                                "resetCredits": 0,
                            }
    except Exception:
        pass

    return None


if __name__ == "__main__":
    data = get_codex_limits()
    if data:
        print(json.dumps(data))
