import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness() {
  const events = [];
  const fakeClaudeJson = JSON.stringify({
    oauthAccount: {
      seatTier: "Team",
      organizationName: "TestOrg",
      emailAddress: "dev@example.com",
    },
    cachedUsageUtilization: {
      utilization: {
        five_hour: { utilization: 15, resets_at: null },
        seven_day: { utilization: 60, resets_at: "2026-11-05T20:00:00Z" },
        extra_usage: {
          is_enabled: true,
          used_credits: 5000,
          monthly_limit: 10000,
          utilization: 50,
        },
      },
    },
  });

  const fakeCodexAuth = JSON.stringify({
    tokens: {
      access_token: "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "prolite" } })).toString("base64") + ".sig",
    },
  });

  const api = {
    home: () => "/home/user",
    readTextFile: async (path) => {
      events.push(["readTextFile", path]);
      if (api.onReadTextFile) {
        const custom = await api.onReadTextFile(path);
        if (custom !== undefined) return custom;
      }
      if (path.includes(".claude")) return fakeClaudeJson;
      if (path.includes(".codex/auth.json")) return fakeCodexAuth;
      if (path.includes(".codex/config.toml")) return 'model = "gpt-5"';
      if (path.includes(".gemini/antigravity-cli/settings.json")) return '{"model": "Gemini 3.8 Flash (Medium)"}';
      return null;
    },
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      if (api.onExec) {
        const custom = await api.onExec(cmd, args);
        if (custom !== undefined) return custom;
      }
      if (cmd === "python3") {
        const script = args?.[0] || "";
        if (script.includes("antigravity_limits.py")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              email: "test@example.com",
              tier: "Antigravity",
              model: "Gemini 3.8 Flash (Medium)",
              fiveHour: {
                percent: 25,
                remainingPercent: 75,
                remainingFraction: 0.75,
                resetTime: "2026-11-06T15:00:00Z",
                modelId: "gemini-3.8-flash-tiered",
              },
              weekly: {
                percent: 40,
                remainingPercent: 60,
                remainingFraction: 0.6,
                resetTime: "2026-11-13T03:00:00Z",
                displayName: "Weekly Limit Remaining",
              },
            }),
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            usedPercent: 54,
            resetsAt: 1794277917,
            windowDurationMins: 10080,
            resetCredits: 2,
          }),
        };
      }
      if (cmd === "sqlite3") {
        const db = args?.[2] || "";
        if (db.includes("conversation_summaries.db")) {
          return { code: 0, stdout: "4500,3\n" };
        }
      }
      return { code: 0, stdout: "1500000,12\n" };
    },
    theme: () => ({
      surface: "#181825",
      background: "#1e1e2e",
      popover: "#181825",
      border: "#313244",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      raised: "#313244",
      hover: "#45475a",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      blocked: "#fab387",
    }),
    props: () => ({}),
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-q";
    },
    setShared: (k, v) => events.push(["setShared", k, v]),
    shared: () => null,
    run: (name, args) => events.push(["run", name, args]),
    notify: () => {},
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const element = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "when") {
          return (cond, fn) => {
            if (cond && typeof fn === "function") {
              fn(element);
            }
            return element;
          };
        }
        return () => element;
      },
    }
  );

  const kit = synthetic({
    View: class {},
    div: () => element,
    image: () => element,
    svg: () => element,
  });

  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
  });

  const herdr = synthetic(api);
  const collectorCode = await readFile(new URL("../mods/agent-quotas/collector.js", import.meta.url), "utf8");
  const collector = new vm.SourceTextModule(collectorCode, { context });
  await collector.link((name) => ({ "herdr": herdr }[name]));
  await collector.evaluate();

  const mainCode = await readFile(new URL("../mods/agent-quotas/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, "herdr": herdr, "./collector.js": collector }[name]));
  await main.evaluate();

  const View = main.namespace.default;
  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    spawn: async (fn) => {
      await fn(cx);
    },
    timer: {
      every: (ms) => events.push(["timer.every", ms]),
    },
    notify: () => events.push(["notify"]),
  };

  return { api, collector: collector.namespace, View, cx, events };
}

test("collector formats tokens and time strings correctly", async () => {
  const { collector } = await harness();
  assert.equal(collector.formatTokenCount(500), "500");
  assert.equal(collector.formatTokenCount(1200), "1.2k");
  assert.equal(collector.formatTokenCount(1500000), "1.5M");
  assert.equal(collector.formatTokenCount(2500000000), "2.5B");
  assert.equal(collector.formatTimeRemaining(null), null);
});

test("collector parses Claude Code, Codex, and Antigravity metrics with 5hr, week, and credit", async () => {
  const { collector } = await harness();
  const res = await collector.collectAllQuotas();

  assert.equal(res.claude.available, true);
  assert.equal(res.claude.name, "Claude Code");
  assert.equal(res.claude.tier, "Team");
  assert.equal(res.claude.hasFiveHour, true);
  assert.equal(res.claude.fiveHour.percent, 15);
  assert.equal(res.claude.hasWeek, true);
  assert.equal(res.claude.week.percent, 60);
  assert.equal(res.claude.hasCredit, true);
  assert.equal(res.claude.isConsumingCredit, false);
  assert.equal(res.claude.credit.used, "$50.00");
  assert.equal(res.claude.primaryLabel, "5h");
  assert.equal(res.claude.primaryPercent, 15);

  assert.equal(res.codex.available, true);
  assert.equal(res.codex.name, "Codex");
  assert.equal(res.codex.plan, "PROLITE");
  assert.equal(res.codex.hasFiveHour, false);
  assert.equal(res.codex.hasWeek, true);
  assert.equal(res.codex.week.percent, 54);
  assert.equal(res.codex.resetCredits, 2);
  assert.equal(res.codex.hasCredit, false);
  assert.equal(res.codex.tokensToday, 1500000);
  assert.equal(res.codex.turnsToday, 12);

  assert.equal(res.antigravity.available, true);
  assert.equal(res.antigravity.name, "Antigravity");
  assert.equal(res.antigravity.tier, "Antigravity");
  assert.equal(res.antigravity.email, "test@example.com");
  assert.equal(res.antigravity.model, "Gemini 3.8 Flash (Medium)");
  assert.equal(res.antigravity.hasFiveHour, true);
  assert.equal(res.antigravity.fiveHour.percent, 25);
  assert.equal(res.antigravity.fiveHour.remainingPercent, 75);
  assert.equal(res.antigravity.fiveHour.modelId, "gemini-3.8-flash-tiered");
  assert.equal(res.antigravity.hasWeek, true);
  assert.equal(res.antigravity.week.percent, 40);
  assert.equal(res.antigravity.week.remainingPercent, 60);
  assert.equal(res.antigravity.week.displayName, "Weekly Limit Remaining");
  assert.equal(res.antigravity.primaryPercent, 25);
  assert.equal(res.antigravity.primaryLabel, "5h");
  assert.equal(res.antigravity.primaryRemainingPercent, 75);
  assert.equal(res.antigravity.stepsToday, 4500);
  assert.equal(res.antigravity.formattedSteps, "4.5k");
  assert.equal(res.antigravity.sessionsToday, 3);
});

test("AgentQuotas view initializes, fetches data, and renders both widget and dialog", async () => {
  const { View, cx } = await harness();
  const widgetInstance = new View();
  widgetInstance.init({ role: "widget" }, cx);
  await new Promise((r) => setImmediate(r));
  assert.equal(widgetInstance.role, "widget");
  assert.ok(widgetInstance.data);
  const widgetRendered = widgetInstance.render(cx);
  assert.ok(widgetRendered);

  const dialogInstance = new View();
  dialogInstance.init({ role: "dialog", overlay: "overlay-test" }, cx);
  await new Promise((r) => setImmediate(r));
  assert.equal(dialogInstance.role, "dialog");
  assert.ok(dialogInstance.data);
  const dialogRendered = dialogInstance.render(cx);
  assert.ok(dialogRendered);
});

test("collector selects newest Claude profile by fetchedAtMs and parses spend amount", async () => {
  const { collector, api } = await harness();
  const olderJson = JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 1000,
      utilization: {
        extra_usage: { used_credits: 1000, monthly_limit: 10000, utilization: 10 },
      },
    },
  });
  const newerJson = JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: 2000,
      utilization: {
        extra_usage: { used_credits: 14494, monthly_limit: 17000, utilization: 85.25 },
      },
    },
  });

  api.onReadTextFile = async (path) => {
    if (path.endsWith("/.claude-work/.claude.json")) return newerJson;
    if (path.endsWith("/.claude.json")) return olderJson;
    return null;
  };

  const claude = await collector.collectClaudeData();
  assert.equal(claude.available, true);
  assert.equal(claude.credit.used, "$144.94");
  assert.equal(claude.credit.limit, "$170.00");
  assert.equal(claude.credit.percent, 85);
  assert.equal(claude.primaryPercent, 85);
});

test("collector shows 5h (even at 0%) when plan limits are below 100% despite historical credit usage, and switches to Credit at 100%", async () => {
  const { collector, api } = await harness();

  // Case 1: 5h is 0%, 7d is 30%, extra_usage has historical spend ($159.92) -> should consume 5h (0%)
  api.onReadTextFile = async (path) => {
    if (path.endsWith("/.claude-work/.claude.json")) {
      return JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 3000,
          utilization: {
            five_hour: { utilization: 0, resets_at: "2026-11-08T19:00:00Z" },
            seven_day: { utilization: 30, resets_at: "2026-11-12T06:00:00Z" },
            extra_usage: { is_enabled: true, used_credits: 15992, monthly_limit: 17000, utilization: 94.07 },
          },
        },
      });
    }
    return null;
  };

  const c1 = await collector.collectClaudeData();
  assert.equal(c1.isConsumingCredit, false);
  assert.equal(c1.primaryLabel, "5h");
  assert.equal(c1.primaryPercent, 0);

  // Case 2: 5h hits 100% -> spills over into Credit (94%)
  api.onReadTextFile = async (path) => {
    if (path.endsWith("/.claude-work/.claude.json")) {
      return JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 4000,
          utilization: {
            five_hour: { utilization: 100, resets_at: "2026-11-08T19:00:00Z" },
            seven_day: { utilization: 45, resets_at: "2026-11-12T06:00:00Z" },
            extra_usage: { is_enabled: true, used_credits: 15992, monthly_limit: 17000, utilization: 94.07 },
          },
        },
      });
    }
    return null;
  };

  const c2 = await collector.collectClaudeData();
  assert.equal(c2.isConsumingCredit, true);
  assert.equal(c2.primaryLabel, "Credit");
  assert.equal(c2.primaryPercent, 94);
});

test("collector resolves Antigravity Argon and GPT/Claude active quota pools accurately", async () => {
  const { collector, api } = await harness();
  api.onExec = async (cmd, args) => {
    if (cmd === "python3" && (args?.[0] || "").includes("antigravity_limits.py")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          email: "user@example.com",
          tier: "Antigravity",
          model: "Gemini 4 Argon (Medium)",
          groupName: "Gemini 4 Argon",
          shortLabel: "Argon",
          fiveHour: null,
          weekly: {
            percent: 50,
            remainingPercent: 50,
            remainingFraction: 0.5,
            resetTime: "2026-11-15T03:35:12Z",
            displayName: "Gemini 4 Argon Weekly Limit",
          },
          groups: [
            { name: "Gemini Models", shortLabel: "Gemini", active: false, fiveHour: { percent: 4, remainingPercent: 96 }, weekly: { percent: 1, remainingPercent: 99 } },
            { name: "Claude and GPT models", shortLabel: "GPT/Claude", active: false, fiveHour: { percent: 0, remainingPercent: 100 }, weekly: { percent: 0, remainingPercent: 100 } },
            { name: "Gemini 4 Argon", shortLabel: "Argon", active: true, fiveHour: null, weekly: { percent: 50, remainingPercent: 50 } },
          ],
        }),
      };
    }
    return undefined;
  };

  const ag = await collector.collectAntigravityData();
  assert.equal(ag.model, "Gemini 4 Argon (Medium)");
  assert.equal(ag.shortLabel, "Argon");
  assert.equal(ag.hasFiveHour, false);
  assert.equal(ag.hasWeek, true);
  assert.equal(ag.primaryLabel, "Argon");
  assert.equal(ag.primaryPercent, 50);
  assert.equal(ag.primaryRemainingPercent, 50);
  assert.equal(ag.groups.length, 3);
});

test("collector prioritizes live claude_limits.py OAuth API data over stale .claude.json cache", async () => {
  const { collector, api } = await harness();

  api.onExec = async (cmd, args) => {
    if (cmd === "python3" && (args?.[0] || "").includes("claude_limits.py")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          oauthAccount: {
            seatTier: "team_standard",
            organizationName: "Acme Corp",
            emailAddress: "dev@example.com",
          },
          utilization: {
            five_hour: { utilization: 33, resets_at: "2026-11-09T06:50:00Z" },
            seven_day: { utilization: 34, resets_at: "2026-11-12T22:00:00Z" },
            extra_usage: {
              is_enabled: true,
              used_credits: 15992,
              monthly_limit: 17000,
              utilization: 94.07,
            },
          },
          fetchedAtMs: 9999999999999,
          source: "live",
        }),
      };
    }
    return undefined;
  };

  const claude = await collector.collectClaudeData();
  assert.equal(claude.available, true);
  assert.equal(claude.email, "dev@example.com");
  assert.equal(claude.fiveHour.percent, 33);
  assert.equal(claude.week.percent, 34);
  assert.equal(claude.primaryLabel, "5h");
  assert.equal(claude.primaryPercent, 33);
});
