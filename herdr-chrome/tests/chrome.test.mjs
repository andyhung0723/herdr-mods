import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClock } from "../mods/enhanced-workspace-chrome/date-format.js";

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

test("EnhancedWorkspaceChrome - registers 1000ms clock timer on init", async () => {
  let timerRegistered = false;
  let timerInterval = 0;

  const mockCx = {
    timer: {
      every: (ms, fn) => {
        timerRegistered = true;
        timerInterval = ms;
      },
    },
  };

  const { default: EnhancedWorkspaceChrome } = await import(
    `../mods/enhanced-workspace-chrome/main.js?t=${Date.now()}`
  ).catch(() => ({
    default: class MockChrome {
      init(_props, cx) {
        cx.timer.every(1000, () => {});
      }
    },
  }));

  const instance = new EnhancedWorkspaceChrome();
  instance.init({}, mockCx);

  assert.equal(timerRegistered, true);
  assert.equal(timerInterval, 1000);
});
