import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, theme, run, exec, focused, panes, home, readTextFile } from "herdr";
import {
  collectAllAgentsStatus,
  detectActiveAgent,
  formatEffort,
  formatCwd,
  shrinkPath,
} from "./agent-collector.js";

const CLAUDE_ICON = "mods/enhanced-status/claude.svg";
const CODEX_ICON = "mods/enhanced-status/codex.svg";
const AGY_ICON = "mods/enhanced-status/antigravity.svg";

const MARQUEE_TICK_MS = 33;
const MARQUEE_SPEED_PX_PER_SEC = 28;
const MARQUEE_PAUSE_MS = 1800;
const MARQUEE_WHEEL_PAUSE_MS = 2500;
const HORIZONTAL_PADDING_PX = 28;

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.polling = false;

    this.agentStatus = {
      claude: null,
      codex: null,
      antigravity: null,
    };
    this.agentPolling = false;

    // Poll AI Agent Status (Claude, Codex, Antigravity) every 3 seconds
    cx.timer.every(3000, (tcx) => this.pollAgentStatus(tcx));
    this.pollAgentStatus(cx);

    // Poll Input Method (IME) state every 300ms
    this.ime = { badge: "ABC", name: "ABC", isChinese: false };
    cx.timer.every(300, (tcx) => this.pollIme(tcx));
    this.pollIme(cx);

    // Ping-pong horizontal auto-scroll state when status bar overflows
    this.viewportWidth = 0;
    this.contentWidth = 0;
    this.scrollOffset = 0;
    this.scrollDir = 1;
    this.scrollPausedUntil = 0;
    this.isHoveringBar = false;
    this.lastScrollTickAt = 0;
    cx.timer.every(MARQUEE_TICK_MS, (tcx) => this.tickMarquee(tcx));
  }

  getMaxScrollOffset() {
    return Math.max(0, Math.ceil(this.contentWidth - this.viewportWidth));
  }

  updateMarqueeBounds(viewportW, contentW, cx) {
    const prevMax = this.getMaxScrollOffset();
    this.viewportWidth = Math.max(0, viewportW || 0);
    this.contentWidth = Math.max(0, contentW || 0);
    const nextMax = this.getMaxScrollOffset();

    if (nextMax <= 1) {
      if (this.scrollOffset !== 0) {
        this.scrollOffset = 0;
        this.scrollDir = 1;
        this.lastScrollTickAt = 0;
        cx?.notify?.();
      } else {
        this.scrollDir = 1;
        this.lastScrollTickAt = 0;
      }
      return;
    }

    if (prevMax <= 1) {
      this.scrollPausedUntil = Date.now() + MARQUEE_PAUSE_MS;
      this.lastScrollTickAt = Date.now();
    }

    if (this.scrollOffset > nextMax) {
      this.scrollOffset = nextMax;
      cx?.notify?.();
    }
  }

  tickMarquee(cx, now = Date.now()) {
    const maxOffset = this.getMaxScrollOffset();
    if (maxOffset <= 1) {
      if (this.scrollOffset !== 0) {
        this.scrollOffset = 0;
        cx?.notify?.();
      }
      this.lastScrollTickAt = 0;
      return;
    }

    if (this.isHoveringBar || now < this.scrollPausedUntil) {
      this.lastScrollTickAt = now;
      return;
    }

    if (!this.lastScrollTickAt) {
      this.lastScrollTickAt = now;
      return;
    }

    const dtSec = Math.min(0.1, (now - this.lastScrollTickAt) / 1000);
    this.lastScrollTickAt = now;
    if (dtSec <= 0) return;

    let next = this.scrollOffset + this.scrollDir * MARQUEE_SPEED_PX_PER_SEC * dtSec;
    if (next >= maxOffset) {
      next = maxOffset;
      this.scrollDir = -1;
      this.scrollPausedUntil = now + MARQUEE_PAUSE_MS;
    } else if (next <= 0) {
      next = 0;
      this.scrollDir = 1;
      this.scrollPausedUntil = now + MARQUEE_PAUSE_MS;
    }

    if (Math.abs(next - this.scrollOffset) >= 0.25) {
      this.scrollOffset = next;
      cx?.notify?.();
    }
  }

  handleScrollWheel(event, cx) {
    const maxOffset = this.getMaxScrollOffset();
    if (maxOffset <= 1) return;
    const dx = event?.delta?.x ?? 0;
    const dy = event?.delta?.y ?? 0;
    const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    if (!delta) return;

    const next = Math.max(0, Math.min(maxOffset, this.scrollOffset - delta));
    if (next !== this.scrollOffset) {
      this.scrollOffset = next;
      this.scrollPausedUntil = Date.now() + MARQUEE_WHEEL_PAUSE_MS;
      this.lastScrollTickAt = Date.now();
      cx?.notify?.();
    }
  }

  async pollIme(cx) {
    try {
      const text = await readTextFile("/tmp/herdr-ime.json");
      if (text) {
        const data = JSON.parse(text);
        if (!this.ime || this.ime.badge !== data.badge || this.ime.isChinese !== data.isChinese) {
          this.ime = data;
          cx?.notify?.();
        }
      }
    } catch {}
  }

  async pollAgentStatus(cx) {
    if (this.agentPolling) return this._agentPollPromise;
    this.agentPolling = true;
    this._agentPollPromise = (async () => {
      try {
        const data = await collectAllAgentsStatus();
        this.agentStatus = data;
        cx?.notify?.();
      } catch {
        // ignore agent poll error
      } finally {
        this.agentPolling = false;
      }
    })();
    return this._agentPollPromise;
  }

  openQuotasDashboard() {
    try {
      run("mod.open", { name: "agent-quotas" });
    } catch {}
  }

  // Render expanded active Claude Code pill
  renderExpandedClaude(t, claude) {
    const model = claude?.model || "Claude";
    const effort = formatEffort(claude?.effort);
    const ctx = claude?.contextPercent;
    const fiveH = claude?.fiveHourPercent;
    const sevenD = claude?.sevenDayPercent;
    const cost = claude?.cost;

    let tip = `Claude Code · ${model}`;
    if (claude?.effort) tip += ` (${claude.effort})`;
    if (ctx !== null && ctx !== undefined) tip += `\nContext: ${ctx}% (${Math.round((claude.contextTokens || 0) / 1000)}k tokens)`;
    if (fiveH !== null && fiveH !== undefined) tip += `\n5-Hour Quota: ${fiveH}% used`;
    if (claude?.timeRemaining) tip += ` (${claude.timeRemaining})`;
    if (sevenD !== null && sevenD !== undefined) tip += `\n7-Day Quota: ${sevenD}% used`;
    if (cost) tip += `\nSession Cost: ${cost}`;
    tip += "\nClick to open AI Quotas Dashboard";

    return h_flex()
      .id("agent-status-claude-expanded")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .rounded(6)
      .bg(t.raised ?? t.surface ?? "#ffffff1a")
      .border(1)
      .border_color(t.input ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(CLAUDE_ICON).size(13).flex_shrink_0())
      .child(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(model)
      )
      .when(Boolean(effort), (el) =>
        el.child(
          div()
            .px(3)
            .py(0.5)
            .rounded(3)
            .bg(t.surface ?? "#ffffff12")
            .text_size(9.5)
            .text_color(t.muted)
            .child(effort)
        )
      )
      .when(ctx !== null && ctx !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(ctx >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`ctx ${ctx}%`)
          )
      )
      .when(fiveH !== null && fiveH !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(fiveH >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`5h ${fiveH}%`)
          )
      )
      .when(sevenD !== null && sevenD !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(sevenD >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`7d ${sevenD}%`)
          )
      );
  }

  // Render expanded active Codex pill
  renderExpandedCodex(t, codex) {
    const model = codex?.model || "gpt-6.1-sol";
    const effort = formatEffort(codex?.effort);
    const week = codex?.weekPercent;

    let tip = `Codex · ${model}`;
    if (codex?.effort) tip += ` (${codex.effort})`;
    if (week !== null && week !== undefined) tip += `\n7-Day Limit: ${week}% used`;
    if (codex?.timeRemaining) tip += ` (${codex.timeRemaining})`;
    if (codex?.tokensToday) tip += `\nTokens Today: ${codex.tokensToday.toLocaleString()}`;
    tip += "\nClick to open AI Quotas Dashboard";

    return h_flex()
      .id("agent-status-codex-expanded")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .rounded(6)
      .bg(t.raised ?? t.surface ?? "#ffffff1a")
      .border(1)
      .border_color(t.input ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(CODEX_ICON).size(13).flex_shrink_0())
      .child(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(model)
      )
      .when(Boolean(effort), (el) =>
        el.child(
          div()
            .px(3)
            .py(0.5)
            .rounded(3)
            .bg(t.surface ?? "#ffffff12")
            .text_size(9.5)
            .text_color(t.muted)
            .child(effort)
        )
      )
      .when(week !== null && week !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(week >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`7d ${week}%`)
          )
      );
  }

  // Render expanded active Antigravity pill
  renderExpandedAntigravity(t, agy) {
    let model = agy?.model || "Gemini 3.8 Flash";
    let effort = formatEffort(agy?.effort);
    if (!effort && model) {
      const match = model.match(/\(([^)]+)\)/);
      if (match) {
        effort = formatEffort(match[1]);
        model = model.replace(/\s*\([^)]+\)/g, "").trim();
      }
    }
    const fiveH = agy?.fiveHour?.percent;
    const week = agy?.weekly?.percent;

    let tip = `Antigravity · ${model}`;
    if (effort) tip += ` (${effort})`;
    if (fiveH !== null && fiveH !== undefined) tip += `\n5-Hour Limit: ${fiveH}% used`;
    if (agy?.fiveHour?.timeRemaining) tip += ` (${agy.fiveHour.timeRemaining})`;
    if (week !== null && week !== undefined) tip += `\n7-Day Limit: ${week}% used`;
    if (agy?.weekly?.timeRemaining) tip += ` (${agy.weekly.timeRemaining})`;
    tip += "\nClick to open AI Quotas Dashboard";

    return h_flex()
      .id("agent-status-antigravity-expanded")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .rounded(6)
      .bg(t.raised ?? t.surface ?? "#ffffff1a")
      .border(1)
      .border_color(t.input ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(AGY_ICON).size(13).flex_shrink_0())
      .child(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(model)
      )
      .when(Boolean(effort), (el) =>
        el.child(
          div()
            .px(3)
            .py(0.5)
            .rounded(3)
            .bg(t.surface ?? "#ffffff12")
            .text_size(9.5)
            .text_color(t.muted)
            .child(effort)
        )
      )
      .when(fiveH !== null && fiveH !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(fiveH >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`5h ${fiveH}%`)
          )
      )
      .when(week !== null && week !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(week >= 85 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`7d ${week}%`)
          )
      );
  }

  // Render compact badge for Claude
  renderCompactClaude(t, claude) {
    const fiveH = claude?.fiveHourPercent;
    const label = fiveH !== null && fiveH !== undefined ? `${fiveH}%` : "Claude";
    const tip = `Claude Code${fiveH !== null && fiveH !== undefined ? ` · 5h: ${fiveH}% used` : ""}\nClick to open AI Quotas Dashboard`;

    return h_flex()
      .id("agent-badge-claude")
      .items_center()
      .gap(4)
      .px(6)
      .h(20)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(CLAUDE_ICON).size(12).flex_shrink_0())
      .child(
        div()
          .text_size(10.5)
          .text_color(t.muted)
          .child(label)
      );
  }

  // Render compact badge for Codex
  renderCompactCodex(t, codex) {
    const week = codex?.weekPercent;
    const label = week !== null && week !== undefined ? `${week}%` : "Codex";
    const tip = `Codex${week !== null && week !== undefined ? ` · 7d: ${week}% used` : ""}\nClick to open AI Quotas Dashboard`;

    return h_flex()
      .id("agent-badge-codex")
      .items_center()
      .gap(4)
      .px(6)
      .h(20)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(CODEX_ICON).size(12).flex_shrink_0())
      .child(
        div()
          .text_size(10.5)
          .text_color(t.muted)
          .child(label)
      );
  }

  // Render compact badge for Antigravity
  renderCompactAntigravity(t, agy) {
    const used = agy?.fiveHour?.percent ?? agy?.weekly?.percent;
    const label = used !== null && used !== undefined ? `${used}%` : "AGY";
    const tip = `Antigravity${used !== null && used !== undefined ? ` · 5h: ${used}% used` : ""}\nClick to open AI Quotas Dashboard`;

    return h_flex()
      .id("agent-badge-antigravity")
      .items_center()
      .gap(4)
      .px(6)
      .h(20)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(AGY_ICON).size(12).flex_shrink_0())
      .child(
        div()
          .text_size(10.5)
          .text_color(t.muted)
          .child(label)
      );
  }

  // Render Input Method (IME) badge styled for Liquid Glass
  renderImeBadge(t, _cx) {
    const ime = this.ime || { badge: "ABC", name: "ABC", isChinese: false };
    const isChinese = Boolean(ime.isChinese);
    const badgeColor = isChinese ? (t.blocked ?? t.ansi3 ?? "#ffd479") : t.foreground;
    const dotColor = isChinese ? (t.blocked ?? "#ffd479") : (t.done ?? t.ansi2 ?? "#6be6b5");

    return h_flex()
      .id("ime-badge")
      .items_center()
      .gap(5)
      .px(8)
      .h(22)
      .rounded(6)
      .bg(isChinese ? (t.raised ?? "#ffffff26") : (t.surface ?? "#ffffff12"))
      .border(1)
      .border_color(isChinese ? (t.blocked ?? t.input ?? t.border) : t.border)
      .tooltip(`當前輸入法: ${ime.name || ime.badge}`)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .child(
        div()
          .size(6)
          .rounded_full()
          .bg(dotColor)
      )
      .child(
        div()
          .font_bold()
          .text_size(11)
          .text_color(badgeColor)
          .child(ime.badge || "ABC")
      );
  }

  // Render Agent Working Directory path badge (with smart path shortening)
  renderAgentCwd(cwd, t, cx) {
    if (!cwd) return null;
    const userHome = typeof home === "function" ? home() : "";
    const displayPath = shrinkPath(cwd, userHome, 28);

    return h_flex()
      .id("agent-cwd")
      .items_center()
      .gap(5)
      .px(8)
      .h(22)
      .max_w(360)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(`Agent 完整路徑: ${cwd}\n點擊複製路徑`)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click((_e, cx) => {
        try {
          if (typeof cx?.write_to_clipboard === "function") {
            cx.write_to_clipboard(cwd);
          } else if (typeof exec === "function") {
            exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", cwd]).catch(() => null);
          }
        } catch {}
      })
      .child(
        svg("mods/workspace-chrome/folder.svg")
          .size(13)
          .flex_shrink_0()
          .text_color(t.ansi2 ?? "#a6e3a1")
      )
      .child(
        div()
          .truncate()
          .text_size(11)
          .text_color(t.muted)
          .child(displayPath)
      );
  }

  // Render Git Branch badge (matching agent-cwd pill styling, positioned to the right of path)
  renderGitBranch(branchName, t, cx) {
    if (!branchName) return null;

    return h_flex()
      .id("git-branch")
      .items_center()
      .gap(5)
      .px(8)
      .h(22)
      .max_w(220)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(`Git 分支: ${branchName}\n點擊複製分支名稱`)
      .hover((s) => s.bg(t.hover ?? t.selected ?? "#ffffff1f"))
      .on_click((_e, cx) => {
        try {
          if (typeof cx?.write_to_clipboard === "function") {
            cx.write_to_clipboard(branchName);
          } else if (typeof exec === "function") {
            exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", branchName]).catch(() => null);
          }
        } catch {}
      })
      .child(
        svg("mods/workspace-chrome/branch.svg")
          .size(13)
          .flex_shrink_0()
          .text_color(t.ansi4 ?? "#89b4fa")
      )
      .child(
        div()
          .truncate()
          .text_size(11)
          .text_color(t.muted)
          .child(branchName)
      );
  }

  // Resolve agent model info for agent status list/tooltip
  resolveAgentModel(a) {
    if (!a) return null;
    const { claude, codex, antigravity } = this.agentStatus || {};
    const raw = `${a.app || ""} ${a.program?.key || ""} ${a.program?.name || ""} ${a.title || ""}`.toLowerCase();

    if (raw.includes("claude")) {
      return claude?.model ? `${claude.model}${claude.effort ? ` (${claude.effort})` : ""}` : "Claude";
    }
    if (raw.includes("codex") || raw.includes("openai")) {
      return codex?.model ? `${codex.model}${codex.effort ? ` (${codex.effort})` : ""}` : "Codex";
    }
    if (raw.includes("antigravity") || raw.includes("agy") || raw.includes("gemini")) {
      return antigravity?.model ? `${antigravity.model}${antigravity.effort ? ` (${antigravity.effort})` : ""}` : "Antigravity";
    }
    return a.program?.name || a.app || null;
  }

  // Resolve current focused session agent (scoped strictly to active tab/pane)
  resolveCurrentSessionAgent() {
    const f = typeof focused === "function" ? focused() : null;
    const allPanes = typeof panes === "function" ? panes() : [];
    const allAgents = typeof agents === "function" ? agents() : [];
    const activeKind = detectActiveAgent({ focused, panes, agents });

    const currentPane = allPanes.find(
      (p) => p.focused || (f?.pane && p.pane === f.pane)
    );

    // If focused pane is a shell, no agent is in this session
    if (currentPane?.program?.shell) {
      return { currentAgent: null, activeKind: null, totalGlobalAgents: allAgents.length };
    }

    let currentAgent = allAgents.find(
      (a) =>
        a.focused ||
        (f?.agent && a.address === f.agent) ||
        (f?.terminal && a.address === f.terminal) ||
        (f?.pane && a.pane === f.pane) ||
        (currentPane?.pane && a.pane === currentPane.pane) ||
        (currentPane?.terminal && a.address === currentPane.terminal)
    );

    if (!currentAgent && activeKind) {
      currentAgent = allAgents.find((a) => {
        const raw = `${a.app || ""} ${a.program?.key || ""} ${a.program?.name || ""} ${a.title || ""}`.toLowerCase();
        return raw.includes(activeKind);
      });
    }

    return { currentAgent, activeKind, totalGlobalAgents: allAgents.length };
  }

  // Collect subagents belonging STRICTLY to the current session's agent
  collectCurrentSessionSubagents(currentAgent, activeKind) {
    const allTerms = typeof terminals === "function" ? terminals() : [];
    const result = {
      total: 0,
      running: 0,
      idle: 0,
      blocked: 0,
      items: [],
    };

    if (!currentAgent && !activeKind) return result;

    // 1. Check Herdr terminals tree where parent === currentAgent.address
    if (currentAgent?.address) {
      const kids = allTerms.filter((k) => k.parent === currentAgent.address && k.state === "live");
      for (const k of kids) {
        const s = k.status;
        const isRunning = s === "working" || s === "running";
        const isBlocked = s === "blocked";
        result.total++;
        if (isRunning) result.running++;
        else if (isBlocked) result.blocked++;
        else result.idle++;

        result.items.push({
          id: k.address,
          name: k.title || k.name || k.program?.name || "Subagent",
          status: isRunning ? "running" : isBlocked ? "blocked" : "done",
        });
      }
    }

    // 2. If current agent is Claude Code, check Claude transcript subagent tasks
    const isClaude =
      activeKind === "claude" ||
      (currentAgent &&
        `${currentAgent.app || ""} ${currentAgent.program?.key || ""}`.toLowerCase().includes("claude"));
    if (isClaude && result.total === 0) {
      const claudeSubs = this.agentStatus?.claude?.subagents;
      if (claudeSubs && claudeSubs.total > 0) {
        result.total = claudeSubs.total;
        result.running = claudeSubs.running;
        result.idle = claudeSubs.done;
        result.items = claudeSubs.items.map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status,
        }));
      }
    }

    return result;
  }

  // Render Agents count & breakdown pill scoped to CURRENT session's agent and its subagents
  renderAgentsWidget(t, cx) {
    const { currentAgent, activeKind, totalGlobalAgents } = this.resolveCurrentSessionAgent();
    const hasAgent = Boolean(currentAgent || activeKind);

    // If current session does not have an active AI agent
    if (!hasAgent) {
      return h_flex()
        .id("statusbar-agents")
        .items_center()
        .gap(6)
        .px(8)
        .h(22)
        .rounded(6)
        .bg(t.surface ?? "#ffffff12")
        .border(1)
        .border_color(t.border)
        .tooltip(`目前 Session 無執行中 Agent${totalGlobalAgents > 0 ? `\n全域共有 ${totalGlobalAgents} 個 Agent 在其他 Session` : ""}`)
        .child(div().size(6).rounded(3).bg(t.dim))
        .child(div().text_size(11).text_color(t.muted).child("0 agents"));
    }

    const subStats = this.collectCurrentSessionSubagents(currentAgent, activeKind);
    const hasSubs = subStats.total > 0;

    // Check status of main agent in this session
    const mainStatus =
      currentAgent?.status ||
      (activeKind === "antigravity" && this.agentStatus?.antigravity?.available ? "working" : "idle");
    const isMainRunning = mainStatus === "working" || mainStatus === "running";
    const isMainBlocked = mainStatus === "blocked";

    const isAnyRunning = isMainRunning || subStats.running > 0;
    const isAnyBlocked = isMainBlocked || subStats.blocked > 0;

    const statusDotColor = isAnyBlocked
      ? (t.blocked ?? "#fab387")
      : isAnyRunning
      ? (t.ansi2 ?? "#a6e3a1")
      : t.dim;

    const runningCount = hasSubs ? subStats.running : isMainRunning ? 1 : 0;
    const idleCount = hasSubs ? subStats.idle : isMainRunning ? 0 : 1;

    // Build rich tooltip for current session
    const model = currentAgent
      ? this.resolveAgentModel(currentAgent)
      : activeKind
      ? this.agentStatus?.[activeKind]?.model
      : "AI Agent";
    const agentLabel =
      currentAgent?.app ||
      currentAgent?.program?.name ||
      (activeKind === "claude" ? "Claude Code" : activeKind === "codex" ? "Codex" : "Antigravity");

    const tooltipLines = [
      `目前 Session: ${agentLabel}${model ? ` · ${model}` : ""}`,
      `狀態: ${isMainRunning ? "🟢 running" : isMainBlocked ? "🟠 needs you" : "⚪ idle"}`,
    ];

    if (hasSubs) {
      tooltipLines.push(`└─ Subagents (${subStats.total} subagents: ${subStats.running} 執行中 · ${subStats.idle} 已完成)`);
      for (const s of subStats.items) {
        const subIcon = s.status === "running" ? "🟢" : "⚪";
        tooltipLines.push(`   ├── ${subIcon} ${s.name} (${s.status})`);
      }
    } else {
      tooltipLines.push("目前無派生 Subagent");
    }

    if (totalGlobalAgents > 1) {
      tooltipLines.push("──────────────────────────────");
      tooltipLines.push(`其他 Session: 共有 ${totalGlobalAgents - 1} 個背景 Agent 在其他視窗`);
    }
    const fullTooltip = tooltipLines.join("\n");

    return h_flex()
      .id("statusbar-agents")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .rounded(6)
      .bg(t.surface ?? "#ffffff12")
      .border(1)
      .border_color(t.border)
      .tooltip(fullTooltip)
      .child(
        isAnyRunning
          ? svg("mods/workspace-chrome/spinner.svg")
              .size(11)
              .flex_none()
              .text_color(t.ansi2 ?? "#a6e3a1")
              .spin(900)
          : div().size(6).rounded(3).bg(statusDotColor)
      )
      .child(
        div()
          .text_size(11)
          .font_medium()
          .text_color(isAnyRunning ? t.foreground : t.muted)
          .child(
            hasSubs
              ? `1 agent · ${subStats.total} subagents`
              : `1 agent`
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(3)
          .text_size(10.5)
          .child(div().text_color(t.dim).child("("))
          .child(
            svg("mods/workspace-chrome/spinner.svg")
              .size(9)
              .flex_none()
              .text_color(t.ansi2 ?? "#a6e3a1")
              .when(runningCount > 0, (s) => s.spin(900))
          )
          .child(
            div()
              .text_color(runningCount > 0 ? (t.ansi2 ?? "#a6e3a1") : t.dim)
              .child(String(runningCount))
          )
          .child(div().text_color(t.dim).child("/"))
          .child(
            div()
              .size(5)
              .rounded(3)
              .border(1)
              .border_color(t.dim)
              .flex_none()
          )
          .child(
            div()
              .text_color(t.muted)
              .child(String(idleCount))
          )
          .child(div().text_color(t.dim).child(")"))
      )
      .when(isAnyBlocked, (el) =>
        el.child(
          div()
            .text_size(10.5)
            .text_color(t.blocked ?? "#fab387")
            .child(`· 1 needs you`)
        )
      );
  }

  renderAgentStatusBar(t, cx) {
    const active = detectActiveAgent({ focused, panes, agents });
    const { claude, codex, antigravity } = this.agentStatus;

    const bar = h_flex().id("unified-agent-statusbar").items_center().gap(8);

    if (active === "claude") {
      return bar
        .child(this.renderExpandedClaude(t, claude))
        .child(this.renderCompactCodex(t, codex))
        .child(this.renderCompactAntigravity(t, antigravity));
    }

    if (active === "codex") {
      return bar
        .child(this.renderCompactClaude(t, claude))
        .child(this.renderExpandedCodex(t, codex))
        .child(this.renderCompactAntigravity(t, antigravity));
    }

    if (active === "antigravity") {
      return bar
        .child(this.renderCompactClaude(t, claude))
        .child(this.renderCompactCodex(t, codex))
        .child(this.renderExpandedAntigravity(t, antigravity));
    }

    // Default neutral mode: show balanced compact badges for all 3 agents
    return bar
      .child(this.renderCompactClaude(t, claude))
      .child(this.renderCompactCodex(t, codex))
      .child(this.renderCompactAntigravity(t, antigravity));
  }

  render(cx) {
    const t = theme();
    const f = typeof focused === "function" ? focused() : null;
    const allPanes = typeof panes === "function" ? panes() : [];
    const currentPane = allPanes.find((p) => p.focused || (f && p.pane === f.pane));
    const space = spaces().find((s) => s.active);

    const activeAgent = detectActiveAgent({ focused, panes, agents });
    const agentCwd = activeAgent
      ? (activeAgent === "claude" && this.agentStatus?.claude?.cwd) ||
        f?.cwd ||
        currentPane?.cwd ||
        space?.cwd ||
        null
      : null;

    const branchName = currentPane?.branch || space?.branch || null;
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;

    const label = (icon, text, tip) => {
      const el = h_flex()
        .gap(5)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);
      if (tip) el.tooltip(tip);
      return el;
    };

    const maxOffset = this.getMaxScrollOffset();
    const offsetPx = maxOffset > 1 ? Math.round(Math.min(this.scrollOffset, maxOffset)) : 0;

    return h_flex()
      .id("status-viewport")
      .size_full()
      .px(14)
      .items_center()
      .overflow_x_hidden()
      .on_size_change((size, scx) => {
        const usable = Math.max(0, (size?.width ?? 0) - HORIZONTAL_PADDING_PX);
        this.updateMarqueeBounds(usable, this.contentWidth, scx);
      })
      .on_hover((hovered, hcx) => {
        this.isHoveringBar = Boolean(hovered);
        if (!hovered) this.lastScrollTickAt = Date.now();
        hcx?.notify?.();
      })
      .on_scroll_wheel((e, wcx) => this.handleScrollWheel(e, wcx))
      .child(
        h_flex()
          .id("status-content")
          .flex_none()
          .gap(12)
          .items_center()
          .text_size(11.8)
          .text_color(t.muted)
          .ml(offsetPx > 0 ? -offsetPx : 0)
          .on_size_change((size, scx) => {
            this.updateMarqueeBounds(this.viewportWidth, size?.width ?? 0, scx);
          })
          // Machine (if remote or custom named)
          .when(Boolean(space?.machine && space.machine !== "This computer"), (el) =>
            el.child(label("server", space.machine))
          )
          // Left Group (1): Path (Agent CWD)
          .when(Boolean(agentCwd), (el) => el.child(this.renderAgentCwd(agentCwd, t, cx)))
          // Left Group (2): Git Branch
          .when(Boolean(branchName), (el) => el.child(this.renderGitBranch(branchName, t, cx)))
          // Left Group (3): Input Method (IME) Indicator
          .child(this.renderImeBadge(t, cx))
          // Left Group (4): Usage / Quotas (Unified AI Agent Status Bar)
          .child(this.renderAgentStatusBar(t, cx))
          // Left Group (5): Agent Count & Breakdown
          .child(this.renderAgentsWidget(t, cx))
      );
  }
}
