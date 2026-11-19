import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { formatClock } from "../mods/enhanced-workspace-chrome/date-format.js";
import { computeDogState } from "../mods/enhanced-workspace-chrome/dog-state.js";

test("formatClock - formats fixed date correctly", () => {
  // 2026-11-05 21:58:41 is Thursday (週四)
  const fixed = new Date(2026, 10, 5, 21, 58, 41);
  const actual = formatClock(fixed);

  assert.equal(actual.time, "21:58:41");
  assert.equal(actual.date, "11/05 週四");
  assert.equal(actual.fullDate, "2026/11/05 週四");
  assert.equal(actual.isoTimestamp, "2026-11-05 21:58:41");
});

test("formatClock - pads single digit values", () => {
  // 2026-01-02 03:04:05 is Friday (週五)
  const fixed = new Date(2026, 0, 2, 3, 4, 5);
  const actual = formatClock(fixed);

  assert.equal(actual.time, "03:04:05");
  assert.equal(actual.date, "01/02 週五");
  assert.equal(actual.isoTimestamp, "2026-01-02 03:04:05");
});

test("computeDogState - Phase 1: walks right for ticks 0..15", () => {
  const start = computeDogState(0);
  assert.equal(start.mode, "walk_right");
  assert.equal(start.frame, 1);
  assert.equal(start.offset, 0);
  assert.equal(start.svg, "dog-right-f1.svg");

  const mid = computeDogState(7);
  assert.equal(mid.mode, "walk_right");
  assert.equal(mid.frame, 2);
  assert.equal(mid.offset, 9);
  assert.equal(mid.svg, "dog-right-f2.svg");

  const end = computeDogState(15);
  assert.equal(end.mode, "walk_right");
  assert.equal(end.frame, 2);
  assert.equal(end.offset, 20);
  assert.equal(end.svg, "dog-right-f2.svg");
});

test("computeDogState - Phase 2: sits and wags tail at right edge (ticks 16..23)", () => {
  const f1 = computeDogState(16);
  assert.equal(f1.mode, "sit");
  assert.equal(f1.frame, 1);
  assert.equal(f1.offset, 20);
  assert.equal(f1.svg, "dog-sit-f1.svg");

  const f2 = computeDogState(17);
  assert.equal(f2.mode, "sit");
  assert.equal(f2.frame, 2);
  assert.equal(f2.offset, 20);
  assert.equal(f2.svg, "dog-sit-f2.svg");
});

test("computeDogState - Phase 3: walks left back to origin (ticks 24..39)", () => {
  const start = computeDogState(24);
  assert.equal(start.mode, "walk_left");
  assert.equal(start.frame, 1);
  assert.equal(start.offset, 20);
  assert.equal(start.svg, "dog-left-f1.svg");

  const mid = computeDogState(31);
  assert.equal(mid.mode, "walk_left");
  assert.equal(mid.frame, 2);
  assert.equal(mid.offset, 11);
  assert.equal(mid.svg, "dog-left-f2.svg");

  const end = computeDogState(39);
  assert.equal(end.mode, "walk_left");
  assert.equal(end.frame, 2);
  assert.equal(end.offset, 0);
  assert.equal(end.svg, "dog-left-f2.svg");
});

test("computeDogState - Phase 4: sits and wags tail at origin (ticks 40..47)", () => {
  const f1 = computeDogState(40);
  assert.equal(f1.mode, "sit");
  assert.equal(f1.frame, 1);
  assert.equal(f1.offset, 0);
  assert.equal(f1.svg, "dog-sit-f1.svg");

  const f2 = computeDogState(41);
  assert.equal(f2.mode, "sit");
  assert.equal(f2.frame, 2);
  assert.equal(f2.offset, 0);
  assert.equal(f2.svg, "dog-sit-f2.svg");
});

test("computeDogState - wraps smoothly after 48 ticks", () => {
  const tick48 = computeDogState(48);
  const tick0 = computeDogState(0);
  assert.deepEqual(tick48, tick0);
});

test("dog svg assets exist and contain valid SVG markup", () => {
  const baseDir = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-workspace-chrome"
  );
  const requiredSvgs = [
    "dog-right-f1.svg",
    "dog-right-f2.svg",
    "dog-left-f1.svg",
    "dog-left-f2.svg",
    "dog-sit-f1.svg",
    "dog-sit-f2.svg",
  ];

  for (const file of requiredSvgs) {
    const fullPath = path.join(baseDir, file);
    assert.equal(fs.existsSync(fullPath), true, `SVG file must exist: ${file}`);
    const content = fs.readFileSync(fullPath, "utf-8");
    assert.match(content, /<svg[^>]*viewBox=/);
    assert.match(content, /<rect /);
  }
});

test("music assets exist in enhanced-workspace-chrome", () => {
  const baseDir = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-workspace-chrome"
  );
  assert.equal(fs.existsSync(path.join(baseDir, "music.svg")), true);
  assert.equal(fs.existsSync(path.join(baseDir, "probe.py")), true);
});

test("enhanced-workspace-chrome renders integrated #chrome-music-player, #chrome-music-eq, and #chrome-music-toggle", async () => {
  const baseDir = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-workspace-chrome"
  );
  const events = [];
  let playingState = true;
  const makeEl = (type) => {
    const el = {
      _type: type,
      _id: null,
      _children: [],
      _text: [],
      _onClick: null,
      _onMouseDown: null,
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        if (prop === "on_mouse_down") return (_btn, fn) => { target._onMouseDown = fn; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "children") return (arr) => {
          for (const c of arr ?? []) if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "when") return (cond, fn) => {
          if (cond && typeof fn === "function") fn(proxy);
          return proxy;
        };
        return () => proxy;
      },
    });
    return proxy;
  };
  const findById = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node._id === id) return node;
    for (const c of node._children ?? []) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const collectText = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    out.push(...(node._text ?? []));
    for (const c of node._children ?? []) collectText(c, out);
    return out;
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );

  const kit = synthetic({
    View: class {},
    div: () => makeEl("div"),
    svg: () => makeEl("svg"),
    image: () => makeEl("image"),
  });
  const base = synthetic({
    h_flex: () => makeEl("h_flex"),
    v_flex: () => makeEl("v_flex"),
  });
  const herdr = synthetic({
    theme: () => ({
      surface: "#ffffff1a",
      raised: "#ffffff26",
      hover: "#ffffff30",
      selected: "#ffffff3b",
      border: "#ffffff40",
      input: "#ffffff59",
      foreground: "#f4f6ff",
      muted: "#d4daef",
      dim: "#a6b0cf",
      accent: "#8ab8ff",
      done: "#6be6b5",
      blocked: "#ffd479",
    }),
    run: (cmd, args) => events.push(["run", cmd, args]),
    props: () => ({}),
    window: () => ({ platform: "macos", fullscreen: false }),
    shared: () => null,
    setShared: () => {},
    updates: () => ({ app: { ready: false } }),
    layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: 276 } }] }),
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      if (args.includes("toggle")) {
        playingState = !playingState;
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("status")) {
        return {
          code: 0,
          stdout: JSON.stringify({ active: true, title: "アイドル", artist: "YOASOBI", playing: playingState }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
    appHome: () => "/Users/dev/.config/herdr-app",
    notify: () => {},
    playSound: () => {},
  });
  const dateFmt = synthetic({ formatClock });
  const dogState = synthetic({ computeDogState });

  const mainCode = fs.readFileSync(path.join(baseDir, "main.js"), "utf8");
  const mod = new vm.SourceTextModule(mainCode, { context });
  await mod.link((spec) => ({
    "gpui-kit": kit,
    "gpui-base": base,
    herdr,
    "./date-format.js": dateFmt,
    "./dog-state.js": dogState,
  }[spec]));
  await mod.evaluate();

  const ChromeView = mod.namespace.default;
  const view = new ChromeView();
  const cx = {
    timer: { every: () => {}, after: (_ms, fn) => fn?.() },
    notify: () => events.push(["notify"]),
    stop_propagation: () => events.push(["stop_propagation"]),
  };
  view.init({}, cx);
  await view.pollMusic(cx);

  const tree = view.render(cx);
  const player = findById(tree, "chrome-music-player");
  const toggle = findById(tree, "chrome-music-toggle");
  const eq = findById(tree, "chrome-music-eq");
  assert.ok(player, "Should render #chrome-music-player");
  assert.ok(toggle, "Should render #chrome-music-toggle");
  assert.ok(eq, "Should render #chrome-music-eq while playing");
  assert.ok(collectText(player).includes("アイドル"));
  assert.ok(collectText(player).includes("YOASOBI"));
  assert.equal(typeof toggle._onMouseDown, "function", "#chrome-music-toggle should stop left mouse_down propagation");

  toggle._onMouseDown({}, cx);
  assert.equal(events.filter(([k]) => k === "stop_propagation").length, 1);

  const togglePromise = toggle._onClick({}, cx);
  assert.equal(view.song.playing, false, "togglePlay should optimistically flip playing state immediately");
  await togglePromise;
  assert.equal(events.filter(([k]) => k === "stop_propagation").length, 2);
  assert.ok(events.some(([k, _c, a]) => k === "exec" && a.includes("toggle")));
  assert.equal(view.song.playing, false, "song.playing should reflect updated toggle status");
});

test("glass-pane renders distinct focused session indicator bar and tint", async () => {
  const paneDir = path.resolve(import.meta.dirname, "../mods/glass-pane");
  const makeEl = (type) => {
    const el = {
      _type: type,
      _id: null,
      _bg: null,
      _borderColor: null,
      _textColor: null,
      _fontWeight: null,
      _children: [],
      _text: [],
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "bg") return (v) => { target._bg = v; return proxy; };
        if (prop === "border_color") return (v) => { target._borderColor = v; return proxy; };
        if (prop === "text_color") return (v) => { target._textColor = v; return proxy; };
        if (prop === "font_semibold") return () => { target._fontWeight = "semibold"; return proxy; };
        if (prop === "font_medium") return () => { target._fontWeight = "medium"; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "children") return (arr) => {
          for (const c of arr ?? []) if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "when") return (cond, fn) => {
          if (cond && typeof fn === "function") fn(proxy);
          return proxy;
        };
        return () => proxy;
      },
    });
    return proxy;
  };
  const findById = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node._id === id) return node;
    for (const c of node._children ?? []) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };

  let currentPane = null;
  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );

  const kit = synthetic({
    View: class {},
    div: () => makeEl("div"),
    svg: () => makeEl("svg"),
    image: () => makeEl("image"),
  });
  const base = synthetic({
    h_flex: () => makeEl("h_flex"),
  });
  const herdr = synthetic({
    panes: () => (currentPane ? [currentPane] : []),
    props: () => (currentPane ? { pane: currentPane.pane } : {}),
    run: () => {},
    home: () => "/Users/dev",
    layout: () => ({ id: "root", children: [] }),
    theme: () => ({
      border: "#ffffff40",
      foreground: "#f4f6ff",
      muted: "#d4daef",
      dim: "#a6b0cf",
      hover: "#ffffff30",
      accent: "#8ab8ff",
      working: "#73e6f5",
      blocked: "#ffd479",
      done: "#6be6b5",
    }),
  });

  const code = fs.readFileSync(path.join(paneDir, "main.js"), "utf8");
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link((spec) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[spec]));
  await mod.evaluate();

  const GlassPane = mod.namespace.default;
  const view = new GlassPane();
  view.init();

  // Focused pane
  currentPane = {
    pane: "p1",
    cwd: "/Users/dev/project",
    title: "claude",
    focused: true,
    status: "idle",
    program: { name: "Claude Code", agent: true, icon: "claude.svg", tint: true },
  };
  const focusedTree = view.render();
  const focusedHead = findById(focusedTree, "pane-head-p1");
  const focusBar = findById(focusedTree, "pane-focus-bar-p1");
  assert.ok(focusBar, "Focused pane should render #pane-focus-bar-p1");
  assert.equal(focusBar._bg, "#8ab8ff");
  assert.equal(focusedHead._bg, "#8ab8ff1f");
  assert.equal(focusedHead._borderColor, "#8ab8ff66");

  // Unfocused pane
  currentPane = {
    pane: "p2",
    cwd: "/Users/dev/other",
    title: "zsh",
    focused: false,
    status: "idle",
    program: { name: "zsh", shell: true, icon: "term.svg", tint: true },
  };
  const unfocusedTree = view.render();
  const unfocusedHead = findById(unfocusedTree, "pane-head-p2");
  const unfocusedBar = findById(unfocusedTree, "pane-focus-bar-p2");
  assert.ok(unfocusedBar, "Unfocused pane should keep #pane-focus-bar-p2 in-place to avoid layout shift");
  assert.equal(unfocusedBar._bg, "#ffffff1a");
  assert.equal(unfocusedHead._bg, "#00000024");
  assert.equal(unfocusedHead._borderColor, "#ffffff40");
});
