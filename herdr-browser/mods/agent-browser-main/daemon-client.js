// Shared by agent-browser-main and agent-browser-sidebar (keep both copies identical).
//
// The mod runtime's fetch has no AbortSignal and no binary bodies: requests
// cannot be cancelled, so callers guard against piling up with `singleFlight`.
import { home, readTextFile, agents } from "herdr";

export const DAEMON_URL = "http://127.0.0.1:9223";
export const SHARED_ACTIVE_AGENT = "agent-browser.active-agent";
const TOKEN_PATH = `${home()}/.config/herdr-browser/token`;

let cachedToken = null;

async function loadToken() {
  cachedToken = (await readTextFile(TOKEN_PATH))?.trim() || null;
  return cachedToken;
}

// Token is re-read after a 401 so a regenerated token doesn't need a mod reload.
export async function daemonFetch(path, init = {}) {
  if (!cachedToken) await loadToken();
  const send = () =>
    fetch(`${DAEMON_URL}${path}`, {
      ...init,
      headers: { ...init.headers, ...(cachedToken && { Authorization: `Bearer ${cachedToken}` }) },
    });
  let res = await send();
  if (res.status === 401 && (await loadToken())) res = await send();
  return res;
}

export async function daemonJson(path, init) {
  const res = await daemonFetch(path, init);
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export function postAction(agentId, payload) {
  return daemonJson(`/action/${encodeURIComponent(agentId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, source: "human" }),
  });
}

// Skips a call while the previous one is still running.
export function singleFlight(fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      await fn(...args);
    } finally {
      running = false;
    }
  };
}

const VENDOR_COLORS = { claude: "#f97316", codex: "#06b6d4", antigravity: "#a855f7" };

export function vendorColor(session, t) {
  return VENDOR_COLORS[session?.vendor] ?? t.accent ?? "#89b4fa";
}

// "Claude · AI Media / 3" when the terminal is known to Herdr, else the raw id.
export function sessionLabel(session) {
  const vendor = session.vendor ? session.vendor[0].toUpperCase() + session.vendor.slice(1) : session.agentId;
  if (!session.terminal) return vendor;
  const agent = agents().find((a) => a.address.toLowerCase() === session.terminal);
  return agent ? `${vendor} · ${agent.space_name} / ${agent.tab_name}` : `${vendor} · ${session.terminal}`;
}
