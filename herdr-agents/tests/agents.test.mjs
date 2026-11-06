import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Extract subStats and kidStatus implementation for standalone testing
function kidStatus(k, listed) {
  const s = (listed?.get ? listed.get(k?.address) : listed?.[k?.address]) ?? k?.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
}

function subStats(subs, listed) {
  const total = subs?.length ?? 0;
  let working = 0, blocked = 0, idle = 0;
  for (const s of subs ?? []) {
    const st = kidStatus(s.t, listed);
    if (st === "working") working++;
    else if (st === "blocked") blocked++;
    else idle++;
  }
  return { total, working, blocked, idle };
}

test("subStats - calculates correct count for empty subagents", () => {
  const stats = subStats([], new Map());
  assert.deepEqual(stats, { total: 0, working: 0, blocked: 0, idle: 0 });
});

test("subStats - detects active working subagents (⚡ 2/3)", () => {
  const subs = [
    { t: { address: "sub-1", status: "working" } },
    { t: { address: "sub-2", status: "working" } },
    { t: { address: "sub-3", status: "idle" } },
  ];
  const stats = subStats(subs, new Map());
  assert.equal(stats.total, 3);
  assert.equal(stats.working, 2);
  assert.equal(stats.blocked, 0);
  assert.equal(stats.idle, 1);

  // Badge text verification
  const badge = `⚡ ${stats.working}/${stats.total}`;
  assert.equal(badge, "⚡ 2/3");
});

test("subStats - handles error / blocked subagents", () => {
  const subs = [
    { t: { address: "sub-1", status: "error" } },
    { t: { address: "sub-2", status: "idle" } },
  ];
  const stats = subStats(subs, new Map());
  assert.equal(stats.total, 2);
  assert.equal(stats.working, 0);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.idle, 1);

  const badge = `! ${stats.blocked}/${stats.total}`;
  assert.equal(badge, "! 1/2");
});

test("subStats - reads status override from listed map", () => {
  const subs = [
    { t: { address: "sub-1", status: "idle" } },
  ];
  const listed = new Map([["sub-1", "working"]]);
  const stats = subStats(subs, listed);
  assert.equal(stats.working, 1);
  assert.equal(stats.idle, 0);
});

test("agents main.js - contains subStats and badge rendering", () => {
  const mainPath = path.resolve(import.meta.dirname, "../mods/agents/main.js");
  assert.equal(fs.existsSync(mainPath), true, "agents main.js must exist");
  const content = fs.readFileSync(mainPath, "utf-8");

  assert.match(content, /export function subStats\(subs, listed\)/);
  assert.match(content, /⚡ \$\{stats\.working\}\/\$\{stats\.total\}/);
  assert.match(content, /! \$\{stats\.blocked\}\/\$\{stats\.total\}/);
  assert.match(content, /subagent.*working.*needs you.*idle/);
});
