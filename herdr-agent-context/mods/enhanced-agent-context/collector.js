// Agent Context Collector Wrapper for Herdr
import { appHome, readTextFile, exec } from "herdr";

const CACHE = new Map();
const CACHE_TTL_MS = 8000;

function resolveCollectorPath() {
  const h = appHome();
  return `${h}/mods/enhanced-agent-context/collector.py`;
}

export async function fetchAgentContext(cwd = "", agentType = "all", force = false) {
  const cacheKey = `${cwd}::${agentType}`;
  const now = Date.now();
  if (!force && CACHE.has(cacheKey)) {
    const entry = CACHE.get(cacheKey);
    if (now - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
  }

  const scriptPath = resolveCollectorPath();
  const args = [scriptPath, "--cwd", cwd || ".", "--agent", agentType || "all"];

  try {
    const res = await exec("python3", args);
    if (res.code === 0 && res.stdout) {
      const data = JSON.parse(res.stdout);
      CACHE.set(cacheKey, { timestamp: now, data });
      return data;
    }
  } catch (err) {
    console.error("fetchAgentContext failed:", err);
  }

  // Fallback structure
  return {
    cwd: cwd || "",
    targetAgent: agentType,
    models: {},
    git: { isRepo: false, branch: "", dirtyCount: 0 },
    rules: [],
    skills: [],
    connectors: [],
    plugins: [],
    summary: { rulesCount: 0, skillsCount: 0, connectorsCount: 0, pluginsCount: 0 },
  };
}

export async function readRuleContent(filePath) {
  if (!filePath) return "";
  try {
    const content = await readTextFile(filePath);
    return content || "";
  } catch {
    return "";
  }
}
