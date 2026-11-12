#!/usr/bin/env node
// Central Daemon for Herdr Agent Browser Hub
// Exposes HTTP API for Herdr UI Mods and MCP clients.
//
// Security model: bound to loopback, no CORS, every endpoint except /health
// requires `Authorization: Bearer <token>` (token in ~/.config/herdr-browser/token,
// mode 0600). Without CORS a web page cannot attach that header, and the Host
// check rejects DNS-rebinding requests that would otherwise look same-origin.
import crypto from "node:crypto";
import http from "node:http";
import { BrowserHub, normalizeNavigationUrl } from "./browser-hub.mjs";
import { stopEdge } from "./edge-launcher.mjs";
import { DAEMON_HOST, DAEMON_PORT, loadOrCreateToken } from "./state.mjs";

const ALLOWED_HOSTS = new Set([`${DAEMON_HOST}:${DAEMON_PORT}`, `localhost:${DAEMON_PORT}`]);
const MAX_BODY_BYTES = 1024 * 1024;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const token = loadOrCreateToken();
const tokenBuffer = Buffer.from(token);
const hub = new BrowserHub();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req) {
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  return presented.length === tokenBuffer.length && crypto.timingSafeEqual(presented, tokenBuffer);
}

function parseAgentId(pathname, prefix) {
  let agentId;
  try {
    agentId = decodeURIComponent(pathname.slice(prefix.length)).trim().toLowerCase();
  } catch {
    throw new HttpError(400, "Malformed agent id");
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new HttpError(400, `Invalid agent id (expected ${AGENT_ID_PATTERN})`);
  }
  return agentId;
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function assertNavigableUrl(url) {
  try {
    normalizeNavigationUrl(url);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

const ACTIONS = {
  navigate: (session, p) => session.navigate(p.url),
  click: (session, p) => session.click({ selector: p.selector, x: p.x, y: p.y }),
  type: (session, p) => session.type({ selector: p.selector, text: p.text, clear: p.clear }),
  reload: (session) => session.navigate(session.currentUrl),
  snapshot: (session) => session.getSnapshot(),
  screenshot: (session) => session.screenshot("jpeg"),
  evaluate: (session, p) => session.evaluate(p.script),
};

async function handleRequest(req, res, url) {
  const { pathname } = url;

  if (pathname === "/health" || pathname === "/") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) throw new HttpError(401, "Unauthorized");

  if (pathname === "/status" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...hub.status() });
    return;
  }

  // Polled by the UI: must never trigger a browser launch.
  if (pathname === "/sessions" && req.method === "GET") {
    sendJson(res, 200, { ok: true, browser: hub.status(), sessions: hub.listSessions() });
    return;
  }

  if (pathname.startsWith("/session/") && req.method === "POST") {
    const session = await hub.getOrCreateSession(parseAgentId(pathname, "/session/"));
    sendJson(res, 200, { ok: true, agentId: session.agentId, url: session.currentUrl, title: session.currentTitle });
    return;
  }

  if (pathname.startsWith("/frame/") && req.method === "GET") {
    const agentId = parseAgentId(pathname, "/frame/");
    const session = hub.sessions.get(agentId);
    if (!session) throw new HttpError(404, "Session not found");

    if (url.searchParams.get("raw") === "1" && session.lastFrame) {
      const imgBuffer = Buffer.from(session.lastFrame, "base64");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": imgBuffer.length, "Cache-Control": "no-store" });
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

  if (pathname.startsWith("/action/") && req.method === "POST") {
    const agentId = parseAgentId(pathname, "/action/");
    const payload = await readJsonBody(req);
    const { action } = payload;

    if (action === "close") {
      await hub.closeSession(agentId);
      sendJson(res, 200, { ok: true, agentId, result: { closed: agentId } });
      return;
    }

    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!run) throw new HttpError(400, `Unknown action: ${action}`);
    if (action === "navigate") assertNavigableUrl(payload.url);

    const session = await hub.getOrCreateSession(agentId);
    const result = await run(session, payload);
    sendJson(res, 200, { ok: true, agentId, url: session.currentUrl, title: session.currentTitle, result });
    return;
  }

  throw new HttpError(404, "Not found");
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
    const url = new URL(req.url, `http://${req.headers.host}`);
    await handleRequest(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error("Daemon request error:", err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${DAEMON_PORT} already in use; another daemon is probably running.`);
    process.exit(1);
  }
  throw err;
});

server.listen(DAEMON_PORT, DAEMON_HOST, async () => {
  console.log(`Herdr Agent Browser Hub Daemon listening on http://${DAEMON_HOST}:${DAEMON_PORT}`);
  try {
    await hub.init();
    console.log("Browser core initialized and ready.");
  } catch (err) {
    console.error("Warning: Could not start browser automatically:", err.message);
  }
});

async function shutdown() {
  console.log("Shutting down Browser Hub Daemon...");
  await hub.destroy({ closeBrowser: true }).catch(() => {});
  stopEdge();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
