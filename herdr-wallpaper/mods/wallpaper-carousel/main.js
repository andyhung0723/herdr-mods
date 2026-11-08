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
  getMatrixRainFrames,
  getNextWallpaper,
} from "./logic.js";

const DEFAULT_MATRIX_INTERVAL_MS = 160;
const DEFAULT_CAROUSEL_INTERVAL_MS = 30000;
const SHARED_KEY_PAUSED = "wallpaper-carousel.paused";
const SHARED_KEY_CURRENT = "wallpaper-carousel.current";
const SHARED_KEY_MODE = "wallpaper-carousel.mode";

export default class WallpaperCarousel extends View {
  init(initialProps, cx) {
    const props = initialProps || {};
    this.mode = props.mode || shared(SHARED_KEY_MODE) || "matrix";
    this.frameCount = props.frameCount || 16;
    this.matrixFrames = getMatrixRainFrames(
      this.frameCount,
      props.matrixFolder || "matrix-rain-hd"
    );
    this.frameIndex = 0;

    this.intervalMs =
      props.intervalMs ||
      (this.mode === "matrix" ? DEFAULT_MATRIX_INTERVAL_MS : DEFAULT_CAROUSEL_INTERVAL_MS);

    this.paused = shared(SHARED_KEY_PAUSED) === true;
    this.busy = false;

    // Start frame / rotation timer
    cx.timer.every(this.intervalMs, async () => {
      if (!this.paused) {
        if (this.mode === "matrix") {
          this.stepMatrixFrame(1);
        } else {
          await this.rotate(1, false);
        }
      }
    });

    // Start command loop for manual controls: next, prev, toggle
    cx.spawn(async () => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "next") {
          if (this.mode === "matrix" && !this.paused) {
            this.mode = "carousel";
            setShared(SHARED_KEY_MODE, this.mode);
            await this.rotate(1, true);
          } else if (this.mode === "carousel") {
            this.mode = "matrix";
            this.paused = false;
            setShared(SHARED_KEY_MODE, this.mode);
            setShared(SHARED_KEY_PAUSED, false);
            this.stepMatrixFrame(1);
            notify({
              title: "已切換為 Matrix 動態數位雨背景",
              body: "按 Ctrl+B Alt+B 可隨時暫停/恢復流動",
              level: "info",
            });
          } else {
            this.stepMatrixFrame(1);
          }
        } else if (cmd === "prev") {
          if (this.mode === "matrix") {
            this.stepMatrixFrame(-1);
          } else {
            await this.rotate(-1, true);
          }
        } else if (cmd === "toggle") {
          this.paused = !this.paused;
          setShared(SHARED_KEY_PAUSED, this.paused);
          notify({
            title: this.paused ? "Matrix 數位雨已暫停" : "Matrix 數位雨已啟動",
            body: this.paused
              ? "已定格為靜態 Matrix 背景 (0% CPU 省電模式)"
              : "終端機背景數位雨持續流瀉中",
            level: "info",
          });
        }
      }
    });
  }

  stepMatrixFrame(step = 1) {
    if (this.busy || this.matrixFrames.length === 0) return;
    this.busy = true;
    try {
      const currentLayout = layout();
      if (!currentLayout || typeof currentLayout !== "object") return;

      const total = this.matrixFrames.length;
      this.frameIndex = ((this.frameIndex + step) % total + total) % total;
      const nextFrame = this.matrixFrames[this.frameIndex];

      currentLayout.background = {
        image: `backgrounds/${nextFrame}`,
        fit: "cover",
      };

      run("layout.set", { layout: currentLayout });
    } catch {
      // Ignore transient layout snapshot errors
    } finally {
      this.busy = false;
    }
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

  render() {
    return div();
  }
}
