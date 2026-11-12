#!/usr/bin/env node
// Model Context Protocol (MCP) Server for Herdr Agent Browser
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DAEMON_LOG_PATH, DAEMON_URL, openDaemonLog, readToken } from "./state.mjs";

const args = process.argv.slice(2);
let agentName = process.env.HERDR_AGENT_NAME || "default";

for (const arg of args) {
  if (arg.startsWith("--agent=")) {
    agentName = arg.slice("--agent=".length);
  }
}
agentName = agentName.trim().toLowerCase();

const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate the agent's browser tab to a specified URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL or domain to visit (e.g. http://localhost:3000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector or (x, y) coordinates on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click (e.g. button#submit)" },
        x: { type: "number", description: "Optional X coordinate to click" },
        y: { type: "number", description: "Optional Y coordinate to click" },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text into an input field or active element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input element" },
        text: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Whether to clear existing text before typing", default: false },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Get a structured summary tree of the page content, text, links, and forms",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a JPEG screenshot of the current page viewport",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the browser page context",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression to execute in page window" },
      },
      required: ["script"],
    },
  },
];

const TOOL_ACTIONS = {
  browser_navigate: "navigate",
  browser_click: "click",
  browser_type: "type",
  browser_snapshot: "snapshot",
  browser_screenshot: "screenshot",
  browser_evaluate: "evaluate",
};

const ACTION_TIMEOUT_MS = 60_000;
const DAEMON_BOOT_TIMEOUT_MS = 15_000;

// Transport failure (daemon not listening) is the only case where we may start
// the daemon and retry. Any HTTP response — including 4xx/5xx from a failed
// click or evaluate — is final: retrying elsewhere would re-run side effects.
class DaemonUnreachableError extends Error {}

async function postAction(action, payload) {
  const token = readToken();
  let res;
  try {
    res = await fetch(`${DAEMON_URL}/action/${encodeURIComponent(agentName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ ...payload, action }),
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") throw new Error(`Browser action "${action}" timed out after ${ACTION_TIMEOUT_MS}ms`);
    throw new DaemonUnreachableError(err.message);
  }
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function isDaemonUp() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

let daemonBoot = null;

function ensureDaemon() {
  daemonBoot ??= (async () => {
    if (await isDaemonUp()) return;
    const log = openDaemonLog();
    const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();

    const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isDaemonUp()) return;
    }
    throw new Error(`Browser Hub daemon did not start within ${DAEMON_BOOT_TIMEOUT_MS}ms (see ${DAEMON_LOG_PATH})`);
  })().finally(() => {
    daemonBoot = null;
  });
  return daemonBoot;
}

async function executeAction(action, payload) {
  try {
    return await postAction(action, payload);
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
    await ensureDaemon();
    return postAction(action, payload);
  }
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

function formatResult(name, data) {
  const { result } = data;
  switch (name) {
    case "browser_screenshot":
      return { content: [{ type: "image", data: result, mimeType: "image/jpeg" }] };
    case "browser_snapshot":
    case "browser_evaluate":
      return toolText(typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2));
    case "browser_navigate":
      return toolText(`Navigated to: ${data.url}\nTitle: ${data.title}`);
    default: {
      const failed = result && typeof result === "object" && result.ok === false;
      return toolText(`${failed ? "Failed" : "OK"}: ${name} on ${data.url}\n${JSON.stringify(result ?? null)}`, failed);
    }
  }
}

async function handleToolCall(name, params) {
  const action = Object.hasOwn(TOOL_ACTIONS, name) ? TOOL_ACTIONS[name] : null;
  if (!action) throw new Error(`Unknown tool: ${name}`);
  try {
    return formatResult(name, await executeAction(action, params));
  } catch (err) {
    return toolText(`${name} failed: ${err.message}`, true);
  }
}

function sendResponse(id, result, error = null) {
  const resp = { jsonrpc: "2.0", id };
  if (error) {
    resp.error = { code: -32603, message: String(error) };
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + "\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  const str = line.trim();
  if (!str) return;

  try {
    const req = JSON.parse(str);
    const { id, method, params } = req;

    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "herdr-browser", version: "1.0.0" },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      try {
        const result = await handleToolCall(params.name, params.arguments || {});
        sendResponse(id, result);
      } catch (err) {
        sendResponse(id, null, err.message);
      }
      return;
    }

    if (id !== undefined) {
      sendResponse(id, null, `Method not found: ${method}`);
    }
  } catch (err) {
    console.error("MCP server error:", err);
  }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
