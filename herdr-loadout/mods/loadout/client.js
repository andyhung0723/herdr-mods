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
const CLI_TIMEOUT_MS = 60_000;

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

export async function runLoadout(config, args) {
  const result = await exec(config.node, cliArgs(config, args), { timeout: CLI_TIMEOUT_MS });
  if (!ACCEPTED_EXIT_CODES.has(result.code)) {
    throw new Error(result.stderr.trim() || `loadout exited with ${result.code}`);
  }
  return JSON.parse(result.stdout);
}

export const fetchStatus = (config) => runLoadout(config, ["status"]);
export const applyPending = (config) => runLoadout(config, ["apply"]);
export const toggle = (config, resource, target, enabled) =>
  runLoadout(config, ["toggle", resource, target, enabled ? "on" : "off"]);

/** true → turn on, false → turn off, null → not toggleable here. */
export function nextEnabled(cell) {
  if (cell === "n/a" || cell === undefined) return null;
  return !SELECTED_CELLS.has(cell);
}

export function visibleRows(status, kindFilter, query = "") {
  const needle = query.trim().toLowerCase();
  return status.rows
    .filter((row) => kindFilter === "all" || row.kind === kindFilter)
    .filter((row) => !needle || row.name.toLowerCase().includes(needle))
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

export function cellKey(resource, target) {
  return `${resource}\u0000${target}`;
}
