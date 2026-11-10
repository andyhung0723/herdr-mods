#!/usr/bin/env python3
"""Install the Loadout mod (agent-loadout matrix) into the Herdr app.

- runs `herdr-app check` on the mod
- copies it to ~/.config/herdr-app/mods/loadout
- writes mods/loadout/config.json with absolute paths to node and the loadout CLI
  (GUI-launched apps don't inherit nvm's PATH, so the mod never relies on PATH)
- binds a global key (default ctrl-b l) to `mod.open:loadout`, refusing to steal a taken key
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MOD_NAME = "loadout"
ACTION_OPEN = f"mod.open:{MOD_NAME}"
DEFAULT_KEY = "ctrl-b l"
DEFAULT_REPO = Path.home() / "Workspace" / "side-project" / "agent-loadout"
MIN_NODE_MAJOR = 24


class InstallError(RuntimeError):
    pass


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install the Herdr Loadout mod")
    parser.add_argument("--home", type=Path, help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)")
    parser.add_argument("--loadout-repo", type=Path, default=DEFAULT_REPO, help="agent-loadout checkout")
    parser.add_argument("--node", type=Path, help="node binary (default: detected, must be >= 24)")
    parser.add_argument("--manifest", type=Path, help="pass --manifest to loadout (default: loadout's own)")
    parser.add_argument("--state", type=Path, help="pass --state to loadout (default: loadout's own)")
    parser.add_argument("--key", default=DEFAULT_KEY, help=f"global key to open the mod (default: {DEFAULT_KEY})")
    parser.add_argument("--dry-run", action="store_true", help="validate and print the plan without writing")
    return parser.parse_args(argv)


def resolve_home(user_home: Path | None) -> Path:
    if user_home is not None:
        return user_home.expanduser().resolve()
    env = os.environ.get("HERDR_APP_HOME")
    return Path(env).expanduser().resolve() if env else Path.home() / ".config" / "herdr-app"


def node_major(node: Path) -> int:
    try:
        version = subprocess.run([str(node), "--version"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise InstallError(f"Cannot run {node}: {error}") from error
    match = re.match(r"v(\d+)", version.strip())
    return int(match.group(1)) if match else 0


def detect_node(explicit: Path | None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(explicit.expanduser())
    if found := shutil.which("node"):
        candidates.append(Path(found))
    nvm_root = Path.home() / ".nvm" / "versions" / "node"
    if nvm_root.is_dir():
        candidates.extend(sorted(nvm_root.glob("v*/bin/node"), key=lambda p: node_sort_key(p), reverse=True))
    candidates.append(Path("/opt/homebrew/bin/node"))

    for candidate in candidates:
        if candidate.exists() and node_major(candidate) >= MIN_NODE_MAJOR:
            return candidate.resolve()
    raise InstallError(f"No node >= {MIN_NODE_MAJOR} found (pass --node)")


def node_sort_key(path: Path) -> tuple[int, ...]:
    version = path.parent.parent.name.lstrip("v")
    return tuple(int(part) for part in version.split(".") if part.isdigit())


def run_mod_check(mod_dir: Path) -> None:
    result = subprocess.run(["herdr-app", "check", str(mod_dir)], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise InstallError(f"herdr-app check failed: {(result.stderr or result.stdout).strip()}")


def backup(path: Path, backups_dir: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = backups_dir / f"{path.name}.{MOD_NAME}-{stamp}"
    shutil.copy2(path, dest)
    return dest


def install_mod(src: Path, dest: Path, config: dict, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] copy {src} -> {dest}")
        print(f"[dry-run] write {dest / 'config.json'}: {json.dumps(config)}")
        return
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    (dest / "config.json").write_text(json.dumps(config, indent=2) + "\n", "utf-8")
    print(f"Installed {dest}")


def bind_key(keys_path: Path, key: str, backups_dir: Path, dry_run: bool) -> None:
    data = json.loads(keys_path.read_text("utf-8")) if keys_path.exists() else {}
    global_keys = data.setdefault("global", {})
    current = global_keys.get(key)
    if current == ACTION_OPEN:
        print(f"Key {key} already opens {MOD_NAME}")
        return
    if current is not None:
        raise InstallError(f"Key {key} is already bound to {current!r}; pick another with --key")

    global_keys[key] = ACTION_OPEN
    if dry_run:
        print(f"[dry-run] bind {key} -> {ACTION_OPEN} in {keys_path}")
        return
    if keys_path.exists():
        print(f"Backed up keys.json to {backup(keys_path, backups_dir)}")
    keys_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"Bound {key} -> {ACTION_OPEN}")


def main() -> int:
    args = parse_args(sys.argv[1:])
    mod_src = Path(__file__).resolve().parent / "mods" / MOD_NAME
    home = resolve_home(args.home)

    try:
        bin_path = (args.loadout_repo.expanduser() / "bin" / "loadout.js").resolve()
        if not bin_path.exists():
            raise InstallError(f"loadout CLI not found at {bin_path} (pass --loadout-repo)")
        config = {"node": str(detect_node(args.node)), "bin": str(bin_path)}
        if args.manifest:
            config["manifest"] = str(args.manifest.expanduser().resolve())
        if args.state:
            config["state"] = str(args.state.expanduser().resolve())

        print("Running herdr-app check…")
        run_mod_check(mod_src)

        backups_dir = home / "backups"
        if not args.dry_run:
            backups_dir.mkdir(parents=True, exist_ok=True)
        install_mod(mod_src, home / "mods" / MOD_NAME, config, args.dry_run)
        bind_key(home / "keys.json", args.key, backups_dir, args.dry_run)
    except InstallError as error:
        print(f"Install failed: {error}", file=sys.stderr)
        return 1

    print(f"\n✅ Loadout ready. Open it with {args.key}, or: herdr-app do mod.open '{{\"name\":\"{MOD_NAME}\"}}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
