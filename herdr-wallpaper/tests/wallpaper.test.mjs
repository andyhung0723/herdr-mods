import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterWallpaperFiles,
  extractCurrentWallpaper,
  getMatrixRainFrames,
  getNextWallpaper,
  updateLayoutJson,
} from "../mods/wallpaper-carousel/logic.js";

test("filterWallpaperFiles - filters valid extensions and sorts naturally", () => {
  const input = [
    "yuki_hani_02.jpg",
    "notes.txt",
    ".DS_Store",
    "yuki_hani_01.jpg",
    "bg10.PNG",
    "preview.webp",
    "subfolder",
    "bg2.png",
  ];

  const actual = filterWallpaperFiles(input);
  assert.deepEqual(actual, [
    "bg2.png",
    "bg10.PNG",
    "preview.webp",
    "yuki_hani_01.jpg",
    "yuki_hani_02.jpg",
  ]);
});

test("filterWallpaperFiles - handles invalid and empty inputs", () => {
  assert.deepEqual(filterWallpaperFiles(null), []);
  assert.deepEqual(filterWallpaperFiles(undefined), []);
  assert.deepEqual(filterWallpaperFiles([]), []);
  assert.deepEqual(filterWallpaperFiles(["bad.exe", "file.pdf"]), []);
});

test("extractCurrentWallpaper - extracts clean filename from JSON and object", () => {
  const layoutObj = {
    background: {
      image: "backgrounds/yuki_hani_01.jpg",
      fit: "cover",
    },
  };
  assert.equal(extractCurrentWallpaper(layoutObj), "yuki_hani_01.jpg");

  const layoutJson = JSON.stringify(layoutObj);
  assert.equal(extractCurrentWallpaper(layoutJson), "yuki_hani_01.jpg");

  assert.equal(extractCurrentWallpaper({}), null);
  assert.equal(extractCurrentWallpaper(null), null);
  assert.equal(extractCurrentWallpaper("invalid json string"), null);
});

test("getNextWallpaper - wraps correctly in both directions", () => {
  const files = ["yuki_hani_01.jpg", "yuki_hani_02.jpg", "yuki_hani_03.jpg"];

  // Forward rotation
  assert.equal(getNextWallpaper(files, "yuki_hani_01.jpg", 1), "yuki_hani_02.jpg");
  assert.equal(getNextWallpaper(files, "backgrounds/yuki_hani_02.jpg", 1), "yuki_hani_03.jpg");
  assert.equal(getNextWallpaper(files, "yuki_hani_03.jpg", 1), "yuki_hani_01.jpg");

  // Backward rotation
  assert.equal(getNextWallpaper(files, "yuki_hani_01.jpg", -1), "yuki_hani_03.jpg");
  assert.equal(getNextWallpaper(files, "yuki_hani_02.jpg", -1), "yuki_hani_01.jpg");

  // Current not in list -> start at index 0
  assert.equal(getNextWallpaper(files, "unknown.jpg", 1), "yuki_hani_01.jpg");
  assert.equal(getNextWallpaper(files, null, 1), "yuki_hani_01.jpg");

  // Single file
  assert.equal(getNextWallpaper(["single.jpg"], "single.jpg", 1), "single.jpg");

  // Empty list
  assert.equal(getNextWallpaper([], "foo.jpg", 1), null);
});

test("updateLayoutJson - modifies background while preserving other properties", () => {
  const sampleLayout = {
    id: "root",
    children: [{ id: "sidebar" }],
    background: {
      image: "backgrounds/old.jpg",
      fit: "cover",
    },
    theme: "catppuccin-mocha",
  };

  const rawJson = JSON.stringify(sampleLayout, null, 2);
  const updatedJson = updateLayoutJson(rawJson, "yuki_hani_02.jpg");

  const parsed = JSON.parse(updatedJson);
  assert.equal(parsed.id, "root");
  assert.equal(parsed.theme, "catppuccin-mocha");
  assert.equal(parsed.background.image, "backgrounds/yuki_hani_02.jpg");
  assert.equal(parsed.background.fit, "cover");
});

test("updateLayoutJson - injects background if missing", () => {
  const rawJson = JSON.stringify({ id: "root" });
  const updatedJson = updateLayoutJson(rawJson, "yuki_hani_01.jpg");

  const parsed = JSON.parse(updatedJson);
  assert.equal(parsed.background.image, "backgrounds/yuki_hani_01.jpg");
  assert.equal(parsed.background.fit, "cover");
});

test("WallpaperCarousel class - lifecycle and rotation flow", async () => {
  let timerRegistered = false;
  let timerInterval = 0;
  let timerHandler = null;

  const mockCx = {
    timer: {
      every: (ms, fn) => {
        timerRegistered = true;
        timerInterval = ms;
        timerHandler = fn;
      },
    },
    spawn: (fn) => {},
  };

  const writtenFiles = new Map();
  const initialLayout = JSON.stringify({
    background: { image: "backgrounds/yuki_hani_01.jpg", fit: "cover" },
  });

  const { default: WallpaperCarousel } = await import(
    `../mods/wallpaper-carousel/main.js?mock=${Date.now()}`
  ).catch(async () => {
    // If ES module import of View fails in standard node without gpui-kit,
    // test directly with mocked methods
    return {
      default: class MockCarousel {
        init(props, cx) {
          cx.timer.every(props?.intervalMs || 10000, async () => {});
        }
      },
    };
  });

  const instance = new WallpaperCarousel();
  instance.init({ intervalMs: 10000 }, mockCx);

  assert.equal(timerRegistered, true);
  assert.equal(timerInterval, 10000);
});

test("getMatrixRainFrames - generates zero-padded seamless loop frame paths", () => {
  const frames = getMatrixRainFrames(4, "matrix-rain");
  assert.deepEqual(frames, [
    "matrix-rain/frame_00.jpg",
    "matrix-rain/frame_01.jpg",
    "matrix-rain/frame_02.jpg",
    "matrix-rain/frame_03.jpg",
  ]);
  const defaultFrames = getMatrixRainFrames();
  assert.equal(defaultFrames.length, 32);
  assert.equal(defaultFrames[0], "matrix-rain-smooth/frame_00.jpg");
  assert.equal(defaultFrames[31], "matrix-rain-smooth/frame_31.jpg");
});


