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
      return null;
    },
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
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
      get: () => () => element,
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

test("collector parses Claude Code and Codex metrics with 5hr, week, and credit", async () => {
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
  assert.equal(res.claude.credit.used, "$50.00");

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
});

test("AgentQuotas view initializes and switches between widget and dialog", async () => {
  const { View, cx } = await harness();
  const widgetInstance = new View();
  widgetInstance.init({ role: "widget" }, cx);
  await new Promise((r) => setImmediate(r));
  assert.equal(widgetInstance.role, "widget");

  const dialogInstance = new View();
  dialogInstance.init({ role: "dialog", overlay: "overlay-test" }, cx);
  await new Promise((r) => setImmediate(r));
  assert.equal(dialogInstance.role, "dialog");
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
