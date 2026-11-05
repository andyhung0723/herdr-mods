/**
 * Pure wallpaper carousel logic for filtering, index computation, and layout transformation.
 */

/**
 * Filters and naturally sorts wallpaper image filenames.
 * Supports .jpg, .jpeg, .png, .webp, .bmp.
 * Ignores dotfiles, directories, non-images.
 * @param {string[]} fileList
 * @returns {string[]}
 */
export function filterWallpaperFiles(fileList) {
  if (!Array.isArray(fileList)) return [];
  const validExts = /\.(jpe?g|png|webp|bmp)$/i;
  return fileList
    .map((f) => (typeof f === "string" ? f.trim() : ""))
    .filter((f) => f.length > 0 && !f.startsWith(".") && validExts.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Extracts current wallpaper filename from layout JSON or parsed object.
 * @param {string|object|null} layoutInput
 * @returns {string|null}
 */
export function extractCurrentWallpaper(layoutInput) {
  if (!layoutInput) return null;
  let obj = layoutInput;
  if (typeof layoutInput === "string") {
    try {
      obj = JSON.parse(layoutInput);
    } catch {
      return null;
    }
  }
  const img = obj?.background?.image;
  if (!img || typeof img !== "string") return null;
  return img.replace(/^backgrounds\//, "").trim();
}

/**
 * Computes next or previous wallpaper filename from sorted list.
 * @param {string[]} files Sorted list of wallpaper filenames
 * @param {string|null} current Current wallpaper filename or relative path
 * @param {number} step Offset (+1 for next, -1 for prev)
 * @returns {string|null}
 */
export function getNextWallpaper(files, current, step = 1) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (files.length === 1) return files[0];

  const cleanCurrent = current ? current.replace(/^backgrounds\//, "").trim() : "";
  const currentIndex = files.indexOf(cleanCurrent);

  if (currentIndex === -1) {
    // Current not found in list -> start with first
    return files[0];
  }

  // Modulo wrap-around with support for negative steps
  const total = files.length;
  const nextIndex = ((currentIndex + step) % total + total) % total;
  return files[nextIndex];
}

/**
 * Updates layout JSON string with new wallpaper image path.
 * Returns formatted JSON string.
 * @param {string} layoutJsonString
 * @param {string} newWallpaperFilename
 * @returns {string}
 */
export function updateLayoutJson(layoutJsonString, newWallpaperFilename) {
  if (typeof layoutJsonString !== "string" || !layoutJsonString.trim()) {
    throw new Error("Invalid layout JSON string");
  }
  if (!newWallpaperFilename || typeof newWallpaperFilename !== "string") {
    throw new Error("Invalid wallpaper filename");
  }

  const parsed = JSON.parse(layoutJsonString);
  const cleanName = newWallpaperFilename.replace(/^backgrounds\//, "").trim();

  if (!parsed.background || typeof parsed.background !== "object") {
    parsed.background = {
      image: `backgrounds/${cleanName}`,
      fit: "cover",
    };
  } else {
    parsed.background.image = `backgrounds/${cleanName}`;
    if (!parsed.background.fit) {
      parsed.background.fit = "cover";
    }
  }

  return JSON.stringify(parsed, null, 2);
}
