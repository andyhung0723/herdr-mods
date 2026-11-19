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
