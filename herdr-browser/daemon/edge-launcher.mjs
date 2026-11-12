// Edge Browser Process Manager for Herdr Agent Browser Hub
//
// The browser listens on an OS-assigned debugging port (`--remote-debugging-port=0`)
// and reports it through `<profile>/DevToolsActivePort`. We never attach to a
// fixed well-known port, so a user's own Chrome/Edge with remote debugging
// enabled can never be mistaken for the hub's headless browser.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDGE_PROFILE_DIR } from "./state.mjs";

const BROWSER_PATHS = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
  "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const LAUNCH_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 150;

let edgeProcess = null;

export function findBrowserExecutable() {
  return BROWSER_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

function activePortFile(profileDir) {
  return path.join(profileDir, "DevToolsActivePort");
}

function readActivePort(profileDir) {
  try {
    const [portLine, browserPath] = fs.readFileSync(activePortFile(profileDir), "utf8").split("\n");
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || !browserPath?.startsWith("/devtools/browser/")) return null;
    return { port, browserPath: browserPath.trim() };
  } catch {
    return null;
  }
}

async function fetchVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// A DevToolsActivePort file only proves which browser *was* ours. Confirm the
// browser now on that port has the same browser target id before trusting it.
async function probeOwnedBrowser(profileDir) {
  const active = readActivePort(profileDir);
  if (!active) return null;
  const version = await fetchVersion(active.port);
  if (!version?.webSocketDebuggerUrl?.endsWith(active.browserPath)) return null;
  return { port: active.port, wsEndpoint: version.webSocketDebuggerUrl, browser: version.Browser };
}

export async function ensureEdgeRunning({ profileDir = EDGE_PROFILE_DIR } = {}) {
  const owned = await probeOwnedBrowser(profileDir);
  if (owned) return { ...owned, isNew: false };

  const execPath = findBrowserExecutable();
  if (!execPath) {
    throw new Error("No Microsoft Edge (or Chrome) executable found in /Applications");
  }

  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.rmSync(activePortFile(profileDir), { force: true });

  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--window-size=1280,800",
  ];

  const child = spawn(execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  edgeProcess = child;

  let exitedEarly = false;
  child.once("exit", () => {
    exitedEarly = true;
    if (edgeProcess === child) edgeProcess = null;
  });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline && !exitedEarly) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const ready = await probeOwnedBrowser(profileDir);
    if (ready) return { ...ready, isNew: true };
  }

  stopEdge();
  throw new Error(
    exitedEarly
      ? `Browser exited during startup (profile may be locked by another process: ${profileDir})`
      : `Browser did not report a DevTools port within ${LAUNCH_TIMEOUT_MS}ms`
  );
}

export function stopEdge() {
  if (edgeProcess && edgeProcess.exitCode === null) {
    try {
      edgeProcess.kill("SIGTERM");
    } catch {}
  }
  edgeProcess = null;
}
