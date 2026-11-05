import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function harness() {
  const events = [];
  const sharedMap = new Map();

  const api = {
    spaces: () => [
      { id: "sp1", name: "eForm", active: true, tabs: [{ id: "t1" }] },
      { id: "sp2", name: "AI Media", active: false, tabs: [{ id: "t2" }] },
    ],
    machines: () => [],
    panes: () => [],
    run: (cmd, args) => events.push(["run", cmd, args]),
    openOverlay: (spec) => events.push(["openOverlay", spec]),
    exec: async () => ({ code: 0, stdout: "" }),
    hc: async () => ({ code: 0, stdout: "" }),
    theme: () => ({
      chrome: "#181825",
      selected: "#313244",
      hover: "#45475a",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      border: "#313244",
      ansi6: "#22a99a",
    }),
    shared: (k) => sharedMap.get(k) ?? null,
    setShared: (k, v) => sharedMap.set(k, v),
    watchFolder: async () => null,
    window: () => ({ platform: "macos", fullscreen: false }),
    layout: () => ({
      id: "root",
      children: [{ id: "sidebar", size: { px: 268 } }],
    }),
    props: () => ({}),
  };

  const mockLocalStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  const context = vm.createContext({
    localStorage: mockLocalStorage,
  });
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const svgsLoaded = [];
  let proxy;
  const element = {
    child() { return proxy; },
    children() { return proxy; },
    when(cond, fn) {
      if (cond && typeof fn === "function") fn(proxy);
      return proxy;
    },
  };
  proxy = new Proxy(element, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      return () => proxy;
    },
  });

  const kit = synthetic({
    View: class {},
    div: () => proxy,
    svg: (path) => {
      svgsLoaded.push(path);
      return proxy;
    },
  });

  const base = synthetic({
    v_flex: () => proxy,
    h_flex: () => proxy,
  });

  const herdr = synthetic(api);
  const code = await readFile(new URL("../mods/enhanced-spaces/main.js", import.meta.url), "utf8");
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link((name) => ({ "gpui-kit": kit, "gpui-base": base, "herdr": herdr }[name]));
  await mod.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    spawn: async (fn) => {
      try {
        await fn(cx);
      } catch {}
    },
    timer: {
      every: () => {},
      after: () => {},
    },
    notify: () => {},
  };

  if (!globalThis.localStorage) {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }

  return { View: mod.namespace.default, api, svgsLoaded, events, cx };
}

test("enhanced-spaces initializes and renders space dashboard icon", async () => {
  const { View, svgsLoaded, cx } = await harness();
  const instance = new View();
  instance.init({}, cx);
  const rendered = instance.render();
  assert.ok(rendered);
  assert.ok(
    svgsLoaded.includes("mods/enhanced-spaces/space.svg"),
    "Should reference mods/enhanced-spaces/space.svg"
  );
});
