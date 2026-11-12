#!/usr/bin/env node
// Model Context Protocol (MCP) Server for Herdr Agent Browser
//
// Identity: one browser session per agent *instance*. The vendor comes from
// `--agent=<vendor>` or the MCP client's `clientInfo.name`; the instance is the
// Herdr terminal (`HC_TERMINAL_ID`, inherited from the agent's pane). Codex
// only forwards env vars it is told to, so its MCP entry must list
// HC_TERMINAL_ID in `env_vars`.
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DAEMON_LOG_PATH, DAEMON_URL, openDaemonLog, readToken } from "./state.mjs";

// Newest first. A client asking for an unknown version gets our newest; it decides whether to continue.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}
const ACTION_TIMEOUT_MS = 60_000;
const DAEMON_BOOT_TIMEOUT_MS = 15_000;

const vendorArg = process.argv.slice(2).find((a) => a.startsWith("--agent="))?.slice("--agent=".length);
const terminal = sanitizeId(process.env.HC_TERMINAL_ID);
let vendor = sanitizeId(vendorArg);

function sanitizeId(value) {
  const clean = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return clean || null;
}

export function vendorFromClientName(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.includes("antigravity") || n.includes("gemini")) return "antigravity";
  return sanitizeId(n);
}

function agentId() {
  const v = vendor ?? "agent";
  return terminal ? `${v}-${terminal}` : v;
}

const REF_OR_SELECTOR = {
  ref: { type: "string", description: "Element ref from the latest browser_snapshot, e.g. e12 (preferred)" },
  selector: { type: "string", description: "CSS selector, when no ref is available" },
};

const TOOLS = [
  {
    name: "browser_navigate",
    action: "navigate",
    description: "Navigate this agent's isolated browser tab to a URL and wait for load. Only http(s), about: and data: URLs are allowed.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL or host, e.g. localhost:3000" } }, required: ["url"] },
  },
  {
    name: "browser_back",
    action: "back",
    description: "Go back one page in history",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    action: "snapshot",
    description: "Accessibility snapshot of the page. Interactive elements carry [ref=eN] for browser_click / browser_type. Refs expire on the next snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    action: "click",
    description: "Click an element (by ref or selector) or viewport coordinates, with real mouse events",
    inputSchema: {
      type: "object",
      properties: {
        ...REF_OR_SELECTOR,
        x: { type: "number", description: "Viewport X (CSS px), with y" },
        y: { type: "number", description: "Viewport Y (CSS px), with x" },
        clickCount: { type: "number", description: "2 for double-click", default: 1 },
      },
    },
  },
  {
    name: "browser_type",
    action: "type",
    description: "Type text into an element (focused first) or into the currently focused element",
    inputSchema: {
      type: "object",
      properties: {
        ...REF_OR_SELECTOR,
        text: { type: "string", description: "Text to insert" },
        clear: { type: "boolean", description: "Replace existing content", default: false },
        submit: { type: "boolean", description: "Press Enter afterwards", default: false },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_press_key",
    action: "press_key",
    description: "Press a key or chord on the focused element, e.g. Enter, Escape, Tab, ArrowDown, Shift+Tab",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    action: "scroll",
    description: "Scroll the page with the mouse wheel (positive dy scrolls down)",
    inputSchema: { type: "object", properties: { dx: { type: "number", default: 0 }, dy: { type: "number" } }, required: ["dy"] },
  },
  {
    name: "browser_screenshot",
    action: "screenshot",
    description: "JPEG screenshot of the current viewport (1280x800)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_evaluate",
    action: "evaluate",
    description: "Evaluate a JavaScript expression in the page and return its JSON value (promises are awaited)",
    inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
  },
  {
    name: "browser_close",
    action: "close",
    description: "Close this agent's browser session and discard its cookies and storage",
    inputSchema: { type: "object", properties: {} },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Transport failure (daemon not listening) is the only case where we may start
// the daemon and retry. Any HTTP response — including 4xx/5xx from a failed
// click or evaluate — is final: retrying elsewhere would re-run side effects.
class DaemonUnreachableError extends Error {}

async function postAction(action, args) {
  const token = readToken();
  let res;
  try {
    res = await fetch(`${DAEMON_URL}/action/${encodeURIComponent(agentId())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ ...args, action, source: "agent", client: { vendor, terminal } }),
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

async function executeAction(action, args) {
  try {
    return await postAction(action, args);
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
    await ensureDaemon();
    return postAction(action, args);
  }
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

function formatResult(action, data) {
  const { result } = data;
  switch (action) {
    case "screenshot":
      return { content: [{ type: "image", data: result, mimeType: "image/jpeg" }] };
    case "snapshot":
      return toolText(result);
    case "evaluate":
      return toolText(JSON.stringify(result ?? null, null, 2));
    case "navigate":
    case "back": {
      const note = result?.loaded === false ? "\n(load event did not fire within 15s; page may still be loading)" : "";
      return toolText(`Now at: ${data.url}\nTitle: ${data.title}${note}`);
    }
    default:
      return toolText(`OK (${data.url})\n${JSON.stringify(result ?? null)}`);
  }
}

async function handleToolCall(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  try {
    return formatResult(tool.action, await executeAction(tool.action, args));
  } catch (err) {
    return toolText(`${name} failed: ${err.message}`, true);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function handleMessage({ id, method, params }) {
  switch (method) {
    case "initialize":
      vendor ??= vendorFromClientName(params?.clientInfo?.name);
      send({
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: "herdr-browser", version: "1.1.0" },
        },
      });
      return;
    case "tools/list":
      send({ id, result: { tools: TOOLS.map(({ action, ...tool }) => tool) } });
      return;
    case "tools/call":
      send({ id, result: await handleToolCall(params?.name, params?.arguments ?? {}) });
      return;
    case "ping":
      send({ id, result: {} });
      return;
    default:
      if (id !== undefined && !method?.startsWith("notifications/")) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      await handleMessage(message);
    } catch (err) {
      if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: err.message } });
    }
  });
  rl.on("close", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
