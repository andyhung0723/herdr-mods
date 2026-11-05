// Git Service & Parser for Herdr Enhanced Git mod
import { spaces, panes, focused, exec, readTextFile } from "herdr";

const READ_FLAGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

export function resolveLocation() {
  const allSpaces = spaces() || [];
  const allPanes = panes() || [];
  const f = focused() || {};

  const activeSpace = allSpaces.find((s) => s.active);
  let pane = null;
  if (f.pane) {
    pane = allPanes.find((p) => p.pane === f.pane);
  }
  if (!pane && activeSpace) {
    pane = allPanes.find((p) => p.space === activeSpace.id);
  }

  const cwd = pane?.cwd || f.cwd || activeSpace?.folder || activeSpace?.cwd || null;
  const on = f.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : activeSpace?.machine ?? null;

  return { cwd, on };
}

export function parseBranchHeader(rawHeader) {
  let branch = "HEAD";
  let upstream = null;
  let ahead = 0;
  let behind = 0;

  const content = rawHeader.replace(/^##\s*/, "").trim();
  if (content.startsWith("No commits yet on ")) {
    branch = content.replace("No commits yet on ", "");
    return { branch, upstream, ahead, behind };
  }
  if (content.startsWith("Initial commit on ")) {
    branch = content.replace("Initial commit on ", "");
    return { branch, upstream, ahead, behind };
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

  return { branch, upstream, ahead, behind };
}

export async function getGitStatus(cwd, on) {
  if (!cwd) return { isRepo: false, error: "No folder" };

  const topRes = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (topRes.code !== 0) {
    return { isRepo: false, error: "Not a git repository" };
  }
  const root = topRes.stdout.trim();
  const git = (args) => exec("git", [...READ_FLAGS, ...args], { cwd: root, on });

  const statusRes = await git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]);
  if (statusRes.code !== 0) {
    return { isRepo: true, root, error: statusRes.stderr || "Status check failed" };
  }

  const entries = statusRes.stdout.split("\0").filter(Boolean);
  const branchHeader = entries[0] || "## HEAD";
  const { branch, upstream, ahead, behind } = parseBranchHeader(branchHeader);

  // Check stats via numstat
  const headRes = await git(["rev-parse", "--verify", "HEAD"]);
  const hasHead = headRes.code === 0;

  const stats = {};
  try {
    const numstatCmd = hasHead
      ? [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])]
      : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"])];

    for (const res of numstatCmd) {
      if (res.code === 0 && res.stdout) {
        for (const item of res.stdout.split("\0")) {
          const [a, d, ...pathParts] = item.split("\t");
          if (!pathParts.length) continue;
          const p = pathParts.join("\t");
          const old = stats[p] ?? { add: 0, del: 0 };
          stats[p] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0) };
        }
      }
    }
  } catch {}

  const stagedFiles = [];
  const unstagedFiles = [];

  for (const entry of entries.slice(1)) {
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

export function parseGraphRow(rawLine) {
  const parts = rawLine.split("\t");
  if (parts.length < 2) {
    // Pure graph line connecting branches, e.g. "| \", "|/", "| |"
    return {
      isCommit: false,
      graph: rawLine,
      hash: null,
      parents: [],
      refs: [],
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
      subject: "",
      relDate: "",
      author: "",
    };
  }

  const parents = (parts[1] || "").split(" ").filter(Boolean);
  const rawRefs = (parts[2] || "").trim();
  const refs = [];
  if (rawRefs.startsWith("(") && rawRefs.endsWith(")")) {
    const inner = rawRefs.slice(1, -1);
    for (const r of inner.split(", ")) {
      const trimmed = r.trim();
      if (trimmed) refs.push(trimmed);
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
    subject,
    relDate,
    author,
  };
}

export async function getGitGraph(cwd, on, limit = 50) {
  if (!cwd) return { rows: [], error: "No folder" };

  // Resolve to repository root if possible
  let repoCwd = cwd;
  try {
    const topRes = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (topRes.code === 0 && topRes.stdout.trim()) {
      repoCwd = topRes.stdout.trim();
    }
  } catch {}

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

  // 2. If --all fails (e.g. huge DAG, invalid remote ref), fallback to HEAD and local branches
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

  // 3. If still fails, fallback to current HEAD only
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
  const res = await exec("git", [...READ_FLAGS, "show", "--numstat", "--format=", hash], { cwd, on });
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

export async function getFileDiff(cwd, on, path, staged = false) {
  const args = staged
    ? ["diff", "--cached", "--no-color", "--", path]
    : ["diff", "--no-color", "--", path];
  const res = await exec("git", [...READ_FLAGS, ...args], { cwd, on });
  if (res.code !== 0) return ["Error loading diff: " + res.stderr];
  const all = res.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) {
    return all.length && all[0] ? all : ["No changes detected"];
  }
  return all.slice(first);
}

export async function getCommitDiff(cwd, on, hash, path) {
  const args = path
    ? ["show", "--no-color", hash, "--", path]
    : ["show", "--no-color", hash];
  const res = await exec("git", [...READ_FLAGS, ...args], { cwd, on });
  if (res.code !== 0) return ["Error loading commit diff: " + res.stderr];
  const all = res.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? all : all.slice(first);
}

// Git Mutation Operations
export async function gitStageFile(cwd, on, path) {
  return exec("git", ["add", "--", path], { cwd, on });
}

export async function gitUnstageFile(cwd, on, path) {
  return exec("git", ["reset", "HEAD", "--", path], { cwd, on });
}

export async function gitDiscardFile(cwd, on, path, isUntracked = false) {
  if (isUntracked) {
    return exec("rm", ["-f", path], { cwd, on });
  }
  return exec("git", ["checkout", "--", path], { cwd, on });
}

export async function gitStageAll(cwd, on) {
  return exec("git", ["add", "-A"], { cwd, on });
}

export async function gitUnstageAll(cwd, on) {
  return exec("git", ["reset", "HEAD"], { cwd, on });
}

export async function gitCommit(cwd, on, message) {
  return exec("git", ["commit", "-m", message], { cwd, on });
}

export async function gitPush(cwd, on) {
  return exec("git", ["push"], { cwd, on });
}

export async function gitPull(cwd, on) {
  return exec("git", ["pull"], { cwd, on });
}

export async function gitFetch(cwd, on) {
  return exec("git", ["fetch"], { cwd, on });
}

export async function gitStash(cwd, on, message = "Herdr stash") {
  return exec("git", ["stash", "push", "-m", message], { cwd, on });
}

export async function gitStashPop(cwd, on) {
  return exec("git", ["stash", "pop"], { cwd, on });
}
