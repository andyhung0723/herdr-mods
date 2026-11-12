#!/usr/bin/env node
// Central Daemon for Herdr Agent Browser Hub
// Exposes HTTP API for Herdr UI Mods and MCP clients.
//
// Security model: bound to loopback, no CORS, every endpoint except /health
// requires `Authorization: Bearer <token>` (token in ~/.config/herdr-browser/token,
// mode 0600). Without CORS a web page cannot attach that header, and the Host
// check rejects DNS-rebinding requests that would otherwise look same-origin.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";
import { ActionError, HumanDrivingError } from "./agent-session.mjs";
import { BrowserHub } from "./browser-hub.mjs";
import { stopEdge } from "./edge-launcher.mjs";
import { DAEMON_HOST, DAEMON_PORT, loadOrCreateToken, removePidFile, writePidFile } from "./state.mjs";
import { normalizeNavigationUrl } from "./url-policy.mjs";

const ALLOWED_HOSTS = new Set([`${DAEMON_HOST}:${DAEMON_PORT}`, `localhost:${DAEMON_PORT}`]);
const MAX_BODY_BYTES = 1024 * 1024;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TERMINAL_PRUNE_INTERVAL_MS = 60_000;

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

function parseClientMeta(client) {
  if (!client || typeof client !== "object") return undefined;
  const clean = (v) => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v.toLowerCase() : undefined);
  return { vendor: clean(client.vendor), terminal: clean(client.terminal) };
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

// `driving: true` actions change the page and are refused for the agent while a human drives.
const ACTIONS = {
  navigate: { driving: true, run: (s, p) => s.navigate(p.url) },
  reload: { driving: true, run: (s) => s.reload() },
  back: { driving: true, run: (s) => s.goHistory(-1) },
  forward: { driving: true, run: (s) => s.goHistory(1) },
  click: { driving: true, run: (s, p) => s.click(p) },
  type: { driving: true, run: (s, p) => s.type(p) },
  press_key: { driving: true, run: (s, p) => s.pressKey(p.key, { text: p.text }) },
  scroll: { driving: true, run: (s, p) => s.scroll(p) },
  evaluate: { driving: true, run: (s, p) => s.evaluate(p.script) },
  snapshot: { driving: false, run: (s) => s.snapshot() },
  screenshot: { driving: false, run: (s) => s.screenshot() },
  set_driver: { driving: false, humanOnly: true, run: (s, p) => s.setDriver(p.driver) },
};

async function handleAction(res, agentId, payload) {
  const { action } = payload;
  const isHuman = payload.source === "human";

  if (action === "close") {
    const closed = await hub.closeSession(agentId);
    sendJson(res, 200, { ok: true, agentId, result: { closed } });
    return;
  }

  const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!spec) throw new HttpError(400, `Unknown action: ${action}`);
  if (spec.humanOnly && !isHuman) throw new HttpError(403, `${action} is only available from the Herdr UI`);
  if (action === "navigate") {
    try {
      normalizeNavigationUrl(payload.url);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  const session = await hub.getOrCreateSession(agentId, parseClientMeta(payload.client));
  if (spec.driving && !isHuman) session.assertAgentMayAct();
  if (!isHuman) session.touch();

  const result = await session.exclusive(async () => {
    const value = await spec.run(session, payload);
    if (spec.driving) await session.refreshTitleAndUrl();
    return value;
  });
  sendJson(res, 200, { ok: true, agentId, url: session.currentUrl, title: session.currentTitle, driver: session.driver, result });
}

async function handleFrame(res, agentId, url) {
  const session = hub.sessions.get(agentId);
  if (!session?.isAlive) throw new HttpError(404, "Session not found");
  await session.noteViewed();
  const after = Number(url.searchParams.get("after")) || 0;
  sendJson(res, 200, { ok: true, agentId, ...session.frameAfter(after) });
}

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

  if (pathname.startsWith("/frame/") && req.method === "GET") {
    await handleFrame(res, parseAgentId(pathname, "/frame/"), url);
    return;
  }

  if (pathname.startsWith("/action/") && req.method === "POST") {
    await handleAction(res, parseAgentId(pathname, "/action/"), await readJsonBody(req));
    return;
  }

  throw new HttpError(404, "Not found");
}

function statusFor(err) {
  if (err instanceof HttpError) return err.status;
  if (err instanceof HumanDrivingError) return 409;
  if (err instanceof ActionError) return 422;
  return 500;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
    const url = new URL(req.url, `http://${req.headers.host}`);
    await handleRequest(req, res, url);
  } catch (err) {
    const status = statusFor(err);
    if (status >= 500) console.error("Daemon request error:", err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message });
  }
});

// Sessions belong to Herdr terminals; when the terminal is gone, so is the session.
const execFileAsync = promisify(execFile);
async function pruneSessionsOfEndedTerminals() {
  const owned = hub.listSessions().filter((s) => s.terminal);
  if (owned.length === 0) return;
  let live;
  try {
    const { stdout } = await execFileAsync("hc", ["ls", "--json"], { timeout: 5000 });
    live = new Set(JSON.parse(stdout).terminals.filter((t) => t.state === "live").map((t) => t.address.toLowerCase()));
  } catch {
    return; // hc unavailable: fall back to idle-timeout cleanup only
  }
  for (const s of owned) {
    if (!live.has(s.terminal)) {
      console.log(`Terminal ${s.terminal} ended; closing session ${s.agentId}`);
      await hub.closeSession(s.agentId).catch(() => {});
    }
  }
}
setInterval(pruneSessionsOfEndedTerminals, TERMINAL_PRUNE_INTERVAL_MS).unref();

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${DAEMON_PORT} already in use; another daemon is probably running.`);
    process.exit(1);
  }
  throw err;
});

server.listen(DAEMON_PORT, DAEMON_HOST, async () => {
  writePidFile();
  console.log(`Herdr Agent Browser Hub Daemon listening on http://${DAEMON_HOST}:${DAEMON_PORT} (pid ${process.pid})`);
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
  removePidFile();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
