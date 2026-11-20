import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings } from "herdr";

const MARQUEE_TICK_MS = 33;
const MARQUEE_SPEED_PX_PER_SEC = 28;
const MARQUEE_PAUSE_MS = 1800;
const MARQUEE_WHEEL_PAUSE_MS = 2500;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;

    // Ping-pong horizontal auto-scroll state when tab strip overflows
    this.viewportWidth = 0;
    this.contentWidth = 0;
    this.scrollOffset = 0;
    this.scrollDir = 1;
    this.scrollPausedUntil = 0;
    this.isHoveringBar = false;
    this.lastScrollTickAt = 0;
    cx?.timer?.every?.(MARQUEE_TICK_MS, (tcx) => this.tickMarquee(tcx));
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
    const dx = event?.delta?.x ?? 0;
    const dy = event?.delta?.y ?? 0;
    if (maxOffset <= 1) {
      if (Math.abs(dy) >= 1) run(dy > 0 ? "tab.prev" : "tab.next");
      return;
    }
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

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const tabNum = i + 1;
      const displayName = name === String(tabNum) || new RegExp(`^${tabNum}[.:\\s_-]`).test(name)
        ? name
        : `${tabNum} ${name}`;
      return h_flex().id(`tab-${c.id}`).h(26).px_2p5().gap_1p5().rounded(8).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? (t.input ?? t.border) : "#00000000").bg(c.active ? t.selected : "#00000000").text_color(c.active ? t.foreground : t.muted)
        .when(!c.active, (el) => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${displayName} Z` : displayName))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const maxOffset = this.getMaxScrollOffset();
    const offsetPx = maxOffset > 1 ? Math.round(Math.min(this.scrollOffset, maxOffset)) : 0;

    return h_flex().size_full().min_w(0).px(8).pl(lightsPadding).gap(3).items_center()
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_hover((hovered, hcx) => {
        this.isHoveringBar = Boolean(hovered);
        if (!hovered) this.lastScrollTickAt = Date.now();
        hcx?.notify?.();
      })
      .on_scroll_wheel((e, wcx) => this.handleScrollWheel(e, wcx))
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .overflow_x_hidden()
          .on_size_change((size, scx) => this.updateMarqueeBounds(size?.width ?? 0, this.contentWidth, scx))
          .child(
            h_flex()
              .id("tab-content")
              .flex_none()
              .h_full()
              .items_center()
              .gap(3)
              .ml(offsetPx > 0 ? -offsetPx : 0)
              .on_size_change((size, scx) => this.updateMarqueeBounds(this.viewportWidth, size?.width ?? 0, scx))
              .children(shown.map(item))
          )
      )
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
