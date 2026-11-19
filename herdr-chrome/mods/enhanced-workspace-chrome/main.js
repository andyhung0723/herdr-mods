import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  theme,
  run,
  props,
  window,
  shared,
  setShared,
  updates,
  layout,
  exec,
  appHome,
  notify,
  playSound,
} from "herdr";
import { formatClock } from "./date-format.js";
import { computeDogState } from "./dog-state.js";

const MUSIC_ICON = "mods/enhanced-workspace-chrome/music.svg";
const EQ_FRAMES = [
  [5, 11, 7],
  [11, 5, 10],
  [7, 12, 5],
  [10, 7, 11],
];

function resolveProbePath() {
  const h = typeof appHome === "function" ? appHome() : "";
  return `${h}/mods/enhanced-workspace-chrome/probe.py`;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const stopMouseDown = (_e, mCx) => mCx?.stop_propagation?.();

export default class EnhancedWorkspaceChrome extends View {
  init(_props, cx) {
    this.asyncCx = cx;
    this.tickCount = 0;
    this.song = null;
    this.polling = false;
    this.toggleLockUntil = 0;

    if (!_props?.footer && !props()?.footer) {
      // Animation timer: ticks every 250ms for live clock + animated pixel pet + EQ
      cx.timer.every(250, (timerCx) => {
        this.tick();
        timerCx.notify();
      });

      // Poll YouTube Music / macOS MediaRemote every 2.5 seconds
      cx.timer.every(2500, (timerCx) => this.pollMusic(timerCx));
      this.pollMusic(cx);
    }
  }

  async pollMusic(cx, force = false) {
    if (!force && this.polling) return this._musicPollPromise;
    this.polling = true;
    this._musicPollPromise = (async () => {
      try {
        const probeScript = resolveProbePath();
        const res = await exec("python3", [probeScript, "--action", "status"]);
        if (res.code === 0 && res.stdout) {
          const data = JSON.parse(res.stdout);
          const prev = this.song;
          if (!force && prev && Date.now() < this.toggleLockUntil) {
            data.playing = prev.playing;
          }
          const changed =
            !prev ||
            prev.active !== data.active ||
            prev.title !== data.title ||
            prev.playing !== data.playing ||
            prev.artist !== data.artist;

          if (changed) {
            this.song = data;
            (this.asyncCx ?? cx)?.notify?.();
          }
        }
      } catch {
        // ignore probe error
      } finally {
        this.polling = false;
      }
    })();
    return this._musicPollPromise;
  }

  async activateYTM(_cx) {
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "activate"]);
    } catch {}
  }

  async togglePlay(cx) {
    const uiCx = this.asyncCx ?? cx;
    if (this.song) {
      this.song = { ...this.song, playing: !this.song.playing };
      this.toggleLockUntil = Date.now() + 1800;
      cx?.notify?.();
      uiCx?.notify?.();
    }
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "toggle"]);
      const timer = uiCx?.timer;
      if (timer && typeof timer.after === "function") {
        await new Promise((resolve) => timer.after(350, resolve));
      }
      this.toggleLockUntil = 0;
      await this.pollMusic(uiCx, true);
    } catch {
      this.toggleLockUntil = 0;
    }
  }

  tick() {
    this.tickCount = (this.tickCount + 1) % 48; // 48 ticks * 250ms = 12-second behavioral loop
  }

  getDogState() {
    return computeDogState(this.tickCount);
  }

  bark(cx) {
    try {
      playSound("done");
    } catch {}
    notify({
      title: "汪！🐾",
      body: "汪汪！(搖尾巴)",
      level: "info",
    });
  }

  copyTimestamp(cx) {
    const ts = formatClock(new Date()).isoTimestamp;
    try {
      cx.write_to_clipboard(ts);
      notify({
        title: "時間已複製到剪貼簿",
        body: ts,
        level: "info",
      });
    } catch {
      exec("sh", ["-c", 'printf "%s" "$1" | pbcopy', "sh", ts]).catch(() => null);
      notify({
        title: "時間已複製到剪貼簿",
        body: ts,
        level: "info",
      });
    }
  }

  renderMusicRow(t, _cx) {
    const song = this.song;
    const hasSong = Boolean(song && song.active && song.title);
    const isPlaying = Boolean(hasSong && song.playing);
    const doneColor = t.done ?? "#6be6b5";
    const eqHeights = EQ_FRAMES[(this.tickCount || 0) % EQ_FRAMES.length];
    const tooltipText = hasSong
      ? `${song.title}${song.artist ? ` · ${song.artist}` : ""} (${isPlaying ? "Playing" : "Paused"})\n點擊切換至播放器`
      : "目前沒有播放中的音樂（YouTube Music）\n點擊嘗試喚醒播放器";

    return h_flex()
      .id("chrome-music-player")
      .w_full()
      .h(32)
      .px(6)
      .gap(8)
      .items_center()
      .rounded(8)
      .bg(isPlaying ? (t.raised ?? "#ffffff26") : "#ffffff0d")
      .border(1)
      .border_color(isPlaying ? (t.input ?? t.border) : "#ffffff1f")
      .cursor_pointer()
      .tooltip(tooltipText)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stopMouseDown)
      .on_click((_e, clickCx) => this.activateYTM(clickCx))
      // Left Disc / Music Icon Tile
      .child(
        div()
          .id("chrome-music-disc")
          .size(22)
          .rounded(6)
          .flex_none()
          .bg(isPlaying ? `${doneColor}24` : (t.surface ?? "#ffffff14"))
          .border(1)
          .border_color(isPlaying ? `${doneColor}55` : t.border)
          .flex()
          .items_center()
          .justify_center()
          .child(
            svg(MUSIC_ICON)
              .size(12)
              .text_color(isPlaying ? doneColor : t.dim)
          )
      )
      // Track Title & Artist Metadata
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .justify_center()
          .child(
            div()
              .id("chrome-music-title")
              .w_full()
              .truncate()
              .text_size(hasSong ? 11 : 10.5)
              .font_semibold()
              .text_color(isPlaying ? t.foreground : hasSong ? t.muted : t.dim)
              .child(hasSong ? song.title : "Not Playing")
          )
          .child(
            div()
              .id("chrome-music-artist")
              .w_full()
              .truncate()
              .text_size(9.5)
              .text_color(t.dim)
              .child(
                hasSong
                  ? song.artist || (isPlaying ? "YouTube Music · 播放中" : "YouTube Music · 已暫停")
                  : "YouTube Music"
              )
          )
      )
      // Animated 3-Bar Equalizer when Playing
      .when(isPlaying, (el) =>
        el.child(
          h_flex()
            .id("chrome-music-eq")
            .h(14)
            .gap(2)
            .items_end()
            .flex_none()
            .children(
              eqHeights.map((hPx) =>
                div()
                  .w(2)
                  .h(hPx)
                  .rounded(1)
                  .bg(doneColor)
              )
            )
        )
      )
      // Play / Pause Control Button
      .when(hasSong, (el) =>
        el.child(
          div()
            .id("chrome-music-toggle")
            .size(22)
            .rounded(6)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .bg(isPlaying ? (t.selected ?? "#ffffff3b") : (t.raised ?? "#ffffff26"))
            .border(1)
            .border_color(t.border)
            .text_size(10)
            .text_color(isPlaying ? doneColor : t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).border_color(t.input ?? t.border))
            .tooltip(isPlaying ? "暫停 (Pause)" : "播放 (Play)")
            .on_mouse_down("left", stopMouseDown)
            .on_click((_e, clickCx) => {
              clickCx?.stop_propagation?.();
              this.togglePlay(clickCx);
            })
            .child(isPlaying ? "⏸" : "▶")
        )
      );
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    const clock = formatClock(new Date());
    const dog = this.getDogState();

    if (props()?.footer) {
      const row = (id, icon, label, dim, action) =>
        h_flex()
          .id(id)
          .h(28)
          .px(8)
          .gap(9)
          .items_center()
          .rounded(8)
          .text_color(dim ? t.dim : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .cursor_pointer()
          .on_click(action)
          .child(svg(`mods/enhanced-workspace-chrome/${icon}.svg`).size(14))
          .when(!collapsed, (el) => el.child(label));

      return v_flex()
        .size_full()
        .border_t(1)
        .border_color(t.border)
        .px(8)
        .pt(4)
        .pb(8)
        .text_size(13)
        .child(
          row("settings", "settings", "Settings", false, () => run("app.settings"))
            .when(Boolean(updates().app.ready), (el) =>
              el.child(div().size(6).rounded_full().bg(t.accent))
            )
        )
        .child(
          row("machine", "plus", "Add machine", true, () =>
            run("mod.open", { name: "machine-add" })
          )
        );
    }

    if (collapsed) {
      return h_flex()
        .id("enhanced-brand")
        .size_full()
        .px(6)
        .items_center()
        .justify_center()
        .child(
          div()
            .id("clock-compact")
            .size(28)
            .flex()
            .items_center()
            .justify_center()
            .rounded(8)
            .bg(t.surface)
            .border(1)
            .border_color(t.border)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_mouse_down("left", stopMouseDown)
            .on_click((_e, cx) => this.copyTimestamp(cx))
            .child(
              svg("mods/enhanced-workspace-chrome/clock.svg")
                .size(14)
                .text_color(t.accent)
            )
        );
    }

    const walkPx = Math.round((dog.offset || 0) * 4.2);
    const isResting = dog.mode === "sit";

    return v_flex()
      .id("enhanced-brand")
      .size_full()
      .px(10)
      .pt(8)
      .pb(4)
      .justify_center()
      .child(
        v_flex()
          .w_full()
          .rounded(12)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .px(10)
          .pt(6)
          .pb(5)
          .gap(4)
          // Top Row: Single-Line Digital Timepiece & Frosted Date Capsule
          .child(
            h_flex()
              .id("clock-row")
              .w_full()
              .h(24)
              .items_center()
              .justify_between()
              .cursor_pointer()
              .rounded(6)
              .px(2)
              .when(window()?.platform === "macos" && !window()?.fullscreen, (el) =>
                el.pl(72)
              )
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", stopMouseDown)
              .on_click((_e, cx) => this.copyTimestamp(cx))
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .min_w(0)
                  .child(div().size(6).rounded_full().bg(t.accent).flex_none())
                  .child(
                    div()
                      .font_bold()
                      .text_size(14)
                      .text_color(t.foreground)
                      .child(clock.hm || clock.time.slice(0, 5))
                  )
                  .child(
                    div()
                      .font_semibold()
                      .text_size(10.5)
                      .text_color(t.accent)
                      .child(clock.sec || clock.time.slice(5))
                  )
              )
              .child(
                h_flex()
                  .flex_none()
                  .px(6)
                  .h(18)
                  .rounded(6)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .items_center()
                  .child(
                    div()
                      .text_size(10)
                      .font_medium()
                      .text_color(t.muted)
                      .child(clock.date)
                  )
              )
          )
          // Hairline Glass Divider
          .child(div().w_full().h(1).bg(t.border))
          // Middle Row: Full-Width Pixel Pet Promenade
          .child(
            h_flex()
              .id("pixel-dog-runway")
              .w_full()
              .h(20)
              .items_center()
              .justify_between()
              .cursor_pointer()
              .rounded(6)
              .px(2)
              .hover((s) => s.bg(t.hover))
              .on_mouse_down("left", stopMouseDown)
              .on_click((_e, cx) => this.bark(cx))
              .child(
                h_flex()
                  .flex_1()
                  .h_full()
                  .items_end()
                  .pb(1)
                  .overflow_hidden()
                  .child(
                    div()
                      .pl(walkPx)
                      .child(
                        image(`mods/enhanced-workspace-chrome/${dog.svg}`)
                          .w(28)
                          .h(18)
                          .flex_none()
                      )
                  )
              )
              .child(
                h_flex()
                  .flex_none()
                  .items_center()
                  .gap(4)
                  .px(5)
                  .h(16)
                  .rounded(5)
                  .bg(t.raised)
                  .child(
                    div()
                      .size(4)
                      .rounded_full()
                      .bg(isResting ? t.blocked : t.done)
                  )
                  .child(
                    div()
                      .text_size(9.5)
                      .text_color(t.dim)
                      .child(isResting ? "休息中" : "散步中")
                  )
              )
          )
          // Hairline Glass Divider
          .child(div().w_full().h(1).bg(t.border))
          // Bottom Row: Integrated Liquid Glass Music Player
          .child(this.renderMusicRow(t, cx))
      );
  }
}
