/**
 * Pure static Liquid Glass wallpaper and layout helper functions.
 */

export const DEFAULT_GLASS_IMAGE = "backgrounds/liquid_glass.jpg";
export const LIQUID_GLASS_THEME = "liquid-glass";

/**
 * Normalizes a background image path under backgrounds/.
 * @param {string|null|undefined} imagePath
 * @returns {string}
 */
export function normalizeBackgroundPath(imagePath) {
  const clean = typeof imagePath === "string" ? imagePath.trim() : "";
  if (!clean) return DEFAULT_GLASS_IMAGE;
  return clean.startsWith("backgrounds/") ? clean : `backgrounds/${clean}`;
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
 * Updates layout JSON string to use the static Liquid Glass wallpaper and theme
 * while removing any legacy wallpaper-carousel-controller node.
 * @param {string} layoutJsonString
 * @param {string} [wallpaperFilename="liquid_glass.jpg"]
 * @returns {string}
 */
export function updateLayoutJson(layoutJsonString, wallpaperFilename = "liquid_glass.jpg") {
  if (typeof layoutJsonString !== "string" || !layoutJsonString.trim()) {
    throw new Error("Invalid layout JSON string");
  }
  if (!wallpaperFilename || typeof wallpaperFilename !== "string") {
    throw new Error("Invalid wallpaper filename");
  }

  const parsed = JSON.parse(layoutJsonString);
  const cleanName = wallpaperFilename.replace(/^backgrounds\//, "").trim();

  parsed.background = {
    image: `backgrounds/${cleanName}`,
    fit: "cover",
  };
  parsed.theme = {
    light: LIQUID_GLASS_THEME,
    dark: LIQUID_GLASS_THEME,
  };

  function stripController(node) {
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) return;
    node.children = node.children.filter((child) => {
      if (!child || typeof child !== "object") return true;
      return (
        child.id !== "wallpaper-carousel-controller" &&
        child.content?.mod !== "wallpaper-carousel"
      );
    });
    for (const child of node.children) {
      stripController(child);
    }
  }
  stripController(parsed);

  return JSON.stringify(parsed, null, 2);
}
