// Agent Browser Sidebar Widget for Herdr
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, shared } from "herdr";

const DAEMON_URL = "http://127.0.0.1:9223";
const ICON_BROWSER = "mods/agent-browser-sidebar/browser.svg";
const SHARED_ACTIVE_AGENT = "agent-browser.active-agent";

export default class AgentBrowserSidebar extends View {
  init(_props, cx) {
    this.sessions = [];
    this.loading = false;
    this.activeAgent = shared(SHARED_ACTIVE_AGENT) || "default";

    // Poll daemon sessions every 1.5 seconds
    cx.timer.every(1500, (tcx) => {
      this.refreshSessions(tcx);
    });

    this.refreshSessions(cx);
  }

  async refreshSessions(cx) {
    try {
      const res = await fetch(`${DAEMON_URL}/sessions`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        cx?.notify?.();
      }
    } catch {
      // Daemon might be offline or starting
      this.sessions = [];
    }
  }

  switchToBrowser(agentId) {
    const targetAgent = agentId || (this.sessions[0]?.agentId || "default");
    setShared(SHARED_ACTIVE_AGENT, targetAgent);
    this.activeAgent = targetAgent;

    // Switch central main panel to browser view!
    try {
      run("layout.select", { stack: "work-main-stack", child: "browser-main" });
    } catch (err) {
      console.error("Failed to select browser-main in work-main-stack:", err);
    }
  }

  async launchNewSession(agentId = "default") {
    try {
      await fetch(`${DAEMON_URL}/session/${agentId}`, { method: "POST" });
      this.switchToBrowser(agentId);
    } catch (err) {
      console.error("Failed to launch session:", err);
    }
  }

  render(cx) {
    const t = theme();
    const hasSessions = this.sessions.length > 0;

    return v_flex()
      .p(6)
      .gap(4)
      .rounded(6)
      .bg(t.chrome ?? t.surface)
      .border(1)
      .border_color(t.border)
      // Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .px(4)
          .py(2)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(svg(ICON_BROWSER).size(13).flex_none().text_color(hasSessions ? (t.ansi2 ?? "#a6e3a1") : t.muted))
              .child(div().text_size(11.5).font_bold().text_color(t.foreground).child("Agent Browser"))
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .when(hasSessions, (el) =>
                el.child(
                  div()
                    .px(5)
                    .h(16)
                    .rounded(8)
                    .bg(t.raised)
                    .text_size(10)
                    .font_semibold()
                    .text_color(t.ansi2 ?? "#a6e3a1")
                    .child(String(this.sessions.length))
                )
              )
              .child(
                div()
                  .size(6)
                  .rounded(3)
                  .bg(hasSessions ? (t.ansi2 ?? "#a6e3a1") : t.dim)
              )
          )
      )
      // Sessions List
      .child(
        hasSessions
          ? v_flex().gap(3).children(
              this.sessions.map((s) => {
                const isSelected = this.activeAgent === s.agentId;
                const agentBadgeColor =
                  s.agentId.includes("claude")
                    ? "#f97316"
                    : s.agentId.includes("codex")
                    ? "#06b6d4"
                    : s.agentId.includes("antigravity") || s.agentId.includes("agy")
                    ? "#a855f7"
                    : t.accent ?? "#89b4fa";

                let domain = "";
                try {
                  domain = new URL(s.url).hostname || s.url;
                } catch {
                  domain = s.url || "about:blank";
                }

                return h_flex()
                  .p(5)
                  .rounded(4)
                  .bg(isSelected ? (t.selected ?? "#334155") : t.surface)
                  .border(1)
                  .border_color(isSelected ? (t.accent ?? t.border) : "transparent")
                  .items_center()
                  .justify_between()
                  .gap(4)
                  .cursor_pointer()
                  .hover((h) => h.bg(t.hover))
                  .on_click(() => this.switchToBrowser(s.agentId))
                  .child(
                    h_flex()
                      .items_center()
                      .gap(5)
                      .min_w(0)
                      .flex_1()
                      .child(
                        div()
                          .px(4)
                          .py(1)
                          .rounded(3)
                          .bg(agentBadgeColor + "22")
                          .text_size(9)
                          .font_bold()
                          .text_color(agentBadgeColor)
                          .child(s.agentId.toUpperCase())
                      )
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(t.foreground)
                          .truncate()
                          .child(s.title || domain)
                      )
                  );
              })
            )
          : h_flex()
              .p(6)
              .items_center()
              .justify_center()
              .rounded(4)
              .bg(t.surface)
              .cursor_pointer()
              .hover((h) => h.bg(t.hover))
              .on_click(() => this.launchNewSession("default"))
              .child(div().text_size(10.5).text_color(t.dim).child("Open Agent Browser →"))
      );
  }
}
