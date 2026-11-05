import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function harness(overrides = {}) {
  const events = [];
  const sharedMap = new Map();
  const fileMap = new Map();
  const clipboard = [];
  let triggerCommand = null;

  const api = {
    appHome: () => "/app-home",
    shared: (k) => sharedMap.get(k) ?? null,
    setShared: (k, v) => sharedMap.set(k, v),
    nextCommand: () => new Promise((resolve) => {
      triggerCommand = resolve;
    }),
    readTextFile: async (path) => {
      events.push(["readTextFile", path]);
      return fileMap.get(path) ?? null;
    },
    writeTextFile: async (path, content) => {
      events.push(["writeTextFile", path, content]);
      fileMap.set(path, content);
      return null;
    },
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    closeOverlay: (id) => {
      events.push(["closeOverlay", id]);
    },
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-scratchpad";
    },
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

  let focusCalls = 0;

  class MockTextareaState {
    constructor(opts) {
      this._val = opts?.value || "";
      this._handlers = [];
      this.focused = false;
      this.softWrap = false;
      this.selectedRange = null;
    }
    value() {
      return this._val;
    }
    set_value(v) {
      this._val = v;
      for (const h of this._handlers) h({}, {});
    }
    set_soft_wrap(w) {
      this.softWrap = w;
    }
    set_selected_range(range) {
      this.selectedRange = range;
    }
    focus() {
      this.focused = true;
      focusCalls++;
    }
    on(event, handler) {
      if (event === "change") this._handlers.push(handler);
    }
    release() {}
  }

  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    TextareaState: {
      new: (opts) => new MockTextareaState(opts),
    },
    Textarea: { new: () => element },
    EditorState: {
      new: (opts) => new MockTextareaState(opts),
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

  const cx = {
    focus_handle: () => ({
      focus: () => {
        focusCalls++;
      },
    }),
    notify: () => {},
    spawn: (fn) => fn(cx),
    write_to_clipboard: (text) => clipboard.push(text),
    timer: {
      after: (_ms, fn) => fn(cx),
    },
  };

  return {
    storage: storageMod.namespace,
    View: mainMod.namespace.default,
    cx,
    events,
    clipboard,
    sharedMap,
    getFocusCalls: () => focusCalls,
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

test("Scratchpad controller handles toggle command and opens 800x560 overlay", async () => {
  const { View, cx, events, sharedMap } = await harness();

  const controller = new View();
  controller.init({ role: "controller" }, cx);

  // Trigger toggle
  controller.toggle(cx);

  const openEvents = events.filter((e) => e[0] === "openOverlay");
  assert.equal(openEvents.length, 1);
  const spec = openEvents[0][1];
  assert.equal(spec.mod, "scratchpad");
  assert.equal(spec.kind, "dialog");
  assert.equal(spec.width, 800);
  assert.equal(spec.height, 560);
  assert.equal(sharedMap.get("scratchpad.open-overlay"), "overlay-scratchpad");

  // Second toggle should close it
  controller.toggle(cx);
  const closeEvents = events.filter((e) => e[0] === "closeOverlay");
  assert.equal(closeEvents.length, 1);
  assert.equal(closeEvents[0][1], "overlay-scratchpad");
  assert.equal(sharedMap.get("scratchpad.open-overlay"), null);
});

test("Scratchpad dialog saves synchronously on change and persists across reopen", async () => {
  const { View, cx, sharedMap, getFocusCalls } = await harness();

  // 1. First session: open dialog and type text
  const pad1 = new View();
  pad1.init({ role: "dialog", overlay: "overlay-1" }, cx);

  // Focus should have been called for auto-focus
  assert.ok(getFocusCalls() > 0, "Editor focus must be triggered automatically on open");

  pad1.editor.set_value("Todo: refactor layout state now");

  // Verify that sharedMap was instantly updated synchronously
  const saved = sharedMap.get("scratchpad.store");
  assert.ok(saved);
  assert.equal(saved.tabs[0].content, "Todo: refactor layout state now");

  // User hits Esc / close
  await pad1.close(cx);

  // 2. Second session: reopened
  const pad2 = new View();
  pad2.init({ role: "dialog", overlay: "overlay-2" }, cx);

  // Content must be 100% preserved even after loadStore runs
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pad2.getActiveTab().content, "Todo: refactor layout state now");
  assert.equal(pad2.editor.value(), "Todo: refactor layout state now");
  // Cursor must be positioned at the end of the text (length = 31)
  assert.equal(pad2.editor.selectedRange?.start, 31);
  assert.equal(pad2.editor.selectedRange?.end, 31);
});

test("Scratchpad quick actions: copyAll, clearCurrent", async () => {
  const { View, cx, clipboard } = await harness();

  const pad = new View();
  pad.init({ role: "dialog", overlay: "test-overlay" }, cx);

  // Set editor value
  pad.editor.set_value("echo 'hello world from scratchpad'");

  // 1. Copy All
  pad.copyAll(cx);
  assert.equal(pad.copied, false); // timer.after fired immediately in test cx
  assert.deepEqual(clipboard, ["echo 'hello world from scratchpad'"]);

  // 2. Clear Current
  pad.clearCurrent(cx);
  assert.equal(pad.editor.value(), "");
  assert.equal(pad.getActiveTab().content, "");
});
