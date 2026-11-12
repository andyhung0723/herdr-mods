// Agent Browser section for Herdr's sidebar.
// Mirrors the Agents section (header, row metrics, rail mode) so it reads as part of the same list.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, shared, agents, layout } from "herdr";
import { SHARED_ACTIVE_AGENT, daemonJson, singleFlight, vendorColor, sessionLabel } from "./daemon-client.js";

const ICON_BROWSER = "mods/agent-browser-sidebar/browser.svg";
const POLL_MS = 1500;
const STACK_ID = "work-main-stack";
const BROWSER_BLOCK_ID = "browser-main";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same rule as the Agents section: the sidebar is a rail when narrower than 160px.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const browserShown = () => find(layout(), STACK_ID)?.active === BROWSER_BLOCK_ID;

function programIcon(program, size, color) {
  if (!program?.icon) return svg(ICON_BROWSER).size(size).flex_none().text_color(color);
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).w(size).h(size).flex_none();
}

// The icon already says which agent; the name says where it lives, like an Agents row.
function rowName(session, agent) {
  if (agent) return `${agent.space_name} · ${agent.tab_name}`;
  return sessionLabel(session);
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export default class AgentBrowserSidebar extends View {
  init(_props, cx) {
    this.sessions = [];
    this.online = false;
    this.dirty = true;
    this.poll = singleFlight(() => this.refreshSessions());

    cx.timer.every(POLL_MS, (tcx) => {
      this.poll();
      if (this.dirty) {
        this.dirty = false;
        tcx.notify();
      }
    });
    this.poll();
  }

  async refreshSessions() {
    try {
      const data = await daemonJson("/sessions");
      this.sessions = data.sessions;
      this.online = true;
    } catch {
      this.sessions = [];
      this.online = false;
    }
    this.dirty = true;
  }

  openBrowser(agentId) {
    if (agentId) setShared(SHARED_ACTIVE_AGENT, agentId);
    run("layout.select", { stack: STACK_ID, child: BROWSER_BLOCK_ID });
  }

  render() {
    const t = theme();
    const rail = narrow();
    const agentByTerminal = new Map(agents().map((a) => [a.address.toLowerCase(), a]));
    const activeId = browserShown() ? shared(SHARED_ACTIVE_AGENT) : null;
    const rows = this.sessions.map((s) => {
      const agent = agentByTerminal.get(s.terminal);
      const ctx = { t, program: agent?.program, name: rowName(s, agent), selected: s.agentId === activeId };
      return rail ? this.railRow(s, ctx) : this.row(s, ctx);
    });

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!rail, (el) => el.child(this.header(t)))
      .when(!rail && rows.length === 0, (el) =>
        el.child(
          div()
            .px(16)
            .text_size(12)
            .text_color(t.dim)
            .child(this.online ? "Agents' browser sessions show up here." : "Browser hub offline. It starts on an agent's first browser tool call.")
        )
      )
      .child(v_flex().id("ab-list").flex_1().min_h(0).px(rail ? 0 : 8).overflow_y_scrollbar().children(rows));
  }

  header(t) {
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .justify_between()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Browser"))
      .child(
        div()
          .id("ab-open")
          .text_size(11)
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .tooltip("Open the browser view")
          .on_click(() => this.openBrowser(null))
          .child(svg(ICON_BROWSER).size(14))
      );
  }

  row(s, { t, program, name, selected }) {
    const human = s.driver === "human";
    return h_flex()
      .id(`ab-${s.agentId}`)
      .px(8)
      .h(42)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(selected, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(s.url)
      .on_click(() => this.openBrowser(s.agentId))
      .child(programIcon(program, 16, vendorColor(s, t)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().truncate().text_color(t.foreground).child(name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(s.title ? `${s.title} · ${hostOf(s.url)}` : hostOf(s.url)))
      )
      .when(human, (el) =>
        el.child(
          div()
            .flex_none()
            .px(6)
            .h(18)
            .rounded(5)
            .bg((t.blocked ?? "#f59e0b") + "26")
            .text_size(10.5)
            .font_semibold()
            .text_color(t.blocked ?? "#f59e0b")
            .flex()
            .items_center()
            .child("You")
        )
      );
  }

  railRow(s, { t, program, selected }) {
    return h_flex()
      .id(`ab-${s.agentId}`)
      .h(26)
      .flex_none()
      .items_center()
      .justify_center()
      .when(selected, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(`${sessionLabel(s)} — ${s.title || hostOf(s.url)}`)
      .on_click(() => this.openBrowser(s.agentId))
      .child(programIcon(program, 16, vendorColor(s, t)));
  }
}
