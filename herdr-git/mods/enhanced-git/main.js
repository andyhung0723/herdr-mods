// Enhanced Git Manager for Herdr with interactive Git Graph and Staged/Unstaged management
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
  gitPush, gitPull, gitFetch, gitStash, gitStashPop
} from "./git.js";

const OVERLAY_KEY = "enhanced-git.open-overlay";

const TRACK_COLORS = [
  "#3b82f6", // Blue
  "#a855f7", // Purple
  "#10b981", // Emerald
  "#f59e0b", // Amber
  "#ec4899", // Pink
  "#06b6d4", // Cyan
  "#f97316", // Orange
];

export default class EnhancedGit extends View {
  init(props, cx) {
    this.role = props?.role || "panel"; // "panel" or "dialog"
    this.overlayId = props?.overlayId || null;
    this.tab = props?.tab || "changes"; // "changes" | "graph"

    this.status = null;
    this.graphRows = [];
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
      selectedFile: this.selectedFile,
      selectedIsStaged: this.selectedIsStaged,
      diffLines: this.diffLines,
    });
    // Cap at 8 sessions to ensure minimal memory usage (< 500KB)
    if (this.gitCache.size > 8) {
      const oldestKey = this.gitCache.keys().next().value;
      this.gitCache.delete(oldestKey);
    }
  }

  fetchGraph(cx) {
    if (!this.cwd || !this.status?.isRepo) return;
    const cwd = this.cwd, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const graphData = await getGitGraph(cwd, on, 40);
        if (this.cwd === cwd) {
          this.graphRows = graphData.rows || [];
          this.updateCache();
          cx.notify();
        }
      } catch (err) {
        // Non-fatal, graph load error is ignored
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
        this.selectedFile = cached.selectedFile || null;
        this.selectedIsStaged = cached.selectedIsStaged || false;
        this.diffLines = cached.diffLines || [];
        this.error = null;
        this.loading = false;
        cx.notify();
      } else {
        this.status = null;
        this.graphRows = [];
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
        // Lazy load graph: only fetch git graph if on graph tab or in full dialog
        const needGraph = this.tab === "graph" || this.role === "dialog";
        const tasks = [getGitStatus(cwd, on)];
        if (needGraph) {
          tasks.push(getGitGraph(cwd, on, 40));
        }

        const [statusData, graphData] = await Promise.all(tasks);

        if (this.cwd !== cwd) return; // Stale request, user switched session

        if (!statusData.isRepo) {
          this.status = null;
          this.graphRows = [];
          this.error = statusData.error || "Not a git repository";
          return;
        }

        this.status = statusData;
        if (graphData) {
          this.graphRows = graphData.rows || [];
        }
        this.error = null;

        // Auto-select first changed file if none selected
        if (!this.selectedFile) {
          if (statusData.stagedFiles.length > 0) {
            this.selectFile(statusData.stagedFiles[0].path, true, cx);
          } else if (statusData.unstagedFiles.length > 0) {
            this.selectFile(statusData.unstagedFiles[0].path, false, cx);
          }
        }

        this.updateCache();
      } catch (err) {
        if (this.cwd === cwd) {
          this.error = String(err);
        }
      } finally {
        if (this.cwd === cwd) {
          this.loading = false;
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
    this.runAction(() => gitStash(this.cwd, this.on), "Stashed current changes", cx);
  }

  doStashPop(cx) {
    this.runAction(() => gitStashPop(this.cwd, this.on), "Applied stashed changes", cx);
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
      width: 960,
      height: 640
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

  // --- View: Changes Tab ---
  renderChangesTab(t, cx) {
    const status = this.status;
    const staged = status?.stagedFiles || [];
    const unstaged = status?.unstagedFiles || [];

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
                      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Staged Changes"))
                      .child(
                        div()
                          .px(5)
                          .py(0.5)
                          .rounded(3)
                          .bg(t.raised)
                          .text_size(10)
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
                      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Changes"))
                      .child(
                        div()
                          .px(5)
                          .py(0.5)
                          .rounded(3)
                          .bg(t.raised)
                          .text_size(10)
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
                        .text_color(f.fresh ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked)
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
                        .text_size(10)
                        .text_color(t.dim)
                        .on_click((e, cx) => {
                          e.stop_propagation?.();
                          this.doDiscard(f.path, f.fresh, cx);
                        })
                        .child("↺")
                    )
                )
              )
              .when(unstaged.length === 0, (el) =>
                el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Clean working tree"))
              )
          )
      )
      // Middle: Diff Viewer
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .rounded(6)
          .overflow_y_scrollbar()
          .child(
            h_flex()
              .h(26)
              .flex_none()
              .px(8)
              .items_center()
              .justify_between()
              .bg(t.raised)
              .border_b(1)
              .border_color(t.border)
              .child(
                div()
                  .text_size(11)
                  .font_medium()
                  .text_color(t.foreground)
                  .truncate()
                  .child(this.selectedFile ? `${this.selectedIsStaged ? "Staged: " : ""}${this.selectedFile}` : "Select a file to inspect diff")
              )
          )
          .child(this.renderDiffLines(this.diffLines, t))
      )
      // Bottom: Commit Area & Quick Stash
      .child(
        v_flex()
          .flex_none()
          .gap(6)
          .child(
            h_flex()
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .h(32)
                  .px(10)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))
              )
              .child(
                div()
                  .h(32)
                  .px(12)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .bg(Boolean(this.message.trim()) ? t.solid : t.raised)
                  .text_color(Boolean(this.message.trim()) ? t.solid_foreground : t.dim)
                  .text_size(12)
                  .font_medium()
                  .when(Boolean(this.message.trim()), (el) => el.cursor_pointer().on_click((_e, cx) => this.doCommit(cx)))
                  .child(this.busy ? "..." : (staged.length > 0 ? "Commit Staged" : "Commit All"))
              )
          )
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(8)
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .cursor_pointer()
                      .hover((s) => s.text_color(t.foreground))
                      .on_click((_e, cx) => this.doStash(cx))
                      .child("📦 Stash")
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .cursor_pointer()
                      .hover((s) => s.text_color(t.foreground))
                      .on_click((_e, cx) => this.doStashPop(cx))
                      .child("Pop")
                  )
              )
              .when(Boolean(this.note), (el) =>
                el.child(div().text_size(11).text_color(t.accent).truncate().child(this.note))
              )
          )
      );
  }

  // --- View: Git Graph Tab ---
  renderGraphTab(t, cx) {
    const rows = this.graphRows;

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
                  .h(18)
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

              return h_flex()
                .h(28)
                .flex_none()
                .px(6)
                .gap(8)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .when(isSelected, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.selectCommit(row, cx))
                // Railway node & hash
                .child(
                  h_flex()
                    .gap(5)
                    .items_center()
                    .child(
                      div()
                        .w(14)
                        .font_family("JetBrains Mono")
                        .text_size(12)
                        .font_semibold()
                        .text_color(color)
                        .child(row.graph || "●")
                    )
                    .child(
                      div()
                        .font_family("JetBrains Mono")
                        .text_size(11)
                        .text_color(t.dim)
                        .child(row.hash)
                    )
                )
                // Ref Badges (branches/tags)
                .children(
                  row.refs.map((ref) => {
                    const isHead = ref.includes("HEAD");
                    return div()
                      .px(5)
                      .py(0.5)
                      .rounded(3)
                      .bg(isHead ? (t.accent + "33") : t.raised)
                      .text_size(10)
                      .font_semibold()
                      .text_color(isHead ? t.accent : t.foreground)
                      .child(ref);
                  })
                )
                // Commit Subject
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .text_size(12)
                    .text_color(t.foreground)
                    .truncate()
                    .child(row.subject)
                )
                // Author & Date
                .child(div().text_size(10.5).text_color(t.dim).child(row.author))
                .child(div().text_size(10.5).text_color(t.dim).child(row.relDate));
            })
          )
      )
      // Commit Detail Inspector (when a commit is clicked)
      .when(Boolean(this.selectedCommit), (el) =>
        el.child(
          v_flex()
            .h(200)
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
                    .gap(6)
                    .items_center()
                    .child(div().font_semibold().text_size(12).text_color(t.foreground).child(this.selectedCommit.hash))
                    .child(div().text_size(11.5).text_color(t.dim).child(`by ${this.selectedCommit.author}`))
                    .child(div().text_size(11.5).text_color(t.dim).child(`(${this.selectedCommit.relDate})`))
                )
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => this.selectCommit(this.selectedCommit, cx))
                    .child("✕ Close")
                )
            )
            .child(
              div()
                .text_size(12)
                .font_medium()
                .text_color(t.foreground)
                .truncate()
                .child(this.selectedCommit.subject)
            )
            // Changed files & diff split
            .child(
              h_flex()
                .flex_1()
                .min_h(0)
                .gap(8)
                .child(
                  v_flex()
                    .w(180)
                    .flex_none()
                    .overflow_y_scrollbar()
                    .gap(2)
                    .children(
                      this.commitFiles.map((f) =>
                        h_flex()
                          .h(22)
                          .px(6)
                          .items_center()
                          .justify_between()
                          .rounded(4)
                          .cursor_pointer()
                          .when(this.selectedCommitFile === f.path, (e) => e.bg(t.selected))
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

  // --- Render Layout Header (Branch, Sync, Tabs, Popout) ---
  renderHeader(t, cx) {
    const status = this.status;
    const branch = status?.branch || "main";
    const ahead = status?.ahead || 0;
    const behind = status?.behind || 0;

    return h_flex()
      .h(38)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .justify_between()
      .border_b(1)
      .border_color(t.border)
      // Left: Branch & Sync Info
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
          // Sync indicators
          .when(ahead > 0, (el) =>
            el.child(
              div()
                .text_size(10.5)
                .font_medium()
                .text_color(t.accent)
                .child(`↑${ahead}`)
            )
          )
          .when(behind > 0, (el) =>
            el.child(
              div()
                .text_size(10.5)
                .font_medium()
                .text_color(t.blocked || "#f59e0b")
                .child(`↓${behind}`)
            )
          )
          // Push / Pull action buttons
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
          )
      )
      // Right: Tabs & Popout
      .child(
        h_flex()
          .gap(4)
          .items_center()
          // Tab: Changes
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "changes", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "changes", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11.5)
              .font_medium()
              .on_click(() => {
                this.tab = "changes";
                cx.notify();
              })
              .child("Changes")
          )
          // Tab: Git Graph
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .when(this.tab === "graph", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "graph", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(11.5)
              .font_medium()
              .on_click((_e, cx) => {
                this.tab = "graph";
                if (!this.graphRows || this.graphRows.length === 0) {
                  this.fetchGraph(cx);
                }
                cx.notify();
              })
              .child("🌿 Graph")
          )
          // Refresh
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
          // Expand button (when in panel mode)
          .when(this.role === "panel", (el) =>
            el.child(
              div()
                .p(3)
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .text_size(11)
                .text_color(t.dim)
                .on_click(() => this.openOverlayDialog())
                .child("⧉")
            )
          )
          // Close button (when in dialog mode)
          .when(this.role === "dialog", (el) =>
            el.child(
              div()
                .p(3)
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .text_size(12)
                .text_color(t.dim)
                .on_click(() => this.close())
                .child("✕")
            )
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
        .child(h_flex().justify_between().child(div().font_semibold().text_size(13).text_color(t.foreground).child("Git Manager")).child(div().cursor_pointer().on_click((_e, cx) => this.refresh(cx)).child("↻")))
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
          .child(this.tab === "changes" ? this.renderChangesTab(t, cx) : this.renderGraphTab(t, cx))
      );
  }
}
