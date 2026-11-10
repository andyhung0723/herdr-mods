// Enhanced Git & GitHub Manager for Herdr
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, v_virtual_list } from "gpui-base";
import {
  theme, settings, openOverlay, closeOverlay, watchFolder,
  setShared, shared, exec, appHome,
} from "herdr";
import {
  resolveLocation, getGitStatus, getGitGraph, getCommitFiles,
  getFileDiff, getCommitDiff, gitStageFile, gitUnstageFile,
  gitDiscardFile, gitStageAll, gitUnstageAll, gitCommit,
  gitPush, gitPull, gitFetch, gitStash, gitStashPop,
  getGitRefs, gitCheckout, gitStashApply, gitStashDrop,
  parseRefBadge,
} from "./git.js";

const OVERLAY_KEY = "enhanced-git.open-overlay";
const ICON_BASE = "mods/enhanced-git";
const icon = (name, size = 13) => svg(`${ICON_BASE}/${name}.svg`).size(size).flex_none();

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

function parseDiffRows(lines) {
  let oldNum = 0;
  let newNum = 0;
  return (lines || []).map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      oldNum = Number(match[1]);
      newNum = Number(match[2]);
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind: "-", number: oldNum++, text: line.slice(1) || " " };
    if (kind === "+") return { kind: "+", number: newNum++, text: line.slice(1) || " " };
    if (kind === " ") {
      oldNum++;
      return { kind: " ", number: newNum++, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

export default class EnhancedGit extends View {
  init(props, cx) {
    this.asyncCx = cx;
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
    this.githubCache = new Map();

    // Local Git state
    this.status = null;
    this.graphRows = [];
    this.graphLimit = 50;
    this.refs = { branches: [], remotes: [], tags: [], stashes: [] };
    this.loading = false;
    this.busy = false;
    this.error = null;
    this.note = null;
    this.watchedRoot = null;

    // Changes tab state
    this.selectedFile = null;
    this.selectedIsStaged = false;
    this.diffLines = [];
    this.diffRows = [];
    this.message = "";
    this.typing = false;
    this.input = InputState.new({ placeholder: "Commit message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.doCommit(cx));
    this.input.on?.("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on?.("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });

    // Git Graph tab state
    this.selectedCommit = null;
    this.commitFiles = [];
    this.selectedCommitFile = null;
    this.commitDiffLines = [];
    this.commitDiffRows = [];
    this.graphLoading = false;
    this.graphError = null;

    // Session cache & lazy loading
    this.gitCache = new Map();
    this.lastKey = null;

    this.handle = cx.focus_handle();
    this.refresh(cx);

    // Periodic lightweight check
    cx.timer.every(12000, (tcx) => {
      this.asyncCx = tcx;
      this.refresh(tcx);
    });
  }

  repoRoot() {
    return this.status?.root || this.cwd;
  }

  setDiffLines(lines) {
    this.diffLines = lines || [];
    this.diffRows = parseDiffRows(this.diffLines);
  }

  setCommitDiffLines(lines) {
    this.commitDiffLines = lines || [];
    this.commitDiffRows = parseDiffRows(this.commitDiffLines);
  }

  watchRepo(root, cx) {
    if (!root || this.on || this.watchedRoot === root) return;
    this.watchedRoot = root;
    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return;
    spawnCx.spawn(async (scx) => {
      try {
        while (this.watchedRoot === root) {
          const paths = await watchFolder(root);
          if (!Array.isArray(paths) || paths.length === 0) break;
          const relevant = paths.some(
            (p) => !p.includes("/node_modules/") && !p.includes("/.angular/") && !p.includes("/dist/")
          );
          if (relevant && this.watchedRoot === root && !this.loading && !this.busy) {
            await this.refresh(scx);
          }
        }
      } catch {
        this.watchedRoot = null;
      }
    });
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
    if (this.gitCache.size > 8) {
      const oldestKey = this.gitCache.keys().next().value;
      this.gitCache.delete(oldestKey);
    }
  }

  fetchGraph(cx) {
    const targetPath = this.repoRoot();
    if (!targetPath) return;
    const on = this.on;
    this.graphLoading = true;
    this.graphError = null;

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return;

    spawnCx.spawn(async (scx) => {
      try {
        const graphData = await getGitGraph(targetPath, on, this.graphLimit);
        if (this.repoRoot() === targetPath || this.cwd === targetPath) {
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
        scx.notify();
      }
    });
  }

  fetchRefs(cx) {
    const targetPath = this.repoRoot();
    if (!targetPath) return;
    const on = this.on;
    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return;

    spawnCx.spawn(async (scx) => {
      try {
        const refsData = await getGitRefs(targetPath, on);
        if (this.repoRoot() === targetPath || this.cwd === targetPath) {
          if (!refsData.error) {
            this.refs = refsData;
            this.updateCache();
          }
        }
      } catch {
      } finally {
        scx.notify();
      }
    });
  }

  // IMPORTANT: Never call cx.notify() synchronously inside refresh(),
  // because refresh() can be invoked from render() when switching spaces.
  refresh(cx, force = false) {
    if (this.busy) return Promise.resolve();
    const { cwd, on } = resolveLocation();
    if (!cwd) {
      this.error = "No workspace folder selected";
      return Promise.resolve();
    }

    const currentKey = `${on || ""}:${cwd}`;
    const isNewSession = currentKey !== this.lastKey;

    if (isNewSession) {
      this.updateCache();

      const cached = this.gitCache.get(currentKey);
      this.lastKey = currentKey;
      this.cwd = cwd;
      this.on = on;
      this.watchedRoot = null;

      // Restore or reset GitHub state for new session
      const ghCached = this.githubCache.get(cwd);
      if (ghCached) {
        this.githubStatus = ghCached.data;
        this.githubPrs = ghCached.data.prs || [];
        this.githubRuns = ghCached.data.runs || [];
        this.githubIssues = ghCached.data.issues || [];
        this.githubError = null;
      } else {
        this.githubStatus = null;
        this.githubPrs = [];
        this.githubRuns = [];
        this.githubIssues = [];
        this.githubError = null;
      }

      if (cached && !force) {
        this.status = cached.status;
        this.graphRows = cached.graphRows || [];
        this.graphError = cached.graphError || null;
        this.refs = cached.refs || { branches: [], remotes: [], tags: [], stashes: [] };
        this.graphLoading = false;
        this.selectedFile = cached.selectedFile || null;
        this.selectedIsStaged = cached.selectedIsStaged || false;
        this.setDiffLines(cached.diffLines || []);
        this.selectedCommit = cached.selectedCommit || null;
        this.commitFiles = cached.commitFiles || [];
        this.selectedCommitFile = cached.selectedCommitFile || null;
        this.setCommitDiffLines(cached.commitDiffLines || []);
        this.error = null;
        this.loading = false;
      } else {
        this.status = null;
        this.graphRows = [];
        this.graphError = null;
        this.graphLoading = this.tab === "graph";
        this.selectedFile = null;
        this.setDiffLines([]);
        this.error = null;
        this.loading = true;
      }
    } else if (this.loading && !force) {
      return Promise.resolve();
    }

    this.loading = true;
    this.cwd = cwd;
    this.on = on;

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return Promise.resolve();

    return new Promise((resolve) => {
      spawnCx.spawn(async (scx) => {
        try {
          const needGraph = this.gitMode === "local" && (this.tab === "graph" || this.role === "dialog");
          const needRefs = this.gitMode === "local" && (this.tab === "branches" || this.tab === "stashes");
          if (needGraph) this.graphLoading = true;

          const statusData = await getGitStatus(cwd, on);

          if (this.cwd !== cwd) {
            resolve();
            return;
          }

          if (!statusData.isRepo) {
            this.status = null;
            this.graphRows = [];
            this.graphError = null;
            this.graphLoading = false;
            this.error = statusData.error || "Not a git repository";
            if (this.gitMode === "github") {
              await this.fetchGithubData(scx, force);
            }
            return;
          }

          this.status = statusData;
          this.error = null;
          this.watchRepo(statusData.root, scx);

          // Lazy-load refs only when needed
          if (needRefs) {
            this.fetchRefs(scx);
          }

          // Lazy-load graph only when needed
          if (needGraph) {
            const graphData = await getGitGraph(statusData.root || cwd, on, this.graphLimit);
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
            this.selectedIsStaged = stillExists.staged;
            const diff = await getFileDiff(
              statusData.root || cwd,
              on,
              stillExists.path,
              stillExists.staged,
              Boolean(stillExists.fresh)
            );
            if (this.selectedFile === stillExists.path) {
              this.setDiffLines(diff);
            }
          } else if (allChangedFiles.length > 0) {
            const first = allChangedFiles[0];
            this.selectedFile = first.path;
            this.selectedIsStaged = first.staged;
            const diff = await getFileDiff(
              statusData.root || cwd,
              on,
              first.path,
              first.staged,
              Boolean(first.fresh)
            );
            if (this.selectedFile === first.path) {
              this.setDiffLines(diff);
            }
          } else {
            this.selectedFile = null;
            this.selectedIsStaged = false;
            this.setDiffLines([]);
          }

          this.updateCache();

          if (this.gitMode === "github") {
            await this.fetchGithubData(scx, force);
          }
        } catch (err) {
          if (this.cwd === cwd) {
            this.error = String(err);
          }
        } finally {
          if (this.cwd === cwd) {
            this.loading = false;
            this.graphLoading = false;
          }
          scx.notify();
          resolve();
        }
      });
    });
  }

  selectFile(path, staged, cx, fresh = null) {
    this.selectedFile = path;
    this.selectedIsStaged = staged;
    this.setDiffLines([]);

    const isFresh =
      fresh !== null
        ? fresh
        : Boolean(
            !staged &&
              this.status?.unstagedFiles?.find((f) => f.path === path)?.fresh
          );
    const root = this.repoRoot();
    const on = this.on;
    const spawnCx = cx?.spawn ? cx : this.asyncCx;

    if (spawnCx?.spawn) {
      spawnCx.spawn(async (scx) => {
        try {
          const lines = await getFileDiff(root, on, path, staged, isFresh);
          if (this.selectedFile === path && this.selectedIsStaged === staged) {
            this.setDiffLines(lines);
          }
        } catch (e) {
          this.setDiffLines(["Failed to load diff: " + e]);
        }
        scx.notify();
      });
    }
    cx?.notify?.();
  }

  selectCommit(row, cx) {
    if (!row.isCommit) return;
    if (this.selectedCommit?.hash === row.hash) {
      this.selectedCommit = null;
      this.commitFiles = [];
      this.selectedCommitFile = null;
      this.setCommitDiffLines([]);
      cx?.notify?.();
      return;
    }

    this.selectedCommit = row;
    this.commitFiles = [];
    this.selectedCommitFile = null;
    this.setCommitDiffLines([]);

    const root = this.repoRoot();
    const on = this.on;
    const spawnCx = cx?.spawn ? cx : this.asyncCx;

    if (spawnCx?.spawn) {
      spawnCx.spawn(async (scx) => {
        try {
          this.commitFiles = await getCommitFiles(root, on, row.hash);
          if (this.commitFiles.length > 0 && this.selectedCommit?.hash === row.hash) {
            const firstPath = this.commitFiles[0].path;
            this.selectedCommitFile = firstPath;
            const lines = await getCommitDiff(root, on, row.hash, firstPath);
            if (this.selectedCommitFile === firstPath) {
              this.setCommitDiffLines(lines);
            }
          }
        } catch (e) {
          this.note = "Failed to load commit files: " + e;
        }
        scx.notify();
      });
    }
    cx?.notify?.();
  }

  selectCommitFile(path, cx) {
    this.selectedCommitFile = path;
    this.setCommitDiffLines([]);
    if (!this.selectedCommit) return;

    const root = this.repoRoot();
    const on = this.on;
    const hash = this.selectedCommit.hash;
    const spawnCx = cx?.spawn ? cx : this.asyncCx;

    if (spawnCx?.spawn) {
      spawnCx.spawn(async (scx) => {
        try {
          const lines = await getCommitDiff(root, on, hash, path);
          if (this.selectedCommitFile === path) {
            this.setCommitDiffLines(lines);
          }
        } catch (e) {
          this.setCommitDiffLines(["Failed to load diff: " + e]);
        }
        scx.notify();
      });
    }
    cx?.notify?.();
  }

  runAction(actionFn, successMsg, cx) {
    if (this.busy || !this.status?.isRepo) return;
    this.busy = true;
    this.note = null;
    cx?.notify?.();

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return;

    spawnCx.spawn(async (scx) => {
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
        await this.refresh(scx, true);
        scx.notify();
      }
    });
  }

  doStage(path, cx) {
    this.runAction(() => gitStageFile(this.repoRoot(), this.on, path), null, cx);
  }

  doUnstage(path, cx) {
    this.runAction(() => gitUnstageFile(this.repoRoot(), this.on, path), null, cx);
  }

  doDiscard(path, fresh, cx) {
    this.runAction(() => gitDiscardFile(this.repoRoot(), this.on, path, fresh), null, cx);
  }

  doStageAll(cx) {
    this.runAction(() => gitStageAll(this.repoRoot(), this.on), null, cx);
  }

  doUnstageAll(cx) {
    this.runAction(() => gitUnstageAll(this.repoRoot(), this.on), null, cx);
  }

  doCommit(cx) {
    const msg = this.message.trim();
    if (!msg) return;
    const stagedCount = this.status?.stagedFiles?.length || 0;
    const unstagedCount = this.status?.unstagedFiles?.length || 0;
    if (stagedCount === 0 && unstagedCount === 0) return;

    const root = this.repoRoot();
    const on = this.on;
    this.runAction(async () => {
      if (this.status?.stagedFiles?.length === 0) {
        const stageRes = await gitStageAll(root, on);
        if (stageRes.code !== 0) return stageRes;
      }
      return gitCommit(root, on, msg);
    }, "Commit successful", cx);

    this.message = "";
    this.input.set_value("");
    cx?.notify?.();
  }

  doPush(cx) {
    this.runAction(() => gitPush(this.repoRoot(), this.on), "Pushed to remote", cx);
  }

  doPull(cx) {
    this.runAction(() => gitPull(this.repoRoot(), this.on), "Pulled from remote", cx);
  }

  doFetch(cx) {
    this.runAction(() => gitFetch(this.repoRoot(), this.on), "Fetched remote", cx);
  }

  doStash(cx) {
    this.runAction(() => gitStash(this.repoRoot(), this.on, "Herdr stash"), "Stashed current changes", cx);
  }

  doStashPop(cx) {
    this.runAction(() => gitStashPop(this.repoRoot(), this.on), "Applied stashed changes", cx);
  }

  doStashApply(stashId, cx) {
    this.runAction(() => gitStashApply(this.repoRoot(), this.on, stashId), `Applied ${stashId}`, cx);
  }

  doStashDrop(stashId, cx) {
    this.runAction(() => gitStashDrop(this.repoRoot(), this.on, stashId), `Dropped ${stashId}`, cx);
  }

  doCheckout(branch, cx) {
    this.runAction(() => gitCheckout(this.repoRoot(), this.on, branch), `Checked out ${branch}`, cx);
  }

  switchGitMode(mode, cx) {
    if (this.gitMode === mode) return;
    this.gitMode = mode;
    cx?.notify?.();
    if (mode === "github") {
      this.fetchGithubData(cx);
    }
  }

  resolveGithubProbePath() {
    const h = appHome();
    return `${h}/mods/enhanced-git/probe.py`;
  }

  async runGithubProbe(args) {
    const script = this.resolveGithubProbePath();
    const loc = resolveLocation();
    const dir = this.repoRoot() || loc?.cwd || "";
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

  applyGithubData(data) {
    this.githubStatus = data;
    this.githubPrs = data.prs || [];
    this.githubRuns = data.runs || [];
    this.githubIssues = data.issues || [];
  }

  fetchGithubData(cx, force = false) {
    const loc = resolveLocation();
    const cacheKey = this.cwd || loc?.cwd || "";
    const now = Date.now();
    const cached = this.githubCache.get(cacheKey);

    if (!force && cached && now - cached.time < 60000) {
      this.applyGithubData(cached.data);
      return Promise.resolve(cached.data);
    }

    if (this.githubLoading && !force) {
      return Promise.resolve(this.githubStatus);
    }

    this.githubLoading = true;
    this.githubError = null;

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) {
      this.githubLoading = false;
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      spawnCx.spawn(async (scx) => {
        try {
          const data = await this.runGithubProbe(["--action", "bundle"]);
          if (data.ok || data.hasRepo) {
            this.githubCache.set(cacheKey, { data, time: Date.now() });
            this.applyGithubData(data);
          } else {
            this.githubStatus = data;
          }
          resolve(data);
        } catch (e) {
          this.githubError = e.message || String(e);
          resolve(null);
        } finally {
          this.githubLoading = false;
          scx.notify();
        }
      });
    });
  }

  fetchGithubStatus(cx, force = false) {
    return this.fetchGithubData(cx, force);
  }

  fetchGithubActiveTab(cx, force = false) {
    return this.fetchGithubData(cx, force);
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
    } else if (typeof this.asyncCx?.write_to_clipboard === "function") {
      this.asyncCx.write_to_clipboard(text);
    } else {
      exec("sh", ["-c", `printf "%s" "$1" | pbcopy`, "_", text]).catch(() => {});
    }
    this.githubAgentPrompt = `Copied ${label} to clipboard`;
    cx?.notify?.();
  }

  reviewPrWithAgent(pr, cx) {
    this.githubInflightAction = `pr-${pr.number}`;
    cx?.notify?.();

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return Promise.resolve();

    return new Promise((resolve) => {
      spawnCx.spawn(async (scx) => {
        try {
          const diffData = await this.runGithubProbe(["--action", "pr-diff", "--pr", String(pr.number)]);
          const diffSnippet = diffData.diff ? `\n\n\`\`\`diff\n${diffData.diff}\n\`\`\`` : "";
          const prompt =
            `Please review Pull Request #${pr.number}: "${pr.title}" (branch: ${pr.headRefName}) from ${pr.author?.login}.\n` +
            `Check for potential bugs, security concerns, test coverage, and code quality.${diffSnippet}`;

          this.copyGithubText(prompt, `PR #${pr.number} Review Prompt`, scx);
        } catch (e) {
          this.githubError = `Failed to prepare PR review: ${e.message}`;
        } finally {
          this.githubInflightAction = null;
          scx.notify();
          resolve();
        }
      });
    });
  }

  fixCiWithAgent(run, cx) {
    this.githubInflightAction = `run-${run.databaseId}`;
    cx?.notify?.();

    const spawnCx = cx?.spawn ? cx : this.asyncCx;
    if (!spawnCx?.spawn) return Promise.resolve();

    return new Promise((resolve) => {
      spawnCx.spawn(async (scx) => {
        try {
          const logData = await this.runGithubProbe(["--action", "failed-log", "--run-id", String(run.databaseId)]);
          const failedLog = logData.log ? `\n\n\`\`\`\n${logData.log}\n\`\`\`` : "";
          const prompt =
            `GitHub Actions workflow "${run.workflowName || run.name}" failed on branch "${run.headBranch}" (Run ID: ${run.databaseId}).\n` +
            `Here is the failed log output:${failedLog}\n\nPlease analyze the root cause and fix the failing code.`;

          this.copyGithubText(prompt, `CI Fix Prompt (#${run.databaseId})`, scx);
        } catch (e) {
          this.githubError = `Failed to get failed CI log: ${e.message}`;
        } finally {
          this.githubInflightAction = null;
          scx.notify();
          resolve();
        }
      });
    });
  }

  startIssueWithAgent(issue, cx) {
    const prompt =
      `Please work on GitHub Issue #${issue.number}: "${issue.title}".\n` +
      `URL: ${issue.url}\n` +
      `Please create an appropriate feature/fix branch, implement the required changes, and verify with tests.`;

    this.copyGithubText(prompt, `Issue #${issue.number} Task Prompt`, cx);
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
        props: { role: "dialog", mode: this.gitMode, tab: this.tab },
      },
      width: 1000,
      height: 680,
    });
    setShared(OVERLAY_KEY, { overlay: id });
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  renderDiffRow(row, t) {
    if (row.kind === "@") {
      return div()
        .w_full()
        .h(20)
        .flex_none()
        .px(10)
        .bg(t.raised)
        .text_size(11)
        .font_family(settings()?.font_family ?? "JetBrains Mono")
        .text_color(t.dim)
        .truncate()
        .child(row.text);
    }
    const isAdd = row.kind === "+";
    const isDel = row.kind === "-";
    const bg = isAdd ? t.ansi2 + "1c" : isDel ? t.ansi1 + "1c" : "transparent";
    const color = isAdd ? t.ansi2 : isDel ? t.ansi1 : t.foreground;

    return h_flex()
      .w_full()
      .h(20)
      .flex_none()
      .px(8)
      .gap(8)
      .when(bg !== "transparent", (el) => el.bg(bg))
      .child(
        div()
          .w(28)
          .flex_none()
          .text_size(10.5)
          .text_color(t.dim)
          .text_right()
          .child(row.number === undefined ? "" : String(row.number))
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .text_size(11.5)
          .font_family(settings()?.font_family ?? "JetBrains Mono")
          .text_color(color)
          .truncate()
          .child(row.text || " ")
      );
  }

  renderDiffViewport(listId, rows, t) {
    if (typeof v_virtual_list === "function" && rows.length > 40) {
      return v_virtual_list(
        listId,
        rows.length,
        20,
        (i) => String(i),
        (range) => rows.slice(range.start, range.end).map((r) => this.renderDiffRow(r, t))
      ).size_full();
    }
    return v_flex()
      .id(listId)
      .size_full()
      .min_h(0)
      .overflow_y_scrollbar()
      .children(rows.map((r) => this.renderDiffRow(r, t)));
  }

  // --- View: Changes Tab (Fork Working Copy Style) ---
  renderChangesTab(t) {
    const status = this.status;
    const staged = status?.stagedFiles || [];
    const unstaged = status?.unstagedFiles || [];
    const canCommit = staged.length > 0 || unstaged.length > 0;

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(8)
      // Top File Lists: Staged & Unstaged Changes
      .child(
        v_flex()
          .id("git-files-list")
          .h(220)
          .flex_none()
          .gap(8)
          .overflow_y_scrollbar()
          // Section 1: Staged Changes
          .child(
            v_flex()
              .gap(3)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .px(4)
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(10.5).font_bold().text_color(t.dim).child("STAGED"))
                      .child(
                        div()
                          .px(5)
                          .py(0.5)
                          .rounded(8)
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
                    .id(`staged-${f.path}`)
                    .h(26)
                    .flex_none()
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(this.selectedFile === f.path && this.selectedIsStaged, (el) => el.bg(t.selected))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.selectFile(f.path, true, cx, false))
                    .child(div().w(14).text_size(10.5).font_semibold().text_color(t.ansi2).child(f.status))
                    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).truncate().child(f.path))
                    .when(f.add > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
                    .child(
                      div()
                        .size(20)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .hover((s) => s.bg(t.raised).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.doUnstage(f.path, cx);
                        })
                        .child(icon("minus", 12))
                    )
                )
              )
              .when(staged.length === 0, (el) =>
                el.child(div().px(6).py(2).text_size(11).text_color(t.dim).child("No staged changes"))
              )
          )
          // Section 2: Unstaged Changes
          .child(
            v_flex()
              .gap(3)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .px(4)
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(div().text_size(10.5).font_bold().text_color(t.dim).child("CHANGES"))
                      .child(
                        div()
                          .px(5)
                          .py(0.5)
                          .rounded(8)
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
                    .id(`unstaged-${f.path}`)
                    .h(26)
                    .flex_none()
                    .px(6)
                    .gap(6)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(this.selectedFile === f.path && !this.selectedIsStaged, (el) => el.bg(t.selected))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.selectFile(f.path, false, cx, Boolean(f.fresh)))
                    .child(
                      div()
                        .w(14)
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(f.fresh ? t.ansi2 : f.status === "D" ? t.ansi1 : "#f59e0b")
                        .child(f.fresh ? "U" : f.status)
                    )
                    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).truncate().child(f.path))
                    .when(f.add > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
                    .when(f.del > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
                    .child(
                      div()
                        .size(20)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .hover((s) => s.bg(t.raised).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.doStage(f.path, cx);
                        })
                        .child(icon("plus", 12))
                    )
                    .child(
                      div()
                        .size(20)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .hover((s) => s.bg(t.raised).text_color(t.ansi1))
                        .text_color(t.dim)
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.doDiscard(f.path, f.fresh, cx);
                        })
                        .child(icon("x", 12))
                    )
                )
              )
              .when(unstaged.length === 0, (el) =>
                el.child(div().px(6).py(2).text_size(11).text_color(t.dim).child("Working tree clean"))
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
          .child(
            h_flex()
              .h(26)
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
          .child(
            this.selectedFile
              ? div()
                  .flex_1()
                  .min_h(0)
                  .child(this.renderDiffViewport("git-changes-diff", this.diffRows, t))
              : v_flex()
                  .flex_1()
                  .min_h(0)
                  .items_center()
                  .justify_center()
                  .gap(4)
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
                      .child(canCommit ? "Click any file above" : "No uncommitted changes")
                  )
          )
      )
      .when(Boolean(this.note), (el) =>
        el.child(div().px(4).text_size(11).text_color(t.accent).truncate().child(this.note))
      )
      // Commit Input Row
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .gap(8)
          .items_center()
          .child(
            div()
              .id("git-commit-input")
              .flex_1()
              .min_w(0)
              .h(32)
              .px(10)
              .flex()
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))
          )
          .child(
            div()
              .id("git-commit-btn")
              .h(32)
              .px(14)
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .bg(canCommit ? t.accent : t.raised)
              .text_color(canCommit ? t.background : t.dim)
              .text_size(11.5)
              .font_semibold()
              .when(canCommit, (el) =>
                el
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => this.doCommit(cx))
              )
              .child(this.busy ? "Working…" : "Commit")
          )
      );
  }

  // --- View: Subway Git Graph ---
  renderGraphTab(t) {
    if (this.graphLoading && (!this.graphRows || this.graphRows.length === 0)) {
      return v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap(8)
        .child(icon("spinner", 16).text_color(t.accent).spin(900))
        .child(div().text_size(12).text_color(t.dim).child("Loading commit history…"));
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
          h_flex()
            .px(10)
            .py(4)
            .gap(6)
            .items_center()
            .rounded(5)
            .bg(t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .text_size(11)
            .text_color(t.foreground)
            .on_click((_e, cx) => this.fetchGraph(cx))
            .child(icon("refresh", 12))
            .child("Retry")
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
          h_flex()
            .px(10)
            .py(4)
            .gap(6)
            .items_center()
            .rounded(5)
            .bg(t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .text_size(11)
            .text_color(t.foreground)
            .on_click((_e, cx) => this.fetchGraph(cx))
            .child(icon("refresh", 12))
            .child("Refresh")
        );
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(8)
      .child(
        v_flex()
          .id("git-graph-list")
          .flex_1()
          .min_h(0)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .rounded(6)
          .overflow_y_scrollbar()
          .p(6)
          .gap(2)
          .children(
            rows.map((row, idx) => {
              const isSelected = this.selectedCommit?.hash === row.hash;
              const color = TRACK_COLORS[idx % TRACK_COLORS.length];

              if (!row.isCommit) {
                return h_flex()
                  .h(16)
                  .flex_none()
                  .px(6)
                  .child(
                    div()
                      .font_family(settings()?.font_family ?? "JetBrains Mono")
                      .text_size(11)
                      .text_color(t.dim)
                      .child(row.graph)
                  );
              }

              const isMerge = row.parents && row.parents.length > 1;
              const isHeadCommit = (row.refs || []).some((r) => r.includes("HEAD"));
              const badges = row.badges || (row.refs || []).map(parseRefBadge);

              return h_flex()
                .id(`commit-${row.hash}`)
                .h(28)
                .flex_none()
                .px(6)
                .gap(6)
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .when(isSelected, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.selectCommit(row, cx))
                .child(
                  h_flex()
                    .flex_none()
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .size(8)
                        .rounded_full()
                        .bg(isHeadCommit ? t.accent : color)
                        .when(isMerge, (el) => el.border_1().border_color(t.foreground))
                    )
                    .child(
                      div()
                        .flex_none()
                        .font_family(settings()?.font_family ?? "JetBrains Mono")
                        .text_size(10.5)
                        .text_color(t.dim)
                        .child(row.hash)
                    )
                )
                .children(
                  badges.slice(0, 2).map((b) => {
                    const badgeIcon = b.type === "tag" ? "tag" : b.type === "remote" ? "cloud" : "git-branch";
                    const badgeColor = b.isHead
                      ? t.accent
                      : b.type === "tag"
                      ? "#fbbf24"
                      : b.type === "remote"
                      ? t.muted
                      : color;
                    return h_flex()
                      .flex_none()
                      .px(5)
                      .py(1)
                      .gap(3)
                      .items_center()
                      .rounded(6)
                      .bg(t.raised)
                      .border_1()
                      .border_color(t.border)
                      .text_size(9.5)
                      .font_medium()
                      .text_color(badgeColor)
                      .child(icon(badgeIcon, 10).text_color(badgeColor))
                      .child(div().max_w(90).truncate().child(b.label));
                  })
                )
                .when(badges.length > 2, (el) =>
                  el.child(
                    div()
                      .flex_none()
                      .px(4)
                      .py(0.5)
                      .rounded(6)
                      .bg(t.raised)
                      .text_size(9.5)
                      .text_color(t.dim)
                      .child(`+${badges.length - 2}`)
                  )
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(60)
                    .text_size(11.5)
                    .text_color(t.foreground)
                    .truncate()
                    .child(row.subject)
                )
                .when(this.role === "dialog", (el) =>
                  el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(row.author))
                )
                .child(div().flex_none().text_size(10).text_color(t.dim).child(row.relDate));
            })
          )
          .child(
            h_flex()
              .h(30)
              .flex_none()
              .items_center()
              .justify_center()
              .child(
                h_flex()
                  .px(12)
                  .py(3)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .text_size(11)
                  .text_color(t.foreground)
                  .on_click((_e, cx) => {
                    this.graphLimit += 50;
                    this.fetchGraph(cx);
                  })
                  .child(icon("arrow-down", 11))
                  .child("Load 50 more")
              )
          )
      )
      .when(Boolean(this.selectedCommit), (el) =>
        el.child(
          v_flex()
            .h(200)
            .flex_none()
            .p(8)
            .gap(6)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .rounded(6)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .font_family(settings()?.font_family ?? "JetBrains Mono")
                        .text_size(10)
                        .text_color(t.accent)
                        .child(this.selectedCommit?.hash || "")
                    )
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .text_size(11.5)
                        .font_semibold()
                        .text_color(t.foreground)
                        .truncate()
                        .child(this.selectedCommit?.subject || "")
                    )
                )
                .child(
                  div()
                    .size(20)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .hover((s) => s.bg(t.hover))
                    .cursor_pointer()
                    .text_color(t.dim)
                    .on_click((_e, cx) => {
                      this.selectedCommit = null;
                      cx.notify();
                    })
                    .child(icon("x", 12))
                )
            )
            .child(
              h_flex()
                .flex_1()
                .min_h(0)
                .gap(6)
                .child(
                  v_flex()
                    .id("git-commit-files")
                    .w(150)
                    .min_h(0)
                    .bg(t.background)
                    .rounded(4)
                    .overflow_y_scrollbar()
                    .children(
                      this.commitFiles.map((f) =>
                        h_flex()
                          .id(`cfile-${f.path}`)
                          .h(24)
                          .px(6)
                          .gap(4)
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
                  div()
                    .flex_1()
                    .min_w(0)
                    .bg(t.background)
                    .rounded(4)
                    .overflow_hidden()
                    .child(this.renderDiffViewport("git-commit-diff", this.commitDiffRows, t))
                )
            )
        )
      );
  }

  // --- View: Branches Tab ---
  renderBranchesTab(t) {
    const branches = this.refs?.branches || [];
    const remotes = this.refs?.remotes || [];
    const tags = this.refs?.tags || [];

    return v_flex()
      .id("git-branches-list")
      .size_full()
      .min_h(0)
      .gap(12)
      .overflow_y_scrollbar()
      .p(4)
      // Local Branches
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(10.5).font_bold().text_color(t.dim).child("LOCAL BRANCHES"))
              .child(
                div()
                  .px(5)
                  .py(0.5)
                  .rounded(8)
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
                .id(`branch-${b.name}`)
                .h(28)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(5)
                .when(b.isCurrent, (el) => el.bg(t.raised))
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon("git-branch", 12).text_color(b.isCurrent ? t.accent : t.dim))
                    .child(
                      div()
                        .text_size(11.5)
                        .when(b.isCurrent, (el) => el.font_semibold().text_color(t.foreground))
                        .when(!b.isCurrent, (el) => el.text_color(t.muted))
                        .truncate()
                        .child(b.name)
                    )
                    .when(b.isCurrent, (el) =>
                      el.child(
                        div()
                          .px(5)
                          .py(0.5)
                          .rounded(6)
                          .bg(t.accent + "26")
                          .text_size(9.5)
                          .font_semibold()
                          .text_color(t.accent)
                          .child("HEAD")
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
                      .px(7)
                      .py(2)
                      .rounded(4)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.raised))
                      .cursor_pointer()
                      .text_size(10.5)
                      .text_color(t.foreground)
                      .on_click((_e, cx) => this.doCheckout(b.name, cx))
                      .child("Checkout")
                  )
                )
            )
          )
      )
      // Remote Branches
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(10.5).font_bold().text_color(t.dim).child("REMOTES"))
              .child(
                div()
                  .px(5)
                  .py(0.5)
                  .rounded(8)
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
                .id(`remote-${r.name}`)
                .h(26)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(5)
                .hover((s) => s.bg(t.hover))
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon("cloud", 12).text_color(t.dim))
                    .child(div().text_size(11.5).text_color(t.muted).truncate().child(r.name))
                )
                .child(
                  div()
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.surface)
                    .hover((s) => s.bg(t.raised))
                    .cursor_pointer()
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .on_click((_e, cx) => this.doCheckout(r.name, cx))
                    .child("Checkout")
                )
            )
          )
      )
      // Tags
      .child(
        v_flex()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .px(4)
              .child(div().text_size(10.5).font_bold().text_color(t.dim).child("TAGS"))
              .child(
                div()
                  .px(5)
                  .py(0.5)
                  .rounded(8)
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
                .id(`tag-${tag.name}`)
                .h(24)
                .flex_none()
                .px(8)
                .gap(6)
                .items_center()
                .rounded(5)
                .hover((s) => s.bg(t.hover))
                .child(icon("tag", 11).text_color("#f59e0b"))
                .child(div().text_size(11.5).text_color(t.foreground).truncate().child(tag.name))
            )
          )
      );
  }

  // --- View: Stashes Tab ---
  renderStashesTab(t) {
    const stashes = this.refs?.stashes || [];

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(8)
      .p(4)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .px(4)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(10.5).font_bold().text_color(t.dim).child("STASHES"))
              .child(
                div()
                  .px(5)
                  .py(0.5)
                  .rounded(8)
                  .bg(t.raised)
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.muted)
                  .child(String(stashes.length))
              )
          )
          .child(
            h_flex()
              .px(8)
              .py(3)
              .gap(4)
              .items_center()
              .rounded(4)
              .bg(t.raised)
              .hover((s) => s.bg(t.hover))
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .text_color(t.foreground)
              .on_click((_e, cx) => this.doStash(cx))
              .child(icon("plus", 11))
              .child("Stash Changes")
          )
      )
      .child(
        v_flex()
          .id("git-stashes-list")
          .flex_1()
          .min_h(0)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            stashes.map((s) =>
              h_flex()
                .id(`stash-${s.id}`)
                .h(32)
                .flex_none()
                .px(8)
                .gap(8)
                .items_center()
                .justify_between()
                .rounded(5)
                .bg(t.surface)
                .hover((st) => st.bg(t.hover))
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon("archive", 12).text_color(t.dim))
                    .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(s.id))
                    .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(s.message))
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
                        .hover((st) => st.bg(t.hover))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.doStashApply(s.id, cx))
                        .child("Apply")
                    )
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.raised)
                        .hover((st) => st.bg(t.hover))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.doStashPop(cx))
                        .child("Pop")
                    )
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .hover((st) => st.bg(t.raised))
                        .cursor_pointer()
                        .text_size(10.5)
                        .text_color(t.ansi1)
                        .on_click((_e, cx) => this.doStashDrop(s.id, cx))
                        .child("Drop")
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
                .child(icon("archive", 18).text_color(t.dim))
                .child(div().text_size(12).text_color(t.dim).child("No stashes saved"))
            )
          )
      );
  }

  // --- Header (Single Unified 2-Row Layout) ---
  renderHeader(t) {
    const status = this.status;
    const branch = status?.branch || "main";
    const ahead = status?.ahead || 0;
    const behind = status?.behind || 0;
    const stagedCount = status?.stagedFiles?.length || 0;
    const unstagedCount = status?.unstagedFiles?.length || 0;
    const totalChanges = stagedCount + unstagedCount;
    const prCount = this.githubStatus?.prs_count ?? 0;
    const issueCount = this.githubStatus?.issues_count ?? 0;
    const isBusy = this.loading || this.githubLoading || this.busy;

    return v_flex()
      .w_full()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      // Row 0: Segmented Mode Switcher + Context Info + Tool Icons
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .justify_between()
          .bg(t.chrome ?? t.surface)
          .border_b(1)
          .border_color(t.border)
          // Left: Segmented Control [ Local | GitHub ]
          .child(
            h_flex()
              .p(2)
              .gap(2)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .items_center()
              .child(
                h_flex()
                  .id("mode-local")
                  .px(8)
                  .py(2.5)
                  .gap(5)
                  .items_center()
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.gitMode === "local", (el) => el.bg(t.raised).text_color(t.foreground).font_semibold())
                  .when(this.gitMode !== "local", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
                  .text_size(11)
                  .on_click((_e, cx) => this.switchGitMode("local", cx))
                  .child(icon("git-branch", 12).text_color(this.gitMode === "local" ? t.accent : t.dim))
                  .child("Local")
              )
              .child(
                h_flex()
                  .id("mode-github")
                  .px(8)
                  .py(2.5)
                  .gap(5)
                  .items_center()
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.gitMode === "github", (el) => el.bg(t.raised).text_color(t.foreground).font_semibold())
                  .when(this.gitMode !== "github", (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
                  .text_size(11)
                  .on_click((_e, cx) => this.switchGitMode("github", cx))
                  .child(icon("github", 12).text_color(this.gitMode === "github" ? t.accent : t.dim))
                  .child("GitHub")
                  .when(Boolean(prCount + issueCount > 0), (el) =>
                    el.child(
                      div()
                        .px(4)
                        .py(0.2)
                        .rounded(6)
                        .bg(this.gitMode === "github" ? t.accent : t.raised)
                        .text_size(9)
                        .font_bold()
                        .text_color(this.gitMode === "github" ? t.background : t.muted)
                        .child(String(prCount + issueCount))
                    )
                  )
              )
          )
          // Right: Context Pill + Action Buttons
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .min_w(0)
              .when(this.gitMode === "local" && Boolean(status?.isRepo), (el) =>
                el
                  .child(
                    h_flex()
                      .gap(4)
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.raised)
                      .items_center()
                      .child(icon("git-branch", 11).text_color(t.accent))
                      .child(div().text_size(10.5).font_medium().text_color(t.foreground).max_w(95).truncate().child(branch))
                      .when(ahead > 0, (b) => b.child(div().text_size(10).font_semibold().text_color(t.accent).child(`↑${ahead}`)))
                      .when(behind > 0, (b) => b.child(div().text_size(10).font_semibold().text_color("#f59e0b").child(`↓${behind}`)))
                  )
                  .child(
                    h_flex()
                      .id("git-pull-btn")
                      .px(5)
                      .py(2)
                      .gap(2)
                      .items_center()
                      .rounded(4)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .text_size(10)
                      .text_color(t.muted)
                      .on_click((_e, cx) => this.doPull(cx))
                      .child(icon("arrow-down", 10))
                      .child("Pull")
                  )
                  .child(
                    h_flex()
                      .id("git-push-btn")
                      .px(5)
                      .py(2)
                      .gap(2)
                      .items_center()
                      .rounded(4)
                      .bg(t.surface)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .text_size(10)
                      .text_color(t.muted)
                      .on_click((_e, cx) => this.doPush(cx))
                      .child(icon("arrow-up", 10))
                      .child("Push")
                  )
              )
              .when(this.gitMode === "github" && Boolean(this.githubStatus?.repo), (el) =>
                el
                  .child(
                    div()
                      .max_w(140)
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.raised)
                      .text_size(10.5)
                      .font_medium()
                      .text_color(t.muted)
                      .truncate()
                      .child(this.githubStatus.repo)
                  )
                  .when(Boolean(this.githubStatus?.url), (w) =>
                    w.child(
                      div()
                        .id("gh-open-web")
                        .size(22)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click(() => exec("open", [this.githubStatus.url]))
                        .child(icon("external-link", 12))
                    )
                  )
              )
              // Refresh Button
              .child(
                div()
                  .id("git-refresh-btn")
                  .size(22)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .text_color(t.dim)
                  .on_click((_e, cx) => {
                    if (this.gitMode === "github") {
                      this.fetchGithubData(cx, true);
                    } else {
                      this.refresh(cx, true);
                    }
                  })
                  .child(isBusy ? icon("spinner", 12).text_color(t.accent).spin(900) : icon("refresh", 12))
              )
              // Expand / Close Dialog Button
              .when(this.role === "panel", (el) =>
                el.child(
                  div()
                    .id("git-expand-btn")
                    .size(22)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .text_color(t.dim)
                    .on_click(() => this.openOverlayDialog())
                    .child(icon("maximize", 12))
                )
              )
              .when(this.role === "dialog", (el) =>
                el.child(
                  div()
                    .id("git-close-btn")
                    .size(22)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .text_color(t.dim)
                    .on_click(() => this.close())
                    .child(icon("x", 13))
                )
              )
          )
      )
      // Row 1: Single Sub-Navigation Tab Bar
      .child(
        this.gitMode === "local"
          ? this.renderLocalSubNav(t, totalChanges)
          : this.renderGithubSubNav(t, prCount, issueCount)
      );
  }

  renderLocalSubNav(t, totalChanges) {
    const navTab = (key, label, badge = 0) => {
      const active = this.tab === key;
      return h_flex()
        .id(`local-tab-${key}`)
        .px(8)
        .py(3)
        .gap(4)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .when(active, (el) => el.bg(t.raised).text_color(t.foreground).font_semibold())
        .when(!active, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
        .text_size(11)
        .on_click((_e, cx) => {
          if (this.tab !== key) {
            this.tab = key;
            cx.notify();
            if (key === "graph" && (!this.graphRows || this.graphRows.length === 0)) {
              this.fetchGraph(cx);
            } else if ((key === "branches" || key === "stashes") && (!this.refs?.branches || this.refs.branches.length === 0)) {
              this.fetchRefs(cx);
            }
          }
        })
        .child(label)
        .when(badge > 0, (el) =>
          el.child(
            div()
              .px(4)
              .py(0.2)
              .rounded(6)
              .bg(active ? t.accent : t.surface)
              .text_size(9)
              .font_bold()
              .text_color(active ? t.background : t.muted)
              .child(String(badge))
          )
        );
    };

    return h_flex()
      .h(30)
      .flex_none()
      .px(8)
      .gap(4)
      .items_center()
      .child(navTab("changes", "Changes", totalChanges))
      .child(navTab("graph", "Graph"))
      .child(navTab("branches", "Branches"))
      .child(navTab("stashes", "Stashes"));
  }

  renderGithubSubNav(t, prCount, issueCount) {
    const subTab = (key, iconName, label, badge) => {
      const active = this.githubActiveTab === key;
      return h_flex()
        .id(`gh-tab-${key}`)
        .px(8)
        .py(3)
        .gap(5)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .when(active, (el) => el.bg(t.raised).text_color(t.foreground).font_semibold())
        .when(!active, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
        .text_size(11)
        .on_click((_e, cx) => this.switchGithubSubTab(key, cx))
        .child(icon(iconName, 12).text_color(active ? t.accent : t.dim))
        .child(label)
        .when(badge !== null && badge !== undefined && badge > 0, (el) =>
          el.child(
            div()
              .px(4)
              .py(0.2)
              .rounded(6)
              .bg(active ? t.accent : t.surface)
              .text_size(9)
              .font_bold()
              .text_color(active ? t.background : t.muted)
              .child(String(badge))
          )
        );
    };

    return h_flex()
      .h(30)
      .flex_none()
      .px(8)
      .gap(4)
      .items_center()
      .child(subTab("prs", "git-pull-request", "Pull Requests", prCount))
      .child(subTab("runs", "play", "Actions CI", null))
      .child(subTab("issues", "circle-dot", "Issues", issueCount));
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
        el.on_key_down((e, kcx) => {
          if (e.key === "escape") {
            this.close();
            kcx.stop_propagation();
          }
        })
      )
      .child(this.renderHeader(t))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(8)
          .child(
            this.gitMode === "github"
              ? this.renderGitHubTab(t)
              : this.error
              ? this.renderLocalErrorState(t)
              : this.tab === "changes"
              ? this.renderChangesTab(t)
              : this.tab === "graph"
              ? this.renderGraphTab(t)
              : this.tab === "branches"
              ? this.renderBranchesTab(t)
              : this.renderStashesTab(t)
          )
      );
  }

  renderLocalErrorState(t) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .gap(8)
      .child(icon("git-branch", 20).text_color(t.dim))
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).child("Not a Git Repository"))
      .child(div().text_size(11).text_color(t.dim).child(String(this.error)))
      .child(
        h_flex()
          .px(10)
          .py(4)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .bg(t.raised)
          .hover((s) => s.bg(t.hover))
          .text_size(11)
          .text_color(t.foreground)
          .on_click((_e, cx) => this.refresh(cx, true))
          .child(icon("refresh", 12))
          .child("Retry")
      );
  }

  renderGitHubTab(t) {
    const hasRepo = Boolean(this.githubStatus && this.githubStatus.hasRepo);

    return v_flex()
      .size_full()
      .min_h(0)
      .gap(8)
      // Agent prompt notification banner
      .when(Boolean(this.githubAgentPrompt), (el) =>
        el.child(
          h_flex()
            .px(10)
            .py(6)
            .rounded(5)
            .items_center()
            .justify_between()
            .bg(t.selected ?? t.raised)
            .border_1()
            .border_color(t.accent)
            .child(
              h_flex()
                .flex_1()
                .min_w(0)
                .gap(6)
                .items_center()
                .child(icon("check", 12).text_color(t.accent))
                .child(
                  div()
                    .text_size(11)
                    .font_medium()
                    .text_color(t.foreground)
                    .truncate()
                    .child(`${this.githubAgentPrompt} — paste into Agent terminal`)
                )
            )
            .child(
              div()
                .size(18)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.githubAgentPrompt = null;
                  cx.notify();
                })
                .child(icon("x", 11))
            )
        )
      )
      // Content Area (Single layer, scrollable with stable ID)
      .child(
        v_flex()
          .id("git-github-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(this.githubLoading && !hasRepo, (el) =>
            el.child(
              v_flex()
                .size_full()
                .py(40)
                .items_center()
                .justify_center()
                .gap(8)
                .child(icon("spinner", 18).text_color(t.accent).spin(900))
                .child(div().text_size(12).text_color(t.dim).child("Loading GitHub repository data…"))
            )
          )
          .when(!this.githubLoading && Boolean(this.githubError), (el) =>
            el.child(
              v_flex()
                .size_full()
                .py(30)
                .items_center()
                .justify_center()
                .gap(8)
                .child(div().text_size(12).font_medium().text_color(t.ansi1).child("Failed to load GitHub data"))
                .child(div().text_size(11).text_color(t.dim).child(String(this.githubError)))
                .child(
                  h_flex()
                    .px(10)
                    .py(4)
                    .gap(5)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .bg(t.raised)
                    .hover((s) => s.bg(t.hover))
                    .text_size(11)
                    .text_color(t.foreground)
                    .on_click((_e, cx) => this.fetchGithubData(cx, true))
                    .child(icon("refresh", 12))
                    .child("Retry")
                )
            )
          )
          .when(!this.githubLoading && !this.githubError && !hasRepo, (el) =>
            el.child(
              v_flex()
                .size_full()
                .py(40)
                .items_center()
                .justify_center()
                .gap(8)
                .child(icon("github", 20).text_color(t.dim))
                .child(div().text_size(12).font_medium().text_color(t.foreground).child("No GitHub Remote Found"))
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(this.githubStatus?.error || "Current workspace is not linked to a GitHub repository.")
                )
                .child(
                  h_flex()
                    .px(10)
                    .py(4)
                    .gap(5)
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .bg(t.raised)
                    .hover((s) => s.bg(t.hover))
                    .text_size(11)
                    .text_color(t.foreground)
                    .on_click((_e, cx) => this.fetchGithubData(cx, true))
                    .child(icon("refresh", 12))
                    .child("Reload")
                )
            )
          )
          .when(hasRepo && !this.githubError, (el) => {
            if (this.githubActiveTab === "prs") return el.child(this.renderGithubPrs(t));
            if (this.githubActiveTab === "runs") return el.child(this.renderGithubRuns(t));
            if (this.githubActiveTab === "issues") return el.child(this.renderGithubIssues(t));
            return el;
          })
      );
  }

  renderGithubPrs(t) {
    if (!this.githubPrs || this.githubPrs.length === 0) {
      const issueCount = this.githubIssues?.length || this.githubStatus?.issues_count || 0;
      return v_flex()
        .size_full()
        .py(36)
        .items_center()
        .justify_center()
        .gap(8)
        .child(icon("git-pull-request", 20).text_color(t.dim))
        .child(div().text_size(12).font_medium().text_color(t.foreground).child("No open pull requests"))
        .when(issueCount > 0, (el) =>
          el.child(
            h_flex()
              .cursor_pointer()
              .px(10)
              .py(4)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(t.raised)
              .hover((s) => s.bg(t.hover))
              .text_size(11)
              .text_color(t.accent)
              .on_click((_e, cx) => this.switchGithubSubTab("issues", cx))
              .child(icon("circle-dot", 12).text_color(t.accent))
              .child(`View ${issueCount} open issues`)
          )
        );
    }

    return v_flex()
      .gap(6)
      .children(
        this.githubPrs.map((pr) => {
          const isInflight = this.githubInflightAction === `pr-${pr.number}`;
          return v_flex()
            .id(`gh-pr-${pr.number}`)
            .p(8)
            .gap(5)
            .rounded(6)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon("git-pull-request", 13).text_color(t.accent))
                    .child(div().text_size(11.5).font_bold().text_color(t.accent).child(`#${pr.number}`))
                    .child(div().flex_1().min_w(0).text_size(11.5).font_medium().text_color(t.foreground).truncate().child(pr.title))
                )
                .child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .child(
                      h_flex()
                        .px(6)
                        .py(2)
                        .gap(4)
                        .items_center()
                        .rounded(4)
                        .cursor_pointer()
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover))
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.reviewPrWithAgent(pr, cx))
                        .child(isInflight ? icon("spinner", 11).spin(900) : icon("sparkles", 11).text_color(t.accent))
                        .child("Review")
                    )
                    .child(
                      div()
                        .size(22)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click(() => exec("open", [pr.url]))
                        .child(icon("external-link", 11))
                    )
                )
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .text_size(10.5)
                .text_color(t.dim)
                .child(`by ${pr.author?.login || "unknown"}`)
                .child(
                  h_flex()
                    .gap(3)
                    .items_center()
                    .child(icon("git-branch", 10).text_color(t.dim))
                    .child(div().max_w(140).truncate().child(pr.headRefName || ""))
                )
                .child(
                  h_flex()
                    .gap(4)
                    .child(div().text_color(t.ansi2).child(`+${pr.additions || 0}`))
                    .child(div().text_color(t.ansi1).child(`−${pr.deletions || 0}`))
                )
            );
        })
      );
  }

  renderGithubRuns(t) {
    if (!this.githubRuns || this.githubRuns.length === 0) {
      return v_flex()
        .size_full()
        .py(36)
        .items_center()
        .justify_center()
        .gap(8)
        .child(icon("play", 20).text_color(t.dim))
        .child(div().text_size(12).text_color(t.dim).child("No recent workflow runs"));
    }

    return v_flex()
      .gap(6)
      .children(
        this.githubRuns.map((run) => {
          const isSuccess = run.conclusion === "success";
          const isFailure = run.conclusion === "failure";
          const isInflight = this.githubInflightAction === `run-${run.databaseId}`;
          const statusColor = isSuccess ? t.ansi2 : isFailure ? t.ansi1 : "#f59e0b";
          const statusIcon = isSuccess ? "check" : isFailure ? "x" : "spinner";

          return v_flex()
            .id(`gh-run-${run.databaseId}`)
            .p(8)
            .gap(5)
            .rounded(6)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon(statusIcon, 13).text_color(statusColor))
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .text_size(11.5)
                        .font_medium()
                        .text_color(t.foreground)
                        .truncate()
                        .child(run.workflowName || run.name)
                    )
                )
                .child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .when(isFailure, (el) =>
                      el.child(
                        h_flex()
                          .px(6)
                          .py(2)
                          .gap(4)
                          .items_center()
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.ansi1 + "26")
                          .border_1()
                          .border_color(t.ansi1)
                          .text_size(10.5)
                          .font_medium()
                          .text_color(t.ansi1)
                          .on_click((_e, cx) => this.fixCiWithAgent(run, cx))
                          .child(isInflight ? icon("spinner", 11).spin(900) : icon("sparkles", 11).text_color(t.ansi1))
                          .child("Fix")
                      )
                    )
                    .child(
                      div()
                        .size(22)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click(() => exec("open", [run.url]))
                        .child(icon("external-link", 11))
                    )
                )
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .text_size(10.5)
                .text_color(t.dim)
                .child(
                  h_flex()
                    .gap(3)
                    .items_center()
                    .child(icon("git-branch", 10).text_color(t.dim))
                    .child(div().max_w(160).truncate().child(run.headBranch || ""))
                )
                .child(`event: ${run.event || "push"}`)
            );
        })
      );
  }

  renderGithubIssues(t) {
    if (!this.githubIssues || this.githubIssues.length === 0) {
      return v_flex()
        .size_full()
        .py(36)
        .items_center()
        .justify_center()
        .gap(8)
        .child(icon("circle-dot", 20).text_color(t.dim))
        .child(div().text_size(12).text_color(t.dim).child("No open issues"));
    }

    return v_flex()
      .gap(6)
      .children(
        this.githubIssues.map((issue) =>
          v_flex()
            .id(`gh-issue-${issue.number}`)
            .p(8)
            .gap(5)
            .rounded(6)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(icon("circle-dot", 13).text_color(t.ansi2))
                    .child(div().text_size(11.5).font_bold().text_color(t.ansi2).child(`#${issue.number}`))
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .text_size(11.5)
                        .font_medium()
                        .text_color(t.foreground)
                        .truncate()
                        .child(issue.title)
                    )
                )
                .child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .child(
                      h_flex()
                        .px(6)
                        .py(2)
                        .gap(4)
                        .items_center()
                        .rounded(4)
                        .cursor_pointer()
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover))
                        .text_size(10.5)
                        .text_color(t.foreground)
                        .on_click((_e, cx) => this.startIssueWithAgent(issue, cx))
                        .child(icon("sparkles", 11).text_color(t.accent))
                        .child("Start")
                    )
                    .child(
                      div()
                        .size(22)
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(4)
                        .cursor_pointer()
                        .bg(t.raised)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .text_color(t.dim)
                        .on_click(() => exec("open", [issue.url]))
                        .child(icon("external-link", 11))
                    )
                )
            )
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child(`opened by ${issue.author?.login || "unknown"}`)
            )
        )
      );
  }
}
