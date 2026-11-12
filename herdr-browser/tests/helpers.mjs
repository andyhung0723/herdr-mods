import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowserExecutable } from "../daemon/edge-launcher.mjs";

const DAEMON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../daemon");
export const SERVER_PATH = path.join(DAEMON_DIR, "server.mjs");
export const MCP_SERVER_PATH = path.join(DAEMON_DIR, "mcp-server.mjs");

// Browser-backed tests skip instead of failing on machines without Edge/Chrome.
export const NO_BROWSER = findBrowserExecutable() ? false : "no Edge/Chrome executable found";

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-state-"));
}

export function removeStateDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export function daemonEnv(port, stateDir) {
  return { ...process.env, HERDR_BROWSER_PORT: String(port), HERDR_BROWSER_STATE_DIR: stateDir };
}

export async function waitFor(check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

export async function isHealthy(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
  } catch {
    return false;
  }
}

export async function startDaemon() {
  const port = await freePort();
  const stateDir = tempStateDir();
  const proc = spawn(process.execPath, [SERVER_PATH], { env: daemonEnv(port, stateDir), stdio: "ignore" });
  await waitFor(() => isHealthy(port));
  const token = fs.readFileSync(path.join(stateDir, "token"), "utf8").trim();
  return { port, stateDir, token, proc };
}

export function processExited(proc) {
  return proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
