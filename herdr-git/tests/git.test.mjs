import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function harness(overrides = {}) {
  const events = [];

  const fakeStatusOutput = [
    "## main...origin/main [ahead 1, behind 0]",
    "M  staged-file.js",
    " M unstaged-file.js",
    "?? new-file.txt",
    "",
  ].join("\0");

  const fakeNumstat = ["10\t5\tstaged-file.js", "2\t1\tunstaged-file.js", ""].join("\0");

  const fakeLogGraph = [
    "* 283ef88\t2a5a99e\t (HEAD -> main, origin/main)\tfeat(ui): replace logo\t10 minutes ago\tAndy",
    "* 2a5a99e\t6feceb0\t\tfeat(codex): add week limit\t1 hour ago\tAndy",
    "| \\\t\t\t\t\t",
    "|  * 6feceb0\t\t (feature/test)\tfeat(quotas): refine display\t2 hours ago\tAndy",
    "* | 67a6bb9\t\t\tfeat(keys): update\t3 hours ago\tAndy",
  ].join("\n");

  const api = {
    spaces: () => [{ id: "s1", active: true, folder: "/repo" }],
    panes: () => [{ pane: "p1", space: "s1", cwd: "/repo" }],
    agents: () => [],
    focused: () => ({ pane: "p1", cwd: "/repo" }),
    exec: async (cmd, args) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
        if (args.includes("bundle") || args.includes("status")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              hasRepo: true,
              repo: "acme-org/sample-app",
              prs_count: 2,
              issues_count: 1,
              prs: [{ number: 7, title: "Refactor video pipeline", author: { login: "andy" }, headRefName: "feat/video" }],
              runs: [],
              ci: { conclusion: "success" },
            }),
          };
        }
        if (args.includes("prs")) {
          return { code: 0, stdout: JSON.stringify({ ok: true, prs: [{ number: 7, title: "Refactor video pipeline", author: { login: "andy" }, headRefName: "feat/video" }] }) };
        }
        if (args.includes("pr-diff")) {
          return { code: 0, stdout: JSON.stringify({ ok: true, diff: "+ export function processVideo() {}" }) };
        }
      }
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return { code: 0, stdout: "/repo\n" };
      }
      if (args.includes("rev-parse") && args.includes("--verify")) {
        return { code: 0, stdout: "283ef88\n" };
      }
      if (args.includes("status")) {
        return { code: 0, stdout: fakeStatusOutput };
      }
      if (args.includes("--numstat")) {
        return { code: 0, stdout: fakeNumstat };
      }
      if (args.includes("log") && args.includes("--graph")) {
        return { code: 0, stdout: fakeLogGraph };
      }
      return { code: 0, stdout: "" };
    },
    readTextFile: async () => null,
    appHome: () => "/Users/dev/.config/herdr-app",
    closeOverlay: () => {},
    openOverlay: () => "overlay-1",
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
      selected: "#45475a",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      solid: "#cdd6f4",
      solid_foreground: "#1e1e2e",
    }),
    settings: () => ({ font_family: "JetBrains Mono" }),
    setShared: () => {},
    shared: () => null,
    run: () => {},
    watchFolder: async () => {},
    ...overrides,
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

  const herdr = synthetic(api);
  const gitCode = await readFile(new URL("../mods/enhanced-git/git.js", import.meta.url), "utf8");
  const gitMod = new vm.SourceTextModule(gitCode, { context });
  await gitMod.link((name) => ({ "herdr": herdr }[name]));
  await gitMod.evaluate();

  const element = new Proxy({}, { get: () => () => element });
  const kit = synthetic({
    View: class {},
    div: () => element,
    image: () => element,
    svg: () => element,
  });
  const base = synthetic({
    v_flex: () => element,
    h_flex: () => element,
    InputState: { new: () => ({ on: () => {}, value: () => "", set_value: () => {} }) },
    Input: { new: () => element },
  });

  const mainCode = await readFile(new URL("../mods/enhanced-git/main.js", import.meta.url), "utf8");
  const mainMod = new vm.SourceTextModule(mainCode, { context });
  await mainMod.link((name) => ({
    "herdr": herdr,
    "gpui-kit": kit,
    "gpui-base": base,
    "./git.js": gitMod,
  }[name]));
  await mainMod.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    notify: () => {},
    spawn: (fn) => fn(cx),
    timer: { every: () => {} },
  };

  return { git: gitMod.namespace, View: mainMod.namespace.default, cx, events };
}

test("parseBranchHeader parses branch and ahead/behind info", async () => {
  const { git } = await harness();
  const res1 = git.parseBranchHeader("## main...origin/main [ahead 2, behind 1]");
  assert.equal(res1.branch, "main");
  assert.equal(res1.upstream, "origin/main");
  assert.equal(res1.ahead, 2);
  assert.equal(res1.behind, 1);

  const res2 = git.parseBranchHeader("## feature-xyz");
  assert.equal(res2.branch, "feature-xyz");
  assert.equal(res2.ahead, 0);
  assert.equal(res2.behind, 0);
});

test("getGitStatus separates staged and unstaged files with diff counts", async () => {
  const { git } = await harness();
  const status = await git.getGitStatus("/repo", null);

  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);

  assert.equal(status.stagedFiles.length, 1);
  assert.equal(status.stagedFiles[0].path, "staged-file.js");
  assert.ok(status.stagedFiles[0].add > 0);

  assert.equal(status.unstagedFiles.length, 2);
  assert.equal(status.unstagedFiles[0].path, "unstaged-file.js");
  assert.equal(status.unstagedFiles[1].path, "new-file.txt");
  assert.equal(status.unstagedFiles[1].fresh, true);
});

test("parseGraphRow parses commit node and branch routing lines", async () => {
  const { git } = await harness();

  const row1 = git.parseGraphRow("* 283ef88\t2a5a99e\t (HEAD -> main, v1.0)\tfeat: init\t5m ago\tAndy");
  assert.equal(row1.isCommit, true);
  assert.equal(row1.hash, "283ef88");
  assert.deepEqual([...row1.refs], ["HEAD -> main", "v1.0"]);
  assert.equal(row1.subject, "feat: init");
  assert.equal(row1.author, "Andy");

  const row2 = git.parseGraphRow("| \\");
  assert.equal(row2.isCommit, false);
  assert.equal(row2.graph, "| \\");
});

test("EnhancedGit view initializes in panel and dialog modes and switches tabs", async () => {
  const { View, cx } = await harness();

  const panel = new View();
  panel.init({ role: "panel" }, cx);
  assert.equal(panel.role, "panel");
  assert.equal(panel.tab, "changes");

  const dialog = new View();
  dialog.init({ role: "dialog", tab: "graph" }, cx);
  assert.equal(dialog.role, "dialog");
  assert.equal(dialog.tab, "graph");
});

test("EnhancedGit caches git status per session and enforces 8-session LRU limit", async () => {
  const { View, cx } = await harness();

  const view = new View();
  view.init({ role: "panel" }, cx);

  // Simulate multiple sessions
  for (let i = 1; i <= 10; i++) {
    view.lastKey = `:session-${i}`;
    view.status = { isRepo: true, stagedFiles: [], unstagedFiles: [] };
    view.updateCache();
  }

  // Should have max 8 items in cache
  assert.equal(view.gitCache.size, 8);
  // Oldest sessions (1 and 2) should be evicted
  assert.equal(view.gitCache.has(":session-1"), false);
  assert.equal(view.gitCache.has(":session-2"), false);
  assert.equal(view.gitCache.has(":session-10"), true);
});

test("getGitGraph falls back to HEAD and branches if --all fails", async () => {
  let callCount = 0;
  const { git } = await harness({
    exec: async (_cmd, args) => {
      callCount++;
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "/repo", stderr: "" };
      }
      if (args.includes("--all")) {
        // Simulate failure on --all (e.g. huge DAG timeout or bad ref)
        return { code: 1, stdout: "", stderr: "fatal: bad ref" };
      }
      return {
        code: 0,
        stdout: "* abc1234\t\t (HEAD -> main)\tfallback commit\t1m ago\tAndy",
        stderr: "",
      };
    },
  });

  const res = await git.getGitGraph("/repo", null, 40);
  assert.equal(res.error, null);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].hash, "abc1234");
  assert.equal(res.rows[0].subject, "fallback commit");
  assert.ok(callCount >= 2);
});

test("parseRefBadge parses branch, remote, head, and tag pill badges", async () => {
  const { git } = await harness();

  const head = git.parseRefBadge("HEAD -> main");
  assert.equal(head.type, "head");
  assert.equal(head.label, "main");
  assert.equal(head.isHead, true);

  const remote = git.parseRefBadge("origin/feat-music");
  assert.equal(remote.type, "remote");
  assert.equal(remote.label, "origin/feat-music");

  const tag = git.parseRefBadge("tag: v2.1.0");
  assert.equal(tag.type, "tag");
  assert.equal(tag.label, "v2.1.0");

  const branch = git.parseRefBadge("develop");
  assert.equal(branch.type, "branch");
  assert.equal(branch.label, "develop");
});

test("getGitRefs safely parses branches, remotes, tags, and stashes", async () => {
  const { git } = await harness({
    exec: async (_cmd, args) => {
      if (args.includes("refs/heads")) {
        return {
          code: 0,
          stdout: "main\t[ahead 2, behind 1]\t*\nfeature/fork\t\t \n",
        };
      }
      if (args.includes("refs/remotes")) {
        return {
          code: 0,
          stdout: "origin/HEAD\norigin/main\norigin/feature/fork\n",
        };
      }
      if (args.includes("tag")) {
        return {
          code: 0,
          stdout: "v2.0.0 Tag release 2\nv1.0.0 Tag release 1\n",
        };
      }
      if (args.includes("stash")) {
        return {
          code: 0,
          stdout: "stash@{0}: WIP on main: 283ef88 fix\n",
        };
      }
      return { code: 0, stdout: "" };
    },
  });

  const refs = await git.getGitRefs("/repo", null);
  assert.equal(refs.branches.length, 2);
  assert.equal(refs.branches[0].name, "main");
  assert.equal(refs.branches[0].isCurrent, true);
  assert.equal(refs.branches[0].ahead, 2);
  assert.equal(refs.branches[0].behind, 1);
  assert.equal(refs.branches[1].name, "feature/fork");
  assert.equal(refs.branches[1].isCurrent, false);

  assert.equal(refs.remotes.length, 2);
  assert.equal(refs.remotes[0].remote, "origin");
  assert.equal(refs.remotes[0].branch, "main");

  assert.equal(refs.tags.length, 2);
  assert.equal(refs.tags[0].name, "v2.0.0");

  assert.equal(refs.stashes.length, 1);
  assert.equal(refs.stashes[0].id, "stash@{0}");
});

test("EnhancedGit view supports Fork navigation tabs (changes, graph, branches, stashes)", async () => {
  const { View, cx } = await harness();

  const view = new View();
  view.init({ role: "panel" }, cx);

  view.tab = "branches";
  assert.equal(view.tab, "branches");

  view.tab = "stashes";
  assert.equal(view.tab, "stashes");

  view.tab = "graph";
  assert.equal(view.tab, "graph");
});

test("resolveLocation prioritizes active second tab cwd when pane is not directly focused", async () => {
  const { git } = await harness({
    focused: () => ({ pane: null, tab: null, space: "s1" }),
    spaces: () => [
      {
        id: "s1",
        active: true,
        folder: "/repo-root",
        tabs: [
          { id: "tab1", active: false },
          { id: "tab2", active: true },
        ],
      },
    ],
    panes: () => [
      { pane: "p1", tab: "tab1", space: "s1", cwd: "/repo-root/tab1-dir" },
      { pane: "p2", tab: "tab2", space: "s1", cwd: "/repo-root/tab2-dir" },
    ],
  });

  const loc = git.resolveLocation();
  assert.equal(loc.cwd, "/repo-root/tab2-dir");
});

test("EnhancedGit clears selectedFile and diffLines when working tree becomes clean", async () => {
  let statusOutput = [
    "## main",
    "M  staged-file.js",
    "",
  ].join("\0");

  const { View, cx } = await harness({
    exec: async (cmd, args) => {
      if (args.includes("rev-parse") && args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n" };
      if (args.includes("rev-parse") && args.includes("--verify")) return { code: 0, stdout: "283ef88\n" };
      if (args.includes("status")) return { code: 0, stdout: statusOutput };
      if (args.includes("diff") && args.includes("staged-file.js")) return { code: 0, stdout: "diff --git a/staged-file.js b/staged-file.js\n+line" };
      return { code: 0, stdout: "" };
    },
  });

  const view = new View();
  view.init({ role: "panel" }, cx);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(view.selectedFile, "staged-file.js");
  assert.equal(view.selectedIsStaged, true);

  // Now working tree becomes clean after commit
  statusOutput = "## main\0";
  await view.refresh(cx, true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(view.selectedFile, null);
  assert.equal(view.selectedIsStaged, false);
  assert.equal(view.diffLines.length, 0);

  // Attempting to commit with empty tree should be ignored safely
  view.message = "test commit";
  view.doCommit(cx);
  assert.equal(view.selectedFile, null);
});

test("EnhancedGit supports GitHub tab with PR review agent action", async () => {
  const clipboard = [];
  const { View, cx } = await harness();
  cx.write_to_clipboard = (text) => clipboard.push(text);

  const view = new View();
  view.init({ role: "panel", mode: "github" }, cx);
  await view.fetchGithubStatus(cx);
  await view.fetchGithubActiveTab(cx);

  assert.equal(view.gitMode, "github");
  assert.ok(view.githubStatus);
  assert.equal(view.githubStatus.repo, "acme-org/sample-app");
  assert.equal(view.githubPrs.length, 1);
  assert.equal(view.githubPrs[0].number, 7);

  await view.reviewPrWithAgent(view.githubPrs[0], cx);
  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0], /Please review Pull Request #7/);
  assert.match(clipboard[0], /processVideo/);

  const rendered = view.render(cx);
  assert.ok(rendered);
});




