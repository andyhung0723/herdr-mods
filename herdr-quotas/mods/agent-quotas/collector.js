// Agent Quota Collector for Claude Code and Codex
import { home, readTextFile, exec } from "herdr";

function decodeBase64(str) {
  try {
    if (typeof atob === "function") return atob(str);
    if (typeof Buffer !== "undefined") return Buffer.from(str, "base64").toString("utf-8");
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    let output = "";
    let clean = String(str).replace(/=+$/, "");
    for (let bc = 0, bs, buffer, idx = 0; buffer = clean.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
      buffer = chars.indexOf(buffer);
    }
    return output;
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  try {
    const parts = (token || "").split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = decodeBase64(b64);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

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

export async function collectClaudeData() {
  const h = home();
  const candidates = [
    `${h}/.claude-work/.claude.json`,
    `${h}/.claude.json`,
    `${h}/.claude/.claude.json`,
  ];

  let bestData = null;
  let bestFetchedAt = -1;

  for (const path of candidates) {
    try {
      let raw = await readTextFile(path).catch(() => null);
      if (!raw && typeof exec === "function") {
        try {
          const res = await exec("cat", [path]).catch(() => null);
          if (res?.code === 0 && res?.stdout) raw = res.stdout;
        } catch {}
      }
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const fetchedAt = parsed.cachedUsageUtilization?.fetchedAtMs ?? 0;
      if (parsed.cachedUsageUtilization?.utilization) {
        if (!bestData || fetchedAt > bestFetchedAt) {
          bestData = parsed;
          bestFetchedAt = fetchedAt;
        }
      }
    } catch {}
  }

  if (!bestData) {
    return { name: "Claude Code", available: false, error: "Config not found" };
  }

  try {
    const data = bestData;
    const u = data.cachedUsageUtilization?.utilization ?? {};
    const oauth = data.oauthAccount ?? {};

    const fiveHour = Math.round(u.five_hour?.utilization ?? 0);
    const fiveHourResetsAt = u.five_hour?.resets_at ?? null;

    const sevenDay = Math.round(u.seven_day?.utilization ?? 0);
    const sevenDayResetsAt = u.seven_day?.resets_at ?? null;

    const extra = u.extra_usage ?? {};
    const spend = u.spend ?? {};

    const usedCents = extra.used_credits ?? spend.used?.amount_minor ?? 0;
    const limitCents = extra.monthly_limit ?? spend.limit?.amount_minor ?? 0;
    const hasCredit = Boolean(extra.is_enabled || spend.enabled || usedCents > 0);

    const creditUsed = (usedCents / 100).toFixed(2);
    const creditLimit = (limitCents / 100).toFixed(2);
    const creditPercent = Math.round(
      extra.utilization ??
      spend.percent ??
      (limitCents > 0 ? (usedCents / limitCents) * 100 : 0)
    );

    return {
      name: "Claude Code",
      available: true,
      tier: oauth.seatTier ?? "Pro/Team",
      org: oauth.organizationName ?? "Personal",
      email: oauth.emailAddress ?? "",
      fetchedAtMs: bestFetchedAt > 0 ? bestFetchedAt : null,
      hasFiveHour: true,
      fiveHour: {
        percent: fiveHour,
        resetsAt: fiveHourResetsAt,
        timeRemaining: formatTimeRemaining(fiveHourResetsAt),
      },
      hasWeek: true,
      week: {
        percent: sevenDay,
        resetsAt: sevenDayResetsAt,
        timeRemaining: formatTimeRemaining(sevenDayResetsAt),
      },
      hasCredit: hasCredit,
      credit: {
        used: `$${creditUsed}`,
        limit: `$${creditLimit}`,
        percent: creditPercent,
        rawUsed: usedCents / 100,
        rawLimit: limitCents / 100,
      },
      primaryPercent: hasCredit ? creditPercent : sevenDay,
    };
  } catch (err) {
    return { name: "Claude Code", available: false, error: String(err) };
  }
}

export async function collectCodexData() {
  const h = home();
  const authContent = await readTextFile(`${h}/.codex/auth.json`);
  if (!authContent) {
    return { name: "Codex", available: false, error: "Auth not found" };
  }

  let plan = "PROLITE";
  try {
    const auth = JSON.parse(authContent);
    const jwt = decodeJwt(auth.tokens?.access_token);
    const authClaims = jwt?.["https://api.openai.com/auth"];
    if (authClaims?.chatgpt_plan_type) {
      plan = authClaims.chatgpt_plan_type.toUpperCase();
    }
  } catch {}

  let model = "GPT-5";
  try {
    const cfg = await readTextFile(`${h}/.codex/config.toml`);
    if (cfg) {
      const match = cfg.match(/model\s*=\s*["']([^"']+)["']/);
      if (match) model = match[1];
    }
  } catch {}

  let tokensToday = 0;
  let turnsToday = 0;
  try {
    const dbPath = `${h}/.codex/state_5.sqlite`;
    const res = await exec("sqlite3", [
      "-csv",
      "-noheader",
      dbPath,
      "SELECT COALESCE(SUM(tokens_used), 0), COUNT(id) FROM threads WHERE updated_at >= unixepoch('now', 'start of day');",
    ]);
    if (res.code === 0 && res.stdout) {
      const parts = res.stdout.trim().split(",");
      if (parts.length >= 2) {
        tokensToday = Number(parts[0]) || 0;
        turnsToday = Number(parts[1]) || 0;
      }
    }
  } catch {}

  // Fetch real-time rate limits (7-day window & reset credits)
  let weekPercent = 0;
  let weekResetsAt = null;
  let hasWeek = false;
  let resetCredits = 0;

  try {
    let scriptPath = `${h}/.config/herdr-app/mods/agent-quotas/codex_limits.py`;
    const exists = await readTextFile(scriptPath);
    if (!exists) {
      scriptPath = `${h}/Workspace/side-project/herdr-customized/herdr-quotas/mods/agent-quotas/codex_limits.py`;
    }
    const res = await exec("python3", [scriptPath]);
    if (res.code === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed.usedPercent === "number") {
        hasWeek = true;
        weekPercent = Math.round(parsed.usedPercent);
        weekResetsAt = parsed.resetsAt;
        resetCredits = parsed.resetCredits || 0;
      }
    }
  } catch {}

  return {
    name: "Codex",
    available: true,
    plan: plan,
    model: model,
    hasFiveHour: false,
    hasWeek: hasWeek,
    week: {
      percent: weekPercent,
      resetsAt: weekResetsAt,
      timeRemaining: formatTimeRemaining(weekResetsAt),
    },
    resetCredits: resetCredits,
    hasCredit: false,
    tokensToday: tokensToday,
    formattedTokens: formatTokenCount(tokensToday),
    turnsToday: turnsToday,
    primaryPercent: hasWeek ? weekPercent : 0,
  };
}

export async function collectAntigravityData() {
  const h = home();
  let model = "Gemini 3.8 Flash";
  try {
    const raw = await readTextFile(`${h}/.gemini/antigravity-cli/settings.json`);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.model) model = cfg.model;
    }
  } catch {}

  let stepsToday = 0;
  let sessionsToday = 0;
  try {
    const dbPath = `${h}/.gemini/antigravity-cli/conversation_summaries.db`;
    const res = await exec("sqlite3", [
      "-csv",
      "-noheader",
      dbPath,
      "SELECT COALESCE(SUM(step_count), 0), COUNT(conversation_id) FROM conversation_summaries WHERE date(last_modified_time) = date('now');",
    ]);
    if (res.code === 0 && res.stdout) {
      const parts = res.stdout.trim().split(",");
      if (parts.length >= 2) {
        stepsToday = Number(parts[0]) || 0;
        sessionsToday = Number(parts[1]) || 0;
      }
    }
  } catch {}

  let email = "";
  let tier = "Antigravity";
  let hasFiveHour = false;
  let fiveHour = { percent: 0, remainingPercent: 100, resetsAt: null, timeRemaining: null, modelId: "" };
  let hasWeek = false;
  let week = { percent: 0, remainingPercent: 100, resetsAt: null, timeRemaining: null, displayName: "Weekly Limit" };

  try {
    let scriptPath = `${h}/.config/herdr-app/mods/agent-quotas/antigravity_limits.py`;
    const exists = await readTextFile(scriptPath);
    if (!exists) {
      scriptPath = `${h}/Workspace/side-project/herdr-customized/herdr-quotas/mods/agent-quotas/antigravity_limits.py`;
    }
    const res = await exec("python3", [scriptPath]);
    if (res.code === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && !parsed.error) {
        if (parsed.email) email = parsed.email;
        if (parsed.tier) tier = parsed.tier;
        if (parsed.model) model = parsed.model;

        if (parsed.fiveHour && typeof parsed.fiveHour.percent === "number") {
          hasFiveHour = true;
          fiveHour = {
            percent: parsed.fiveHour.percent,
            remainingPercent: parsed.fiveHour.remainingPercent ?? (100 - parsed.fiveHour.percent),
            resetsAt: parsed.fiveHour.resetTime,
            timeRemaining: formatTimeRemaining(parsed.fiveHour.resetTime),
            modelId: parsed.fiveHour.modelId || "",
          };
        }

        if (parsed.weekly && typeof parsed.weekly.percent === "number") {
          hasWeek = true;
          week = {
            percent: parsed.weekly.percent,
            remainingPercent: parsed.weekly.remainingPercent ?? (100 - parsed.weekly.percent),
            resetsAt: parsed.weekly.resetTime,
            timeRemaining: formatTimeRemaining(parsed.weekly.resetTime),
            displayName: parsed.weekly.displayName || "Weekly Limit",
          };
        }
      }
    }
  } catch {}

  const primaryPercent = Math.max(
    hasFiveHour ? fiveHour.percent : 0,
    hasWeek ? week.percent : 0
  );

  return {
    name: "Antigravity",
    available: true,
    tier: tier,
    email: email,
    model: model,
    hasFiveHour: hasFiveHour,
    fiveHour: fiveHour,
    hasWeek: hasWeek,
    week: week,
    hasCredit: false,
    stepsToday: stepsToday,
    formattedSteps: formatTokenCount(stepsToday),
    sessionsToday: sessionsToday,
    primaryPercent: primaryPercent,
  };
}

export async function collectAllQuotas() {
  const [claude, codex, antigravity] = await Promise.all([
    collectClaudeData(),
    collectCodexData(),
    collectAntigravityData(),
  ]);
  return {
    claude,
    codex,
    antigravity,
    updatedAt: new Date(),
  };
}
