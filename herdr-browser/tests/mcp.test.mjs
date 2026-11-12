import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { negotiateProtocolVersion, vendorFromClientName } from "../daemon/mcp-server.mjs";
import { NO_BROWSER, daemonEnv, freePort, isHealthy, isPidAlive, removeStateDir, tempStateDir, waitFor } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.resolve(__dirname, "../daemon/mcp-server.mjs");

test("negotiateProtocolVersion keeps supported versions and falls back to the newest", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("1999-01-01"), "2025-06-18");
  assert.equal(negotiateProtocolVersion(undefined), "2025-06-18");
});

test("vendorFromClientName maps known MCP clients", () => {
  assert.equal(vendorFromClientName("claude-code"), "claude");
  assert.equal(vendorFromClientName("codex-mcp-client"), "codex");
  assert.equal(vendorFromClientName("Antigravity"), "antigravity");
  assert.equal(vendorFromClientName("Some Client"), "some-client");
});

function rpcSession(args, env = process.env) {
  const proc = spawn(process.execPath, [mcpServerPath, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
  const waiters = new Map();
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { request, close: () => proc.kill("SIGTERM") };
}

test("mcp-server speaks initialize / tools/list over stdio", async () => {
  const rpc = rpcSession([]);
  try {
    const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } });
    assert.equal(init.result.serverInfo.name, "herdr-browser");
    assert.equal(init.result.protocolVersion, "2025-06-18");

    const list = await rpc.request("tools/list");
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_close"]) {
      assert.ok(names.includes(n), n);
    }
    assert.ok(list.result.tools.every((t) => !("action" in t)), "internal fields must not leak");

    const unknown = await rpc.request("tools/call", { name: "nope", arguments: {} });
    assert.ok(unknown.error);
  } finally {
    rpc.close();
  }
});

test("first tool call starts the daemon; session is named <vendor>-<terminal>", { skip: NO_BROWSER }, async () => {
  const port = await freePort();
  const stateDir = tempStateDir();
  const rpc = rpcSession([], { ...daemonEnv(port, stateDir), HC_TERMINAL_ID: "t42" });
  let daemonPid;
  try {
    assert.equal(await isHealthy(port), false);
    await rpc.request("initialize", { clientInfo: { name: "codex-mcp-client" } });

    const nav = await rpc.request("tools/call", {
      name: "browser_navigate",
      arguments: { url: "data:text/html,<title>Booted</title>" },
    });
    assert.ok(!nav.result.isError, nav.result.content[0].text);
    assert.match(nav.result.content[0].text, /Title: Booted/);

    daemonPid = Number(fs.readFileSync(`${stateDir}/daemon.pid`, "utf8"));
    const token = fs.readFileSync(`${stateDir}/token`, "utf8").trim();
    const { sessions } = await (await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(sessions.map((s) => s.agentId), ["codex-t42"]);

    const blocked = await rpc.request("tools/call", { name: "browser_navigate", arguments: { url: "file:///etc/hosts" } });
    assert.equal(blocked.result.isError, true, "daemon errors surface as tool errors, not JSON-RPC errors");
  } finally {
    rpc.close();
    if (daemonPid) {
      process.kill(daemonPid, "SIGTERM");
      await waitFor(() => !isPidAlive(daemonPid));
    }
    removeStateDir(stateDir);
  }
});
