// Enhanced Files mod with VS Code file explorer capabilities:
// New File, New Folder, Rename, Delete (macOS Trash), Move/Cut/Copy/Paste,
// Path Finder reveal, and Native Markdown Preview & Split integration.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder,
  theme, settings, window, run, notify
} from "herdr";
import {
  cleanRelativePath, generateCopyName, createFile, createFolder,
  renamePath, deletePath, copyPath, movePath, revealInPathFinder
} from "./fs-actions.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

function resolveRelativePath(currentFilePath, linkUrl) {
  if (!linkUrl) return null;
  const cleanUrl = linkUrl.split("#")[0].split("?")[0].trim();
  if (!cleanUrl) return null;

  let target = cleanUrl;
  if (target.startsWith("file://")) {
    target = target.replace(/^file:\/\//, "");
  }
  if (target.startsWith("/")) {
    return target;
  }

  let currentDir = ".";
  if (currentFilePath && currentFilePath.includes("/")) {
    currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf("/"));
  }

  const combined = `${currentDir}/${target}`;
  const parts = combined.split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const isAbsolute = combined.startsWith("/");
  return (isAbsolute ? "/" : "") + resolved.join("/");
}

export default class EnhancedFiles extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.viewMode = "preview"; // "preview" | "code"
    this.isMarkdown = false;
    this.rawText = null;

    // Interactive state for VS Code Explorer features
    this.selectedPath = null;
    this.clipboard = null; // { action: "cut"|"copy", path, isDir, name }
    this.contextMenu = null; // { path, isDir, name, x, y }
    this.creating = null; // { type: "file"|"folder", parentDir }
    this.createInput = null;
    this.renaming = null; // { path, isDir, originalName }
    this.renameInput = null;
    this.confirmDelete = null; // { path, isDir, name }

    this.handle = cx.focus_handle();

    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context && this.entries?.size > 0) {
        this.saved.set(this.context.key, {
          folders: new Set(this.folders),
          file: this.file,
          entries: new Map(this.entries),
          marks: { ...this.marks },
        });
        if (this.saved.size > 8) {
          const oldestKey = this.saved.keys().next().value;
          this.saved.delete(oldestKey);
        }
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.watched = null;
      this.error = null;
      this.limited = false;

      // Stale-While-Revalidate: Instant render from cache
      if (saved && saved.entries && saved.entries.size > 0) {
        this.entries = new Map(saved.entries);
        this.folders = new Set(saved.folders);
        this.marks = { ...(saved.marks || {}) };
        this.loading = false;
        if (saved.file) this.show(saved.file, cx);
      } else {
        this.entries = new Map();
        this.folders = new Set(saved?.folders);
        this.pending = new Set();
        this.marks = {};
        this.show(null);
        this.loading = true;
        if (saved?.file) this.show(saved.file, cx);
      }
    }
    if (!cwd) return;
    const context = this.context;
    if (!this.entries?.size) {
      this.loading = true;
      cx?.notify();
    }
    cx?.spawn(async cx => {
      try {
        await this.loadFolder("", context);
        for (const folder of [...this.folders]) if (this.current(context)) await this.loadFolder(folder, context);
        if (!this.current(context)) return;
        const marks = {};
        try {
          const r = await exec("git", ["status", "--porcelain", "-uall", "-z"], { cwd, on });
          if (r.code === 0) {
            const raw = r.stdout.split("\0");
            for (const item of raw) {
              if (item.length < 4) continue;
              const code = item.slice(0, 2).trim(), p = item.slice(3);
              marks[`${cwd}/${p}`] = code.includes("U") ? "U" : code.includes("?") ? "A" : code[0] !== " " ? code[0] : code[1];
            }
          }
        } catch {}
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) {
          this.loading = false;
          if (this.entries?.size > 0) {
            this.saved.set(context.key, {
              folders: new Set(this.folders),
              file: this.file,
              entries: new Map(this.entries),
              marks: { ...this.marks },
            });
          }
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  collapseAll(cx) {
    this.folders.clear();
    this.entries.clear();
    this.refresh(cx);
  }

  show(path, cx) {
    this.code?.release();
    this.code = null;
    this.file = path;
    this.selectedPath = path;
    this.fileError = null;
    this.rawText = null;
    this.isMarkdown = false;
    this.viewMode = "preview";
    if (!path || !cx) return;

    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }

        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        this.isMarkdown = (ext === "md" || ext === "markdown");
        this.rawText = text;

        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family,
          font_size: 12,
          syntax: {
            keyword: t.ansi5, string: t.ansi2, comment: t.dim,
            function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6
          }
        });
      } catch {
        if (this.file === path && this.current(context)) {
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        cx.notify();
      }
    });
  }

  // --- VS Code File Operations ---

  startCreate(type, parentDir, cx) {
    this.contextMenu = null;
    this.renaming = null;
    this.confirmDelete = null;
    const cleanParent = parentDir ? cleanRelativePath(parentDir) : "";
    if (cleanParent && !this.folders.has(cleanParent)) {
      this.folders.add(cleanParent);
    }
    this.creating = { type, parentDir: cleanParent };
    this.createInput = InputState.new({ value: "" });
    this.createInput.on("submit", () => this.submitCreate(cx));
    cx.timer.after(50, () => this.createInput?.focus());
    cx.notify();
  }

  async submitCreate(cx) {
    if (!this.creating || !this.createInput) return;
    const name = this.createInput.value().trim();
    if (!name) {
      this.creating = null;
      this.createInput = null;
      cx.notify();
      return;
    }
    const { type, parentDir } = this.creating;
    const relPath = parentDir ? `${parentDir}/${name}` : name;
    this.creating = null;
    this.createInput = null;

    try {
      if (type === "file") {
        await createFile(this.root, relPath, exec, { on: this.on });
        notify({ title: "檔案建立成功", body: relPath, level: "success" });
        this.refresh(cx);
        this.show(relPath, cx);
      } else {
        await createFolder(this.root, relPath, exec, { on: this.on });
        notify({ title: "資料夾建立成功", body: relPath, level: "success" });
        this.folders.add(relPath);
        this.refresh(cx);
      }
    } catch (err) {
      notify({ title: "建立失敗", body: String(err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  startRename(path, isDir, cx) {
    this.contextMenu = null;
    this.creating = null;
    this.confirmDelete = null;
    const originalName = path.split("/").pop();
    this.renaming = { path, isDir, originalName };
    this.renameInput = InputState.new({ value: originalName });
    const dotIdx = originalName.lastIndexOf(".");
    const selEnd = isDir || dotIdx <= 0 ? originalName.length : dotIdx;
    this.renameInput.set_selected_range({ start: 0, end: selEnd });
    this.renameInput.on("submit", () => this.submitRename(cx));
    cx.timer.after(50, () => this.renameInput?.focus());
    cx.notify();
  }

  async submitRename(cx) {
    if (!this.renaming || !this.renameInput) return;
    const newName = this.renameInput.value().trim();
    const { path, originalName } = this.renaming;
    this.renaming = null;
    this.renameInput = null;

    if (!newName || newName === originalName) {
      cx.notify();
      return;
    }

    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const newPath = parent ? `${parent}/${newName}` : newName;

    try {
      await renamePath(this.root, path, newPath, exec, { on: this.on });
      notify({ title: "重新命名成功", body: `${originalName} → ${newName}`, level: "success" });
      if (this.file === path) {
        this.file = newPath;
      }
      this.refresh(cx);
    } catch (err) {
      notify({ title: "重新命名失敗", body: String(err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  promptDelete(path, isDir, cx) {
    this.contextMenu = null;
    this.creating = null;
    this.renaming = null;
    const name = path.split("/").pop();
    this.confirmDelete = { path, isDir, name };
    cx.notify();
  }

  async executeDelete(cx) {
    if (!this.confirmDelete) return;
    const { path, name } = this.confirmDelete;
    this.confirmDelete = null;
    try {
      await deletePath(this.root, path, exec, { on: this.on });
      notify({ title: "已移至垃圾桶", body: name, level: "info" });
      if (this.file === path || this.file?.startsWith(path + "/")) {
        this.show(null, cx);
      }
      this.refresh(cx);
    } catch (err) {
      notify({ title: "刪除失敗", body: String(err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  cutItem(path, isDir, cx) {
    this.contextMenu = null;
    const name = path.split("/").pop();
    this.clipboard = { action: "cut", path, isDir, name };
    notify({ title: "已剪下", body: name, level: "info" });
    cx.notify();
  }

  copyItem(path, isDir, cx) {
    this.contextMenu = null;
    const name = path.split("/").pop();
    this.clipboard = { action: "copy", path, isDir, name };
    notify({ title: "已複製", body: name, level: "info" });
    cx.notify();
  }

  async pasteItem(targetFolder, cx) {
    this.contextMenu = null;
    if (!this.clipboard) return;
    const { action, path: srcPath, name } = this.clipboard;
    const cleanTarget = targetFolder ? cleanRelativePath(targetFolder) : "";
    let dstPath = cleanTarget ? `${cleanTarget}/${name}` : name;

    try {
      if (action === "copy") {
        if (cleanTarget === (srcPath.includes("/") ? srcPath.slice(0, srcPath.lastIndexOf("/")) : "")) {
          // Duplicating in same directory
          const existing = (this.entries.get(cleanTarget) ?? []).map(e => e.name);
          const copyName = generateCopyName(existing, name);
          dstPath = cleanTarget ? `${cleanTarget}/${copyName}` : copyName;
        }
        await copyPath(this.root, srcPath, dstPath, exec, { on: this.on });
        notify({ title: "複製完成", body: dstPath, level: "success" });
      } else if (action === "cut") {
        await movePath(this.root, srcPath, dstPath, exec, { on: this.on });
        this.clipboard = null; // Clear after move
        notify({ title: "搬移完成", body: dstPath, level: "success" });
      }
      if (cleanTarget && !this.folders.has(cleanTarget)) {
        this.folders.add(cleanTarget);
      }
      this.refresh(cx);
    } catch (err) {
      notify({ title: "貼上失敗", body: String(err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  copyPathToClipboard(path, absolute, cx) {
    this.contextMenu = null;
    const text = absolute ? `${this.root}/${path}` : path;
    try {
      cx.write_to_clipboard(text);
      notify({ title: "已複製路徑到剪貼簿", body: text, level: "info" });
    } catch {
      exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", text]).catch(() => null);
      notify({ title: "已複製路徑到剪貼簿", body: text, level: "info" });
    }
  }

  async revealPathFinder(path, cx) {
    this.contextMenu = null;
    const full = path ? `${this.root}/${path}` : this.root;
    notify({ title: "正在 Path Finder 中開啟…", body: full, level: "info" });
    await revealInPathFinder(full, exec, { on: this.on });
  }

  splitMarkdownPane() {
    if (!this.file) return;
    run("pane.split", {
      direction: "right",
      mod: "markdown-preview",
      props: { file: `${this.root}/${this.file}` }
    });
  }

  handleMarkdownLinkClick(url, cx) {
    if (!url) return;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !url.startsWith("file:")) {
      try { cx.open_url(url); } catch {}
      return;
    }
    if (url.startsWith("#")) return;

    const base = this.file ? `${this.root}/${this.file}` : this.root;
    let target = resolveRelativePath(base, url);
    if (!target) return;

    if (target.startsWith(this.root + "/")) {
      target = target.slice(this.root.length + 1);
    }
    this.show(target, cx);
  }

  rows(prefix, depth, out, t, cx) {
    if (out.length >= TOTAL || depth > 40) return out;

    // Render inline creation input if it belongs to this folder
    if (this.creating && this.creating.parentDir === prefix) {
      out.push(
        h_flex()
          .id("files-create-inline")
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(6)
          .bg(t.raised)
          .child(
            svg(`mods/enhanced-files/${this.creating.type === "folder" ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(t.accent)
          )
          .child(
            Input.new(this.createInput)
              .flex_1()
              .h(22)
              .px(4)
              .rounded(4)
              .border_1()
              .border_color(t.accent)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground)
          )
      );
    }

    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.root}/${path}`];
      const isSelected = this.selectedPath === path;
      const isCut = this.clipboard?.action === "cut" && this.clipboard?.path === path;
      const isRenaming = this.renaming?.path === path;

      const row = h_flex()
        .id(`file-${path}`)
        .h(28)
        .flex_none()
        .pl(8 + depth * 18)
        .pr(8)
        .gap(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(isSelected, el => el.bg(t.selected))
        .when(!isSelected, el => el.hover(s => s.bg(t.hover)))
        .when(isCut, el => el.opacity(0.45))
        .on_click((_e, cx) => {
          this.selectedPath = path;
          this.contextMenu = null;
          if (entry.dir) this.toggle(path, cx);
          else this.show(path, cx);
        })
        .on_mouse_down("right", (e, cx) => {
          try {
            cx.stop_propagation();
            this.selectedPath = path;
            this.contextMenu = {
              path,
              isDir: entry.dir,
              name: entry.name,
              x: e.position?.x ?? 40,
              y: e.position?.y ?? 100,
            };
            cx.notify();
          } catch (err) {
            notify({ title: "選單開啟異常", body: String(err), level: "error" });
          }
        })
        .child(
          entry.dir
            ? svg(`mods/enhanced-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)
            : div().w(12).flex_none()
        )
        .child(
          svg(
            `mods/enhanced-files/${
              entry.dir
                ? (open ? "folder-open" : "folder")
                : (entry.name.toLowerCase().endsWith(".md") ? "markdown" : "file")
            }.svg`
          ).size(14).flex_none()
        );

      if (isRenaming) {
        row.child(
          Input.new(this.renameInput)
            .flex_1()
            .h(22)
            .px(4)
            .rounded(4)
            .border_1()
            .border_color(t.accent)
            .bg(t.background)
            .text_size(12)
            .text_color(t.foreground)
        );
      } else {
        row.child(div().flex_1().min_w(0).truncate().child(entry.name));
      }

      row.when(Boolean(mark), el =>
        el.child(
          div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)
        )
      );

      out.push(row);
      if (entry.dir && open) this.rows(path, depth + 1, out, t, cx);
    }
    return out;
  }

  renderContextMenu(t, cx) {
    if (!this.contextMenu) return null;
    const { path, isDir, name } = this.contextMenu;
    const parentFolder = isDir ? (path || "") : (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

    const item = (iconName, label, shortcut, action, danger = false, disabled = false) =>
      h_flex()
        .h(26)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .when(disabled, el => el.opacity(0.35))
        .when(!disabled, el => el.hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => {
          if (!disabled) {
            cx.stop_propagation();
            action();
          }
        })
        .child(svg(`mods/enhanced-files/${iconName}.svg`).size(13).flex_none().text_color(danger ? t.ansi1 : t.dim))
        .child(div().flex_1().text_size(12).text_color(danger ? t.ansi1 : t.foreground).child(label))
        .when(Boolean(shortcut), el => el.child(div().text_size(10.5).text_color(t.dim).child(shortcut)));

    const divider = () => div().h(1).my(3).bg(t.border);

    return v_flex()
      .id("files-context-menu")
      .absolute()
      .top(36)
      .left(12)
      .w(210)
      .p(4)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .on_mouse_down_out((_e, cx) => {
        this.contextMenu = null;
        cx.notify();
      })
      .child(item("file-plus", "New File…", "", () => this.startCreate("file", parentFolder, cx)))
      .child(item("folder-plus", "New Folder…", "", () => this.startCreate("folder", parentFolder, cx)))
      .child(divider())
      .when(Boolean(path), el =>
        el
          .child(item("cut", "Cut", "⌘X", () => this.cutItem(path, isDir, cx)))
          .child(item("copy", "Copy", "⌘C", () => this.copyItem(path, isDir, cx)))
      )
      .child(
        item("paste", "Paste", "⌘V", () => this.pasteItem(parentFolder, cx), false, !this.clipboard)
      )
      .child(divider())
      .when(Boolean(path), el =>
        el
          .child(item("copy", "Copy Path", "", () => this.copyPathToClipboard(path, true, cx)))
          .child(item("copy", "Copy Relative Path", "", () => this.copyPathToClipboard(path, false, cx)))
          .child(divider())
          .child(item("edit", "Rename…", "F2", () => this.startRename(path, isDir, cx)))
          .child(item("trash", "Delete", "⌫", () => this.promptDelete(path, isDir, cx), true))
          .child(divider())
      )
      .child(item("pathfinder", "Reveal in Path Finder", "", () => this.revealPathFinder(path, cx)))
      .child(divider())
      .child(item("refresh", "Close Menu", "Esc", () => { this.contextMenu = null; cx.notify(); }));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();

    return v_flex()
      .id("enhanced-files")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.contextMenu = null;
          this.creating = null;
          this.renaming = null;
          this.confirmDelete = null;
          cx.notify();
        } else if (e.key === "f2" && this.selectedPath) {
          const isDir = this.folders.has(this.selectedPath) || this.entries.has(this.selectedPath);
          this.startRename(this.selectedPath, isDir, cx);
        } else if ((e.key === "backspace" || e.key === "delete") && this.selectedPath) {
          const isDir = this.folders.has(this.selectedPath) || this.entries.has(this.selectedPath);
          this.promptDelete(this.selectedPath, isDir, cx);
        }
      })
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Top header (VS Code style toolbar)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(this.file), el =>
            el.child(
              div()
                .id("files-back")
                .w(20)
                .cursor_pointer()
                .text_color(t.muted)
                .on_click((_e, cx) => {
                  this.show(null);
                  cx.notify();
                })
                .child("←")
            )
          )
          .child(div().font_semibold().child("Files"))
          // Markdown View Switcher and Split button
          .when(Boolean(this.file && this.isMarkdown), el =>
            el.child(
              h_flex()
                .gap(4)
                .items_center()
                .child(
                  h_flex()
                    .px(6)
                    .h(22)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .when(this.viewMode === "preview", el => el.bg(t.raised))
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.viewMode = "preview";
                      cx.notify();
                    })
                    .child(
                      div()
                        .text_size(11)
                        .text_color(this.viewMode === "preview" ? t.accent : t.muted)
                        .child("Preview")
                    )
                )
                .child(
                  h_flex()
                    .px(6)
                    .h(22)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .when(this.viewMode === "code", el => el.bg(t.raised))
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.viewMode = "code";
                      cx.notify();
                    })
                    .child(
                      div()
                        .text_size(11)
                        .text_color(this.viewMode === "code" ? t.accent : t.muted)
                        .child("Code")
                    )
                )
                .child(
                  h_flex()
                    .px(6)
                    .h(22)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click(() => this.splitMarkdownPane())
                    .child(div().text_size(11).text_color(t.muted).child("⧉ Split"))
                )
            )
          )
          .child(div().flex_1())
          // VS Code Explorer action icons
          .when(!this.file, el =>
            el.child(
              h_flex()
                .gap(2)
                .items_center()
                // New File
                .child(
                  h_flex()
                    .id("btn-new-file")
                    .size(26)
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.startCreate("file", "", cx))
                    .child(svg("mods/enhanced-files/file-plus.svg").size(15).text_color(t.muted))
                )
                // New Folder
                .child(
                  h_flex()
                    .id("btn-new-folder")
                    .size(26)
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.startCreate("folder", "", cx))
                    .child(svg("mods/enhanced-files/folder-plus.svg").size(15).text_color(t.muted))
                )
                // Refresh
                .child(
                  h_flex()
                    .id("btn-refresh-files")
                    .size(26)
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      notify({ title: "重新整理中…", level: "info" });
                      this.refresh(cx);
                    })
                    .child(svg("mods/enhanced-files/refresh.svg").size(14).text_color(t.muted))
                )
                // Collapse All
                .child(
                  h_flex()
                    .id("btn-collapse-all")
                    .size(26)
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.collapseAll(cx))
                    .child(svg("mods/enhanced-files/collapse.svg").size(15).text_color(t.muted))
                )
            )
          )
      )
      // Delete Confirmation Banner
      .when(Boolean(this.confirmDelete), el =>
        el.child(
          h_flex()
            .h(36)
            .px(10)
            .gap(8)
            .items_center()
            .bg(t.popover)
            .border_b(1)
            .border_color(t.ansi1)
            .child(
              div()
                .flex_1()
                .truncate()
                .text_size(12)
                .text_color(t.foreground)
                .child(`刪除 "${this.confirmDelete.name}"？`)
            )
            .child(
              h_flex()
                .h(22)
                .px(8)
                .items_center()
                .rounded(4)
                .bg(t.ansi1)
                .cursor_pointer()
                .hover(s => s.opacity(0.85))
                .on_click((_e, cx) => this.executeDelete(cx))
                .child(div().text_size(11).text_color("#ffffff").font_semibold().child("移至垃圾桶"))
            )
            .child(
              h_flex()
                .h(22)
                .px(8)
                .items_center()
                .rounded(4)
                .bg(t.raised)
                .cursor_pointer()
                .hover(s => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.confirmDelete = null;
                  cx.notify();
                })
                .child(div().text_size(11).text_color(t.dim).child("取消"))
            )
        )
      )
      // File Tree Area
      .when(!this.file, el =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .on_mouse_down("right", (e, cx) => {
              try {
                this.contextMenu = {
                  path: null,
                  isDir: true,
                  name: "root",
                  x: e.position?.x ?? 40,
                  y: e.position?.y ?? 100,
                };
                cx.notify();
              } catch (err) {
                notify({ title: "選單開啟異常", body: String(err), level: "error" });
              }
            })
            .children(this.rows("", 0, [], t, cx))
            .when(Boolean(this.error) || !this.entries.get("")?.length, el =>
              el.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))
              )
            )
            .when(this.limited, el =>
              el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))
            )
            .when(Boolean(this.contextMenu), el => el.child(this.renderContextMenu(t, cx)))
        )
      )
      // File Preview
      .when(Boolean(this.file), el =>
        el.child(
          this.fileError
            ? div().p(12).text_color(t.dim).child(this.fileError)
            : this.isMarkdown && this.viewMode === "preview"
            ? v_flex()
                .flex_1()
                .min_h(0)
                .p(12)
                .overflow_y_scrollbar()
                .child(
                  TextView.markdown("enhanced-file-md", this.rawText ?? "")
                    .selectable(true)
                    .scrollable(true)
                    .on_link_click((url, cx) => this.handleMarkdownLinkClick(url, cx))
                )
            : this.code
            ? Editor.new(this.code).flex_1().min_h(0)
            : div().p(12).text_color(t.dim).child("Loading file…")
        )
      );
  }
}
