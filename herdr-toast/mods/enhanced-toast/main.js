// Liquid Glass toast notifications. Anything can post one with
// notify({ title, body, level, icon, action }); click to run its action and dismiss it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

const LOGIN_RE = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/;
const WAITING_RE = /needs you|blocked|waiting|approval|permission/i;
const DONE_RE = /finished|done|completed|ready|完成/i;

const LEVEL_STYLES = {
  error: {
    colorKey: null,
    fallbackColor: "#ff7a90",
    label: "Alert",
    fallbackIcon: "mods/workspace-chrome/x.svg",
  },
  warning: {
    colorKey: "blocked",
    fallbackColor: "#ffd479",
    label: "Needs you",
    fallbackIcon: "mods/workspace-chrome/clock.svg",
  },
  success: {
    colorKey: "done",
    fallbackColor: "#6be6b5",
    label: "Done",
    fallbackIcon: "mods/workspace-chrome/check.svg",
  },
  info: {
    colorKey: "accent",
    fallbackColor: "#8ab8ff",
    label: "Notice",
    fallbackIcon: "mods/workspace-chrome/terminal.svg",
  },
};

function withAlpha(hex, alphaHex) {
  if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return `${hex}${alphaHex}`;
  }
  if (typeof hex === "string" && /^#[0-9a-fA-F]{8}$/.test(hex)) {
    return `${hex.slice(0, 7)}${alphaHex}`;
  }
  return hex;
}

export function resolveStatus(p, t, isLogin) {
  const text = `${p?.title ?? ""} ${p?.body ?? ""}`;
  let key = "info";
  if (isLogin || p?.level === "error") {
    key = "error";
  } else if (p?.level === "warning" || WAITING_RE.test(text)) {
    key = "warning";
  } else if (p?.level === "success" || DONE_RE.test(text)) {
    key = "success";
  } else if (p?.level && LEVEL_STYLES[p.level]) {
    key = p.level;
  }

  const spec = LEVEL_STYLES[key];
  const color = (spec.colorKey && t?.[spec.colorKey]) || spec.fallbackColor;
  return {
    key,
    color,
    label: spec.label,
    fallbackIcon: spec.fallbackIcon,
  };
}

export default class EnhancedToast extends View {
  render(_cx) {
    const t = theme() ?? {};
    const p = props() ?? {};
    const login = LOGIN_RE.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const status = resolveStatus(p, t, Boolean(login));

    const surfaceBg = "#141828eb";
    const surfaceHoverBg = "#1d2338f5";
    const glassBorder = t.border ?? "#ffffff40";
    const glassHoverBorder = t.input ?? "#ffffff59";
    const dimColor = t.dim ?? t.muted ?? "#a6b0cf";
    const mutedColor = t.muted ?? "#d4daef";
    const fgColor = t.foreground ?? "#f4f6ff";

    const titleText = login
      ? `${login[1]} needs a login: run`
      : (p.title || "Notification");

    const subtitleEl = !login && Boolean(p.body)
      ? div().id("toast-body").truncate().text_size(11.5).text_color(mutedColor).child(p.body)
      : !login && !p.body && Boolean(p.action?.name)
        ? div().id("toast-body").truncate().text_size(11).text_color(dimColor).child("Click to jump to terminal ↗")
        : Boolean(login)
          ? h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .id("toast-body")
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .tooltip(command)
                  .text_size(11.5)
                  .text_color(mutedColor)
                  .child(command),
              )
              .child(
                div()
                  .id("toast-login-copy")
                  .flex_none()
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.raised ?? "#ffffff26")
                  .border(1)
                  .border_color(glassBorder)
                  .text_size(11)
                  .text_color(fgColor)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover ?? "#ffffff30"))
                  .on_click((_e, clickCx) => {
                    clickCx.stop_propagation();
                    clickCx.write_to_clipboard(command);
                    this.copied = true;
                    clickCx.notify();
                  })
                  .child(this.copied ? "Copied" : "Copy"),
              )
          : null;

    const card = h_flex()
      .id("toast")
      .size_full()
      .pl(10)
      .pr(10)
      .py(8)
      .gap(10)
      .items_center()
      .rounded(10)
      .bg(surfaceBg)
      .border(1)
      .border_color(glassBorder)
      .cursor_pointer()
      .hover((s) => s.bg(surfaceHoverBg).border_color(glassHoverBorder))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(
        div()
          .id("toast-accent-bar")
          .w(3.5)
          .h(36)
          .rounded(2)
          .flex_none()
          .bg(status.color),
      )
      .child(
        div()
          .id("toast-icon-tile")
          .size(34)
          .rounded(9)
          .flex_none()
          .bg(withAlpha(status.color, "1f"))
          .border(1)
          .border_color(withAlpha(status.color, "4d"))
          .flex()
          .items_center()
          .justify_center()
          .child(
            p.icon
              ? image(p.icon).w(20).h(20).flex_none()
              : svg(status.fallbackIcon).size(16).text_color(status.color),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .justify_center()
          .overflow_hidden()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .id("toast-title")
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .font_semibold()
                  .text_size(12.5)
                  .text_color(fgColor)
                  .child(titleText),
              )
              .child(
                h_flex()
                  .id("toast-status-pill")
                  .flex_none()
                  .px(6)
                  .h(17)
                  .rounded(5)
                  .bg(withAlpha(status.color, "24"))
                  .border(1)
                  .border_color(withAlpha(status.color, "45"))
                  .items_center()
                  .child(
                    div()
                      .text_size(10)
                      .font_semibold()
                      .text_color(status.color)
                      .child(status.label),
                  ),
              ),
          )
          .when(Boolean(subtitleEl), (el) => el.child(subtitleEl)),
      )
      .child(
        div()
          .id("toast-close")
          .size(22)
          .rounded(6)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .text_color(dimColor)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover ?? "#ffffff30").text_color(fgColor))
          .on_click((_e, clickCx) => {
            clickCx.stop_propagation();
            closeOverlay(p.overlay);
          })
          .child(svg("mods/workspace-chrome/x.svg").size(12)),
      );

    return card;
  }
}
