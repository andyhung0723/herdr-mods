// Task storage, workspace/agent discovery, and prompt dispatching for todo-list mod.
import {
  appHome,
  readTextFile,
  writeTextFile,
  agents,
  panes,
  spaces,
  focused,
  hc,
  exec,
  run,
  setShared,
} from "herdr";

export const GLOBAL_PROJECT = "__global__";
export const LOCAL_STORAGE_KEY = "herdr.todo.store.v1";
export const SHARED_STORE_VERSION_KEY = "todo.store.version";
export const AGENT_CLI_CHOICES = ["claude", "codex", "agy"];
export const SORT_MODES = ["manual", "priority", "newest", "oldest"];
export const SORT_LABELS = {
  manual: "Manual",
  priority: "Priority",
  newest: "Newest",
  oldest: "Oldest",
};

const STATUS_ORDER = {
  in_progress: 0,
  todo: 1,
  done: 2,
};

const PRIORITY_ORDER = {
  P1: 0,
  P2: 1,
  P3: 2,
};

export function basename(p) {
  if (!p || p === GLOBAL_PROJECT) return "Global";
  const clean = String(p).replace(/\/+$/, "");
  if (!clean || clean === "/") return "/";
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
}

export function normalizeProjectPath(p) {
  if (!p || typeof p !== "string") return GLOBAL_PROJECT;
  const trimmed = p.trim().replace(/\/+$/, "");
  return trimmed || GLOBAL_PROJECT;
}

export function getTodoFilePath() {
  return `${appHome()}/todos.json`;
}

function makeId(prefix = "todo") {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function createTask({
  title,
  notes = "",
  priority = "P2",
  project = GLOBAL_PROJECT,
  projectName = "",
  subtasks = [],
  order = null,
}) {
  const normProject = normalizeProjectPath(project);
  const now = Date.now();
  return {
    id: makeId("t"),
    title: String(title || "").trim(),
    notes: String(notes || "").trim(),
    priority: ["P1", "P2", "P3"].includes(priority) ? priority : "P2",
    status: "todo",
    project: normProject,
    projectName: projectName || basename(normProject),
    subtasks: Array.isArray(subtasks)
      ? subtasks
          .map((s) => ({
            id: s.id || makeId("sub"),
            title: String(s.title || "").trim(),
            done: Boolean(s.done),
          }))
          .filter((s) => s.title)
      : [],
    assignedAgent: null,
    order: typeof order === "number" ? order : now,
    createdAt: now,
    updatedAt: now,
  };
}

export function sortTasks(tasks, sortMode = "manual") {
  const mode = SORT_MODES.includes(sortMode) ? sortMode : "manual";
  return [...(tasks || [])].sort((a, b) => {
    const doneA = a.status === "done" ? 1 : 0;
    const doneB = b.status === "done" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;

    if (mode === "manual") {
      const oa = typeof a.order === "number" ? a.order : a.createdAt || 0;
      const ob = typeof b.order === "number" ? b.order : b.createdAt || 0;
      if (oa !== ob) return oa - ob;
      return (b.createdAt || 0) - (a.createdAt || 0);
    }

    if (mode === "priority") {
      const sa = STATUS_ORDER[a.status] ?? 1;
      const sb = STATUS_ORDER[b.status] ?? 1;
      if (sa !== sb) return sa - sb;

      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;

      const oa = typeof a.order === "number" ? a.order : 0;
      const ob = typeof b.order === "number" ? b.order : 0;
      if (oa !== ob) return oa - ob;
      return (b.createdAt || 0) - (a.createdAt || 0);
    }

    if (mode === "newest") {
      return (b.createdAt || 0) - (a.createdAt || 0);
    }

    // mode === "oldest"
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

export function moveTaskInList(allTasks, visibleTasks, taskId, direction) {
  const idx = visibleTasks.findIndex((t) => t.id === taskId);
  const targetIdx = idx + direction;
  if (idx < 0 || targetIdx < 0 || targetIdx >= visibleTasks.length) {
    return allTasks;
  }
  return reorderTaskInList(allTasks, visibleTasks, taskId, visibleTasks[targetIdx].id);
}

export function reorderTaskInList(allTasks, visibleTasks, fromTaskId, toTaskId) {
  const fromIdx = visibleTasks.findIndex((t) => t.id === fromTaskId);
  const toIdx = visibleTasks.findIndex((t) => t.id === toTaskId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
    return allTasks;
  }
  if ((visibleTasks[fromIdx].status === "done") !== (visibleTasks[toIdx].status === "done")) {
    return allTasks;
  }

  const reorderedIds = visibleTasks.map((t) => t.id);
  const [moved] = reorderedIds.splice(fromIdx, 1);
  reorderedIds.splice(toIdx, 0, moved);

  const orderMap = new Map();
  reorderedIds.forEach((id, i) => orderMap.set(id, i));
  const now = Date.now();

  return allTasks.map((t) =>
    orderMap.has(t.id) ? { ...t, order: orderMap.get(t.id), updatedAt: now } : t
  );
}

function parseStoreJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const preferredAgentCli = AGENT_CLI_CHOICES.includes(parsed.preferredAgentCli)
      ? parsed.preferredAgentCli
      : "claude";
    const sortMode = SORT_MODES.includes(parsed.sortMode) ? parsed.sortMode : "manual";
    return {
      version: 1,
      tasks,
      preferredAgentCli,
      sortMode,
    };
  } catch {
    return null;
  }
}

export async function loadStore() {
  let raw = null;
  try {
    raw = await readTextFile(getTodoFilePath());
  } catch {
    raw = null;
  }

  let parsed = parseStoreJson(raw);
  if (!parsed && typeof localStorage !== "undefined") {
    try {
      const localRaw = localStorage.getItem(LOCAL_STORAGE_KEY);
      parsed = parseStoreJson(localRaw);
    } catch {}
  }

  return {
    version: 1,
    tasks: parsed?.tasks ?? [],
    preferredAgentCli: parsed?.preferredAgentCli ?? "claude",
    sortMode: parsed?.sortMode ?? "manual",
    lastExpectedRaw: typeof raw === "string" ? raw : null,
  };
}

export async function saveStore(state) {
  const payload = {
    version: 1,
    tasks: Array.isArray(state?.tasks) ? state.tasks : [],
    preferredAgentCli: AGENT_CLI_CHOICES.includes(state?.preferredAgentCli)
      ? state.preferredAgentCli
      : "claude",
    sortMode: SORT_MODES.includes(state?.sortMode) ? state.sortMode : "manual",
  };
  const serialized = JSON.stringify(payload, null, 2) + "\n";

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
    } catch {}
  }

  const filePath = getTodoFilePath();
  let expected = state?.lastExpectedRaw ?? null;
  try {
    await writeTextFile(filePath, serialized, expected);
  } catch {
    // Re-read current snapshot on concurrent edit conflict and retry atomically.
    try {
      const fresh = await readTextFile(filePath);
      expected = typeof fresh === "string" ? fresh : null;
      await writeTextFile(filePath, serialized, expected);
    } catch (err) {
      console.error("todo-list saveStore failed:", err);
      return serialized;
    }
  }

  try {
    if (typeof setShared === "function") {
      setShared(SHARED_STORE_VERSION_KEY, Date.now());
    }
  } catch {}

  return serialized;
}

export function resolveActiveProject() {
  const f = typeof focused === "function" ? focused() : null;
  const allPanes = typeof panes === "function" ? panes() : [];
  const allSpaces = typeof spaces === "function" ? spaces() : [];

  let candidate = f?.cwd || "";
  if (!candidate && f?.pane) {
    candidate = allPanes.find((p) => p.pane === f.pane)?.cwd || "";
  }
  if (!candidate && f?.tab) {
    candidate = allPanes.find((p) => p.tab === f.tab && p.cwd)?.cwd || "";
  }
  if (!candidate) {
    const activeSpace = allSpaces.find((s) => s.active) || allSpaces[0];
    candidate = activeSpace?.folder || "";
  }
  if (!candidate) {
    candidate = allPanes.find((p) => p.cwd)?.cwd || "";
  }

  const norm = normalizeProjectPath(candidate);
  return {
    path: norm,
    name: basename(norm),
    isGlobal: norm === GLOBAL_PROJECT,
  };
}

function cleanTitle(s) {
  return (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function leadPanes(allPanes) {
  const leads = new Map();
  for (const p of allPanes) {
    if (!p?.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) {
      leads.set(p.tab, p);
    }
  }
  return leads;
}

function isTellingTitle(rawTitle, prog, progKey) {
  const raw = (rawTitle ?? "").trim();
  if (!raw || /^[~/]|^[A-Za-z]:\\/.test(raw) || raw.includes("@")) return false;
  const live = cleanTitle(raw);
  return (
    Boolean(live) &&
    live !== prog &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    live.toLowerCase() !== (progKey || "").toLowerCase()
  );
}

function resolveTabTitle(tab, lead) {
  const prog = lead?.program?.name;
  const live = cleanTitle(lead?.title);
  const telling = isTellingTitle(lead?.title, prog, lead?.program?.key);
  return (tab.name === prog || !tab.named) && telling ? live : (tab.name || "");
}

export function resolveAvailableAgents(preferredAddress = null) {
  const f = typeof focused === "function" ? focused() : null;
  const allAgents = typeof agents === "function" ? agents() : [];
  const allPanes = typeof panes === "function" ? panes() : [];
  const allSpaces = typeof spaces === "function" ? spaces() : [];

  const paneByTerminal = new Map();
  const paneById = new Map();
  for (const p of allPanes) {
    if (p.terminal) paneByTerminal.set(p.terminal, p);
    if (p.pane) paneById.set(p.pane, p);
  }

  const leads = leadPanes(allPanes);
  const tabLabels = new Map(
    allSpaces.flatMap((s) => (s.tabs || []).map((tab) => [tab.id, resolveTabTitle(tab, leads.get(tab.id))]))
  );
  const spaceById = new Map(allSpaces.map((s) => [s.id, s]));

  const candidates = [];
  const seenAddresses = new Set();

  for (const a of allAgents) {
    if (!a?.address || seenAddresses.has(a.address)) continue;
    seenAddresses.add(a.address);
    const pane = paneByTerminal.get(a.address) || paneById.get(a.pane);
    const prog = a.program?.name || pane?.program?.name || a.app || "Agent";
    const progKey = (a.program?.key || pane?.program?.key || a.app || "").toLowerCase();
    const rawPaneTitle = a.title || pane?.title;
    const live = cleanTitle(rawPaneTitle);
    const telling = isTellingTitle(rawPaneTitle, prog, progKey);

    let rawLabel = "";
    const fromTab = tabLabels.get(a.tab);
    if (fromTab) {
      rawLabel = fromTab;
    } else if (telling) {
      rawLabel = live;
    } else if (a.tab_name && !/^\d+$/.test(a.tab_name.trim())) {
      rawLabel = a.tab_name.replace(/^\d+\s+/, "").trim() || a.tab_name.trim();
    } else {
      rawLabel = prog;
    }

    const detail = /^\d+$/.test(rawLabel) ? null : rawLabel;
    const rowName = detail ?? prog;
    const spaceName = a.space_name || spaceById.get(a.space)?.name || "";
    const baseLabel = spaceName && spaceName !== rowName ? `${spaceName} · ${rowName}` : rowName;

    candidates.push({
      address: a.address,
      baseLabel,
      label: baseLabel,
      shortLabel: rowName,
      tabIndex: a.tab_index ?? null,
      status: a.status || "idle",
      app: a.program?.key || a.app || "agent",
      space: a.space,
      tab: a.tab,
      cwd: pane?.cwd || null,
      isFocused: Boolean(a.focused || f?.agent === a.address || f?.terminal === a.address),
      isAgent: true,
    });
  }

  // Fallback to focused terminal pane if user runs a shell/agent without OSC status
  const focusedTerm = f?.agent || f?.terminal;
  if (focusedTerm && !seenAddresses.has(focusedTerm)) {
    seenAddresses.add(focusedTerm);
    const pane = paneByTerminal.get(focusedTerm) || paneById.get(f?.pane);
    const spaceName = spaceById.get(f?.space)?.name || "";
    const paneProg = pane?.program?.name || "Terminal";
    const progName = isTellingTitle(pane?.title, paneProg, pane?.program?.key)
      ? cleanTitle(pane?.title)
      : paneProg;
    const baseLabel = spaceName && spaceName !== progName ? `${spaceName} · ${progName}` : progName;
    candidates.push({
      address: focusedTerm,
      baseLabel,
      label: baseLabel,
      shortLabel: progName,
      tabIndex: null,
      status: pane?.status || "idle",
      app: pane?.program?.key || "terminal",
      space: f?.space || null,
      tab: f?.tab || pane?.tab || null,
      cwd: pane?.cwd || f?.cwd || null,
      isFocused: true,
      isAgent: false,
    });
  }

  // Disambiguate identical display names using tab index instead of internal terminal addresses
  const labelCounts = new Map();
  for (const c of candidates) {
    labelCounts.set(c.baseLabel, (labelCounts.get(c.baseLabel) || 0) + 1);
  }
  const shortCounts = new Map();
  for (const c of candidates) {
    shortCounts.set(c.shortLabel, (shortCounts.get(c.shortLabel) || 0) + 1);
  }
  candidates.forEach((c, idx) => {
    const suffix = ` #${c.tabIndex || idx + 1}`;
    if ((labelCounts.get(c.baseLabel) || 0) > 1) {
      c.label = `${c.baseLabel}${suffix}`;
    }
    if ((shortCounts.get(c.shortLabel) || 0) > 1) {
      c.shortLabel = `${c.shortLabel}${suffix}`;
    }
    delete c.baseLabel;
    delete c.tabIndex;
  });

  let selected = null;
  if (preferredAddress) {
    selected = candidates.find((c) => c.address === preferredAddress) || null;
  }
  if (!selected) {
    selected =
      candidates.find((c) => c.isFocused) ||
      candidates.find((c) => f?.tab && c.tab === f.tab) ||
      candidates.find((c) => f?.space && c.space === f.space) ||
      candidates[0] ||
      null;
  }

  return { candidates, selected };
}

export function buildAgentPrompt(tasks, { projectPath = "" } = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [tasks].filter(Boolean);
  if (list.length === 0) return "";

  if (list.length === 1) {
    const task = list[0];
    const effectiveProject =
      projectPath && projectPath !== GLOBAL_PROJECT
        ? projectPath
        : task.project && task.project !== GLOBAL_PROJECT
        ? task.project
        : "";
    const meta = [];
    if (task.priority === "P1") meta.push("[Priority: P1]");
    if (effectiveProject) meta.push(`Project: ${effectiveProject}`);
    const headerSuffix = meta.length ? ` (${meta.join(" | ")})` : "";

    const lines = [
      `Please complete the following task:${headerSuffix}`,
      "",
      `## ${task.title}`,
    ];

    if (task.notes && task.notes.trim()) {
      lines.push("", "### Context & Notes", task.notes.trim());
    }

    if (Array.isArray(task.subtasks) && task.subtasks.length > 0) {
      lines.push("", "### Checklist / Steps");
      for (const sub of task.subtasks) {
        if (sub.done) {
          lines.push(`- [x] ${sub.title} (already done)`);
        } else {
          lines.push(`- [ ] ${sub.title}`);
        }
      }
    }

    return lines.join("\n");
  }

  const lines = [`Please complete the following ${list.length} tasks in order:`];
  const effectiveProject =
    projectPath && projectPath !== GLOBAL_PROJECT
      ? projectPath
      : list.find((t) => t.project && t.project !== GLOBAL_PROJECT)?.project || "";
  if (effectiveProject) {
    lines.push(`Project: ${effectiveProject}`);
  }

  list.forEach((task, idx) => {
    lines.push("", `### ${idx + 1}. [${task.priority || "P2"}] ${task.title}`);
    if (task.notes && task.notes.trim()) {
      lines.push(`Notes: ${task.notes.trim()}`);
    }
    const remainingSubs = (task.subtasks || []).filter((s) => !s.done);
    if (remainingSubs.length > 0) {
      lines.push("Steps:");
      for (const sub of remainingSubs) {
        lines.push(`- [ ] ${sub.title}`);
      }
    }
  });

  return lines.join("\n");
}

export async function sendTasksToAgent(tasks, targetAddress, { force = false, projectPath = "" } = {}) {
  const prompt = buildAgentPrompt(tasks, { projectPath });
  if (!prompt || !targetAddress) {
    return { ok: false, prompt, error: !targetAddress ? "No active Agent terminal found" : "Empty prompt" };
  }
  const args = ["send", ...(force ? ["--force"] : []), targetAddress, prompt];
  try {
    const res = await hc(args);
    return {
      ok: res.code === 0,
      prompt,
      error: res.code === 0 ? null : res.stderr || res.stdout || "hc send failed",
    };
  } catch (err) {
    return { ok: false, prompt, error: String(err) };
  }
}

export async function spawnAgentTabWithTasks(tasks, { agentCli = "claude", folder = "" } = {}) {
  const list = Array.isArray(tasks) ? tasks.filter(Boolean) : [tasks].filter(Boolean);
  const prompt = buildAgentPrompt(list, { projectPath: folder });
  if (!prompt) return { ok: false, prompt: "", error: "Empty task prompt" };

  const cli = AGENT_CLI_CHOICES.includes(agentCli) ? agentCli : "claude";
  const tabName =
    list.length === 1
      ? (list[0].title || "Todo Task").slice(0, 24)
      : `Todo Batch (${list.length})`;
  const effectiveFolder = folder && folder !== GLOBAL_PROJECT ? folder : undefined;

  const args = {
    name: tabName,
    argv: [cli],
    task: prompt,
  };
  if (effectiveFolder) args.folder = effectiveFolder;

  try {
    run("tab.new", args);
    return { ok: true, prompt, error: null };
  } catch (err) {
    return { ok: false, prompt, error: String(err) };
  }
}

export async function copyPromptToClipboard(tasks, { projectPath = "", cx = null } = {}) {
  const prompt = buildAgentPrompt(tasks, { projectPath });
  if (!prompt) return { ok: false, prompt: "", error: "Empty prompt" };
  try {
    if (typeof cx?.write_to_clipboard === "function") {
      cx.write_to_clipboard(prompt);
      return { ok: true, prompt, error: null };
    }
    const res = await exec("sh", [
      "-c",
      'printf "%s" "$1" | LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 __CF_USER_TEXT_ENCODING=0x1F5:0x8000100:0x8000100 pbcopy',
      "--",
      prompt,
    ]);
    return { ok: res.code === 0, prompt, error: res.code === 0 ? null : res.stderr || "pbcopy failed" };
  } catch (err) {
    return { ok: false, prompt, error: String(err) };
  }
}
