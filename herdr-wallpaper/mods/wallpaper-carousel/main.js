import { View, div } from "gpui-kit";
import {
  appHome,
  exec,
  layout,
  nextCommand,
  notify,
  run,
  setShared,
  shared,
} from "herdr";
import {
  extractCurrentWallpaper,
  filterWallpaperFiles,
  getNextWallpaper,
} from "./logic.js";

const DEFAULT_INTERVAL_MS = 10000;
const SHARED_KEY_PAUSED = "wallpaper-carousel.paused";
const SHARED_KEY_CURRENT = "wallpaper-carousel.current";

export default class WallpaperCarousel extends View {
  init(initialProps, cx) {
    this.intervalMs = (initialProps && initialProps.intervalMs) || DEFAULT_INTERVAL_MS;
    this.paused = shared(SHARED_KEY_PAUSED) === true;
    this.busy = false;

    // Start auto-rotation timer
    cx.timer.every(this.intervalMs, async (timerCx) => {
      if (!this.paused) {
        await this.rotate(1, false);
      }
    });

    // Start command loop for manual controls: next, prev, toggle
    cx.spawn(async (spawnCx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "next") {
          await this.rotate(1, true);
        } else if (cmd === "prev") {
          await this.rotate(-1, true);
        } else if (cmd === "toggle") {
          this.paused = !this.paused;
          setShared(SHARED_KEY_PAUSED, this.paused);
          notify({
            title: this.paused ? "桌布輪播已暫停" : "桌布輪播已恢復",
            body: this.paused
              ? "自動切換已停止 (仍可用快捷鍵切換)"
              : `每 ${Math.round(this.intervalMs / 1000)} 秒自動更換`,
            level: "info",
          });
        }
      }
    });
  }

  async rotate(step, notifyUser) {
    if (this.busy) return;
    this.busy = true;
    try {
      const home = appHome();
      const bgDir = `${home}/backgrounds`;

      // Read wallpapers directory
      const lsRes = await exec("sh", ["-c", 'ls -1 "$1"', "sh", bgDir]).catch(() => null);
      if (!lsRes || lsRes.code !== 0) {
        if (notifyUser) {
          notify({
            title: "找不到桌布目錄",
            body: bgDir,
            level: "error",
          });
        }
        return;
      }

      const files = filterWallpaperFiles(lsRes.stdout.split("\n"));
      if (files.length === 0) {
        if (notifyUser) {
          notify({
            title: "桌布目錄內無有效圖片",
            body: "請在 ~/.config/herdr-app/backgrounds/ 放入圖片",
            level: "warn",
          });
        }
        return;
      }

      if (files.length === 1 && !notifyUser) {
        return;
      }

      const currentLayout = layout();
      if (!currentLayout || typeof currentLayout !== "object") {
        if (notifyUser) {
          notify({
            title: "無法取得當前版面",
            level: "error",
          });
        }
        return;
      }

      const currentImage = extractCurrentWallpaper(currentLayout);
      const nextImage = getNextWallpaper(files, currentImage, step);
      if (!nextImage || nextImage === currentImage) return;

      currentLayout.background = {
        image: `backgrounds/${nextImage}`,
        fit: "cover",
      };

      run("layout.set", { layout: currentLayout });
      setShared(SHARED_KEY_CURRENT, nextImage);

      if (notifyUser) {
        const idx = files.indexOf(nextImage) + 1;
        notify({
          title: "桌布已切換",
          body: `${nextImage} (${idx}/${files.length})`,
          level: "info",
        });
      }
    } catch (err) {
      if (notifyUser) {
        notify({
          title: "桌布切換異常",
          body: String(err),
          level: "error",
        });
      }
    } finally {
      this.busy = false;
    }
  }

  render(cx) {
    return div();
  }
}
