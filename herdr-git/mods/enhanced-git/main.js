// Enhanced Git Manager for Herdr with Fork-style Sidebar, Subway Git Graph, and LRU Cache
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme, settings, run, openOverlay, closeOverlay, watchFolder,
  setShared, shared, exec, appHome,
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
    this.gitMode = props?.mode || (props?.tab === "github" ? "github" : "local");
    this.tab = props?.tab === "github" ? "changes" : (props?.tab || "changes");

    // GitHub tab state
    this.githubActiveTab = "prs"; // "prs" | "runs" | "issues"
    this.githubLoading = false;
    this.githubError = null;
    this.githubStatus = null; // { hasRepo, repo, branch, url, ci, prs_count, issues_count }
    this.githubPrs = [];
    this.githubRuns = [];
    this.githubIssues = [];
    this.githubAgentPrompt = null;
    this.githubInflightAction = null;

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
      this.githubStatus = null;
      this.fetchGithubStatus(cx);
      if (this.gitMode === "github") {
        this.fetchGithubActiveTab(cx);
      }

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
    setTimeout(() => this.fetchGithubStatus(cx), 1500);
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

  switchGitMode(mode, cx) {
    if (this.gitMode === mode) return;
    this.gitMode = mode;
    cx?.notify?.();
    if (mode === "github") {
      this.fetchGithubStatus(cx).then(() => this.fetchGithubActiveTab(cx));
    }
  }

  doCheckout(branch, cx) {
    this.runAction(() => gitCheckout(this.cwd, this.on, branch), `Checked out ${branch}`, cx);
  }

  resolveGithubProbePath() {
    const h = appHome();
    return `${h}/mods/enhanced-git/probe.py`;
  }

  async runGithubProbe(args) {
    const script = this.resolveGithubProbePath();
    const loc = resolveLocation();
    const dir = this.cwd || loc?.cwd || "";
    const cmdArgs = [script];
    if (dir) {
      cmdArgs.push("--dir", dir);
    }
    cmdArgs.push(...args);

    const res = await exec("python3", cmdArgs);
    if (res.code !== 0 && !res.stdout) {
      throw new Error(res.stderr || `Probe failed with code ${res.code}`);
    }
    return JSON.parse(res.stdout || "{}");
  }

  applyGithubData(data, cx) {
    this.githubStatus = data;
    this.githubPrs = data.prs || [];
    this.githubRuns = data.runs || [];
    this.githubIssues = data.issues || [];
    cx?.notify?.();
  }

  async fetchGithubData(cx, force = false) {
    const loc = resolveLocation();
    const dir = this.cwd || loc?.cwd || "";
    const now = Date.now();
    const cached = this.githubCache?.get(dir);

    if (!force && cached && (now - cached.time < 60000)) {
      this.applyGithubData(cached.data, cx);
      return;
    }

    this.githubLoading = true;
    this.githubError = null;
    cx?.notify?.();

    try {
      const data = await this.runGithubProbe(["--action", "bundle"]);
      if (data.ok || data.hasRepo) {
        if (!this.githubCache) this.githubCache = new Map();
        this.githubCache.set(dir, { data, time: now });
        this.applyGithubData(data, cx);
      } else {
        this.githubStatus = data;
      }
    } catch (e) {
      this.githubError = e.message || String(e);
    } finally {
      this.githubLoading = false;
      cx?.notify?.();
    }
  }

  fetchGithubStatus(cx) {
    return this.fetchGithubData(cx);
  }

  fetchGithubActiveTab(cx) {
    return this.fetchGithubData(cx);
  }

  switchGithubSubTab(tab, cx) {
    if (this.githubActiveTab === tab) return;
    this.githubActiveTab = tab;
    this.githubAgentPrompt = null;
    cx?.notify?.();
  }

  copyGithubText(text, label, cx) {
    if (typeof cx?.write_to_clipboard === "function") {
      cx.write_to_clipboard(text);
    } else {
      exec("sh", ["-c", `printf "%s" "$1" | pbcopy`, "_", text]).catch(() => {});
    }
    this.githubAgentPrompt = `📋 Copied ${label} to clipboard!`;
    cx?.notify?.();
  }

  async reviewPrWithAgent(pr, cx) {
    this.githubInflightAction = `pr-${pr.number}`;
    cx?.notify?.();
    try {
      const diffData = await this.runGithubProbe(["--action", "pr-diff", "--pr", String(pr.number)]);
      const diffSnippet = diffData.diff ? `\n\n\`\`\`diff\n${diffData.diff}\n\`\`\`` : "";
      const prompt = `Please review Pull Request #${pr.number}: "${pr.title}" (branch: ${pr.headRefName}) from ${pr.author?.login}.\n` +
        `Check for potential bugs, security concerns, test coverage, and code quality.${diffSnippet}`;

      this.copyGithubText(prompt, `Agent Review Prompt for PR #${pr.number}`, cx);
    } catch (e) {
      this.githubError = `Failed to prepare PR review: ${e.message}`;
    } finally {
      this.githubInflightAction = null;
      cx?.notify?.();
    }
  }

  async fixCiWithAgent(run, cx) {
    this.githubInflightAction = `run-${run.databaseId}`;
    cx?.notify?.();
    try {
      const logData = await this.runGithubProbe(["--action", "failed-log", "--run-id", String(run.databaseId)]);
      const failedLog = logData.log ? `\n\n\`\`\`\n${logData.log}\n\`\`\`` : "";
      const prompt = `GitHub Actions workflow "${run.workflowName || run.name}" failed on branch "${run.headBranch}" (Run ID: ${run.databaseId}).\n` +
        `Here is the failed log output:${failedLog}\n\nPlease analyze the root cause and fix the failing code.`;

      this.copyGithubText(prompt, `Agent CI Fix Prompt for Run #${run.databaseId}`, cx);
    } catch (e) {
      this.githubError = `Failed to get failed CI log: ${e.message}`;
    } finally {
      this.githubInflightAction = null;
      cx?.notify?.();
    }
  }

  startIssueWithAgent(issue, cx) {
    const prompt = `Please work on GitHub Issue #${issue.number}: "${issue.title}".\n` +
      `URL: ${issue.url}\n` +
      `Please create an appropriate feature/fix branch, implement the required changes, and verify with tests.`;

    this.copyGithubText(prompt, `Agent Task Prompt for Issue #${issue.number}`, cx);
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
    const prCount = this.githubStatus?.prs_count ?? 0;
    const issueCount = this.githubStatus?.issues_count ?? 0;

    return v_flex()
      .w_full()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      // Row 0: Mode Toggle [ 💻 Local ]  [ ☁️ GitHub ] + Repo/Sync info
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(8)
          .items_center()
          .justify_between()
          .bg(t.chrome ?? t.surface)
          .border_b(1)
          .border_color(t.border)
          // Mode Toggle Buttons
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .px(8)
                  .py(2)
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.gitMode === "local", (el) => el.bg(t.raised).text_color(t.foreground).font_bold())
                  .when(this.gitMode !== "local", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
                  .text_size(11)
                  .child("💻 Local")
                  .on_click((_e, cx) => this.switchGitMode("local", cx))
              )
              .child(
                h_flex()
                  .px(8)
                  .py(2)
                  .gap(5)
                  .items_center()
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.gitMode === "github", (el) => el.bg(t.raised).text_color(t.foreground).font_bold())
                  .when(this.gitMode !== "github", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
                  .text_size(11)
                  .child("☁️ GitHub")
                  .when(Boolean(prCount > 0 || issueCount > 0), (el) =>
                    el.child(
                      div()
                        .px(4)
                        .py(0.2)
                        .rounded(8)
                        .bg(this.gitMode === "github" ? t.accent : t.surface)
                        .text_size(9)
                        .font_bold()
                        .text_color(this.gitMode === "github" ? t.background : t.dim)
                        .child(String(prCount + issueCount))
                    )
                  )
                  .on_click((_e, cx) => this.switchGitMode("github", cx))
              )
          )
          // Right Side Actions in Mode Bar
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .when(this.gitMode === "github" && Boolean(this.githubStatus?.repo), (el) =>
                el.child(
                  div()
                    .max_w(160)
                    .px(6)
                    .py(1.5)
                    .rounded(3)
                    .bg(t.background)
                    .text_size(10.5)
                    .font_medium()
                    .text_color(t.accent ?? "#89b4fa")
                    .truncate()
                    .child(this.githubStatus.repo)
                )
              )
              .child(
                div()
                  .p(3)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .text_size(11)
                  .text_color(t.dim)
                  .on_click((_e, cx) => {
                    this.refresh(cx, true);
                    this.fetchGithubStatus(cx);
                    if (this.gitMode === "github") {
                      this.fetchGithubActiveTab(cx);
                    }
                  })
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
      // Row 1: Contextual Navigation Tabs
      .child(
        this.gitMode === "local"
          ? this.renderLocalHeaderRow(t, branch, ahead, behind, totalChanges, cx)
          : this.renderGithubHeaderRow(t, prCount, issueCount, cx)
      );
  }

  renderLocalHeaderRow(t, branch, ahead, behind, totalChanges, cx) {
    return h_flex()
      .h(32)
      .flex_none()
      .px(8)
      .gap(4)
      .items_center()
      .justify_between()
      // Left: Branch
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(
            h_flex()
              .gap(3)
              .px(5)
              .py(1.5)
              .rounded(3)
              .bg(t.raised)
              .items_center()
              .child(div().text_size(10.5).child("⎇"))
              .child(div().font_semibold().text_size(10.5).text_color(t.foreground).truncate().max_w(90).child(branch))
          )
          .when(ahead > 0, (el) => el.child(div().text_size(10).font_semibold().text_color(t.accent).child(`↑${ahead}`)))
          .when(behind > 0, (el) => el.child(div().text_size(10).font_semibold().text_color("#f59e0b").child(`↓${behind}`)))
          .child(
            h_flex()
              .gap(2)
              .child(
                div().px(4).py(1).rounded(3).bg(t.surface).hover((s) => s.bg(t.hover)).cursor_pointer().text_size(9.5).text_color(t.foreground).on_click((_e, cx) => this.doPush(cx)).child("Push")
              )
              .child(
                div().px(4).py(1).rounded(3).bg(t.surface).hover((s) => s.bg(t.hover)).cursor_pointer().text_size(9.5).text_color(t.foreground).on_click((_e, cx) => this.doPull(cx)).child("Pull")
              )
          )
      )
      // Right: Local 4 Tabs
      .child(
        h_flex()
          .gap(2)
          .items_center()
          // Changes
          .child(
            h_flex()
              .px(6)
              .py(1.5)
              .gap(3)
              .items_center()
              .rounded(3)
              .cursor_pointer()
              .when(this.tab === "changes", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "changes", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(10.5)
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
                  div().px(4).py(0.2).rounded(8).bg(t.accent).text_size(8.5).font_bold().text_color(t.background).child(String(totalChanges))
                )
              )
          )
          // Graph
          .child(
            div()
              .px(6)
              .py(1.5)
              .rounded(3)
              .cursor_pointer()
              .when(this.tab === "graph", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "graph", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(10.5)
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
              .child("Graph")
          )
          // Branches
          .child(
            div()
              .px(6)
              .py(1.5)
              .rounded(3)
              .cursor_pointer()
              .when(this.tab === "branches", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "branches", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(10.5)
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
              .child("Branches")
          )
          // Stashes
          .child(
            div()
              .px(6)
              .py(1.5)
              .rounded(3)
              .cursor_pointer()
              .when(this.tab === "stashes", (el) => el.bg(t.raised).text_color(t.foreground))
              .when(this.tab !== "stashes", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
              .text_size(10.5)
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
              .child("Stashes")
          )
      );
  }

  renderGithubHeaderRow(t, prCount, issueCount, cx) {
    const subTab = (key, label, badge) => {
      const active = this.githubActiveTab === key;
      return div()
        .px(8)
        .py(2)
        .cursor_pointer()
        .rounded(3)
        .when(active, (el) => el.bg(t.raised).text_color(t.foreground))
        .when(!active, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
        .text_size(10.5)
        .font_medium()
        .child(
          h_flex()
            .gap(4)
            .items_center()
            .child(label)
            .when(badge !== null && badge !== undefined && badge > 0, (el) =>
              el.child(
                div()
                  .px(4)
                  .py(0.2)
                  .rounded(8)
                  .bg(active ? t.accent : t.surface)
                  .text_size(8.5)
                  .font_bold()
                  .text_color(active ? t.background : t.dim)
                  .child(String(badge))
              )
            )
        )
        .on_click(() => this.switchGithubSubTab(key, cx));
    };

    return h_flex()
      .h(32)
      .flex_none()
      .px(8)
      .gap(4)
      .items_center()
      .justify_between()
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(subTab("prs", "🔀 PRs", prCount))
          .child(subTab("runs", "🟢 CI Runs", null))
          .child(subTab("issues", "🎫 Issues", issueCount))
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .when(Boolean(this.githubStatus?.url), (el) =>
            el.child(
              div()
                .px(6)
                .py(1.5)
                .rounded(3)
                .cursor_pointer()
                .text_size(10)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => exec("open", [this.githubStatus.url]))
                .child("🌐 Web")
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
            this.gitMode === "github"
              ? this.renderGitHubTab(t, cx)
              : this.error
              ? this.renderLocalErrorState(t, cx)
              : this.tab === "changes"
              ? this.renderChangesTab(t, cx)
              : this.tab === "graph"
              ? this.renderGraphTab(t, cx)
              : this.tab === "branches"
              ? this.renderBranchesTab(t, cx)
              : this.renderStashesTab(t, cx)
          )
      );
  }

  renderLocalErrorState(t, cx) {
    return div()
      .py(40)
      .items_center()
      .justify_center()
      .child(
        v_flex()
          .items_center()
          .gap(8)
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("Not a Git Repository"))
          .child(div().text_size(11.5).text_color(t.dim).child(String(this.error)))
          .child(
            div()
              .px(8)
              .py(3)
              .rounded(4)
              .cursor_pointer()
              .bg(t.raised)
              .text_size(11)
              .text_color(t.foreground)
              .on_click((_e, cx) => this.refresh(cx, true))
              .child("↻ Retry")
          )
      );
  }

  renderGitHubTab(t, cx) {
    const hasRepo = Boolean(this.githubStatus && this.githubStatus.hasRepo);
    const prCount = this.githubStatus?.prs_count ?? 0;
    const issueCount = this.githubStatus?.issues_count ?? 0;

    const subTab = (key, label, badge) => {
      const active = this.githubActiveTab === key;
      return div()
        .px(10)
        .py(4)
        .cursor_pointer()
        .rounded(4)
        .when(active, (el) => el.bg(t.raised).text_color(t.foreground))
        .when(!active, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
        .text_size(11)
        .font_medium()
        .child(
          h_flex()
            .gap(5)
            .items_center()
            .child(label)
            .when(badge !== null && badge !== undefined && badge > 0, (el) =>
              el.child(
                div()
                  .px(4)
                  .py(0.2)
                  .rounded(8)
                  .bg(active ? t.accent : t.surface)
                  .text_size(9)
                  .font_bold()
                  .text_color(active ? t.background : t.dim)
                  .child(String(badge))
              )
            )
        )
        .on_click(() => this.switchGithubSubTab(key, cx));
    };

    return v_flex()
      .size_full()
      .gap(8)
      // Agent prompt banner (if any)
      .when(Boolean(this.githubAgentPrompt), (el) =>
        el.child(
          h_flex()
            .px(10)
            .py(6)
            .rounded(4)
            .items_center()
            .justify_between()
            .bg(t.selected ?? "#1e293b")
            .border_1()
            .border_color(t.accent ?? "#89b4fa")
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .text_size(11.5)
                    .font_medium()
                    .text_color(t.accent ?? "#89b4fa")
                    .child(this.githubAgentPrompt)
                )
                .child(
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child("(Paste into Agent terminal)")
                )
            )
            .child(
              div()
                .cursor_pointer()
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => {
                  this.githubAgentPrompt = null;
                  cx.notify();
                })
                .child("✕")
            )
        )
      )
      // Sub-Tabs Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(subTab("prs", "🔀 PRs", prCount))
              .child(subTab("runs", "🟢 CI Runs", null))
              .child(subTab("issues", "🎫 Issues", issueCount))
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(Boolean(this.githubStatus?.url), (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(2)
                    .rounded(3)
                    .cursor_pointer()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .on_click(() => exec("open", [this.githubStatus.url]))
                    .child("🌐 Web")
                )
              )
              .child(
                div()
                  .px(6)
                  .py(2)
                  .rounded(3)
                  .cursor_pointer()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => {
                    this.fetchGithubStatus(cx).then(() => this.fetchGithubActiveTab(cx));
                  })
                  .child(this.githubLoading ? "↻ ..." : "↻ Refresh")
              )
          )
      )
      // Sub-View Content
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scroll()
          .when(!hasRepo, (el) =>
            el.child(
              div()
                .py(30)
                .items_center()
                .justify_center()
                .child(
                  v_flex()
                    .items_center()
                    .gap(6)
                    .child(div().text_size(12).font_medium().text_color(t.foreground).child("No GitHub Remote in Workspace"))
                    .child(div().text_size(11).text_color(t.dim).child("Current directory is not connected to a GitHub repository."))
                )
            )
          )
          .when(hasRepo && this.githubLoading, (el) =>
            el.child(
              div()
                .py(30)
                .items_center()
                .justify_center()
                .child(div().text_size(12).text_color(t.dim).child("Connecting to GitHub..."))
            )
          )
          .when(hasRepo && !this.githubLoading && Boolean(this.githubError), (el) =>
            el.child(
              div()
                .py(20)
                .items_center()
                .justify_center()
                .child(
                  v_flex()
                    .items_center()
                    .gap(4)
                    .child(div().text_size(12).text_color(t.ansi1 ?? "#f38ba8").child("Failed to load GitHub data"))
                    .child(div().text_size(11).text_color(t.dim).child(String(this.githubError)))
                )
            )
          )
          .when(hasRepo && !this.githubLoading && !this.githubError, (el) => {
            if (this.githubActiveTab === "prs") return el.child(this.renderGithubPrs(t, cx));
            if (this.githubActiveTab === "runs") return el.child(this.renderGithubRuns(t, cx));
            if (this.githubActiveTab === "issues") return el.child(this.renderGithubIssues(t, cx));
            return el;
          })
      );
  }

  renderGithubPrs(t, cx) {
    if (!this.githubPrs || this.githubPrs.length === 0) {
      const issueCount = this.githubIssues?.length || this.githubStatus?.issues_count || 0;
      return div()
        .py(30)
        .items_center()
        .justify_center()
        .child(
          v_flex()
            .items_center()
            .gap(6)
            .child(div().text_size(12).font_medium().text_color(t.foreground).child("No open pull requests"))
            .when(issueCount > 0, (el) =>
              el.child(
                div()
                  .cursor_pointer()
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.accent ?? "#89b4fa")
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => this.switchGithubSubTab("issues", cx))
                  .child(`View ${issueCount} open issues in Issues tab ➔`)
              )
            )
        );
    }
    const list = v_flex().gap(6);
    for (const pr of this.githubPrs) {
      const isInflight = this.githubInflightAction === `pr-${pr.number}`;
      list.child(
        div()
          .p(8)
          .rounded(4)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(11.5).font_bold().text_color(t.accent).child(`#${pr.number}`))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).truncate().child(pr.title))
                  )
                  .child(
                    h_flex()
                      .gap(4)
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .cursor_pointer()
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover ?? t.border))
                          .on_click(() => this.reviewPrWithAgent(pr, cx))
                          .child(isInflight ? "..." : "🤖 Review")
                      )
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .cursor_pointer()
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => exec("open", [pr.url]))
                          .child("Open ↗")
                      )
                  )
              )
              .child(
                h_flex()
                  .gap(8)
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(`by ${pr.author?.login || "unknown"}`)
                  .child(`🌿 ${pr.headRefName}`)
                  .child(
                    h_flex()
                      .gap(3)
                      .child(div().text_color(t.ansi2 ?? "#a6e3a1").child(`+${pr.additions || 0}`))
                      .child(div().text_color(t.ansi1 ?? "#f38ba8").child(`-${pr.deletions || 0}`))
                  )
              )
          )
      );
    }
    return list;
  }

  renderGithubRuns(t, cx) {
    if (!this.githubRuns || this.githubRuns.length === 0) {
      return div().py(30).items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("No recent workflow runs."));
    }
    const list = v_flex().gap(6);
    for (const run of this.githubRuns) {
      const isSuccess = run.conclusion === "success";
      const isFailure = run.conclusion === "failure";
      const isInflight = this.githubInflightAction === `run-${run.databaseId}`;
      const statusColor = isSuccess ? (t.ansi2 ?? "#a6e3a1") : isFailure ? (t.ansi1 ?? "#f38ba8") : (t.blocked ?? "#fab387");

      list.child(
        div()
          .p(8)
          .rounded(4)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(10).font_bold().text_color(statusColor).child(isSuccess ? "✔" : isFailure ? "✖" : "●"))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).truncate().child(run.workflowName || run.name))
                  )
                  .child(
                    h_flex()
                      .gap(4)
                      .when(isFailure, (el) =>
                        el.child(
                          div()
                            .px(6)
                            .py(2)
                            .rounded(3)
                            .cursor_pointer()
                            .bg(t.ansi1 ?? "#f38ba8")
                            .text_size(10.5)
                            .font_medium()
                            .text_color("#181825")
                            .on_click(() => this.fixCiWithAgent(run, cx))
                            .child(isInflight ? "..." : "🤖 Fix")
                        )
                      )
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .cursor_pointer()
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => exec("open", [run.url]))
                          .child("Open ↗")
                      )
                  )
              )
              .child(
                h_flex()
                  .gap(8)
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(`🌿 ${run.headBranch}`)
                  .child(`event: ${run.event || "push"}`)
              )
          )
      );
    }
    return list;
  }

  renderGithubIssues(t, cx) {
    if (!this.githubIssues || this.githubIssues.length === 0) {
      return div().py(30).items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("No open issues."));
    }
    const list = v_flex().gap(6);
    for (const issue of this.githubIssues) {
      list.child(
        div()
          .p(8)
          .rounded(4)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(11.5).font_bold().text_color(t.ansi2 ?? "#a6e3a1").child(`#${issue.number}`))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).truncate().child(issue.title))
                  )
                  .child(
                    h_flex()
                      .gap(4)
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .cursor_pointer()
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover ?? t.border))
                          .on_click(() => this.startIssueWithAgent(issue, cx))
                          .child("🤖 Start")
                      )
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .cursor_pointer()
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => exec("open", [issue.url]))
                          .child("Open ↗")
                      )
                  )
              )
              .child(
                div().text_size(10.5).text_color(t.dim).child(`opened by ${issue.author?.login || "unknown"}`)
              )
          )
      );
    }
    return list;
  }
}
