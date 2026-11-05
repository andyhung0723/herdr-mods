import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function harness(overrides = {}) {
  const events = [];

  const api = {
    appHome: () => "/app-home",
    readTextFile: async (path) => {
      events.push(["readTextFile", path]);
      return null;
    },
    writeTextFile: async (path, content) => {
      events.push(["writeTextFile", path, content]);
      return null;
    },
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    closeOverlay: (id) => {
      events.push(["closeOverlay", id]);
    },
    openOverlay: () => "overlay-scratchpad",
    run: (cmd, args) => {
      events.push(["run", cmd, args]);
    },
    theme: () => ({
      surface: "#181825",
      background: "#1e1e2e",
      border: "#313244",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#cba6f7",
      raised: "#313244",
      hover: "#45475a",
      solid_foreground: "#1e1e2e",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      ansi3: "#f9e2af",
      ansi4: "#89b4fa",
      ansi5: "#cba6f7",
      ansi6: "#94e2d5",
    }),
    settings: () => ({ font_family: "JetBrains Mono" }),
    props: () => ({ overlay: "overlay-123" }),
    ...overrides,
  };

  const context = vm.createContext({
    console,
    Date,
    setTimeout,
    clearTimeout,
  });

  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const herdr = synthetic(api);
  const storageCode = await readFile(new URL("../mods/scratchpad/storage.js", import.meta.url), "utf8");
  const storageMod = new vm.SourceTextModule(storageCode, { context });
  await storageMod.link((name) => ({ "herdr": herdr }[name]));
  await storageMod.evaluate();

  const element = new Proxy({}, { get: () => () => element });
  const kit = synthetic({
    View: class {},
    div: () => element,
    svg: () => element,
  });

  class MockEditorState {
    constructor(opts) {
      this._val = opts?.value || "";
    }
    value() {
      return this._val;
    }
    set_value(v) {
      this._val = v;
    }
    on() {}
    release() {}
  }

  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    EditorState: {
      new: (opts) => new MockEditorState(opts),
    },
    Editor: { new: () => element },
    InputState: {
      new: (opts) => ({
        value: () => opts?.value || "",
        on: () => {},
      }),
    },
    Input: { new: () => element },
  });

  const mainCode = await readFile(new URL("../mods/scratchpad/main.js", import.meta.url), "utf8");
  const mainMod = new vm.SourceTextModule(mainCode, { context });
  await mainMod.link((name) => ({
    "herdr": herdr,
    "gpui-kit": kit,
    "gpui-base": base,
    "./storage.js": storageMod,
  }[name]));
  await mainMod.evaluate();

  const clipboard = [];
  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    notify: () => {},
    spawn: (fn) => fn(cx),
    write_to_clipboard: (text) => clipboard.push(text),
  };

  return {
    storage: storageMod.namespace,
    View: mainMod.namespace.default,
    cx,
    events,
    clipboard,
  };
}

test("storage provides default store structure and creates new tabs", async () => {
  const { storage } = await harness();

  const def = storage.getDefaultStore();
  assert.equal(Array.isArray(def.tabs), true);
  assert.equal(def.tabs.length, 1);
  assert.equal(def.tabs[0].title, "Quick Scratch");
  assert.equal(def.activeTabId, def.tabs[0].id);

  const newTab = storage.createDefaultTab("tab-custom", "Custom Snippet");
  assert.equal(newTab.id, "tab-custom");
  assert.equal(newTab.title, "Custom Snippet");
});

test("Scratchpad initializes with loaded store and can add, switch and close tabs", async () => {
  const { View, cx } = await harness();

  const pad = new View();
  pad.init({ overlay: "test-overlay" }, cx);

  assert.equal(pad.tabs.length, 1);
  assert.equal(pad.getActiveTab().title, "Quick Scratch");

  // Add tab
  pad.addTab(cx);
  assert.equal(pad.tabs.length, 2);
  assert.equal(pad.getActiveTab().title, "Note 2");

  // Switch back to first tab
  const firstId = pad.tabs[0].id;
  pad.switchTab(firstId, cx);
  assert.equal(pad.activeTabId, firstId);

  // Close second tab
  const secondId = pad.tabs[1].id;
  pad.closeTab(secondId, cx);
  assert.equal(pad.tabs.length, 1);
  assert.equal(pad.activeTabId, firstId);
});

test("Scratchpad quick actions: copyAll, sendToTerminal, clearCurrent", async () => {
  const { View, cx, events, clipboard } = await harness();

  const pad = new View();
  pad.init({ overlay: "test-overlay" }, cx);

  // Set editor value
  pad.editor.set_value("echo 'hello world from scratchpad'");

  // 1. Copy All
  pad.copyAll(cx);
  assert.equal(pad.copied, true);
  assert.deepEqual(clipboard, ["echo 'hello world from scratchpad'"]);

  // 2. Send to Terminal
  pad.sendToTerminal(cx);
  assert.equal(pad.pastedToTerminal, true);
  const runEvents = events.filter((e) => e[0] === "run");
  assert.equal(runEvents.length, 1);
  assert.equal(runEvents[0][1], "terminal.paste");
  assert.equal(runEvents[0][2].text, "echo 'hello world from scratchpad'");

  // 3. Clear Current
  pad.clearCurrent(cx);
  assert.equal(pad.editor.value(), "");
  assert.equal(pad.getActiveTab().content, "");
});
