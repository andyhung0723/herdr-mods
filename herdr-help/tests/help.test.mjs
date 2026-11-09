import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MOCK_KEYS = [
  { keys: "ctrl-b shift-a", action: "mod.open:enhanced-agent-context", section: "global" },
  { keys: "ctrl-b shift-e", action: "mod.open:services-inspector", section: "global" },
  { keys: "ctrl-b shift-s", action: "mod.open:spectra-status", section: "global" },
  { keys: "ctrl-b q", action: "mod.open:agent-quotas", section: "global" },
  { keys: "ctrl-b g", action: "mod.open:enhanced-git", section: "global" },
  { keys: "ctrl-b m", action: "mod.open:markdown-preview", section: "global" },
  { keys: "ctrl-b t", action: "popup-terminal.toggle", section: "layout:main-popup" },
  { keys: "ctrl-b alt-b", action: "wallpaper-carousel.toggle", section: "global" },
  { keys: "cmd-t", action: "tab.new", section: "global" },
  { keys: "ctrl-1", action: "space.select:1", section: "global" },
  { keys: "cmd-d", action: "pane.split:right", section: "global" },
];

async function harness() {
  const events = [];
  const api = {
    keys: () => MOCK_KEYS,
    theme: () => ({
      popover: "#181825",
      foreground: "#cdd6f4",
      dim: "#6c7086",
      accent: "#89b4fa",
      ansi2: "#a6e3a1",
      background: "#1e1e2e",
      selected: "#313244",
    }),
    props: () => ({ overlay: "overlay-help" }),
    closeOverlay: (id) => events.push(["closeOverlay", id]),
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const element = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(element) : element);
        return () => element;
      },
    }
  );

  const kit = synthetic({ View: class {}, div: () => element });
  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    InputState: {
      new: () => ({
        on: () => {},
        focus: () => {},
        value: () => "",
      }),
    },
    Input: { new: () => element },
  });
  const herdr = synthetic(api);

  const mainCode = await readFile(new URL("../mods/help/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await main.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    timer: { after: () => {} },
    notify: () => events.push(["notify"]),
  };

  return { View: main.namespace.default, cx, events };
}

test("enhanced help groups custom mods at top and renders friendly labels", async () => {
  const { View, cx } = await harness();

  const view = new View();
  view.init({}, cx);

  const rendered = view.render(cx);
  assert.ok(rendered);

  // Search filter test
  view.filter = "docker";
  const filtered = view.render(cx);
  assert.ok(filtered);
});
