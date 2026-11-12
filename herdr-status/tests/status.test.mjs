import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MOCK_SONG_ACTIVE = {
  active: true,
  title: "夜に駆ける",
  artist: "YOASOBI",
  playing: true,
  app: "YouTube Music",
  source: "Edge PWA",
};

const MOCK_SONG_INACTIVE = {
  active: false,
  title: "",
  artist: "",
  playing: false,
  app: "YouTube Music",
  source: null,
};

const MOCK_CLAUDE_STATUSLINE = {
  session_id: "test-session",
  effort: { level: "medium" },
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  cost: { total_cost_usd: 12.34 },
  context_window: { used_percentage: 42, total_input_tokens: 420000 },
  rate_limits: {
    five_hour: { used_percentage: 55, resets_at: Math.floor(Date.now() / 1000) + 7200 },
    seven_day: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 86400 },
  },
};

const MOCK_CODEX_CONFIG = `
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
`;

const MOCK_ANTIGRAVITY_SETTINGS = JSON.stringify({
  model: "Gemini 3.8 Flash (Medium)",
});

async function harness({
  mockSong = MOCK_SONG_ACTIVE,
  focused = null,
  panes = [],
  terminals = [],
  files = {},
} = {}) {
  const events = [];
  const renderedElements = [];

  const defaultFiles = {
    "/tmp/claude-statusline-input.json": JSON.stringify(MOCK_CLAUDE_STATUSLINE),
    "/Users/dev/.codex/config.toml": MOCK_CODEX_CONFIG,
    "/Users/dev/.gemini/antigravity-cli/settings.json": MOCK_ANTIGRAVITY_SETTINGS,
    ...files,
  };

  const api = {
    home: () => "/Users/dev",
    appHome: () => "/Users/dev/.config/herdr-app",
    spaces: () => [{ active: true, machine: "This computer", branch: "main" }],
    agents: () => [{ address: "t1", status: "working" }, { address: "t2", status: "idle" }],
    terminals: () => terminals,
    focused: () => focused,
    panes: () => panes,
    theme: () => ({
      chrome: "#181825",
      border: "#313244",
      muted: "#a6adc8",
      dim: "#6c7086",
      foreground: "#cdd6f4",
      selected: "#313244",
      hover: "#45475a",
      ansi2: "#a6e3a1",
      ansi3: "#f9e2af",
      blocked: "#fab387",
      accent: "#cba6f7",
      surface: "#1e1e2e",
    }),
    run: (act, args) => events.push(["run", act, args]),
    window: () => ({ platform: "macos" }),
    keys: () => [{ section: "global", action: "app.palette", keys: "cmd-shift-p" }],
    readTextFile: async (path) => {
      if (path in defaultFiles) {
        return defaultFiles[path];
      }
      return null;
    },
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "status") {
          return { code: 0, stdout: JSON.stringify(mockSong), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "activate") {
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "toggle") {
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (args[0] && args[0].endsWith("codex_limits.py")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              usedPercent: 36,
              resetsAt: Math.floor(Date.now() / 1000) + 36000,
              resetCredits: 0,
            }),
            stderr: "",
          };
        }
        if (args[0] && args[0].endsWith("antigravity_limits.py")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              model: "Gemini 3.8 Flash (Medium)",
              fiveHour: { percent: 15, remainingPercent: 85, resetTime: "2026-11-12T06:56:32Z" },
              weekly: { percent: 20, remainingPercent: 80, resetTime: "2026-11-15T03:05:09Z" },
            }),
            stderr: "",
          };
        }
      }
      if (cmd === "sqlite3") {
        return { code: 0, stdout: "142000\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
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

  const makeElement = (type) => {
    const el = {
      _type: type,
      _id: null,
      _children: [],
      _text: [],
      _tooltip: null,
      _onClick: null,
    };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop === "_id") return target._id;
        if (prop === "_children") return target._children;
        if (prop === "_text") return target._text;
        if (prop === "_tooltip") return target._tooltip;
        if (prop === "_onClick") return target._onClick;
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else target._children.push(c);
          return proxy;
        };
        if (prop === "tooltip") return (tip) => { target._tooltip = tip; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        if (prop === "when") return (cond, fn) => {
          if (cond && typeof fn === "function") fn(proxy);
          return proxy;
        };
        return () => proxy;
      },
    });
    return proxy;
  };

  const kit = synthetic({
    View: class {},
    div: () => makeElement("div"),
    svg: () => makeElement("svg"),
  });
  const base = synthetic({
    h_flex: () => makeElement("h_flex"),
  });
  const herdr = synthetic(api);

  const collectorCode = await readFile(
    new URL("../mods/workspace-status/agent-collector.js", import.meta.url),
    "utf8"
  );
  const collector = new vm.SourceTextModule(collectorCode, { context });
  await collector.link((name) => ({ herdr }[name]));
  await collector.evaluate();

  const mainCode = await readFile(
    new URL("../mods/workspace-status/main.js", import.meta.url),
    "utf8"
  );
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({
    "gpui-kit": kit,
    "gpui-base": base,
    herdr,
    "./agent-collector.js": collector,
  }[name]));
  await main.evaluate();

  const cx = {
    timer: { every: () => {} },
    notify: () => events.push(["notify"]),
  };

  return {
    View: main.namespace.default,
    collector: collector.namespace,
    cx,
    events,
  };
}

function findElementById(root, id) {
  if (!root || typeof root !== "object") return null;
  if (root._id === id) return root;
  if (Array.isArray(root._children)) {
    for (const child of root._children) {
      const found = findElementById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function collectAllText(el) {
  if (!el || typeof el !== "object") return [];
  let texts = Array.isArray(el._text) ? [...el._text] : [];
  if (Array.isArray(el._children)) {
    for (const child of el._children) {
      texts.push(...collectAllText(child));
    }
  }
  return texts;
}

test("workspace status renders YouTube Music widget in bottom-right corner when playing", async () => {
  const { View, cx } = await harness({ mockSong: MOCK_SONG_ACTIVE });

  const view = new View();
  view.init({}, cx);
  await view.pollMusic(cx);

  assert.ok(view.song);
  assert.equal(view.song.active, true);
  assert.equal(view.song.title, "夜に駆ける");
  assert.equal(view.song.artist, "YOASOBI");
  assert.equal(view.song.playing, true);

  const rendered = view.render(cx);
  assert.ok(rendered);
});

test("workspace status handles inactive state cleanly without crashing", async () => {
  const { View, cx } = await harness({ mockSong: MOCK_SONG_INACTIVE });

  const view = new View();
  view.init({}, cx);
  await view.pollMusic(cx);

  assert.ok(view.song);
  assert.equal(view.song.active, false);

  const rendered = view.render(cx);
  assert.ok(rendered);
});

test("activate and toggle actions call python probe", async () => {
  const { View, cx, events } = await harness();

  const view = new View();
  view.init({}, cx);

  await view.activateYTM(cx);
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("activate")));

  await view.togglePlay(cx);
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("toggle")));
});

test("agent collector detects active Claude pane and renders expanded Claude pill", async () => {
  const { View, cx } = await harness({
    focused: { pane: "p1", terminal: "t1", agent: null, cwd: "/Users/dev/Workspace/project-x" },
    panes: [
      { pane: "p1", app: "claude-code", title: "Claude Code", focused: true, program: { name: "claude" }, branch: "feature-auth" },
    ],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  assert.ok(rendered);

  // Verify Branch on left, and Agent full CWD path on right
  const allTexts = collectAllText(rendered);
  assert.ok(allTexts.some((t) => t.includes("feature-auth")), "Should display git branch feature-auth");

  const agentCwdEl = findElementById(rendered, "agent-cwd");
  assert.ok(agentCwdEl, "Should render agent-cwd badge");
  const cwdTexts = collectAllText(agentCwdEl);
  assert.ok(cwdTexts.some((t) => t.includes("~/Workspace/project-x")), "Should display agent cwd path");
  assert.ok(agentCwdEl._tooltip.includes("/Users/dev/Workspace/project-x"), "Tooltip should contain full path");

  const expandedClaude = findElementById(rendered, "agent-status-claude-expanded");
  assert.ok(expandedClaude, "Should render expanded Claude status pill");
  const claudeTexts = collectAllText(expandedClaude);
  assert.ok(claudeTexts.some((t) => t.includes("Opus 5.5")), "Should display model Opus 5.5");
  assert.ok(claudeTexts.some((t) => t.includes("medium")), "Should display full effort medium");
  assert.ok(claudeTexts.some((t) => t.includes("5h 55%")), "Should display 5h quota");
  assert.ok(claudeTexts.some((t) => t.includes("7d 18%")), "Should display 7d quota for Claude");
  assert.equal(claudeTexts.some((t) => t.includes("$")), false, "Claude should NOT display cost/dollar amount in pill");

  const codexBadge = findElementById(rendered, "agent-badge-codex");
  assert.ok(codexBadge, "Should render compact Codex badge flanking");

  const agyBadge = findElementById(rendered, "agent-badge-antigravity");
  assert.ok(agyBadge, "Should render compact Antigravity badge flanking");
});

test("agent collector detects active Codex pane and renders expanded Codex pill without tok", async () => {
  const { View, cx } = await harness({
    focused: { pane: "p2", terminal: "t2", agent: null },
    panes: [
      { pane: "p2", app: "codex", title: "Codex Session", focused: true, program: { name: "codex" } },
    ],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  assert.ok(rendered);

  const expandedCodex = findElementById(rendered, "agent-status-codex-expanded");
  assert.ok(expandedCodex, "Should render expanded Codex status pill");
  const codexTexts = collectAllText(expandedCodex);
  assert.ok(codexTexts.some((t) => t.includes("gpt-6.1-sol")), "Should display model gpt-6.1-sol");
  assert.ok(codexTexts.some((t) => t.includes("medium")), "Should display full effort medium");
  assert.ok(codexTexts.some((t) => t.includes("7d 36%")), "Should display 7d quota for Codex");
  assert.equal(codexTexts.some((t) => t.includes("tok")), false, "Codex should NOT display tok");

  const claudeBadge = findElementById(rendered, "agent-badge-claude");
  assert.ok(claudeBadge, "Should render compact Claude badge flanking");
});

test("agent collector detects active Antigravity pane and renders expanded Antigravity pill with 7d and without rem/steps", async () => {
  const { View, cx } = await harness({
    focused: { pane: "p3", terminal: "t3", agent: null },
    panes: [
      { pane: "p3", app: "antigravity", title: "agy session", focused: true, program: { name: "agy" } },
    ],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  assert.ok(rendered);

  const expandedAgy = findElementById(rendered, "agent-status-antigravity-expanded");
  assert.ok(expandedAgy, "Should render expanded Antigravity status pill");
  const agyTexts = collectAllText(expandedAgy);
  assert.ok(agyTexts.some((t) => t.includes("Gemini 3.8 Flash")), "Should display Gemini model");
  assert.ok(agyTexts.some((t) => t.includes("medium")), "Should display full effort medium");
  assert.equal(agyTexts.some((t) => t.includes("(Medium)")), false, "AGY should NOT include (Medium) in model name");
  assert.ok(agyTexts.some((t) => t.includes("5h 15%")), "Should display 5h used quota");
  assert.ok(agyTexts.some((t) => t.includes("7d 20%")), "Should display 7d used quota (not wk)");
  assert.equal(agyTexts.some((t) => t.includes("rem")), false, "AGY should NOT display rem text");
  assert.equal(agyTexts.some((t) => t.includes("steps")), false, "AGY should NOT display steps text");

  const codexBadge = findElementById(rendered, "agent-badge-codex");
  assert.ok(codexBadge, "Should render compact Codex badge flanking");
});

test("neutral mode without active agent renders 3 compact badges and does not expand anything", async () => {
  const { View, cx } = await harness({
    focused: { pane: "p0", terminal: "t0", agent: null },
    panes: [
      {
        pane: "p0",
        app: "zsh",
        title: "/Users/dev/Workspace/claude/test-repo", // path mentions claude, but it's a shell!
        focused: true,
        program: { key: "shell", name: "zsh", shell: true },
      },
    ],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  assert.ok(rendered);

  // Assert NO agent is expanded
  assert.equal(findElementById(rendered, "agent-status-claude-expanded"), null);
  assert.equal(findElementById(rendered, "agent-status-codex-expanded"), null);
  assert.equal(findElementById(rendered, "agent-status-antigravity-expanded"), null);
  assert.equal(findElementById(rendered, "agent-cwd"), null, "agent-cwd should not render when no agent is active");

  // Assert all 3 compact badges are rendered
  const claudeBadge = findElementById(rendered, "agent-badge-claude");
  const codexBadge = findElementById(rendered, "agent-badge-codex");
  const agyBadge = findElementById(rendered, "agent-badge-antigravity");

  assert.ok(claudeBadge, "Claude badge should render in neutral mode");
  assert.ok(codexBadge, "Codex badge should render in neutral mode");
  assert.ok(agyBadge, "Antigravity badge should render in neutral mode");
});

test("clicking agent status badge calls mod.open for agent-quotas dashboard", async () => {
  const { View, cx, events } = await harness({
    focused: { pane: "p1", terminal: "t1" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const expandedClaude = findElementById(rendered, "agent-status-claude-expanded");
  assert.ok(expandedClaude);

  expandedClaude._onClick();
  assert.ok(
    events.some((e) => e[0] === "run" && e[1] === "mod.open" && e[2]?.name === "agent-quotas"),
    "Should trigger mod.open for agent-quotas"
  );
});

test("clicking agent-cwd copies full path to clipboard", async () => {
  const copied = [];
  const { View, cx } = await harness({
    focused: { pane: "p1", terminal: "t1", cwd: "/Users/dev/Workspace/project-x" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
  });
  cx.write_to_clipboard = (text) => copied.push(text);

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const agentCwdEl = findElementById(rendered, "agent-cwd");
  assert.ok(agentCwdEl, "Should render agent-cwd");

  agentCwdEl._onClick(null, cx);
  assert.deepEqual(copied, ["/Users/dev/Workspace/project-x"]);
});

test("shrinkPath preserves last 2 segments and contracts leading segments to first letters", async () => {
  const { View, collector, cx } = await harness({
    focused: { pane: "p1", terminal: "t1", cwd: "/Users/dev/Workspace/side-project/herdr-mods" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
  });

  // Direct collector helper assertions
  assert.equal(
    collector.shrinkPath("/Users/dev/Workspace/side-project/herdr-mods", "/Users/dev"),
    "~/W/side-project/herdr-mods"
  );
  assert.equal(
    collector.shrinkPath("/Users/dev/Workspace/dentsu/code/AI-Media/pitch/prd", "/Users/dev"),
    "~/W/d/c/A/pitch/prd"
  );
  assert.equal(
    collector.shrinkPath("/Users/dev/Workspace/project-x", "/Users/dev"),
    "~/Workspace/project-x"
  );

  // Render assertion
  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const agentCwdEl = findElementById(rendered, "agent-cwd");
  assert.ok(agentCwdEl);

  const texts = collectAllText(agentCwdEl);
  assert.ok(
    texts.some((t) => t.includes("~/W/side-project/herdr-mods")),
    "Should display shortened path with last 2 segments full"
  );
  assert.ok(
    agentCwdEl._tooltip.includes("/Users/dev/Workspace/side-project/herdr-mods"),
    "Tooltip should always keep unabbreviated path"
  );
});

test("git-branch badge renders on the right with matching style and copies to clipboard on click", async () => {
  const copied = [];
  const { View, cx } = await harness({
    focused: { pane: "p1", terminal: "t1", cwd: "/Users/dev/Workspace/project-x", branch: "feature/unified-status" },
    panes: [{ pane: "p1", app: "claude-code", focused: true, branch: "feature/unified-status" }],
  });
  cx.write_to_clipboard = (text) => copied.push(text);

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const gitBranchEl = findElementById(rendered, "git-branch");
  assert.ok(gitBranchEl, "Should render git-branch badge");

  const branchTexts = collectAllText(gitBranchEl);
  assert.ok(branchTexts.some((t) => t.includes("feature/unified-status")), "Should display git branch");
  assert.ok(gitBranchEl._tooltip.includes("feature/unified-status"), "Tooltip should contain branch name");

  gitBranchEl._onClick(null, cx);
  assert.deepEqual(copied, ["feature/unified-status"]);
});

test("statusbar-agents displays breakdown of running and idle agents with rich model tooltip and triggers agents mod on click", async () => {
  const { View, cx, events } = await harness({
    focused: { pane: "p1", terminal: "t1" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const agentsWidget = findElementById(rendered, "statusbar-agents");
  assert.ok(agentsWidget, "Should render statusbar-agents widget");

  const texts = collectAllText(agentsWidget);
  assert.ok(texts.some((t) => t.includes("2 agents")), "Should display total agents count");
  assert.ok(texts.some((t) => t.includes("1")), "Should display running agents count");

  assert.ok(agentsWidget._tooltip.includes("Agents (2 total · 1 running)"), "Tooltip should have summary header");
  assert.ok(agentsWidget._tooltip.includes("running"), "Tooltip should list running status");
  assert.ok(agentsWidget._tooltip.includes("idle"), "Tooltip should list idle status");
  assert.ok(agentsWidget._tooltip.includes("點擊開啟 Agent 清單"), "Tooltip should indicate click action");

  agentsWidget._onClick(null, cx);
  assert.ok(
    events.some((e) => e[0] === "run" && e[1] === "mod.open" && e[2]?.name === "agents"),
    "Clicking agents widget should trigger mod.open for agents"
  );
});

test("statusbar-agents detects Herdr terminal subagents and displays subagents (running / idle) count and tree", async () => {
  const { View, cx } = await harness({
    focused: { pane: "p1", terminal: "t1" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
    terminals: [
      { address: "sub1", parent: "t1", state: "live", status: "working", title: "Codebase Researcher" },
      { address: "sub2", parent: "t1", state: "live", status: "working", title: "Unit Test Runner" },
      { address: "sub3", parent: "t1", state: "live", status: "running", title: "Doc Parser" },
      { address: "sub4", parent: "t1", state: "live", status: "done", title: "Linter" },
      { address: "sub5", parent: "t1", state: "live", status: "idle", title: "Dependency Checker" },
    ],
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const agentsWidget = findElementById(rendered, "statusbar-agents");
  assert.ok(agentsWidget, "Should render statusbar-agents widget");

  const texts = collectAllText(agentsWidget);
  assert.ok(texts.some((t) => t.includes("5 subagents")), "Should display 5 subagents");
  assert.ok(texts.some((t) => t.includes("3")), "Should display running count 3");
  assert.ok(texts.some((t) => t.includes("2")), "Should display idle count 2");

  assert.ok(agentsWidget._tooltip.includes("5 subagents"), "Tooltip should include subagents count");
  assert.ok(agentsWidget._tooltip.includes("Codebase Researcher"), "Tooltip should list subagent names");
  assert.ok(agentsWidget._tooltip.includes("Linter"), "Tooltip should list completed subagent");
});

test("parseTranscriptTasks parses Claude Code transcript tasks and displays on expanded Claude pill", async () => {
  const mockTranscript = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "task_1", name: "Task", input: { description: "Subagent Alpha" } },
          { type: "tool_use", id: "task_2", name: "Task", input: { description: "Subagent Beta" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "task_1", content: "Done" }],
      },
    }),
  ].join("\n");

  const customClaudeStatusline = {
    ...MOCK_CLAUDE_STATUSLINE,
    transcript_path: "/tmp/mock-transcript.jsonl",
  };

  const { View, cx } = await harness({
    focused: { pane: "p1", terminal: "t1", cwd: "/Users/dev/Workspace/project-x" },
    panes: [{ pane: "p1", app: "claude-code", focused: true }],
    files: {
      "/tmp/claude-statusline-input.json": JSON.stringify(customClaudeStatusline),
      "/tmp/mock-transcript.jsonl": mockTranscript,
    },
  });

  const view = new View();
  view.init({}, cx);
  await view.pollAgentStatus(cx);

  const rendered = view.render(cx);
  const expandedClaude = findElementById(rendered, "agent-status-claude-expanded");
  assert.ok(expandedClaude, "Should render expanded Claude pill");

  const claudeTexts = collectAllText(expandedClaude);
  assert.ok(claudeTexts.some((t) => t.includes("2 sub (1/1)")), "Should display 2 sub (1/1)");
});
