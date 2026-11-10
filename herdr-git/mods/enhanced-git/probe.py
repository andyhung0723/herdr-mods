#!/usr/bin/env python3
"""GitHub Hub backend probe for Herdr.

Queries GitHub CLI (gh) via fast GraphQL & parallel execution for
repository status, Pull Requests, Actions (CI), and Issues.
"""

from __future__ import annotations

import argparse
import concurrent.futures
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


def resolve_repo_dir(cwd: str) -> str:
    """Find directory containing .git, checking cwd, parents, or immediate children."""
    if not cwd or not os.path.exists(cwd):
        return cwd
    try:
        res = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    try:
        entries = os.listdir(cwd)
        base = os.path.basename(os.path.normpath(cwd))
        if base in entries and os.path.isdir(os.path.join(cwd, base, ".git")):
            return os.path.join(cwd, base)
        for entry in entries:
            sub = os.path.join(cwd, entry)
            if os.path.isdir(sub) and os.path.isdir(os.path.join(sub, ".git")):
                return sub
    except Exception:
        pass
    return cwd


def get_git_repo_info(cwd: str) -> tuple[str | None, str | None]:
    """Extract owner/repo and current branch from git directory."""
    actual_dir = resolve_repo_dir(cwd)
    try:
        res = subprocess.run(
            ["git", "-C", actual_dir, "config", "--get", "remote.origin.url"],
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

        b_res = subprocess.run(
            ["git", "-C", actual_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        branch = b_res.stdout.strip() if b_res.returncode == 0 else None
        return repo, branch
    except Exception:
        return None, None


def query_graphql(gh: str, owner: str, name: str) -> dict | None:
    """Fetch PRs and Issues in a single GraphQL query (under 0.7s)."""
    gql = """
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        url
        pullRequests(states: OPEN, first: 15, orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount
          nodes {
            number
            title
            headRefName
            additions
            deletions
            updatedAt
            author { login }
            reviewDecision
            isDraft
            url
          }
        }
        issues(states: OPEN, first: 15, orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount
          nodes {
            number
            title
            updatedAt
            author { login }
            url
          }
        }
      }
    }
    """
    try:
        res = subprocess.run(
            [gh, "api", "graphql", "-f", f"query={gql}", "-F", f"owner={owner}", "-F", f"name={name}"],
            capture_output=True,
            text=True,
            timeout=6,
        )
        if res.returncode == 0 and res.stdout.strip():
            return json.loads(res.stdout.strip())
    except Exception:
        pass
    return None


def query_runs(gh: str, repo: str) -> list:
    """Fetch recent GitHub Actions runs."""
    try:
        res = subprocess.run(
            [
                gh, "run", "list",
                "-R", repo,
                "--limit", "10",
                "--json", "databaseId,name,status,conclusion,headBranch,url,workflowName,event,createdAt",
            ],
            capture_output=True,
            text=True,
            timeout=6,
        )
        if res.returncode == 0 and res.stdout.strip():
            return json.loads(res.stdout.strip())
    except Exception:
        pass
    return []


def action_bundle(gh: str, repo: str, branch: str | None) -> dict:
    """Fetch Status, PRs, Issues, and Runs concurrently in < 0.8s."""
    parts = repo.split("/", 1)
    if len(parts) != 2:
        return {"hasRepo": False, "error": f"Invalid repo format: {repo}"}
    owner, name = parts

    gql_future = None
    runs_future = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        gql_future = executor.submit(query_graphql, gh, owner, name)
        runs_future = executor.submit(query_runs, gh, repo)

    gql_res = gql_future.result() if gql_future else None
    runs = runs_future.result() if runs_future else []

    prs = []
    prs_count = 0
    issues = []
    issues_count = 0
    repo_url = f"https://github.com/{repo}"

    if gql_res and "data" in gql_res and "repository" in gql_res["data"]:
        repo_data = gql_res["data"]["repository"] or {}
        repo_url = repo_data.get("url", repo_url)
        pr_data = repo_data.get("pullRequests", {})
        prs_count = pr_data.get("totalCount", 0)
        prs = pr_data.get("nodes", []) or []

        issue_data = repo_data.get("issues", {})
        issues_count = issue_data.get("totalCount", 0)
        issues = issue_data.get("nodes", []) or []

    # Identify latest CI run for branch
    ci_latest = None
    if runs and isinstance(runs, list):
        if branch:
            matching = [r for r in runs if r.get("headBranch") == branch]
            if matching:
                ci_latest = matching[0]
        if not ci_latest and len(runs) > 0:
            ci_latest = runs[0]

    return {
        "ok": True,
        "hasRepo": True,
        "repo": repo,
        "branch": branch or "main",
        "url": repo_url,
        "ci": ci_latest,
        "prs": prs,
        "prs_count": prs_count,
        "issues": issues,
        "issues_count": issues_count,
        "runs": runs,
    }


def action_failed_log(gh: str, repo: str, run_id: str) -> dict:
    try:
        res = subprocess.run(
            [gh, "run", "view", run_id, "--log-failed", "-R", repo],
            capture_output=True,
            text=True,
            timeout=10,
        )
        log = res.stdout.strip() or res.stderr.strip()
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
        default="bundle",
        choices=["bundle", "status", "prs", "runs", "issues", "failed-log", "pr-diff"],
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

    # For status, prs, runs, issues, or bundle: use fast bundle
    res = action_bundle(gh, repo, branch)
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
