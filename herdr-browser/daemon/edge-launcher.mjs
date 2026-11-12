// Edge Browser Process Manager for Herdr Agent Browser Hub
import { spawn } from "node:child_process";
import fs from "node:fs";

const EDGE_PATHS = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
  "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const DEFAULT_PORT = 9222;
const PROFILE_DIR = "/tmp/herdr-browser-edge-profile";

let edgeProcess = null;

export function findBrowserExecutable() {
  for (const p of EDGE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function isPortOpen(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch {}
  return null;
}

export async function ensureEdgeRunning(port = DEFAULT_PORT) {
  // 1. Check if already running on the port
  const existing = await isPortOpen(port);
  if (existing) {
    return {
      port,
      wsEndpoint: existing.webSocketDebuggerUrl,
      browser: existing.Browser,
      isNew: false,
    };
  }

  // 2. Locate Edge executable
  const execPath = findBrowserExecutable();
  if (!execPath) {
    throw new Error("No Microsoft Edge (or Chrome) executable found in /Applications");
  }

  // Ensure clean profile dir
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // 3. Launch Edge in background
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
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

  edgeProcess = spawn(execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  edgeProcess.unref();

  // 4. Poll until CDP is available (up to 6 seconds)
  const startTime = Date.now();
  while (Date.now() - startTime < 6000) {
    await new Promise((r) => setTimeout(r, 200));
    const info = await isPortOpen(port);
    if (info) {
      return {
        port,
        wsEndpoint: info.webSocketDebuggerUrl,
        browser: info.Browser,
        isNew: true,
      };
    }
  }

  throw new Error(`Edge launched (PID ${edgeProcess?.pid}) but did not respond on port ${port} within 6s`);
}

export function stopEdge() {
  if (edgeProcess && !edgeProcess.killed) {
    try {
      edgeProcess.kill("SIGTERM");
    } catch {}
    edgeProcess = null;
  }
}
