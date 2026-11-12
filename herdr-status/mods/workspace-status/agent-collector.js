// Agent status collector for Claude Code, Codex, and Antigravity
import { home, readTextFile, exec, appHome } from "herdr";

let codexCache = { data: null, timestamp: 0 };
let agyCache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 30_000;

export function formatTimeRemaining(isoOrTimestamp) {
  if (!isoOrTimestamp) return null;
  const target =
    typeof isoOrTimestamp === "number"
      ? (isoOrTimestamp < 1e11 ? isoOrTimestamp * 1000 : isoOrTimestamp)
      : !isNaN(Number(isoOrTimestamp)) && String(isoOrTimestamp).length <= 10
      ? Number(isoOrTimestamp) * 1000
      : new Date(isoOrTimestamp).getTime();

  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return "Resets soon";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `in ${days}d ${remHours}h`;
  }
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

export function formatTokenCount(num) {
  if (!num || isNaN(num)) return "0";
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "k";
  return String(num);
}

export function formatEffort(effort) {
  if (!effort) return "";
  const s = String(effort).toLowerCase();
  if (s === "medium" || s === "med") return "med";
  if (s === "high") return "high";
  if (s === "low") return "low";
  return s.slice(0, 4);
}

export function formatShortModel(model) {
  if (!model) return "";
  const s = String(model);
  if (s.startsWith("claude-")) {
    return s.replace("claude-", "").replace(/-/g, " ");
  }
  return s;
}

export function formatCwd(cwd, userHome) {
  if (!cwd) return null;
  const h = userHome || "";
  if (h && (cwd === h || cwd === `${h}/`)) return "~";
  if (h && cwd.startsWith(h)) {
    const rel = cwd.slice(h.length).replace(/^\/+/, "");
    const parts = rel.split("/").filter(Boolean);
    return parts[parts.length - 1] || "~";
  }
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function detectActiveAgent({ focused, panes, agents }) {
  const f = typeof focused === "function" ? focused() : null;
  const allPanes = typeof panes === "function" ? panes() : [];
  const allAgents = typeof agents === "function" ? agents() : [];

  const currentPane = allPanes.find((p) => p.focused || (f && p.pane === f.pane));
  const currentAgent = allAgents.find(
    (a) => a.focused || (f && (a.pane === f.pane || a.address === f.agent))
  );

  const probe = [
    currentPane?.app,
    currentPane?.program?.name,
    currentPane?.program?.agent,
    currentPane?.title,
    currentAgent?.app,
    currentAgent?.program?.name,
    currentAgent?.title,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  for (const str of probe) {
    if (str.includes("claude")) return "claude";
    if (str.includes("codex")) return "codex";
    if (str.includes("antigravity") || str.includes("agy") || str.includes("gemini")) return "antigravity";
  }

  return null;
}

export async function getLiveClaudeStatus() {
  const h = home();
  let liveJson = null;

  // 1. Fast read from Claude Code statusline output (written live during sessions)
  try {
    const raw = await readTextFile("/tmp/claude-statusline-input.json").catch(() => null);
    if (raw) {
      liveJson = JSON.parse(raw);
    }
  } catch {}

  if (liveJson) {
    const modelDisplay = liveJson.model?.display_name || liveJson.model?.id || "Claude";
    const effortLevel = liveJson.effort?.level || "";
    const ctxPercent = liveJson.context_window?.used_percentage ?? null;
    const ctxTokens = liveJson.context_window?.total_input_tokens ?? 0;
    const rateLimits = liveJson.rate_limits || {};
    const fiveHourPercent = rateLimits.five_hour?.used_percentage ?? null;
    const sevenDayPercent = rateLimits.seven_day?.used_percentage ?? null;
    const fiveHourResetsAt = rateLimits.five_hour?.resets_at ?? null;
    const costUsd = liveJson.cost?.total_cost_usd;
    const formattedCost = typeof costUsd === "number" ? `$${costUsd.toFixed(2)}` : null;
    const agentCwd = liveJson.cwd || liveJson.workspace?.current_dir || null;

    return {
      id: "claude",
      name: "Claude Code",
      model: modelDisplay,
      effort: effortLevel,
      contextPercent: ctxPercent,
      contextTokens: ctxTokens,
      fiveHourPercent: fiveHourPercent,
      sevenDayPercent: sevenDayPercent,
      fiveHourResetsAt: fiveHourResetsAt,
      timeRemaining: formatTimeRemaining(fiveHourResetsAt),
      cost: formattedCost,
      cwd: agentCwd,
      source: "live-session",
      available: true,
    };
  }

  // 2. Fallback: read ~/.claude.json
  const candidates = [
    `${h}/.claude-work/.claude.json`,
    `${h}/.claude.json`,
    `${h}/.claude/.claude.json`,
  ];

  for (const path of candidates) {
    try {
      const raw = await readTextFile(path).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        const u = parsed.cachedUsageUtilization?.utilization ?? {};
        const fiveHour = typeof u.five_hour?.utilization === "number" ? Math.round(u.five_hour.utilization) : null;
        const sevenDay = typeof u.seven_day?.utilization === "number" ? Math.round(u.seven_day.utilization) : null;
        const fiveHourResetsAt = u.five_hour?.resets_at ?? null;

        return {
          id: "claude",
          name: "Claude Code",
          model: "Claude 3.7",
          effort: "",
          contextPercent: null,
          contextTokens: 0,
          fiveHourPercent: fiveHour,
          sevenDayPercent: sevenDay,
          fiveHourResetsAt: fiveHourResetsAt,
          timeRemaining: formatTimeRemaining(fiveHourResetsAt),
          cost: null,
          source: "cached-config",
          available: true,
        };
      }
    } catch {}
  }

  return {
    id: "claude",
    name: "Claude Code",
    model: "Claude",
    effort: "",
    contextPercent: null,
    fiveHourPercent: null,
    sevenDayPercent: null,
    cost: null,
    available: false,
  };
}

export async function getLiveCodexStatus() {
  const h = home();
  let model = "gpt-6.1-sol";
  let effort = "medium";

  // 1. Read config.toml for current model & reasoning effort
  try {
    const cfg = await readTextFile(`${h}/.codex/config.toml`).catch(() => null);
    if (cfg) {
      const mMatch = cfg.match(/model\s*=\s*["']([^"']+)["']/);
      if (mMatch) model = mMatch[1];
      const eMatch = cfg.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (eMatch) effort = eMatch[1];
    }
  } catch {}

  // 2. Rate limits with cache TTL
  const now = Date.now();
  if (codexCache.data && now - codexCache.timestamp < CACHE_TTL_MS) {
    return {
      ...codexCache.data,
      model,
      effort,
    };
  }

  let weekPercent = null;
  let resetsAt = null;
  let resetCredits = 0;

  try {
    const appH = typeof appHome === "function" ? appHome() : `${h}/.config/herdr-app`;
    const probeCandidates = [
      `${appH}/mods/workspace-status/codex_limits.py`,
      `${appH}/mods/agent-quotas/codex_limits.py`,
      `${h}/Workspace/side-project/herdr-mods/herdr-status/mods/workspace-status/codex_limits.py`,
    ];

    let probeScript = probeCandidates[0];
    for (const cand of probeCandidates) {
      const exists = await readTextFile(cand).catch(() => null);
      if (exists) {
        probeScript = cand;
        break;
      }
    }

    if (typeof exec === "function") {
      const res = await exec("python3", [probeScript]).catch(() => null);
      if (res?.code === 0 && res?.stdout?.trim()) {
        const parsed = JSON.parse(res.stdout.trim());
        if (typeof parsed?.usedPercent === "number") {
          weekPercent = Math.round(parsed.usedPercent);
          resetsAt = parsed.resetsAt;
          resetCredits = parsed.resetCredits || 0;
        }
      }
    }
  } catch {}

  let tokensToday = 0;
  try {
    if (typeof exec === "function") {
      const dbPath = `${h}/.codex/state_5.sqlite`;
      const res = await exec("sqlite3", [
        "-csv",
        "-noheader",
        dbPath,
        "SELECT COALESCE(SUM(tokens_used), 0) FROM threads WHERE updated_at >= unixepoch('now', 'start of day');",
      ]).catch(() => null);
      if (res?.code === 0 && res?.stdout) {
        tokensToday = Number(res.stdout.trim()) || 0;
      }
    }
  } catch {}

  const result = {
    id: "codex",
    name: "Codex",
    model,
    effort,
    weekPercent,
    tokensToday,
    formattedTokens: formatTokenCount(tokensToday),
    resetsAt,
    timeRemaining: formatTimeRemaining(resetsAt),
    resetCredits,
    available: true,
  };

  codexCache = { data: result, timestamp: now };
  return result;
}

export async function getLiveAntigravityStatus() {
  const h = home();
  let model = "Gemini 3.8 Flash";

  // 1. Read settings.json
  try {
    const raw = await readTextFile(`${h}/.gemini/antigravity-cli/settings.json`).catch(() => null);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.model) model = cfg.model;
    }
  } catch {}

  // 2. Limits with cache TTL
  const now = Date.now();
  if (agyCache.data && now - agyCache.timestamp < CACHE_TTL_MS) {
    return {
      ...agyCache.data,
      model,
    };
  }

  let fiveHour = null;
  let weekly = null;

  try {
    const appH = typeof appHome === "function" ? appHome() : `${h}/.config/herdr-app`;
    const probeCandidates = [
      `${appH}/mods/workspace-status/antigravity_limits.py`,
      `${appH}/mods/agent-quotas/antigravity_limits.py`,
      `${h}/Workspace/side-project/herdr-mods/herdr-status/mods/workspace-status/antigravity_limits.py`,
    ];

    let probeScript = probeCandidates[0];
    for (const cand of probeCandidates) {
      const exists = await readTextFile(cand).catch(() => null);
      if (exists) {
        probeScript = cand;
        break;
      }
    }

    if (typeof exec === "function") {
      const res = await exec("python3", [probeScript]).catch(() => null);
      if (res?.code === 0 && res?.stdout?.trim()) {
        const parsed = JSON.parse(res.stdout.trim());
        if (parsed?.model) model = parsed.model;
        if (parsed?.fiveHour && typeof parsed.fiveHour.percent === "number") {
          fiveHour = {
            percent: parsed.fiveHour.percent,
            remainingPercent: parsed.fiveHour.remainingPercent ?? (100 - parsed.fiveHour.percent),
            resetsAt: parsed.fiveHour.resetTime,
            timeRemaining: formatTimeRemaining(parsed.fiveHour.resetTime),
          };
        }
        if (parsed?.weekly && typeof parsed.weekly.percent === "number") {
          weekly = {
            percent: parsed.weekly.percent,
            remainingPercent: parsed.weekly.remainingPercent ?? (100 - parsed.weekly.percent),
            resetsAt: parsed.weekly.resetTime,
            timeRemaining: formatTimeRemaining(parsed.weekly.resetTime),
          };
        }
      }
    }
  } catch {}

  let stepsToday = 0;
  try {
    if (typeof exec === "function") {
      const dbPath = `${h}/.gemini/antigravity-cli/conversation_summaries.db`;
      const res = await exec("sqlite3", [
        "-csv",
        "-noheader",
        dbPath,
        "SELECT COALESCE(SUM(step_count), 0) FROM conversation_summaries WHERE date(last_modified_time) = date('now');",
      ]).catch(() => null);
      if (res?.code === 0 && res?.stdout) {
        stepsToday = Number(res.stdout.trim()) || 0;
      }
    }
  } catch {}

  const result = {
    id: "antigravity",
    name: "Antigravity",
    model,
    fiveHour,
    weekly,
    stepsToday,
    available: true,
  };

  agyCache = { data: result, timestamp: now };
  return result;
}

export async function collectAllAgentsStatus() {
  const [claude, codex, antigravity] = await Promise.all([
    getLiveClaudeStatus().catch(() => ({ id: "claude", available: false })),
    getLiveCodexStatus().catch(() => ({ id: "codex", available: false })),
    getLiveAntigravityStatus().catch(() => ({ id: "antigravity", available: false })),
  ]);

  return { claude, codex, antigravity };
}
