import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vendorFromClientName } from "../daemon/mcp-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.resolve(__dirname, "../daemon/mcp-server.mjs");

test("vendorFromClientName maps known MCP clients", () => {
  assert.equal(vendorFromClientName("claude-code"), "claude");
  assert.equal(vendorFromClientName("codex-mcp-client"), "codex");
  assert.equal(vendorFromClientName("Antigravity"), "antigravity");
  assert.equal(vendorFromClientName("Some Client"), "some-client");
});

function rpcSession(args, env = {}) {
  const proc = spawn(process.execPath, [mcpServerPath, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
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
