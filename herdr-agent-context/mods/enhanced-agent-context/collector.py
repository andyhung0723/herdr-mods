#!/usr/bin/env python3
"""Collector for Agent Context: Rules, Skills, Connectors (MCP), and Environment."""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional


def safe_read_file(path: Path, max_bytes: int = 100_000) -> Optional[str]:
    try:
        if path.is_file():
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read(max_bytes)
    except Exception:
        pass
    return None


def get_file_meta(p: Path, agent: str, scope: str) -> Dict[str, Any]:
    try:
        stat = p.stat()
        mtime = datetime.datetime.fromtimestamp(stat.st_mtime, tz=datetime.timezone.utc).isoformat()
        content = safe_read_file(p, max_bytes=2048) or ""
        full_content = safe_read_file(p, max_bytes=200_000) or content
        lines = full_content.splitlines()
        preview = "\n".join(lines[:8])
        is_symlink = p.is_symlink()
        resolved_path = str(p.resolve())
        return {
            "name": p.name,
            "path": resolved_path,
            "displayPath": str(p),
            "targetPath": resolved_path if is_symlink else None,
            "size": stat.st_size,
            "lines": len(lines),
            "modified": mtime,
            "preview": preview,
            "isSymlink": is_symlink,
            "agent": agent,
            "scope": scope,
        }
    except Exception:
        return {
            "name": p.name,
            "path": str(p),
            "displayPath": str(p),
            "targetPath": None,
            "size": 0,
            "lines": 0,
            "modified": None,
            "preview": "",
            "isSymlink": False,
            "agent": agent,
            "scope": scope,
        }


def parse_skill_meta(skill_dir: Path, agent: str, scope: str = "global") -> Dict[str, Any]:
    name = skill_dir.name
    desc = ""
    prompt_file = None
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        skill_md = skill_dir / "skill.md"

    if skill_md.is_file():
        content = safe_read_file(skill_md, 4096) or ""
        prompt_file = str(skill_md)
        fm_match = re.search(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
        if fm_match:
            fm = fm_match.group(1)
            desc_match = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
            if desc_match:
                desc = desc_match.group(1).strip().strip("'\"")
            name_match = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
            if name_match:
                name = name_match.group(1).strip().strip("'\"")
        if not desc:
            for line in content.splitlines():
                line = line.strip()
                if line and not line.startswith(("#", "---")):
                    desc = line
                    break

    return {
        "name": name,
        "agent": agent,
        "scope": scope,
        "path": str(skill_dir),
        "description": desc or f"{agent.capitalize()} skill package",
        "hasPrompt": prompt_file is not None,
        "promptFile": prompt_file,
    }


def matches_agent(item_agent: str, target_agent: str) -> bool:
    if not target_agent or target_agent == "all":
        return True
    return item_agent == target_agent


def collect_rules(cwd: Path, home: Path, target_agent: str = "all") -> List[Dict[str, Any]]:
    rules: List[Dict[str, Any]] = []
    seen_keys = set()

    cur = cwd.resolve()
    checks = [cur]
    p_dir = cur.parent
    for _ in range(4):
        if p_dir == p_dir.parent or p_dir == home:
            break
        checks.append(p_dir)
        p_dir = p_dir.parent

    # Map each project rule file pattern to the agent(s) that actually consume it
    project_agent_files = [
        ("CLAUDE.md", "claude"),
        (".claude.md", "claude"),
        (".claude/CLAUDE.md", "claude"),
        ("AGENTS.md", "codex"),
        (".codex/AGENTS.md", "codex"),
        ("GEMINI.md", "antigravity"),
        ("AGENTS.md", "antigravity"),
        (".gemini/GEMINI.md", "antigravity"),
    ]

    for folder in checks:
        scope = "project" if folder == cur else "workspace"
        for rel_name, rule_agent in project_agent_files:
            if not matches_agent(rule_agent, target_agent):
                continue
            p = folder / rel_name
            # If viewing 'all', avoid showing the exact same symlink path twice in the same folder
            dedup_key = (
                f"{folder}::{p.name}" if target_agent == "all" else f"{rule_agent}::{folder}::{rel_name}"
            )
            if p.exists() and dedup_key not in seen_keys:
                seen_keys.add(dedup_key)
                rules.append(get_file_meta(p, rule_agent, scope))

    # Global rules per agent
    global_candidates = [
        (home / ".claude" / "CLAUDE.md", "claude"),
        (home / ".codex" / "AGENTS.md", "codex"),
        (home / ".codex" / "rules" / "default.rules", "codex"),
        (home / ".gemini" / "antigravity-cli" / "GEMINI.md", "antigravity"),
        (home / ".gemini" / "GEMINI.md", "antigravity"),
    ]
    for gp, rule_agent in global_candidates:
        if not matches_agent(rule_agent, target_agent):
            continue
        dedup_key = f"global::{rule_agent}::{gp}"
        if gp.exists() and dedup_key not in seen_keys:
            seen_keys.add(dedup_key)
            rules.append(get_file_meta(gp, rule_agent, "global"))

    return rules


def collect_skills(home: Path, cwd: Path, target_agent: str = "all") -> List[Dict[str, Any]]:
    skills: List[Dict[str, Any]] = []
    seen = set()

    def add_from_dir(d: Path, agent: str, scope: str) -> None:
        if not matches_agent(agent, target_agent) or not d.is_dir():
            return
        for item in sorted(d.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                key = f"{agent}::{item.name}"
                if key not in seen:
                    seen.add(key)
                    skills.append(parse_skill_meta(item, agent, scope))

    # Claude skills (project first, then global)
    add_from_dir(cwd / ".claude" / "skills", "claude", "project")
    add_from_dir(home / ".claude" / "skills", "claude", "global")

    # Codex skills (project first, then global)
    add_from_dir(cwd / ".codex" / "skills", "codex", "project")
    add_from_dir(cwd / ".agents" / "skills", "codex", "project")
    add_from_dir(home / ".codex" / "skills", "codex", "global")

    # Antigravity skills (project first, then global & builtin)
    add_from_dir(cwd / ".agent" / "skills", "antigravity", "project")
    add_from_dir(cwd / ".gemini" / "skills", "antigravity", "project")
    add_from_dir(home / ".gemini" / "antigravity-cli" / "skills", "antigravity", "global")
    add_from_dir(home / ".gemini" / "antigravity-cli" / "builtin" / "skills", "antigravity", "builtin")

    return skills


def collect_connectors(home: Path, cwd: Path, target_agent: str = "all") -> List[Dict[str, Any]]:
    connectors: List[Dict[str, Any]] = []
    seen = set()

    # 1. Claude MCP Servers
    if matches_agent("claude", target_agent):
        claude_sources = [
            cwd / ".mcp.json",
            cwd / ".claude" / "mcp.json",
            home / ".claude.json",
            home / ".claude" / "settings.json",
        ]
        for src in claude_sources:
            if src.is_file():
                try:
                    data = json.loads(src.read_text(encoding="utf-8"))
                    mcp_map = dict(data.get("mcpServers") or {})
                    # Also check project-scoped MCP servers inside ~/.claude.json
                    projects_map = data.get("projects")
                    if isinstance(projects_map, dict):
                        proj_cfg = projects_map.get(str(cwd)) or projects_map.get(str(cwd.resolve()))
                        if isinstance(proj_cfg, dict) and isinstance(proj_cfg.get("mcpServers"), dict):
                            mcp_map.update(proj_cfg["mcpServers"])
                    for name, cfg in mcp_map.items():
                        if not isinstance(cfg, dict):
                            continue
                        key = f"claude::{name}"
                        if key in seen:
                            continue
                        seen.add(key)
                        connectors.append({
                            "name": name,
                            "agent": "claude",
                            "command": cfg.get("command") or cfg.get("url") or "custom",
                            "args": cfg.get("args") or [],
                            "env": list((cfg.get("env") or {}).keys()),
                            "source": str(src.name),
                            "status": "configured",
                        })
                except Exception:
                    pass

    # 2. Codex MCP Servers from config.toml
    if matches_agent("codex", target_agent):
        codex_cfg = home / ".codex" / "config.toml"
        if codex_cfg.is_file():
            content = safe_read_file(codex_cfg, 100_000) or ""
            server_matches = re.finditer(
                r"\[mcp_servers\.([a-zA-Z0-9_\-]+)\](.*?)(?=\n\[|$)", content, re.DOTALL
            )
            for m in server_matches:
                name = m.group(1)
                body = m.group(2)
                # Skip nested sections like [mcp_servers.foo.env]
                if "." in name:
                    continue
                cmd_match = re.search(r"command\s*=\s*[\"']([^\"']+)[\"']", body)
                url_match = re.search(r"url\s*=\s*[\"']([^\"']+)[\"']", body)
                args_match = re.search(r"args\s*=\s*\[(.*?)\]", body)
                args = []
                if args_match:
                    args = [a.strip().strip("\"'") for a in args_match.group(1).split(",") if a.strip()]
                key = f"codex::{name}"
                if key not in seen:
                    seen.add(key)
                    connectors.append({
                        "name": name,
                        "agent": "codex",
                        "command": (
                            cmd_match.group(1)
                            if cmd_match
                            else (url_match.group(1) if url_match else "npx/bin")
                        ),
                        "args": args,
                        "env": [],
                        "source": "config.toml",
                        "status": "configured",
                    })

    # 3. Antigravity MCP Servers
    if matches_agent("antigravity", target_agent):
        agy_sources = [
            home / ".gemini" / "antigravity-cli" / "mcp_config.json",
            home / ".gemini" / "config" / "mcp_config.json",
            home / ".gemini" / "settings.json",
        ]
        for src in agy_sources:
            if src.is_file():
                try:
                    raw = src.read_text(encoding="utf-8").strip()
                    if not raw:
                        continue
                    data = json.loads(raw)
                    mcp_map = data.get("mcpServers") or {}
                    for name, cfg in mcp_map.items():
                        if not isinstance(cfg, dict):
                            continue
                        key = f"antigravity::{name}"
                        if key in seen:
                            continue
                        seen.add(key)
                        connectors.append({
                            "name": name,
                            "agent": "antigravity",
                            "command": cfg.get("command") or cfg.get("url") or "custom",
                            "args": cfg.get("args") or [],
                            "env": list((cfg.get("env") or {}).keys()),
                            "source": str(src.name),
                            "status": "configured",
                        })
                except Exception:
                    pass

    return connectors


def collect_plugins(home: Path, target_agent: str = "all") -> List[Dict[str, Any]]:
    plugins: List[Dict[str, Any]] = []
    if matches_agent("claude", target_agent):
        c_set = home / ".claude" / "settings.json"
        if c_set.is_file():
            try:
                data = json.loads(c_set.read_text(encoding="utf-8"))
                enabled = data.get("enabledPlugins")
                if isinstance(enabled, dict):
                    for k, v in enabled.items():
                        if v:
                            plugins.append({"name": str(k), "agent": "claude", "enabled": True})
                elif isinstance(enabled, list):
                    for p in enabled:
                        plugins.append({"name": str(p), "agent": "claude", "enabled": True})
            except Exception:
                pass

    if matches_agent("codex", target_agent):
        x_plug = home / ".codex" / "plugins"
        if x_plug.is_dir():
            for p in sorted(x_plug.iterdir()):
                if p.is_dir() and not p.name.startswith("."):
                    plugins.append({"name": p.name, "agent": "codex", "enabled": True})

    if matches_agent("antigravity", target_agent):
        a_plug = home / ".gemini" / "antigravity-cli" / "builtin" / "plugins"
        if a_plug.is_dir():
            for p in sorted(a_plug.iterdir()):
                if p.is_dir() and not p.name.startswith("."):
                    plugins.append({"name": p.name, "agent": "antigravity", "enabled": True})

    return plugins


def collect_git_info(cwd: Path) -> Dict[str, Any]:
    info = {"isRepo": False, "branch": "", "remote": "", "dirtyCount": 0}
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and "true" in proc.stdout:
            info["isRepo"] = True
            b_proc = subprocess.run(
                ["git", "-C", str(cwd), "branch", "--show-current"],
                capture_output=True,
                text=True,
                check=False,
            )
            info["branch"] = b_proc.stdout.strip() or "HEAD"
            s_proc = subprocess.run(
                ["git", "-C", str(cwd), "status", "--porcelain"],
                capture_output=True,
                text=True,
                check=False,
            )
            dirty_lines = [l for l in s_proc.stdout.splitlines() if l.strip()]
            info["dirtyCount"] = len(dirty_lines)
    except Exception:
        pass
    return info


def detect_models(home: Path) -> Dict[str, str]:
    models = {
        "claude": "Claude Sonnet 4",
        "codex": "GPT-5",
        "antigravity": "Gemini 2.5 Pro",
    }
    c_set = home / ".claude" / "settings.json"
    if c_set.is_file():
        try:
            data = json.loads(c_set.read_text(encoding="utf-8"))
            if data.get("model"):
                models["claude"] = str(data["model"])
        except Exception:
            pass
    x_cfg = home / ".codex" / "config.toml"
    if x_cfg.is_file():
        content = safe_read_file(x_cfg, 10_000) or ""
        m = re.search(r"model\s*=\s*[\"']([^\"']+)[\"']", content)
        if m:
            models["codex"] = m.group(1)
    a_set = home / ".gemini" / "antigravity-cli" / "settings.json"
    if a_set.is_file():
        try:
            data = json.loads(a_set.read_text(encoding="utf-8"))
            if data.get("model"):
                models["antigravity"] = str(data["model"])
        except Exception:
            pass
    return models


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Agent Context")
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Target workspace cwd")
    parser.add_argument(
        "--agent",
        type=str,
        default="all",
        help="Target agent filter (claude, codex, antigravity, all)",
    )
    args = parser.parse_args()

    home = Path.home()
    target_cwd = args.cwd.resolve()
    target_agent = (args.agent or "all").lower().strip()

    rules = collect_rules(target_cwd, home, target_agent)
    skills = collect_skills(home, target_cwd, target_agent)
    connectors = collect_connectors(home, target_cwd, target_agent)
    plugins = collect_plugins(home, target_agent)
    git_info = collect_git_info(target_cwd)
    models = detect_models(home)

    payload = {
        "cwd": str(target_cwd),
        "targetAgent": target_agent,
        "models": models,
        "git": git_info,
        "rules": rules,
        "skills": skills,
        "connectors": connectors,
        "plugins": plugins,
        "summary": {
            "rulesCount": len(rules),
            "skillsCount": len(skills),
            "connectorsCount": len(connectors),
            "pluginsCount": len(plugins),
        },
    }

    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
