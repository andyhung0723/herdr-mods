import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { theme, run, focused, panes, spaces, agents, terminals, notify, home, layout, closeOverlay, props } from "herdr";
import { fetchAgentContext, readRuleContent } from "./collector.js";

function cleanPath(p) {
  if (!p) return "";
  const userHome = home() || "/Users/dev";
  return p.startsWith(userHome) ? "~" + p.slice(userHome.length) : p;
}

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function getPanelWidth() {
  try {
    if (typeof layout === "function") {
      const panel = findLayoutNode(layout(), "panel");
      if (typeof panel?.size?.px === "number") return panel.size.px;
    }
  } catch {}
  return null;
}

function classifyAgentKind(rawString) {
  const s = (rawString || "").toLowerCase();
  if (!s) return null;
  if (s.includes("claude")) return { key: "claude", label: "Claude Code" };
  if (s.includes("codex") || s.includes("openai")) return { key: "codex", label: "Codex" };
  if (s.includes("antigravity") || s.includes("agy") || s.includes("gemini")) {
    return { key: "antigravity", label: "Antigravity" };
  }
  return null;
}

export default class EnhancedAgentContext extends View {
  init(_props, cx) {
    const p = _props ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.activeTab = "overview"; // overview | rules | skills | connectors
    this.scopeMode = "focused"; // focused (only current agent) | all (all agents)
    this.selectedRule = null;
    this.ruleContent = "";
    this.skillFilter = "all"; // all | claude | codex | antigravity
    this.expandedSkill = null;
    this.loading = false;
    this.lastObservedKey = "";
    this.lastWidthBucket = "";
    this.data = {
      cwd: "",
      targetAgent: "all",
      models: {},
      git: { isRepo: false, branch: "", dirtyCount: 0 },
      rules: [],
      skills: [],
      connectors: [],
      plugins: [],
      summary: { rulesCount: 0, skillsCount: 0, connectorsCount: 0, pluginsCount: 0 },
    };

    // Fast dirty-check every 500ms: immediately switches context when user switches tabs/panes or resizes panel
    cx.timer.every(500, (timerCx) => {
      const { cwd, effectiveAgent } = this.resolveActiveContext();
      const nextKey = `${cwd}::${effectiveAgent}::${this.scopeMode}`;
      const w = getPanelWidth();
      const widthBucket = w === null ? "normal" : w < 380 ? "very-narrow" : w < 420 ? "narrow" : "normal";
      if (nextKey !== this.lastObservedKey) {
        this.lastObservedKey = nextKey;
        this.lastWidthBucket = widthBucket;
        this.refresh(timerCx, false);
      } else if (widthBucket !== this.lastWidthBucket) {
        this.lastWidthBucket = widthBucket;
        timerCx?.notify?.();
      }
    });

    // Background revalidation every 10s
    cx.timer.every(10000, (timerCx) => {
      this.refresh(timerCx, false);
    });

    this.refresh(cx, true);
  }

  resolveActiveContext() {
    const focus = focused() || {};
    const allAgents = agents() || [];
    const allSpaces = spaces() || [];
    const allPanes = panes() || [];

    const activeSpace =
      allSpaces.find((s) => s.id === focus?.space) ??
      allSpaces.find((s) => s.active) ??
      allSpaces[0];

    const activeTabId = focus?.tab || activeSpace?.tabs?.find((t) => t.active)?.id;

    // 1. Find focused pane or active tab's agent pane
    let activePane = focus?.pane ? allPanes.find((p) => p.pane === focus.pane) : null;
    if (!activePane && activeTabId) {
      activePane =
        allPanes.find((p) => p.tab === activeTabId && p.focused) ??
        allPanes.find((p) => p.tab === activeTabId && p.program?.agent) ??
        allPanes.find((p) => p.tab === activeTabId);
    }
    if (!activePane) {
      activePane = allPanes.find((p) => p.focused && p.cwd);
    }

    // 2. Find matching agent in agents() list
    let currentAgent = focus?.agent ? allAgents.find((a) => a.address === focus.agent) : null;
    if (!currentAgent && activePane) {
      currentAgent = allAgents.find(
        (a) => a.pane === activePane.pane || (activePane.terminal && a.address === activePane.terminal)
      );
    }
    if (!currentAgent && activeTabId) {
      currentAgent = allAgents.find((a) => a.tab === activeTabId);
    }
    if (!currentAgent && activeSpace) {
      currentAgent = allAgents.find((a) => a.space === activeSpace.id && a.focused);
    }

    // 3. Classify agent type (claude | codex | antigravity | all)
    const detected =
      classifyAgentKind(currentAgent?.program?.key) ||
      classifyAgentKind(currentAgent?.program?.name) ||
      classifyAgentKind(currentAgent?.agent) ||
      classifyAgentKind(activePane?.program?.key) ||
      classifyAgentKind(activePane?.program?.name) ||
      classifyAgentKind(activePane?.title);

    const agentType = detected ? detected.key : "all";
    const agentLabel = detected
      ? detected.label
      : currentAgent?.program?.name || activePane?.program?.name || "All Agents";

    const cwd =
      currentAgent?.cwd ||
      activePane?.cwd ||
      focus?.cwd ||
      activeSpace?.folder ||
      activeSpace?.cwd ||
      "";

    const effectiveAgent = this.scopeMode === "all" ? "all" : agentType;

    return { currentAgent, cwd, agentType, agentLabel, effectiveAgent };
  }

  async refresh(cx, force = false) {
    const { cwd, effectiveAgent } = this.resolveActiveContext();
    this.lastObservedKey = `${cwd}::${effectiveAgent}::${this.scopeMode}`;
    this.loading = true;
    cx?.notify?.();

    try {
      const result = await fetchAgentContext(cwd, effectiveAgent, force);
      if (result) {
        this.data = result;
        const rules = this.data.rules || [];
        const stillExists =
          this.selectedRule &&
          rules.some(
            (r) => r.displayPath === this.selectedRule.displayPath && r.agent === this.selectedRule.agent
          );
        if (!stillExists) {
          if (rules.length > 0) {
            this.selectRule(rules[0], cx);
          } else {
            this.selectedRule = null;
            this.ruleContent = "";
          }
        }
      }
    } catch (err) {
      console.error("AgentContext refresh error:", err);
    } finally {
      this.loading = false;
      cx?.notify?.();
    }
  }

  async selectRule(rule, cx) {
    this.selectedRule = rule;
    if (rule?.path) {
      this.ruleContent = await readRuleContent(rule.path);
    } else {
      this.ruleContent = "";
    }
    cx?.notify?.();
  }

  renderTabButton(t, id, label, iconSvg, count = null, isNarrow = false, isVeryNarrow = false) {
    const on = this.activeTab === id;
    return h_flex()
      .id(`tab-btn-${id}`)
      .h(26)
      .px(isNarrow ? 6 : 8)
      .gap(isNarrow ? 4 : 5)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.activeTab = id;
        cx.notify();
      })
      .when(!isVeryNarrow, (el) => el.child(svg(iconSvg).size(13).flex_none()))
      .child(div().text_size(isNarrow ? 11.5 : 12).font_medium().child(label))
      .when(count !== null && (!isNarrow || on), (el) =>
        el.child(
          div()
            .px(5)
            .h(16)
            .rounded(8)
            .bg(on ? t.raised : t.chrome)
            .text_size(10.5)
            .text_color(on ? t.accent ?? t.foreground : t.dim)
            .flex()
            .items_center()
            .child(String(count))
        )
      );
  }

  renderHeader(t, currentAgent, cwd, agentType = "all", agentLabel = "AI Agent", isNarrow = false, isVeryNarrow = false) {
    const git = this.data.git || {};
    const isFocusedScope = this.scopeMode === "focused" && agentType !== "all";
    const model =
      (agentType !== "all" ? this.data.models?.[agentType] : null) ||
      this.data.models?.claude ||
      "Default Model";

    return v_flex()
      .w_full()
      .p(10)
      .gap(isNarrow ? 4 : 6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(svg("mods/workspace-chrome/layers.svg").size(16).flex_none().text_color(t.accent ?? t.working ?? t.foreground))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(13.5).font_bold().text_color(t.foreground).child("Agent Inspector"))
              )
              .child(
                div()
                  .px(6)
                  .h(18)
                  .flex_none()
                  .rounded(4)
                  .bg((isFocusedScope ? (t.working ?? "#10b981") : (t.accent ?? "#3b82f6")) + "22")
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(isFocusedScope ? (t.working ?? "#10b981") : (t.accent ?? t.foreground))
                  .flex()
                  .items_center()
                  .child(isFocusedScope ? `🎯 ${agentLabel}` : "All Agents")
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .flex_none()
              .child(
                div()
                  .id("btn-toggle-agent-scope")
                  .px(6)
                  .h(20)
                  .rounded(4)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Toggle between current focused Agent context vs All Agents")
                  .on_click((_e, cx) => {
                    this.scopeMode = this.scopeMode === "focused" ? "all" : "focused";
                    this.skillFilter = "all";
                    this.refresh(cx, false);
                  })
                  .flex()
                  .items_center()
                  .child(this.scopeMode === "focused" ? "Show All" : "Follow Agent")
              )
              .child(
                div()
                  .id("btn-refresh-context")
                  .size(22)
                  .rounded(4)
                  .flex()
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("Refresh context")
                  .on_click((_e, cx) => this.refresh(cx, true))
                  .child(svg("mods/workspace-chrome/clock.svg").size(13).text_color(this.loading ? (t.working ?? t.foreground) : t.dim))
              )
              .when(Boolean(this.overlayId), (el) =>
                el.child(
                  div()
                    .id("btn-close-overlay")
                    .size(22)
                    .rounded(4)
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .bg(t.raised)
                    .text_size(11)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => closeOverlay(this.overlayId))
                    .child("✕")
                )
              )
          )
      )
      .child(
        h_flex()
          .w_full()
          .gap(10)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .items_center()
              .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none())
              .child(div().flex_1().min_w(0).truncate().child(cleanPath(cwd) || "No workspace"))
          )
          .when(Boolean(git.isRepo), (el) =>
            el.child(
              h_flex()
                .flex_none()
                .gap(4)
                .items_center()
                .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.accent ?? t.foreground))
                .child(div().text_color(t.foreground).child(git.branch))
                .when(Boolean(git.dirtyCount > 0 && !isVeryNarrow), (del) =>
                  del.child(div().text_color(t.blocked ?? "#f59e0b").child(`• ${git.dirtyCount} modified`))
                )
            )
          )
          .when(!isNarrow, (el) =>
            el.child(
              h_flex()
                .flex_none()
                .gap(4)
                .items_center()
                .child(svg("mods/workspace-chrome/server.svg").size(12).flex_none())
                .child(div().child(model))
            )
          )
      )
      .when(isNarrow, (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(4)
            .items_center()
            .text_size(10.5)
            .text_color(t.dim)
            .child(svg("mods/workspace-chrome/server.svg").size(11).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(model))
        )
      );
  }

  renderOverview(t, isNarrow = false, isVeryNarrow = false) {
    const summary = this.data.summary || {};
    const rules = this.data.rules || [];
    const connectors = this.data.connectors || [];

    return v_flex()
      .w_full()
      .p(12)
      .gap(12)
      .overflow_y_scrollbar()
      // Metric summary grid
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .p(isNarrow ? 8 : 10)
              .rounded(8)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .gap(3)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.activeTab = "rules";
                cx.notify();
              })
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child("Rules")).child(svg("mods/workspace-chrome/file-text.svg").size(14).flex_none().text_color(t.accent ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.rulesCount || 0)))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(10).text_color(t.muted).truncate().child("CLAUDE.md / AGENTS.md"))
              )
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .p(isNarrow ? 8 : 10)
              .rounded(8)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .gap(3)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.activeTab = "skills";
                cx.notify();
              })
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child("Skills")).child(svg("mods/workspace-chrome/layers.svg").size(14).flex_none().text_color(t.working ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.skillsCount || 0)))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(10).text_color(t.muted).truncate().child("Slash commands & tools"))
              )
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .p(isNarrow ? 8 : 10)
              .rounded(8)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .gap(3)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.activeTab = "connectors";
                cx.notify();
              })
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child(isVeryNarrow ? "MCP" : "Connectors")).child(svg("mods/workspace-chrome/server.svg").size(14).flex_none().text_color(t.blocked ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.connectorsCount || 0)))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(10).text_color(t.muted).truncate().child("MCP Servers configured"))
              )
          )
      )
      // Active Instructions Preview Card
      .child(
        v_flex()
          .w_full()
          .p(10)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .gap(8)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(svg("mods/workspace-chrome/file-text.svg").size(13).flex_none().text_color(t.accent ?? t.foreground))
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Active Instructions"))
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.accent ?? t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.activeTab = "rules";
                    cx.notify();
                  })
                  .child("View all →")
              )
          )
          .children(
            rules.slice(0, 3).map((r) =>
              h_flex()
                .w_full()
                .p(8)
                .gap(6)
                .rounded(6)
                .bg(t.chrome)
                .items_center()
                .justify_between()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.activeTab = "rules";
                  this.selectRule(r, cx);
                })
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .px(4)
                        .h(16)
                        .flex_none()
                        .rounded(3)
                        .bg(r.scope === "project" ? (t.working ?? "#10b981") + "22" : (t.accent ?? "#3b82f6") + "22")
                        .text_size(9.5)
                        .font_medium()
                        .text_color(r.scope === "project" ? (t.working ?? "#10b981") : (t.accent ?? "#3b82f6"))
                        .child(r.scope)
                    )
                    .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(r.name))
                    .when(Boolean(r.isSymlink && !isNarrow), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("↳ symlink")))
                )
                .child(
                  div()
                    .flex_none()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(isVeryNarrow ? `${r.lines} lines` : `${r.lines} lines • ${(r.size / 1024).toFixed(1)} KB`)
                )
            )
          )
      )
      // MCP Connectors Preview Card
      .child(
        v_flex()
          .w_full()
          .p(10)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .gap(8)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(svg("mods/workspace-chrome/server.svg").size(13).flex_none().text_color(t.working ?? t.foreground))
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Connected MCP Tools"))
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.accent ?? t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.activeTab = "connectors";
                    cx.notify();
                  })
                  .child("Details →")
              )
          )
          .children(
            connectors.slice(0, 4).map((c) =>
              h_flex()
                .w_full()
                .p(6)
                .px(8)
                .gap(6)
                .rounded(6)
                .bg(t.chrome)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(div().size(6).flex_none().rounded(3).bg(t.working ?? "#10b981"))
                    .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(c.name))
                    .child(
                      div()
                        .px(4)
                        .h(14)
                        .flex_none()
                        .rounded(3)
                        .bg(t.hover)
                        .text_size(9)
                        .text_color(t.dim)
                        .child(c.agent)
                    )
                )
                .when(!isVeryNarrow, (el) =>
                  el.child(div().text_size(10.5).truncate().max_w(isNarrow ? 110 : 200).text_color(t.dim).child(c.command))
                )
            )
          )
      );
  }

  renderRules(t, isNarrow = false, isVeryNarrow = false) {
    const rules = this.data.rules || [];
    return h_flex()
      .w_full()
      .h_full()
      .min_w(0)
      .child(
        // Left rules list
        v_flex()
          .w(isVeryNarrow ? 118 : isNarrow ? 140 : 180)
          .flex_none()
          .h_full()
          .border_r(1)
          .border_color(t.border)
          .p(6)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            rules.map((r, idx) => {
              const on =
                (this.selectedRule?.displayPath || this.selectedRule?.path) ===
                  (r.displayPath || r.path) &&
                (this.selectedRule?.agent || "") === (r.agent || "");
              return v_flex()
                .id(`rule-item-${r.agent || "all"}-${r.scope}-${idx}`)
                .w_full()
                .p(6)
                .rounded(6)
                .gap(2)
                .cursor_pointer()
                .when(on, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.selectRule(r, cx))
                .child(
                  h_flex()
                    .w_full()
                    .min_w(0)
                    .gap(4)
                    .items_center()
                    .justify_between()
                    .child(div().flex_1().min_w(0).truncate().text_size(isVeryNarrow ? 11 : 12).font_medium().text_color(on ? t.foreground : t.muted).child(r.name))
                    .when(!isVeryNarrow, (el) =>
                      el.child(
                        div()
                          .px(4)
                          .h(14)
                          .flex_none()
                          .rounded(3)
                          .bg(r.scope === "project" ? (t.working ?? "#10b981") + "22" : (t.accent ?? "#3b82f6") + "22")
                          .text_size(9)
                          .text_color(r.scope === "project" ? (t.working ?? "#10b981") : (t.accent ?? "#3b82f6"))
                          .child(r.scope)
                      )
                    )
                )
                .child(
                  div()
                    .w_full()
                    .min_w(0)
                    .truncate()
                    .text_size(10)
                    .text_color(t.dim)
                    .child(
                      isVeryNarrow
                        ? `${r.scope} • ${r.lines}L`
                        : `${r.agent ? r.agent + " • " : ""}${r.lines} lines • ${(r.size / 1024).toFixed(1)} KB`
                    )
                );
            })
          )
      )
      .child(
        // Right rule content reader
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .p(isNarrow ? 8 : 10)
          .gap(6)
          .child(
            h_flex()
              .w_full()
              .min_w(0)
              .gap(6)
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color(t.border)
              .pb(6)
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .child(div().w_full().min_w(0).truncate().text_size(13).font_bold().text_color(t.foreground).child(this.selectedRule?.name || "Instructions Viewer"))
                  .child(
                    div()
                      .w_full()
                      .min_w(0)
                      .truncate()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(
                        this.selectedRule?.isSymlink && this.selectedRule?.targetPath
                          ? `${cleanPath(this.selectedRule?.displayPath)} ↳ ${cleanPath(this.selectedRule?.targetPath)}`
                          : cleanPath(this.selectedRule?.displayPath || this.selectedRule?.path) || ""
                      )
                  )
              )
              .child(
                h_flex()
                  .flex_none()
                  .gap(4)
                  .child(
                    div()
                      .px(6)
                      .h(22)
                      .rounded(4)
                      .bg(t.raised)
                      .text_size(11)
                      .text_color(t.foreground)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .tooltip("Copy entire file path")
                      .on_click((_e, cx) => {
                        if (this.selectedRule?.path) {
                          cx.write_to_clipboard(this.selectedRule.path);
                          notify({ title: "Path copied", body: this.selectedRule.path, level: "info" });
                        }
                      })
                      .flex()
                      .items_center()
                      .child(isVeryNarrow ? "Copy" : "Copy Path")
                  )
              )
          )
          .child(
            v_flex()
              .flex_1()
              .w_full()
              .min_w(0)
              .p(isNarrow ? 8 : 10)
              .rounded(6)
              .bg(t.raised)
              .overflow_y_scrollbar()
              .child(
                TextView.markdown(
                  "rule-markdown-preview",
                  this.ruleContent || this.selectedRule?.preview || "No content available"
                ).selectable(true)
              )
          )
      );
  }

  renderSkills(t, isNarrow = false, isVeryNarrow = false) {
    const allSkills = this.data.skills || [];
    const filter = this.skillFilter;
    const skills = filter === "all" ? allSkills : allSkills.filter((s) => s.agent === filter);

    return v_flex()
      .w_full()
      .h_full()
      .p(10)
      .gap(8)
      .child(
        // Filter pills
        h_flex()
          .w_full()
          .gap(4)
          .child(
            div()
              .px(isNarrow ? 6 : 8)
              .h(22)
              .rounded(11)
              .bg(filter === "all" ? t.selected : t.raised)
              .text_size(11)
              .font_medium()
              .text_color(filter === "all" ? t.foreground : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.skillFilter = "all";
                cx.notify();
              })
              .flex()
              .items_center()
              .child(`All (${allSkills.length})`)
          )
          .child(
            div()
              .px(isNarrow ? 6 : 8)
              .h(22)
              .rounded(11)
              .bg(filter === "claude" ? t.selected : t.raised)
              .text_size(11)
              .font_medium()
              .text_color(filter === "claude" ? t.foreground : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.skillFilter = "claude";
                cx.notify();
              })
              .flex()
              .items_center()
              .child(`Claude (${allSkills.filter((s) => s.agent === "claude").length})`)
          )
          .child(
            div()
              .px(isNarrow ? 6 : 8)
              .h(22)
              .rounded(11)
              .bg(filter === "codex" ? t.selected : t.raised)
              .text_size(11)
              .font_medium()
              .text_color(filter === "codex" ? t.foreground : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.skillFilter = "codex";
                cx.notify();
              })
              .flex()
              .items_center()
              .child(`Codex (${allSkills.filter((s) => s.agent === "codex").length})`)
          )
          .child(
            div()
              .px(isNarrow ? 6 : 8)
              .h(22)
              .rounded(11)
              .bg(filter === "antigravity" ? t.selected : t.raised)
              .text_size(11)
              .font_medium()
              .text_color(filter === "antigravity" ? t.foreground : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.skillFilter = "antigravity";
                cx.notify();
              })
              .flex()
              .items_center()
              .child(`${isVeryNarrow ? "AGY" : "Antigravity"} (${allSkills.filter((s) => s.agent === "antigravity").length})`)
          )
      )
      .child(
        // Skills Cards Grid
        v_flex()
          .flex_1()
          .w_full()
          .gap(6)
          .overflow_y_scrollbar()
          .children(
            skills.map((s) => {
              const expanded = this.expandedSkill === s.name;
              return v_flex()
                .id(`skill-${s.name}`)
                .w_full()
                .p(8)
                .rounded(7)
                .bg(t.raised)
                .border(1)
                .border_color(t.border)
                .gap(4)
                .cursor_pointer()
                .hover((st) => st.bg(t.hover))
                .on_click((_e, cx) => {
                  this.expandedSkill = expanded ? null : s.name;
                  cx.notify();
                })
                .child(
                  h_flex()
                    .w_full()
                    .gap(6)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(6)
                        .items_center()
                        .child(svg("mods/workspace-chrome/layers.svg").size(13).flex_none().text_color(t.working ?? t.foreground))
                        .child(div().flex_1().min_w(0).truncate().text_size(12).font_bold().text_color(t.foreground).child(s.name))
                        .child(
                          div()
                            .px(5)
                            .h(15)
                            .flex_none()
                            .rounded(3)
                            .bg(t.chrome)
                            .text_size(9.5)
                            .text_color(t.dim)
                            .child(s.agent)
                        )
                    )
                    .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
                )
                .child(
                  div()
                    .w_full()
                    .min_w(0)
                    .text_size(11)
                    .text_color(t.muted)
                    .when(!expanded, (el) => el.truncate())
                    .when(expanded, (el) => el.whitespace_normal())
                    .child(s.description || "No description provided.")
                )
                .when(expanded && Boolean(s.promptFile), (el) =>
                  el.child(
                    div()
                      .w_full()
                      .min_w(0)
                      .truncate()
                      .mt(4)
                      .p(6)
                      .rounded(4)
                      .bg(t.chrome)
                      .text_size(10)
                      .font_family("monospace")
                      .text_color(t.dim)
                      .child(`Prompt: ${cleanPath(s.promptFile)}`)
                  )
                );
            })
          )
      );
  }

  renderConnectors(t, isNarrow = false, isVeryNarrow = false) {
    const connectors = this.data.connectors || [];
    const plugins = this.data.plugins || [];

    return v_flex()
      .w_full()
      .h_full()
      .p(10)
      .gap(10)
      .overflow_y_scrollbar()
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(svg("mods/workspace-chrome/server.svg").size(14).flex_none().text_color(t.accent ?? t.foreground))
          .child(div().text_size(13).font_bold().text_color(t.foreground).child(`MCP Connectors (${connectors.length})`))
      )
      .children(
        connectors.map((c) =>
          v_flex()
            .w_full()
            .p(8)
            .rounded(8)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .gap(4)
            .child(
              h_flex()
                .w_full()
                .gap(6)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(6)
                    .items_center()
                    .child(div().size(7).flex_none().rounded(4).bg(t.working ?? "#10b981"))
                    .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_bold().text_color(t.foreground).child(c.name))
                    .child(
                      div()
                        .px(5)
                        .h(16)
                        .flex_none()
                        .rounded(3)
                        .bg(t.chrome)
                        .text_size(9.5)
                        .text_color(t.accent ?? t.foreground)
                        .child(c.agent)
                    )
                )
                .when(!isVeryNarrow, (el) =>
                  el.child(div().flex_none().text_size(10).text_color(t.dim).child(`Source: ${c.source}`))
                )
            )
            .child(
              h_flex()
                .w_full()
                .min_w(0)
                .gap(6)
                .items_center()
                .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("Command:"))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .font_family("monospace")
                    .text_color(t.foreground)
                    .child(`${c.command} ${c.args?.join(" ") || ""}`)
                )
            )
        )
      )
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .mt(6)
          .child(svg("mods/workspace-chrome/layers.svg").size(14).flex_none().text_color(t.working ?? t.foreground))
          .child(div().text_size(13).font_bold().text_color(t.foreground).child(`Installed Plugins (${plugins.length})`))
      )
      .children(
        plugins.map((p) =>
          h_flex()
            .w_full()
            .p(6)
            .px(8)
            .gap(6)
            .rounded(6)
            .bg(t.raised)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .flex_1()
                .min_w(0)
                .gap(6)
                .items_center()
                .child(div().size(6).flex_none().rounded(3).bg(t.working ?? "#10b981"))
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(p.name))
            )
            .child(div().flex_none().text_size(10).text_color(t.dim).child(p.agent))
        )
      );
  }

  render(cx) {
    const t = theme();
    const { currentAgent, cwd, agentType, agentLabel } = this.resolveActiveContext();
    const summary = this.data.summary || {};
    const panelWidth = getPanelWidth();
    const isNarrow = panelWidth !== null && panelWidth < 420;
    const isVeryNarrow = panelWidth !== null && panelWidth < 380;

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .child(this.renderHeader(t, currentAgent, cwd, agentType, agentLabel, isNarrow, isVeryNarrow))
      .child(
        // Tabs Navigation Bar
        h_flex()
          .w_full()
          .px(isNarrow ? 6 : 8)
          .py(4)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(this.renderTabButton(t, "overview", "Overview", "mods/workspace-chrome/layers.svg", null, isNarrow, isVeryNarrow))
          .child(this.renderTabButton(t, "rules", "Rules", "mods/workspace-chrome/file-text.svg", summary.rulesCount, isNarrow, isVeryNarrow))
          .child(this.renderTabButton(t, "skills", "Skills", "mods/workspace-chrome/layers.svg", summary.skillsCount, isNarrow, isVeryNarrow))
          .child(this.renderTabButton(t, "connectors", "Connectors", "mods/workspace-chrome/server.svg", summary.connectorsCount, isNarrow, isVeryNarrow))
      )
      .child(
        // Tab View Body
        v_flex()
          .flex_1()
          .w_full()
          .min_h(0)
          .when(this.activeTab === "overview", (el) => el.child(this.renderOverview(t, isNarrow, isVeryNarrow)))
          .when(this.activeTab === "rules", (el) => el.child(this.renderRules(t, isNarrow, isVeryNarrow)))
          .when(this.activeTab === "skills", (el) => el.child(this.renderSkills(t, isNarrow, isVeryNarrow)))
          .when(this.activeTab === "connectors", (el) => el.child(this.renderConnectors(t, isNarrow, isVeryNarrow)))
      );
  }
}
