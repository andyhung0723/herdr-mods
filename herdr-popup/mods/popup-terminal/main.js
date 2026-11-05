// ds-sense 產出：GPUI 原生介面，使用 Herdr 的語意主題。
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  closeOverlay, focused, hc, nextCommand, notify, openOverlay, props, run,
  setShared, shared, spaces, terminals, theme,
} from "herdr";
import { ensureShell, shellContext, terminalOverlay } from "./session.js";

const OPEN_OVERLAY = "popup-terminal.open-overlay";

export default class PopupTerminal extends View {
  init(initialProps, cx) {
    this.options = initialProps ?? props() ?? {};
    this.overlay = null;
    if (this.options.role === "header") return;

    setShared(OPEN_OVERLAY, null);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command !== "toggle") continue;
        try {
          await this.toggle(cx);
        } catch (error) {
          notify({ title: "Popup terminal 無法開啟", body: String(error), level: "error" });
        }
      }
    });
  }

  async toggle(cx) {
    if (this.overlay && shared(OPEN_OVERLAY) === this.overlay) {
      closeOverlay(this.overlay);
      this.overlay = null;
      return;
    }

    const context = shellContext(focused(), spaces());
    const terminal = await ensureShell(context, hc);
    cx.notify();
    this.overlay = openOverlay(terminalOverlay(terminal, context));
    setShared(OPEN_OVERLAY, this.overlay);
  }

  close() {
    if (this.options.role !== "header") {
      if (this.overlay) closeOverlay(this.overlay);
      return;
    }

    const { overlay, returnTerminal } = this.options;
    if (shared(OPEN_OVERLAY) !== overlay) return;
    setShared(OPEN_OVERLAY, null);
    if (returnTerminal && terminals().some((item) => item.address === returnTerminal && item.state === "live")) {
      run("pane.focus", { terminal: returnTerminal });
    }
  }

  render() {
    if (this.options?.role !== "header") return div().h(0);

    const colors = theme();
    const terminal = terminals().find((item) => item.address === this.options.terminal);
    return h_flex()
      .size_full()
      .px(12)
      .gap(12)
      .items_center()
      .bg(colors.chrome)
      .border_b(1)
      .border_color(colors.border)
      .text_size(12)
      .text_color(colors.muted)
      .child(div().font_semibold().text_color(colors.foreground).child("Popup Terminal"))
      .child(div().flex_1().truncate().child(terminal?.cwd ?? this.options.terminal ?? ""))
      .child(div().flex_none().text_color(colors.dim).child("Ctrl+B T 收起 · exit 結束"))
      .child(
        div()
          .id("popup-terminal-hide")
          .flex_none()
          .px(8)
          .py(4)
          .rounded(4)
          .cursor_pointer()
          .hover((style) => style.bg(colors.hover).text_color(colors.foreground))
          .on_click(() => closeOverlay(this.options.overlay))
          .child("收起"),
      );
  }
}
