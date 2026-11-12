#!/usr/bin/env node
// Model Context Protocol (MCP) Server for Herdr Agent Browser
import readline from "node:readline";
import { BrowserHub } from "./browser-hub.mjs";

const args = process.argv.slice(2);
let agentName = process.env.HERDR_AGENT_NAME || "default";

for (const arg of args) {
  if (arg.startsWith("--agent=")) {
    agentName = arg.split("=")[1];
  }
}

// Global Hub instance for standalone mode
let localHub = null;

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

async function executeViaDaemon(action, payload) {
  try {
    const res = await fetch(`http://127.0.0.1:9223/action/${agentName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch {}
  return null;
}

async function handleToolCall(name, params) {
  // Try central daemon first
  let actionName = "";
  if (name === "browser_navigate") actionName = "navigate";
  else if (name === "browser_click") actionName = "click";
  else if (name === "browser_type") actionName = "type";
  else if (name === "browser_snapshot") actionName = "snapshot";
  else if (name === "browser_screenshot") actionName = "screenshot";
  else if (name === "browser_evaluate") actionName = "evaluate";

  const daemonResult = await executeViaDaemon(actionName, params);
  if (daemonResult && daemonResult.ok) {
    if (name === "browser_screenshot") {
      return {
        content: [{ type: "image", data: daemonResult.result, mimeType: "image/jpeg" }],
      };
    }
    if (name === "browser_snapshot" || name === "browser_evaluate") {
      return {
        content: [{ type: "text", text: typeof daemonResult.result === "string" ? daemonResult.result : JSON.stringify(daemonResult.result, null, 2) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Action ${name} succeeded on ${daemonResult.url || ""}\n${JSON.stringify(daemonResult.result || "")}`,
        },
      ],
    };
  }

  // Fallback to standalone local hub
  if (!localHub) {
    localHub = new BrowserHub();
    await localHub.init();
  }
  const session = await localHub.getOrCreateSession(agentName);

  switch (name) {
    case "browser_navigate": {
      await session.navigate(params.url);
      return {
        content: [
          {
            type: "text",
            text: `Successfully navigated to: ${session.currentUrl}\nTitle: ${session.currentTitle}`,
          },
        ],
      };
    }
    case "browser_click": {
      const res = await session.click(params);
      return {
        content: [
          {
            type: "text",
            text: res.ok ? `Clicked successfully: ${JSON.stringify(res)}` : `Click failed: ${res.error}`,
          },
        ],
        isError: !res.ok,
      };
    }
    case "browser_type": {
      const res = await session.type(params);
      return {
        content: [
          {
            type: "text",
            text: `Typed ${res.typedLength} characters into ${params.selector || "active element"}`,
          },
        ],
      };
    }
    case "browser_snapshot": {
      const snapshot = await session.getSnapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    }
    case "browser_screenshot": {
      const b64 = await session.screenshot("jpeg");
      return {
        content: [
          {
            type: "image",
            data: b64,
            mimeType: "image/jpeg",
          },
        ],
      };
    }
    case "browser_evaluate": {
      const result = await session.evaluate(params.script);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
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

process.on("SIGINT", async () => {
  if (localHub) await localHub.destroy().catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (localHub) await localHub.destroy().catch(() => {});
  process.exit(0);
});
