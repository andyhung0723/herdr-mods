// Services & Ports Collector Wrapper for Herdr
import { appHome, exec } from "herdr";

let CACHE = null;
let CACHE_TIME = 0;
const CACHE_TTL_MS = 2000;

function resolveScannerPath() {
  const h = appHome();
  return `${h}/mods/services-inspector/scanner.py`;
}

/**
 * Fetch ports and docker status from scanner.py
 */
export async function fetchServicesData({ mode = "all", force = false } = {}) {
  const now = Date.now();
  if (!force && CACHE && now - CACHE_TIME < CACHE_TTL_MS) {
    return CACHE;
  }

  const scriptPath = resolveScannerPath();
  try {
    const res = await exec("python3", [scriptPath, "--action", "scan", "--mode", mode]);
    if (res.code === 0 && res.stdout) {
      const data = JSON.parse(res.stdout);
      CACHE = data;
      CACHE_TIME = now;
      return data;
    } else {
      console.error("fetchServicesData exit code != 0:", res.stderr || res.stdout);
    }
  } catch (err) {
    console.error("fetchServicesData error:", err);
  }

  return CACHE || {
    timestamp: Date.now() / 1000,
    ports: [],
    docker: { installed: false, running: false, containers: [], error: "Scanner unavailable" },
  };
}

/**
 * Kill a process by PID
 */
export async function killProcess(pid, signal = 15) {
  const scriptPath = resolveScannerPath();
  try {
    const res = await exec("python3", [
      scriptPath,
      "--action",
      "kill-pid",
      "--pid",
      String(pid),
      "--signal",
      String(signal),
    ]);
    if (res.stdout) {
      const data = JSON.parse(res.stdout);
      // Invalidate cache so next scan is fresh
      CACHE_TIME = 0;
      return data;
    }
    return { ok: false, error: res.stderr || "Unknown kill failure" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Control a Docker container (start / stop / restart)
 */
export async function controlDocker(containerId, action) {
  const scriptPath = resolveScannerPath();
  try {
    const res = await exec("python3", [
      scriptPath,
      "--action",
      "docker-action",
      "--container",
      String(containerId),
      "--docker-action",
      String(action),
    ]);
    if (res.stdout) {
      const data = JSON.parse(res.stdout);
      CACHE_TIME = 0;
      return data;
    }
    return { ok: false, error: res.stderr || `Failed to ${action} container` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
