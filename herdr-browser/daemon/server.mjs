#!/usr/bin/env node
// Central Daemon for Herdr Agent Browser Hub
// Exposes HTTP API for Herdr UI Mods and MCP clients
import http from "node:http";
import { BrowserHub } from "./browser-hub.mjs";

const PORT = 9223;
const hub = new BrowserHub();

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    // 1. Health check
    if (pathname === "/health" || pathname === "/") {
      sendJson(res, 200, { ok: true, isReady: hub.isReady, sessions: hub.listSessions().length });
      return;
    }

    // 2. List active sessions
    if (pathname === "/sessions" && req.method === "GET") {
      await hub.init().catch(() => {});
      sendJson(res, 200, { ok: true, sessions: hub.listSessions() });
      return;
    }

    // 3. Get or create session
    // POST /session/:agent
    if (pathname.startsWith("/session/") && req.method === "POST") {
      const agentId = pathname.replace("/session/", "").trim();
      const session = await hub.getOrCreateSession(agentId);
      sendJson(res, 200, {
        ok: true,
        agentId: session.agentId,
        url: session.currentUrl,
        title: session.currentTitle,
      });
      return;
    }

    // 4. Get latest frame of an agent
    // GET /frame/:agent
    if (pathname.startsWith("/frame/") && req.method === "GET") {
      const agentId = pathname.replace("/frame/", "").trim();
      const session = hub.sessions.get(agentId);
      if (!session) {
        sendJson(res, 404, { ok: false, error: "Session not found" });
        return;
      }

      if (url.searchParams.get("raw") === "1" && session.lastFrame) {
        const imgBuffer = Buffer.from(session.lastFrame, "base64");
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": imgBuffer.length,
          "Cache-Control": "no-cache",
        });
        res.end(imgBuffer);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        agentId,
        url: session.currentUrl,
        title: session.currentTitle,
        hasFrame: Boolean(session.lastFrame),
        frame: session.lastFrame || null,
        time: session.lastFrameTime,
      });
      return;
    }

    // 5. Execute action for an agent
    // POST /action/:agent
    if (pathname.startsWith("/action/") && req.method === "POST") {
      const agentId = pathname.replace("/action/", "").trim();
      const session = await hub.getOrCreateSession(agentId);

      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = body ? JSON.parse(body) : {};
      const { action } = payload;

      let result = null;
      switch (action) {
        case "navigate":
          result = await session.navigate(payload.url);
          break;
        case "click":
          result = await session.click({ selector: payload.selector, x: payload.x, y: payload.y });
          break;
        case "type":
          result = await session.type({ selector: payload.selector, text: payload.text, clear: payload.clear });
          break;
        case "reload":
          result = await session.navigate(session.currentUrl);
          break;
        case "snapshot":
          result = await session.getSnapshot();
          break;
        case "screenshot":
          result = await session.screenshot("jpeg");
          break;
        case "evaluate":
          result = await session.evaluate(payload.script);
          break;
        case "close":
          await hub.closeSession(agentId);
          result = { ok: true, closed: agentId };
          break;
        default:
          sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
          return;
      }

      sendJson(res, 200, {
        ok: true,
        agentId,
        url: session.currentUrl,
        title: session.currentTitle,
        result,
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    console.error("Daemon request error:", err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Herdr Agent Browser Hub Daemon listening on http://127.0.0.1:${PORT}`);
  try {
    await hub.init();
    console.log("Edge browser core initialized and ready.");
  } catch (err) {
    console.error("Warning: Could not start Edge automatically:", err.message);
  }
});

async function shutdown() {
  console.log("Shutting down Browser Hub Daemon...");
  await hub.destroy().catch(() => {});
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
