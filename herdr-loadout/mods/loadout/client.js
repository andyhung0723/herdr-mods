// Talks to the agent-loadout CLI (`loadout … --json`) and holds the pure decisions the UI makes.
import { appHome, exec, readTextFile } from "herdr";

export const KIND_ORDER = [
  "instructions",
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
  "plugin",
  "marketplace",
];

const SELECTED_CELLS = new Set(["ok", "pending", "conflict", "unresolved", "observed", "absent"]);
const ACCEPTED_EXIT_CODES = new Set([0, 2]);
const READ_TIMEOUT_MS = 60_000;
// Writes can wait on a keychain authorization prompt the user has to click; exec caps at 10 min.
const WRITE_TIMEOUT_MS = 300_000;

export async function loadConfig() {
  const path = `${appHome()}/mods/loadout/config.json`;
  const text = await readTextFile(path);
  if (!text) {
    throw new Error(`Missing ${path}. Run herdr-loadout/install.py to point the mod at the loadout CLI.`);
  }
  const config = JSON.parse(text);
  if (!config.node || !config.bin) throw new Error(`${path} needs "node" and "bin".`);
  return config;
}

export function cliArgs(config, args) {
  return [
    config.bin,
    ...args,
    ...(config.manifest ? ["--manifest", config.manifest] : []),
    ...(config.state ? ["--state", config.state] : []),
    "--json",
  ];
}

export async function runLoadout(config, args, { write = false } = {}) {
  const timeout = write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const result = await exec(config.node, cliArgs(config, args), { timeout });
  if (!ACCEPTED_EXIT_CODES.has(result.code)) {
    throw new Error(result.stderr.trim() || `loadout exited with ${result.code}`);
  }
  return JSON.parse(result.stdout);
}

const WRITE = { write: true };

export const fetchStatus = (config) => runLoadout(config, ["status"]);
export const fetchHistory = (config) => runLoadout(config, ["history"]);
export const applyPending = (config) => runLoadout(config, ["apply"], WRITE);
export const toggle = (config, resource, target, enabled) =>
  runLoadout(config, ["toggle", resource, target, enabled ? "on" : "off"], WRITE);
/** Stop managing `resource` on `target` but keep its files (`loadout release`). */
export const release = (config, resource, target) =>
  runLoadout(config, ["release", resource, target], WRITE);
/** Undo a journaled run (`loadout restore <run>`); the restore is itself undoable. */
export const undo = (config, run) => runLoadout(config, ["restore", run], WRITE);

const INERT_CELLS = new Set(["n/a", "inherited"]);

/** true → turn on, false → turn off, null → not toggleable here (unsupported, or inherited from a shared layer). */
export function nextEnabled(cell) {
  if (cell === undefined || INERT_CELLS.has(cell)) return null;
  return !SELECTED_CELLS.has(cell);
}

/** Only a resource that is on for the target can be released from it. */
export function releasable(cell) {
  return nextEnabled(cell) === false;
}

/** The run a write response journaled, as the next thing "Undo" acts on. */
export function undoable(response, label) {
  return response?.run ? { run: response.run, label } : null;
}

export function latestUndoable(history) {
  const [latest] = history?.runs ?? [];
  return latest ? { run: latest.id, label: latest.command } : null;
}

/** Accounts shown as columns: every one when none is picked, else the picked ones in manifest order. */
export function visibleTargets(status, picked) {
  return picked.size === 0 ? status.targets : status.targets.filter((target) => picked.has(target));
}

/** With only some accounts shown, a resource none of them can hold ("n/a" everywhere) is noise. */
export function visibleRows(status, kindFilter, query = "", targets = status.targets) {
  const needle = query.trim().toLowerCase();
  const narrowed = targets.length < status.targets.length;
  return status.rows
    .filter((row) => kindFilter === "all" || row.kind === kindFilter)
    .filter((row) => !needle || row.name.toLowerCase().includes(needle))
    .filter((row) => !narrowed || targets.some((target) => (row.cells[target] ?? "off") !== "n/a"))
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
}

export function kindCounts(status) {
  const counts = new Map();
  for (const row of status.rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
    kind,
    count: counts.get(kind),
  }));
}

export function summarize(status) {
  const summary = { pending: 0, conflict: 0, unresolved: 0 };
  for (const row of status.rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell in summary) summary[cell] += 1;
    }
  }
  return { ...summary, orphans: status.orphans.length, warnings: status.warnings };
}

/** Problems from a toggle/apply response, worded for a toast. */
export function failuresOf(response) {
  return (response.results ?? [])
    .filter(({ entry, error }) => error || entry.action === "conflict" || entry.action === "unresolved")
    .map(({ entry, error }) => `${entry.resource} → ${entry.target}: ${error ?? entry.detail ?? entry.action}`);
}

/** Entries a restore left alone (changed since that run), worded for a toast. */
export function restoreFailures(response) {
  return (response.results ?? [])
    .filter((result) => result.error)
    .map((result) => `${result.resource} → ${result.target}: ${result.error}`);
}

export function cellKey(resource, target) {
  return `${resource}\u0000${target}`;
}
