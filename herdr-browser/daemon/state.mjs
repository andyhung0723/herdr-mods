// Shared on-disk state for the daemon and its clients (MCP server, Herdr mods)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = Number(process.env.HERDR_BROWSER_PORT) || 9223;
export const DAEMON_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

export const STATE_DIR = process.env.HERDR_BROWSER_STATE_DIR || path.join(os.homedir(), ".config", "herdr-browser");
export const TOKEN_PATH = path.join(STATE_DIR, "token");
export const DAEMON_LOG_PATH = path.join(STATE_DIR, "daemon.log");
export const EDGE_PROFILE_DIR = path.join(STATE_DIR, "edge-profile");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function loadOrCreateToken() {
  ensureStateDir();
  const existing = readToken();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  return token;
}

export function openDaemonLog() {
  ensureStateDir();
  return fs.openSync(DAEMON_LOG_PATH, "a", 0o600);
}
