import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function harness({ props: customProps = {}, exec: customExec = null } = {}) {
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
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    exec: customExec || (async () => ({ code: 0, stdout: "" })),
    hc: async () => ({ code: 0, stdout: "" }),
    appHome: () => "/Users/dev/.config/herdr-app",
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
    props: () => customProps,
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
  const imagesLoaded = [];
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
    image: (path) => {
      imagesLoaded.push(path);
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

  return { View: mod.namespace.default, api, svgsLoaded, imagesLoaded, sharedMap, events, cx };
}

test("enhanced-spaces initializes and renders space dashboard icon", async () => {
  const { View, svgsLoaded, cx } = await harness();
  const instance = new View();
  instance.init({}, cx);
  const rendered = instance.render(cx);
  assert.ok(rendered);
  assert.ok(
    svgsLoaded.includes("mods/enhanced-spaces/space.svg"),
    "Should reference mods/enhanced-spaces/space.svg"
  );
});

test("enhanced-spaces renders custom svg, full-color image, and opens icon picker overlay", async () => {
  const { View, svgsLoaded, imagesLoaded, sharedMap, events, cx } = await harness();
  sharedMap.set("space.icons", {
    sp1: { kind: "svg", value: "icons/spaces/my-team.svg" },
    sp2: { kind: "image", value: "icons/spaces/brand-logo.png" },
  });

  const instance = new View();
  instance.init({}, cx);
  const rendered = instance.render(cx);
  assert.ok(rendered);
  assert.ok(svgsLoaded.includes("icons/spaces/my-team.svg"), "Should render custom svg icon");
  assert.ok(imagesLoaded.includes("icons/spaces/brand-logo.png"), "Should render custom image icon");

  instance.openIconPicker({ id: "sp1", name: "eForm" });
  assert.ok(
    events.some(
      ([type, spec]) =>
        type === "openOverlay" &&
        spec?.mod === "enhanced-spaces" &&
        spec?.props?.iconPicker === true &&
        spec?.props?.spaceId === "sp1"
    ),
    "Should open icon picker overlay for sp1"
  );

  // Also verify setSpaceIcon updates shared state and resets cleanly
  instance.setSpaceIcon("sp1", { kind: "emoji", value: "🚀" });
  assert.equal(sharedMap.get("space.icons").sp1.value, "🚀");
  instance.setSpaceIcon("sp1", null);
  assert.equal(sharedMap.get("space.icons").sp1, undefined);
});

test("enhanced-spaces icon picker always renders .png custom icons with image() even in monochrome mode", async () => {
  const { View, svgsLoaded, imagesLoaded, cx } = await harness({
    props: { iconPicker: true, spaceId: "sp1", spaceName: "eForm" },
    exec: async () => ({ code: 0, stdout: "eForm.png\nlogo.svg\n" }),
  });

  const instance = new View();
  instance.init({}, cx);
  // Wait microtask for loadCustomIcons
  await new Promise((r) => setTimeout(r, 10));
  instance.render(cx);

  assert.ok(imagesLoaded.includes("icons/spaces/eForm.png"), "PNG custom icon must render via image()");
  assert.equal(svgsLoaded.includes("icons/spaces/eForm.png"), false, "PNG custom icon must NOT render via svg()");
  assert.ok(svgsLoaded.includes("icons/spaces/logo.svg"), "SVG custom icon in monochrome mode renders via svg()");
});
