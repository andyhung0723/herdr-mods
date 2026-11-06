import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, exec, notify, openOverlay } from "herdr";
import { formatSeconds, getYtmStatus, sendYtmCommand } from "./player-state.js";

export default class EnhancedMusic extends View {
  init(_props, cx) {
    this.player = {
      running: false,
      playing: false,
      title: "",
      artist: "",
      album: "",
      elapsed: 0,
      duration: 0,
      percent: 0,
    };
    this.loading = false;

    // Refresh every 2.5 seconds gently
    cx.timer.every(2500, (timerCx) => {
      this.poll(timerCx);
    });

    this.poll(cx);
  }

  async poll(cx) {
    const status = await getYtmStatus(exec);
    this.player = status;
    cx?.notify?.();
  }

  async handleControl(action, cx) {
    this.loading = true;
    cx?.notify?.();
    await sendYtmCommand(action, exec);
    await this.poll(cx);
    this.loading = false;
    cx?.notify?.();
  }

  openTerminalTui() {
    try {
      run("terminal.open", { argv: ["ytm"], place: "tab" });
      notify({
        title: "已開啟 YouTube Music",
        body: "已在新分頁啟動 ytm-player 完整終端介面",
        level: "info",
      });
    } catch (e) {
      notify({
        title: "無法開啟終端",
        body: String(e),
        level: "error",
      });
    }
  }

  render(cx) {
    const t = theme();
    const p = this.player;

    const controlBtn = (icon, action, tooltip, isMain = false) =>
      h_flex()
        .size(isMain ? 36 : 28)
        .rounded(isMain ? 18 : 8)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .bg(isMain ? t.accent : t.raised)
        .text_color(isMain ? t.raised : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, clickCx) => this.handleControl(action, clickCx || cx))
        .child(
          svg(`mods/enhanced-music/${icon}.svg`)
            .size(isMain ? 16 : 14)
            .flex_none()
        );

    return v_flex()
      .id("enhanced-music-panel")
      .size_full()
      .bg(t.surface)
      .p(12)
      .gap(12)
      // Header
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .pb(8)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(
                svg("mods/enhanced-music/music.svg")
                  .size(16)
                  .text_color(t.accent)
              )
              .child(
                div()
                  .font_bold()
                  .text_size(13.5)
                  .text_color(t.foreground)
                  .child("YouTube Music")
              )
              .child(
                div()
                  .text_size(10.5)
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(p.running ? t.raised : t.chrome)
                  .text_color(p.running ? t.working : t.dim)
                  .child(p.running ? (p.playing ? "播放中" : "已暫停") : "離線")
              )
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                h_flex()
                  .h(24)
                  .px(8)
                  .gap(4)
                  .rounded(6)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => this.openTerminalTui())
                  .child(
                    svg("mods/enhanced-music/terminal.svg").size(12).flex_none()
                  )
                  .child(div().text_size(11).child("全螢幕 TUI"))
              )
          )
      )
      // Main Content Area
      .child(
        p.running
          ? // Player Active View
            v_flex()
              .w_full()
              .p(12)
              .rounded(10)
              .bg(t.chrome)
              .border_1()
              .border_color(t.border)
              .gap(10)
              // Track Info
              .child(
                v_flex()
                  .gap(2)
                  .child(
                    div()
                      .font_bold()
                      .text_size(14)
                      .text_color(t.foreground)
                      .truncate()
                      .child(p.title || "YouTube Music")
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.muted)
                      .truncate()
                      .child(p.artist || "正在背景播放")
                  )
              )
              // Progress Bar
              .child(
                v_flex()
                  .gap(4)
                  .child(
                    div()
                      .w_full()
                      .h(4)
                      .rounded(2)
                      .bg(t.raised)
                      .child(
                        div()
                          .h_full()
                          .rounded(2)
                          .bg(t.accent)
                          .w(`${p.percent || 0}%`)
                      )
                  )
                  .child(
                    h_flex()
                      .w_full()
                      .justify_between()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(formatSeconds(p.elapsed))
                      .child(formatSeconds(p.duration))
                  )
              )
              // Controls Row
              .child(
                h_flex()
                  .w_full()
                  .items_center()
                  .justify_center()
                  .gap(12)
                  .pt(4)
                  .child(controlBtn("skip-back", "prev", "上一首"))
                  .child(
                    controlBtn(
                      p.playing ? "pause" : "play",
                      p.playing ? "pause" : "play",
                      p.playing ? "暫停" : "播放",
                      true
                    )
                  )
                  .child(controlBtn("skip-forward", "next", "下一首"))
                  .child(controlBtn("heart", "like", "喜歡"))
              )
          : // Player Inactive View (Empty State)
            v_flex()
              .w_full()
              .py(24)
              .px(12)
              .items_center()
              .justify_center()
              .rounded(10)
              .bg(t.chrome)
              .border_1()
              .border_color(t.border)
              .gap(10)
              .child(
                div()
                  .size(48)
                  .rounded(24)
                  .bg(t.raised)
                  .flex()
                  .items_center()
                  .justify_center()
                  .child(
                    svg("mods/enhanced-music/music.svg")
                      .size(24)
                      .text_color(t.accent)
                  )
              )
              .child(
                v_flex()
                  .items_center()
                  .gap(2)
                  .child(
                    div()
                      .font_semibold()
                      .text_size(13.5)
                      .text_color(t.foreground)
                      .child("YouTube Music 尚未啟動")
                  )
                  .child(
                    div()
                      .text_size(11.5)
                      .text_color(t.dim)
                      .child("點擊下方按鈕啟動 ytm 終端音樂播放器")
                  )
              )
              .child(
                h_flex()
                  .mt(4)
                  .h(32)
                  .px(14)
                  .gap(6)
                  .rounded(8)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.accent)
                  .text_color(t.raised)
                  .hover((s) => s.opacity(0.9))
                  .on_click(() => this.openTerminalTui())
                  .child(
                    svg("mods/enhanced-music/play.svg").size(14).flex_none()
                  )
                  .child(div().font_bold().text_size(12).child("啟動 ytm-player"))
              )
      )
      // Keyboard Hints Footer
      .child(
        v_flex()
          .w_full()
          .p(10)
          .rounded(8)
          .bg(t.raised)
          .gap(5)
          .text_size(11)
          .child(
            div()
              .font_semibold()
              .text_color(t.foreground)
              .child("快捷鍵指南（在 TUI 終端內）：")
          )
          .child(
            h_flex()
              .justify_between()
              .text_color(t.muted)
              .child("空白鍵 (Space)")
              .child("播放 / 暫停")
          )
          .child(
            h_flex()
              .justify_between()
              .text_color(t.muted)
              .child("j / k")
              .child("上下選擇歌曲")
          )
          .child(
            h_flex()
              .justify_between()
              .text_color(t.muted)
              .child("gs")
              .child("搜尋歌曲 / 專輯")
          )
          .child(
            h_flex()
              .justify_between()
              .text_color(t.muted)
              .child("gl")
              .child("開啟個人歌單庫")
          )
      );
  }
}
