import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function findById(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node._id === id) return node;
  for (const child of node._children ?? []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

function collectText(node) {
  if (!node || typeof node !== "object") return [];
  const out = [...(node._text ?? [])];
  for (const child of node._children ?? []) {
    out.push(...collectText(child));
  }
  return out;
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const child of node._children ?? []) {
    collectNodes(child, pred, out);
  }
  return out;
}

async function createToastHarness(toastProps = {}) {
  const events = [];

  const liquidTheme = {
    popover: "#181a28f0",
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
    working: "#73e6f5",
    blocked: "#ffd479",
    done: "#6be6b5",
  };

  const makeElement = (type, src = null) => {
    const el = {
      _type: type,
      _src: src,
      _id: null,
      _bg: null,
      _borderColor: null,
      _textColor: null,
      _children: [],
      _text: [],
      _tooltip: null,
      _onClick: null,
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "bg") return (color) => { target._bg = color; return proxy; };
        if (prop === "border_color") return (color) => { target._borderColor = color; return proxy; };
        if (prop === "text_color") return (color) => { target._textColor = color; return proxy; };
        if (prop === "tooltip") return (tip) => { target._tooltip = tip; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        if (prop === "child") {
          return (c) => {
            if (typeof c === "string" || typeof c === "number") {
              target._text.push(String(c));
            } else if (c) {
              target._children.push(c);
            }
            return proxy;
          };
        }
        if (prop === "when") {
          return (cond, fn) => {
            if (cond && typeof fn === "function") fn(proxy);
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
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
    div: () => makeElement("div"),
    image: (src) => makeElement("image", src),
    svg: (src) => makeElement("svg", src),
  });
  const base = synthetic({
    v_flex: () => makeElement("v_flex"),
    h_flex: () => makeElement("h_flex"),
  });
  const herdr = synthetic({
    props: () => toastProps,
    closeOverlay: (overlay) => events.push(["closeOverlay", overlay]),
    run: (name, args) => events.push(["run", name, args]),
    theme: () => liquidTheme,
  });

  const code = await readFile(
    new URL("../mods/enhanced-toast/main.js", import.meta.url),
    "utf8"
  );
  const mod = new vm.SourceTextModule(code, {
    context,
    identifier: "enhanced-toast/main.js",
  });

  const deps = { "gpui-kit": kit, "gpui-base": base, herdr };
  await mod.link((spec) => deps[spec]);
  await mod.evaluate();

  const ToastClass = mod.namespace.default;
  const instance = new ToastClass();

  const makeCx = () => ({
    stop_propagation: () => events.push(["stop_propagation"]),
    write_to_clipboard: (val) => events.push(["clipboard", val]),
    notify: () => events.push(["notify"]),
  });

  return {
    render: () => instance.render(makeCx()),
    makeCx,
    events,
    theme: liquidTheme,
  };
}

test("agent completion toast renders Liquid Glass structure and handles click vs close", async () => {
  const h = await createToastHarness({
    overlay: "toast-1",
    level: "success",
    title: "Claude finished",
    body: "herdr-mods · t1",
    icon: "custom-icons/claude.svg",
    action: { name: "agent.focus", args: { address: "t1" } },
  });

  const tree = h.render();
  const root = findById(tree, "toast");
  const accentBar = findById(tree, "toast-accent-bar");
  const iconTile = findById(tree, "toast-icon-tile");
  const title = findById(tree, "toast-title");
  const pill = findById(tree, "toast-status-pill");
  const body = findById(tree, "toast-body");
  const closeBtn = findById(tree, "toast-close");

  assert.ok(root);
  assert.equal(root._bg, "#141828eb");
  assert.equal(root._borderColor, h.theme.border);
  assert.equal(accentBar._bg, h.theme.done);
  assert.equal(iconTile._bg, "#6be6b51f");
  assert.equal(collectNodes(iconTile, (n) => n._type === "image")[0]._src, "custom-icons/claude.svg");
  assert.deepEqual(collectText(title), ["Claude finished"]);
  assert.deepEqual(collectText(pill), ["Done"]);
  assert.deepEqual(collectText(body), ["herdr-mods · t1"]);
  assert.ok(closeBtn);

  // Clicking dismiss stops propagation and only closes overlay
  closeBtn._onClick({}, h.makeCx());
  assert.deepEqual(h.events, [
    ["stop_propagation"],
    ["closeOverlay", "toast-1"],
  ]);

  // Clicking card invokes action and closes overlay
  h.events.length = 0;
  root._onClick({}, h.makeCx());
  assert.deepEqual(h.events, [
    ["run", "agent.focus", { address: "t1" }],
    ["closeOverlay", "toast-1"],
  ]);
});

test("blocked warning toast renders Needs you badge, fallback SVG when no icon, and jump hint when body empty", async () => {
  const h = await createToastHarness({
    overlay: "toast-2",
    level: "warning",
    title: "Claude needs you",
    action: { name: "agent.focus", args: { address: "t2" } },
  });

  const tree = h.render();
  const accentBar = findById(tree, "toast-accent-bar");
  const iconTile = findById(tree, "toast-icon-tile");
  const pill = findById(tree, "toast-status-pill");
  const body = findById(tree, "toast-body");

  assert.equal(accentBar._bg, h.theme.blocked);
  assert.deepEqual(collectText(pill), ["Needs you"]);
  assert.equal(collectNodes(iconTile, (n) => n._type === "svg")[0]._src, "mods/workspace-chrome/clock.svg");
  assert.deepEqual(collectText(body), ["Click to jump to terminal ↗"]);
});

test("remote login toast renders Alert style and copies command without triggering root click", async () => {
  const h = await createToastHarness({
    overlay: "toast-3",
    title: "Login required",
    body: "devbox needs login; run hc machine login devbox",
  });

  const tree = h.render();
  const title = findById(tree, "toast-title");
  const pill = findById(tree, "toast-status-pill");
  const body = findById(tree, "toast-body");
  const copyBtn = findById(tree, "toast-login-copy");

  assert.deepEqual(collectText(title), ["devbox needs a login: run"]);
  assert.deepEqual(collectText(pill), ["Alert"]);
  assert.deepEqual(collectText(body), ["hc machine login devbox"]);
  assert.deepEqual(collectText(copyBtn), ["Copy"]);

  copyBtn._onClick({}, h.makeCx());
  assert.deepEqual(h.events, [
    ["stop_propagation"],
    ["clipboard", "hc machine login devbox"],
    ["notify"],
  ]);

  const rerendered = h.render();
  assert.deepEqual(collectText(findById(rerendered, "toast-login-copy")), ["Copied"]);
});
