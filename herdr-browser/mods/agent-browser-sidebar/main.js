// Agent Browser Sidebar Widget for Herdr
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, shared, focused } from "herdr";
import { SHARED_ACTIVE_AGENT, daemonJson, singleFlight, vendorColor, sessionLabel } from "./daemon-client.js";

const ICON_BROWSER = "mods/agent-browser-sidebar/browser.svg";
const POLL_MS = 1500;

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
    run("layout.select", { stack: "work-main-stack", child: "browser-main" });
  }

  render() {
    const t = theme();
    const active = shared(SHARED_ACTIVE_AGENT);
    const focusedTerminal = focused()?.terminal?.toLowerCase() ?? null;
    const live = this.online && this.sessions.length > 0;
    const statusColor = live ? (t.ansi2 ?? "#a6e3a1") : t.dim;

    return v_flex()
      .p(6)
      .gap(4)
      .rounded(6)
      .bg(t.chrome ?? t.surface)
      .border(1)
      .border_color(t.border)
      .child(
        h_flex()
          .px(4)
          .py(2)
          .gap(6)
          .items_center()
          .child(svg(ICON_BROWSER).size(13).flex_none().text_color(statusColor))
          .child(div().flex_1().text_size(11.5).font_bold().child("Agent Browser"))
          .when(live, (el) => el.child(div().text_size(10).font_semibold().text_color(statusColor).child(String(this.sessions.length))))
          .child(div().size(6).rounded(3).bg(statusColor))
      )
      .child(
        live
          ? v_flex()
              .gap(3)
              .children(this.sessions.map((s) => this.renderSession(t, s, s.agentId === active, s.terminal === focusedTerminal)))
          : h_flex()
              .p(6)
              .rounded(4)
              .justify_center()
              .bg(t.surface)
              .cursor_pointer()
              .hover((h) => h.bg(t.hover))
              .on_click(() => this.openBrowser(null))
              .child(div().text_size(10.5).text_color(t.dim).child(this.online ? "No sessions yet →" : "Hub offline →"))
      );
  }

  renderSession(t, s, selected, isFocusedAgent) {
    const color = vendorColor(s, t);
    const background = selected ? (t.selected ?? t.raised) : t.surface;
    let host = s.url;
    try {
      host = new URL(s.url).host || s.url;
    } catch {}
    return v_flex()
      .p(5)
      .gap(2)
      .rounded(4)
      .bg(background)
      .border(1)
      .border_color(isFocusedAgent ? color : background)
      .cursor_pointer()
      .hover((h) => h.bg(t.hover))
      .on_click(() => this.openBrowser(s.agentId))
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .min_w(0)
          .child(div().size(6).rounded(3).flex_none().bg(color))
          .child(div().flex_1().text_size(10).font_semibold().truncate().text_color(color).child(sessionLabel(s)))
          .when(s.driver === "human", (el) => el.child(div().text_size(9).text_color(t.blocked ?? "#f59e0b").child("YOU")))
      )
      .child(div().text_size(10.5).truncate().text_color(t.foreground).child(s.title || host))
      .child(div().text_size(9.5).truncate().text_color(t.dim).child(host));
  }
}
