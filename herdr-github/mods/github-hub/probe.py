#!/usr/bin/env python3
"""GitHub Hub backend probe for Herdr.

Queries GitHub CLI (gh) for repository status, Pull Requests, Actions (CI),
and Issues, and supports fetching failed CI logs and PR diffs for Agent dispatching.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def find_gh_binary() -> str | None:
    """Find gh executable path."""
    for cand in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", shutil.which("gh")):
        if cand and os.path.exists(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def get_git_repo_info(cwd: str) -> tuple[str | None, str | None]:
    """Extract owner/repo and current branch from git directory."""
    try:
        # Check remote origin url
        res = subprocess.run(
            ["git", "-C", cwd, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        url = res.stdout.strip()
        repo = None
        if url:
            m = re.search(r"[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$", url)
            if m:
                repo = f"{m.group(1)}/{m.group(2)}"

        # Check current branch
        b_res = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        branch = b_res.stdout.strip() if b_res.returncode == 0 else None
        return repo, branch
    except Exception:
        return None, None


def run_gh_json(gh: str, args: list[str], timeout: int = 8) -> tuple[list | dict | None, str | None]:
    """Run gh command and parse JSON output."""
    try:
        cmd = [gh] + args
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if res.returncode != 0:
            return None, res.stderr.strip() or f"gh exited with code {res.returncode}"
        raw = res.stdout.strip()
        if not raw:
            return [], None
        return json.loads(raw), None
    except Exception as e:
        return None, str(e)


def action_status(gh: str, repo: str | None, branch: str | None) -> dict:
    if not repo:
        return {
            "hasRepo": False,
            "error": "No GitHub remote detected in current workspace",
        }

    out: dict = {
        "hasRepo": True,
        "repo": repo,
        "branch": branch or "main",
        "url": f"https://github.com/{repo}",
        "ci": None,
        "prs_count": 0,
        "issues_count": 0,
    }

    # Fetch latest run on current branch if available
    run_args = [
        "run", "list",
        "-R", repo,
        "--limit", "1",
        "--json", "databaseId,name,status,conclusion,headBranch,url,workflowName,createdAt",
    ]
    if branch:
        run_args.extend(["--branch", branch])

    runs, _ = run_gh_json(gh, run_args, timeout=5)
    if isinstance(runs, list) and len(runs) > 0:
        out["ci"] = runs[0]

    # Quick PRs count
    prs, _ = run_gh_json(gh, ["pr", "list", "-R", repo, "--limit", "20", "--json", "number"], timeout=5)
    if isinstance(prs, list):
        out["prs_count"] = len(prs)

    # Quick Issues count
    issues, _ = run_gh_json(gh, ["issue", "list", "-R", repo, "--limit", "20", "--json", "number"], timeout=5)
    if isinstance(issues, list):
        out["issues_count"] = len(issues)

    return out


def action_prs(gh: str, repo: str) -> dict:
    args = [
        "pr", "list",
        "-R", repo,
        "--limit", "20",
        "--json", "number,title,author,headRefName,state,isDraft,reviewDecision,url,additions,deletions,updatedAt",
    ]
    data, err = run_gh_json(gh, args, timeout=8)
    if err:
        return {"ok": False, "error": err, "prs": []}
    return {"ok": True, "prs": data or []}


def action_runs(gh: str, repo: str) -> dict:
    args = [
        "run", "list",
        "-R", repo,
        "--limit", "15",
        "--json", "databaseId,name,status,conclusion,headBranch,url,workflowName,event,createdAt",
    ]
    data, err = run_gh_json(gh, args, timeout=8)
    if err:
        return {"ok": False, "error": err, "runs": []}
    return {"ok": True, "runs": data or []}


def action_issues(gh: str, repo: str) -> dict:
    args = [
        "issue", "list",
        "-R", repo,
        "--limit", "20",
        "--json", "number,title,author,state,url,labels,updatedAt",
    ]
    data, err = run_gh_json(gh, args, timeout=8)
    if err:
        return {"ok": False, "error": err, "issues": []}
    return {"ok": True, "issues": data or []}


def action_failed_log(gh: str, repo: str, run_id: str) -> dict:
    try:
        res = subprocess.run(
            [gh, "run", "view", run_id, "--log-failed", "-R", repo],
            capture_output=True,
            text=True,
            timeout=10,
        )
        log = res.stdout.strip() or res.stderr.strip()
        # Truncate if excessively long
        if len(log) > 6000:
            log = log[-6000:]
        return {"ok": True, "log": log, "runId": run_id}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def action_pr_diff(gh: str, repo: str, pr_num: str) -> dict:
    try:
        res = subprocess.run(
            [gh, "pr", "diff", pr_num, "-R", repo],
            capture_output=True,
            text=True,
            timeout=10,
        )
        diff = res.stdout.strip()
        if len(diff) > 8000:
            diff = diff[:8000] + "\n...[truncated]..."
        return {"ok": True, "diff": diff, "pr": pr_num}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main() -> int:
    parser = argparse.ArgumentParser(description="GitHub Hub backend probe for Herdr")
    parser.add_argument("--dir", default=os.getcwd(), help="Target repository directory")
    parser.add_argument("--repo", default=None, help="Explicit owner/repo override")
    parser.add_argument(
        "--action",
        default="status",
        choices=["status", "prs", "runs", "issues", "failed-log", "pr-diff"],
    )
    parser.add_argument("--run-id", default=None, help="Workflow run ID for failed-log")
    parser.add_argument("--pr", default=None, help="PR number for pr-diff")

    args = parser.parse_args()

    gh = find_gh_binary()
    if not gh:
        print(json.dumps({"ok": False, "hasRepo": False, "error": "GitHub CLI (gh) not installed"}))
        return 0

    repo = args.repo
    branch = None
    if not repo:
        repo, branch = get_git_repo_info(args.dir)

    if not repo:
        print(json.dumps({"ok": False, "hasRepo": False, "error": "No GitHub repository found in directory"}))
        return 0

    if args.action == "status":
        res = action_status(gh, repo, branch)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if args.action == "prs":
        res = action_prs(gh, repo)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if args.action == "runs":
        res = action_runs(gh, repo)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if args.action == "issues":
        res = action_issues(gh, repo)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if args.action == "failed-log":
        if not args.run_id:
            print(json.dumps({"ok": False, "error": "Missing --run-id"}))
            return 1
        res = action_failed_log(gh, repo, args.run_id)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    if args.action == "pr-diff":
        if not args.pr:
            print(json.dumps({"ok": False, "error": "Missing --pr"}))
            return 1
        res = action_pr_diff(gh, repo, args.pr)
        print(json.dumps(res, ensure_ascii=False))
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
