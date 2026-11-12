// Agent Browser Main View for Herdr
//
// Frames: the daemon screencasts only while this view polls /frame. Each new
// JPEG is written under the app home with a fresh file name, because image()
// only resolves app-relative paths and caches decoded images by path.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, shared, setShared, appHome } from "herdr";
import { Buffer } from "buffer";
import fs from "fs/promises";
import { SHARED_ACTIVE_AGENT, daemonJson, postAction, singleFlight, vendorColor, sessionLabel } from "./daemon-client.js";

const ICON_BROWSER = "mods/agent-browser-main/browser.svg";
const FRAME_DIR = "cache/agent-browser";
const FRAMES_KEPT = 3;
const TICK_MS = 200;
const SESSION_POLL_TICKS = 5;
// GPUI skips render() for a view that isn't on screen; no render for this long means hidden.
const HIDDEN_AFTER_MS = 1500;
const NOTICE_MS = 2500;

export default class AgentBrowserMain extends View {
  init(_props, cx) {
    this.sessions = [];
    this.daemonError = null;
    this.activeAgent = shared(SHARED_ACTIVE_AGENT) || null;

    this.frame = null; // { path, seq, width, height }
    this.frameFiles = [];
    this.frameCounter = Date.now();
    this.canvasSize = null;

    this.pendingScroll = { dx: 0, dy: 0 };
    this.inputQueue = Promise.resolve();
    this.notice = null;

    this.tick = 0;
    this.dirty = true;
    this.lastRenderAt = Date.now();
    this.canvasFocus = cx.focus_handle();

    this.pollSessions = singleFlight(() => this.refreshSessions());
    this.pollFrame = singleFlight(() => this.refreshFrame());
    this.clearStaleFrames();

    cx.timer.every(TICK_MS, (tcx) => this.onTick(tcx));
    this.pollSessions();
  }

  // Async work only marks the view dirty; notify happens synchronously on the next tick.
  onTick(cx) {
    this.tick += 1;
    if (this.tick % SESSION_POLL_TICKS === 0) this.pollSessions();
    if (this.isVisible()) this.pollFrame();
    this.flushScroll();
    if (this.notice && Date.now() > this.notice.until) {
      this.notice = null;
      this.dirty = true;
    }
    if (this.dirty || this.tick % SESSION_POLL_TICKS === 0) {
      this.dirty = false;
      cx.notify();
    }
  }

  isVisible() {
    return Date.now() - this.lastRenderAt < HIDDEN_AFTER_MS;
  }

  get session() {
    return this.sessions.find((s) => s.agentId === this.activeAgent) ?? null;
  }

  // ── daemon polling ───────────────────────────────────────────────────────

  async refreshSessions() {
    try {
      const data = await daemonJson("/sessions");
      this.sessions = data.sessions;
      this.daemonError = null;
    } catch (err) {
      this.sessions = [];
      this.daemonError = String(err?.message ?? err);
    }
    const ids = new Set(this.sessions.map((s) => s.agentId));
    const wanted = shared(SHARED_ACTIVE_AGENT);
    const next = ids.has(wanted) ? wanted : ids.has(this.activeAgent) ? this.activeAgent : (this.sessions[0]?.agentId ?? null);
    if (next !== this.activeAgent) this.selectAgent(next);
    this.dirty = true;
  }

  async refreshFrame() {
    const agentId = this.activeAgent;
    if (!agentId || !this.session) return;
    const after = this.frame?.agentId === agentId ? this.frame.seq : 0;
    let data;
    try {
      data = await daemonJson(`/frame/${encodeURIComponent(agentId)}?after=${after}`);
    } catch {
      return;
    }
    if (!data.changed || agentId !== this.activeAgent) return;

    const name = `f-${(this.frameCounter++).toString(36)}.jpg`;
    await fs.writeFile(`${appHome()}/${FRAME_DIR}/${name}`, new Uint8Array(Buffer.from(data.frame, "base64")));
    this.frame = { agentId, path: `${FRAME_DIR}/${name}`, seq: data.seq, width: data.width, height: data.height };
    this.frameFiles.push(name);
    for (const old of this.frameFiles.splice(0, Math.max(0, this.frameFiles.length - FRAMES_KEPT))) {
      fs.unlink(`${appHome()}/${FRAME_DIR}/${old}`).catch(() => {});
    }
    this.dirty = true;
  }

  async clearStaleFrames() {
    await fs.mkdir(`${appHome()}/${FRAME_DIR}`, { recursive: true }).catch(() => {});
    try {
      for (const name of await fs.readdir(`${appHome()}/${FRAME_DIR}`)) {
        if (name.startsWith("f-")) await fs.unlink(`${appHome()}/${FRAME_DIR}/${name}`).catch(() => {});
      }
    } catch {}
  }

  // ── commands ─────────────────────────────────────────────────────────────

  selectAgent(agentId) {
    this.activeAgent = agentId;
    if (agentId) setShared(SHARED_ACTIVE_AGENT, agentId);
    this.frame = null;
    this.dirty = true;
  }

  showNotice(text) {
    this.notice = { text, until: Date.now() + NOTICE_MS };
    this.dirty = true;
  }

  send(payload) {
    const agentId = this.activeAgent;
    if (!agentId) return;
    // Input must reach the page in order, so actions are chained rather than dropped.
    this.inputQueue = this.inputQueue
      .then(() => postAction(agentId, payload))
      .then(() => this.pollSessions())
      .catch((err) => this.showNotice(String(err?.message ?? err)));
  }

  toggleTakeover() {
    const session = this.session;
    if (!session) return;
    const driver = session.driver === "human" ? "agent" : "human";
    session.driver = driver; // optimistic; next poll reconciles
    this.send({ action: "set_driver", driver });
    if (driver === "human") this.canvasFocus.focus();
  }

  backToTerminal() {
    run("layout.select", { stack: "work-main-stack", child: "main-terminals" });
  }

  // ── canvas input (human takeover only) ───────────────────────────────────

  isHumanDriving() {
    return this.session?.driver === "human";
  }

  toPagePoint(event) {
    const { local_position: p, bounds: b } = event;
    if (!p || !b?.width || !b?.height || !this.frame) return null;
    return { x: (p.x / b.width) * this.frame.width, y: (p.y / b.height) * this.frame.height };
  }

  onCanvasMouseDown(event) {
    if (!this.isHumanDriving()) {
      this.showNotice("AI is driving. Click “AI Driving” to take over.");
      return;
    }
    this.canvasFocus.focus();
    const point = this.toPagePoint(event);
    if (point) this.send({ action: "click", ...point, clickCount: event.click_count || 1 });
  }

  onCanvasScroll(event) {
    if (!this.isHumanDriving()) return;
    // GPUI reports positive y when content should move down (scrolling up).
    this.pendingScroll.dx -= event.delta.x;
    this.pendingScroll.dy -= event.delta.y;
  }

  flushScroll() {
    const { dx, dy } = this.pendingScroll;
    if (!dx && !dy) return;
    this.pendingScroll = { dx: 0, dy: 0 };
    this.send({ action: "scroll", dx, dy });
  }

  onCanvasKey(event, cx) {
    if (!this.isHumanDriving()) return;
    const m = event.modifiers;
    // Platform shortcuts (cmd-…) stay with Herdr.
    if (m.platform) return;
    const chord = [m.control && "Control", m.alt && "Alt", m.shift && "Shift", event.key].filter(Boolean).join("+");
    this.send({ action: "press_key", key: chord, text: m.control || m.alt ? undefined : event.key_char });
    cx.stop_propagation();
  }

  fittedFrameSize() {
    const c = this.canvasSize;
    const f = this.frame;
    if (!c || !f) return null;
    const scale = Math.min(c.width / f.width, c.height / f.height);
    return { width: Math.floor(f.width * scale), height: Math.floor(f.height * scale) };
  }

  // ── render ───────────────────────────────────────────────────────────────

  render(cx) {
    this.lastRenderAt = Date.now();
    const t = theme();
    return v_flex()
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .overflow_hidden()
      .child(this.renderToolbar(t))
      .child(this.renderCanvas(t, cx));
  }

  renderToolbar(t) {
    const session = this.session;
    const human = session?.driver === "human";
    const driverColor = human ? (t.blocked ?? "#f59e0b") : (t.ansi2 ?? "#a6e3a1");
    const navButton = (glyph, action) =>
      h_flex()
        .size(24)
        .items_center()
        .justify_center()
        .rounded(4)
        .text_size(13)
        .text_color(session ? t.muted : t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => session && this.send({ action }))
        .child(glyph);

    return h_flex()
      .h(38)
      .px(10)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome ?? t.surface)
      .child(
        h_flex()
          .px(8)
          .py(3)
          .rounded(4)
          .bg(t.raised)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.backToTerminal())
          .child(div().text_size(11).font_medium().child("← Terminal"))
      )
      .child(navButton("‹", "back"))
      .child(navButton("›", "forward"))
      .child(navButton("↻", "reload"))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .h(26)
          .px(8)
          .rounded(5)
          .bg(t.surface ?? t.background)
          .border(1)
          .border_color(t.border)
          .items_center()
          .child(div().flex_1().text_size(11.5).truncate().child(session?.url ?? "No session"))
      )
      .children(this.sessions.map((s) => this.renderSessionTab(t, s)))
      .when(Boolean(session), (el) =>
        el.child(
          h_flex()
            .px(6)
            .py(2)
            .gap(4)
            .rounded(4)
            .items_center()
            .bg(driverColor + "22")
            .cursor_pointer()
            .on_click(() => this.toggleTakeover())
            .child(div().size(6).rounded(3).bg(driverColor))
            .child(div().text_size(10).font_semibold().text_color(driverColor).child(human ? "You're driving" : "AI Driving"))
        )
      );
  }

  renderSessionTab(t, s) {
    const selected = s.agentId === this.activeAgent;
    const color = vendorColor(s, t);
    return h_flex()
      .px(6)
      .py(2)
      .gap(4)
      .rounded(4)
      .items_center()
      .max_w(180)
      .cursor_pointer()
      .bg(selected ? color + "26" : t.surface)
      .border(1)
      .border_color(selected ? color : t.surface)
      .on_click(() => this.selectAgent(s.agentId))
      .child(div().size(6).rounded(3).flex_none().bg(color))
      .child(div().text_size(10.5).font_semibold().truncate().text_color(selected ? color : t.muted).child(sessionLabel(s)));
  }

  renderCanvas(t, cx) {
    const fitted = this.fittedFrameSize();
    const human = this.isHumanDriving();
    return v_flex()
      .id("agent-browser-canvas")
      .flex_1()
      .min_h(0)
      .w_full()
      .bg(t.canvas ?? "#11111b")
      .items_center()
      .justify_center()
      .overflow_hidden()
      .on_size_change((size, scx) => {
        this.canvasSize = size;
        scx.notify();
      })
      .child(
        this.frame && fitted
          ? div()
              .w(fitted.width)
              .h(fitted.height)
              .flex_none()
              .border(human ? 2 : 0)
              .border_color(t.blocked ?? "#f59e0b")
              .track_focus(this.canvasFocus)
              .on_mouse_down("left", (e) => this.onCanvasMouseDown(e))
              .on_scroll_wheel((e) => this.onCanvasScroll(e))
              .on_key_down((e, kcx) => this.onCanvasKey(e, kcx))
              .child(image(this.frame.path).size_full())
          : this.renderEmptyState(t)
      )
      .when(Boolean(this.notice), (el) =>
        el.child(
          div()
            .absolute()
            .bottom(12)
            .px(10)
            .py(5)
            .rounded(5)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .text_size(11)
            .child(this.notice?.text ?? "")
        )
      );
  }

  renderEmptyState(t) {
    const [title, body] = this.daemonError
      ? ["Browser Hub daemon offline", "It starts automatically on an agent's first browser_* tool call, or run: node herdr-browser/daemon/server.mjs"]
      : this.session
        ? ["Waiting for the first frame…", "The page will appear here as soon as it paints."]
        : ["No agent browser sessions", "Sessions appear when Claude Code or Codex call a browser_* tool. Each agent pane gets its own isolated browser."];
    return v_flex()
      .gap(10)
      .p(24)
      .items_center()
      .child(svg(ICON_BROWSER).size(36).text_color(t.accent ?? "#89b4fa"))
      .child(div().text_size(15).font_bold().child(title))
      .child(div().max_w(460).text_size(12).text_color(t.muted).text_center().child(body));
  }
}
