import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness(propsValue = {}) {
  const events = [];
  const sharedMap = new Map();
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
    shared: (k) => sharedMap.get(k) ?? null,
    setShared: (k, v) => sharedMap.set(k, v),
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
      get: (_target, prop) => {
        if (prop === "when") {
          return (cond, fn) => {
            if (cond) fn(element);
            return element;
          };
        }
        return () => element;
      },
    }
  );

  const kit = synthetic({
    View: class {},
    div: () => element,
    svg: () => element,
  });

  const linkHandlers = new Map();

  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    Input: { new: () => element },
    InputState: {
      new: () => ({
        value: () => "",
        on: () => {},
        focus: () => {},
      }),
    },
    TextView: {
      markdown: (id, text) => {
        events.push(["TextView.markdown", id, text]);
        const textEl = {
          selectable: () => textEl,
          scrollable: () => textEl,
          on_link_click: (fn) => {
            events.push(["TextView.on_link_click", id]);
            linkHandlers.set(id, fn);
            return textEl;
          },
        };
        return textEl;
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
    open_url: (url) => events.push(["cx.open_url", url]),
  };

  const buildFileTree = main.namespace.buildFileTree;

  return { api, View, instance, cx, events, files, linkHandlers, sharedMap, buildFileTree };
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

  assert.equal(instance.fileName, "docs/guide.md");
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

test("markdown-preview navigates to relative markdown links and supports going back", async () => {
  const { instance, cx, linkHandlers } = await harness({});
  instance.init({}, cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.fileName, "README.md");
  assert.equal(instance.filePath, "/repo/README.md");

  // Call render to trigger TextView.markdown and bind on_link_click
  instance.render(cx);
  const clickHandler = linkHandlers.get("preview-text");
  assert.ok(clickHandler, "Link click handler must be registered");

  // Click a relative link: ./docs/guide.md
  clickHandler("./docs/guide.md", cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.fileName, "docs/guide.md");
  assert.equal(instance.filePath, "/repo/docs/guide.md");
  assert(instance.content.includes("Detailed documentation"));
  assert.equal(instance.history.length, 1);
  assert.equal(instance.history[0], "/repo/README.md");

  // Go Back
  instance.goBack(cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.fileName, "README.md");
  assert.equal(instance.filePath, "/repo/README.md");
  assert.equal(instance.history.length, 0);
});

test("markdown-preview delegates external URLs to cx.open_url", async () => {
  const { instance, cx, events, linkHandlers } = await harness({});
  instance.init({}, cx);
  await new Promise((r) => setImmediate(r));

  instance.render(cx);
  const clickHandler = linkHandlers.get("preview-text");
  assert.ok(clickHandler);

  // Click external URL
  clickHandler("https://github.com/project/docs", cx);

  const openEvents = events.filter((e) => e[0] === "cx.open_url");
  assert.equal(openEvents.length, 1);
  assert.equal(openEvents[0][1], "https://github.com/project/docs");
});

test("buildFileTree builds hierarchical tree with folders first and README on top", async () => {
  const { buildFileTree } = await harness({});

  const list = [
    "docs/api/endpoints.md",
    "README.md",
    "docs/guide.md",
    "docs/api/auth.md",
    "CHANGELOG.md",
  ];

  const tree = buildFileTree(list);
  assert.equal(tree.length, 3); // docs (dir), README.md (file), CHANGELOG.md (file)
  assert.equal(tree[0].name, "docs");
  assert.equal(tree[0].isDir, true);
  assert.equal(tree[1].name, "README.md");
  assert.equal(tree[1].isDir, false);
  assert.equal(tree[2].name, "CHANGELOG.md");

  // Inside docs
  const docsChildren = tree[0].children;
  assert.equal(docsChildren.length, 2); // api (dir), guide.md (file)
  assert.equal(docsChildren[0].name, "api");
  assert.equal(docsChildren[0].isDir, true);
  assert.equal(docsChildren[1].name, "guide.md");

  // Inside docs/api
  const apiChildren = docsChildren[0].children;
  assert.equal(apiChildren.length, 2);
  assert.equal(apiChildren[0].name, "auth.md");
  assert.equal(apiChildren[1].name, "endpoints.md");
});

test("markdown-preview folder collapsing toggle and overlay state", async () => {
  const { instance, cx } = await harness({ overlay: "test-overlay" });
  instance.init({ overlay: "test-overlay" }, cx);
  await new Promise((r) => setImmediate(r));

  assert.equal(instance.overlayId, "test-overlay");

  // Folder collapse toggle
  assert.equal(instance.collapsedFolders.has("docs"), false);
  instance.toggleFolder("docs", cx);
  assert.equal(instance.collapsedFolders.has("docs"), true);
  instance.toggleFolder("docs", cx);
  assert.equal(instance.collapsedFolders.has("docs"), false);
});
