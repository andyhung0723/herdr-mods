#!/usr/bin/env python3
"""Collect live Claude Code subagent tasks from session metadata and transcript."""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

SUBAGENT_TOOL_NAMES = {"Agent", "Task", "subagent", "dispatch_agent"}
DEFAULT_STATUSLINE_INPUT = "/tmp/claude-statusline-input.json"
TAIL_BYTES = 4 * 1024 * 1024
AGENT_TAIL_BYTES = 16 * 1024


def resolve_transcript_path(cli_transcript: str | None) -> str | None:
    if cli_transcript:
        return os.path.expanduser(cli_transcript)
    try:
        with open(DEFAULT_STATUSLINE_INPUT, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        tp = data.get("transcript_path")
        return os.path.expanduser(tp) if isinstance(tp, str) and tp else None
    except Exception:
        return None


def subagent_jsonl_has_handback(jsonl_path: str) -> bool:
    if not os.path.isfile(jsonl_path):
        return False
    try:
        size = os.path.getsize(jsonl_path)
        with open(jsonl_path, "rb") as fh:
            if size > AGENT_TAIL_BYTES:
                fh.seek(size - AGENT_TAIL_BYTES)
            tail = fh.read().decode("utf-8", errors="ignore")
        return "SubagentHandback" in tail or "Report delivered to your caller" in tail
    except Exception:
        return False


def resolve_subagents_dir(transcript_path: str | None) -> str | None:
    if not transcript_path:
        return None
    if transcript_path.endswith(".jsonl"):
        return f"{transcript_path[:-len('.jsonl')]}/subagents"
    return None


def collect_meta_tasks(subagents_dir: str | None) -> tuple[dict[str, dict], dict[str, str]]:
    """Read subagents/agent-*.meta.json files ordered chronologically."""
    tasks: dict[str, dict] = {}
    agent_to_task: dict[str, str] = {}
    if not subagents_dir or not os.path.isdir(subagents_dir):
        return tasks, agent_to_task

    meta_files = glob.glob(os.path.join(subagents_dir, "agent-*.meta.json"))

    def sort_key(path: str) -> tuple[float, float]:
        st = os.stat(path)
        birthtime = getattr(st, "st_birthtime", st.st_ctime)
        return (birthtime, st.st_mtime)

    meta_files.sort(key=sort_key)

    for meta_path in meta_files:
        base = os.path.basename(meta_path)
        agent_id = base[len("agent-") : -len(".meta.json")]
        try:
            with open(meta_path, "r", encoding="utf-8", errors="ignore") as fh:
                meta = json.load(fh)
        except Exception:
            meta = {}

        if not isinstance(meta, dict):
            continue

        task_id = meta.get("toolUseId") or agent_id
        name = (
            meta.get("description")
            or meta.get("name")
            or meta.get("agentType")
            or "Subagent"
        )
        finished = meta.get("finished") is True
        if not finished:
            jsonl_path = meta_path[: -len(".meta.json")] + ".jsonl"
            finished = subagent_jsonl_has_handback(jsonl_path)

        status = "done" if finished else "running"
        tasks[task_id] = {
            "id": task_id,
            "name": str(name),
            "status": status,
            "agentId": agent_id,
        }
        agent_to_task[agent_id] = task_id

    return tasks, agent_to_task


def mark_done_from_text(
    raw: str, tasks: dict[str, dict], agent_to_task: dict[str, str]
) -> None:
    for match in re.finditer(r"<tool-use-id>([^<]+)</tool-use-id>", raw):
        tid = match.group(1)
        if tid in tasks:
            tasks[tid]["status"] = "done"
    for match in re.finditer(r'(?:<task-id>|<agent-message from=")([^"<]+)', raw):
        aid = match.group(1)
        tid = agent_to_task.get(aid)
        if tid and tid in tasks:
            tasks[tid]["status"] = "done"


def scan_transcript_tail(
    transcript_path: str | None,
    tasks: dict[str, dict],
    agent_to_task: dict[str, str],
) -> None:
    """Scan the last TAIL_BYTES of the session transcript for new or sync tasks."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return

    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as fh:
            if size > TAIL_BYTES:
                fh.seek(size - TAIL_BYTES)
                # Drop partial first line when seeking into the middle of the file.
                fh.readline()
            chunk = fh.read().decode("utf-8", errors="ignore")
    except Exception:
        return

    for line in chunk.splitlines():
        if not line or '"api-request-blob"' in line:
            continue
        if (
            '"tool_use"' not in line
            and '"tool_result"' not in line
            and "task-notification" not in line
            and "agent-message" not in line
            and "tool-use-id" not in line
        ):
            continue

        try:
            entry = json.loads(line)
        except Exception:
            continue

        if not isinstance(entry, dict) or entry.get("type") == "api-request-blob":
            continue

        entry_type = entry.get("type")
        if entry_type in ("queue-operation", "attachment"):
            raw = str(
                entry.get("content")
                or (entry.get("attachment") or {}).get("prompt")
                or ""
            )
            if raw:
                mark_done_from_text(raw, tasks, agent_to_task)
            continue

        msg = entry.get("message") if isinstance(entry.get("message"), dict) else entry
        content = msg.get("content") if isinstance(msg, dict) else None

        if isinstance(content, str):
            if "<task-notification>" in content or "<agent-message" in content:
                mark_done_from_text(content, tasks, agent_to_task)
            continue

        if not isinstance(content, list):
            continue

        tur = entry.get("toolUseResult")
        for item in content:
            if not isinstance(item, dict):
                continue
            itype = item.get("type")
            if itype == "tool_use" and item.get("name") in SUBAGENT_TOOL_NAMES:
                tid = item.get("id")
                if not tid or tid in tasks:
                    continue
                inp = item.get("input") if isinstance(item.get("input"), dict) else {}
                prompt = str(inp.get("prompt") or "")
                name = (
                    inp.get("description")
                    or inp.get("name")
                    or inp.get("subagent_type")
                    or (prompt[:30] if prompt else "")
                    or "Subagent"
                )
                tasks[tid] = {
                    "id": tid,
                    "name": str(name),
                    "status": "running",
                    "agentId": None,
                }
            elif itype == "tool_result":
                tid = item.get("tool_use_id")
                if not tid or tid not in tasks:
                    continue
                is_async = isinstance(tur, dict) and (
                    tur.get("isAsync") is True or tur.get("status") == "async_launched"
                )
                if not is_async:
                    item_text = json.dumps(item.get("content") or "", ensure_ascii=False)
                    if "Async agent launched" in item_text:
                        is_async = True

                if is_async:
                    aid = tur.get("agentId") if isinstance(tur, dict) else None
                    if aid:
                        tasks[tid]["agentId"] = aid
                        agent_to_task[aid] = tid
                else:
                    tasks[tid]["status"] = "done"


def collect_claude_subagents(transcript_path: str | None) -> dict:
    subagents_dir = resolve_subagents_dir(transcript_path)
    tasks, agent_to_task = collect_meta_tasks(subagents_dir)
    scan_transcript_tail(transcript_path, tasks, agent_to_task)

    if subagents_dir and os.path.isdir(subagents_dir):
        for task in tasks.values():
            aid = task.get("agentId")
            if aid and task["status"] == "running":
                jsonl_path = os.path.join(subagents_dir, f"agent-{aid}.jsonl")
                if subagent_jsonl_has_handback(jsonl_path):
                    task["status"] = "done"

    items = [
        {"id": t["id"], "name": t["name"], "status": t["status"]}
        for t in tasks.values()
    ]
    running = sum(1 for t in items if t["status"] == "running")
    done = sum(1 for t in items if t["status"] == "done")
    return {
        "total": len(items),
        "running": running,
        "done": done,
        "items": items,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect Claude Code subagent status")
    parser.add_argument("--transcript", help="Path to Claude Code session transcript JSONL")
    args = parser.parse_args(argv)

    transcript_path = resolve_transcript_path(args.transcript)
    result = collect_claude_subagents(transcript_path)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
