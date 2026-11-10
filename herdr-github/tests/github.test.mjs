import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MOCK_STATUS_ACTIVE = {
  hasRepo: true,
  repo: "octocat/storage-copier",
  branch: "main",
  url: "https://github.com/octocat/storage-copier",
  ci: {
    databaseId: 101,
    name: "CI / Test",
    workflowName: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
  },
  prs_count: 2,
  issues_count: 1,
};

const MOCK_PRS = {
  ok: true,
  prs: [
    {
      number: 12,
      title: "Add async retry to upload queue",
      author: { login: "octocat" },
      headRefName: "feat/upload-retry",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      url: "https://github.com/octocat/storage-copier/pull/12",
      additions: 45,
      deletions: 12,
      updatedAt: "2026-11-10T02:00:00Z",
    },
  ],
};

const MOCK_RUNS = {
  ok: true,
  runs: [
    {
      databaseId: 101,
      name: "Build and Test",
      workflowName: "CI",
      status: "completed",
      conclusion: "failure",
      headBranch: "main",
      url: "https://github.com/octocat/storage-copier/actions/runs/101",
      event: "push",
      createdAt: "2026-11-10T01:30:00Z",
    },
  ],
};

const MOCK_ISSUES = {
  ok: true,
  issues: [
    {
      number: 42,
      title: "Memory leak in socket connection pool",
      author: { login: "colleague" },
      state: "OPEN",
      url: "https://github.com/octocat/storage-copier/issues/42",
      labels: [],
      updatedAt: "2026-11-10T00:00:00Z",
    },
  ],
};

async function harness({ mockStatus = MOCK_STATUS_ACTIVE } = {}) {
  const events = [];
  const clipboard = [];

  const api = {
    home: () => "/Users/dev",
    appHome: () => "/Users/dev/.config/herdr-app",
    spaces: () => [{ active: true, folder: "/Users/dev/workspace/sample-repo", branch: "main" }],
    props: () => ({ overlay: "overlay-gh" }),
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    theme: () => ({
      background: "#1e1e2e",
      chrome: "#181825",
      border: "#313244",
      surface: "#313244",
      muted: "#a6adc8",
      dim: "#6c7086",
      foreground: "#cdd6f4",
      selected: "#313244",
      hover: "#45475a",
      accent: "#89b4fa",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      blocked: "#fab387",
    }),
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
        if (args.includes("status")) return { code: 0, stdout: JSON.stringify(mockStatus) };
        if (args.includes("prs")) return { code: 0, stdout: JSON.stringify(MOCK_PRS) };
        if (args.includes("runs")) return { code: 0, stdout: JSON.stringify(MOCK_RUNS) };
        if (args.includes("issues")) return { code: 0, stdout: JSON.stringify(MOCK_ISSUES) };
        if (args.includes("failed-log")) return { code: 0, stdout: JSON.stringify({ ok: true, log: "Error: Process exited with 1" }) };
        if (args.includes("pr-diff")) return { code: 0, stdout: JSON.stringify({ ok: true, diff: "+ retryLimit = 3" }) };
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

  const element = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(element) : element);
        return () => element;
      },
    }
  );

  const kit = synthetic({ View: class {}, div: () => element, svg: () => element });
  const base = synthetic({ v_flex: () => element, h_flex: () => element });
  const herdr = synthetic(api);

  const mainCode = await readFile(new URL("../mods/github-hub/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await main.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    notify: () => events.push(["notify"]),
    write_to_clipboard: (text) => clipboard.push(text),
  };

  return { View: main.namespace.default, cx, events, clipboard };
}

test("GitHubHub initializes and loads status and PR list", async () => {
  const { View, cx } = await harness();
  const hub = new View();
  hub.init({}, cx);
  await hub.refreshAll(cx);

  assert.ok(hub.repoInfo);
  assert.equal(hub.repoInfo.repo, "octocat/storage-copier");
  assert.equal(hub.prs.length, 1);
  assert.equal(hub.prs[0].number, 12);

  const rendered = hub.render(cx);
  assert.ok(rendered);
});

test("GitHubHub switches tabs between PRs, Runs, and Issues", async () => {
  const { View, cx } = await harness();
  const hub = new View();
  hub.init({}, cx);
  await hub.refreshAll(cx);

  // Switch to Actions & CI
  await hub.switchTab("runs", cx);
  assert.equal(hub.activeTab, "runs");
  assert.equal(hub.runs.length, 1);
  assert.equal(hub.runs[0].databaseId, 101);

  // Switch to Issues
  await hub.switchTab("issues", cx);
  assert.equal(hub.activeTab, "issues");
  assert.equal(hub.issues.length, 1);
  assert.equal(hub.issues[0].number, 42);
});

test("reviewPrWithAgent prepares prompt with diff and copies to clipboard", async () => {
  const { View, cx, clipboard } = await harness();
  const hub = new View();
  hub.init({}, cx);
  await hub.refreshAll(cx);

  const pr = hub.prs[0];
  await hub.reviewPrWithAgent(pr, cx);

  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0], /Please review Pull Request #12/);
  assert.match(clipboard[0], /retryLimit = 3/);
});

test("fixCiWithAgent fetches failed logs and copies agent prompt to clipboard", async () => {
  const { View, cx, clipboard } = await harness();
  const hub = new View();
  hub.init({}, cx);
  await hub.refreshAll(cx);
  await hub.switchTab("runs", cx);

  const run = hub.runs[0];
  await hub.fixCiWithAgent(run, cx);

  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0], /GitHub Actions workflow "CI" failed/);
  assert.match(clipboard[0], /Error: Process exited with 1/);
});
