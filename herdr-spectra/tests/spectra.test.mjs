import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ROOT = "/home/user/proj";
const V3_ROOT = "/home/user/v3proj";

const LIST = {
  changes: [
    { name: "report-sensitivity", status: "in-progress", completedTasks: 0, totalTasks: 15, summary: "PRD v2.1" },
    { name: "account-permission", status: "in-progress", completedTasks: 10, totalTasks: 12, summary: "PRD §4.2" },
    { name: "old-change", status: "done", completedTasks: 5, totalTasks: 5 },
  ],
};
const PARKED = { parked: [{ name: "parked-one", status: "parked", completedTasks: 0, totalTasks: 3 }] };
const SPECS = { specs: [{ id: "access-control", path: `${ROOT}/openspec/specs/access-control` }] };
const STATUS = {
  changeName: "account-permission",
  schemaName: "spec-driven",
  isComplete: false,
  artifacts: [
    { id: "proposal", outputPath: "proposal.md", status: "done" },
    { id: "design", outputPath: "design.md", status: "ready" },
    { id: "specs", outputPath: "specs/**/*.md", status: "done" },
    { id: "tasks", outputPath: "tasks.md", status: "done" },
  ],
};
const TASKS_MD = `## 1. Domain

- [x] 1.1 Enum + derive function
- [ ] 1.2 Value objects

## 2. API

- [X] 2.1 Endpoint
`;

async function harness({ cwd = `${ROOT}/src/app` } = {}) {
  const events = [];
  const api = {
    home: () => "/home/user",
    layout: () => ({ id: "root", children: [{ id: "panel", size: { px: 420 } }] }),
    exec: async (cmd, args = [], opts = {}) => {
      events.push(["exec", cmd, args, opts]);
      if (cmd === "test" && args[0] === "-x") return { code: args[1] === "/home/user/.local/bin/spectra" ? 0 : 1, stdout: "", stderr: "" };
      if (cmd === "test" && args[0] === "-d") {
        const p = args[1];
        const ok = p === `${ROOT}/openspec` || p === `${V3_ROOT}/docs/spectra`;
        return { code: ok ? 0 : 1, stdout: "", stderr: "" };
      }
      if (cmd.endsWith("spectra")) {
        const json = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
        if (args[0] === "list" && args.includes("--parked")) return json(PARKED);
        if (args[0] === "list" && args.includes("--specs")) return json(SPECS);
        if (args[0] === "list") return json(LIST);
        if (args[0] === "status") return json(STATUS);
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    readTextFile: async (path) => {
      events.push(["readTextFile", path]);
      if (path === `${V3_ROOT}/.spectra.yaml`) return "spec_dir: docs/spectra\nlocale: tw\n";
      if (path.endsWith("/tasks.md")) return TASKS_MD;
      return null;
    },
    theme: () => ({
      chrome: "#181825", surface: "#181825", background: "#1e1e2e", popover: "#181825", border: "#313244",
      selected: "#313244", foreground: "#cdd6f4", muted: "#a6adc8", dim: "#6c7086", accent: "#89b4fa",
      working: "#a6e3a1", raised: "#313244", hover: "#45475a", ansi1: "#f38ba8", ansi2: "#a6e3a1", blocked: "#fab387",
    }),
    props: () => ({}),
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-s";
    },
    setShared: (k, v) => events.push(["setShared", k, v]),
    shared: () => null,
    focused: () => ({ space: "s1", tab: "t1", pane: "p1", cwd }),
    agents: () => [],
    panes: () => [],
    spaces: () => [],
    watchFolder: () => new Promise(() => {}),
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
      get: (target, prop) => {
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(element) : element);
        return () => element;
      },
    }
  );

  const kit = synthetic({ View: class {}, div: () => element, svg: () => element, image: () => element });
  const base = synthetic({ v_flex: () => element, h_flex: () => element });
  const herdr = synthetic(api);

  const collectorCode = await readFile(new URL("../mods/spectra-status/collector.js", import.meta.url), "utf8");
  const collector = new vm.SourceTextModule(collectorCode, { context });
  await collector.link((name) => ({ herdr }[name]));
  await collector.evaluate();

  const mainCode = await readFile(new URL("../mods/spectra-status/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr, "./collector.js": collector }[name]));
  await main.evaluate();

  const pending = [];
  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    spawn: (fn) => {
      pending.push(Promise.resolve().then(() => fn(cx)));
    },
    timer: { every: (ms) => events.push(["timer.every", ms]) },
    notify: () => events.push(["notify"]),
    stop_propagation: () => {},
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  return { api, collector: collector.namespace, View: main.namespace.default, cx, events, settle };
}

test("findSpectraRoot detects both openspec/ and .spectra.yaml (docs/spectra) roots", async () => {
  const { collector } = await harness();
  assert.equal(await collector.findSpectraRoot(`${ROOT}/src/app`), ROOT);
  assert.equal(await collector.findSpectraRoot(`${V3_ROOT}/apps/web`), V3_ROOT);
  assert.equal(await collector.resolveSpecDir(V3_ROOT), "docs/spectra");
  assert.equal(await collector.findSpectraRoot("/home/user/elsewhere"), null);
  assert.equal(await collector.findSpectraRoot(""), null);
});

test("collectOverview parses changes, parked, specs and picks the active focus change", async () => {
  const { collector, events } = await harness();
  const o = await collector.collectOverview(ROOT);
  assert.equal(o.available, true);
  assert.equal(o.project, "proj");
  assert.equal(o.specDir, "openspec");
  assert.equal(o.changes.length, 3);
  assert.equal(o.parked.length, 1);
  assert.equal(o.parked[0].status, "parked");
  assert.equal(o.specs[0].id, "access-control");
  assert.deepEqual({ ...o.counts }, { active: 2, done: 1, parked: 1, specs: 1 });
  assert.equal(o.focus.name, "account-permission");
  assert.equal(o.focus.percent, 83);

  const spectraCalls = events.filter((e) => e[0] === "exec" && e[1].endsWith("spectra"));
  assert.ok(spectraCalls.every((e) => e[1] === "/home/user/.local/bin/spectra"));
  assert.ok(spectraCalls.every((e) => e[2].includes("--json") && e[3].cwd === ROOT));
});

test("parseTasksMarkdown groups checklist items by section", async () => {
  const { collector } = await harness();
  const sections = collector.parseTasksMarkdown(TASKS_MD);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "1. Domain");
  assert.equal(sections[0].completed, 1);
  assert.equal(sections[0].total, 2);
  assert.deepEqual({ ...sections[0].tasks[0] }, { done: true, id: "1.1", text: "Enum + derive function" });
  assert.equal(sections[1].tasks[0].done, true);
});

test("collectChangeDetail resolves artifact paths for both openspec and docs/spectra", async () => {
  const { collector } = await harness();
  const d1 = await collector.collectChangeDetail(ROOT, "account-permission");
  assert.equal(d1.schema, "spec-driven");
  assert.equal(d1.artifacts[0].file, `${ROOT}/openspec/changes/account-permission/proposal.md`);
  assert.equal(d1.sections.length, 2);

  const d2 = await collector.collectChangeDetail(V3_ROOT, "account-permission");
  assert.equal(d2.artifacts[0].file, `${V3_ROOT}/docs/spectra/changes/account-permission/proposal.md`);
});

test("view renders right-side panel (tabs: tasks/changes/specs) and dialog mode", async () => {
  const { View, cx, settle, events } = await harness();

  const panel = new View();
  panel.init({}, cx);
  await settle();
  assert.equal(panel.role, "panel");
  assert.equal(panel.root, ROOT);
  assert.equal(panel.data.focus.name, "account-permission");
  assert.ok(panel.render(cx));
  panel.activeTab = "changes";
  assert.ok(panel.render(cx));
  panel.activeTab = "specs";
  assert.ok(panel.render(cx));
  assert.ok(events.some((e) => e[0] === "setShared" && e[1] === "spectra-status.last-root" && e[2] === ROOT));

  panel.openDetailedDialog();
  const open = events.find((e) => e[0] === "openOverlay");
  assert.equal(open[1].mod, "spectra-status");
  assert.equal(open[1].props.root, ROOT);

  const dialog = new View();
  dialog.init({ role: "dialog", overlay: "overlay-x", root: ROOT }, cx);
  await settle();
  assert.equal(dialog.selected.name, "account-permission");
  assert.ok(dialog.details.get("account-permission"));
  assert.ok(dialog.render(cx));
});

test("panel shows empty state when focused pane is not inside a Spectra project", async () => {
  const { View, cx, settle } = await harness({ cwd: "/home/user/elsewhere" });
  const panel = new View();
  panel.init({}, cx);
  await settle();
  assert.equal(panel.root, null);
  assert.ok(panel.render(cx));
});
