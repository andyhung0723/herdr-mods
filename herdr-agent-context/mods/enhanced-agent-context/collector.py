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


def get_file_meta(p: Path) -> Dict[str, Any]:
    try:
        stat = p.stat()
        mtime = datetime.datetime.fromtimestamp(stat.st_mtime, tz=datetime.timezone.utc).isoformat()
        content = safe_read_file(p, max_bytes=2048) or ""
        lines = content.splitlines()
        preview = "\n".join(lines[:8])
        return {
            "name": p.name,
            "path": str(p.resolve()),
            "displayPath": str(p),
            "size": stat.st_size,
            "lines": len(lines),
            "modified": mtime,
            "preview": preview,
            "isSymlink": p.is_symlink(),
        }
    except Exception:
        return {
            "name": p.name,
            "path": str(p),
            "displayPath": str(p),
            "size": 0,
            "lines": 0,
            "modified": None,
            "preview": "",
            "isSymlink": False,
        }


def parse_skill_meta(skill_dir: Path, agent: str) -> Dict[str, Any]:
    name = skill_dir.name
    desc = ""
    prompt_file = None
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        skill_md = skill_dir / "skill.md"

    if skill_md.is_file():
        content = safe_read_file(skill_md, 4096) or ""
        prompt_file = str(skill_md)
        # Extract YAML frontmatter description
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
            # First non-header paragraph
            for line in content.splitlines():
                line = line.strip()
                if line and not line.startswith(("#", "---")):
                    desc = line
                    break

    return {
        "name": name,
        "agent": agent,
        "path": str(skill_dir),
        "description": desc or f"{agent.capitalize()} skill package",
        "hasPrompt": prompt_file is not None,
        "promptFile": prompt_file,
    }


def collect_rules(cwd: Path, home: Path) -> List[Dict[str, Any]]:
    rules: List[Dict[str, Any]] = []
    seen_paths = set()

    # 1. Project level rules
    candidate_names = [
        "CLAUDE.md",
        "AGENTS.md",
        "GEMINI.md",
        ".cursorrules",
        ".windsurfrules",
        ".claude.md",
    ]
    cur = cwd.resolve()
    # Check current directory and up to 2 parent directories
    checks = [cur]
    if cur.parent != cur:
        checks.append(cur.parent)

    for folder in checks:
        for fname in candidate_names:
            p = folder / fname
            if p.exists() and str(p.resolve()) not in seen_paths:
                seen_paths.add(str(p.resolve()))
                meta = get_file_meta(p)
                meta["scope"] = "project" if folder == cur else "workspace"
                rules.append(meta)

    # 2. Global rules
    global_candidates = [
        home / ".claude" / "CLAUDE.md",
        home / ".codex" / "AGENTS.md",
        home / ".gemini" / "antigravity-cli" / "GEMINI.md",
    ]
    for gp in global_candidates:
        if gp.exists() and str(gp.resolve()) not in seen_paths:
            seen_paths.add(str(gp.resolve()))
            meta = get_file_meta(gp)
            meta["scope"] = "global"
            rules.append(meta)

    return rules


def collect_skills(home: Path, cwd: Path) -> List[Dict[str, Any]]:
    skills: List[Dict[str, Any]] = []

    # Claude skills
    c_dirs = [home / ".claude" / "skills", cwd / ".claude" / "skills"]
    for d in c_dirs:
        if d.is_dir():
            for item in sorted(d.iterdir()):
                if item.is_dir() and not item.name.startswith("."):
                    skills.append(parse_skill_meta(item, "claude"))

    # Codex skills
    x_dirs = [home / ".codex" / "skills", cwd / ".codex" / "skills"]
    for d in x_dirs:
        if d.is_dir():
            for item in sorted(d.iterdir()):
                if item.is_dir() and not item.name.startswith("."):
                    skills.append(parse_skill_meta(item, "codex"))

    # Antigravity skills
    a_dirs = [
        home / ".gemini" / "antigravity-cli" / "builtin" / "skills",
        home / ".gemini" / "antigravity-cli" / "skills",
    ]
    for d in a_dirs:
        if d.is_dir():
            for item in sorted(d.iterdir()):
                if item.is_dir() and not item.name.startswith("."):
                    skills.append(parse_skill_meta(item, "antigravity"))

    return skills


def collect_connectors(home: Path, cwd: Path) -> List[Dict[str, Any]]:
    connectors: List[Dict[str, Any]] = []

    # 1. Claude MCP Servers
    claude_sources = [
        home / ".claude.json",
        home / ".claude" / "settings.json",
        cwd / ".claude" / "mcp.json",
    ]
    for src in claude_sources:
        if src.is_file():
            try:
                data = json.loads(src.read_text(encoding="utf-8"))
                mcp_map = data.get("mcpServers") or {}
                for name, cfg in mcp_map.items():
                    connectors.append({
                        "name": name,
                        "agent": "claude",
                        "command": cfg.get("command") or "custom",
                        "args": cfg.get("args") or [],
                        "env": list(cfg.get("env", {}).keys()),
                        "source": str(src.name),
                        "status": "configured",
                    })
            except Exception:
                pass

    # 2. Codex MCP Servers from config.toml
    codex_cfg = home / ".codex" / "config.toml"
    if codex_cfg.is_file():
        content = safe_read_file(codex_cfg, 100_000) or ""
        # Find sections like [mcp_servers.playwright]
        server_matches = re.finditer(r"\[mcp_servers\.([a-zA-Z0-9_\-]+)\](.*?)(?=\n\[|$)", content, re.DOTALL)
        for m in server_matches:
            name = m.group(1)
            body = m.group(2)
            cmd_match = re.search(r"command\s*=\s*[\"']([^\"']+)[\"']", body)
            args_match = re.search(r"args\s*=\s*\[(.*?)\]", body)
            args = []
            if args_match:
                args = [a.strip().strip("\"'") for a in args_match.group(1).split(",") if a.strip()]
            connectors.append({
                "name": name,
                "agent": "codex",
                "command": cmd_match.group(1) if cmd_match else "npx/bin",
                "args": args,
                "env": [],
                "source": "config.toml",
                "status": "configured",
            })

    return connectors


def collect_plugins(home: Path) -> List[Dict[str, Any]]:
    plugins: List[Dict[str, Any]] = []
    # Claude enabledPlugins in settings.json
    c_set = home / ".claude" / "settings.json"
    if c_set.is_file():
        try:
            data = json.loads(c_set.read_text(encoding="utf-8"))
            for p in data.get("enabledPlugins") or []:
                plugins.append({"name": str(p), "agent": "claude", "enabled": True})
        except Exception:
            pass

    # Codex plugins directory
    x_plug = home / ".codex" / "plugins"
    if x_plug.is_dir():
        for p in x_plug.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                plugins.append({"name": p.name, "agent": "codex", "enabled": True})

    return plugins


def collect_git_info(cwd: Path) -> Dict[str, Any]:
    info = {"isRepo": False, "branch": "", "remote": "", "dirtyCount": 0}
    try:
        proc = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, check=False)
        if proc.returncode == 0 and "true" in proc.stdout:
            info["isRepo"] = True
            b_proc = subprocess.run(["git", "-C", str(cwd), "branch", "--show-current"], capture_output=True, text=True, check=False)
            info["branch"] = b_proc.stdout.strip() or "HEAD"
            s_proc = subprocess.run(["git", "-C", str(cwd), "status", "--porcelain"], capture_output=True, text=True, check=False)
            dirty_lines = [l for l in s_proc.stdout.splitlines() if l.strip()]
            info["dirtyCount"] = len(dirty_lines)
    except Exception:
        pass
    return info


def detect_models(home: Path) -> Dict[str, str]:
    models = {
        "claude": "Claude 3.7 Sonnet",
        "codex": "GPT-5",
        "antigravity": "Gemini 2.5 Pro",
    }
    # Claude
    c_set = home / ".claude" / "settings.json"
    if c_set.is_file():
        try:
            data = json.loads(c_set.read_text(encoding="utf-8"))
            if data.get("model"):
                models["claude"] = str(data["model"])
        except Exception:
            pass
    # Codex
    x_cfg = home / ".codex" / "config.toml"
    if x_cfg.is_file():
        content = safe_read_file(x_cfg, 10_000) or ""
        m = re.search(r"model\s*=\s*[\"']([^\"']+)[\"']", content)
        if m:
            models["codex"] = m.group(1)
    return models


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Agent Context")
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Target workspace cwd")
    parser.add_argument("--agent", type=str, default="all", help="Target agent filter (claude, codex, antigravity, all)")
    args = parser.parse_args()

    home = Path.home()
    target_cwd = args.cwd.resolve()

    rules = collect_rules(target_cwd, home)
    skills = collect_skills(home, target_cwd)
    connectors = collect_connectors(home, target_cwd)
    plugins = collect_plugins(home)
    git_info = collect_git_info(target_cwd)
    models = detect_models(home)

    payload = {
        "cwd": str(target_cwd),
        "targetAgent": args.agent,
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
