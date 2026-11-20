import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

test("enhanced-tabs - main.js keeps tab bar clean without panel buttons", () => {
  const mainPath = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-tabs/main.js"
  );
  assert.equal(fs.existsSync(mainPath), true, "main.js must exist");
  const content = fs.readFileSync(mainPath, "utf-8");

  assert.doesNotMatch(content, /panelButton\(/);
  assert.match(content, /const tabNum = i \+ 1;/);
  assert.match(content, /displayName/);
});

test("enhanced-tabs and tool-dock - mod.json files exist and have valid place", () => {
  for (const modName of ["enhanced-tabs", "tool-dock"]) {
    const modJsonPath = path.resolve(
      import.meta.dirname,
      `../mods/${modName}/mod.json`
    );
    assert.equal(fs.existsSync(modJsonPath), true, `${modName}/mod.json must exist`);
    const data = JSON.parse(fs.readFileSync(modJsonPath, "utf-8"));
    assert.equal(data.place, "none");
  }
});

test("tool-dock - renders fixed icon rail with tooltips and toggles panels without resizing layout", async () => {
  const events = [];
  const store = {};
  const sharedState = { "workspace.panels": ["files", "changes", "context", "spectra", "services", "todo"] };
  const layoutDoc = {
    id: "root",
    children: [
      { id: "panel", hidden: true, children: [{ id: "panel-body", active: "context" }] },
      { id: "tool-dock", size: { px: 48 } },
    ],
  };

  const makeEl = (type) => {
    const el = { _type: type, _id: null, _children: [], _text: [], _onHover: null, _onClick: null, _tooltip: null };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "children") return (arr) => {
          for (const c of arr || []) if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "when") return (cond, fn) => {
          if (cond && typeof fn === "function") fn(proxy);
          return proxy;
        };
        if (prop === "tooltip") return (t) => { target._tooltip = t; return proxy; };
        if (prop === "on_hover") return (fn) => { target._onHover = fn; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        return () => proxy;
      },
    });
    return proxy;
  };

  const context = vm.createContext({
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  });
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );

  const kit = synthetic({ View: class {}, div: () => makeEl("div"), svg: () => makeEl("svg") });
  const base = synthetic({ h_flex: () => makeEl("h_flex"), v_flex: () => makeEl("v_flex") });
  const herdr = synthetic({
    spaces: () => [{ id: "sp1", active: true }],
    run: (act, args) => events.push([act, args]),
    theme: () => ({ foreground: "#fff", muted: "#aaa", border: "#333", selected: "#222", hover: "#444", input: "#555" }),
    shared: (k) => sharedState[k],
    setShared: (k, v) => { sharedState[k] = v; },
    layout: () => layoutDoc,
  });

  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../mods/tool-dock/main.js"), "utf-8");
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await mod.evaluate();

  const ToolDock = mod.namespace.default;
  const cx = { timer: { every: () => {} }, notify: () => events.push(["notify"]) };
  const view = new ToolDock();
  view.init({}, cx);

  const collectText = (el) => {
    if (!el || typeof el !== "object") return [];
    const out = [...(el._text || [])];
    for (const c of el._children || []) out.push(...collectText(c));
    return out;
  };
  const findById = (el, id) => {
    if (!el || typeof el !== "object") return null;
    if (el._id === id) return el;
    for (const c of el._children || []) {
      const f = findById(c, id);
      if (f) return f;
    }
    return null;
  };

  // Fixed icon rail: icons only, tooltips for each tool, no layout.resize
  let rendered = view.render();
  assert.deepEqual(collectText(rendered), []);
  assert.equal(rendered._onHover, null, "Should not attach hover resize handler");
  for (const [id, label] of [
    ["files", "Files"],
    ["changes", "Git"],
    ["context", "Agent"],
    ["spectra", "Spectra"],
    ["services", "Services"],
    ["todo", "Todo"],
    ["api", "API"],
  ]) {
    assert.equal(findById(rendered, `panel-${id}`)?._tooltip, label);
  }

  // Clicking Todo opens panel
  findById(rendered, "panel-todo")._onClick(null, cx);
  assert.ok(events.some(([a, args]) => a === "layout.select" && args?.stack === "panel-body" && args?.child === "todo"));
  assert.ok(events.some(([a, args]) => a === "layout.show" && args?.id === "panel"));
  assert.equal(events.some(([a]) => a === "layout.resize"), false, "Should never trigger layout.resize");
});

test("enhanced-tabs - auto-scrolls when overflowing, pauses on hover, reverses at edge, and resets when fitting", async () => {
  const events = [];
  const makeEl = (type) => {
    const el = {
      _type: type,
      _id: null,
      _children: [],
      _onHover: null,
      _onSizeChange: null,
      _onWheel: null,
      _ml: null,
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "ml") return (v) => { target._ml = v; return proxy; };
        if (prop === "child") return (c) => { if (c) target._children.push(c); return proxy; };
        if (prop === "children") return (arr) => { for (const c of arr || []) if (c) target._children.push(c); return proxy; };
        if (prop === "when") return (cond, fn) => { if (cond && typeof fn === "function") fn(proxy); return proxy; };
        if (prop === "on_hover") return (fn) => { target._onHover = fn; return proxy; };
        if (prop === "on_size_change") return (fn) => { target._onSizeChange = fn; return proxy; };
        if (prop === "on_scroll_wheel") return (fn) => { target._onWheel = fn; return proxy; };
        return () => proxy;
      },
    });
    return proxy;
  };

  const context = vm.createContext({ Date, Math, RegExp });
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );

  const kit = synthetic({ View: class {}, div: () => makeEl("div"), svg: () => makeEl("svg"), image: () => makeEl("image") });
  const base = synthetic({ h_flex: () => makeEl("h_flex") });
  const herdr = synthetic({
    spaces: () => [{ id: "sp1", active: true, tabs: [{ id: "t1", name: "Tab 1", active: true }, { id: "t2", name: "Tab 2", active: false }] }],
    panes: () => [],
    run: (act, args) => events.push([act, args]),
    openOverlay: () => {},
    theme: () => ({ foreground: "#fff", muted: "#aaa", dim: "#888", border: "#333", selected: "#222", hover: "#444", input: "#555", working: "#0ff", blocked: "#f00", done: "#0f0" }),
    window: () => ({ platform: "macos", titlebar: "none", fullscreen: false, buttons: false }),
    layout: () => ({ id: "root", children: [{ id: "sidebar", hidden: false, size: { px: 260 } }], traffic_lights: [18, 20] }),
    settings: () => ({ zoom: 1 }),
  });

  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../mods/enhanced-tabs/main.js"), "utf-8");
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await mod.evaluate();

  const findById = (el, id) => {
    if (!el || typeof el !== "object") return null;
    if (el._id === id) return el;
    for (const c of el._children || []) {
      const f = findById(c, id);
      if (f) return f;
    }
    return null;
  };

  const Tabs = mod.namespace.default;
  const cx = { timer: { every: () => ({ cancel: () => {} }) }, notify: () => events.push(["notify"]) };
  const view = new Tabs();
  view.init({}, cx);

  let rendered = view.render();
  const scrollViewport = findById(rendered, "tab-scroll");
  const scrollContent = findById(rendered, "tab-content");
  assert.ok(scrollViewport && scrollContent, "Should render tab-scroll viewport and tab-content track");

  // Trigger overflow: viewport 200px, content 320px -> maxOffset 120px
  scrollViewport._onSizeChange({ width: 200 }, cx);
  scrollContent._onSizeChange({ width: 320 }, cx);
  assert.equal(view.getMaxScrollOffset(), 120);

  // Advance past initial pause
  const baseNow = Date.now() + 2000;
  view.tickMarquee(cx, baseNow);
  view.tickMarquee(cx, baseNow + 100);
  const movedOffset = view.scrollOffset;
  assert.ok(movedOffset > 0, "Should scroll forward when overflowing");

  // Hover pauses marquee
  rendered._onHover(true, cx);
  view.tickMarquee(cx, baseNow + 200);
  assert.equal(view.scrollOffset, movedOffset, "Should pause while hovering");
  rendered._onHover(false, cx);

  // Wheel scrolls manually while overflowing instead of switching tabs
  rendered._onWheel({ delta: { x: -20, y: 0 } }, cx);
  assert.equal(view.scrollOffset, movedOffset + 20);
  assert.equal(events.some(([a]) => a === "tab.prev" || a === "tab.next"), false);

  // Hitting maxOffset reverses direction
  view.scrollPausedUntil = 0;
  view.lastScrollTickAt = baseNow + 300;
  view.scrollOffset = 119;
  view.tickMarquee(cx, baseNow + 400);
  assert.equal(view.scrollOffset, 120);
  assert.equal(view.scrollDir, -1);

  // Render reflects negative margin-left offset
  rendered = view.render();
  assert.equal(findById(rendered, "tab-content")._ml, -120);

  // Fitting back inside viewport resets offset to 0 and restores wheel tab switching
  scrollContent._onSizeChange({ width: 180 }, cx);
  assert.equal(view.scrollOffset, 0);
  rendered._onWheel({ delta: { x: 0, y: -2 } }, cx);
  assert.ok(events.some(([a]) => a === "tab.next"));
});
