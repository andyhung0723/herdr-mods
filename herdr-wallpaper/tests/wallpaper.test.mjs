import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GLASS_IMAGE,
  LIQUID_GLASS_THEME,
  extractCurrentWallpaper,
  normalizeBackgroundPath,
  updateLayoutJson,
} from "../mods/wallpaper-carousel/logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOD_DIR = path.resolve(__dirname, "../mods/wallpaper-carousel");

test("normalizeBackgroundPath - normalizes relative wallpaper paths", () => {
  assert.equal(normalizeBackgroundPath(null), DEFAULT_GLASS_IMAGE);
  assert.equal(normalizeBackgroundPath("  "), DEFAULT_GLASS_IMAGE);
  assert.equal(normalizeBackgroundPath("liquid_glass.jpg"), "backgrounds/liquid_glass.jpg");
  assert.equal(normalizeBackgroundPath("backgrounds/liquid_glass.jpg"), "backgrounds/liquid_glass.jpg");
});

test("extractCurrentWallpaper - extracts clean filename from JSON and object", () => {
  const layoutObj = {
    background: {
      image: "backgrounds/liquid_glass.jpg",
      fit: "cover",
    },
  };
  assert.equal(extractCurrentWallpaper(layoutObj), "liquid_glass.jpg");
  assert.equal(extractCurrentWallpaper(JSON.stringify(layoutObj)), "liquid_glass.jpg");
  assert.equal(extractCurrentWallpaper({}), null);
  assert.equal(extractCurrentWallpaper(null), null);
  assert.equal(extractCurrentWallpaper("invalid json"), null);
});

test("updateLayoutJson - sets static liquid_glass background/theme and strips carousel controller", () => {
  const sampleLayout = {
    id: "root",
    children: [
      { id: "sidebar" },
      {
        id: "work",
        children: [
          { id: "popup-terminal-controller", content: { mod: "popup-terminal" } },
          { id: "wallpaper-carousel-controller", content: { mod: "wallpaper-carousel" } },
          { id: "scratchpad-controller", content: { mod: "scratchpad" } },
        ],
      },
    ],
    background: { image: "backgrounds/old.jpg", fit: "cover" },
    theme: "catppuccin-mocha",
  };

  const updated = JSON.parse(updateLayoutJson(JSON.stringify(sampleLayout)));
  assert.equal(updated.background.image, "backgrounds/liquid_glass.jpg");
  assert.equal(updated.background.fit, "cover");
  assert.deepEqual(updated.theme, {
    light: LIQUID_GLASS_THEME,
    dark: LIQUID_GLASS_THEME,
  });

  const workIds = updated.children[1].children.map((c) => c.id);
  assert.deepEqual(workIds, ["popup-terminal-controller", "scratchpad-controller"]);
});

test("wallpaper-carousel main.js has no background timer or layout.set polling", () => {
  const src = fs.readFileSync(path.join(MOD_DIR, "main.js"), "utf8");
  assert.equal(src.includes("timer.every"), false);
  assert.equal(src.includes("layout.set"), false);
});
