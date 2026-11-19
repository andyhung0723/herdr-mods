import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness({
  initialFile = null,
  cwd = "/home/user/proj-a",
  spacesList = null,
  panesList = null,
  focusedInfo = null,
  agentsList = [
    {
      address: "t2x",
      pane: "p1",
      space: "sp1",
      space_name: "proj-a",
      tab: "tab1",
      tab_index: 1,
      tab_name: "1 main",
      status: "idle",
      app: "claude-code",
      program: { key: "claude", name: "Claude Code", icon: null, tint: false, tile: null, color: null, shell: false, agent: true },
      title: "claude",
      seq: 10,
      pinned: false,
      focused: true,
    },
    {
      address: "t5b",
      pane: "p2",
      space: "sp1",
      space_name: "proj-a",
      tab: "tab2",
      tab_index: 2,
      tab_name: "2 codex",
      status: "working",
      app: "codex",
      program: { key: "codex", name: "Codex", icon: null, tint: false, tile: null, color: null, shell: false, agent: true },
      title: "codex",
      seq: 8,
      pinned: false,
      focused: false,
    },
  ],
  roleProps = {},
} = {}) {
  const events = [];
  const files = new Map();
  if (initialFile !== null) files.set("/home/user/.config/herdr-app/todos.json", initialFile);
  const sharedMap = new Map();
  const storageMap = new Map();

  const api = {
    appHome: () => "/home/user/.config/herdr-app",
    readTextFile: async (path) => files.get(path) ?? null,
    writeTextFile: async (path, text, expected) => {
      const current = files.get(path) ?? null;
      if (current !== expected) throw new Error("stale snapshot");
      files.set(path, text);
      events.push(["writeTextFile", path, text]);
      return null;
    },
    agents: () => agentsList,
    panes: () =>
      panesList ?? [
        {
          pane: "p1",
          terminal: "t2x",
          tab: "tab1",
          title: "claude",
          cwd,
          branch: "main",
          status: "idle",
          app: "claude-code",
          program: { key: "claude", name: "Claude Code", agent: true },
          focused: true,
        },
      ],
    spaces: () => spacesList ?? [{ id: "sp1", index: 1, name: "proj-a", folder: cwd, active: true, tabs: [] }],
    focused: () => focusedInfo ?? { space: "sp1", tab: "tab1", pane: "p1", terminal: "t2x", shown: null, agent: "t2x", cwd },
    layout: () => ({ id: "root", children: [{ id: "panel", size: { px: 440 } }] }),
    theme: () => ({
      chrome: "#181825",
      surface: "#181825",
      background: "#1e1e2e",
      popover: "#181825",
      raised: "#313244",
      hover: "#45475a",
      selected: "#313244",
      border: "#313244",
      input: "#45475a",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      accent_foreground: "#11111b",
      working: "#a6e3a1",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      blocked: "#fab387",
    }),
    props: () => roleProps,
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-todo";
    },
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    setShared: (k, v) => {
      sharedMap.set(k, v);
      events.push(["setShared", k, v]);
    },
    shared: (k) => sharedMap.get(k) ?? null,
    notify: (n) => {
      events.push(["notifyToast", n]);
      return "toast-1";
    },
    hc: async (args) => {
      events.push(["hc", args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    run: (name, args) => {
      events.push(["run", name, args]);
      return null;
    },
  };

  const localStorage = {
    getItem: (k) => storageMap.get(k) ?? null,
    setItem: (k, v) => storageMap.set(k, v),
  };

  const context = vm.createContext({ localStorage });
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const makeEl = (type) => {
    const el = {
      _type: type,
      _id: null,
      _children: [],
      _text: [],
      _onClick: null,
      _onMouseDown: null,
      _onMouseMove: null,
      _onMouseUp: null,
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        if (prop === "on_mouse_down") return (_btn, fn) => { target._onMouseDown = fn; return proxy; };
        if (prop === "on_mouse_move") return (fn) => { target._onMouseMove = fn; return proxy; };
        if (prop === "on_mouse_up") return (_btn, fn) => { target._onMouseUp = fn; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "children") return (arr) => {
          for (const c of arr ?? []) {
            if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
            else if (c) target._children.push(c);
          }
          return proxy;
        };
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(proxy) : proxy);
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

  const createInputState = () => {
    let val = "";
    const handlers = {};
    return {
      value: () => val,
      set_value: (next) => {
        val = String(next ?? "");
      },
      on: (evt, fn) => {
        handlers[evt] = fn;
        return true;
      },
      focus: () => {},
      triggerSubmit: (cx) => handlers.submit?.({}, cx),
    };
  };

  const kit = synthetic({ View: class {}, div: () => makeEl("div"), svg: () => makeEl("svg") });
  const base = synthetic({
    v_flex: () => makeEl("v_flex"),
    h_flex: () => makeEl("h_flex"),
    InputState: { new: createInputState },
    Input: { new: () => makeEl("Input") },
  });
  const herdr = synthetic(api);

  const storeCode = await readFile(new URL("../mods/todo-list/store.js", import.meta.url), "utf8");
  const store = new vm.SourceTextModule(storeCode, { context });
  await store.link((name) => ({ herdr }[name]));
  await store.evaluate();

  const mainCode = await readFile(new URL("../mods/todo-list/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr, "./store.js": store }[name]));
  await main.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    spawn: (fn) => Promise.resolve().then(() => fn(cx)),
    timer: { every: () => {}, after: () => {} },
    notify: () => events.push(["cx.notify"]),
    stop_propagation: () => {},
  };

  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  return { store: store.namespace, View: main.namespace.default, cx, events, files, settle, findById, collectText };
}

test("store builds structured prompts for single task and batch dispatch", async () => {
  const { store } = await harness();

  const t1 = store.createTask({
    title: "Fix WebSocket reconnect",
    notes: "Ensure exponential backoff stops after unmount",
    priority: "P1",
    project: "/home/user/proj-a",
    subtasks: [
      { title: "Add cleanup in useEffect", done: true },
      { title: "Add unit test", done: false },
    ],
  });

  const singlePrompt = store.buildAgentPrompt([t1]);
  assert.match(singlePrompt, /\[Priority: P1\]/);
  assert.match(singlePrompt, /Project: \/home\/user\/proj-a/);
  assert.match(singlePrompt, /## Fix WebSocket reconnect/);
  assert.match(singlePrompt, /### Context & Notes\nEnsure exponential backoff/);
  assert.match(singlePrompt, /- \[x\] Add cleanup in useEffect \(already done\)/);
  assert.match(singlePrompt, /- \[ \] Add unit test/);

  const t2 = store.createTask({
    title: "Update CHANGELOG",
    priority: "P3",
    project: "/home/user/proj-a",
  });
  const batchPrompt = store.buildAgentPrompt([t1, t2]);
  assert.match(batchPrompt, /complete the following 2 tasks in order/);
  assert.match(batchPrompt, /### 1\. \[P1\] Fix WebSocket reconnect/);
  assert.match(batchPrompt, /### 2\. \[P3\] Update CHANGELOG/);
});

test("store sends prompt via hc send and spawns new tab via run('tab.new')", async () => {
  const { store, events } = await harness();
  const t = store.createTask({ title: "Write tests", project: "/home/user/proj-a" });

  const sendRes = await store.sendTasksToAgent([t], "t2x");
  assert.equal(sendRes.ok, true);
  const hcCall = events.find((e) => e[0] === "hc");
  assert.equal(hcCall[1][0], "send");
  assert.equal(hcCall[1][1], "t2x");
  assert.match(hcCall[1][2], /Write tests/);

  const tabRes = await store.spawnAgentTabWithTasks([t], { agentCli: "codex", folder: "/home/user/proj-a" });
  assert.equal(tabRes.ok, true);
  const runCall = events.find((e) => e[0] === "run" && e[1] === "tab.new");
  assert.deepEqual([...runCall[2].argv], ["codex"]);
  assert.equal(runCall[2].folder, "/home/user/proj-a");
  assert.match(runCall[2].task, /Write tests/);
});

test("view manages tasks, subtasks, and one-click/batch agent dispatch", async () => {
  const { View, cx, events, files, settle } = await harness();

  const view = new View();
  view.init({}, cx);
  await settle();

  assert.equal(view.role, "panel");
  assert.equal(view.activeProject.name, "proj-a");

  // Add first task with notes & immediately inspect
  view.newPriority = "P1";
  view.titleInput.set_value("Refactor auth middleware");
  view.notesInput.set_value("Check token expiry edge cases");
  await view.handleAddTask(cx, false);

  assert.equal(view.tasks.length, 1);
  const first = view.tasks[0];
  assert.equal(first.priority, "P1");
  assert.equal(first.project, "/home/user/proj-a");

  // Add subtask
  view.expandedTaskId = first.id;
  view.subtaskInput.set_value("Verify refresh flow");
  await view.handleAddSubtask(first.id, cx);
  assert.equal(view.tasks[0].subtasks.length, 1);

  // Add second task
  view.newPriority = "P2";
  view.titleInput.set_value("Add metrics endpoint");
  await view.handleAddTask(cx, false);
  assert.equal(view.tasks.length, 2);

  // One-click send single task
  await view.handleSendTask(view.tasks[1], cx);
  const updatedFirst = view.tasks.find((t) => t.id === first.id);
  assert.equal(updatedFirst.status, "in_progress");
  assert.equal(updatedFirst.assignedAgent.address, "t2x");
  assert.equal(updatedFirst.assignedAgent.shortLabel, "main");
  assert.equal(updatedFirst.assignedAgent.label, "proj-a · main");
  assert.doesNotMatch(updatedFirst.assignedAgent.label, /\(t2x\)/);

  // Multi-select batch dispatch to second agent (after cycling)
  view.cycleTargetAgent(cx);
  view.selectedIds.add(view.tasks[0].id);
  view.selectedIds.add(view.tasks[1].id);
  await view.handleSendBatch(cx);

  const hcCalls = events.filter((e) => e[0] === "hc");
  assert.equal(hcCalls.length, 2);
  assert.equal(hcCalls[1][1][1], "t5b");
  assert.match(hcCalls[1][1][2], /complete the following 2 tasks/);
  assert.equal(view.selectedIds.size, 0);

  // Verify persisted to todos.json
  const savedRaw = files.get("/home/user/.config/herdr-app/todos.json");
  assert.ok(savedRaw);
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.tasks.length, 2);

  // Render panel and dialog cleanly
  assert.ok(view.render(cx));

  const dialogView = new View();
  dialogView.init({ overlay: "ov-1", role: "dialog" }, cx);
  await settle();
  assert.equal(dialogView.role, "dialog");
  assert.ok(dialogView.render(cx));
});

test("view supports sort mode cycling, manual reordering, and ordered batch dispatch", async () => {
  const { View, cx, events, files, settle } = await harness();

  const view = new View();
  view.init({}, cx);
  await settle();

  assert.equal(view.sortMode, "manual");

  // Add two tasks with explicit priority difference so manual vs priority differ
  view.newPriority = "P3";
  view.titleInput.set_value("Low priority first");
  await view.handleAddTask(cx, false);
  await new Promise((r) => setTimeout(r, 5));

  view.newPriority = "P1";
  view.titleInput.set_value("High priority second");
  await view.handleAddTask(cx, false);

  // In manual mode, newest added with minOrder-1 sits at index 0
  let visible = view.getVisibleTasks();
  assert.equal(visible[0].title, "High priority second");
  assert.equal(visible[1].title, "Low priority first");

  // Move bottom task up to index 0
  await view.handleMoveTask(visible[1].id, -1, cx);
  visible = view.getVisibleTasks();
  assert.equal(visible[0].title, "Low priority first");
  assert.equal(visible[1].title, "High priority second");

  // Batch send follows manual visual order ("Low priority first" is #1)
  view.selectedIds.add(visible[0].id);
  view.selectedIds.add(visible[1].id);
  await view.handleSendBatch(cx);
  const hcCall = events.find((e) => e[0] === "hc");
  assert.match(hcCall[1][2], /### 1\. \[P3\] Low priority first[\s\S]*### 2\. \[P1\] High priority second/);

  // Cycle sort mode -> priority -> P1 sits first again
  await view.cycleSortMode(cx);
  assert.equal(view.sortMode, "priority");
  visible = view.getVisibleTasks();
  assert.equal(visible[0].priority, "P1");

  // Cycle through remaining modes
  await view.cycleSortMode(cx);
  assert.equal(view.sortMode, "newest");
  await view.cycleSortMode(cx);
  assert.equal(view.sortMode, "oldest");
  await view.cycleSortMode(cx);
  assert.equal(view.sortMode, "manual");

  const savedRaw = files.get("/home/user/.config/herdr-app/todos.json");
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.sortMode, "manual");
});

test("resolveAvailableAgents matches Agents sidebar names without internal terminal IDs", async () => {
  const { store } = await harness({
    spacesList: [
      {
        id: "sp1",
        index: 1,
        name: "playground",
        folder: "/home/user/playground",
        active: true,
        tabs: [
          { id: "tab1", index: 1, name: "Paliw", named: true },
          { id: "tab2", index: 4, name: "4", named: false },
          { id: "tab3", index: 5, name: "5", named: false },
          { id: "tab4", index: 6, name: "6", named: false },
        ],
      },
    ],
    panesList: [
      {
        pane: "p1",
        terminal: "t2x",
        tab: "tab1",
        title: "✳ some random title",
        cwd: "/home/user/playground",
        program: { key: "claude", name: "Claude Code", agent: true },
        focused: false,
      },
      {
        pane: "p2",
        terminal: "t39",
        tab: "tab2",
        title: "✳ herdr 相關",
        cwd: "/home/user/playground",
        program: { key: "claude", name: "Claude Code", agent: true },
        focused: true,
      },
      {
        pane: "p3",
        terminal: "t40",
        tab: "tab3",
        title: "~/playground",
        cwd: "/home/user/playground",
        program: { key: "claude", name: "Claude Code", agent: true },
        focused: false,
      },
      {
        pane: "p4",
        terminal: "t41",
        tab: "tab4",
        title: "Claude Code",
        cwd: "/home/user/playground",
        program: { key: "claude", name: "Claude Code", agent: true },
        focused: false,
      },
    ],
    agentsList: [
      {
        address: "t2x",
        pane: "p1",
        space: "sp1",
        space_name: "playground",
        tab: "tab1",
        tab_index: 1,
        tab_name: "Paliw",
        status: "working",
        app: "claude-code",
        program: { key: "claude", name: "Claude Code", agent: true },
        title: "✳ some random title",
        focused: false,
      },
      {
        address: "t39",
        pane: "p2",
        space: "sp1",
        space_name: "playground",
        tab: "tab2",
        tab_index: 4,
        tab_name: "4",
        status: "working",
        app: "claude-code",
        program: { key: "claude", name: "Claude Code", agent: true },
        title: "✳ herdr 相關",
        focused: true,
      },
      {
        address: "t40",
        pane: "p3",
        space: "sp1",
        space_name: "playground",
        tab: "tab3",
        tab_index: 5,
        tab_name: "5",
        status: "done",
        app: "claude-code",
        program: { key: "claude", name: "Claude Code", agent: true },
        title: "~/playground",
        focused: false,
      },
      {
        address: "t41",
        pane: "p4",
        space: "sp1",
        space_name: "playground",
        tab: "tab4",
        tab_index: 6,
        tab_name: "6",
        status: "idle",
        app: "claude-code",
        program: { key: "claude", name: "Claude Code", agent: true },
        title: "Claude Code",
        focused: false,
      },
    ],
    focusedInfo: { space: "sp1", tab: "tab2", pane: "p2", terminal: "t39", agent: "t39" },
  });

  const { candidates, selected } = store.resolveAvailableAgents();
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].label, "playground · Paliw");
  assert.equal(candidates[0].shortLabel, "Paliw");
  assert.equal(candidates[1].label, "playground · herdr 相關");
  assert.equal(candidates[1].shortLabel, "herdr 相關");
  assert.equal(candidates[2].label, "playground · Claude Code #5");
  assert.equal(candidates[2].shortLabel, "Claude Code #5");
  assert.equal(candidates[3].label, "playground · Claude Code #6");
  assert.equal(candidates[3].shortLabel, "Claude Code #6");
  assert.equal(selected.address, "t39");
  for (const c of candidates) {
    assert.doesNotMatch(c.label, /\(t\d+/);
    assert.doesNotMatch(c.shortLabel, /\bt\d+/);
  }
});

test("view supports manual status changes and displays counts on status filter tabs", async () => {
  const { View, cx, settle, findById, collectText } = await harness();

  const view = new View();
  view.init({}, cx);
  await settle();

  view.titleInput.set_value("Task A");
  await view.handleAddTask(cx, false);
  view.titleInput.set_value("Task B");
  await view.handleAddTask(cx, false);
  view.titleInput.set_value("Task C");
  await view.handleAddTask(cx, false);

  const taskA = view.tasks.find((t) => t.title === "Task A");
  const taskB = view.tasks.find((t) => t.title === "Task B");
  const taskC = view.tasks.find((t) => t.title === "Task C");

  assert.deepEqual(
    { ...view.getStatusCounts() },
    {
      activeCount: 3,
      inProgressCount: 0,
      doneCount: 0,
      allCount: 3,
    }
  );

  // Cycle Task A: todo -> in_progress -> done -> todo
  await view.handleCycleStatus(taskA, cx);
  assert.equal(view.tasks.find((t) => t.id === taskA.id).status, "in_progress");

  // Direct set status on Task B -> done
  await view.handleSetStatus(taskB, "done", cx);
  assert.equal(view.tasks.find((t) => t.id === taskB.id).status, "done");

  assert.deepEqual(
    { ...view.getStatusCounts() },
    {
      activeCount: 2,
      inProgressCount: 1,
      doneCount: 1,
      allCount: 3,
    }
  );

  // Expand Task C so drawer status picker renders too
  view.expandedTaskId = taskC.id;
  const tree = view.render(cx);

  assert.equal(collectText(findById(tree, "todo-status-active")).join(""), "Active (2)");
  assert.equal(collectText(findById(tree, "todo-status-in_progress")).join(""), "In Progress (1)");
  assert.equal(collectText(findById(tree, "todo-status-done")).join(""), "Done (1)");
  assert.equal(collectText(findById(tree, "todo-status-all")).join(""), "Everything (3)");

  // Click card status badge to cycle Task C todo -> in_progress
  const badgeC = findById(tree, `todo-status-badge-${taskC.id}`);
  assert.ok(badgeC, "Card should render clickable #todo-status-badge");
  await badgeC._onClick({}, cx);
  assert.equal(view.tasks.find((t) => t.id === taskC.id).status, "in_progress");

  // Drawer status picker button sets Task C back to todo & clears assignedAgent
  const drawerTodoBtn = findById(tree, `todo-drawer-status-${taskC.id}-todo`);
  assert.ok(drawerTodoBtn, "Drawer should render direct status picker buttons");
  await drawerTodoBtn._onClick({}, cx);
  assert.equal(view.tasks.find((t) => t.id === taskC.id).status, "todo");

  // Cycle Task A in_progress -> done -> todo
  await view.handleCycleStatus(view.tasks.find((t) => t.id === taskA.id), cx);
  assert.equal(view.tasks.find((t) => t.id === taskA.id).status, "done");
  await view.handleCycleStatus(view.tasks.find((t) => t.id === taskA.id), cx);
  assert.equal(view.tasks.find((t) => t.id === taskA.id).status, "todo");
});

test("view supports editing task title, notes, and priority as well as canceling edits", async () => {
  const { View, cx } = await harness();
  const view = new View();
  view.init({}, cx);
  await new Promise((r) => setTimeout(r, 10));

  view.titleInput.set_value("初始任務標題");
  view.notesInput.set_value("初始備註");
  await view.handleAddTask(cx, false);
  const task = view.tasks[0];
  assert.equal(task.priority, "P2");

  // Start edit, verify inputs are pre-filled and renderEditForm renders cleanly, then cancel
  view.startEditTask(task, cx);
  assert.equal(view.editingTaskId, task.id);
  const editTree = view.render(cx);
  assert.ok(editTree, "Should render edit form without throwing");
  assert.equal(view.editTitleInput.value(), "初始任務標題");
  assert.equal(view.editNotesInput.value(), "初始備註");
  view.editTitleInput.set_value("不應該被存下來的標題");
  view.cancelEditTask(cx);
  assert.equal(view.editingTaskId, null);
  assert.equal(view.tasks[0].title, "初始任務標題");

  // Start edit again, update title, notes, priority, and save
  view.startEditTask(task, cx);
  view.editTitleInput.set_value("更新後的繁體中文標題");
  view.editNotesInput.set_value("補充細節與驗證步驟");
  view.editPriority = "P1";
  await view.handleSaveEdit(cx);

  assert.equal(view.editingTaskId, null);
  assert.equal(view.tasks[0].title, "更新後的繁體中文標題");
  assert.equal(view.tasks[0].notes, "補充細節與驗證步驟");
  assert.equal(view.tasks[0].priority, "P1");
});

test("copyPromptToClipboard preserves Traditional Chinese via write_to_clipboard and UTF-8 pbcopy fallback", async () => {
  const { store, View, cx, events } = await harness();
  const copied = [];
  cx.write_to_clipboard = (text) => copied.push(text);

  const view = new View();
  view.init({}, cx);
  await new Promise((r) => setTimeout(r, 10));

  view.titleInput.set_value("修正繁體中文複製亂碼問題");
  view.notesInput.set_value("確認貼上後文字正常顯示");
  await view.handleAddTask(cx, false);

  await view.handleCopyPrompt([view.tasks[0]], cx);
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes("修正繁體中文複製亂碼問題"));
  assert.ok(copied[0].includes("確認貼上後文字正常顯示"));

  // Fallback without cx.write_to_clipboard must set UTF-8 locale and CF text encoding for pbcopy
  const fallbackRes = await store.copyPromptToClipboard([view.tasks[0]], { projectPath: "/home/user/proj-a" });
  assert.equal(fallbackRes.ok, true);
  const pbcopyCall = events.find((e) => e[0] === "exec" && e[1] === "sh" && e[2][1].includes("pbcopy"));
  assert.ok(pbcopyCall, "Fallback should invoke pbcopy");
  assert.ok(pbcopyCall[2][1].includes("LC_ALL=en_US.UTF-8"));
  assert.ok(pbcopyCall[2][1].includes("__CF_USER_TEXT_ENCODING=0x1F5:0x8000100:0x8000100"));
});

test("view supports drag-and-drop reordering and removes up/down arrow buttons", async () => {
  const { View, cx, findById } = await harness();
  const view = new View();
  view.init({}, cx);
  await new Promise((r) => setTimeout(r, 10));

  view.titleInput.set_value("First");
  await view.handleAddTask(cx, false);
  view.titleInput.set_value("Second");
  await view.handleAddTask(cx, false);
  view.titleInput.set_value("Third");
  await view.handleAddTask(cx, false);

  let visible = view.getVisibleTasks();
  assert.deepEqual(Array.from(visible, (t) => t.title), ["Third", "Second", "First"]);

  const tree = view.render(cx);
  assert.equal(findById(tree, `todo-up-${visible[0].id}`), null, "Up button should be removed");
  assert.equal(findById(tree, `todo-down-${visible[0].id}`), null, "Down button should be removed");

  const card0 = findById(tree, `todo-card-${visible[0].id}`);
  const card2 = findById(tree, `todo-card-${visible[2].id}`);
  assert.ok(card0 && card2, "Task cards should render with todo-card-<id>");

  // Drag Third (index 0) onto First (index 2)
  card0._onMouseDown({}, cx);
  assert.equal(view.dragTaskId, visible[0].id);
  card2._onMouseMove({}, cx);
  assert.equal(view.dragOverTaskId, visible[2].id);
  card2._onMouseUp({}, cx);
  await new Promise((r) => setTimeout(r, 10));

  visible = view.getVisibleTasks();
  assert.deepEqual(Array.from(visible, (t) => t.title), ["Second", "First", "Third"]);
  assert.equal(view.dragTaskId, null);
  assert.equal(view.dragOverTaskId, null);
});
