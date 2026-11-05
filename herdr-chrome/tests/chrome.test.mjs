import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatClock } from "../mods/enhanced-workspace-chrome/date-format.js";
import { computeDogState } from "../mods/enhanced-workspace-chrome/dog-state.js";

test("formatClock - formats fixed date correctly", () => {
  // 2026-11-05 21:58:41 is Thursday (週四)
  const fixed = new Date(2026, 10, 5, 21, 58, 41);
  const actual = formatClock(fixed);

  assert.equal(actual.time, "21:58:41");
  assert.equal(actual.date, "11/05 週四");
  assert.equal(actual.fullDate, "2026/11/05 週四");
  assert.equal(actual.isoTimestamp, "2026-11-05 21:58:41");
});

test("formatClock - pads single digit values", () => {
  // 2026-01-02 03:04:05 is Friday (週五)
  const fixed = new Date(2026, 0, 2, 3, 4, 5);
  const actual = formatClock(fixed);

  assert.equal(actual.time, "03:04:05");
  assert.equal(actual.date, "01/02 週五");
  assert.equal(actual.isoTimestamp, "2026-01-02 03:04:05");
});

test("computeDogState - Phase 1: walks right for ticks 0..15", () => {
  const start = computeDogState(0);
  assert.equal(start.mode, "walk_right");
  assert.equal(start.frame, 1);
  assert.equal(start.offset, 0);
  assert.equal(start.svg, "dog-right-f1.svg");

  const mid = computeDogState(7);
  assert.equal(mid.mode, "walk_right");
  assert.equal(mid.frame, 2);
  assert.equal(mid.offset, 9);
  assert.equal(mid.svg, "dog-right-f2.svg");

  const end = computeDogState(15);
  assert.equal(end.mode, "walk_right");
  assert.equal(end.frame, 2);
  assert.equal(end.offset, 20);
  assert.equal(end.svg, "dog-right-f2.svg");
});

test("computeDogState - Phase 2: sits and wags tail at right edge (ticks 16..23)", () => {
  const f1 = computeDogState(16);
  assert.equal(f1.mode, "sit");
  assert.equal(f1.frame, 1);
  assert.equal(f1.offset, 20);
  assert.equal(f1.svg, "dog-sit-f1.svg");

  const f2 = computeDogState(17);
  assert.equal(f2.mode, "sit");
  assert.equal(f2.frame, 2);
  assert.equal(f2.offset, 20);
  assert.equal(f2.svg, "dog-sit-f2.svg");
});

test("computeDogState - Phase 3: walks left back to origin (ticks 24..39)", () => {
  const start = computeDogState(24);
  assert.equal(start.mode, "walk_left");
  assert.equal(start.frame, 1);
  assert.equal(start.offset, 20);
  assert.equal(start.svg, "dog-left-f1.svg");

  const mid = computeDogState(31);
  assert.equal(mid.mode, "walk_left");
  assert.equal(mid.frame, 2);
  assert.equal(mid.offset, 11);
  assert.equal(mid.svg, "dog-left-f2.svg");

  const end = computeDogState(39);
  assert.equal(end.mode, "walk_left");
  assert.equal(end.frame, 2);
  assert.equal(end.offset, 0);
  assert.equal(end.svg, "dog-left-f2.svg");
});

test("computeDogState - Phase 4: sits and wags tail at origin (ticks 40..47)", () => {
  const f1 = computeDogState(40);
  assert.equal(f1.mode, "sit");
  assert.equal(f1.frame, 1);
  assert.equal(f1.offset, 0);
  assert.equal(f1.svg, "dog-sit-f1.svg");

  const f2 = computeDogState(41);
  assert.equal(f2.mode, "sit");
  assert.equal(f2.frame, 2);
  assert.equal(f2.offset, 0);
  assert.equal(f2.svg, "dog-sit-f2.svg");
});

test("computeDogState - wraps smoothly after 48 ticks", () => {
  const tick48 = computeDogState(48);
  const tick0 = computeDogState(0);
  assert.deepEqual(tick48, tick0);
});

test("dog svg assets exist and contain valid SVG markup", () => {
  const baseDir = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-workspace-chrome"
  );
  const requiredSvgs = [
    "dog-right-f1.svg",
    "dog-right-f2.svg",
    "dog-left-f1.svg",
    "dog-left-f2.svg",
    "dog-sit-f1.svg",
    "dog-sit-f2.svg",
  ];

  for (const file of requiredSvgs) {
    const fullPath = path.join(baseDir, file);
    assert.equal(fs.existsSync(fullPath), true, `SVG file must exist: ${file}`);
    const content = fs.readFileSync(fullPath, "utf-8");
    assert.match(content, /<svg[^>]*viewBox=/);
    assert.match(content, /<rect /);
  }
});
