// Enhanced Git Manager for Herdr with Fork-style Sidebar, Subway Git Graph, and LRU Cache
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme, settings, run, openOverlay, closeOverlay, watchFolder,
  setShared, shared
} from "herdr";
import {
  resolveLocation, getGitStatus, getGitGraph, getCommitFiles,
  getFileDiff, getCommitDiff, gitStageFile, gitUnstageFile,
  gitDiscardFile, gitStageAll, gitUnstageAll, gitCommit,
  gitPush, gitPull, gitFetch, gitStash, gitStashPop,
  getGitRefs, gitCheckout, gitStashApply, gitStashDrop,
  parseRefBadge
} from "./git.js";

const OVERLAY_KEY = "enhanced-git.open-overlay";

// Fork-style vibrant subway track colors
const TRACK_COLORS = [
  "#3b82f6", // Blue (Main line)
  "#10b981", // Emerald Green
  "#f59e0b", // Amber/Gold
  "#8b5cf6", // Purple
  "#ec4899", // Magenta/Pink
  "#06b6d4", // Cyan
  "#f97316", // Orange
  "#ef4444", // Coral Red
];

export default class EnhancedGit extends View {
  init(props, cx) {
    this.role = props?.role || "panel"; // "panel" or "dialog"
    this.overlayId = props?.overlayId || null;
    this.tab = props?.tab || "changes"; // "changes" | "graph" | "branches" | "stashes"

    this.status = null;
    this.graphRows = [];
    this.graphLimit = 50;
    this.refs = { branches: [], remotes: [], tags: [], stashes: [] };
    this.loading = false;
    this.busy = false;
    this.error = null;
    this.note = null;

    // Changes tab state
    this.selectedFile = null;
    this.selectedIsStaged = false;
    this.diffLines = [];
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.doCommit(cx));

    // Git Graph tab state
    this.selectedCommit = null;
    this.commitFiles = [];
    this.selectedCommitFile = null;
    this.commitDiffLines = [];
    this.graphLoading = false;
    this.graphError = null;

    // Session cache & lazy loading
    this.gitCache = new Map();
    this.lastKey = null;

    this.handle = cx.focus_handle();
    this.refresh(cx);

    // Watch for folder changes every 10s or filesystem events
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  updateCache() {
    if (!this.lastKey || !this.status?.isRepo) return;
    this.gitCache.set(this.lastKey, {
      status: this.status,
      graphRows: this.graphRows,
      graphError: this.graphError,
      refs: this.refs,
      selectedFile: this.selectedFile,
      selectedIsStaged: this.selectedIsStaged,
      diffLines: this.diffLines,
      selectedCommit: this.selectedCommit,
      commitFiles: this.commitFiles,
      selectedCommitFile: this.selectedCommitFile,
      commitDiffLines: this.commitDiffLines,
    });
    // Cap at 8 sessions to ensure minimal memory usage (< 500KB)
    if (this.gitCache.size > 8) {
      const oldestKey = this.gitCache.keys().next().value;
      this.gitCache.delete(oldestKey);
    }
  }

  fetchGraph(cx) {
    if (!this.cwd) return;
    const targetPath = this.status?.root || this.cwd;
    const on = this.on;
    this.graphLoading = true;
    this.graphError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const graphData = await getGitGraph(targetPath, on, this.graphLimit);
        if (this.cwd === targetPath || this.status?.root === targetPath || this.cwd) {
          if (graphData.error) {
            this.graphError = graphData.error;
            this.graphRows = [];
          } else {
            this.graphRows = graphData.rows || [];
            this.graphError = null;
          }
          this.updateCache();
        }
      } catch (err) {
        this.graphError = String(err);
      } finally {
        this.graphLoading = false;
        cx.notify();
      }
    });
  }

  fetchRefs(cx) {
    if (!this.cwd) return;
    const targetPath = this.status?.root || this.cwd;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const refsData = await getGitRefs(targetPath, on);
        if (this.cwd === targetPath || this.status?.root === targetPath || this.cwd) {
          if (!refsData.error) {
            this.refs = refsData;
            this.updateCache();
          }
        }
      } catch (e) {
      } finally {
        cx.notify();
      }
    });
  }

  async refresh(cx, force = false) {
    if (this.busy) return;
    const { cwd, on } = resolveLocation();
    if (!cwd) {
      this.error = "No workspace folder selected";
      cx.notify();
      return;
    }

    const currentKey = `${on || ""}:${cwd}`;
    const isNewSession = currentKey !== this.lastKey;

    if (isNewSession) {
      this.updateCache();

      const cached = this.gitCache.get(currentKey);
      this.lastKey = currentKey;
      this.cwd = cwd;
      this.on = on;

      if (cached && !force) {
        // Stale-While-Revalidate: instant render from cache (0ms)
        this.status = cached.status;
        this.graphRows = cached.graphRows || [];
        this.graphError = cached.graphError || null;
        this.refs = cached.refs || { branches: [], remotes: [], tags: [], stashes: [] };
        this.graphLoading = false;
        this.selectedFile = cached.selectedFile || null;
        this.selectedIsStaged = cached.selectedIsStaged || false;
        this.diffLines = cached.diffLines || [];
        this.selectedCommit = cached.selectedCommit || null;
        this.commitFiles = cached.commitFiles || [];
        this.selectedCommitFile = cached.selectedCommitFile || null;
        this.commitDiffLines = cached.commitDiffLines || [];
        this.error = null;
        this.loading = false;
        cx.notify();
      } else {
        this.status = null;
        this.graphRows = [];
        this.graphError = null;
        this.graphLoading = this.tab === "graph";
        this.selectedFile = null;
        this.diffLines = [];
        this.error = null;
        this.loading = true;
        cx.notify();
      }
    } else if (this.loading && !force) {
      return;
    }

    this.loading = true;
    this.cwd = cwd;
    this.on = on;

    cx.spawn(async (cx) => {
      try {
        const needGraph = this.tab === "graph" || this.role === "dialog";
        if (needGraph) this.graphLoading = true;

        const statusData = await getGitStatus(cwd, on);

        if (this.cwd !== cwd) return; // Stale request, user switched session

        if (!statusData.isRepo) {
          this.status = null;
          this.graphRows = [];
          this.graphError = null;
          this.graphLoading = false;
          this.error = statusData.error || "Not a git repository";
          return;
        }

        this.status = statusData;
        this.error = null;

        // Asynchronously fetch refs (branches, remotes, tags, stashes)
        this.fetchRefs(cx);

        if (needGraph) {
          const repoRoot = statusData.root || cwd;
          const graphData = await getGitGraph(repoRoot, on, this.graphLimit);
          if (graphData.error) {
            this.graphError = graphData.error;
            this.graphRows = [];
          } else {
            this.graphRows = graphData.rows || [];
            this.graphError = null;
          }
          this.graphLoading = false;
        }

        // Reconcile selected file with current git status
        const allChangedFiles = [
          ...statusData.stagedFiles.map((f) => ({ ...f, staged: true })),
          ...statusData.unstagedFiles.map((f) => ({ ...f, staged: false })),
        ];

        const stillExists =
          allChangedFiles.find((f) => f.path === this.selectedFile && f.staged === this.selectedIsStaged) ||
          allChangedFiles.find((f) => f.path === this.selectedFile);

        if (stillExists) {
          if (stillExists.staged !== this.selectedIsStaged) {
            this.selectedIsStaged = stillExists.staged;
            this.selectFile(stillExists.path, stillExists.staged, cx);
          }
        } else if (allChangedFiles.length > 0) {
          // Previously selected file is gone (committed or discarded), auto-select next available
          this.selectFile(allChangedFiles[0].path, allChangedFiles[0].staged, cx);
        } else {
          // Working tree is completely clean
          this.selectedFile = null;
          this.selectedIsStaged = false;
          this.diffLines = [];
        }

        this.updateCache();
      } catch (err) {
        if (this.cwd === cwd) {
          this.error = String(err);
        }
      } finally {
        if (this.cwd === cwd) {
          this.loading = false;
          this.graphLoading = false;
        }
        cx.notify();
      }
    });
  }

  selectFile(path, staged, cx) {
    this.selectedFile = path;
    this.selectedIsStaged = staged;
    this.diffLines = [];
    cx.spawn(async (cx) => {
      try {
        this.diffLines = await getFileDiff(this.cwd, this.on, path, staged);
      } catch (e) {
        this.diffLines = ["Failed to load diff: " + e];
      }
      cx.notify();
    });
    cx.notify();
  }

  selectCommit(row, cx) {
    if (!row.isCommit) return;
    if (this.selectedCommit?.hash === row.hash) {
      this.selectedCommit = null;
      this.commitFiles = [];
      this.selectedCommitFile = null;
      this.commitDiffLines = [];
      cx.notify();
      return;
    }

    this.selectedCommit = row;
    this.commitFiles = [];
    this.selectedCommitFile = null;
    this.commitDiffLines = [];

    cx.spawn(async (cx) => {
      try {
        this.commitFiles = await getCommitFiles(this.cwd, this.on, row.hash);
        if (this.commitFiles.length > 0) {
          this.selectCommitFile(this.commitFiles[0].path, cx);
        }
      } catch (e) {
        this.note = "Failed to load commit files: " + e;
      }
      cx.notify();
    });
    cx.notify();
  }

  selectCommitFile(path, cx) {
    this.selectedCommitFile = path;
    this.commitDiffLines = [];
    if (!this.selectedCommit) return;

    cx.spawn(async (cx) => {
      try {
        this.commitDiffLines = await getCommitDiff(this.cwd, this.on, this.selectedCommit.hash, path);
      } catch (e) {
        this.commitDiffLines = ["Failed to load diff: " + e];
      }
      cx.notify();
    });
    cx.notify();
  }

  async runAction(actionFn, successMsg, cx) {
    if (this.busy || !this.status?.isRepo) return;
    this.busy = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await actionFn();
        if (res.code !== 0) {
          throw new Error((res.stderr || res.stdout || "Action failed").trim());
        }
        if (successMsg) this.note = successMsg;
      } catch (err) {
        this.note = "Error: " + err.message;
      } finally {
        this.busy = false;
        await this.refresh(cx);
        cx.notify();
      }
    });
  }

  doStage(path, cx) {
    this.runAction(() => gitStageFile(this.cwd, this.on, path), null, cx);
  }

  doUnstage(path, cx) {
    this.runAction(() => gitUnstageFile(this.cwd, this.on, path), null, cx);
  }

  doDiscard(path, fresh, cx) {
    this.runAction(() => gitDiscardFile(this.cwd, this.on, path, fresh), null, cx);
  }

  doStageAll(cx) {
    this.runAction(() => gitStageAll(this.cwd, this.on), null, cx);
  }

  doUnstageAll(cx) {
    this.runAction(() => gitUnstageAll(this.cwd, this.on), null, cx);
  }

  doCommit(cx) {
    const msg = this.message.trim();
    if (!msg) return;
    const stagedCount = this.status?.stagedFiles?.length || 0;
    const unstagedCount = this.status?.unstagedFiles?.length || 0;
    if (stagedCount === 0 && unstagedCount === 0) return;

    this.runAction(async () => {
      // If nothing staged, auto-stage all
      if (this.status?.stagedFiles?.length === 0) {
        const stageRes = await gitStageAll(this.cwd, this.on);
        if (stageRes.code !== 0) return stageRes;
      }
      return gitCommit(this.cwd, this.on, msg);
    }, "Commit successful", cx);

    this.message = "";
    this.input.set_value("");
    cx.notify();
  }

  doPush(cx) {
    this.runAction(() => gitPush(this.cwd, this.on), "Pushed to remote", cx);
  }

  doPull(cx) {
    this.runAction(() => gitPull(this.cwd, this.on), "Pulled from remote", cx);
  }

  doFetch(cx) {
    this.runAction(() => gitFetch(this.cwd, this.on), "Fetched remote", cx);
  }

  doStash(cx) {
    this.runAction(() => gitStash(this.cwd, this.on, "Herdr stash"), "Stashed current changes", cx);
  }

  doStashPop(cx) {
    this.runAction(() => gitStashPop(this.cwd, this.on), "Applied stashed changes", cx);
  }

  doStashApply(stashId, cx) {
    this.runAction(() => gitStashApply(this.cwd, this.on, stashId), `Applied ${stashId}`, cx);
  }

  doStashDrop(stashId, cx) {
    this.runAction(() => gitStashDrop(this.cwd, this.on, stashId), `Dropped ${stashId}`, cx);
  }

  doCheckout(branch, cx) {
    this.runAction(() => gitCheckout(this.cwd, this.on, branch), `Checked out ${branch}`, cx);
  }

  openOverlayDialog() {
    const current = shared(OVERLAY_KEY);
    if (current?.overlay) {
      closeOverlay(current.overlay);
      setShared(OVERLAY_KEY, null);
    }
    const id = openOverlay({
      content: {
        mod: "enhanced-git",
        props: { role: "dialog", tab: this.tab }
      },
      width: 1000,
      height: 680
    });
    setShared(OVERLAY_KEY, { overlay: id });
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  renderDiffLines(lines, t) {
    return v_flex()
      .w_full()
      .children(
        lines.map((line, idx) => {
          const isAdd = line.startsWith("+");
          const isDel = line.startsWith("-");
          const isHdr = line.startsWith("@");
          const bg = isAdd ? (t.ansi2 + "22") : isDel ? (t.ansi1 + "22") : isHdr ? t.raised : "transparent";
          const color = isAdd ? t.ansi2 : isDel ? t.ansi1 : isHdr ? t.dim : t.foreground;

          return h_flex()
            .w_full()
            .h(20)
            .flex_none()
            .px(8)
            .gap(8)
            .when(bg !== "transparent", (el) => el.bg(bg))
            .child(div().w(26).text_size(10.5).text_color(t.dim).text_right().child(String(idx + 1)))
            .child(div().flex_1().text_size(11.5).font_family("JetBrains Mono").text_color(color).truncate().child(line || " "));
        })
      );
  }

  // --- View: Changes Tab (Fork Working Copy Style) ---
  renderChangesTab(t, cx) {
    const status = this.status;
    const staged = status?.stagedFiles || [];
    const unstaged = status?.unstagedFiles || [];
    const canCommit = staged.length > 0 || unstaged.length > 0;

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(10)
      // Top File Lists: Staged & Changes
      .child(
        v_flex()
          .h(240)
          .flex_none()
          .gap(8)
          .overflow_y_scrollbar()
          // Section 1: Staged Changes
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .px(4)
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(11).font_bold().text_color(t.dim).child("STAGED CHANGES"))
                      .child(
                        div()
                          .px(6)
                          .py(0.5)
                          .rounded(10)
                          .bg(t.raised)
                          .text_size(10)
                          .font_semibold()
                          .text_color(t.muted)
                          .child(String(staged.length))
                      )
                  )
                  .when(staged.length > 0, (el) =>
                    el.child(
                      div()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .cursor_pointer()
                        .hover((s) => s.text_color(t.foreground))
                        .on_click((_e, cx) => this.doUnstageAll(cx))
                        .child("Unstage All")
                    )
                  )
              )
              .children(
                staged.map((f) =>
                  h_flex()
                    .h(26)
                    .flex_none()
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(this.selectedFile === f.path && this.selectedIsStaged, (el) => el.bg(t.selected))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.selectFile(f.path, true, cx))
                    .child(div().w(12).text_size(10.5).font_semibold().text_color(t.ansi2).child(f.status))
                    .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).truncate().child(f.path))
                    .when(f.add > 0, (el) => el.child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, (el) => el.child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)))
                    // Unstage button
                    .child(
                      div()
                        .px(4)
                        .rounded(3)
                        .hover((s) => s.bg(t.raised))
                        .text_size(11)
                        .text_color(t.dim)
                        .on_click((e, cx) => {
                          e.stop_propagation?.();
                          this.doUnstage(f.path, cx);
                        })
                        .child("−")
                    )
                )
              )
              .when(staged.length === 0, (el) =>
                el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("No staged changes"))
              )
          )
          // Section 2: Changes (Unstaged)
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .px(4)
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(11).font_bold().text_color(t.dim).child("UNSTAGED CHANGES"))
                      .child(
                        div()
                          .px(6)
                          .py(0.5)
                          .rounded(10)
                          .bg(t.raised)
                          .text_size(10)
                          .font_semibold()
                          .text_color(t.muted)
                          .child(String(unstaged.length))
                      )
                  )
                  .when(unstaged.length > 0, (el) =>
                    el.child(
                      div()
                        .text_size(10.5)
                        .text_color(t.dim)
                        .cursor_pointer()
                        .hover((s) => s.text_color(t.foreground))
                        .on_click((_e, cx) => this.doStageAll(cx))
                        .child("Stage All")
                    )
                  )
              )
              .children(
                unstaged.map((f) =>
                  h_flex()
                    .h(26)
                    .flex_none()
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(this.selectedFile === f.path && !this.selectedIsStaged, (el) => el.bg(t.selected))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.selectFile(f.path, false, cx))
                    .child(
                      div()
                        .w(12)
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(f.fresh ? t.ansi2 : f.status === "D" ? t.ansi1 : "#f59e0b")
                        .child(f.status)
                    )
                    .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).truncate().child(f.path))
                    .when(f.add > 0, (el) => el.child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, (el) => el.child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)))
                    // Stage button
                    .child(
                      div()
                        .px(4)
                        .rounded(3)
                        .hover((s) => s.bg(t.raised))
                        .text_size(11)
                        .text_color(t.dim)
                        .on_click((e, cx) => {
                          e.stop_propagation?.();
                          this.doStage(f.path, cx);
                        })
                        .child("+")
                    )
                    // Discard button
                    .child(
                      div()
                        .px(4)
                        .rounded(3)
                        .hover((s) => s.bg(t.raised))
                        .text_size(11)
                        .text_color(t.dim)
                        .on_click((e, cx) => {
                          e.stop_propagation?.();
                          this.doDiscard(f.path, f.fresh, cx);
                        })
                        .child("✕")
                    )
                )
              )
              .when(unstaged.length === 0, (el) =>
                el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Working tree clean"))
              )
          )
      )
      // Diff View of Selected File
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .rounded(6)
          .overflow_hidden()
          // Diff Header
          .child(
            h_flex()
              .h(28)
              .flex_none()
              .px(8)
              .gap(6)
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color(t.border)
              .bg(t.raised)
              .child(
                div()
                  .text_size(11)
                  .font_medium()
                  .text_color(t.foreground)
                  .truncate()
                  .child(
                    this.selectedFile
                      ? `${this.selectedIsStaged ? "[Staged] " : ""}${this.selectedFile}`
                      : canCommit
                      ? "No file selected"
                      : "Working tree clean"
                  )
              )
          )
          // Diff Content
          .child(
            this.selectedFile
              ? v_flex()
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .child(this.renderDiffLines(this.diffLines, t))
              : v_flex()
                  .flex_1()
                  .min_h(0)
                  .items_center()
                  .justify_center()
                  .gap(6)
                  .child(
                    div()
                      .text_size(12)
                      .font_medium()
                      .text_color(t.muted)
                      .child(canCommit ? "Select a file to view diff" : "Working tree clean")
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(canCommit ? "Click any staged or unstaged file above" : "No pending changes in this repository")
                  )
          )
      )
      // Commit Input Row
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .h(34)
              .child(Input.new(this.input))
          )
          .child(
            div()
              .h(34)
              .px(14)
              .rounded(6)
              .bg(canCommit ? t.accent : t.raised)
              .border_1()
              .border_color(canCommit ? t.accent : t.border)
              .when(canCommit, (el) =>
                el
                  .hover((s) => s.opacity(0.85))
                  .cursor_pointer()
                  .on_click((_e, cx) => this.doCommit(cx))
              )
              .when(!canCommit, (el) => el.cursor_default().opacity(0.6))
              .items_center()
              .justify_center()
              .text_size(11.5)
              .font_semibold()
              .text_color(canCommit ? t.background : t.dim)
              .child("Commit")
          )
      );
  }

  // --- View: Subway Git Graph (Fork Style) ---
  renderGraphTab(t, cx) {
    if (this.graphLoading && (!this.graphRows || this.graphRows.length === 0)) {
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .child(div().text_size(12).text_color(t.dim).child("Loading Subway Git Graph..."));
    }

    if (this.graphError) {
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .p(16)
        .child(div().text_size(12).text_color(t.ansi1).child(this.graphError))
        .child(
          div()
            .px(10)
            .py(4)
            .rounded(5)
            .bg(t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .text_size(11)
            .text_color(t.foreground)
            .on_click((_e, cx) => this.fetchGraph(cx))
            .child("↻ Retry")
        );
    }

    const rows = this.graphRows || [];

    if (rows.length === 0) {
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .child(div().text_size(12).text_color(t.dim).child("No commit history found"))
        .child(
          div()
            .px(10)
            .py(4)
            .rounded(5)
            .bg(t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .text_size(11)
            .text_color(t.foreground)
            .on_click((_e, cx) => this.fetchGraph(cx))
            .child("↻ Refresh")
        );
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(10)
      // Graph Commit List
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .rounded(8)
          .overflow_y_scrollbar()
          .p(6)
          .gap(2)
          .children(
            rows.map((row, idx) => {
              const isSelected = this.selectedCommit?.hash === row.hash;
              const color = TRACK_COLORS[idx % TRACK_COLORS.length];

              if (!row.isCommit) {
                // Pure routing line
                return h_flex()
                  .h(16)
                  .flex_none()
                  .px(6)
                  .child(
                    div()
                      .font_family("JetBrains Mono")
                      .text_size(11)
                      .text_color(t.dim)
                      .child(row.graph)
                  );
              }

              const isMerge = row.parents && row.parents.length > 1;
              const isHeadCommit = (row.refs || []).some((r) => r.includes("HEAD"));
              const badges = row.badges || (row.refs || []).map(parseRefBadge);

              return h_flex()
                .h(28)
                .flex_none()
                .px(6)
                .gap(6)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .when(isSelected, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.selectCommit(row, cx))
                // Railway node & hash
                .child(
                  h_flex()
                    .flex_none()
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .flex_none()
                        .font_family("JetBrains Mono")
                        .text_size(12)
                        .font_semibold()
                        .text_color(isHeadCommit ? t.accent : color)
                        .child(isHeadCommit ? "◉" : isMerge ? "◎" : "●")
                    )
                    .child(
                      div()
                        .flex_none()
                        .font_family("JetBrains Mono")
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(row.hash)
                    )
                )
                // Ref Badges (Fork Rounded Pills)
                .children(
                  badges.slice(0, 3).map((b) => {
                    if (b.isHead) {
                      return div()
                        .flex_none()
                        .px(6)
                        .py(1)
                        .rounded(10)
                        .bg(t.accent + "26")
                        .border_1()
                        .border_color(t.accent + "66")
                        .text_size(10)
                        .font_semibold()
                        .text_color(t.accent)
                        .truncate()
                        .child(`⎇ ${b.label}`);
                    }
                    if (b.type === "branch") {
                      return div()
                        .flex_none()
                        .px(6)
                        .py(1)
                        .rounded(10)
                        .bg(color + "20")
                        .border_1()
                        .border_color(color + "55")
                        .text_size(10)
                        .font_medium()
                        .text_color(color)
                        .truncate()
                        .child(`⎇ ${b.label}`);
                    }
                    if (b.type === "remote") {
                      return div()
                        .flex_none()
                        .px(6)
                        .py(1)
                        .rounded(10)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10)
                        .font_medium()
                        .text_color(t.muted)
                        .truncate()
                        .child(`☁ ${b.label}`);
                    }
                    // Tag
                    return div()
                      .flex_none()
                      .px(6)
                      .py(1)
                      .rounded(10)
                      .bg("#f59e0b20")
                      .border_1()
                      .border_color("#f59e0b66")
                      .text_size(10)
                      .font_medium()
                      .text_color("#fbbf24")
                      .truncate()
                      .child(`🏷 ${b.label}`);
                  })
                )
                .when(badges.length > 3, (el) =>
                  el.child(
                    div()
                      .flex_none()
                      .px(5)
                      .py(0.5)
                      .rounded(10)
                      .bg(t.raised)
                      .text_size(9.5)
                      .text_color(t.dim)
                      .child(`+${badges.length - 3}`)
                  )
                )
                // Commit Subject
                .child(
                  div()
                    .flex_1()
                    .min_w(60)
                    .text_size(11.5)
                    .text_color(t.foreground)
                    .truncate()
                    .child(row.subject)
                )
                // Author & Date
                .when(this.role === "dialog", (el) =>
                  el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(row.author))
                )
                .child(div().flex_none().text_size(10.5).text_color(t.dim).child(row.relDate));
            })
          )
          // Load More Commits Button (+50)
          .child(
            h_flex()
              .h(32)
              .flex_none()
              .items_center()
              .justify_center()
              .child(
                div()
                  .px(14)
                  .py(4)
                  .rounded(5)
                  .bg(t.raised)
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .text_size(11)
                  .font_medium()
                  .text_color(t.foreground)
                  .on_click((_e, cx) => {
                    this.graphLimit += 50;
                    this.fetchGraph(cx);
                  })
                  .child("⇣ 載入更多歷史紀錄 (+50 筆)")
              )
          )
      )
      // Commit Detail Inspector (when a commit is clicked)
      .when(Boolean(this.selectedCommit), (el) =>
        el.child(
          v_flex()
            .h(210)
            .flex_none()
            .p(10)
            .gap(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .rounded(8)
            // Commit header
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .gap(8)
                    .items_center()
                    .child(
                      div()
                        .size(20)
                        .rounded_full()
                        .bg(t.accent)
                        .items_center()
                        .justify_center()
                        .child(
                          div()
                            .text_size(10)
                            .font_bold()
                            .text_color(t.background)
                            .child((this.selectedCommit?.author || "A")[0].toUpperCase())
                        )
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .font_semibold()
                        .text_color(t.foreground)
                        .child(this.selectedCommit?.subject || "")
                    )
                    .child(
                      div()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .font_family("JetBrains Mono")
                        .text_size(10)
                        .text_color(t.dim)
                        .child(this.selectedCommit?.hash || "")
                    )
                )
                .child(
                  div()
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .hover((s) => s.bg(t.hover))
                    .cursor_pointer()
                    .text_size(11)
                    .text_color(t.dim)
                    .on_click((_e, cx) => {
                      this.selectedCommit = null;
                      cx.notify();
                    })
                    .child("✕ Close")
                )
            )
            // Files and Diff view
            .child(
              h_flex()
                .flex_1()
                .min_h(0)
                .gap(8)
                .child(
                  v_flex()
                    .w(180)
                    .min_h(0)
                    .bg(t.background)
                    .rounded(4)
                    .overflow_y_scrollbar()
                    .children(
                      this.commitFiles.map((f) =>
                        h_flex()
                          .h(24)
                          .px(6)
                          .gap(6)
                          .items_center()
                          .cursor_pointer()
                          .when(this.selectedCommitFile === f.path, (el) => el.bg(t.selected))
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.selectCommitFile(f.path, cx))
                          .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).truncate().child(f.path))
                          .child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`))
                          .child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`))
                      )
                    )
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .bg(t.background)
                    .rounded(4)
                    .overflow_y_scrollbar()
                    .child(this.renderDiffLines(this.commitDiffLines, t))
                )
            )
        )
      );
  }

  // --- View: Branches Tab (Fork Style Local & Remotes Tree) ---
  renderBranchesTab(t, cx) {
    const branches = this.refs?.branches || [];
    const remotes = this.refs?.remotes || [];
    const tags = this.refs?.tags || [];

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(12)
      .overflow_y_scrollbar()
      .p(6)
      // Section: Local Branches
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(11).font_bold().text_color(t.dim).child("LOCAL BRANCHES"))
              .child(
                div()
                  .px(6)
                  .py(0.5)
                  .rounded(10)
                  .bg(t.raised)
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(String(branches.length))
              )
          )
          .children(
            branches.map((b) =>
              h_flex()
                .h(28)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(6)
                .when(b.isCurrent, (el) => el.bg(t.raised))
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .text_size(12)
                        .text_color(b.isCurrent ? t.accent : t.muted)
                        .child("⎇")
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .font_semibold()
                        .when(!b.isCurrent, (el) => el.font_normal())
                        .text_color(b.isCurrent ? t.foreground : t.muted)
                        .child(b.name)
                    )
                    .when(b.isCurrent, (el) =>
                      el.child(
                        div()
                          .px(6)
                          .py(0.5)
                          .rounded(8)
                          .bg(t.accent + "26")
                          .text_size(9.5)
                          .font_semibold()
                          .text_color(t.accent)
                          .child("✓ HEAD")
                      )
                    )
                    .when(b.ahead > 0, (el) =>
                      el.child(div().text_size(10).font_medium().text_color(t.accent).child(`↑${b.ahead}`))
                    )
                    .when(b.behind > 0, (el) =>
                      el.child(div().text_size(10).font_medium().text_color("#f59e0b").child(`↓${b.behind}`))
                    )
                )
                .when(!b.isCurrent, (el) =>
                  el.child(
                    div()
                      .px(8)
                      .py(2)
                      .rounded(4)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.raised))
                      .cursor_pointer()
                      .text_size(10.5)
                      .text_color(t.foreground)
                      .on_click((_e, cx) => this.doCheckout(b.name, cx))
                      .child("切換 Checkout")
                  )
                )
            )
          )
      )
      // Section: Remote Branches
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(11).font_bold().text_color(t.dim).child("REMOTES"))
              .child(
                div()
                  .px(6)
                  .py(0.5)
                  .rounded(10)
                  .bg(t.raised)
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(String(remotes.length))
              )
          )
          .children(
            remotes.map((r) =>
              h_flex()
                .h(28)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(6)
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().text_size(11).text_color(t.dim).child("☁"))
                    .child(div().text_size(11.5).text_color(t.muted).child(r.name))
                )
                .child(
                  div()
                    .px(8)
                    .py(2)
                    .rounded(4)
                    .bg(t.surface)
                    .hover((s) => s.bg(t.raised))
                    .cursor_pointer()
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .on_click((_e, cx) => this.doCheckout(r.name, cx))
                    .child("檢出 Checkout")
                )
            )
          )
      )
      // Section: Tags
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(11).font_bold().text_color(t.dim).child("TAGS"))
              .child(
                div()
                  .px(6)
                  .py(0.5)
                  .rounded(10)
                  .bg(t.raised)
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(String(tags.length))
              )
          )
          .children(
            tags.map((tag) =>
              h_flex()
                .h(26)
                .flex_none()
                .px(8)
                .gap(6)
                .items_center()
                .rounded(6)
                .hover((s) => s.bg(t.hover))
                .child(div().text_size(11).text_color("#f59e0b").child("🏷"))
                .child(div().text_size(11.5).text_color(t.foreground).child(tag.name))
            )
          )
      );
  }

  // --- View: Stashes Tab (Fork Style) ---
  renderStashesTab(t, cx) {
    const stashes = this.refs?.stashes || [];

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(10)
      .p(6)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .px(4)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(11).font_bold().text_color(t.dim).child("STASHES"))
              .child(
                div()
                  .px(6)
                  .py(0.5)
                  .rounded(10)
                  .bg(t.raised)
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(String(stashes.length))
              )
          )
          .child(
            div()
              .px(8)
              .py(3)
              .rounded(4)
              .bg(t.raised)
              .hover((s) => s.bg(t.hover))
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .text_color(t.foreground)
              .on_click((_e, cx) => this.doStash(cx))
              .child("＋ 暫存當前變更")
          )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            stashes.map((s) =>
              h_flex()
                .h(34)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(6)
                .bg(t.surface)
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().text_size(12).text_color(t.dim).child("📦"))
                    .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(s.id))
                    .child(div().text_size(11).text_color(t.dim).truncate().child(s.message))
                )
                .child(
                  h_flex()
                    .gap(4)
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.doStashApply(s.id, cx))
                        .child("套用 Apply")
                    )
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.doStashPop(cx))
                        .child("彈出 Pop")
                    )
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .hover((s) => s.bg(t.raised))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.ansi1)
                        .on_click((_e, cx) => this.doStashDrop(s.id, cx))
                        .child("捨棄 Drop")
                    )
                )
            )
          )
          .when(stashes.length === 0, (el) =>
            el.child(
              v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap(6)
                .child(div().text_size(12).text_color(t.dim).child("No stashes saved"))
            )
          )
      );
  }

  // --- Render Layout Header (Fork Style: Repo, Branch, Sync, Tabs) ---
  renderHeader(t, cx) {
    const status = this.status;
    const branch = status?.branch || "main";
    const ahead = status?.ahead || 0;
    const behind = status?.behind || 0;
    const stagedCount = status?.stagedFiles?.length || 0;
    const unstagedCount = status?.unstagedFiles?.length || 0;
    const totalChanges = stagedCount + unstagedCount;

    return v_flex()
      .w_full()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      // Top Row: Branch, Sync Indicators & Actions
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .justify_between()
          // Left: Branch & Sync Indicators
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .gap(4)
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.raised)
                  .items_center()
                  .child(div().text_size(11.5).child("⎇"))
                  .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child(branch))
              )
              .when(ahead > 0, (el) =>
                el.child(
                  div()
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(`↑${ahead}`)
                )
              )
              .when(behind > 0, (el) =>
                el.child(
                  div()
                    .text_size(10.5)
                    .font_semibold()
                    .text_color("#f59e0b")
                    .child(`↓${behind}`)
                )
              )
              // Pull / Push / Fetch buttons
              .child(
                h_flex()
                  .gap(4)
                  .child(
                    div()
                      .px(6)
                      .py(1.5)
                      .rounded(3)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .text_size(10.5)
                      .text_color(t.foreground)
                      .on_click((_e, cx) => this.doPush(cx))
                      .child("⇪ Push")
                  )
                  .child(
                    div()
                      .px(6)
                      .py(1.5)
                      .rounded(3)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .text_size(10.5)
                      .text_color(t.foreground)
                      .on_click((_e, cx) => this.doPull(cx))
                      .child("⇩ Pull")
                  )
                  .child(
                    div()
                      .px(6)
                      .py(1.5)
                      .rounded(3)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .text_size(10.5)
                      .text_color(t.foreground)
                      .on_click((_e, cx) => this.doFetch(cx))
                      .child("↻ Fetch")
                  )
              )
          )
          // Right: Refresh & Popout/Close
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .p(3)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .text_size(11)
                  .text_color(t.dim)
                  .on_click((_e, cx) => this.refresh(cx))
                  .child("↻")
              )
              .when(this.role === "panel", (el) =>
                el.child(
                  div()
                    .p(3)
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .text_size(11)
                    .text_color(t.dim)
                    .on_click((_e, _cx) => this.openOverlayDialog())
                    .child("⧉")
                )
              )
              .when(this.role === "dialog", (el) =>
                el.child(
                  div()
                    .p(3)
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .text_size(12)
                    .text_color(t.dim)
                    .on_click((_e, _cx) => this.close())
                    .child("✕")
                )
              )
          )
      )
      // Bottom Row: Fork Navigation Tabs
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(10)
          .gap(4)
          .items_center()
          // Tab: Changes
          .child(
            h_flex()
              .px(8)
              .py(2)
              .gap(5)
              .items_center()
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "changes", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "changes", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11)
              .font_medium()
              .on_click((_e, cx) => {
                if (this.tab !== "changes") {
                  this.tab = "changes";
                  cx.notify();
                }
              })
              .child(div().child("Changes"))
              .when(totalChanges > 0, (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(0.2)
                    .rounded(8)
                    .bg(t.accent)
                    .text_size(9.5)
                    .font_bold()
                    .text_color(t.background)
                    .child(String(totalChanges))
                )
              )
          )
          // Tab: Subway Graph
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "graph", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "graph", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11)
              .font_medium()
              .on_click((_e, cx) => {
                if (this.tab !== "graph") {
                  this.tab = "graph";
                  cx.notify();
                  if (!this.graphRows || this.graphRows.length === 0) {
                    this.fetchGraph(cx);
                  }
                }
              })
              .child("🌿 Commits Graph")
          )
          // Tab: Branches
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "branches", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "branches", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11)
              .font_medium()
              .on_click((_e, cx) => {
                if (this.tab !== "branches") {
                  this.tab = "branches";
                  cx.notify();
                  if (!this.refs?.branches || this.refs.branches.length === 0) {
                    this.fetchRefs(cx);
                  }
                }
              })
              .child("⎇ Branches")
          )
          // Tab: Stashes
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "stashes", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "stashes", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11)
              .font_medium()
              .on_click((_e, cx) => {
                if (this.tab !== "stashes") {
                  this.tab = "stashes";
                  cx.notify();
                  if (!this.refs?.stashes || this.refs.stashes.length === 0) {
                    this.fetchRefs(cx);
                  }
                }
              })
              .child("📦 Stashes")
          )
      );
  }

  render(cx) {
    const loc = resolveLocation();
    const curKey = `${loc.on || ""}:${loc.cwd || ""}`;
    if (loc.cwd && curKey !== this.lastKey) {
      this.refresh(cx);
    }

    const t = theme();

    if (this.error) {
      return v_flex()
        .id("enhanced-git-view")
        .size_full()
        .p(16)
        .gap(10)
        .bg(t.background)
        .border_1()
        .border_color(t.border)
        .rounded(8)
        .child(
          h_flex()
            .justify_between()
            .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Git Manager (Fork Style)"))
            .child(div().cursor_pointer().on_click((_e, cx) => this.refresh(cx)).child("↻"))
        )
        .child(div().text_size(12).text_color(t.dim).child(this.error));
    }

    const isDialog = this.role === "dialog";

    return v_flex()
      .id("enhanced-git-view")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .rounded(isDialog ? 12 : 8)
      .overflow_hidden()
      .when(isDialog, (el) =>
        el.on_key_down((e, cx) => {
          if (e.key === "escape") {
            this.close();
            cx.stop_propagation();
          }
        })
      )
      .child(this.renderHeader(t, cx))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(10)
          .child(
            this.tab === "changes"
              ? this.renderChangesTab(t, cx)
              : this.tab === "graph"
              ? this.renderGraphTab(t, cx)
              : this.tab === "branches"
              ? this.renderBranchesTab(t, cx)
              : this.renderStashesTab(t, cx)
          )
      );
  }
}
