// Store, HTTP request builder, cURL parser, security redaction, and Agent dispatcher for Herdr API Client.
import {
  agents,
  appHome,
  exec,
  focused,
  hc,
  home,
  panes,
  readTextFile,
  setShared,
  spaces,
  writeTextFile,
} from "herdr";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const AUTH_TYPES = ["none", "bearer", "basic", "apikey"];
export const GLOBAL_PROJECT = "__global__";
export const SHARED_STORE_VERSION_KEY = "api-client.store-version";
const LOCAL_STORAGE_KEY = "herdr.api-client.store.v1";
const MAX_HISTORY_ITEMS = 40;

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|apikey|api_key|auth|cookie|credential)/i;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64Utf8(input) {
  const str = String(input ?? "");
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    out += has1 ? B64_ALPHABET[(n >> 6) & 63] : "=";
    out += has2 ? B64_ALPHABET[n & 63] : "=";
  }
  return out;
}

export function uid(prefix = "api") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function isSensitiveKey(key) {
  const k = String(key ?? "").trim().toLowerCase();
  return SENSITIVE_HEADER_KEYS.has(k) || SENSITIVE_KEY_PATTERN.test(k);
}

export function createEmptyRequest(project = GLOBAL_PROJECT, projectName = "Global") {
  return {
    id: uid("req"),
    name: "Untitled Request",
    method: "GET",
    url: "",
    params: [{ id: uid("p"), key: "", value: "", enabled: true }],
    headers: [{ id: uid("h"), key: "", value: "", enabled: true }],
    auth: {
      type: "none",
      token: "",
      username: "",
      password: "",
      apiKeyName: "X-API-Key",
      apiKeyValue: "",
      apiKeyIn: "header",
    },
    body: "",
    verifySsl: true,
    timeoutSec: 15,
    project,
    projectName,
    updatedAt: Date.now(),
  };
}

export function envListToMap(envVars) {
  if (!envVars) return {};
  if (!Array.isArray(envVars)) return { ...envVars };
  const map = {};
  for (const row of envVars) {
    if (!row || row.enabled === false) continue;
    const k = String(row.key ?? "").trim();
    if (k) map[k] = String(row.value ?? "");
  }
  return map;
}

export function interpolateEnv(str, envVars) {
  if (typeof str !== "string" || !str.includes("{{")) return str ?? "";
  const map = envListToMap(envVars);
  return str.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : match
  );
}

export function appendQueryParams(rawUrl, extraParams) {
  const urlStr = String(rawUrl ?? "").trim();
  if (!urlStr || !Array.isArray(extraParams) || extraParams.length === 0) return urlStr;

  const hashIdx = urlStr.indexOf("#");
  const base = hashIdx >= 0 ? urlStr.slice(0, hashIdx) : urlStr;
  const hash = hashIdx >= 0 ? urlStr.slice(hashIdx) : "";

  const encoded = extraParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!encoded) return urlStr;

  const sep = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return `${base}${sep}${encoded}${hash}`;
}

export function buildFinalRequest(req, envVars) {
  const method = METHODS.includes(String(req?.method || "GET").toUpperCase())
    ? String(req.method).toUpperCase()
    : "GET";

  const interpolatedUrl = interpolateEnv(String(req?.url ?? ""), envVars).trim();
  const queryPairs = [];
  for (const p of req?.params ?? []) {
    if (!p || p.enabled === false) continue;
    const k = interpolateEnv(String(p.key ?? ""), envVars).trim();
    if (!k) continue;
    const v = interpolateEnv(String(p.value ?? ""), envVars);
    queryPairs.push([k, v]);
  }

  const headers = {};
  const headerNamesLower = new Set();
  for (const h of req?.headers ?? []) {
    if (!h || h.enabled === false) continue;
    const k = interpolateEnv(String(h.key ?? ""), envVars).trim();
    if (!k) continue;
    const v = interpolateEnv(String(h.value ?? ""), envVars);
    headers[k] = v;
    headerNamesLower.add(k.toLowerCase());
  }

  const auth = req?.auth || { type: "none" };
  if (auth.type === "bearer" && !headerNamesLower.has("authorization")) {
    const token = interpolateEnv(String(auth.token ?? ""), envVars).trim();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } else if (auth.type === "basic" && !headerNamesLower.has("authorization")) {
    const user = interpolateEnv(String(auth.username ?? ""), envVars);
    const pass = interpolateEnv(String(auth.password ?? ""), envVars);
    if (user || pass) {
      headers["Authorization"] = `Basic ${encodeBase64Utf8(`${user}:${pass}`)}`;
    }
  } else if (auth.type === "apikey") {
    const keyName = interpolateEnv(String(auth.apiKeyName ?? "X-API-Key"), envVars).trim();
    const keyVal = interpolateEnv(String(auth.apiKeyValue ?? ""), envVars);
    if (keyName && keyVal) {
      if (auth.apiKeyIn === "query") {
        queryPairs.push([keyName, keyVal]);
      } else if (!headerNamesLower.has(keyName.toLowerCase())) {
        headers[keyName] = keyVal;
      }
    }
  }

  const finalUrl = appendQueryParams(interpolatedUrl, queryPairs);
  const body = method === "GET" || method === "HEAD" ? "" : interpolateEnv(String(req?.body ?? ""), envVars);

  if (body.trim() && !headerNamesLower.has("content-type")) {
    const trimmed = body.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      headers["Content-Type"] = "application/json";
    }
  }

  return {
    method,
    url: finalUrl,
    headers,
    body,
    timeoutSec: typeof req?.timeoutSec === "number" ? req.timeoutSec : 15,
    verifySsl: req?.verifySsl !== false,
  };
}

export function redactHeaderValue(key, value) {
  const raw = String(value ?? "");
  if (!isSensitiveKey(key)) return raw;
  const bearerMatch = raw.match(/^(Bearer|Basic|Token)\s+.+$/i);
  if (bearerMatch) return `${bearerMatch[1]} [REDACTED]`;
  return "[REDACTED]";
}

export function redactUrlForDisplay(rawUrl) {
  const urlStr = String(rawUrl ?? "");
  const qIdx = urlStr.indexOf("?");
  if (qIdx < 0) return urlStr;
  const hashIdx = urlStr.indexOf("#", qIdx);
  const base = urlStr.slice(0, qIdx);
  const query = hashIdx >= 0 ? urlStr.slice(qIdx + 1, hashIdx) : urlStr.slice(qIdx + 1);
  const hash = hashIdx >= 0 ? urlStr.slice(hashIdx) : "";
  const masked = query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part;
      const k = decodeURIComponent(part.slice(0, eq));
      return isSensitiveKey(k) ? `${part.slice(0, eq)}=[REDACTED]` : part;
    })
    .join("&");
  return `${base}?${masked}${hash}`;
}

export function redactResponseHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = redactHeaderValue(k, v);
  }
  return out;
}

export function redactRequestForLog(req) {
  if (!req || typeof req !== "object") return req;
  const headersOut = Array.isArray(req.headers)
    ? req.headers.map((h) => ({
        ...h,
        value: isSensitiveKey(h?.key) ? redactHeaderValue(h.key, h.value) : h?.value,
      }))
    : redactResponseHeaders(req.headers);

  const authOut = req.auth
    ? {
        ...req.auth,
        token: req.auth.token ? "[REDACTED]" : "",
        password: req.auth.password ? "[REDACTED]" : "",
        apiKeyValue: req.auth.apiKeyValue ? "[REDACTED]" : "",
      }
    : undefined;

  return {
    ...req,
    url: redactUrlForDisplay(req.url),
    headers: headersOut,
    ...(authOut ? { auth: authOut } : {}),
  };
}

function shellTokenize(input) {
  const cleaned = String(input ?? "").replace(/\\\r?\n/g, " ");
  const tokens = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      hasToken = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\") escaped = true;
      else cur += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\") {
      escaped = true;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

export function parseCurlCommand(curlStr) {
  const tokens = shellTokenize(curlStr);
  if (tokens.length === 0) throw new Error("Empty cURL command");

  let start = 0;
  if (tokens[0].toLowerCase() === "curl") start = 1;

  let method = "";
  let url = "";
  const headers = [];
  const dataParts = [];
  let basicUser = null;

  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-X" || tok === "--request") {
      method = String(tokens[++i] || "").toUpperCase();
    } else if (tok.startsWith("-X") && tok.length > 2) {
      method = tok.slice(2).toUpperCase();
    } else if (tok === "-H" || tok === "--header") {
      const rawH = tokens[++i] || "";
      const colon = rawH.indexOf(":");
      if (colon > 0) {
        headers.push({
          id: uid("h"),
          key: rawH.slice(0, colon).trim(),
          value: rawH.slice(colon + 1).trim(),
          enabled: true,
        });
      }
    } else if (
      tok === "-d" ||
      tok === "--data" ||
      tok === "--data-raw" ||
      tok === "--data-binary" ||
      tok === "--data-urlencode"
    ) {
      dataParts.push(tokens[++i] ?? "");
    } else if (tok === "-u" || tok === "--user") {
      basicUser = tokens[++i] ?? "";
    } else if (tok === "--url") {
      url = tokens[++i] ?? "";
    } else if (tok === "-k" || tok === "--insecure" || tok === "-L" || tok === "--location" || tok === "-i" || tok === "--include" || tok === "-s" || tok === "--silent") {
      // recognized boolean flags without arg
    } else if (!tok.startsWith("-") && !url) {
      url = tok;
    }
  }

  if (!url) throw new Error("No URL found in cURL command");

  let auth = {
    type: "none",
    token: "",
    username: "",
    password: "",
    apiKeyName: "X-API-Key",
    apiKeyValue: "",
    apiKeyIn: "header",
  };

  if (basicUser !== null) {
    const sep = basicUser.indexOf(":");
    auth.type = "basic";
    auth.username = sep >= 0 ? basicUser.slice(0, sep) : basicUser;
    auth.password = sep >= 0 ? basicUser.slice(sep + 1) : "";
  }

  const remainingHeaders = [];
  for (const h of headers) {
    if (h.key.toLowerCase() === "authorization" && /^Bearer\s+/i.test(h.value) && auth.type === "none") {
      auth.type = "bearer";
      auth.token = h.value.replace(/^Bearer\s+/i, "").trim();
    } else {
      remainingHeaders.push(h);
    }
  }

  const body = dataParts.join("&");
  const finalMethod = METHODS.includes(method)
    ? method
    : dataParts.length > 0
    ? "POST"
    : "GET";

  // Extract query string into params if present
  let cleanUrl = url;
  const params = [];
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    const hashIdx = url.indexOf("#", qIdx);
    const query = hashIdx >= 0 ? url.slice(qIdx + 1, hashIdx) : url.slice(qIdx + 1);
    const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
    cleanUrl = url.slice(0, qIdx) + hash;
    for (const part of query.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      try {
        const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
        const v = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : "");
        params.push({ id: uid("p"), key: k, value: v, enabled: true });
      } catch {
        params.push({
          id: uid("p"),
          key: eq >= 0 ? part.slice(0, eq) : part,
          value: eq >= 0 ? part.slice(eq + 1) : "",
          enabled: true,
        });
      }
    }
  }

  return {
    method: finalMethod,
    url: cleanUrl,
    params: params.length ? params : [{ id: uid("p"), key: "", value: "", enabled: true }],
    headers: remainingHeaders.length ? remainingHeaders : [{ id: uid("h"), key: "", value: "", enabled: true }],
    auth,
    body,
  };
}

function quoteSh(str) {
  return `'${String(str ?? "").replace(/'/g, "'\\''")}'`;
}

export function buildCurlCommand(req, envVars, { redact = false } = {}) {
  const finalReq = buildFinalRequest(req, envVars);
  const safeReq = redact ? redactRequestForLog(finalReq) : finalReq;
  const parts = ["curl", "-X", safeReq.method];
  for (const [k, v] of Object.entries(safeReq.headers || {})) {
    parts.push("-H", quoteSh(`${k}: ${v}`));
  }
  if (safeReq.body) {
    parts.push("--data-raw", quoteSh(safeReq.body));
  }
  parts.push(quoteSh(safeReq.url || ""));
  return parts.join(" ");
}

export function buildAgentDebugPrompt(req, res, envVars) {
  const finalReq = buildFinalRequest(req, envVars);
  const safeReq = redactRequestForLog(finalReq);
  const safeRespHeaders = redactResponseHeaders(res?.headers);

  const lines = [
    "Please inspect and debug the following HTTP API call (sensitive credentials redacted):",
    "",
    `- **Request**: \`${safeReq.method} ${safeReq.url}\``,
  ];

  const reqHeaderEntries = Object.entries(safeReq.headers || {});
  if (reqHeaderEntries.length > 0) {
    lines.push("- **Request Headers**:");
    for (const [k, v] of reqHeaderEntries) {
      lines.push(`  - \`${k}: ${v}\``);
    }
  }

  if (safeReq.body) {
    lines.push("", "### Request Body", "```json", safeReq.body, "```");
  }

  if (res) {
    lines.push(
      "",
      `- **Response Status**: \`${res.status} ${res.statusText || ""}\` (${res.elapsedMs ?? 0} ms, ${res.sizeBytes ?? 0} bytes)`
    );
    if (res.error) {
      lines.push(`- **Error**: ${res.error}`);
    }
    const respHeaderEntries = Object.entries(safeRespHeaders);
    if (respHeaderEntries.length > 0) {
      lines.push("- **Response Headers**:");
      for (const [k, v] of respHeaderEntries.slice(0, 15)) {
        lines.push(`  - \`${k}: ${v}\``);
      }
    }
    if (res.body) {
      const preview = res.body.length > 6000 ? `${res.body.slice(0, 6000)}\n... [truncated]` : res.body;
      lines.push("", "### Response Body", res.isJson ? "```json" : "```text", preview, "```");
    }
  }

  return lines.join("\n");
}

function getStorePath() {
  const appH = typeof appHome === "function" ? appHome() : `${home()}/.config/herdr-app`;
  return `${appH}/api-client.json`;
}

function defaultStore() {
  return {
    version: 1,
    savedRequests: [],
    history: [],
    environments: [
      { id: "env_local", name: "Local", vars: [{ id: uid("v"), key: "baseUrl", value: "http://localhost:3000", enabled: true }] },
      { id: "env_staging", name: "Staging", vars: [{ id: uid("v"), key: "baseUrl", value: "", enabled: true }] },
    ],
    activeEnvId: "env_local",
    preferredAgentCli: "claude",
  };
}

function parseStoreJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const def = defaultStore();
    return {
      version: 1,
      savedRequests: Array.isArray(parsed.savedRequests) ? parsed.savedRequests : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY_ITEMS) : [],
      environments:
        Array.isArray(parsed.environments) && parsed.environments.length > 0
          ? parsed.environments
          : def.environments,
      activeEnvId: typeof parsed.activeEnvId === "string" ? parsed.activeEnvId : def.activeEnvId,
      preferredAgentCli: parsed.preferredAgentCli || "claude",
    };
  } catch {
    return null;
  }
}

export async function loadStore() {
  const path = getStorePath();
  let raw = null;
  try {
    raw = await readTextFile(path);
  } catch {
    raw = null;
  }

  let parsed = parseStoreJson(raw);
  if (!parsed && typeof localStorage !== "undefined") {
    try {
      parsed = parseStoreJson(localStorage.getItem(LOCAL_STORAGE_KEY));
    } catch {}
  }

  const def = defaultStore();
  return {
    ...def,
    ...(parsed ?? {}),
    lastExpectedRaw: typeof raw === "string" ? raw : null,
  };
}

export async function saveStore(state) {
  const def = defaultStore();
  const payload = {
    version: 1,
    savedRequests: Array.isArray(state?.savedRequests) ? state.savedRequests : [],
    history: Array.isArray(state?.history) ? state.history.slice(0, MAX_HISTORY_ITEMS) : [],
    environments:
      Array.isArray(state?.environments) && state.environments.length > 0
        ? state.environments
        : def.environments,
    activeEnvId: state?.activeEnvId || def.activeEnvId,
    preferredAgentCli: state?.preferredAgentCli || "claude",
  };

  const serialized = JSON.stringify(payload, null, 2) + "\n";

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
    } catch {}
  }

  const filePath = getStorePath();
  let expected = state?.lastExpectedRaw ?? null;
  try {
    await writeTextFile(filePath, serialized, expected);
  } catch {
    try {
      const fresh = await readTextFile(filePath);
      await writeTextFile(filePath, serialized, typeof fresh === "string" ? fresh : null);
    } catch {}
  }

  // Enforce strict owner-only permissions on credential-containing collection file.
  if (typeof exec === "function") {
    exec("chmod", ["600", filePath]).catch(() => null);
  }

  try {
    setShared(SHARED_STORE_VERSION_KEY, Date.now());
  } catch {}

  return serialized;
}

export async function executeHttpRequest(req, envVars) {
  const finalSpec = buildFinalRequest(req, envVars);
  if (!finalSpec.url) {
    return {
      ok: false,
      status: 0,
      statusText: "Invalid URL",
      elapsedMs: 0,
      sizeBytes: 0,
      headers: {},
      body: "",
      isJson: false,
      truncated: false,
      error: "Please enter a request URL",
    };
  }

  const h = typeof home === "function" ? home() : "";
  const appH = typeof appHome === "function" ? appHome() : `${h}/.config/herdr-app`;
  const candidates = [
    `${appH}/mods/api-client/runner.py`,
  ];

  let runnerPath = candidates[0];
  for (const cand of candidates) {
    const exists = await readTextFile(cand).catch(() => null);
    if (exists) {
      runnerPath = cand;
      break;
    }
  }

  if (typeof exec !== "function") {
    return {
      ok: false,
      status: 0,
      statusText: "Unavailable",
      elapsedMs: 0,
      sizeBytes: 0,
      headers: {},
      body: "",
      isJson: false,
      truncated: false,
      error: "exec() unavailable in this environment",
    };
  }

  try {
    const res = await exec("python3", [runnerPath, "--payload", JSON.stringify(finalSpec)], {
      timeout: Math.max(20_000, ((finalSpec.timeoutSec || 15) + 5) * 1000),
    });
    if (res?.code !== 0 || !res?.stdout?.trim()) {
      return {
        ok: false,
        status: 0,
        statusText: "Runner Error",
        elapsedMs: 0,
        sizeBytes: 0,
        headers: {},
        body: "",
        isJson: false,
        truncated: false,
        error: res?.stderr?.trim() || "HTTP runner failed",
      };
    }
    return JSON.parse(res.stdout.trim());
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: "Runner Exception",
      elapsedMs: 0,
      sizeBytes: 0,
      headers: {},
      body: "",
      isJson: false,
      truncated: false,
      error: String(err?.message || err),
    };
  }
}

export function resolveActiveProject() {
  const f = typeof focused === "function" ? focused() : null;
  const allPanes = typeof panes === "function" ? panes() : [];
  const activeSpace = (typeof spaces === "function" ? spaces() : []).find((s) => s.active);

  const focusedPane =
    allPanes.find((p) => f?.pane && p.pane === f.pane) ||
    allPanes.find((p) => p.focused) ||
    null;

  const cwd = f?.cwd || focusedPane?.cwd || activeSpace?.folder || null;
  if (!cwd) {
    return { path: GLOBAL_PROJECT, name: "Global", isGlobal: true };
  }
  const clean = String(cwd).replace(/\/+$/, "");
  const name = activeSpace?.name || clean.split("/").filter(Boolean).pop() || clean;
  return { path: clean, name, isGlobal: false };
}

function cleanAgentTitle(title) {
  if (!title) return "";
  return String(title).replace(/^[^\p{L}\p{N}./~_-]+/u, "").trim();
}

function isUsefulTitle(title, programName) {
  if (!title) return false;
  const c = cleanAgentTitle(title);
  if (!c) return false;
  if (programName && c.toLowerCase() === String(programName).toLowerCase()) return false;
  return !/^\d+$/.test(c);
}

export function resolveAvailableAgents(preferredAddress = null) {
  const f = typeof focused === "function" ? focused() : null;
  const allAgents = typeof agents === "function" ? agents() : [];
  const allSpaces = typeof spaces === "function" ? spaces() : [];
  const allPanes = typeof panes === "function" ? panes() : [];

  const tabMap = new Map();
  for (const s of allSpaces) {
    for (const t of s.tabs ?? []) {
      tabMap.set(t.id, t);
    }
  }

  const candidates = [];
  for (const a of allAgents) {
    const tab = tabMap.get(a.tab);
    const pane = allPanes.find((p) => p.pane === a.pane || p.terminal === a.address);
    const title = pane?.title || a.title || "";
    let rowName = tab?.name || "";
    if (!tab?.named || /^\d+$/.test(rowName)) {
      rowName = isUsefulTitle(title, a.program?.name) ? cleanAgentTitle(title) : a.program?.name || a.app || "Agent";
    }
    const baseLabel = a.space_name ? `${a.space_name} · ${rowName}` : rowName;
    candidates.push({
      address: a.address,
      space: a.space,
      tab: a.tab,
      tabIndex: a.tab_index,
      baseLabel,
      label: `${baseLabel} (${a.status || "idle"})`,
      shortLabel: baseLabel,
      status: a.status,
      isFocused: Boolean(a.focused || (f?.terminal && a.address === f.terminal)),
    });
  }

  const counts = new Map();
  for (const c of candidates) counts.set(c.baseLabel, (counts.get(c.baseLabel) || 0) + 1);
  candidates.forEach((c, idx) => {
    if ((counts.get(c.baseLabel) || 0) > 1) {
      c.shortLabel = `${c.baseLabel} #${c.tabIndex || idx + 1}`;
      c.label = `${c.shortLabel} (${c.status || "idle"})`;
    }
    delete c.baseLabel;
    delete c.tabIndex;
  });

  let selected = preferredAddress ? candidates.find((c) => c.address === preferredAddress) || null : null;
  if (!selected) {
    selected =
      candidates.find((c) => c.isFocused) ||
      candidates.find((c) => f?.tab && c.tab === f.tab) ||
      candidates.find((c) => f?.space && c.space === f.space) ||
      candidates[0] ||
      null;
  }

  return { candidates, selected };
}

export async function sendDebugToAgent(req, res, envVars, { agentAddress } = {}) {
  const prompt = buildAgentDebugPrompt(req, res, envVars);
  if (!prompt) return { ok: false, error: "Empty prompt" };
  if (!agentAddress) return { ok: false, error: "No active Agent terminal found" };
  if (typeof hc !== "function") return { ok: false, error: "hc() unavailable" };

  try {
    const out = await hc(["send", agentAddress, prompt]);
    return {
      ok: out?.code === 0,
      error: out?.code === 0 ? null : out?.stderr || `hc send failed (${out?.code})`,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function copyTextToClipboard(text, cx = null) {
  if (!text) return { ok: false, error: "Empty text" };
  try {
    if (typeof cx?.write_to_clipboard === "function") {
      cx.write_to_clipboard(text);
      return { ok: true, error: null };
    }
    if (typeof exec === "function") {
      const res = await exec("python3", [
        "-c",
        "import os, subprocess, sys; env = {**os.environ, 'LC_ALL': 'en_US.UTF-8', 'LANG': 'en_US.UTF-8', '__CF_USER_TEXT_ENCODING': '0x1F5:0x8000100:0x8000100'}; subprocess.run(['pbcopy'], input=sys.argv[1].encode('utf-8'), env=env, check=True)",
        text,
      ]);
      return { ok: res.code === 0, error: res.code === 0 ? null : res.stderr || "pbcopy failed" };
    }
    return { ok: false, error: "Clipboard unavailable" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
