// The keybind list (Herdr's prefix+h / prefix+?), grouped, filterable by typing.
// Reads keys.json through keys(); enhanced with friendly descriptions for custom mods.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { keys, props, closeOverlay, theme } from "herdr";

const GROUPS = [
  ["Custom Mods & Extensions", /^mod\.open:|^popup-terminal|^wallpaper-carousel/],
  ["Spaces", /^space\./],
  ["Tabs", /^tab\./],
  ["Panes", /^pane\./],
  ["Agents", /^agent\./],
  ["Terminal", /^terminal\.|^send:/],
  ["Window & Layout", /./],
];

const FRIENDLY_LABELS = {
  "mod.open:enhanced-agent-context": "Agent Inspector (Context, Rules, MCP)",
  "mod.open:services-inspector": "Services (Ports, Dev Servers, Docker)",
  "mod.open:spectra-status": "Spectra (SDD Status & Tasks)",
  "mod.open:agent-quotas": "Agent Quotas (Usage & Limits)",
  "mod.open:enhanced-git": "Git Manager (Fork Graph & Stashes)",
  "mod.open:markdown-preview": "Markdown Dual-Column Preview",
  "mod.open:picker": "Command Palette & Switcher",
  "popup-terminal.toggle": "Toggle Floating Popup Terminal",
  "wallpaper-carousel.toggle": "Toggle Matrix Digital Rain Loop",
  "wallpaper-carousel.next": "Next Wallpaper Background",
  "scratchpad.toggle": "Toggle Scratchpad Note",
  "app.help": "Keybindings Cheat Sheet",
  "layout.toggle:sidebar": "Toggle Left Sidebar",
  "app.palette": "Command Palette",
  "app.settings": "Preferences & Settings",
  "app.quit": "Quit Herdr",
  "app.hide": "Hide Herdr",
  "app.zoom_in": "Zoom In UI",
  "app.zoom_out": "Zoom Out UI",
  "app.zoom_reset": "Reset UI Zoom",
  "pane.zoom": "Zoom / Maximize Active Pane",
  "pane.close": "Close Active Pane",
};

function label(action) {
  if (FRIENDLY_LABELS[action]) return FRIENDLY_LABELS[action];
  if (action.startsWith("send:")) return "type " + JSON.stringify(action.slice(5));
  const [name, arg] = action.split(":");
  const words = name.replace(/[._]/g, " ");
  return arg ? `${words} ${arg}` : words;
}

export default class Help extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Type to filter (e.g. docker, agent, git, port)…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      cx.notify();
    });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  render(cx) {
    const t = theme();
    const f = this.filter.toLowerCase();
    const all = keys().filter((k) => !f || k.keys.includes(f) || label(k.action).toLowerCase().includes(f));
    const seen = new Set();
    const groups = GROUPS.map(([name, re]) => {
      const rows = all.filter((k) => !seen.has(k) && re.test(k.action) && (seen.add(k) || true));
      return [name, rows];
    }).filter(([, rows]) => rows.length > 0);

    return v_flex()
      .id("help")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(14)
      .bg(t.popover)
      .text_size(12)
      .child(
        h_flex()
          .h(22)
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Keybinds"))
              .child(div().text_size(11).text_color(t.dim).child(`(${all.length} shortcuts)`))
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc to close"))
      )
      .child(
        Input.new(this.input)
          .h(36)
          .flex_none()
          .px(10)
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .text_size(12.8)
          .text_color(t.foreground)
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(2)
          .gap(12)
          .children(
            groups.map(([name, rows]) =>
              v_flex()
                .gap(3)
                .child(
                  div()
                    .text_size(11.5)
                    .font_bold()
                    .text_color(name === "Custom Mods & Extensions" ? (t.accent ?? "#89b4fa") : t.dim)
                    .child(name)
                )
                .children(
                  rows.map((k) => {
                    const isMod = name === "Custom Mods & Extensions";
                    return h_flex()
                      .h(32)
                      .px(8)
                      .rounded(7)
                      .items_center()
                      .hover((s) => s.bg(t.selected ?? "#334155"))
                      .child(
                        div()
                          .w(210)
                          .font_medium()
                          .text_color(isMod ? (t.ansi2 ?? "#a6e3a1") : (t.accent ?? "#89b4fa"))
                          .child(k.keys + (k.section !== "global" ? `  (${k.section})` : ""))
                      )
                      .child(
                        div()
                          .text_color(t.foreground)
                          .font_medium()
                          .child(label(k.action))
                      );
                  })
                )
            )
          )
      );
  }
}
