import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, appHome, focused, panes, home } from "herdr";
import {
  collectAllAgentsStatus,
  detectActiveAgent,
  formatEffort,
  formatCwd,
  shrinkPath,
} from "./agent-collector.js";

const MUSIC_ICON = "mods/workspace-status/music.svg";
const CLAUDE_ICON = "mods/workspace-status/claude.svg";
const CODEX_ICON = "mods/workspace-status/codex.svg";
const AGY_ICON = "mods/workspace-status/antigravity.svg";

function resolveProbePath() {
  const h = appHome();
  return `${h}/mods/workspace-status/probe.py`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.song = null;
    this.polling = false;

    this.agentStatus = {
      claude: null,
      codex: null,
      antigravity: null,
    };
    this.agentPolling = false;

    // Fast check: poll YouTube Music every 2.5 seconds
    cx.timer.every(2500, (tcx) => this.pollMusic(tcx));
    this.pollMusic(cx);

    // Poll AI Agent Status (Claude, Codex, Antigravity) every 3 seconds
    cx.timer.every(3000, (tcx) => this.pollAgentStatus(tcx));
    this.pollAgentStatus(cx);
  }

  async pollMusic(cx) {
    if (this.polling) return this._musicPollPromise;
    this.polling = true;
    this._musicPollPromise = (async () => {
      try {
        const probeScript = resolveProbePath();
        const res = await exec("python3", [probeScript, "--action", "status"]);
        if (res.code === 0 && res.stdout) {
          const data = JSON.parse(res.stdout);
          const prev = this.song;
          const changed =
            !prev ||
            prev.active !== data.active ||
            prev.title !== data.title ||
            prev.playing !== data.playing ||
            prev.artist !== data.artist;

          if (changed) {
            this.song = data;
            cx?.notify?.();
          }
        }
      } catch {
        // ignore probe error
      } finally {
        this.polling = false;
      }
    })();
    return this._musicPollPromise;
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

  async activateYTM(cx) {
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "activate"]);
    } catch {}
  }

  async togglePlay(cx) {
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "toggle"]);
      await this.pollMusic(cx);
    } catch {}
  }

  openQuotasDashboard() {
    try {
      run("mod.open", { name: "agent-quotas" });
    } catch {}
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  renderMusicWidget(t, song, cx) {
    const isPlaying = song.playing;
    const accentColor = t.ansi2 ?? "#a6e3a1";
    const fullInfo = song.artist ? `${song.title} · ${song.artist}` : song.title;
    const tooltipText = `${fullInfo} (${isPlaying ? "Playing" : "Paused"})`;

    return h_flex()
      .id("ytm-now-playing")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .max_w(420)
      .rounded(5)
      .cursor_pointer()
      .tooltip(tooltipText)
      .hover((s) => s.bg(t.selected ?? "#334155"))
      .on_click((_e, cx) => this.activateYTM(cx))
      // Music note icon
      .child(
        svg(MUSIC_ICON)
          .size(13)
          .flex_shrink_0()
          .text_color(isPlaying ? accentColor : t.dim)
      )
      // Song title
      .child(
        div()
          .max_w(240)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(isPlaying ? t.foreground : t.muted)
          .child(song.title)
      )
      // Artist
      .when(Boolean(song.artist), (el) =>
        el.child(
          div()
            .max_w(140)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(`· ${song.artist}`)
        )
      )
      // Mini play / pause indicator button
      .child(
        div()
          .flex_shrink_0()
          .px(4)
          .py(1)
          .rounded(3)
          .text_size(10)
          .text_color(isPlaying ? accentColor : t.dim)
          .hover((s) => s.bg(t.hover ?? t.surface))
          .tooltip(isPlaying ? "Pause" : "Play")
          .on_click((e, cx) => {
            e.stop_propagation();
            this.togglePlay(cx);
          })
          .child(isPlaying ? "⏸" : "▶")
      );
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
      .rounded(5)
      .bg(t.surface ?? "#1e1e2e")
      .border(1)
      .border_color(t.accent ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
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
            .bg(t.dim ? `${t.dim}33` : "#45475a")
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
      .rounded(5)
      .bg(t.surface ?? "#1e1e2e")
      .border(1)
      .border_color(t.accent ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
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
            .bg(t.dim ? `${t.dim}33` : "#45475a")
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
    const model = agy?.model || "Gemini 3.8 Flash";
    const fiveHRem = agy?.fiveHour?.remainingPercent;
    const weekRem = agy?.weekly?.remainingPercent;

    let tip = `Antigravity · ${model}`;
    if (fiveHRem !== null && fiveHRem !== undefined) tip += `\n5-Hour Limit: ${fiveHRem}% remaining`;
    if (agy?.fiveHour?.timeRemaining) tip += ` (${agy.fiveHour.timeRemaining})`;
    if (weekRem !== null && weekRem !== undefined) tip += `\n7-Day Limit: ${weekRem}% remaining`;
    if (agy?.weekly?.timeRemaining) tip += ` (${agy.weekly.timeRemaining})`;
    tip += "\nClick to open AI Quotas Dashboard";

    return h_flex()
      .id("agent-status-antigravity-expanded")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .rounded(5)
      .bg(t.surface ?? "#1e1e2e")
      .border(1)
      .border_color(t.accent ?? t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(AGY_ICON).size(13).flex_shrink_0())
      .child(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(model)
      )
      .when(fiveHRem !== null && fiveHRem !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(fiveHRem <= 15 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`5h ${fiveHRem}%`)
          )
      )
      .when(weekRem !== null && weekRem !== undefined, (el) =>
        el
          .child(div().text_color(t.dim).child("·"))
          .child(
            div()
              .text_size(11)
              .text_color(weekRem <= 15 ? (t.blocked ?? "#f38ba8") : t.muted)
              .child(`7d ${weekRem}%`)
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
      .rounded(4)
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
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
      .rounded(4)
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
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
    const rem = agy?.fiveHour?.remainingPercent ?? agy?.weekly?.remainingPercent;
    const label = rem !== null && rem !== undefined ? `${rem}%` : "AGY";
    const tip = `Antigravity${rem !== null && rem !== undefined ? ` · ${rem}% remaining` : ""}\nClick to open AI Quotas Dashboard`;

    return h_flex()
      .id("agent-badge-antigravity")
      .items_center()
      .gap(4)
      .px(6)
      .h(20)
      .rounded(4)
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.selected ?? "#334155"))
      .on_click(() => this.openQuotasDashboard())
      .child(svg(AGY_ICON).size(12).flex_shrink_0())
      .child(
        div()
          .text_size(10.5)
          .text_color(t.muted)
          .child(label)
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
      .rounded(5)
      .bg(t.surface ?? "#1e1e2e")
      .border(1)
      .border_color(t.border)
      .cursor_pointer()
      .tooltip(`Agent 完整路徑: ${cwd}\n點擊複製路徑`)
      .hover((s) => s.bg(t.selected ?? "#334155"))
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

    return h_flex()
      .size_full()
      .px(14)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      // Left Group: Git Branch
      .when(Boolean(branchName), (el) => el.child(label("branch", branchName)))
      // Machine (if remote or custom named)
      .when(Boolean(space?.machine && space.machine !== "This computer"), (el) =>
        el.child(label("server", space.machine))
      )
      // Agent Count
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)))
      )
      // Spacer: absorbs all middle space, pushing AI Agent Status Bar and controls to the right
      .child(div().flex_1())
      // Right Group: Agent CWD Full Path
      .when(Boolean(agentCwd), (el) => el.child(this.renderAgentCwd(agentCwd, t, cx)))
      // Right Group: Unified AI Agent Status Bar (Right-aligned!)
      .child(this.renderAgentStatusBar(t, cx))
      // Right Corner: YouTube Music Widget (when active)
      .when(Boolean(this.song && this.song.active), (el) =>
        el.child(this.renderMusicWidget(t, this.song, cx))
      )
      // Right Corner: Palette command
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint(t))
      );
  }
}
