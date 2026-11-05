/**
 * Filesystem actions for Enhanced Files mod.
 * Supports file/folder creation, rename, move, delete (with Trash), copy, and Path Finder reveal.
 */

/**
 * Sanitizes and normalizes relative path. Prevents root escaping.
 * @param {string} path
 * @returns {string}
 */
export function cleanRelativePath(path) {
  if (!path || typeof path !== "string") return "";
  const parts = path.trim().replace(/^[\/\\]+/, "").split(/[\/\\]+/);
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

/**
 * Generates duplicate name (e.g. "foo copy.js" or "foo copy 2.js").
 * @param {string[]} existingNames
 * @param {string} originalName
 * @returns {string}
 */
export function generateCopyName(existingNames, originalName) {
  const set = new Set(existingNames || []);
  const dotIdx = originalName.lastIndexOf(".");
  const base = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  const ext = dotIdx > 0 ? originalName.slice(dotIdx) : "";

  let candidate = `${base} copy${ext}`;
  if (!set.has(candidate)) return candidate;

  let counter = 2;
  while (set.has(`${base} copy ${counter}${ext}`)) {
    counter++;
  }
  return `${base} copy ${counter}${ext}`;
}

/**
 * Creates a new file at root + relativePath.
 */
export async function createFile(root, relativePath, execFn, options = {}) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) throw new Error("檔名不得為空");
  const fullPath = `${root}/${clean}`;

  const script = `dir=$(dirname "$1"); mkdir -p "$dir" && touch "$1"`;
  const res = await execFn("sh", ["-c", script, "sh", fullPath], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `無法建立檔案: ${clean}`);
  }
  return { ok: true, path: clean, fullPath };
}

/**
 * Creates a new folder at root + relativePath.
 */
export async function createFolder(root, relativePath, execFn, options = {}) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) throw new Error("資料夾名稱不得為空");
  const fullPath = `${root}/${clean}`;

  const script = `mkdir -p "$1"`;
  const res = await execFn("sh", ["-c", script, "sh", fullPath], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `無法建立資料夾: ${clean}`);
  }
  return { ok: true, path: clean, fullPath };
}

/**
 * Renames a file or folder.
 */
export async function renamePath(root, oldRelPath, newRelPath, execFn, options = {}) {
  const cleanOld = cleanRelativePath(oldRelPath);
  const cleanNew = cleanRelativePath(newRelPath);
  if (!cleanOld || !cleanNew) throw new Error("路徑不得為空");
  if (cleanOld === cleanNew) return { ok: true, oldPath: cleanOld, newPath: cleanNew };

  const oldFull = `${root}/${cleanOld}`;
  const newFull = `${root}/${cleanNew}`;

  const script = `dir=$(dirname "$2"); mkdir -p "$dir" && mv "$1" "$2"`;
  const res = await execFn("sh", ["-c", script, "sh", oldFull, newFull], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `重新命名失敗: ${cleanOld} -> ${cleanNew}`);
  }
  return { ok: true, oldPath: cleanOld, newPath: cleanNew };
}

/**
 * Deletes a file or directory (uses macOS trash if available, fallback to rm -rf).
 */
export async function deletePath(root, relativePath, execFn, options = {}) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) throw new Error("路徑不得為空");
  const fullPath = `${root}/${clean}`;

  // Try /usr/bin/trash first on macOS, fallback to rm -rf
  const script = `
    if command -v trash >/dev/null 2>&1; then
      trash "$1"
    else
      rm -rf "$1"
    fi
  `;
  const res = await execFn("sh", ["-c", script, "sh", fullPath], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `刪除失敗: ${clean}`);
  }
  return { ok: true, path: clean };
}

/**
 * Copies a file or directory to a destination.
 */
export async function copyPath(root, srcRelPath, dstRelPath, execFn, options = {}) {
  const cleanSrc = cleanRelativePath(srcRelPath);
  const cleanDst = cleanRelativePath(dstRelPath);
  if (!cleanSrc || !cleanDst) throw new Error("來源或目標路徑不得為空");

  const srcFull = `${root}/${cleanSrc}`;
  const dstFull = `${root}/${cleanDst}`;

  const script = `dir=$(dirname "$2"); mkdir -p "$dir" && cp -R "$1" "$2"`;
  const res = await execFn("sh", ["-c", script, "sh", srcFull, dstFull], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `複製失敗: ${cleanSrc} -> ${cleanDst}`);
  }
  return { ok: true, src: cleanSrc, dst: cleanDst };
}

/**
 * Moves a file or directory to a destination folder or path.
 */
export async function movePath(root, srcRelPath, dstRelPath, execFn, options = {}) {
  const cleanSrc = cleanRelativePath(srcRelPath);
  const cleanDst = cleanRelativePath(dstRelPath);
  if (!cleanSrc || !cleanDst) throw new Error("來源或目標路徑不得為空");
  if (cleanSrc === cleanDst) return { ok: true, src: cleanSrc, dst: cleanDst };

  const srcFull = `${root}/${cleanSrc}`;
  const dstFull = `${root}/${cleanDst}`;

  const script = `dir=$(dirname "$2"); mkdir -p "$dir" && mv "$1" "$2"`;
  const res = await execFn("sh", ["-c", script, "sh", srcFull, dstFull], options);
  if (res && res.code !== 0) {
    throw new Error(res.stderr || `搬移失敗: ${cleanSrc} -> ${cleanDst}`);
  }
  return { ok: true, src: cleanSrc, dst: cleanDst };
}

/**
 * Reveals file or directory in Path Finder with fallback to default Finder.
 */
export async function revealInPathFinder(fullPath, execFn, options = {}) {
  const script = `
    osascript -e '
      tell application "Path Finder"
        reveal (POSIX file "'"$1"'" as alias)
        activate
      end tell
    ' 2>/dev/null || open -R "$1"
  `;
  const res = await execFn("sh", ["-c", script, "sh", fullPath], options).catch(() => null);
  return { ok: res?.code === 0 };
}
