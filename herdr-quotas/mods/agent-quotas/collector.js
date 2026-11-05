// Agent Quota Collector for Claude, Codex, and Antigravity
import { home, readTextFile, exec, agents } from "herdr";

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
    return { name: "Claude", available: false, error: "Config not found" };
  }

  try {
    const data = JSON.parse(content);
    const u = data.cachedUsageUtilization?.utilization ?? {};
    const oauth = data.oauthAccount ?? {};

    const fiveHour = Math.round(u.five_hour?.utilization ?? 0);
    const sevenDay = Math.round(u.seven_day?.utilization ?? 0);
    const sevenDayResetsAt = u.seven_day?.resets_at ?? null;

    const extra = u.extra_usage ?? {};
    const extraEnabled = Boolean(extra.is_enabled);
    const extraUsed = extra.used_credits ? (extra.used_credits / 100).toFixed(2) : "0.00";
    const extraLimit = extra.monthly_limit ? (extra.monthly_limit / 100).toFixed(2) : "0.00";
    const extraPercent = Math.round(extra.utilization ?? 0);

    return {
      name: "Claude Code",
      available: true,
      tier: oauth.seatTier ?? "Pro/Team",
      org: oauth.organizationName ?? "Personal",
      email: oauth.emailAddress ?? "",
      primaryPercent: extraEnabled ? extraPercent : sevenDay,
      primaryLabel: extraEnabled ? "Monthly Extra" : "7-Day Usage",
      fiveHour: {
        percent: fiveHour,
        resetsAt: u.five_hour?.resets_at,
        timeRemaining: formatTimeRemaining(u.five_hour?.resets_at),
      },
      sevenDay: {
        percent: sevenDay,
        resetsAt: sevenDayResetsAt,
        timeRemaining: formatTimeRemaining(sevenDayResetsAt),
      },
      extraUsage: {
        enabled: extraEnabled,
        used: extraUsed,
        limit: extraLimit,
        percent: extraPercent,
      },
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

  let plan = "Pro";
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
      dbPath,
      "SELECT COALESCE(SUM(tokens_used), 0), COUNT(id) FROM threads WHERE updated_at >= unixepoch('now', 'start of day');",
    ]);
    if (res.code === 0 && res.stdout) {
      const parts = res.stdout.replace(/[│╭─╮╞═╡├┼┤╰┴╯]/g, "").trim().split(/\s+/).filter(Boolean);
      const nums = parts.map(Number).filter((n) => !isNaN(n));
      if (nums.length >= 2) {
        tokensToday = nums[0];
        turnsToday = nums[1];
      }
    }
  } catch {}

  return {
    name: "Codex",
    available: true,
    plan: plan,
    model: model,
    tokensToday: tokensToday,
    formattedTokens: formatTokenCount(tokensToday),
    turnsToday: turnsToday,
  };
}

export async function collectAntigravityData() {
  const h = home();
  let model = "Gemini 3.8 Flash";
  try {
    const cfg = await readTextFile(`${h}/.gemini/antigravity-cli/settings.json`);
    if (cfg) {
      const parsed = JSON.parse(cfg);
      if (parsed.model) model = parsed.model;
    }
  } catch {}

  let convsToday = 0;
  let stepsToday = 0;
  try {
    const dbPath = `${h}/.gemini/antigravity-cli/conversation_summaries.db`;
    const res = await exec("sqlite3", [
      dbPath,
      "SELECT COUNT(conversation_id), COALESCE(SUM(step_count), 0) FROM conversation_summaries WHERE date(last_modified_time) = date('now');",
    ]);
    if (res.code === 0 && res.stdout) {
      const parts = res.stdout.replace(/[│╭─╮╞═╡├┼┤╰┴╯]/g, "").trim().split(/\s+/).filter(Boolean);
      const nums = parts.map(Number).filter((n) => !isNaN(n));
      if (nums.length >= 2) {
        convsToday = nums[0];
        stepsToday = nums[1];
      }
    }
  } catch {}

  // Check live agent status from Herdr
  const liveAgent = agents().find((a) => a.app?.toLowerCase().includes("antigravity"));

  return {
    name: "Antigravity",
    available: true,
    model: model,
    conversationsToday: convsToday,
    stepsToday: stepsToday,
    status: liveAgent?.status ?? "active",
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
