import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness() {
  const state = new Map();
  const events = [];
  let shellExists = false;
  const api = {
    closeOverlay: (id) => events.push(["close", id]),
    focused: () => ({ space: "space-one", terminal: "t1", cwd: "/repo" }),
    hc: async (args) => {
      events.push(["hc", args[0]]);
      if (args[0] === "get") return {
        code: shellExists ? 0 : 3,
        stdout: JSON.stringify({ address: "t2", state: "live", labels: { "herdr.popup-terminal": "space-one" } }),
      };
      shellExists = true;
      return { code: 0, stdout: JSON.stringify({ address: "t2" }) };
    },
    nextCommand: () => new Promise(() => {}),
    notify: (value) => events.push(["notification", value]),
    openOverlay: (spec) => {
      events.push(["open", spec]);
      return `overlay-${events.length}`;
    },
    props: () => ({}),
    run: (name, args) => events.push([name, args]),
    setShared: (key, value) => state.set(key, value),
    shared: (key) => state.get(key),
    spaces: () => [{ id: "space-one", machine: null }],
    terminals: () => [{ address: "t1", state: "live" }],
    theme: () => ({}),
  };
  const context = vm.createContext({});
  const synthetic = (values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
  const element = new Proxy({}, { get: () => () => element });
  const kit = synthetic({ View: class {}, div: () => element });
  const base = synthetic({ h_flex: () => element });
  const herdr = synthetic(api);
  const session = new vm.SourceTextModule(await readFile(new URL("../mods/popup-terminal/session.js", import.meta.url), "utf8"), { context });
  const main = new vm.SourceTextModule(await readFile(new URL("../mods/popup-terminal/main.js", import.meta.url), "utf8"), { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr, "./session.js": session })[name]);
  await main.evaluate();
  const View = main.namespace.default;
  const controller = new View();
  const cx = { spawn: (callback) => callback(cx), notify: () => {} };
  controller.init({ role: "controller" }, cx);
  return { api, View, controller, cx, events };
}

test("toggle opens, hides, and reopens the same shell; hide does not kill the process", async () => {
  const { controller, cx, events } = await harness();
  await controller.toggle(cx);
  const first = controller.overlay;
  await controller.toggle(cx);
  assert(events.some((event) => event[0] === "close" && event[1] === first));
  await controller.toggle(cx);
  assert.equal(events.filter((event) => event[0] === "hc" && event[1] === "run").length, 1);
  assert.equal(events.filter((event) => event[0] === "open").length, 2);
  assert(!events.some((event) => event[0] === "terminal.kill" || event[1] === "kill"));
});

test("external dismissal clears popup state, restores focus, and reopens in one toggle", async () => {
  const { controller, cx, events, View } = await harness();
  await controller.toggle(cx);
  const header = new View();
  header.init({ role: "header", overlay: controller.overlay, returnTerminal: "t1" }, cx);
  header.close();
  assert(events.some((event) => event[0] === "pane.focus" && event[1].terminal === "t1"));
  await controller.toggle(cx);
  assert.equal(events.filter((event) => event[0] === "open").length, 2);
});

test("an old header closing late cannot clear a newly opened popup", async () => {
  const { controller, cx, events, View } = await harness();
  await controller.toggle(cx);
  const oldHeader = new View();
  oldHeader.init({ role: "header", overlay: controller.overlay, returnTerminal: "t1" }, cx);
  await controller.toggle(cx);
  await controller.toggle(cx);
  oldHeader.close();
  assert(!events.some((event) => event[0] === "pane.focus"));
  const currentOverlay = controller.overlay;
  await controller.toggle(cx);
  assert(events.some((event) => event[0] === "close" && event[1] === currentOverlay));
  assert.equal(events.filter((event) => event[0] === "open").length, 2);
});

test("closing the controller closes its popup without ending the shell", async () => {
  const { controller, cx, events } = await harness();
  await controller.toggle(cx);
  controller.close();
  assert(events.some((event) => event[0] === "close" && event[1] === controller.overlay));
  assert.equal(events.filter((event) => event[0] === "hc").length, 2);
});
