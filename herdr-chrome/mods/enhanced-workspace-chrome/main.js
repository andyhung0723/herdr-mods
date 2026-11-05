import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  theme,
  run,
  props,
  window,
  shared,
  setShared,
  updates,
  layout,
  exec,
  notify,
} from "herdr";
import { formatClock } from "./date-format.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

export default class EnhancedWorkspaceChrome extends View {
  init(_props, cx) {
    // Tick every second to update live clock
    cx.timer.every(1000, (timerCx) => {
      timerCx.notify();
    });
  }

  button(id, label, action) {
    const t = theme();
    return div()
      .id(id)
      .size(26)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(label);
  }

  copyTimestamp(cx) {
    const ts = formatClock(new Date()).isoTimestamp;
    try {
      cx.write_to_clipboard(ts);
      notify({
        title: "時間已複製到剪貼簿",
        body: ts,
        level: "info",
      });
    } catch {
      exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", ts]).catch(() => null);
      notify({
        title: "時間已複製到剪貼簿",
        body: ts,
        level: "info",
      });
    }
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    const clock = formatClock(new Date());

    if (props()?.footer) {
      const row = (id, icon, label, dim, action) =>
        h_flex()
          .id(id)
          .h(28)
          .px(8)
          .gap(9)
          .items_center()
          .rounded(8)
          .text_color(dim ? t.dim : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .cursor_pointer()
          .on_click(action)
          .child(svg(`mods/enhanced-workspace-chrome/${icon}.svg`).size(14))
          .when(!collapsed, (el) => el.child(label));

      return v_flex()
        .size_full()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .px(8)
        .pt(4)
        .pb(8)
        .text_size(13)
        .child(
          row("settings", "settings", "Settings", false, () => run("app.settings"))
            .when(Boolean(updates().app.ready), (el) =>
              el.child(div().size(6).rounded_full().bg(t.accent))
            )
        )
        .child(
          row("machine", "plus", "Add machine", true, () =>
            run("mod.open", { name: "machine-add" })
          )
        );
    }

    return h_flex()
      .id("enhanced-brand")
      .size_full()
      .bg(t.chrome)
      .pl(collapsed ? 6 : 14)
      .pr(10)
      .gap(6)
      .items_center()
      .text_size(13.5)
      // macOS traffic lights reserve 76px padding
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, (el) =>
        el.pl(76)
      )
      // Live Clock & Date
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(7)
            .items_center()
            .cursor_pointer()
            .hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.copyTimestamp(cx))
            .child(
              svg("mods/enhanced-workspace-chrome/clock.svg")
                .size(15)
                .flex_none()
                .text_color(t.accent)
            )
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .justify_center()
                .gap(1)
                .child(
                  div()
                    .font_bold()
                    .text_size(12.5)
                    .text_color(t.foreground)
                    .child(clock.time)
                )
                .child(
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(clock.date)
                )
            )
        )
      )
      // Search and Sidebar Toggle buttons
      .when(!collapsed, (el) =>
        el.child(
          this.button(
            "search",
            svg("mods/enhanced-workspace-chrome/search.svg").size(15),
            () => run("mod.open", { name: "picker" })
          )
        )
      )
      .when(!(collapsed && window()?.platform === "macos"), (el) =>
        el.child(
          this.button(
            "sidebar-toggle",
            svg("mods/enhanced-workspace-chrome/sidebar.svg").size(15),
            toggleSidebar
          )
        )
      );
  }
}
