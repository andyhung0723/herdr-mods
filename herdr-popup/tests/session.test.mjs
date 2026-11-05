import assert from "node:assert/strict";
import test from "node:test";
import { ensureShell, shellContext, terminalOverlay } from "../mods/popup-terminal/session.js";

const focus = { space: "sp0123456789abcdef0123456789abcdef", terminal: "t1", cwd: "/repo with spaces" };
const space = { id: focus.space, machine: null, folder: "/fallback" };
const context = shellContext(focus, [space]);
const result = (data, code = 0) => ({ code, stdout: JSON.stringify(data), stderr: "" });

test("a missing shell starts in the focused folder without a parent or workspace pane", async () => {
  const calls = [];
  const address = await ensureShell(context, async (args) => {
    calls.push(args);
    return calls.length === 1 ? result({}, 3) : result({ address: "t2" });
  });
  assert.equal(address, "t2");
  const launch = calls[1];
  assert(launch.includes("--no-parent"));
  assert(launch.includes("--keep"));
  assert(launch.includes("--bg"));
  assert.equal(launch[launch.indexOf("--cwd") + 1], "/repo with spaces");
  assert.equal(launch[launch.indexOf("--label") + 1], `herdr.popup-terminal=${space.id}`);
  assert(!launch.some((arg) => arg.includes("herdr.space=")));
});

test("reopening reuses a live shell and never runs a second command", async () => {
  const calls = [];
  const address = await ensureShell(context, async (args) => {
    calls.push(args);
    return result({ address: "t2", state: "live", labels: { "herdr.popup-terminal": space.id } });
  });
  assert.equal(address, "t2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "get");
});

test("a shell exited by the user is recreated on next open", async () => {
  let calls = 0;
  const address = await ensureShell(context, async () => {
    calls++;
    return calls === 1 ? result({ terminal: { state: "finished" } }) : result({ address: "t3" });
  });
  assert.equal(address, "t3");
  assert.equal(calls, 2);
});

test("a connection failure must not create a duplicate shell", async () => {
  let calls = 0;
  await assert.rejects(ensureShell(context, async () => {
    calls++;
    return { code: 1, stdout: "", stderr: "machine offline" };
  }), /machine offline/);
  assert.equal(calls, 1);
});

test("an unrelated terminal with the same name is never adopted", async () => {
  let calls = 0;
  await assert.rejects(ensureShell(context, async () => {
    calls++;
    return result({ address: "t7", state: "live", labels: {} });
  }), /已被其他工作占用/);
  assert.equal(calls, 1);
});

test("remote spaces launch on their own machine and qualify the address", async () => {
  const remote = shellContext({ ...focus, space: `vps/${space.id}` }, [
    { ...space, id: `vps/${space.id}`, machine: "vps" },
  ]);
  const calls = [];
  assert.equal(await ensureShell(remote, async (args) => {
    calls.push(args);
    return calls.length === 1 ? result({}, 3) : result({ address: "t4" });
  }), "vps/t4");
  assert.equal(calls[0][1], `vps/${context.name}`);
  assert.equal(calls[1][calls[1].indexOf("--on") + 1], "vps");
});

test("unknown terminal state and malformed JSON are reported without launching", async () => {
  for (const response of [result({ address: "t2" }), { code: 0, stdout: "not JSON" }]) {
    let calls = 0;
    await assert.rejects(ensureShell(context, async () => {
      calls++;
      return response;
    }));
    assert.equal(calls, 1);
  }
});

test("popup uses a native terminal block with the previous terminal available for focus restore", () => {
  const overlay = terminalOverlay("t2", context);
  assert.equal(overlay.kind, "dialog");
  assert(overlay.width > 0 && overlay.width < 1);
  assert(overlay.height > 0 && overlay.height < 1);
  assert.equal(overlay.layout.children[1].content.terminal, "t2");
  assert.equal(overlay.layout.children[0].content.props.returnTerminal, "t1");
});

test("workspace IDs isolate shells; the core name stays within its 32-character limit", () => {
  const other = shellContext({ ...focus, space: "spabcdefabcdefabcdefabcdefabcdef12" }, [
    { ...space, id: "spabcdefabcdefabcdefabcdefabcdef12" },
  ]);
  assert.notEqual(other.name, context.name);
  assert.match(context.name, /^[a-z0-9_-]{1,32}$/);
  assert.throws(() => shellContext(focus, []), /選擇工作空間/);
});
