// Agent Browser Main View for Herdr
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, shared, setShared, home, readTextFile } from "herdr";

const DAEMON_URL = "http://127.0.0.1:9223";
const SHARED_ACTIVE_AGENT = "agent-browser.active-agent";
const FRAMES_DIR = "/tmp/herdr-browser-frames";
const TOKEN_PATH = `${home()}/.config/herdr-browser/token`;
let cachedToken = null;

// Token is re-read after a 401 so a regenerated token doesn't need a mod reload.
async function daemonFetch(path, init = {}) {
  cachedToken ??= (await readTextFile(TOKEN_PATH))?.trim() || null;
  const send = () =>
    fetch(`${DAEMON_URL}${path}`, {
      ...init,
      headers: { ...init.headers, ...(cachedToken && { Authorization: `Bearer ${cachedToken}` }) },
    });
  let res = await send();
  if (res.status === 401) {
    cachedToken = (await readTextFile(TOKEN_PATH))?.trim() || null;
    res = await send();
  }
  return res;
}

export default class AgentBrowserMain extends View {
  init(_props, cx) {
    this.activeAgent = shared(SHARED_ACTIVE_AGENT) || "claude";
    this.session = null;
    this.sessions = [];
    this.inputUrl = "";
    this.isEditingUrl = false;
    this.humanTakeover = false;
    this.lastFrameTime = 0;

    // Refresh every 500ms for smooth live screencast updates
    cx.timer.every(500, (tcx) => {
      this.pollSession(tcx);
    });

    this.pollSession(cx);
  }

  async pollSession(cx) {
    const currentAgent = shared(SHARED_ACTIVE_AGENT) || this.activeAgent || "claude";
    this.activeAgent = currentAgent;

    try {
      const res = await daemonFetch("/sessions", { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const data = await res.json();
        this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        this.session = this.sessions.find((s) => s.agentId === this.activeAgent) || this.sessions[0] || null;
        if (this.session) {
          this.activeAgent = this.session.agentId;
          this.lastFrameTime = this.session.updatedAt || Date.now();
        }
        cx?.notify?.();
      }
    } catch {}
  }

  async navigateTo(url) {
    if (!url) return;
    try {
      await daemonFetch(`/action/${encodeURIComponent(this.activeAgent)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "navigate", url }),
      });
      this.isEditingUrl = false;
      this.pollSession();
    } catch (err) {
      console.error("Navigation failed:", err);
    }
  }

  async reloadPage() {
    try {
      await daemonFetch(`/action/${encodeURIComponent(this.activeAgent)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reload" }),
      });
      this.pollSession();
    } catch {}
  }

  async sendClick(x, y) {
    try {
      await daemonFetch(`/action/${encodeURIComponent(this.activeAgent)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "click", x, y }),
      });
    } catch {}
  }

  backToTerminal() {
    try {
      run("layout.select", { stack: "work-main-stack", child: "main-terminals" });
    } catch (err) {
      console.error("Failed to switch back to terminal:", err);
    }
  }

  selectAgent(agentId) {
    this.activeAgent = agentId;
    setShared(SHARED_ACTIVE_AGENT, agentId);
    this.pollSession();
  }

  render(cx) {
    const t = theme();
    const framePath = `${FRAMES_DIR}/${this.activeAgent}.jpg`;
    const currentUrl = this.session?.url || "about:blank";
    const currentTitle = this.session?.title || "Agent Browser";

    return v_flex()
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .overflow_hidden()
      // Top Control Bar
      .child(
        h_flex()
          .h(38)
          .px(10)
          .gap(8)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome ?? t.surface)
          // Left: Navigation & Terminal Switcher
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                h_flex()
                  .items_center()
                  .gap(4)
                  .px(7)
                  .py(3)
                  .rounded(4)
                  .bg(t.raised)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => this.backToTerminal())
                  .child(svg("mods/workspace-chrome/terminal.svg").size(12).flex_none().text_color(t.muted))
                  .child(div().text_size(11).font_medium().child("Terminal"))
              )
              .child(
                h_flex()
                  .items_center()
                  .justify_center()
                  .size(24)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => this.reloadPage())
                  .child(svg("mods/workspace-chrome/clock.svg").size(13).flex_none().text_color(t.muted))
              )
          )
          // Center: Address Bar
          .child(
            h_flex()
              .flex_1()
              .max_w(560)
              .h(26)
              .px(8)
              .rounded(5)
              .bg(t.surface ?? t.background)
              .border(1)
              .border_color(t.border)
              .items_center()
              .gap(6)
              .child(svg("mods/workspace-chrome/search.svg").size(12).flex_none().text_color(t.dim))
              .child(
                div()
                  .flex_1()
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .truncate()
                  .child(currentUrl)
              )
          )
          // Right: Agent Session Switcher & Status
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .children(
                this.sessions.map((s) => {
                  const isSel = this.activeAgent === s.agentId;
                  const color =
                    s.agentId.includes("claude")
                      ? "#f97316"
                      : s.agentId.includes("codex")
                      ? "#06b6d4"
                      : s.agentId.includes("antigravity") || s.agentId.includes("agy")
                      ? "#a855f7"
                      : t.accent ?? "#89b4fa";

                  return h_flex()
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .cursor_pointer()
                    .bg(isSel ? color + "26" : t.surface)
                    .border(1)
                    .border_color(isSel ? color : "transparent")
                    .items_center()
                    .gap(4)
                    .on_click(() => this.selectAgent(s.agentId))
                    .child(
                      div()
                        .size(6)
                        .rounded(3)
                        .bg(color)
                    )
                    .child(
                      div()
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(isSel ? color : t.muted)
                        .child(s.agentId.toUpperCase())
                    );
                })
              )
              .child(
                h_flex()
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(this.humanTakeover ? (t.blocked ?? "#f59e0b") + "22" : (t.ansi2 ?? "#a6e3a1") + "22")
                  .items_center()
                  .gap(4)
                  .cursor_pointer()
                  .on_click(() => {
                    this.humanTakeover = !this.humanTakeover;
                    cx.notify();
                  })
                  .child(
                    div()
                      .size(6)
                      .rounded(3)
                      .bg(this.humanTakeover ? (t.blocked ?? "#f59e0b") : (t.ansi2 ?? "#a6e3a1"))
                  )
                  .child(
                    div()
                      .text_size(10)
                      .font_semibold()
                      .text_color(this.humanTakeover ? (t.blocked ?? "#f59e0b") : (t.ansi2 ?? "#a6e3a1"))
                      .child(this.humanTakeover ? "Takeover" : "AI Driving")
                  )
              )
          )
      )
      // Main Canvas Viewport
      .child(
        v_flex()
          .flex_1()
          .size_full()
          .bg("#11111b")
          .items_center()
          .justify_center()
          .overflow_hidden()
          .child(
            this.session?.hasFrame
              ? image(framePath).size_full()
              : v_flex()
                  .gap(10)
                  .items_center()
                  .justify_center()
                  .p(24)
                  .child(svg("mods/agent-browser-sidebar/browser.svg").size(36).text_color(t.accent ?? "#89b4fa"))
                  .child(div().text_size(15).font_bold().text_color(t.foreground).child("Agent Browser Hub Ready"))
                  .child(
                    div()
                      .max_w(460)
                      .text_size(12)
                      .text_color(t.muted)
                      .text_center()
                      .child(
                        "All browser actions from Claude Code, Codex, and Antigravity run inside isolated sessions here. No rogue windows will pop up on your desktop."
                      )
                  )
                  .child(
                    h_flex()
                      .gap(8)
                      .pt(8)
                      .child(
                        h_flex()
                          .px(10)
                          .py(4)
                          .rounded(4)
                          .bg(t.surface)
                          .border(1)
                          .border_color(t.border)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click(() => this.navigateTo("http://localhost:3000"))
                          .child(div().text_size(11).text_color(t.foreground).child("localhost:3000"))
                      )
                      .child(
                        h_flex()
                          .px(10)
                          .py(4)
                          .rounded(4)
                          .bg(t.surface)
                          .border(1)
                          .border_color(t.border)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click(() => this.navigateTo("http://localhost:5173"))
                          .child(div().text_size(11).text_color(t.foreground).child("localhost:5173"))
                      )
                  )
          )
      );
  }
}
