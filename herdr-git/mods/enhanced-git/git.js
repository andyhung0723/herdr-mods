// Git Service & Parser for Herdr Enhanced Git mod
import { spaces, panes, focused, agents, exec, readTextFile } from "herdr";

const READ_FLAGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

const rootCache = new Map();

export function resolveLocation() {
  const allSpaces = spaces() || [];
  const allPanes = panes() || [];
  const allAgents = (typeof agents === "function" ? agents() : null) || [];
  const f = focused() || {};

  const activeSpace = allSpaces.find((s) => s.id === f?.space) ?? allSpaces.find((s) => s.active) ?? allSpaces[0];

  // 1. Highest priority: currently focused pane
  let pane = f.pane ? allPanes.find((p) => p.pane === f.pane) : null;

  // 2. Second priority: pane in the currently active tab (e.g. Tab 2, Tab 3)
  if (!pane?.cwd) {
    const activeTabId = f.tab || activeSpace?.tabs?.find((t) => t.active)?.id;
    if (activeTabId) {
      pane = allPanes.find((p) => p.tab === activeTabId && p.cwd);
    }
  }

  // 3. Fallback to any pane in the active space
  if (!pane && activeSpace) {
    pane = allPanes.find((p) => p.space === activeSpace.id || activeSpace.tabs?.some((t) => t.id === p.tab));
  }

  // Check matching agent in agents() list
  let currentAgent = f?.agent ? allAgents.find((a) => a.address === f.agent) : null;
  if (!currentAgent && pane) {
    currentAgent = allAgents.find(
      (a) => a.pane === pane.pane || (pane.terminal && a.address === pane.terminal)
    );
  }
  if (!currentAgent && f.tab) {
    currentAgent = allAgents.find((a) => a.tab === f.tab);
  }

  const cwd = currentAgent?.cwd || pane?.cwd || f.cwd || activeSpace?.folder || activeSpace?.cwd || null;
  const on = f.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : activeSpace?.machine ?? null;

  return { cwd, on };
}

export async function resolveRepoRoot(cwd, on) {
  if (!cwd) return null;
  const key = `${on || ""}:${cwd}`;
  if (rootCache.has(key)) {
    return rootCache.get(key);
  }

  try {
    const topRes = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (topRes.code === 0 && topRes.stdout.trim()) {
      const root = topRes.stdout.trim();
      rootCache.set(key, root);
      return root;
    }
  } catch {}

  const base = cwd.split("/").filter(Boolean).pop();
  if (base) {
    try {
      const subRes = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: `${cwd}/${base}`, on });
      if (subRes.code === 0 && subRes.stdout.trim()) {
        const root = subRes.stdout.trim();
        rootCache.set(key, root);
        return root;
      }
    } catch {}
  }

  return null;
}

export function parseBranchHeader(rawHeader) {
  let branch = "HEAD";
  let upstream = null;
  let ahead = 0;
  let behind = 0;

  const content = rawHeader.replace(/^##\s*/, "").trim();
  if (content.startsWith("No commits yet on ")) {
    branch = content.replace("No commits yet on ", "");
    return { branch, upstream, ahead, behind, hasHead: false };
  }
  if (content.startsWith("Initial commit on ")) {
    branch = content.replace("Initial commit on ", "");
    return { branch, upstream, ahead, behind, hasHead: false };
  }

  const parts = content.split("...");
  branch = parts[0];

  if (parts.length > 1) {
    const upParts = parts[1].split(" [");
    upstream = upParts[0];
    if (upParts.length > 1) {
      const countsStr = upParts[1].replace("]", "");
      const aheadMatch = /ahead\s+(\d+)/.exec(countsStr);
      const behindMatch = /behind\s+(\d+)/.exec(countsStr);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
    }
  }

  return { branch, upstream, ahead, behind, hasHead: true };
}

export async function getGitStatus(cwd, on) {
  if (!cwd) return { isRepo: false, error: "No folder" };

  const root = await resolveRepoRoot(cwd, on);
  if (!root) {
    return { isRepo: false, error: "Not a git repository" };
  }

  const git = (args) => exec("git", [...READ_FLAGS, ...args], { cwd: root, on });

  const [statusRes, cachedNumstat, unstagedNumstat] = await Promise.all([
    git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]),
    git(["diff", "--cached", "--numstat", "-z", "--no-renames"]).catch(() => ({ code: 1, stdout: "" })),
    git(["diff", "--numstat", "-z", "--no-renames"]).catch(() => ({ code: 1, stdout: "" })),
  ]);

  if (statusRes.code !== 0) {
    return { isRepo: true, root, error: statusRes.stderr || "Status check failed" };
  }

  const entries = statusRes.stdout.split("\0").filter(Boolean);
  const branchHeader = entries[0] || "## HEAD";
  const { branch, upstream, ahead, behind, hasHead } = parseBranchHeader(branchHeader);

  const stats = {};
  for (const res of [cachedNumstat, unstagedNumstat]) {
    if (res && res.code === 0 && res.stdout) {
      for (const item of res.stdout.split("\0")) {
        const [a, d, ...pathParts] = item.split("\t");
        if (!pathParts.length) continue;
        const p = pathParts.join("\t");
        const old = stats[p] ?? { add: 0, del: 0 };
        stats[p] = {
          add: old.add + (Number(a) || 0),
          del: old.del + (Number(d) || 0),
          binary: a === "-",
        };
      }
    }
  }

  const stagedFiles = [];
  const unstagedFiles = [];

  for (const entry of entries.slice(1, 1001)) {
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    const fileStat = stats[path] ?? { add: 0, del: 0 };

    // Staged changes (X is M, A, D, R, C)
    if (["M", "A", "D", "R", "C"].includes(x)) {
      stagedFiles.push({
        path,
        status: x,
        staged: true,
        fresh: false,
        ...fileStat,
      });
    }

    // Unstaged changes (Y is M, D, or ?? untracked)
    if (x === "?" && y === "?") {
      unstagedFiles.push({
        path,
        status: "??",
        fresh: true,
        staged: false,
        ...fileStat,
      });
    } else if (["M", "D"].includes(y)) {
      unstagedFiles.push({
        path,
        status: y,
        fresh: false,
        staged: false,
        ...fileStat,
      });
    } else if (["U", "A"].includes(x) && ["U", "A"].includes(y)) {
      // Conflict
      unstagedFiles.push({
        path,
        status: "U",
        conflict: true,
        fresh: false,
        staged: false,
        ...fileStat,
      });
    }
  }

  const totalAdd = stagedFiles.reduce((s, f) => s + f.add, 0) + unstagedFiles.reduce((s, f) => s + f.add, 0);
  const totalDel = stagedFiles.reduce((s, f) => s + f.del, 0) + unstagedFiles.reduce((s, f) => s + f.del, 0);

  return {
    isRepo: true,
    root,
    on,
    hasHead,
    branch,
    upstream,
    ahead,
    behind,
    stagedFiles,
    unstagedFiles,
    totalAdd,
    totalDel,
  };
}

export function parseRefBadge(refStr) {
  let type = "branch"; // "head" | "branch" | "remote" | "tag"
  let label = (refStr || "").trim();
  let isHead = false;

  if (label.startsWith("HEAD -> ")) {
    isHead = true;
    type = "head";
    label = label.replace("HEAD -> ", "").trim();
  } else if (label === "HEAD") {
    isHead = true;
    type = "head";
  } else if (label.startsWith("tag: ")) {
    type = "tag";
    label = label.replace("tag: ", "").trim();
  } else if (label.includes("/")) {
    type = "remote";
  }
  return { type, label, isHead, raw: refStr };
}

export function parseGraphRow(rawLine) {
  const parts = rawLine.split("\t");
  if (parts.length < 2) {
    return {
      isCommit: false,
      graph: rawLine,
      hash: null,
      parents: [],
      refs: [],
      badges: [],
      subject: "",
      relDate: "",
      author: "",
    };
  }

  const part0 = parts[0];
  const hashIdx = part0.lastIndexOf(" ");
  let graph = "";
  let hash = "";
  if (hashIdx >= 0) {
    graph = part0.slice(0, hashIdx);
    hash = part0.slice(hashIdx + 1);
  } else {
    hash = part0;
  }

  const isCommit = /^[0-9a-fA-F]{4,40}$/.test(hash);
  if (!isCommit) {
    return {
      isCommit: false,
      graph: parts[0] || rawLine,
      hash: null,
      parents: [],
      refs: [],
      badges: [],
      subject: "",
      relDate: "",
      author: "",
    };
  }

  const parents = (parts[1] || "").split(" ").filter(Boolean);
  const rawRefs = (parts[2] || "").trim();
  const refs = [];
  const badges = [];
  if (rawRefs.startsWith("(") && rawRefs.endsWith(")")) {
    const inner = rawRefs.slice(1, -1);
    for (const r of inner.split(", ")) {
      const trimmed = r.trim();
      if (trimmed) {
        refs.push(trimmed);
        badges.push(parseRefBadge(trimmed));
      }
    }
  }

  const subject = parts[3] || "";
  const relDate = parts[4] || "";
  const author = parts[5] || "";

  return {
    isCommit: true,
    graph: graph || "*",
    hash,
    parents,
    refs,
    badges,
    subject,
    relDate,
    author,
  };
}

export async function getGitGraph(cwd, on, limit = 50) {
  if (!cwd) return { rows: [], error: "No folder" };

  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const fmt = `--format=format:%h%x09%p%x09%d%x09%s%x09%cr%x09%an`;

  // 1. Try full graph with all refs and date order
  let res = await exec("git", [
    ...READ_FLAGS,
    "log",
    "--graph",
    "--all",
    "--date-order",
    fmt,
    "-n",
    String(limit),
  ], { cwd: repoCwd, on });

  // 2. Fallback to HEAD and local branches
  if (res.code !== 0) {
    res = await exec("git", [
      ...READ_FLAGS,
      "log",
      "--graph",
      "HEAD",
      "--branches",
      "--date-order",
      fmt,
      "-n",
      String(limit),
    ], { cwd: repoCwd, on });
  }

  // 3. Fallback to current HEAD only
  if (res.code !== 0) {
    res = await exec("git", [
      ...READ_FLAGS,
      "log",
      "--graph",
      "HEAD",
      fmt,
      "-n",
      String(limit),
    ], { cwd: repoCwd, on });
  }

  if (res.code !== 0) {
    return { rows: [], error: res.stderr || "Failed to load log graph" };
  }

  const lines = res.stdout.split("\n");
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseGraphRow(line));
  }

  return { rows, error: null };
}

export async function getCommitFiles(cwd, on, hash) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const res = await exec("git", [...READ_FLAGS, "show", "--numstat", "--format=", hash], { cwd: repoCwd, on });
  if (res.code !== 0) return [];
  const files = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...p] = line.split("\t");
    files.push({
      path: p.join("\t"),
      add: Number(a) || 0,
      del: Number(d) || 0,
      binary: a === "-",
    });
  }
  return files;
}

const sanitizeDiffLines = (lines) =>
  lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (truncated)" : l));

export async function getFileDiff(cwd, on, path, staged = false, fresh = false) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;

  if (fresh && !staged) {
    try {
      const text = await readTextFile(`${repoCwd}/${path}`, { on });
      if (text !== null && text !== undefined) {
        if (text.includes("\0")) return ["Binary file · no text diff"];
        const rawLines = text.slice(0, 400000).replace(/\n$/, "").split("\n");
        const count = rawLines.length;
        return sanitizeDiffLines([
          `@@ -0,0 +1,${count} @@`,
          ...rawLines.map((l) => `+${l}`),
        ]);
      }
    } catch {}
  }

  const args = staged
    ? ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", path]
    : ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
  const res = await exec("git", [...READ_FLAGS, ...args], { cwd: repoCwd, on });
  if (res.code !== 0) return ["Error loading diff: " + res.stderr];
  const all = res.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) {
    return sanitizeDiffLines(all.length && all[0] ? all : ["No text diff available"]);
  }
  return sanitizeDiffLines(all.slice(first));
}

export async function getCommitDiff(cwd, on, hash, path) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const args = path
    ? ["show", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--", path]
    : ["show", "--no-ext-diff", "--no-textconv", "--no-color", hash];
  const res = await exec("git", [...READ_FLAGS, ...args], { cwd: repoCwd, on });
  if (res.code !== 0) return ["Error loading commit diff: " + res.stderr];
  const all = res.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  return sanitizeDiffLines(first < 0 ? all : all.slice(first));
}

// Git Mutation Operations
export async function gitStageFile(cwd, on, path) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["add", "--", path], { cwd: repoCwd, on });
}

export async function gitUnstageFile(cwd, on, path) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["reset", "HEAD", "--", path], { cwd: repoCwd, on });
}

export async function gitDiscardFile(cwd, on, path, isUntracked = false) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  if (isUntracked) {
    return exec("rm", ["-f", path], { cwd: repoCwd, on });
  }
  return exec("git", ["checkout", "--", path], { cwd: repoCwd, on });
}

export async function gitStageAll(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["add", "-A"], { cwd: repoCwd, on });
}

export async function gitUnstageAll(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["reset", "HEAD"], { cwd: repoCwd, on });
}

export async function gitCommit(cwd, on, message) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["commit", "-m", message], { cwd: repoCwd, on });
}

export async function gitPush(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["push"], { cwd: repoCwd, on });
}

export async function gitPull(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["pull"], { cwd: repoCwd, on });
}

export async function gitFetch(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["fetch"], { cwd: repoCwd, on });
}

export async function gitStash(cwd, on, message = "Herdr stash") {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["stash", "push", "-m", message], { cwd: repoCwd, on });
}

export async function gitStashPop(cwd, on) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["stash", "pop"], { cwd: repoCwd, on });
}

export async function gitStashApply(cwd, on, stashId) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const args = stashId ? ["stash", "apply", stashId] : ["stash", "apply"];
  return exec("git", args, { cwd: repoCwd, on });
}

export async function gitStashDrop(cwd, on, stashId) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const args = stashId ? ["stash", "drop", stashId] : ["stash", "drop"];
  return exec("git", args, { cwd: repoCwd, on });
}

export async function gitCheckout(cwd, on, branch) {
  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  return exec("git", ["checkout", branch], { cwd: repoCwd, on });
}

export async function getGitRefs(cwd, on) {
  if (!cwd) return { branches: [], remotes: [], tags: [], stashes: [], error: "No folder" };

  const repoCwd = (await resolveRepoRoot(cwd, on)) || cwd;
  const git = (args) => exec("git", [...READ_FLAGS, ...args], { cwd: repoCwd, on });

  const [branchesRes, remotesRes, tagsRes, stashesRes] = await Promise.all([
    git(["for-each-ref", "--format=%(refname:short)\t%(upstream:track)\t%(HEAD)", "refs/heads"]).catch(() => ({ code: 1, stdout: "" })),
    git(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).catch(() => ({ code: 1, stdout: "" })),
    git(["tag", "--list", "--sort=-creatordate", "-n1"]).catch(() => ({ code: 1, stdout: "" })),
    git(["stash", "list"]).catch(() => ({ code: 1, stdout: "" })),
  ]);

  const branches = [];
  if (branchesRes.code === 0 && branchesRes.stdout) {
    for (const line of branchesRes.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, track, headMarker] = line.split("\t");
      let ahead = 0;
      let behind = 0;
      if (track) {
        const aheadMatch = /ahead\s+(\d+)/.exec(track);
        const behindMatch = /behind\s+(\d+)/.exec(track);
        if (aheadMatch) ahead = Number(aheadMatch[1]);
        if (behindMatch) behind = Number(behindMatch[1]);
      }
      branches.push({
        name: (name || "").trim(),
        ahead,
        behind,
        isCurrent: (headMarker || "").trim() === "*",
      });
    }
  }

  const remotes = [];
  if (remotesRes.code === 0 && remotesRes.stdout) {
    for (const line of remotesRes.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.endsWith("/HEAD")) continue;
      const parts = trimmed.split("/");
      const remote = parts[0];
      const branch = parts.slice(1).join("/");
      remotes.push({ name: trimmed, remote, branch });
    }
  }

  const tags = [];
  if (tagsRes.code === 0 && tagsRes.stdout) {
    for (const line of tagsRes.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tagName = trimmed.split(/\s+/)[0];
      if (tagName && !tags.some((t) => t.name === tagName)) {
        tags.push({ name: tagName });
      }
      if (tags.length >= 25) break;
    }
  }

  const stashes = [];
  if (stashesRes.code === 0 && stashesRes.stdout) {
    for (const line of stashesRes.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      const id = colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
      const message = colonIdx > 0 ? trimmed.slice(colonIdx + 1).trim() : "";
      stashes.push({ id, message });
      if (stashes.length >= 25) break;
    }
  }

  return { branches, remotes, tags, stashes, error: null };
}
