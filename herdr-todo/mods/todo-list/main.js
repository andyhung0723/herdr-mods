// Todo List & One-Click Agent Task Dispatcher mod for Herdr.
// Supports Right-Side Panel mode and Popup Dialog mode (Ctrl+B o).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  theme,
  props,
  closeOverlay,
  openOverlay,
  setShared,
  shared,
  notify,
  layout,
} from "herdr";
import {
  GLOBAL_PROJECT,
  AGENT_CLI_CHOICES,
  SORT_MODES,
  SORT_LABELS,
  SHARED_STORE_VERSION_KEY,
  createTask,
  sortTasks,
  moveTaskInList,
  reorderTaskInList,
  loadStore,
  saveStore,
  resolveActiveProject,
  resolveAvailableAgents,
  buildAgentPrompt,
  sendTasksToAgent,
  spawnAgentTabWithTasks,
  copyPromptToClipboard,
} from "./store.js";

const MOD = "todo-list";
const OVERLAY_KEY = "todo-list.open-overlay";

const ICON_TODO = `mods/${MOD}/todo.svg`;
const ICON_SEND = `mods/${MOD}/send.svg`;
const ICON_PLUS = `mods/${MOD}/plus.svg`;
const ICON_TRASH = `mods/${MOD}/trash.svg`;
const ICON_COPY = `mods/${MOD}/copy.svg`;
const ICON_TERMINAL = `mods/${MOD}/terminal.svg`;
const ICON_TARGET = `mods/${MOD}/target.svg`;
const ICON_PLAY = `mods/${MOD}/play.svg`;
const ICON_X = `mods/${MOD}/x.svg`;
const ICON_EXTERNAL = `mods/${MOD}/external-link.svg`;
const ICON_SORT = `mods/${MOD}/arrow-up-down.svg`;

const ICON_CIRCLE_CHECK = "mods/workspace-chrome/circle-check.svg";
const ICON_SQUARE = "mods/workspace-chrome/square.svg";
const ICON_CHEVRON_RIGHT = "mods/workspace-chrome/chevron-right.svg";
const ICON_CHEVRON_DOWN = "mods/workspace-chrome/chevron-down.svg";

const PRIORITIES = ["P1", "P2", "P3"];
const TASK_STATUSES = ["todo", "in_progress", "done"];
const TASK_STATUS_LABELS = {
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
};

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return null;
}

function getPanelWidth() {
  try {
    const root = typeof layout === "function" ? layout() : null;
    const panel = findNode(root, "panel");
    const px = panel?.size?.px;
    return typeof px === "number" && px > 0 ? px : null;
  } catch {
    return null;
  }
}

function withAlpha(hex, alphaHex = "22") {
  if (typeof hex !== "string" || !hex.startsWith("#")) return `#3b82f6${alphaHex}`;
  return hex.slice(0, 7) + alphaHex;
}

function priorityColors(t, priority) {
  if (priority === "P1") {
    const fg = t.ansi1 ?? t.blocked ?? "#f38ba8";
    return { fg, bg: withAlpha(fg, "22") };
  }
  if (priority === "P2") {
    const fg = t.accent ?? "#89b4fa";
    return { fg, bg: withAlpha(fg, "22") };
  }
  return {
    fg: t.dim ?? t.muted,
    bg: (t.surface ?? t.background),
  };
}

function safeNotify(payload) {
  try {
    if (typeof notify === "function") notify(payload);
  } catch {}
}

export default class TodoListView extends View {
  init(initialProps, cx) {
    this.asyncCx = cx;
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "panel");

    this.tasks = [];
    this.lastExpectedRaw = null;
    this.lastStoreVersion = shared(SHARED_STORE_VERSION_KEY) ?? null;
    this.loaded = false;

    this.scopeTab = "project"; // "project" | "global" | "all"
    this.statusFilter = "active"; // "active" | "in_progress" | "done" | "all"
    this.sortMode = "manual"; // "manual" | "priority" | "newest" | "oldest"
    this.newPriority = "P2";
    this.showComposerNotes = false;
    this.expandedTaskId = null;
    this.selectedIds = new Set();
    this.selectedAgentAddress = null;
    this.lastAgentCandidates = [];
    this.preferredAgentCli = "claude";
    this.sendingId = null;
    this.feedbackMsg = "";
    this.editingTaskId = null;
    this.editPriority = "P2";
    this.dragTaskId = null;
    this.dragOverTaskId = null;

    this.activeProject = resolveActiveProject();
    this.lastWidthBucket = this.computeWidthBucket();
    this.handle = cx.focus_handle();

    this.titleInput = InputState.new({ placeholder: "Add a task… (Enter to save)" });
    this.notesInput = InputState.new({ placeholder: "Notes / prompt context for Agent (optional)…" });
    this.subtaskInput = InputState.new({ placeholder: "Add subtask step… (Enter)" });
    this.editTitleInput = InputState.new({ placeholder: "Task title…" });
    this.editNotesInput = InputState.new({ placeholder: "Notes / prompt context for Agent (optional)…" });

    this.titleInput.on("submit", (_e, subCx) => this.handleAddTask(subCx, false));
    this.editTitleInput.on("submit", (_e, subCx) => this.handleSaveEdit(subCx));
    this.subtaskInput.on("submit", (_e, subCx) => {
      if (this.expandedTaskId) {
        this.handleAddSubtask(this.expandedTaskId, subCx);
      }
    });

    if (this.role === "dialog") {
      this.handle.focus();
      cx.timer.after(120, () => this.titleInput.focus());
    }

    this.reloadStore(cx);

    cx.timer.every(1000, (tcx) => {
      let dirty = false;
      const proj = resolveActiveProject();
      if (proj.path !== this.activeProject.path) {
        this.activeProject = proj;
        dirty = true;
      }
      const bucket = this.computeWidthBucket();
      if (bucket !== this.lastWidthBucket) {
        this.lastWidthBucket = bucket;
        dirty = true;
      }
      const sharedVer = shared(SHARED_STORE_VERSION_KEY);
      if (sharedVer && sharedVer !== this.lastStoreVersion) {
        this.lastStoreVersion = sharedVer;
        this.reloadStore(tcx);
        return;
      }
      if (dirty) tcx?.notify?.();
    });
  }

  computeWidthBucket() {
    if (this.role === "dialog") return "normal";
    const w = getPanelWidth();
    if (w === null) return "normal";
    if (w < 365) return "very-narrow";
    if (w < 430) return "narrow";
    return "normal";
  }

  async reloadStore(cx) {
    const store = await loadStore();
    this.tasks = Array.isArray(store.tasks) ? store.tasks : [];
    this.preferredAgentCli = store.preferredAgentCli || "claude";
    this.sortMode = SORT_MODES.includes(store.sortMode) ? store.sortMode : "manual";
    this.lastExpectedRaw = store.lastExpectedRaw ?? null;
    this.loaded = true;
    if (this.role === "dialog" && !this.expandedTaskId && this.tasks.length > 0) {
      const firstVisible = this.getVisibleTasks()[0];
      if (firstVisible) this.expandedTaskId = firstVisible.id;
    }
    (this.asyncCx ?? cx)?.notify?.();
  }

  async persistStore(cx) {
    const raw = await saveStore({
      tasks: this.tasks,
      preferredAgentCli: this.preferredAgentCli,
      sortMode: this.sortMode,
      lastExpectedRaw: this.lastExpectedRaw,
    });
    this.lastExpectedRaw = raw;
    this.lastStoreVersion = shared(SHARED_STORE_VERSION_KEY) ?? this.lastStoreVersion;
    (this.asyncCx ?? cx)?.notify?.();
  }

  // --- Filtering & Selection Helpers --------------------------------------

  getScopedTasks() {
    const projPath = this.activeProject?.path || GLOBAL_PROJECT;
    if (this.scopeTab === "global") {
      return this.tasks.filter((t) => t.project === GLOBAL_PROJECT);
    }
    if (this.scopeTab === "project" && projPath !== GLOBAL_PROJECT) {
      return this.tasks.filter((t) => t.project === projPath);
    }
    return this.tasks;
  }

  getVisibleTasks() {
    const scoped = this.getScopedTasks();
    const filtered = scoped.filter((t) => {
      if (this.statusFilter === "active") return t.status !== "done";
      if (this.statusFilter === "in_progress") return t.status === "in_progress";
      if (this.statusFilter === "done") return t.status === "done";
      return true;
    });
    return sortTasks(filtered, this.sortMode);
  }

  getOrderedSelectedTasks() {
    if (this.selectedIds.size === 0) return [];
    return sortTasks(
      this.tasks.filter((t) => this.selectedIds.has(t.id)),
      this.sortMode
    );
  }

  getScopeCounts() {
    const projPath = this.activeProject?.path || GLOBAL_PROJECT;
    let projectCount = 0;
    let globalCount = 0;
    let allActiveCount = 0;
    for (const t of this.tasks) {
      const active = t.status !== "done";
      if (active) allActiveCount++;
      if (t.project === GLOBAL_PROJECT && active) globalCount++;
      if (projPath !== GLOBAL_PROJECT && t.project === projPath && active) projectCount++;
    }
    return { projectCount, globalCount, allActiveCount };
  }

  getStatusCounts() {
    const scoped = this.getScopedTasks();
    let activeCount = 0;
    let inProgressCount = 0;
    let doneCount = 0;
    for (const t of scoped) {
      if (t.status === "done") doneCount++;
      else activeCount++;
      if (t.status === "in_progress") inProgressCount++;
    }
    return {
      activeCount,
      inProgressCount,
      doneCount,
      allCount: scoped.length,
    };
  }

  // --- Actions ------------------------------------------------------------

  openDetailedDialog() {
    if (this.overlayId) return;
    const existing = shared(OVERLAY_KEY);
    if (existing) closeOverlay(existing);
    const id = openOverlay({
      mod: MOD,
      kind: "dialog",
      width: 860,
      height: 640,
      props: { role: "dialog" },
    });
    setShared(OVERLAY_KEY, id);
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  cycleNewPriority(clickCx) {
    const idx = PRIORITIES.indexOf(this.newPriority);
    this.newPriority = PRIORITIES[(idx + 1) % PRIORITIES.length];
    clickCx?.notify?.();
  }

  cycleTargetAgent(clickCx) {
    const { candidates, selected } = resolveAvailableAgents(this.selectedAgentAddress);
    if (candidates.length === 0) {
      this.selectedAgentAddress = null;
      clickCx?.notify?.();
      return;
    }
    const idx = candidates.findIndex((c) => c.address === selected?.address);
    const next = candidates[(idx + 1) % candidates.length];
    this.selectedAgentAddress = next.address;
    clickCx?.notify?.();
  }

  async cycleAgentCli(clickCx) {
    const idx = AGENT_CLI_CHOICES.indexOf(this.preferredAgentCli);
    this.preferredAgentCli = AGENT_CLI_CHOICES[(idx + 1) % AGENT_CLI_CHOICES.length];
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async cycleSortMode(clickCx) {
    const idx = SORT_MODES.indexOf(this.sortMode);
    this.sortMode = SORT_MODES[(idx + 1) % SORT_MODES.length];
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleMoveTask(taskId, direction, clickCx) {
    const visible = this.getVisibleTasks();
    const updated = moveTaskInList(this.tasks, visible, taskId, direction);
    if (updated === this.tasks) return;
    this.tasks = updated;
    if (this.sortMode !== "manual") {
      this.sortMode = "manual";
      this.feedbackMsg = "Switched to Manual order";
    }
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleReorderTask(fromTaskId, toTaskId, clickCx) {
    const visible = this.getVisibleTasks();
    const updated = reorderTaskInList(this.tasks, visible, fromTaskId, toTaskId);
    if (updated === this.tasks) return;
    this.tasks = updated;
    if (this.sortMode !== "manual") {
      this.sortMode = "manual";
      this.feedbackMsg = "Switched to Manual order";
    }
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleAddTask(clickCx, sendImmediately = false) {
    const title = this.titleInput.value().trim();
    const notes = this.notesInput.value().trim();
    if (!title) {
      this.titleInput.focus();
      return;
    }

    const useGlobal = this.scopeTab === "global" || this.activeProject.isGlobal;
    const minOrder =
      this.tasks.reduce((m, t) => Math.min(m, typeof t.order === "number" ? t.order : 0), 0) - 1;
    const task = createTask({
      title,
      notes,
      priority: this.newPriority,
      project: useGlobal ? GLOBAL_PROJECT : this.activeProject.path,
      projectName: useGlobal ? "Global" : this.activeProject.name,
      order: minOrder,
    });

    this.tasks = [task, ...this.tasks];
    this.titleInput.set_value("");
    this.notesInput.set_value("");
    this.showComposerNotes = false;
    if (this.role === "dialog" || task.notes) {
      this.expandedTaskId = task.id;
    }
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);

    if (sendImmediately) {
      await this.handleSendTask(task, this.asyncCx);
    }
  }

  async handleToggleStatus(task, clickCx) {
    if (!task) return;
    const nextStatus = task.status === "done" ? "todo" : "done";
    await this.handleSetStatus(task, nextStatus, clickCx);
  }

  async handleSetStatus(task, nextStatus, clickCx) {
    if (!task || !TASK_STATUSES.includes(nextStatus)) return;
    this.tasks = this.tasks.map((t) =>
      t.id === task.id
        ? {
            ...t,
            status: nextStatus,
            assignedAgent: nextStatus === "todo" ? null : t.assignedAgent,
            updatedAt: Date.now(),
          }
        : t
    );
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleCycleStatus(task, clickCx) {
    if (!task) return;
    const currentIdx = TASK_STATUSES.indexOf(task.status);
    const nextStatus = TASK_STATUSES[(currentIdx + 1) % TASK_STATUSES.length];
    await this.handleSetStatus(task, nextStatus, clickCx);
  }

  async handleCyclePriority(task, clickCx) {
    if (!task) return;
    const idx = PRIORITIES.indexOf(task.priority);
    const nextPriority = PRIORITIES[(idx + 1) % PRIORITIES.length];
    this.tasks = this.tasks.map((t) =>
      t.id === task.id ? { ...t, priority: nextPriority, updatedAt: Date.now() } : t
    );
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleAddSubtask(taskId, clickCx) {
    const step = this.subtaskInput.value().trim();
    if (!taskId || !step) return;
    const sub = {
      id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      title: step,
      done: false,
    };
    this.tasks = this.tasks.map((t) =>
      t.id === taskId
        ? { ...t, subtasks: [...(t.subtasks || []), sub], updatedAt: Date.now() }
        : t
    );
    this.subtaskInput.set_value("");
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleToggleSubtask(taskId, subId, clickCx) {
    this.tasks = this.tasks.map((t) => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        subtasks: (t.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)),
        updatedAt: Date.now(),
      };
    });
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleDeleteSubtask(taskId, subId, clickCx) {
    this.tasks = this.tasks.map((t) => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        subtasks: (t.subtasks || []).filter((s) => s.id !== subId),
        updatedAt: Date.now(),
      };
    });
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleDeleteTask(taskId, clickCx) {
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    this.selectedIds.delete(taskId);
    if (this.expandedTaskId === taskId) this.expandedTaskId = null;
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleClearDone(clickCx) {
    const doneIds = new Set(this.getScopedTasks().filter((t) => t.status === "done").map((t) => t.id));
    if (doneIds.size === 0) return;
    this.tasks = this.tasks.filter((t) => !doneIds.has(t.id));
    for (const id of doneIds) this.selectedIds.delete(id);
    if (this.expandedTaskId && doneIds.has(this.expandedTaskId)) this.expandedTaskId = null;
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleSendTask(task, clickCx) {
    if (!task) return;
    await this.dispatchTasks([task], clickCx, task.id);
  }

  async handleSendBatch(clickCx) {
    const list = this.getOrderedSelectedTasks();
    if (list.length === 0) return;
    await this.dispatchTasks(list, clickCx, "batch");
  }

  async dispatchTasks(taskList, clickCx, sendingKey) {
    const { selected } = resolveAvailableAgents(this.selectedAgentAddress);
    if (!selected) {
      safeNotify({
        title: "No Active Agent",
        body: "Start Claude/Codex/Agy first, or use '+ Tab' to launch a new Agent tab.",
        level: "warning",
      });
      this.feedbackMsg = "No running Agent found — try '+ Tab'";
      (clickCx ?? this.asyncCx)?.notify?.();
      return;
    }

    this.sendingId = sendingKey;
    (clickCx ?? this.asyncCx)?.notify?.();

    const res = await sendTasksToAgent(taskList, selected.address, {
      projectPath: this.activeProject.path,
    });

    this.sendingId = null;
    if (res.ok) {
      const sentIds = new Set(taskList.map((t) => t.id));
      const assigned = {
        address: selected.address,
        label: selected.label,
        shortLabel: selected.shortLabel,
        sentAt: Date.now(),
      };
      this.tasks = this.tasks.map((t) =>
        sentIds.has(t.id)
          ? { ...t, status: "in_progress", assignedAgent: assigned, updatedAt: Date.now() }
          : t
      );
      if (sendingKey === "batch") this.selectedIds.clear();
      this.feedbackMsg = `Sent ${taskList.length} task(s) to ${selected.shortLabel}`;
      safeNotify({
        title: "Sent to Agent",
        body: `${selected.label}: ${taskList.length === 1 ? taskList[0].title : `${taskList.length} tasks`}`,
        level: "success",
      });
      await this.persistStore(this.asyncCx);
    } else {
      this.feedbackMsg = res.error || "Failed to send to Agent";
      safeNotify({
        title: "Agent Dispatch Failed",
        body: this.feedbackMsg,
        level: "error",
      });
      (this.asyncCx ?? clickCx)?.notify?.();
    }
  }

  async handleSpawnTab(taskList, clickCx) {
    if (!taskList || taskList.length === 0) return;
    const folder =
      taskList[0].project && taskList[0].project !== GLOBAL_PROJECT
        ? taskList[0].project
        : this.activeProject.path;

    const res = await spawnAgentTabWithTasks(taskList, {
      agentCli: this.preferredAgentCli,
      folder,
    });
    if (res.ok) {
      const sentIds = new Set(taskList.map((t) => t.id));
      const assigned = {
        address: `new-tab:${this.preferredAgentCli}`,
        label: `${this.preferredAgentCli} (New Tab)`,
        sentAt: Date.now(),
      };
      this.tasks = this.tasks.map((t) =>
        sentIds.has(t.id)
          ? { ...t, status: "in_progress", assignedAgent: assigned, updatedAt: Date.now() }
          : t
      );
      this.selectedIds.clear();
      this.feedbackMsg = `Started new ${this.preferredAgentCli} tab`;
      safeNotify({
        title: `New ${this.preferredAgentCli} Tab`,
        body: taskList.length === 1 ? taskList[0].title : `${taskList.length} tasks`,
        level: "info",
      });
      await this.persistStore(this.asyncCx);
    } else {
      safeNotify({
        title: "Failed to Spawn Agent Tab",
        body: res.error || "Unknown error",
        level: "error",
      });
      (this.asyncCx ?? clickCx)?.notify?.();
    }
  }

  async handleCopyPrompt(taskList, clickCx) {
    if (!taskList || taskList.length === 0) return;
    const res = await copyPromptToClipboard(taskList, {
      projectPath: this.activeProject.path,
      cx: clickCx ?? this.asyncCx,
    });
    if (res.ok) {
      this.feedbackMsg = "Copied prompt to clipboard";
      safeNotify({
        title: "Prompt Copied",
        body: taskList.length === 1 ? taskList[0].title : `${taskList.length} tasks copied`,
        level: "info",
      });
    } else {
      this.feedbackMsg = res.error || "Copy failed";
    }
    (this.asyncCx ?? clickCx)?.notify?.();
  }

  async handleBatchMarkDone(clickCx) {
    if (this.selectedIds.size === 0) return;
    const ids = new Set(this.selectedIds);
    this.tasks = this.tasks.map((t) =>
      ids.has(t.id) ? { ...t, status: "done", updatedAt: Date.now() } : t
    );
    this.selectedIds.clear();
    clickCx?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  // --- Rendering ----------------------------------------------------------

  renderHeader(t, isNarrow, isVeryNarrow, selectedAgent, candidateCount) {
    const proj = this.activeProject;
    return v_flex()
      .w_full()
      .px(12)
      .py(9)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .min_w(0)
              .child(svg(ICON_TODO).size(15).flex_none().text_color(t.accent ?? "#89b4fa"))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(13.5).font_bold().text_color(t.foreground).flex_none().child("Todo"))
              )
              .child(
                h_flex()
                  .px(6)
                  .h(18)
                  .gap(4)
                  .flex_none()
                  .rounded(4)
                  .bg(withAlpha(proj.isGlobal ? t.dim : (t.accent ?? "#89b4fa"), "22"))
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(proj.isGlobal ? t.dim : (t.accent ?? "#89b4fa"))
                  .items_center()
                  .child(svg(ICON_TARGET).size(11).flex_none())
                  .child(div().child(proj.name))
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .flex_none()
              .when(this.role === "panel", (el) =>
                el.child(
                  h_flex()
                    .id("todo-btn-popup")
                    .px(6)
                    .h(20)
                    .gap(3)
                    .rounded(4)
                    .bg(t.raised ?? t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .tooltip("Open wide Todo dialog (Ctrl+B o)")
                    .on_click(() => this.openDetailedDialog())
                    .items_center()
                    .child(div().child(isVeryNarrow ? "Pop" : "Popup"))
                    .child(svg(ICON_EXTERNAL).size(10.5).flex_none())
                )
              )
              .when(this.role === "dialog", (el) =>
                el.child(
                  h_flex()
                    .id("todo-btn-close")
                    .items_center()
                    .justify_center()
                    .size(22)
                    .rounded(4)
                    .cursor_pointer()
                    .bg(t.raised ?? t.surface)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .tooltip("Close (Esc)")
                    .on_click(() => this.close())
                    .child(svg(ICON_X).size(12).flex_none())
                )
              )
          )
      )
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .id("btn-cycle-target-agent")
              .flex_1()
              .min_w(0)
              .h(20)
              .px(6)
              .gap(5)
              .rounded(4)
              .bg(t.surface ?? t.background)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover ?? t.selected))
              .items_center()
              .tooltip("Click to switch target Agent terminal")
              .on_click((_e, clickCx) => this.cycleTargetAgent(clickCx))
              .child(
                div()
                  .w(6)
                  .h(6)
                  .rounded(3)
                  .flex_none()
                  .bg(selectedAgent ? (t.ansi2 ?? "#a6e3a1") : (t.dim ?? "#6c7086"))
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(10.5)
                  .text_color(selectedAgent ? t.foreground : t.dim)
                  .child(
                    selectedAgent
                      ? `Target: ${isNarrow ? selectedAgent.shortLabel : selectedAgent.label}`
                      : "Target: No running Agent"
                  )
              )
              .when(Boolean(selectedAgent) && candidateCount > 1, (el) =>
                el.child(
                  div()
                    .flex_none()
                    .text_size(9.5)
                    .text_color(t.dim)
                    .child(`${candidateCount} agents`)
                )
              )
          )
          .child(
            h_flex()
              .id("btn-cycle-agent-cli")
              .h(20)
              .px(6)
              .gap(4)
              .flex_none()
              .rounded(4)
              .bg(t.surface ?? t.background)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover ?? t.selected))
              .items_center()
              .tooltip("Default Agent CLI for '+ Tab'")
              .on_click((_e, clickCx) => this.cycleAgentCli(clickCx))
              .child(svg(ICON_TERMINAL).size(10.5).flex_none().text_color(t.accent ?? "#89b4fa"))
              .child(div().text_size(10.5).text_color(t.muted).child(this.preferredAgentCli))
          )
      );
  }

  renderFilterBar(t, isNarrow) {
    const { projectCount, globalCount, allActiveCount } = this.getScopeCounts();
    const { activeCount, inProgressCount, doneCount, allCount } = this.getStatusCounts();

    const scopeBtn = (id, label, count) => {
      const on = this.scopeTab === id;
      return h_flex()
        .id(`todo-scope-${id}`)
        .px(7)
        .h(20)
        .gap(3)
        .rounded(4)
        .items_center()
        .cursor_pointer()
        .bg(on ? (t.selected ?? "#334155") : "#00000000")
        .when(!on, (el) => el.hover((s) => s.bg(t.hover ?? t.selected)))
        .text_size(10.5)
        .font_medium()
        .text_color(on ? t.foreground : t.muted)
        .on_click((_e, clickCx) => {
          this.scopeTab = id;
          clickCx.notify();
        })
        .child(div().child(count !== null ? `${label} (${count})` : label));
    };

    const statusBtn = (id, label, count) => {
      const on = this.statusFilter === id;
      const text = typeof count === "number" ? `${label} (${count})` : label;
      return h_flex()
        .id(`todo-status-${id}`)
        .px(6)
        .h(18)
        .rounded(4)
        .items_center()
        .cursor_pointer()
        .bg(on ? (t.accent ?? "#89b4fa") : "#00000000")
        .when(!on, (el) => el.hover((s) => s.bg(t.hover ?? t.selected)))
        .text_size(10)
        .font_medium()
        .text_color(on ? (t.accent_foreground ?? t.accentForeground ?? "#ffffff") : t.muted)
        .on_click((_e, clickCx) => {
          this.statusFilter = id;
          clickCx.notify();
        })
        .child(text);
    };

    return v_flex()
      .w_full()
      .px(10)
      .py(6)
      .gap(5)
      .bg(t.surface ?? t.background)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(4)
          .child(
            h_flex()
              .gap(3)
              .items_center()
              .when(!this.activeProject.isGlobal, (el) =>
                el.child(scopeBtn("project", "Project", projectCount))
              )
              .child(scopeBtn("global", "Global", globalCount))
              .child(scopeBtn("all", "All", allActiveCount))
          )
          .when(doneCount > 0, (el) =>
            el.child(
              div()
                .id("todo-btn-clear-done")
                .px(6)
                .h(18)
                .rounded(4)
                .cursor_pointer()
                .text_size(10)
                .text_color(t.dim)
                .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                .flex()
                .items_center()
                .on_click((_e, clickCx) => this.handleClearDone(clickCx))
                .child(`Clear Done (${doneCount})`)
            )
          )
      )
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(4)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .items_center()
              .flex_wrap()
              .child(statusBtn("active", "Active", activeCount))
              .child(statusBtn("in_progress", isNarrow ? "Running" : "In Progress", inProgressCount))
              .child(statusBtn("done", "Done", doneCount))
              .child(statusBtn("all", isNarrow ? "All" : "Everything", allCount))
          )
          .child(
            h_flex()
              .id("todo-btn-sort-mode")
              .px(6)
              .h(18)
              .gap(3)
              .flex_none()
              .rounded(4)
              .cursor_pointer()
              .bg(t.raised ?? t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
              .items_center()
              .text_size(10)
              .text_color(t.muted)
              .tooltip("Click to switch sort order (Manual / Priority / Newest / Oldest)")
              .on_click((_e, clickCx) => this.cycleSortMode(clickCx))
              .child(svg(ICON_SORT).size(10).flex_none().text_color(t.accent ?? "#89b4fa"))
              .child(div().child(isNarrow ? (SORT_LABELS[this.sortMode] || "Manual") : `Sort: ${SORT_LABELS[this.sortMode] || "Manual"}`))
          )
      );
  }

  renderComposer(t, isNarrow) {
    const pStyle = priorityColors(t, this.newPriority);
    return v_flex()
      .w_full()
      .p(8)
      .gap(6)
      .rounded(7)
      .bg(t.surface ?? t.background)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .gap(5)
          .child(
            div()
              .id("todo-composer-priority")
              .px(5)
              .h(26)
              .rounded(5)
              .flex_none()
              .bg(pStyle.bg)
              .text_size(10.5)
              .font_bold()
              .text_color(pStyle.fg)
              .cursor_pointer()
              .flex()
              .items_center()
              .tooltip("Click to cycle priority (P1 / P2 / P3)")
              .on_click((_e, clickCx) => this.cycleNewPriority(clickCx))
              .child(this.newPriority)
          )
          .child(
            Input.new(this.titleInput)
              .flex_1()
              .min_w(0)
              .h(26)
              .px(7)
              .rounded(5)
              .border_1()
              .border_color(t.input ?? t.border)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.foreground)
          )
          .child(
            div()
              .id("todo-composer-toggle-notes")
              .px(6)
              .h(26)
              .rounded(5)
              .flex_none()
              .cursor_pointer()
              .bg(this.showComposerNotes ? (t.selected ?? "#334155") : (t.raised ?? t.background))
              .border_1()
              .border_color(t.border)
              .text_size(10.5)
              .text_color(this.showComposerNotes ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
              .flex()
              .items_center()
              .tooltip("Toggle notes / prompt context")
              .on_click((_e, clickCx) => {
                this.showComposerNotes = !this.showComposerNotes;
                clickCx.notify();
              })
              .child("Note")
          )
      )
      .when(this.showComposerNotes, (el) =>
        el.child(
          Input.new(this.notesInput)
            .w_full()
            .h(26)
            .px(8)
            .rounded(5)
            .border_1()
            .border_color(t.input ?? t.border)
            .bg(t.background)
            .text_size(11)
            .text_color(t.foreground)
        )
      )
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(10)
              .text_color(t.dim)
              .child(
                this.feedbackMsg ||
                  (this.scopeTab === "global" || this.activeProject.isGlobal
                    ? "Saving to Global"
                    : `Saving to ${this.activeProject.name}`)
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .flex_none()
              .child(
                h_flex()
                  .id("todo-btn-add")
                  .px(8)
                  .h(22)
                  .gap(4)
                  .rounded(5)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.background)
                  .border_1()
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .text_size(11)
                  .text_color(t.foreground)
                  .on_click((_e, clickCx) => this.handleAddTask(clickCx, false))
                  .child(svg(ICON_PLUS).size(11).flex_none())
                  .child(div().child("Add"))
              )
              .child(
                h_flex()
                  .id("todo-btn-add-send")
                  .px(8)
                  .h(22)
                  .gap(4)
                  .rounded(5)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.accent ?? "#89b4fa")
                  .text_size(11)
                  .font_medium()
                  .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
                  .tooltip("Save task and send to active Agent immediately")
                  .on_click((_e, clickCx) => this.handleAddTask(clickCx, true))
                  .child(svg(ICON_SEND).size(11).flex_none())
                  .child(div().child(isNarrow ? "Send" : "Add & Send"))
              )
          )
      );
  }

  renderBatchBar(t) {
    const count = this.selectedIds.size;
    if (count === 0) return null;
    const selectedTasks = this.getOrderedSelectedTasks();

    return h_flex()
      .w_full()
      .px(8)
      .py(6)
      .gap(6)
      .rounded(6)
      .bg(withAlpha(t.accent ?? "#89b4fa", "18"))
      .border_1()
      .border_color(t.accent ?? t.border)
      .items_center()
      .justify_between()
      .flex_wrap()
      .child(
        div()
          .text_size(11)
          .font_semibold()
          .text_color(t.accent ?? t.foreground)
          .child(`${count} selected`)
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(
            h_flex()
              .id("todo-batch-send")
              .px(7)
              .h(22)
              .gap(4)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.accent ?? "#89b4fa")
              .text_size(10.5)
              .font_medium()
              .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
              .on_click((_e, clickCx) => this.handleSendBatch(clickCx))
              .child(svg(ICON_SEND).size(10.5).flex_none())
              .child(div().child(`Send (${count})`))
          )
          .child(
            h_flex()
              .id("todo-batch-tab")
              .px(7)
              .h(22)
              .gap(4)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.raised ?? t.surface)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected))
              .text_size(10.5)
              .text_color(t.foreground)
              .on_click((_e, clickCx) => this.handleSpawnTab(selectedTasks, clickCx))
              .child(svg(ICON_TERMINAL).size(10.5).flex_none())
              .child(div().child("+ Tab"))
          )
          .child(
            div()
              .id("todo-batch-done")
              .px(6)
              .h(22)
              .rounded(4)
              .cursor_pointer()
              .bg(t.raised ?? t.surface)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected))
              .text_size(10.5)
              .text_color(t.ansi2 ?? "#a6e3a1")
              .flex()
              .items_center()
              .on_click((_e, clickCx) => this.handleBatchMarkDone(clickCx))
              .child("Done")
          )
          .child(
            div()
              .id("todo-batch-clear")
              .px(6)
              .h(22)
              .rounded(4)
              .cursor_pointer()
              .text_size(10.5)
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
              .flex()
              .items_center()
              .on_click((_e, clickCx) => {
                this.selectedIds.clear();
                clickCx.notify();
              })
              .child("Clear")
          )
      );
  }

  startEditTask(task, clickCx) {
    if (!task) return;
    this.editingTaskId = task.id;
    this.editPriority = task.priority || "P2";
    this.editTitleInput.set_value(task.title || "");
    this.editNotesInput.set_value(task.notes || "");
    this.expandedTaskId = task.id;
    (clickCx ?? this.asyncCx)?.notify?.();
    this.asyncCx?.timer?.after?.(40, () => this.editTitleInput.focus?.());
  }

  cancelEditTask(clickCx) {
    this.editingTaskId = null;
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  async handleSaveEdit(clickCx) {
    const targetId = this.editingTaskId;
    if (!targetId) return;
    const title = (this.editTitleInput.value?.() ?? "").trim();
    if (!title) return;
    const notes = (this.editNotesInput.value?.() ?? "").trim();

    this.tasks = this.tasks.map((t) =>
      t.id === targetId
        ? { ...t, title, notes, priority: this.editPriority, updatedAt: Date.now() }
        : t
    );
    this.editingTaskId = null;
    this.feedbackMsg = "Task updated";
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  renderEditForm(t, task, idPrefix) {
    return v_flex()
      .id(`${idPrefix}-form-${task.id}`)
      .w_full()
      .p(8)
      .gap(6)
      .rounded(6)
      .bg(t.surface ?? t.background)
      .border_1()
      .border_color(t.accent ?? t.border)
      .on_mouse_down("left", (_e, mcx) => mcx?.stop_propagation?.())
      .child(
        Input.new(this.editTitleInput)
          .w_full()
          .h(28)
          .px(8)
          .rounded(5)
          .border_1()
          .border_color(t.input ?? t.border)
          .bg(t.background)
          .text_size(12)
          .text_color(t.foreground)
      )
      .child(
        Input.new(this.editNotesInput)
          .w_full()
          .h(26)
          .px(8)
          .rounded(5)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .text_size(11.5)
          .text_color(t.muted)
      )
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .children(
                PRIORITIES.map((p) => {
                  const active = this.editPriority === p;
                  const ps = priorityColors(t, p);
                  return h_flex()
                    .id(`${idPrefix}-pri-${task.id}-${p}`)
                    .px(6)
                    .h(20)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(active ? ps.bg : (t.raised ?? t.background))
                    .border_1()
                    .border_color(active ? ps.fg : t.border)
                    .text_size(10)
                    .font_bold()
                    .text_color(active ? ps.fg : t.muted)
                    .on_click((_e, clickCx) => {
                      clickCx.stop_propagation?.();
                      this.editPriority = p;
                      clickCx.notify();
                    })
                    .child(p);
                })
              )
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                h_flex()
                  .id(`${idPrefix}-cancel-${task.id}`)
                  .px(8)
                  .h(22)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.background)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10.5)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                  .on_click((_e, clickCx) => {
                    clickCx.stop_propagation?.();
                    this.cancelEditTask(clickCx);
                  })
                  .child("Cancel")
              )
              .child(
                h_flex()
                  .id(`${idPrefix}-save-${task.id}`)
                  .px(10)
                  .h(22)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.accent ?? "#89b4fa")
                  .text_size(10.5)
                  .font_medium()
                  .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
                  .on_click((_e, clickCx) => {
                    clickCx.stop_propagation?.();
                    this.handleSaveEdit(clickCx);
                  })
                  .child("Save")
              )
          )
      );
  }

  renderStatusPicker(t, task, idPrefix) {
    const activeBg = (st) =>
      st === "in_progress"
        ? withAlpha(t.working ?? t.ansi2 ?? "#a6e3a1", "26")
        : st === "done"
        ? withAlpha(t.ansi2 ?? t.done ?? "#a6e3a1", "26")
        : (t.selected ?? t.raised ?? t.surface);
    const activeFg = (st) =>
      st === "in_progress"
        ? (t.working ?? t.ansi2 ?? "#a6e3a1")
        : st === "done"
        ? (t.ansi2 ?? t.done ?? "#a6e3a1")
        : t.foreground;

    let picker = h_flex().gap(4).items_center().flex_wrap();
    for (const st of TASK_STATUSES) {
      const on = task.status === st;
      picker = picker.child(
        h_flex()
          .id(`${idPrefix}-${task.id}-${st}`)
          .flex_none()
          .px(6)
          .h(18)
          .rounded(4)
          .items_center()
          .cursor_pointer()
          .bg(on ? activeBg(st) : (t.surface ?? t.background))
          .border_1()
          .border_color(on ? activeFg(st) : t.border)
          .when(!on, (el) => el.hover((s) => s.bg(t.hover ?? t.selected)))
          .text_size(9.5)
          .font_medium()
          .text_color(on ? activeFg(st) : t.muted)
          .on_click((_e, clickCx) => {
            clickCx.stop_propagation?.();
            this.handleSetStatus(task, st, clickCx);
          })
          .child(TASK_STATUS_LABELS[st])
      );
    }
    return picker;
  }

  renderTaskDrawer(t, task, showInlineNotes = true) {
    const subtasks = task.subtasks || [];
    const isEditing = this.editingTaskId === task.id;
    return v_flex()
      .w_full()
      .mt(4)
      .pt(6)
      .gap(6)
      .border_t(1)
      .border_color(t.border)
      .when(showInlineNotes && isEditing, (el) => el.child(this.renderEditForm(t, task, "todo-drawer-edit")))
      .when(showInlineNotes, (el) =>
        el.child(
          h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(6)
            .child(div().text_size(10).text_color(t.dim).child("Status"))
            .child(this.renderStatusPicker(t, task, "todo-drawer-status"))
        )
      )
      .when(showInlineNotes && !isEditing && Boolean(task.notes), (el) =>
        el.child(
          div()
            .p(7)
            .rounded(5)
            .bg(t.background)
            .text_size(11)
            .text_color(t.muted)
            .child(task.notes)
        )
      )
      .when(subtasks.length > 0, (el) => {
        let list = v_flex().gap(4);
        for (const sub of subtasks) {
          list = list.child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .gap(6)
              .child(
                h_flex()
                  .id(`todo-sub-toggle-${task.id}-${sub.id}`)
                  .flex_1()
                  .min_w(0)
                  .gap(6)
                  .items_center()
                  .cursor_pointer()
                  .on_click((_e, clickCx) => {
                    clickCx.stop_propagation?.();
                    this.handleToggleSubtask(task.id, sub.id, clickCx);
                  })
                  .child(
                    svg(sub.done ? ICON_CIRCLE_CHECK : ICON_SQUARE)
                      .size(12)
                      .flex_none()
                      .text_color(sub.done ? (t.ansi2 ?? "#a6e3a1") : t.dim)
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .text_size(11)
                      .text_color(sub.done ? t.dim : t.foreground)
                      .child(sub.title)
                  )
              )
              .child(
                div()
                  .id(`todo-sub-del-${task.id}-${sub.id}`)
                  .size(18)
                  .rounded(4)
                  .cursor_pointer()
                  .flex()
                  .items_center()
                  .justify_center()
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .on_click((_e, clickCx) => {
                    clickCx.stop_propagation?.();
                    this.handleDeleteSubtask(task.id, sub.id, clickCx);
                  })
                  .child(svg(ICON_X).size(10).text_color(t.dim))
              )
          );
        }
        return el.child(list);
      })
      .child(
        h_flex()
          .w_full()
          .gap(5)
          .items_center()
          .child(
            Input.new(this.subtaskInput)
              .flex_1()
              .min_w(0)
              .h(24)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.input ?? t.border)
              .bg(t.background)
              .text_size(11)
              .text_color(t.foreground)
          )
          .child(
            h_flex()
              .id(`todo-sub-add-${task.id}`)
              .px(7)
              .h(24)
              .gap(3)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.raised ?? t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected))
              .text_size(10.5)
              .text_color(t.foreground)
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.handleAddSubtask(task.id, clickCx);
              })
              .child(svg(ICON_PLUS).size(10.5).flex_none())
              .child(div().child("Step"))
          )
      );
  }

  renderTaskCard(t, task, isNarrow, isDialogList = false, index = 0, visibleTasks = []) {
    const isDone = task.status === "done";
    const isRunning = task.status === "in_progress";
    const isExpanded = this.expandedTaskId === task.id;
    const isSelected = this.selectedIds.has(task.id);
    const isSending = this.sendingId === task.id;
    const pStyle = priorityColors(t, task.priority);
    const dragFromIdx = this.dragTaskId ? visibleTasks.findIndex((x) => x.id === this.dragTaskId) : -1;
    const stopMouseDown = (_e, mcx) => mcx?.stop_propagation?.();

    const subtasks = task.subtasks || [];
    const subDone = subtasks.filter((s) => s.done).length;

    let card = v_flex()
      .relative()
      .id(`todo-card-${task.id}`)
      .p(8)
      .gap(5)
      .rounded(7)
      .bg(isExpanded ? (t.selected ?? t.surface ?? t.background) : (t.surface ?? t.background))
      .border_1()
      .border_color(
        isRunning
          ? (t.working ?? t.accent ?? t.border)
          : isSelected
          ? (t.accent ?? t.border)
          : t.border
      )
      .when(!isDone, (el) =>
        el
          .when(this.dragTaskId === task.id && this.dragOverTaskId !== task.id, (d) => d.opacity(0.5))
          .when(
            this.dragTaskId !== null && this.dragOverTaskId === task.id && this.dragTaskId !== task.id,
            (d) =>
              d.child(
                div()
                  .absolute()
                  .left(0)
                  .right(0)
                  .h(2)
                  .bg(t.accent ?? "#89b4fa")
                  .when(dragFromIdx < index, (line) => line.bottom(0))
                  .when(dragFromIdx > index, (line) => line.top(0))
              )
          )
          .on_mouse_down("left", (_e, mcx) => {
            this.dragTaskId = task.id;
            this.dragOverTaskId = task.id;
            mcx?.notify?.();
          })
          .on_mouse_move((_e, mcx) => {
            if (this.dragTaskId !== null && this.dragOverTaskId !== task.id) {
              this.dragOverTaskId = task.id;
              mcx?.notify?.();
            }
          })
          .on_mouse_up("left", (_e, mcx) => {
            const from = this.dragTaskId;
            const over = this.dragOverTaskId;
            this.dragTaskId = null;
            this.dragOverTaskId = null;
            if (from && over === task.id && from !== task.id) {
              this.handleReorderTask(from, task.id, mcx);
            } else {
              mcx?.notify?.();
            }
          })
      );

    // Line 1: Done toggle, Batch box, Priority, Title, Expand toggle
    card = card.child(
      h_flex()
        .w_full()
        .items_start()
        .gap(6)
        .child(
          div()
            .id(`todo-done-${task.id}`)
            .pt(2)
            .cursor_pointer()
            .flex_none()
            .tooltip(isDone ? "Reopen task" : "Mark done")
            .on_mouse_down("left", stopMouseDown)
            .on_click((_e, clickCx) => {
              clickCx.stop_propagation?.();
              this.handleToggleStatus(task, clickCx);
            })
            .child(
              svg(isDone ? ICON_CIRCLE_CHECK : ICON_SQUARE)
                .size(14)
                .flex_none()
                .text_color(isDone ? (t.ansi2 ?? "#a6e3a1") : t.muted)
            )
        )
        .child(
          div()
            .id(`todo-select-${task.id}`)
            .mt(2)
            .w(12)
            .h(12)
            .rounded(3)
            .flex_none()
            .border_1()
            .border_color(isSelected ? (t.accent ?? "#89b4fa") : t.border)
            .bg(isSelected ? (t.accent ?? "#89b4fa") : "#00000000")
            .cursor_pointer()
            .tooltip("Select for batch dispatch")
            .on_mouse_down("left", stopMouseDown)
            .on_click((_e, clickCx) => {
              clickCx.stop_propagation?.();
              if (this.selectedIds.has(task.id)) this.selectedIds.delete(task.id);
              else this.selectedIds.add(task.id);
              clickCx.notify();
            })
        )
        .child(
          div()
            .id(`todo-prio-${task.id}`)
            .px(4)
            .h(16)
            .rounded(3)
            .flex_none()
            .bg(pStyle.bg)
            .text_size(9.5)
            .font_bold()
            .text_color(pStyle.fg)
            .cursor_pointer()
            .flex()
            .items_center()
            .tooltip("Click to cycle priority")
            .on_mouse_down("left", stopMouseDown)
            .on_click((_e, clickCx) => {
              clickCx.stop_propagation?.();
              this.handleCyclePriority(task, clickCx);
            })
            .child(task.priority || "P2")
        )
        .child(
          h_flex()
            .id(`todo-expand-${task.id}`)
            .flex_1()
            .min_w(0)
            .gap(4)
            .items_start()
            .justify_between()
            .cursor_pointer()
            .on_click((_e, clickCx) => {
              if (isDialogList) {
                if (this.expandedTaskId !== task.id) {
                  this.subtaskInput.set_value("");
                  this.expandedTaskId = task.id;
                }
              } else {
                const next = isExpanded ? null : task.id;
                if (next !== this.expandedTaskId) this.subtaskInput.set_value("");
                this.expandedTaskId = next;
              }
              clickCx.notify();
            })
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(12)
                .font_medium()
                .text_color(isDone ? t.dim : t.foreground)
                .child(task.title)
            )
            .when(!isDialogList, (el) =>
              el.child(
                div()
                  .pt(2)
                  .flex_none()
                  .child(
                    svg(isExpanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT)
                      .size(12)
                      .flex_none()
                      .text_color(t.dim)
                  )
              )
            )
        )
    );

    const assigned = task.assignedAgent;
    const matchedCandidate = assigned?.address
      ? this.lastAgentCandidates.find((c) => c.address === assigned.address)
      : null;
    const cleanAssignedLabel = assigned?.label ? assigned.label.replace(/\s*\(t[0-9a-z]+\)$/i, "").trim() : "";
    const runningTargetName =
      matchedCandidate?.shortLabel ||
      assigned?.shortLabel ||
      cleanAssignedLabel ||
      null;

    // Line 2: Metadata badges + One-Click Action Buttons
    const actionsRow = h_flex()
      .w_full()
      .pl(20)
      .items_center()
      .justify_between()
      .gap(6)
      .flex_wrap()
      .child(
        h_flex()
          .items_center()
          .gap(4)
          .flex_wrap()
          .child(
            h_flex()
              .id(`todo-status-badge-${task.id}`)
              .px(5)
              .h(16)
              .gap(3)
              .rounded(3)
              .cursor_pointer()
              .bg(
                isRunning
                  ? withAlpha(t.working ?? t.ansi2 ?? "#a6e3a1", "22")
                  : isDone
                  ? withAlpha(t.ansi2 ?? t.done ?? "#a6e3a1", "22")
                  : (t.raised ?? t.background)
              )
              .when(!isRunning && !isDone, (el) => el.border_1().border_color(t.border))
              .hover((s) => s.bg(t.hover ?? t.selected))
              .items_center()
              .tooltip("Click to change status (Todo / In Progress / Done)")
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.handleCycleStatus(task, clickCx);
              })
              .when(isRunning, (el) =>
                el.child(svg(ICON_PLAY).size(9).flex_none().text_color(t.working ?? t.ansi2 ?? "#a6e3a1"))
              )
              .when(isDone, (el) =>
                el.child(svg(ICON_CIRCLE_CHECK).size(9).flex_none().text_color(t.ansi2 ?? t.done ?? "#a6e3a1"))
              )
              .child(
                div()
                  .text_size(9.5)
                  .when(isRunning || isDone, (el) => el.font_semibold())
                  .text_color(
                    isRunning
                      ? (t.working ?? t.ansi2 ?? "#a6e3a1")
                      : isDone
                      ? (t.ansi2 ?? t.done ?? "#a6e3a1")
                      : t.muted
                  )
                  .child(
                    isRunning
                      ? runningTargetName
                        ? `Running · ${runningTargetName}`
                        : "In Progress"
                      : isDone
                      ? "Done"
                      : "Todo"
                  )
              )
          )
          .when(subtasks.length > 0, (el) =>
            el.child(
              div()
                .px(5)
                .h(16)
                .rounded(3)
                .bg(t.background)
                .text_size(9.5)
                .text_color(subDone === subtasks.length ? (t.ansi2 ?? "#a6e3a1") : t.muted)
                .flex()
                .items_center()
                .child(`${subDone}/${subtasks.length} steps`)
            )
          )
          .when(this.scopeTab === "all" && Boolean(task.projectName), (el) =>
            el.child(
              div()
                .px(5)
                .h(16)
                .rounded(3)
                .bg(t.background)
                .text_size(9.5)
                .text_color(t.dim)
                .flex()
                .items_center()
                .child(task.projectName)
            )
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(4)
          .flex_none()
          .on_mouse_down("left", stopMouseDown)
          .child(
            h_flex()
              .id(`todo-send-${task.id}`)
              .px(7)
              .h(20)
              .gap(3)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.accent ?? "#89b4fa")
              .text_size(10.5)
              .font_medium()
              .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
              .tooltip("Send task prompt directly to target Agent")
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.handleSendTask(task, clickCx);
              })
              .child(svg(ICON_SEND).size(10).flex_none())
              .child(div().child(isSending ? "…" : "Send"))
          )
          .child(
            h_flex()
              .id(`todo-tab-${task.id}`)
              .px(6)
              .h(20)
              .gap(3)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.raised ?? t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected))
              .text_size(10.5)
              .text_color(t.foreground)
              .tooltip(`Spawn new ${this.preferredAgentCli} tab with this task`)
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.handleSpawnTab([task], clickCx);
              })
              .child(svg(ICON_TERMINAL).size(10).flex_none().text_color(t.accent ?? "#89b4fa"))
              .child(div().child("+ Tab"))
          )
          .when(!isNarrow, (el) =>
            el.child(
              div()
                .id(`todo-copy-${task.id}`)
                .size(20)
                .rounded(4)
                .cursor_pointer()
                .bg(t.raised ?? t.background)
                .border_1()
                .border_color(t.border)
                .hover((s) => s.bg(t.hover ?? t.selected))
                .flex()
                .items_center()
                .justify_center()
                .tooltip("Copy formatted prompt to clipboard")
                .on_click((_e, clickCx) => {
                  clickCx.stop_propagation?.();
                  this.handleCopyPrompt([task], clickCx);
                })
                .child(svg(ICON_COPY).size(10.5).text_color(t.muted))
            )
          )
          .child(
            div()
              .id(`todo-edit-${task.id}`)
              .px(6)
              .h(20)
              .rounded(4)
              .cursor_pointer()
              .bg(t.raised ?? t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover ?? t.selected))
              .flex()
              .items_center()
              .justify_center()
              .text_size(10)
              .text_color(t.muted)
              .tooltip("Edit task title, notes & priority")
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.startEditTask(task, clickCx);
              })
              .child("Edit")
          )
          .child(
            div()
              .id(`todo-del-${task.id}`)
              .size(20)
              .rounded(4)
              .cursor_pointer()
              .bg(t.raised ?? t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(withAlpha(t.ansi1 ?? "#f38ba8", "22")))
              .flex()
              .items_center()
              .justify_center()
              .tooltip("Delete task")
              .on_click((_e, clickCx) => {
                clickCx.stop_propagation?.();
                this.handleDeleteTask(task.id, clickCx);
              })
              .child(svg(ICON_TRASH).size(10.5).text_color(t.dim))
          )
      );

    card = card.child(actionsRow);

    if (!isDialogList && isExpanded) {
      card = card.child(this.renderTaskDrawer(t, task, true));
    }

    return card;
  }

  renderDialogDetailPane(t, task, selectedAgent) {
    if (!task) {
      return v_flex()
        .flex_1()
        .h_full()
        .items_center()
        .justify_center()
        .p(24)
        .child(div().text_size(12).text_color(t.dim).child("Select or create a task to inspect details and Agent prompt."));
    }

    const promptPreview = buildAgentPrompt([task], { projectPath: this.activeProject.path });
    const pStyle = priorityColors(t, task.priority);
    const isEditing = this.editingTaskId === task.id;

    return v_flex()
      .id("todo-dialog-detail")
      .flex_1()
      .min_w(0)
      .min_h(0)
      .h_full()
      .overflow_y_scrollbar()
      .p(16)
      .gap(12)
      .child(
        v_flex()
          .w_full()
          .flex_none()
          .gap(8)
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .items_center()
              .flex_wrap()
              .child(
                div()
                  .flex_none()
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .bg(pStyle.bg)
                  .text_size(10)
                  .font_bold()
                  .text_color(pStyle.fg)
                  .flex()
                  .items_center()
                  .child(task.priority || "P2")
              )
              .child(
                div()
                  .flex_none()
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .bg(t.surface ?? t.background)
                  .text_size(10)
                  .text_color(t.muted)
                  .flex()
                  .items_center()
                  .child(task.projectName || "Global")
              )
              .child(this.renderStatusPicker(t, task, "todo-detail-status"))
          )
          .when(isEditing, (el) => el.child(this.renderEditForm(t, task, "todo-detail-edit")))
          .when(!isEditing, (el) =>
            el.child(div().w_full().text_size(15).font_bold().text_color(t.foreground).child(task.title))
          )
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .items_center()
              .flex_wrap()
              .child(
                h_flex()
                  .id(`todo-detail-send-${task.id}`)
                  .flex_none()
                  .px(10)
                  .h(26)
                  .gap(5)
                  .rounded(6)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.accent ?? "#89b4fa")
                  .text_size(11.5)
                  .font_medium()
                  .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
                  .on_click((_e, clickCx) => this.handleSendTask(task, clickCx))
                  .child(svg(ICON_SEND).size(12).flex_none())
                  .child(div().max_w(220).truncate().child(selectedAgent ? `Send to ${selectedAgent.shortLabel}` : "Send to Agent"))
              )
              .child(
                h_flex()
                  .id(`todo-detail-tab-${task.id}`)
                  .flex_none()
                  .px(9)
                  .h(26)
                  .gap(5)
                  .rounded(6)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.surface)
                  .border_1()
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .on_click((_e, clickCx) => this.handleSpawnTab([task], clickCx))
                  .child(svg(ICON_TERMINAL).size(12).flex_none().text_color(t.accent ?? "#89b4fa"))
                  .child(div().child(`+ ${this.preferredAgentCli} Tab`))
              )
              .when(!isEditing, (el) =>
                el.child(
                  h_flex()
                    .id(`todo-detail-edit-${task.id}`)
                    .flex_none()
                    .px(9)
                    .h(26)
                    .rounded(6)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.raised ?? t.surface)
                    .border_1()
                    .border_color(t.border)
                    .hover((s) => s.bg(t.hover ?? t.selected))
                    .text_size(11.5)
                    .text_color(t.foreground)
                    .on_click((_e, clickCx) => this.startEditTask(task, clickCx))
                    .child("Edit")
                )
              )
          )
      )
      .when(!isEditing && Boolean(task.notes), (el) =>
        el.child(
          v_flex()
            .w_full()
            .flex_none()
            .gap(4)
            .child(div().text_size(10.5).font_bold().text_color(t.muted).child("NOTES & CONTEXT"))
            .child(
              div()
                .w_full()
                .p(10)
                .rounded(6)
                .bg(t.surface ?? t.background)
                .border_1()
                .border_color(t.border)
                .text_size(12)
                .text_color(t.foreground)
                .child(task.notes)
            )
        )
      )
      .child(
        v_flex()
          .w_full()
          .flex_none()
          .gap(4)
          .child(div().text_size(10.5).font_bold().text_color(t.muted).child("SUBTASKS & STEPS"))
          .child(
            div()
              .w_full()
              .p(10)
              .rounded(6)
              .bg(t.surface ?? t.background)
              .border_1()
              .border_color(t.border)
              .child(this.renderTaskDrawer(t, task, false))
          )
      )
      .child(
        v_flex()
          .w_full()
          .flex_none()
          .gap(4)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(div().text_size(10.5).font_bold().text_color(t.muted).child("AGENT PROMPT PREVIEW"))
              .child(
                h_flex()
                  .id(`todo-detail-copy-${task.id}`)
                  .px(7)
                  .h(20)
                  .gap(4)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.surface)
                  .border_1()
                  .border_color(t.border)
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .text_size(10.5)
                  .text_color(t.muted)
                  .on_click((_e, clickCx) => this.handleCopyPrompt([task], clickCx))
                  .child(svg(ICON_COPY).size(10.5).flex_none())
                  .child(div().child("Copy Prompt"))
              )
          )
          .child(
            div()
              .w_full()
              .p(10)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .text_size(11.5)
              .text_color(t.muted)
              .child(promptPreview)
          )
      );
  }

  renderTaskList(t, visibleTasks, isNarrow, isDialogList = false) {
    if (visibleTasks.length === 0) {
      return v_flex()
        .p(24)
        .items_center()
        .justify_center()
        .gap(6)
        .child(div().text_size(12.5).font_bold().text_color(t.muted).child("No Tasks Here"))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child("Type above and press Enter to save, or 'Add & Send' to dispatch straight to your Agent.")
        );
    }

    let list = v_flex().gap(6);
    for (let i = 0; i < visibleTasks.length; i++) {
      const task = visibleTasks[i];
      list = list.child(this.renderTaskCard(t, task, isNarrow, isDialogList, i, visibleTasks));
    }
    return list;
  }

  render(cx) {
    const t = theme();
    const isNarrow = this.lastWidthBucket === "narrow" || this.lastWidthBucket === "very-narrow";
    const isVeryNarrow = this.lastWidthBucket === "very-narrow";

    const { candidates, selected: selectedAgent } = resolveAvailableAgents(this.selectedAgentAddress);
    this.lastAgentCandidates = candidates;
    const visibleTasks = this.getVisibleTasks();
    const batchBar = this.renderBatchBar(t);

    if (this.role === "dialog") {
      const activeDetailTask =
        visibleTasks.find((x) => x.id === this.expandedTaskId) ||
        this.tasks.find((x) => x.id === this.expandedTaskId) ||
        visibleTasks[0] ||
        null;

      return v_flex()
        .id("todo-dialog-root")
        .track_focus(this.handle)
        .on_key_down((e, keyCx) => {
          if (e.key === "escape") {
            this.close();
            keyCx.stop_propagation();
          }
        })
        .size_full()
        .bg(t.popover ?? t.background)
        .rounded(14)
        .border_1()
        .border_color(t.border)
        .shadow_lg()
        .text_color(t.foreground)
        .overflow_hidden()
        .child(this.renderHeader(t, false, false, selectedAgent, candidates.length))
        .child(
          h_flex()
            .flex_1()
            .min_h(0)
            .w_full()
            .child(
              v_flex()
                .w(410)
                .flex_none()
                .h_full()
                .border_r(1)
                .border_color(t.border)
                .child(this.renderFilterBar(t, false))
                .child(
                  v_flex()
                    .id("todo-scroll-body")
                    .flex_1()
                    .min_h(0)
                    .overflow_y_scrollbar()
                    .p(10)
                    .gap(8)
                    .on_mouse_up("left", (_e, mcx) => {
                      if (this.dragTaskId !== null) {
                        this.dragTaskId = null;
                        this.dragOverTaskId = null;
                        mcx?.notify?.();
                      }
                    })
                    .child(this.renderComposer(t, false))
                    .when(Boolean(batchBar), (el) => el.child(batchBar))
                    .child(this.renderTaskList(t, visibleTasks, false, true))
                )
            )
            .child(this.renderDialogDetailPane(t, activeDetailTask, selectedAgent))
        );
    }

    return v_flex()
      .id("todo-panel-root")
      .track_focus(this.handle)
      .size_full()
      .text_color(t.foreground)
      .overflow_hidden()
      .child(this.renderHeader(t, isNarrow, isVeryNarrow, selectedAgent, candidates.length))
      .child(this.renderFilterBar(t, isNarrow))
      .child(
        v_flex()
          .id("todo-scroll-body")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(10)
          .gap(8)
          .on_mouse_up("left", (_e, mcx) => {
            if (this.dragTaskId !== null) {
              this.dragTaskId = null;
              this.dragOverTaskId = null;
              mcx?.notify?.();
            }
          })
          .child(this.renderComposer(t, isNarrow))
          .when(Boolean(batchBar), (el) => el.child(batchBar))
          .child(this.renderTaskList(t, visibleTasks, isNarrow, false))
      );
  }
}
