#!/usr/bin/env python3
"""Install the popup-terminal Herdr mod into a personal layout.

The installer is deliberately conservative: it only edits a cloned layout,
never overwrites a different mod, and aborts on shortcut conflicts.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SHORTCUT = "ctrl-b t"
ACTION = "popup-terminal.toggle"
MOD_NAME = "popup-terminal"
CONTROLLER_ID = "popup-terminal-controller"


class InstallError(RuntimeError):
    """An expected validation or installation failure."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install Herdr popup-terminal")
    parser.add_argument(
        "--home",
        type=Path,
        help="Herdr app home (default: HERDR_APP_HOME or ~/.config/herdr-app)",
    )
    parser.add_argument("--layout", default="legacy", help="personal layout name")
    parser.add_argument(
        "--clone-from",
        help="clone this layout into --layout before installing (for example: main)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="validate and print the plan without writing"
    )
    return parser.parse_args(argv)


def fail(message: str) -> InstallError:
    return InstallError(message)


def read_json(path: Path, label: str) -> tuple[Any, bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise fail(f"找不到 {label}: {path} ({exc})") from exc
    try:
        return json.loads(raw.decode("utf-8")), raw
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise fail(f"{label} 不是有效的 UTF-8 JSON: {path} ({exc})") from exc


def run_mod_check(source_mod: Path, home: Path | None = None) -> None:
    try:
        child_env = os.environ.copy()
        if home is not None:
            child_env["HERDR_APP_HOME"] = str(home)
        result = subprocess.run(
            ["herdr-app", "check", str(source_mod)],
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
            env=child_env,
        )
    except FileNotFoundError as exc:
        raise fail("找不到 herdr-app；請先讓 Herdr CLI 出現在 PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise fail("herdr-app check 超過 45 秒，安裝已中止") from exc
    if result.returncode:
        details = (result.stdout + result.stderr).strip()
        raise fail(f"popup-terminal mod 未通過 herdr-app check：{details or '未知錯誤'}")


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise fail(f"mod 不得包含 symlink：{path}")
        if path.is_file():
            yield path.relative_to(root)


def trees_equal(left: Path, right: Path) -> bool:
    if not left.is_dir() or not right.is_dir():
        return False
    try:
        left_files = set(iter_files(left))
        right_files = set(iter_files(right))
    except InstallError:
        return False
    if left_files != right_files:
        return False
    return all((left / rel).read_bytes() == (right / rel).read_bytes() for rel in left_files)


def walk_nodes(value: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(value, dict):
        return
    yield value
    children = value.get("children")
    if isinstance(children, list):
        for child in children:
            yield from walk_nodes(child)


def has_active_tab_descendant(node: dict[str, Any]) -> bool:
    return any(
        item.get("content", {}).get("tab") == "active"
        for item in walk_nodes(node)
        if item is not node
    )


def direct_mod_child(node: dict[str, Any], mod_name: str) -> bool:
    children = node.get("children")
    return isinstance(children, list) and any(
        isinstance(child, dict)
        and child.get("content", {}).get("mod") == mod_name
        for child in children
    )


def controller_node() -> dict[str, Any]:
    return {
        "id": CONTROLLER_ID,
        "type": "block",
        "size": {"px": 0},
        "min": 0,
        "max": 0,
        "content": {"mod": MOD_NAME, "props": {"role": "controller"}},
    }


def prepare_layout(layout: Any, *, require_cloned: bool = True) -> tuple[Any, bool]:
    if not isinstance(layout, dict):
        raise fail("layout JSON 頂層必須是 object")
    if require_cloned and not isinstance(layout.get("cloned_from"), dict):
        raise fail("目標 layout 沒有 cloned_from；為避免修改 Herdr shipped layout，安裝已中止")

    desired = controller_node()
    nodes = list(walk_nodes(layout))
    existing = [node for node in nodes if node.get("id") == CONTROLLER_ID]
    if len(existing) > 1:
        raise fail(f"layout 已有多個 {CONTROLLER_ID}，無法安全判定安裝位置")

    target: dict[str, Any] | None = None
    for node in nodes:
        if (
            node.get("type") == "column"
            and direct_mod_child(node, "legacy-commands")
            and has_active_tab_descendant(node)
        ):
            target = node
            break
    # Shipped layouts such as `main` do not contain legacy-commands.  Their
    # first column containing the active-tab composition is the safe fallback.
    if target is None:
        for node in nodes:
            if node.get("type") == "column" and has_active_tab_descendant(node):
                target = node
                break
    if target is None:
        raise fail(
            "layout 找不到含 active tab 子孫的 column；未改寫 layout"
        )

    children = target.get("children")
    if not isinstance(children, list):
        raise fail("目標 column 缺少 children 陣列；未改寫 layout")

    if existing:
        if existing[0] != desired:
            raise fail(f"layout 已有不同內容的 {CONTROLLER_ID}，拒絕覆寫")
        if existing[0] not in children:
            raise fail(f"既有 {CONTROLLER_ID} 不在預期 column，拒絕改動 layout")
        return layout, False

    updated = copy.deepcopy(layout)
    # Locate the same target by a stable object path in the copied tree.
    target_path = node_path(layout, target)
    copied_target = target_at_path(updated, target_path)
    copied_target.setdefault("children", []).append(desired)
    return updated, True


def node_path(root: dict[str, Any], target: dict[str, Any]) -> tuple[int, ...]:
    found: tuple[int, ...] | None = None

    def visit(node: Any, path: tuple[int, ...]) -> None:
        nonlocal found
        if found is not None:
            return
        if node is target:
            found = path
            return
        if isinstance(node, dict) and isinstance(node.get("children"), list):
            for index, child in enumerate(node["children"]):
                visit(child, path + (index,))

    visit(root, ())
    if found is None:
        raise fail("內部錯誤：找不到 layout 目標 column")
    return found


def target_at_path(root: dict[str, Any], path: tuple[int, ...]) -> dict[str, Any]:
    node: Any = root
    for index in path:
        children = node.get("children") if isinstance(node, dict) else None
        if not isinstance(children, list) or index >= len(children):
            raise fail("內部錯誤：layout 目標路徑失效")
        node = children[index]
    if not isinstance(node, dict):
        raise fail("內部錯誤：layout 目標不是 object")
    return node


def prepare_keys(keys: Any, layout_name: str) -> tuple[Any, bool]:
    if not isinstance(keys, dict):
        raise fail("keys.json 頂層必須是 object")
    updated = copy.deepcopy(keys)
    relevant = ["global", "terminal", f"layout:{layout_name}"]
    for section_name in relevant:
        section = updated.get(section_name)
        if section is not None and not isinstance(section, dict):
            raise fail(f"keys.json 的 {section_name} 必須是 object")
        if isinstance(section, dict) and SHORTCUT in section and section[SHORTCUT] != ACTION:
            raise fail(
                f"快捷鍵衝突：{section_name} 的 {SHORTCUT!r} 已綁定 {section[SHORTCUT]!r}，未覆寫"
            )
    section = updated.setdefault(f"layout:{layout_name}", {})
    if not isinstance(section, dict):
        raise fail(f"keys.json 的 layout:{layout_name} 必須是 object")
    changed = section.get(SHORTCUT) != ACTION
    section[SHORTCUT] = ACTION
    return updated, changed


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary_path = Path(temporary)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def backup_files(home: Path, keys_path: Path, layout_path: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = home / "backups" / "popup-terminal" / timestamp
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(keys_path, backup / "keys.json")
    shutil.copy2(layout_path, backup / layout_path.name)
    return backup


def ensure_snapshots(keys_path: Path, layout_path: Path, keys_raw: bytes, layout_raw: bytes) -> None:
    try:
        current_keys = keys_path.read_bytes()
        current_layout = layout_path.read_bytes()
    except OSError as exc:
        raise fail(f"安裝前重新讀取設定失敗，為避免覆蓋外部變更已中止：{exc}") from exc
    if current_keys != keys_raw or current_layout != layout_raw:
        raise fail("keys.json 或 layout 在檢查後已變更；為避免遺失修改，請重新執行")


def ensure_file_snapshot(path: Path, expected: bytes, label: str) -> None:
    try:
        current = path.read_bytes()
    except OSError as exc:
        raise fail(f"{label} 在安裝前已消失；為避免覆蓋外部變更已中止：{exc}") from exc
    if current != expected:
        raise fail(f"{label} 在安裝前已變更；為避免遺失修改，請重新執行")


def has_controller(layout: Any) -> bool:
    return any(node.get("id") == CONTROLLER_ID for node in walk_nodes(layout))


def run_app_command(command: str, values: dict[str, str], home: Path) -> None:
    argv = ["herdr-app", "do", command]
    for name, value in values.items():
        argv.extend([f"--{name}", value])
    try:
        child_env = os.environ.copy()
        child_env["HERDR_APP_HOME"] = str(home)
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
            env=child_env,
        )
    except FileNotFoundError as exc:
        raise fail("找不到 herdr-app；請先讓 Herdr CLI 出現在 PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise fail(f"herdr-app do {command} 超過 45 秒，安裝已中止") from exc
    if result.returncode:
        details = (result.stdout + result.stderr).strip()
        raise fail(f"herdr-app do {command} 失敗：{details or '未知錯誤'}")


def cleanup_created_clone(
    target_path: Path,
    clone_from: str,
    home: Path,
) -> None:
    """Try to leave no trace of a clone created by this invocation."""
    try:
        run_app_command("layout.switch", {"name": clone_from}, home)
    except InstallError as exc:
        raise fail(
            f"無法切回 {clone_from}；保留此次 clone 以避免誤刪，請手動清理 {target_path}：{exc}"
        ) from exc

    if target_path.exists():
        try:
            cloned_layout, _ = read_json(target_path, "新建立的 clone")
        except InstallError as exc:
            raise fail(f"新建立的 clone 無法驗證，保留檔案：{target_path} ({exc})") from exc
        if cloned_layout.get("cloned_from", {}).get("name") != clone_from:
            raise fail(f"clone 來源已變更，保留檔案避免誤刪：{target_path}")
        target_path.unlink()



def install(args: argparse.Namespace) -> int:
    source_root = Path(__file__).resolve().parent
    source_mod = source_root / "mods" / MOD_NAME
    if not source_mod.is_dir() or not (source_mod / "main.js").is_file():
        raise fail(f"找不到安裝資產：{source_mod}（需要 mods/{MOD_NAME}/main.js）")

    home = (args.home or Path(os.environ.get("HERDR_APP_HOME", "~/.config/herdr-app"))).expanduser()
    if not home.is_dir():
        raise fail(f"找不到 Herdr app home：{home}")
    keys_path = home / "keys.json"
    target_path = home / "layouts" / f"{args.layout}.json"
    source_name = args.clone_from
    if source_name == args.layout:
        raise fail("--clone-from 與 --layout 必須不同")
    source_path = home / "layouts" / f"{source_name or args.layout}.json"
    destination_mod = home / "mods" / MOD_NAME

    target_preexisting = target_path.exists()
    if source_name and target_preexisting:
        existing_target, _ = read_json(target_path, f"layout {args.layout}")
        metadata = existing_target.get("cloned_from", {}) if isinstance(existing_target, dict) else {}
        if metadata.get("name") != source_name or not has_controller(existing_target):
            raise fail(
                f"目標 layout 已存在但不是可重用的 {source_name} clone（需 cloned_from.name 與 controller），拒絕覆寫：{target_path}"
            )

    if source_name and not source_path.is_file():
        raise fail(f"找不到 clone 來源 layout：{source_path}")
    if not source_name and not target_preexisting:
        raise fail(f"找不到目標 layout：{target_path}")

    # Dry-run never executes mod code or app commands.  It computes a plan
    # against the source layout when the clone does not exist.
    if not args.dry_run:
        run_mod_check(source_mod, home)

    source_layout, source_layout_raw = read_json(source_path, f"layout {source_name or args.layout}")
    keys, keys_raw = read_json(keys_path, "keys.json")
    updated_keys, keys_changed = prepare_keys(keys, args.layout)

    if source_name and target_preexisting:
        layout, layout_raw = read_json(target_path, f"layout {args.layout}")
        updated_layout, layout_changed = prepare_layout(layout, require_cloned=True)
    elif source_name:
        layout, layout_raw = source_layout, source_layout_raw
        updated_layout, layout_changed = prepare_layout(layout, require_cloned=False)
    else:
        layout, layout_raw = source_layout, source_layout_raw
        updated_layout, layout_changed = prepare_layout(layout, require_cloned=True)

    destination_exists = destination_mod.exists()
    if destination_exists:
        if not destination_mod.is_dir():
            raise fail(f"目標 mod 路徑不是資料夾，拒絕覆寫：{destination_mod}")
        if not trees_equal(source_mod, destination_mod):
            raise fail(f"既有 mod 與安裝資產不同，拒絕覆寫：{destination_mod}")
        mod_changed = False
    else:
        mod_changed = True

    cloning = bool(source_name and not target_preexisting)
    if not (layout_changed or keys_changed or mod_changed or cloning):
        print("popup-terminal 已安裝，檔案內容與快捷鍵皆一致；不需變更。")
        return 0

    if cloning:
        print(f"安裝計畫：先 clone {source_name} -> {args.layout}")
    print(
        f"安裝計畫：mod={'新增' if mod_changed else '已一致'}，"
        f"layout={'更新' if layout_changed else '已一致'}，"
        f"快捷鍵={'更新' if keys_changed else '已一致'}"
    )
    print(f"  mod: {destination_mod}")
    print(f"  layout: {target_path}")
    print(f"  shortcut: {args.layout} / {SHORTCUT} -> {ACTION}")
    if args.dry_run:
        print("dry-run：未執行 herdr-app check、clone 或任何寫入。")
        return 0

    ensure_snapshots(keys_path, source_path, keys_raw, source_layout_raw)
    clone_attempted = False
    clone_created = False
    backup: Path | None = None
    temporary_mod: Path | None = None
    mod_installed = False
    layout_written = False
    keys_written = False
    layout_new_raw = json_bytes(updated_layout)
    keys_new_raw = json_bytes(updated_keys)
    try:
        if cloning:
            clone_attempted = True
            run_app_command("layout.clone", {"name": source_name, "as": args.layout}, home)
            layout, layout_raw = read_json(target_path, f"新 clone layout {args.layout}")
            if layout.get("cloned_from", {}).get("name") != source_name:
                raise fail(f"layout.clone 產生的來源不符預期：{target_path}")
            clone_created = True
            updated_layout, layout_changed = prepare_layout(layout, require_cloned=True)
            layout_new_raw = json_bytes(updated_layout)

        if not target_path.is_file():
            raise fail(f"找不到要寫入的目標 layout：{target_path}")
        ensure_file_snapshot(keys_path, keys_raw, "keys.json")
        backup = backup_files(home, keys_path, target_path)
        target_snapshot = target_path.read_bytes()
        if clone_created:
            # The clone is a new file; verify its own post-clone snapshot.
            if target_snapshot != layout_raw:
                raise fail("新 clone 在讀取後已變更，安裝已中止")
        else:
            if target_snapshot != layout_raw:
                raise fail("目標 layout 在安裝前已變更，請重新執行")

        if mod_changed:
            destination_mod.parent.mkdir(parents=True, exist_ok=True)
            temporary_mod = Path(tempfile.mkdtemp(prefix=f".{MOD_NAME}.", dir=str(destination_mod.parent)))
            shutil.rmtree(temporary_mod)
            shutil.copytree(source_mod, temporary_mod)
            if destination_mod.exists():
                raise fail(f"安裝期間目標 mod 出現變更，拒絕覆寫：{destination_mod}")
            os.replace(temporary_mod, destination_mod)
            temporary_mod = None
            mod_installed = True
        if layout_changed:
            write_atomic(target_path, layout_new_raw)
            layout_written = True
        if keys_changed:
            write_atomic(keys_path, keys_new_raw)
            keys_written = True
    except Exception as exc:
        if temporary_mod is not None:
            shutil.rmtree(temporary_mod, ignore_errors=True)
        rollback_errors: list[str] = []
        if mod_installed:
            if trees_equal(source_mod, destination_mod):
                shutil.rmtree(destination_mod, ignore_errors=True)
            else:
                rollback_errors.append(f"mod 在安裝後已被外部變更，保留：{destination_mod}")
        if clone_created:
            try:
                cleanup_created_clone(target_path, source_name, home)
            except InstallError as cleanup_exc:
                rollback_errors.append(f"clone 清理失敗，請手動處理：{cleanup_exc}")
        elif clone_attempted:
            rollback_errors.append(
                f"clone 結果不明，保留可能的新檔案：{target_path}；請確認後手動清理"
            )
        if layout_written and not clone_created:
            try:
                ensure_file_snapshot(target_path, layout_new_raw, "layout 安裝結果")
                write_atomic(target_path, layout_raw)
            except Exception as rollback_exc:
                rollback_errors.append(f"layout 回復失敗，保留目前內容：{rollback_exc}")
        if keys_written:
            try:
                ensure_file_snapshot(keys_path, keys_new_raw, "keys 安裝結果")
                write_atomic(keys_path, keys_raw)
            except Exception as rollback_exc:
                rollback_errors.append(f"keys 回復失敗，保留目前內容：{rollback_exc}")
        if rollback_errors:
            raise fail(f"安裝失敗：{exc}；" + "；".join(rollback_errors)) from exc
        if isinstance(exc, InstallError):
            raise
        raise fail(f"安裝失敗，已回復原始檔案；備份在 {backup}：{exc}") from exc

    print(f"安裝完成。備份：{backup}")
    print("Herdr hot reload 後按 Ctrl+B，再按 T 開啟／收起 popup terminal。")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return install(parse_args(argv or sys.argv[1:]))
    except InstallError as exc:
        print(f"錯誤：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
