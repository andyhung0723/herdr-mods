import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.resolve(__dirname, "../daemon/mcp-server.mjs");

test("mcp-server handles initialize, tools/list, and tool calls over stdio", async () => {
  const proc = spawn("node", [mcpServerPath, "--agent=claude-test"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses = [];

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const l of lines) {
      if (l.trim()) {
        try {
          responses.push(JSON.parse(l.trim()));
        } catch {}
      }
    }
  });

  // 1. Send initialize
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(responses.some((r) => r.id === 1 && r.result?.serverInfo?.name === "herdr-browser"));

  // 2. Send tools/list
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const listResp = responses.find((r) => r.id === 2);
  assert.ok(listResp);
  assert.ok(Array.isArray(listResp.result?.tools));
  assert.ok(listResp.result.tools.some((t) => t.name === "browser_navigate"));
  assert.ok(listResp.result.tools.some((t) => t.name === "browser_click"));
  assert.ok(listResp.result.tools.some((t) => t.name === "browser_type"));
  assert.ok(listResp.result.tools.some((t) => t.name === "browser_snapshot"));

  proc.kill("SIGTERM");
});
