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

export function formatTimeRemaining(isoDateString) {
  if (!isoDateString) return null;
  const target = new Date(isoDateString).getTime();
  const now = Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return "Resets soon";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
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
  let content = await readTextFile(`${h}/.claude-work/.claude.json`);
  if (!content) {
    content = await readTextFile(`${h}/.claude/.claude.json`);
  }
  if (!content) {
    return { name: "Claude Code", available: false, error: "Config not found" };
  }

  try {
    const data = JSON.parse(content);
    const u = data.cachedUsageUtilization?.utilization ?? {};
    const oauth = data.oauthAccount ?? {};

    const fiveHour = Math.round(u.five_hour?.utilization ?? 0);
    const fiveHourResetsAt = u.five_hour?.resets_at ?? null;

    const sevenDay = Math.round(u.seven_day?.utilization ?? 0);
    const sevenDayResetsAt = u.seven_day?.resets_at ?? null;

    const extra = u.extra_usage ?? {};
    const hasCredit = Boolean(extra.is_enabled);
    const creditUsed = extra.used_credits ? (extra.used_credits / 100).toFixed(2) : "0.00";
    const creditLimit = extra.monthly_limit ? (extra.monthly_limit / 100).toFixed(2) : "0.00";
    const creditPercent = Math.round(extra.utilization ?? 0);

    return {
      name: "Claude Code",
      available: true,
      tier: oauth.seatTier ?? "Pro/Team",
      org: oauth.organizationName ?? "Personal",
      email: oauth.emailAddress ?? "",
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

  return {
    name: "Codex",
    available: true,
    plan: plan,
    model: model,
    hasFiveHour: false,
    hasWeek: false,
    hasCredit: false,
    tokensToday: tokensToday,
    formattedTokens: formatTokenCount(tokensToday),
    turnsToday: turnsToday,
  };
}

export async function collectAllQuotas() {
  const [claude, codex] = await Promise.all([
    collectClaudeData(),
    collectCodexData(),
  ]);
  return {
    claude,
    codex,
    updatedAt: new Date(),
  };
}
