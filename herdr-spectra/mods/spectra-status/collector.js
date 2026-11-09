// Spectra (SDD) data collector for Herdr — read-only.
// Wraps the `spectra` CLI JSON output and parses tasks.md checklists.
// Supports both OpenSpec (`openspec/`) and Spectra v3 (`.spectra.yaml` / `docs/spectra/`).
import { home, exec, readTextFile } from "herdr";

const rootCache = new Map(); // cwd -> root | null
const specDirCache = new Map(); // root -> relative spec_dir (e.g. "docs/spectra" or "openspec")
let spectraBin = null;

/** Resolves the spectra CLI path (GUI apps may not have ~/.local/bin in PATH). */
export async function resolveSpectraBin() {
  if (spectraBin) return spectraBin;
  const candidates = [
    `${home()}/.local/bin/spectra`,
    "/Applications/Spectra.app/Contents/MacOS/spectra",
    "/opt/homebrew/bin/spectra",
    "/usr/local/bin/spectra",
  ];
  for (const bin of candidates) {
    const res = await exec("test", ["-x", bin]).catch(() => null);
    if (res?.code === 0) {
      spectraBin = bin;
      return bin;
    }
  }
  spectraBin = "spectra";
  return spectraBin;
}

function parentDir(dir) {
  const trimmed = dir.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return null;
  return trimmed.slice(0, idx);
}

export function basename(path) {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function parseSpecDirFromYaml(yamlText) {
  if (!yamlText) return null;
  for (const line of String(yamlText).split(/\r?\n/)) {
    const m = line.match(/^\s*spec_dir\s*:\s*([^\s#]+)\s*/);
    if (m && m[1]) {
      return m[1].replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
    }
  }
  return null;
}

/** Resolves the relative spec directory for a Spectra project root (`docs/spectra` or `openspec`). */
export async function resolveSpecDir(root) {
  if (!root) return "openspec";
  if (specDirCache.has(root)) return specDirCache.get(root);

  const yaml = await readTextFile(`${root}/.spectra.yaml`).catch(() => null);
  const fromYaml = parseSpecDirFromYaml(yaml);
  if (fromYaml) {
    specDirCache.set(root, fromYaml);
    return fromYaml;
  }

  const hasOpenspec = await exec("test", ["-d", `${root}/openspec`]).catch(() => null);
  if (hasOpenspec?.code === 0) {
    specDirCache.set(root, "openspec");
    return "openspec";
  }

  const hasDocsSpectra = await exec("test", ["-d", `${root}/docs/spectra`]).catch(() => null);
  if (hasDocsSpectra?.code === 0) {
    specDirCache.set(root, "docs/spectra");
    return "docs/spectra";
  }

  specDirCache.set(root, "openspec");
  return "openspec";
}

async function isSpectraDir(dir) {
  const yaml = await readTextFile(`${dir}/.spectra.yaml`).catch(() => null);
  if (yaml !== null && yaml !== undefined) {
    const parsed = parseSpecDirFromYaml(yaml);
    if (parsed) specDirCache.set(dir, parsed);
    return true;
  }
  for (const rel of ["openspec", "docs/spectra", ".spectra"]) {
    const res = await exec("test", ["-d", `${dir}/${rel}`]).catch(() => null);
    if (res?.code === 0) {
      if (rel === "openspec" || rel === "docs/spectra") {
        specDirCache.set(dir, rel);
      }
      return true;
    }
  }
  return false;
}

/**
 * Walks up from cwd to find the nearest Spectra project root
 * (`.spectra.yaml`, `openspec/`, `docs/spectra/`, or `.spectra/`).
 * If not found walking up, probes immediate child directories of cwd.
 */
export async function findSpectraRoot(cwd) {
  if (!cwd) return null;
  if (rootCache.has(cwd)) return rootCache.get(cwd);

  const h = home();
  const cleanCwd = cwd.replace(/\/+$/, "");
  let dir = cleanCwd;
  let found = null;

  for (let i = 0; dir && i < 12; i++) {
    if (dir !== h && (await isSpectraDir(dir))) {
      found = dir;
      break;
    }
    if (dir === h || dir === "/") break;
    dir = parentDir(dir);
  }

  // Fallback: if cwd is a workspace container folder (e.g. jira-discuss/ containing dsc-project-hub/),
  // probe immediate subdirectories one level deep.
  if (!found && cleanCwd && cleanCwd !== h) {
    const probe = await exec("sh", [
      "-c",
      'for d in "$1"/*; do [ -d "$d" ] || continue; if [ -f "$d/.spectra.yaml" ] || [ -d "$d/openspec" ] || [ -d "$d/docs/spectra" ] || [ -d "$d/.spectra" ]; then printf "%s" "$d"; exit 0; fi; done; exit 1',
      "sh",
      cleanCwd,
    ]).catch(() => null);
    if (probe?.code === 0 && probe?.stdout?.trim()) {
      found = probe.stdout.trim();
    }
  }

  rootCache.set(cwd, found);
  return found;
}

export function clearRootCache() {
  rootCache.clear();
  specDirCache.clear();
}

async function spectraJson(root, args) {
  const bin = await resolveSpectraBin();
  const res = await exec(bin, [...args, "--json", "--no-color"], { cwd: root, timeout: 8000 }).catch(
    (err) => ({ code: -1, stdout: "", stderr: String(err) })
  );
  if (res?.code !== 0 || !res?.stdout?.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function normalizeChange(c, parked = false) {
  const total = Number(c.totalTasks) || 0;
  const done = Number(c.completedTasks) || 0;
  return {
    name: c.name,
    status: parked ? "parked" : c.status || (total > 0 && done >= total ? "done" : "in-progress"),
    summary: c.summary || "",
    completedTasks: done,
    totalTasks: total,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
    parked,
  };
}

/** Picks the change that is most likely being worked on (list is sorted by modified). */
export function pickFocusChange(changes) {
  if (!changes?.length) return null;
  return (
    changes.find((c) => c.status === "in-progress" && c.completedTasks > 0 && c.completedTasks < c.totalTasks) ??
    changes.find((c) => c.status !== "done" && c.completedTasks < c.totalTasks) ??
    changes[0]
  );
}

/** Lightweight overview: changes, parked changes, and specs. */
export async function collectOverview(root) {
  if (!root) return { root: null, available: false };

  const [specDir, list, parkedList, specsList] = await Promise.all([
    resolveSpecDir(root),
    spectraJson(root, ["list", "--changes"]),
    spectraJson(root, ["list", "--parked"]),
    spectraJson(root, ["list", "--specs"]),
  ]);

  if (!list && !specsList) {
    return {
      root,
      specDir,
      project: basename(root),
      available: false,
      error: "spectra CLI unavailable or failed",
    };
  }

  const changes = (list?.changes ?? []).map((c) => normalizeChange(c));
  const parked = (parkedList?.parked ?? []).map((c) => normalizeChange(c, true));
  const specs = (specsList?.specs ?? []).map((s) => ({ id: s.id, path: s.path }));

  const active = changes.filter((c) => c.status !== "done");
  const done = changes.filter((c) => c.status === "done");

  return {
    root,
    specDir,
    project: basename(root),
    available: true,
    changes,
    parked,
    specs,
    counts: {
      active: active.length,
      done: done.length,
      parked: parked.length,
      specs: specs.length,
    },
    focus: pickFocusChange(changes),
    updatedAt: Date.now(),
  };
}

/** Parses tasks.md into sections of checklist items. */
export function parseTasksMarkdown(md) {
  const sections = [];
  let current = null;
  if (!md) return sections;

  for (const rawLine of md.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], tasks: [] };
      sections.push(current);
      continue;
    }
    const task = rawLine.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/);
    if (task) {
      if (!current) {
        current = { title: "Tasks", tasks: [] };
        sections.push(current);
      }
      const text = task[2];
      const idMatch = text.match(/^(\d+(?:\.\d+)*)\s+(.*)$/);
      current.tasks.push({
        done: task[1].toLowerCase() === "x",
        id: idMatch ? idMatch[1] : "",
        text: idMatch ? idMatch[2] : text,
      });
    }
  }

  return sections
    .filter((s) => s.tasks.length > 0)
    .map((s) => ({
      ...s,
      completed: s.tasks.filter((t) => t.done).length,
      total: s.tasks.length,
    }));
}

/** Detailed info for one change: artifact DAG status + task checklist. */
export async function collectChangeDetail(root, name, parked = false) {
  if (!root || !name) return null;
  const specDir = await resolveSpecDir(root);
  const changeDir = parked ? null : `${root}/${specDir}/changes/${name}`;

  const [status, tasksMd] = await Promise.all([
    parked ? Promise.resolve(null) : spectraJson(root, ["status", "--change", name]),
    changeDir ? readTextFile(`${changeDir}/tasks.md`).catch(() => null) : Promise.resolve(null),
  ]);

  const artifacts = (status?.artifacts ?? []).map((a) => {
    const isGlob = String(a.outputPath || "").includes("*");
    return {
      id: a.id,
      status: a.status || "unknown",
      outputPath: a.outputPath,
      file: changeDir && !isGlob ? `${changeDir}/${a.outputPath}` : null,
    };
  });

  return {
    name,
    parked,
    changeDir,
    schema: status?.schemaName ?? null,
    isComplete: Boolean(status?.isComplete),
    artifacts,
    sections: parseTasksMarkdown(tasksMd),
    loadedAt: Date.now(),
  };
}
