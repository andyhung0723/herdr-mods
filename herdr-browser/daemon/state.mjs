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
export const DAEMON_PID_PATH = path.join(STATE_DIR, "daemon.pid");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
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

// Keeps one previous generation (daemon.log.1) once the log passes 5 MiB.
export function openDaemonLog() {
  ensureStateDir();
  try {
    if (fs.statSync(DAEMON_LOG_PATH).size > LOG_ROTATE_BYTES) fs.renameSync(DAEMON_LOG_PATH, `${DAEMON_LOG_PATH}.1`);
  } catch {}
  return fs.openSync(DAEMON_LOG_PATH, "a", 0o600);
}

export function writePidFile() {
  ensureStateDir();
  fs.writeFileSync(DAEMON_PID_PATH, `${process.pid}\n`, { mode: 0o600 });
}

// Only removes the file if it still names this process (a newer daemon may own it).
export function removePidFile() {
  try {
    if (fs.readFileSync(DAEMON_PID_PATH, "utf8").trim() === String(process.pid)) fs.rmSync(DAEMON_PID_PATH);
  } catch {}
}
