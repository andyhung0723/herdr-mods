import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const same = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const STATUS = {
  targets: ["claude", "claude-work", "codex"],
  targetDetails: [
    { name: "claude", tool: "claude", tags: [], dir: "/h/.claude" },
    { name: "claude-work", tool: "claude", tags: ["work"], dir: "/h/.claude-work" },
    { name: "codex", tool: "codex", tags: [], dir: "/h/.codex" },
  ],
  rows: [
    { resource: "skill:review", kind: "skill", name: "review", observe: false, cells: { claude: "ok", "claude-work": "off", codex: "pending" } },
    { resource: "command:list-pr", kind: "command", name: "list-pr", observe: false, cells: { claude: "ok", "claude-work": "conflict", codex: "n/a" } },
    { resource: "mcp:node_repl", kind: "mcp", name: "node_repl", observe: true, cells: { claude: "off", "claude-work": "off", codex: "observed" } },
    { resource: "instructions:shared", kind: "instructions", name: "shared", observe: false, cells: { claude: "ok", "claude-work": "ok", codex: "unresolved" } },
  ],
  orphans: [],
  warnings: ["codex: hooks are ignored until …"],
};

async function harness({ execResult, configText } = {}) {
  const calls = [];
  const notifications = [];
  const api = {
    appHome: () => "/app",
    readTextFile: async (path) =>
      path === "/app/mods/loadout/config.json"
        ? configText === undefined
          ? JSON.stringify({ node: "/n/node", bin: "/l/bin/loadout.js", manifest: "/m.toml" })
          : configText
        : null,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (execResult) return execResult(args);
      if (args[1] === "status") return { code: 0, stdout: JSON.stringify(STATUS), stderr: "" };
      if (args[1] === "toggle") {
        return {
          code: 0,
          stdout: JSON.stringify({
            toggle: { resource: args[2], target: args[3], changed: true },
            results: [{ entry: { action: "create", resource: args[2], target: args[3] } }],
            restart: args[3],
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ results: [] }), stderr: "" };
    },
    notify: (n) => notifications.push(n),
    props: () => ({ overlay: "o1" }),
    theme: () => new Proxy({}, { get: (_t, name) => `#${String(name)}` }),
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });

  const clicks = [];
  const element = new Proxy(() => element, {
    get: (_target, prop) => {
      if (prop === "when") return (cond, fn) => (cond ? fn(element) : element);
      if (prop === "on_click") return (handler) => (clicks.push(handler), element);
      if (prop === "children") return (list) => (list.forEach(() => {}), element);
      return () => element;
    },
  });

  const herdr = synthetic(api);
  const kit = synthetic({ View: class {}, div: () => element });
  const inputs = [];
  const InputState = {
    new: () => {
      const state = {
        text: "",
        focused: false,
        handlers: {},
        value: () => state.text,
        set_value: (next) => (state.text = next),
        on: (event, handler) => ((state.handlers[event] = handler), true),
        focus: () => (state.focused = true),
        type: (text, cx) => {
          state.text = text;
          state.handlers.change?.({}, cx);
        },
      };
      inputs.push(state);
      return state;
    },
  };
  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    InputState,
    Input: { new: () => element },
  });

  const load = async (file, links) => {
    const code = await readFile(new URL(`../mods/loadout/${file}`, import.meta.url), "utf8");
    const module = new vm.SourceTextModule(code, { context });
    await module.link((name) => links[name]);
    await module.evaluate();
    return module;
  };
  const client = await load("client.js", { herdr });
  const main = await load("main.js", { herdr, "gpui-kit": kit, "gpui-base": base, "./client.js": client });

  const pending = [];
  const cx = {
    focus_handle: () => ({ focus() {} }),
    spawn: (fn) => pending.push(fn(cx)),
    timer: { every() {} },
    notify() {},
    stop_propagation() {},
  };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };

  return { client: client.namespace, View: main.namespace.default, cx, settle, calls, notifications, inputs };
}

test("cliArgs always asks for JSON and forwards manifest/state overrides", async () => {
  const { client } = await harness();
  same(client.cliArgs({ node: "n", bin: "b", manifest: "/m", state: "/s" }, ["status"]), [
    "b", "status", "--manifest", "/m", "--state", "/s", "--json",
  ]);
  same(client.cliArgs({ node: "n", bin: "b" }, ["apply"]), ["b", "apply", "--json"]);
});

test("nextEnabled: off turns on, any selected state turns off, n/a is inert", async () => {
  const { client } = await harness();
  assert.equal(client.nextEnabled("off"), true);
  for (const cell of ["ok", "pending", "conflict", "unresolved", "observed", "absent"]) {
    assert.equal(client.nextEnabled(cell), false, cell);
  }
  assert.equal(client.nextEnabled("n/a"), null);
});

test("visibleRows sorts by kind order then name and filters by kind/query", async () => {
  const { client } = await harness();
  same(client.visibleRows(STATUS, "all").map((row) => row.resource), [
    "instructions:shared", "skill:review", "command:list-pr", "mcp:node_repl",
  ]);
  same(client.visibleRows(STATUS, "mcp").map((row) => row.name), ["node_repl"]);
  same(client.visibleRows(STATUS, "all", "LIST").map((row) => row.name), ["list-pr"]);
});

test("summarize counts problem cells; kindCounts follows kind order", async () => {
  const { client } = await harness();
  const summary = client.summarize(STATUS);
  assert.equal(summary.pending, 1);
  assert.equal(summary.conflict, 1);
  assert.equal(summary.unresolved, 1);
  same(client.kindCounts(STATUS).map(({ kind }) => kind), ["instructions", "skill", "command", "mcp"]);
});

test("runLoadout accepts exit 2 (blocked) but surfaces stderr for real failures", async () => {
  const blocked = await harness({ execResult: () => ({ code: 2, stdout: '{"entries":[]}', stderr: "" }) });
  same(await blocked.client.runLoadout({ node: "n", bin: "b" }, ["plan"]), { entries: [] });

  const broken = await harness({
    execResult: () => ({ code: 65, stdout: "", stderr: "manifest: not found: /m.toml\n" }),
  });
  await assert.rejects(broken.client.runLoadout({ node: "n", bin: "b" }, ["status"]), /manifest: not found/);
});

test("failuresOf reports conflicts, unresolved and errors only", async () => {
  const { client } = await harness();
  same(
    client.failuresOf({
      results: [
        { entry: { action: "create", resource: "a", target: "x" } },
        { entry: { action: "conflict", resource: "b", target: "x", detail: "unmanaged" } },
        { entry: { action: "remove", resource: "c", target: "y" }, error: "EACCES" },
      ],
    }),
    ["b → x: unmanaged", "c → y: EACCES"],
  );
});

test("view loads status via the configured node binary and renders without throwing", async () => {
  const { View, cx, settle, calls } = await harness();
  const view = new View();
  view.init({ overlay: "o1" }, cx);
  await settle();
  assert.equal(view.error, null);
  assert.equal(calls[0].command, "/n/node");
  same(calls[0].args, ["/l/bin/loadout.js", "status", "--manifest", "/m.toml", "--json"]);
  view.render(cx);
});

test("space on the focused cell toggles it and marks the target for restart", async () => {
  const { View, cx, settle, calls } = await harness();
  const view = new View();
  view.init({}, cx);
  await settle();

  view.onKey({ keystroke: "down" }, cx);
  view.onKey({ keystroke: "right" }, cx);
  view.onKey({ keystroke: "space" }, cx);
  await settle();

  const toggleCall = calls.find((call) => call.args[1] === "toggle");
  same(toggleCall.args.slice(1, 5), ["toggle", "skill:review", "claude-work", "on"]);
  assert.ok(view.restartTargets.has("claude-work"));
  assert.match(view.message, /skill:review → claude-work: on/);
});

test("n/a cells are never toggled", async () => {
  const { View, cx, settle, calls } = await harness();
  const view = new View();
  view.init({}, cx);
  await settle();
  view.cursor = { row: 2, col: 2 };
  view.onKey({ keystroke: "space" }, cx);
  await settle();
  assert.equal(calls.filter((call) => call.args[1] === "toggle").length, 0);
});

test("a missing config shows an actionable error instead of crashing", async () => {
  const { View, cx, settle, calls } = await harness({ configText: null });
  const view = new View();
  view.init({}, cx);
  await settle();
  assert.match(view.error, /Missing \/app\/mods\/loadout\/config.json.*install.py/);
  assert.equal(calls.length, 0);
  view.render(cx);
});

test("typing in search filters rows and resets the cursor", async () => {
  const { View, cx, settle, inputs } = await harness();
  const view = new View();
  view.init({}, cx);
  await settle();
  view.cursor = { row: 3, col: 0 };

  inputs[0].type("list", cx);
  same(view.rows().map((row) => row.resource), ["command:list-pr"]);
  assert.equal(view.cursor.row, 0);
  view.render(cx);
});

test("/ focuses search; while typing, matrix keys are not hijacked", async () => {
  const { View, cx, settle, inputs, calls } = await harness();
  const view = new View();
  view.init({}, cx);
  await settle();

  view.onKey({ keystroke: "/" }, cx);
  assert.equal(inputs[0].focused, true);
  assert.equal(view.typing, true);

  view.onKey({ keystroke: "j" }, cx);
  view.onKey({ keystroke: "space" }, cx);
  await settle();
  same(view.cursor, { row: 0, col: 0 });
  assert.equal(calls.filter((call) => call.args[1] === "toggle").length, 0);
});

test("escape clears the query first, then leaves search; enter leaves at once", async () => {
  const { View, cx, settle, inputs } = await harness();
  const view = new View();
  view.init({}, cx);
  await settle();

  view.onKey({ keystroke: "/" }, cx);
  inputs[0].type("review", cx);
  view.onKey({ keystroke: "escape" }, cx);
  assert.equal(view.query, "");
  assert.equal(view.typing, true);
  view.onKey({ keystroke: "escape" }, cx);
  assert.equal(view.typing, false);

  view.onKey({ keystroke: "/" }, cx);
  inputs[0].type("ds", cx);
  view.onKey({ keystroke: "enter" }, cx);
  assert.equal(view.typing, false);
  assert.equal(view.query, "ds");
});
