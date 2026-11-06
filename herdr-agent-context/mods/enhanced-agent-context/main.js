import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, focused, panes, spaces, agents, terminals, notify } from "herdr";
import { fetchAgentContext, readRuleContent } from "./collector.js";

function cleanPath(p) {
  if (!p) return "";
  const home = "/Users/dev";
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export default class EnhancedAgentContext extends View {
  init(_props, cx) {
    this.activeTab = "overview"; // overview | rules | skills | connectors | plugins
    this.selectedRule = null;
    this.ruleContent = "";
    this.skillFilter = "all"; // all | claude | codex | antigravity
    this.expandedSkill = null;
    this.loading = false;
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

    // Auto-refresh when pane focus changes
    cx.timer.every(4000, (timerCx) => {
      this.refresh(timerCx, false);
    });

    this.refresh(cx, true);
  }

  resolveActiveContext() {
    const focus = focused();
    const allAgents = agents();
    const currentAgent = focus?.agent ? allAgents.find((a) => a.address === focus.agent) : allAgents[0];
    const cwd = currentAgent?.cwd || panes().find((p) => p.focused && p.cwd)?.cwd || spaces().find((s) => s.active)?.cwd || "";
    const agentType = (currentAgent?.program?.key || currentAgent?.agent || "all").toLowerCase();
    return { currentAgent, cwd, agentType };
  }

  async refresh(cx, force = false) {
    const { cwd, agentType } = this.resolveActiveContext();
    this.loading = true;
    cx?.notify?.();

    try {
      const result = await fetchAgentContext(cwd, agentType, force);
      if (result) {
        this.data = result;
        // Default select first rule if not selected
        if (!this.selectedRule && this.data.rules?.length > 0) {
          this.selectRule(this.data.rules[0], cx);
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

  renderTabButton(t, id, label, iconSvg, count = null) {
    const on = this.activeTab === id;
    return h_flex()
      .id(`tab-btn-${id}`)
      .h(26)
      .px(8)
      .gap(5)
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
      .child(svg(iconSvg).size(13).flex_none())
      .child(div().text_size(12).font_medium().child(label))
      .when(count !== null, (el) =>
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

  renderHeader(t, currentAgent, cwd) {
    const git = this.data.git || {};
    const agentName = currentAgent?.name || currentAgent?.program?.name || "AI Agent";
    const agentKey = (currentAgent?.program?.key || currentAgent?.agent || "agent").toLowerCase();
    const model = this.data.models?.[agentKey] || this.data.models?.claude || "Default Model";

    return v_flex()
      .w_full()
      .p(10)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(svg("mods/workspace-chrome/layers.svg").size(16).text_color(t.accent ?? t.working ?? t.foreground))
              .child(div().text_size(14).font_bold().text_color(t.foreground).child("Agent Inspector"))
              .child(
                div()
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .bg((t.accent ?? "#3b82f6") + "22")
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.accent ?? t.foreground)
                  .child(agentName)
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
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
          )
      )
      .child(
        h_flex()
          .w_full()
          .gap(12)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(svg("mods/workspace-chrome/folder.svg").size(12))
              .child(div().truncate().child(cleanPath(cwd) || "No workspace"))
          )
          .when(git.isRepo, (el) =>
            el.child(
              h_flex()
                .gap(4)
                .items_center()
                .child(svg("mods/workspace-chrome/git-branch.svg").size(12).text_color(t.accent ?? t.foreground))
                .child(div().text_color(t.foreground).child(git.branch))
                .when(git.dirtyCount > 0, (del) => del.child(div().text_color(t.blocked ?? "#f59e0b").child(`• ${git.dirtyCount} modified`)))
            )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(svg("mods/workspace-chrome/server.svg").size(12))
              .child(div().child(model))
          )
      );
  }

  renderOverview(t) {
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
              .p(10)
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
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child("Rules")).child(svg("mods/workspace-chrome/file-text.svg").size(14).text_color(t.accent ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.rulesCount || 0)))
              .child(div().text_size(10).text_color(t.muted).child("CLAUDE.md / AGENTS.md"))
          )
          .child(
            v_flex()
              .flex_1()
              .p(10)
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
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child("Skills")).child(svg("mods/workspace-chrome/layers.svg").size(14).text_color(t.working ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.skillsCount || 0)))
              .child(div().text_size(10).text_color(t.muted).child("Slash commands & tools"))
          )
          .child(
            v_flex()
              .flex_1()
              .p(10)
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
              .child(h_flex().items_center().justify_between().child(div().text_size(11).text_color(t.dim).child("Connectors")).child(svg("mods/workspace-chrome/server.svg").size(14).text_color(t.blocked ?? t.foreground)))
              .child(div().text_size(20).font_bold().text_color(t.foreground).child(String(summary.connectorsCount || 0)))
              .child(div().text_size(10).text_color(t.muted).child("MCP Servers configured"))
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
                  .child(svg("mods/workspace-chrome/file-text.svg").size(13).text_color(t.accent ?? t.foreground))
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
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .px(4)
                        .h(16)
                        .rounded(3)
                        .bg(r.scope === "project" ? (t.working ?? "#10b981") + "22" : (t.accent ?? "#3b82f6") + "22")
                        .text_size(9.5)
                        .font_medium()
                        .text_color(r.scope === "project" ? (t.working ?? "#10b981") : (t.accent ?? "#3b82f6"))
                        .child(r.scope)
                    )
                    .child(div().text_size(12).font_medium().text_color(t.foreground).child(r.name))
                    .when(r.isSymlink, (el) => el.child(div().text_size(10).text_color(t.dim).child("↳ symlink")))
                )
                .child(div().text_size(11).text_color(t.dim).child(`${r.lines} lines • ${(r.size / 1024).toFixed(1)} KB`))
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
                  .child(svg("mods/workspace-chrome/server.svg").size(13).text_color(t.working ?? t.foreground))
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
                .rounded(6)
                .bg(t.chrome)
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().size(6).rounded(3).bg(t.working ?? "#10b981"))
                    .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(c.name))
                    .child(
                      div()
                        .px(4)
                        .h(14)
                        .rounded(3)
                        .bg(t.hover)
                        .text_size(9)
                        .text_color(t.dim)
                        .child(c.agent)
                    )
                )
                .child(div().text_size(10.5).truncate().max_w(200).text_color(t.dim).child(c.command))
            )
          )
      );
  }

  renderRules(t) {
    const rules = this.data.rules || [];
    return h_flex()
      .w_full()
      .h_full()
      .child(
        // Left rules list
        v_flex()
          .w(180)
          .h_full()
          .border_r(1)
          .border_color(t.border)
          .p(6)
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            rules.map((r) => {
              const on = this.selectedRule?.path === r.path;
              return v_flex()
                .id(`rule-item-${r.name}`)
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
                    .items_center()
                    .justify_between()
                    .child(div().text_size(12).font_medium().text_color(on ? t.foreground : t.muted).child(r.name))
                    .child(
                      div()
                        .px(4)
                        .h(14)
                        .rounded(3)
                        .bg(r.scope === "project" ? (t.working ?? "#10b981") + "22" : (t.accent ?? "#3b82f6") + "22")
                        .text_size(9)
                        .text_color(r.scope === "project" ? (t.working ?? "#10b981") : (t.accent ?? "#3b82f6"))
                        .child(r.scope)
                    )
                )
                .child(div().text_size(10).text_color(t.dim).child(`${r.lines} lines • ${(r.size / 1024).toFixed(1)} KB`));
            })
          )
      )
      .child(
        // Right rule content reader
        v_flex()
          .flex_1()
          .h_full()
          .p(10)
          .gap(6)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color(t.border)
              .pb(6)
              .child(
                v_flex()
                  .child(div().text_size(13).font_bold().text_color(t.foreground).child(this.selectedRule?.name || "Instructions Viewer"))
                  .child(div().text_size(10.5).text_color(t.dim).child(cleanPath(this.selectedRule?.path) || ""))
              )
              .child(
                h_flex()
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
                      .on_click((_e, _cx) => {
                        if (this.selectedRule?.path) {
                          notify({ title: "Path copied", body: this.selectedRule.path, level: "info" });
                        }
                      })
                      .flex()
                      .items_center()
                      .child("Copy Path")
                  )
              )
          )
          .child(
            v_flex()
              .flex_1()
              .w_full()
              .p(8)
              .rounded(6)
              .bg(t.raised)
              .overflow_y_scrollbar()
              .child(
                div()
                  .text_size(11.5)
                  .font_family("monospace")
                  .text_color(t.foreground)
                  .whitespace_pre_wrap()
                  .child(this.ruleContent || this.selectedRule?.preview || "No content available")
              )
          )
      );
  }

  renderSkills(t) {
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
              .px(8)
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
              .px(8)
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
              .px(8)
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
              .px(8)
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
              .child(`Antigravity (${allSkills.filter((s) => s.agent === "antigravity").length})`)
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
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(svg("mods/workspace-chrome/layers.svg").size(13).text_color(t.working ?? t.foreground))
                        .child(div().text_size(12).font_bold().text_color(t.foreground).child(s.name))
                        .child(
                          div()
                            .px(5)
                            .h(15)
                            .rounded(3)
                            .bg(t.chrome)
                            .text_size(9.5)
                            .text_color(t.dim)
                            .child(s.agent)
                        )
                    )
                    .child(svg(`mods/workspace-chrome/chevron-${expanded ? "down" : "right"}.svg`).size(12).text_color(t.dim))
                )
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.muted)
                    .when(!expanded, (el) => el.line_clamp(2))
                    .child(s.description || "No description provided.")
                )
                .when(expanded && Boolean(s.promptFile), (el) =>
                  el.child(
                    div()
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

  renderConnectors(t) {
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
          .child(svg("mods/workspace-chrome/server.svg").size(14).text_color(t.accent ?? t.foreground))
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
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().size(7).rounded(4).bg(t.working ?? "#10b981"))
                    .child(div().text_size(12.5).font_bold().text_color(t.foreground).child(c.name))
                    .child(
                      div()
                        .px(5)
                        .h(16)
                        .rounded(3)
                        .bg(t.chrome)
                        .text_size(9.5)
                        .text_color(t.accent ?? t.foreground)
                        .child(c.agent)
                    )
                )
                .child(div().text_size(10).text_color(t.dim).child(`Source: ${c.source}`))
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("Command:"))
                .child(
                  div()
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
          .child(svg("mods/workspace-chrome/layers.svg").size(14).text_color(t.working ?? t.foreground))
          .child(div().text_size(13).font_bold().text_color(t.foreground).child(`Installed Plugins (${plugins.length})`))
      )
      .children(
        plugins.map((p) =>
          h_flex()
            .w_full()
            .p(6)
            .px(8)
            .rounded(6)
            .bg(t.raised)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().size(6).rounded(3).bg(t.working ?? "#10b981"))
                .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(p.name))
            )
            .child(div().text_size(10).text_color(t.dim).child(p.agent))
        )
      );
  }

  render(cx) {
    const t = theme();
    const { currentAgent, cwd } = this.resolveActiveContext();
    const summary = this.data.summary || {};

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .child(this.renderHeader(t, currentAgent, cwd))
      .child(
        // Tabs Navigation Bar
        h_flex()
          .w_full()
          .px(8)
          .py(4)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(this.renderTabButton(t, "overview", "Overview", "mods/workspace-chrome/layers.svg"))
          .child(this.renderTabButton(t, "rules", "Rules", "mods/workspace-chrome/file-text.svg", summary.rulesCount))
          .child(this.renderTabButton(t, "skills", "Skills", "mods/workspace-chrome/layers.svg", summary.skillsCount))
          .child(this.renderTabButton(t, "connectors", "Connectors", "mods/workspace-chrome/server.svg", summary.connectorsCount))
      )
      .child(
        // Tab View Body
        v_flex()
          .flex_1()
          .w_full()
          .min_h(0)
          .when(this.activeTab === "overview", () => this.renderOverview(t))
          .when(this.activeTab === "rules", () => this.renderRules(t))
          .when(this.activeTab === "skills", () => this.renderSkills(t))
          .when(this.activeTab === "connectors", () => this.renderConnectors(t))
      );
  }
}
