// GitHub Hub Mod for Herdr.
// Provides PRs, GitHub Actions (CI) runs, Issues, and AI Agent workflow dispatching.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, closeOverlay, exec, spaces, appHome,
} from "herdr";

const MOD = "github-hub";
const ICON = `mods/${MOD}/github.svg`;

function resolveProbePath() {
  const h = appHome();
  return `${h}/mods/${MOD}/probe.py`;
}

function timeAgo(dateString) {
  if (!dateString) return "";
  const d = new Date(dateString);
  const now = new Date();
  const diffSec = Math.floor((now - d) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export default class GitHubHub extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;

    this.activeTab = "prs"; // "prs" | "runs" | "issues"
    this.loading = false;
    this.error = null;
    this.inflightRefresh = null;

    this.repoInfo = null; // { hasRepo, repo, branch, url, ci, prs_count, issues_count }
    this.prs = [];
    this.runs = [];
    this.issues = [];

    this.agentPromptMessage = null; // Preview banner when prompt is prepared
    this.actionInflight = null;

    this.handle = cx.focus_handle();
    this.handle.focus();

    // Initial load
    this.refreshAll(cx);
  }

  getTargetDir() {
    try {
      const sp = spaces() || [];
      const active = sp.find((s) => s.active);
      return active?.folder || "";
    } catch {
      return "";
    }
  }

  async runProbe(args) {
    const script = resolveProbePath();
    const dir = this.getTargetDir();
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

  refreshAll(cx) {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this._doRefreshAll(cx).finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  async _doRefreshAll(cx) {
    this.loading = true;
    this.error = null;
    cx?.notify?.();

    try {
      // 1. Fetch Status
      const statusData = await this.runProbe(["--action", "status"]);
      this.repoInfo = statusData;

      if (statusData.hasRepo) {
        // 2. Fetch current tab data
        await this.loadActiveTabData();
      }
    } catch (e) {
      this.error = e.message || String(e);
    } finally {
      this.loading = false;
      cx?.notify?.();
    }
  }

  async switchTab(tab, cx) {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.agentPromptMessage = null;
    cx?.notify?.();

    if (this.repoInfo?.hasRepo) {
      this.loading = true;
      cx?.notify?.();
      try {
        await this.loadActiveTabData();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
        cx?.notify?.();
      }
    }
  }

  async loadActiveTabData() {
    if (this.activeTab === "prs") {
      const res = await this.runProbe(["--action", "prs"]);
      this.prs = res.prs || [];
    } else if (this.activeTab === "runs") {
      const res = await this.runProbe(["--action", "runs"]);
      this.runs = res.runs || [];
    } else if (this.activeTab === "issues") {
      const res = await this.runProbe(["--action", "issues"]);
      this.issues = res.issues || [];
    }
  }

  openUrl(url) {
    if (url) {
      exec("open", [url]).catch(() => {});
    }
  }

  copyText(text, label, cx) {
    if (typeof cx?.write_to_clipboard === "function") {
      cx.write_to_clipboard(text);
    } else {
      exec("sh", ["-c", `printf "%s" "$1" | pbcopy`, "_", text]).catch(() => {});
    }
    this.agentPromptMessage = `📋 Copied ${label} to clipboard!`;
    cx?.notify?.();
  }

  async reviewPrWithAgent(pr, cx) {
    this.actionInflight = `pr-${pr.number}`;
    cx?.notify?.();
    try {
      const diffData = await this.runProbe(["--action", "pr-diff", "--pr", String(pr.number)]);
      const diffSnippet = diffData.diff ? `\n\n\`\`\`diff\n${diffData.diff}\n\`\`\`` : "";
      const prompt = `Please review Pull Request #${pr.number}: "${pr.title}" (branch: ${pr.headRefName}) from ${pr.author?.login}.\n` +
        `Check for potential bugs, security concerns, test coverage, and code quality.${diffSnippet}`;

      this.copyText(prompt, `Agent Review Prompt for PR #${pr.number}`, cx);
    } catch (e) {
      this.error = `Failed to prepare PR review: ${e.message}`;
    } finally {
      this.actionInflight = null;
      cx?.notify?.();
    }
  }

  async fixCiWithAgent(run, cx) {
    this.actionInflight = `run-${run.databaseId}`;
    cx?.notify?.();
    try {
      const logData = await this.runProbe(["--action", "failed-log", "--run-id", String(run.databaseId)]);
      const failedLog = logData.log ? `\n\n\`\`\`\n${logData.log}\n\`\`\`` : "";
      const prompt = `GitHub Actions workflow "${run.workflowName || run.name}" failed on branch "${run.headBranch}" (Run ID: ${run.databaseId}).\n` +
        `Here is the failed log output:${failedLog}\n\nPlease analyze the root cause and fix the failing code.`;

      this.copyText(prompt, `Agent CI Fix Prompt for Run #${run.databaseId}`, cx);
    } catch (e) {
      this.error = `Failed to get failed CI log: ${e.message}`;
    } finally {
      this.actionInflight = null;
      cx?.notify?.();
    }
  }

  startIssueWithAgent(issue, cx) {
    const prompt = `Please work on GitHub Issue #${issue.number}: "${issue.title}".\n` +
      `URL: ${issue.url}\n` +
      `Please create an appropriate feature/fix branch, implement the required changes, and verify with tests.`;

    this.copyText(prompt, `Agent Task Prompt for Issue #${issue.number}`, cx);
  }

  render(cx) {
    const t = theme();
    const hasRepo = Boolean(this.repoInfo && this.repoInfo.hasRepo);
    const repoName = this.repoInfo?.repo ?? "No Git Remote";
    const branchName = this.repoInfo?.branch ?? "main";

    return div()
      .track_focus(this.handle)
      .size_full()
      .bg(t.background)
      .rounded(8)
      .border(1)
      .border_color(t.border)
      .shadow_lg()
      .overflow_hidden()
      .child(
        v_flex()
          .size_full()
          // Top Header
          .child(this.renderHeader(t, repoName, branchName, cx))
          // Agent Prompt / Notification Banner
          .when(Boolean(this.agentPromptMessage), (el) =>
            el.child(this.renderAgentBanner(t, cx))
          )
          // Navigation Tabs
          .child(this.renderTabs(t, cx))
          // Content Area
          .child(
            div()
              .flex_1()
              .p(14)
              .overflow_y_scroll()
              .when(!hasRepo, (el) => el.child(this.renderNoRepoState(t)))
              .when(hasRepo && this.loading, (el) => el.child(this.renderLoading(t)))
              .when(hasRepo && !this.loading && Boolean(this.error), (el) =>
                el.child(this.renderErrorState(t, this.error))
              )
              .when(hasRepo && !this.loading && !this.error, (el) => {
                if (this.activeTab === "prs") return el.child(this.renderPrsList(t, cx));
                if (this.activeTab === "runs") return el.child(this.renderRunsList(t, cx));
                if (this.activeTab === "issues") return el.child(this.renderIssuesList(t, cx));
                return el;
              })
          )
      );
  }

  renderHeader(t, repoName, branchName, cx) {
    return h_flex()
      .px(16)
      .py(12)
      .items_center()
      .justify_between()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      // Left: Logo & Repo Title
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .child(svg(ICON).size(20).text_color(t.foreground))
          .child(
            div()
              .font_bold()
              .text_size(14)
              .text_color(t.foreground)
              .child("GitHub Hub")
          )
          .child(
            div()
              .px(8)
              .py(2)
              .rounded(4)
              .bg(t.surface ?? t.background)
              .border(1)
              .border_color(t.border)
              .text_size(11.5)
              .font_medium()
              .text_color(t.accent ?? "#89b4fa")
              .child(repoName)
          )
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(4)
              .bg(t.background)
              .text_size(11)
              .text_color(t.muted)
              .child(`🌿 ${branchName}`)
          )
      )
      // Right Actions: Open in Browser, Refresh, Close
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .when(Boolean(this.repoInfo?.url), (el) =>
            el.child(
              div()
                .px(8)
                .py(4)
                .rounded(4)
                .cursor_pointer()
                .bg(t.surface)
                .text_size(11)
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => this.openUrl(this.repoInfo.url))
                .child("🌐 Open in GitHub")
            )
          )
          .child(
            div()
              .px(8)
              .py(4)
              .rounded(4)
              .cursor_pointer()
              .bg(t.surface)
              .text_size(11)
              .text_color(t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click(() => this.refreshAll(cx))
              .child(this.loading ? "🔄 Refreshing..." : "🔄 Refresh")
          )
          .when(Boolean(this.overlayId), (el) =>
            el.child(
              div()
                .px(8)
                .py(4)
                .rounded(4)
                .cursor_pointer()
                .text_size(12)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => closeOverlay(this.overlayId))
                .child("✕")
            )
          )
      );
  }

  renderAgentBanner(t, cx) {
    return h_flex()
      .px(16)
      .py(8)
      .items_center()
      .justify_between()
      .bg(t.selected ?? "#1e293b")
      .border_b(1)
      .border_color(t.accent ?? "#89b4fa")
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(
            div()
              .text_size(11.8)
              .font_medium()
              .text_color(t.accent ?? "#89b4fa")
              .child(this.agentPromptMessage)
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child("(Paste into your Agent terminal to run)")
          )
      )
      .child(
        div()
          .cursor_pointer()
          .px(6)
          .py(2)
          .text_size(11)
          .text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => {
            this.agentPromptMessage = null;
            cx?.notify?.();
          })
          .child("Dismiss")
      );
  }

  renderTabs(t, cx) {
    const tabItem = (key, label, badge) => {
      const active = this.activeTab === key;
      return div()
        .px(14)
        .py(8)
        .cursor_pointer()
        .when(active, (el) =>
          el.border_b(2).border_color(t.accent ?? "#89b4fa")
        )
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(
              div()
                .text_size(12)
                .font_medium()
                .text_color(active ? t.foreground : t.muted)
                .child(label)
            )
            .when(badge !== null && badge !== undefined, (el) =>
              el.child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(10)
                  .bg(active ? (t.accent ?? "#89b4fa") : t.surface)
                  .text_size(9.5)
                  .font_bold()
                  .text_color(active ? "#181825" : t.dim)
                  .child(String(badge))
              )
            )
        )
        .on_click(() => this.switchTab(key, cx));
    };

    const prCount = this.repoInfo?.prs_count ?? 0;
    const issueCount = this.repoInfo?.issues_count ?? 0;

    return h_flex()
      .px(16)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .gap(12)
      .child(tabItem("prs", "🔀 Pull Requests", prCount))
      .child(tabItem("runs", "🟢 Actions & CI", null))
      .child(tabItem("issues", "🎫 Issues", issueCount));
  }

  renderPrsList(t, cx) {
    if (!this.prs || this.prs.length === 0) {
      return div()
        .py(40)
        .items_center()
        .justify_center()
        .child(
          div()
            .text_size(13)
            .text_color(t.muted)
            .child("No open pull requests found for this repository.")
        );
    }

    const list = v_flex().gap(8);
    for (const pr of this.prs) {
      const isDraft = Boolean(pr.isDraft);
      const isApproved = pr.reviewDecision === "APPROVED";
      const isInflight = this.actionInflight === `pr-${pr.number}`;

      list.child(
        div()
          .p(12)
          .rounded(6)
          .bg(t.surface ?? t.background)
          .border(1)
          .border_color(t.border)
          .hover((s) => s.border_color(t.muted))
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  // Title + Number
                  .child(
                    h_flex()
                      .items_center()
                      .gap(8)
                      .child(
                        div()
                          .text_size(12)
                          .font_bold()
                          .text_color(t.accent ?? "#89b4fa")
                          .child(`#${pr.number}`)
                      )
                      .child(
                        div()
                          .text_size(12.5)
                          .font_medium()
                          .text_color(t.foreground)
                          .child(pr.title)
                      )
                      .when(isDraft, (el) =>
                        el.child(
                          div()
                            .px(5)
                            .py(1)
                            .rounded(3)
                            .bg(t.dim)
                            .text_size(10)
                            .text_color("#ffffff")
                            .child("Draft")
                        )
                      )
                      .when(isApproved, (el) =>
                        el.child(
                          div()
                            .px(5)
                            .py(1)
                            .rounded(3)
                            .bg(t.ansi2 ?? "#a6e3a1")
                            .text_size(10)
                            .text_color("#181825")
                            .child("Approved")
                        )
                      )
                  )
                  // Actions: Review with Agent & Open
                  .child(
                    h_flex()
                      .items_center()
                      .gap(6)
                      .child(
                        div()
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.selected ?? "#313244")
                          .text_size(11)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover ?? "#45475a"))
                          .on_click(() => this.reviewPrWithAgent(pr, cx))
                          .child(isInflight ? "Analyzing..." : "🤖 Review with Agent")
                      )
                      .child(
                        div()
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.background)
                          .border(1)
                          .border_color(t.border)
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => this.openUrl(pr.url))
                          .child("Open ↗")
                      )
                  )
              )
              // Subtitle: Author, Branch, Diff stats, Time
              .child(
                h_flex()
                  .items_center()
                  .gap(10)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(`by ${pr.author?.login || "unknown"}`)
                  .child(`branch: ${pr.headRefName}`)
                  .child(
                    h_flex()
                      .gap(4)
                      .child(div().text_color(t.ansi2 ?? "#a6e3a1").child(`+${pr.additions || 0}`))
                      .child(div().text_color(t.ansi1 ?? "#f38ba8").child(`-${pr.deletions || 0}`))
                  )
                  .child(`updated ${timeAgo(pr.updatedAt)}`)
              )
          )
      );
    }
    return list;
  }

  renderRunsList(t, cx) {
    if (!this.runs || this.runs.length === 0) {
      return div()
        .py(40)
        .items_center()
        .justify_center()
        .child(
          div()
            .text_size(13)
            .text_color(t.muted)
            .child("No recent workflow runs found.")
        );
    }

    const list = v_flex().gap(8);
    for (const run of this.runs) {
      const isSuccess = run.conclusion === "success";
      const isFailure = run.conclusion === "failure";
      const isRunning = run.status === "in_progress" || run.status === "queued";
      const isInflight = this.actionInflight === `run-${run.databaseId}`;

      const statusColor = isSuccess
        ? (t.ansi2 ?? "#a6e3a1")
        : isFailure
        ? (t.ansi1 ?? "#f38ba8")
        : (t.blocked ?? "#fab387");

      const statusText = isSuccess
        ? "✔ Passed"
        : isFailure
        ? "✖ Failed"
        : "● In Progress";

      list.child(
        div()
          .p(12)
          .rounded(6)
          .bg(t.surface ?? t.background)
          .border(1)
          .border_color(t.border)
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .items_center()
                      .gap(8)
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(3)
                          .text_size(10.5)
                          .font_bold()
                          .text_color(statusColor)
                          .bg(t.background)
                          .child(statusText)
                      )
                      .child(
                        div()
                          .text_size(12.5)
                          .font_medium()
                          .text_color(t.foreground)
                          .child(run.workflowName || run.name)
                      )
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(3)
                          .bg(t.background)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(`🌿 ${run.headBranch}`)
                      )
                  )
                  // Actions: Fix with Agent (if failed) & Open
                  .child(
                    h_flex()
                      .items_center()
                      .gap(6)
                      .when(isFailure, (el) =>
                        el.child(
                          div()
                            .px(8)
                            .py(4)
                            .rounded(4)
                            .cursor_pointer()
                            .bg(t.ansi1 ?? "#f38ba8")
                            .text_size(11)
                            .font_medium()
                            .text_color("#181825")
                            .hover((s) => s.opacity(0.9))
                            .on_click(() => this.fixCiWithAgent(run, cx))
                            .child(isInflight ? "Fetching Log..." : "🤖 Fix with Agent")
                        )
                      )
                      .child(
                        div()
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.background)
                          .border(1)
                          .border_color(t.border)
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => this.openUrl(run.url))
                          .child("Open ↗")
                      )
                  )
              )
              // Subtitle: event & time
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(`event: ${run.event || "push"}`)
                  .child(`· ${timeAgo(run.createdAt)}`)
              )
          )
      );
    }
    return list;
  }

  renderIssuesList(t, cx) {
    if (!this.issues || this.issues.length === 0) {
      return div()
        .py(40)
        .items_center()
        .justify_center()
        .child(
          div()
            .text_size(13)
            .text_color(t.muted)
            .child("No open issues found.")
        );
    }

    const list = v_flex().gap(8);
    for (const issue of this.issues) {
      list.child(
        div()
          .p(12)
          .rounded(6)
          .bg(t.surface ?? t.background)
          .border(1)
          .border_color(t.border)
          .child(
            v_flex()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .items_center()
                      .gap(8)
                      .child(
                        div()
                          .text_size(12)
                          .font_bold()
                          .text_color(t.ansi2 ?? "#a6e3a1")
                          .child(`#${issue.number}`)
                      )
                      .child(
                        div()
                          .text_size(12.5)
                          .font_medium()
                          .text_color(t.foreground)
                          .child(issue.title)
                      )
                  )
                  .child(
                    h_flex()
                      .items_center()
                      .gap(6)
                      .child(
                        div()
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.selected ?? "#313244")
                          .text_size(11)
                          .text_color(t.foreground)
                          .hover((s) => s.bg(t.hover ?? "#45475a"))
                          .on_click(() => this.startIssueWithAgent(issue, cx))
                          .child("🤖 Start with Agent")
                      )
                      .child(
                        div()
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .cursor_pointer()
                          .bg(t.background)
                          .border(1)
                          .border_color(t.border)
                          .text_size(11)
                          .text_color(t.muted)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => this.openUrl(issue.url))
                          .child("Open ↗")
                      )
                  )
              )
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(`opened by ${issue.author?.login || "unknown"}`)
                  .child(`· updated ${timeAgo(issue.updatedAt)}`)
              )
          )
      );
    }
    return list;
  }

  renderNoRepoState(t) {
    return div()
      .py(40)
      .items_center()
      .justify_center()
      .child(
        v_flex()
          .items_center()
          .gap(10)
          .child(svg(ICON).size(36).text_color(t.dim))
          .child(
            div()
              .text_size(13.5)
              .font_medium()
              .text_color(t.foreground)
              .child("No GitHub Remote in Current Workspace")
          )
          .child(
            div()
              .max_w(360)
              .text_size(11.5)
              .text_color(t.muted)
              .child(
                "Please open a workspace directory that contains a Git repository connected to GitHub (e.g. origin remote)."
              )
          )
      );
  }

  renderLoading(t) {
    return div()
      .py(40)
      .items_center()
      .justify_center()
      .child(
        div()
          .text_size(12.5)
          .text_color(t.muted)
          .child("Connecting to GitHub...")
      );
  }

  renderErrorState(t, err) {
    return div()
      .py(30)
      .items_center()
      .justify_center()
      .child(
        v_flex()
          .items_center()
          .gap(8)
          .child(
            div()
              .text_size(13)
              .text_color(t.ansi1 ?? "#f38ba8")
              .child("Error querying GitHub")
          )
          .child(
            div()
              .text_size(11.5)
              .text_color(t.muted)
              .child(String(err))
          )
      );
  }
}
