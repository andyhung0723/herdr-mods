import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness(propsValue = {}) {
  const events = [];
  const files = new Map([
    ["/repo/README.md", "# Hello Project\n\nThis is a test readme."],
    ["/repo/docs/guide.md", "# Guide\n\nDetailed documentation."],
  ]);

  const api = {
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-123";
    },
    focused: () => ({ space: "sp1", terminal: "t1", cwd: "/repo" }),
    spaces: () => [{ id: "sp1", name: "Project Space", folder: "/repo", machine: null, active: true }],
    panes: () => [{ pane: "p1", cwd: "/repo" }],
    theme: () => ({
      background: "#1e1e2e",
      surface: "#181825",
      border: "#313244",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      hover: "#45475a",
      raised: "#313244",
      popover: "#181825",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
    }),
    props: () => propsValue,
    run: (name, args) => events.push(["run", name, args]),
    readTextFile: async (path) => {
      events.push(["readTextFile", path]);
      return files.has(path) ? files.get(path) : null;
    },
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      return { code: 0, stdout: "README.md\ndocs/guide.md\n" };
    },
    notify: (n) => events.push(["notify", n]),
    settings: () => ({ font_family: "monospace" }),
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const element = new Proxy(
    {},
    {
      get: () => () => element,
    }
  );

  const kit = synthetic({
    View: class {},
    div: () => element,
    svg: () => element,
  });

  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    TextView: {
      markdown: (id, text) => {
        events.push(["TextView.markdown", id, text]);
        return element;
      },
    },
  });

  const herdr = synthetic(api);
  const mainCode = await readFile(new URL("../mods/markdown-preview/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });

  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await main.evaluate();

  const View = main.namespace.default;
  const instance = new View();
  const cx = {
    focus_handle: () => ({ focus: () => events.push(["focus"]) }),
    spawn: async (fn) => {
      await fn(cx);
    },
    timer: {
      every: (ms, fn) => events.push(["timer.every", ms]),
    },
    notify: () => events.push(["cx.notify"]),
  };

  return { api, View, instance, cx, events, files };
}

test("markdown-preview loads default README.md when no file prop is provided", async () => {
  const { instance, cx, events } = await harness({});
  instance.init({}, cx);
  // Allow async tasks to run
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.fileName, "README.md");
  assert.equal(instance.filePath, "/repo/README.md");
  assert(instance.content.includes("Hello Project"));
  assert(events.some((e) => e[0] === "readTextFile" && e[1] === "/repo/README.md"));
});

test("markdown-preview loads explicit file prop", async () => {
  const { instance, cx } = await harness({ file: "docs/guide.md" });
  instance.init({ file: "docs/guide.md" }, cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.fileName, "guide.md");
  assert.equal(instance.filePath, "/repo/docs/guide.md");
  assert(instance.content.includes("Detailed documentation"));
});

test("markdown-preview openInSplit triggers pane.split and closes overlay if present", async () => {
  const { instance, cx, events } = await harness({ overlay: "overlay-test", file: "README.md" });
  instance.init({ overlay: "overlay-test", file: "README.md" }, cx);
  await new Promise((r) => setImmediate(r));

  instance.openInSplit(cx);

  assert(events.some((e) => e[0] === "run" && e[1] === "pane.split" && e[2].mod === "markdown-preview"));
  assert(events.some((e) => e[0] === "closeOverlay" && e[1] === "overlay-test"));
});

test("markdown-preview handles missing files with clear error state", async () => {
  const { instance, cx } = await harness({ file: "non-existent.md" });
  instance.init({ file: "non-existent.md" }, cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.content, null);
  assert(instance.error.includes("File not found"));
});
