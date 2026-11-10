import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, appHome } from "herdr";

const MUSIC_ICON = "mods/workspace-status/music.svg";

function resolveProbePath() {
  const h = appHome();
  return `${h}/mods/workspace-status/probe.py`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.song = null;
    this.polling = false;

    // Fast check: poll YouTube Music every 2.5 seconds
    cx.timer.every(2500, (tcx) => this.pollMusic(tcx));
    this.pollMusic(cx);
  }

  async pollMusic(cx) {
    if (this.polling) return;
    this.polling = true;
    try {
      const probeScript = resolveProbePath();
      const res = await exec("python3", [probeScript, "--action", "status"]);
      if (res.code === 0 && res.stdout) {
        const data = JSON.parse(res.stdout);
        const prev = this.song;
        const changed =
          !prev ||
          prev.active !== data.active ||
          prev.title !== data.title ||
          prev.playing !== data.playing ||
          prev.artist !== data.artist;

        if (changed) {
          this.song = data;
          cx?.notify?.();
        }
      }
    } catch {
      // ignore probe error
    } finally {
      this.polling = false;
    }
  }

  async activateYTM(cx) {
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "activate"]);
    } catch {}
  }

  async togglePlay(cx) {
    try {
      const probeScript = resolveProbePath();
      await exec("python3", [probeScript, "--action", "toggle"]);
      await this.pollMusic(cx);
    } catch {}
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  renderMusicWidget(t, song, cx) {
    const isPlaying = song.playing;
    const accentColor = t.ansi2 ?? "#a6e3a1";
    const fullInfo = song.artist ? `${song.title} · ${song.artist}` : song.title;
    const tooltipText = `${fullInfo} (${isPlaying ? "Playing" : "Paused"})`;

    return h_flex()
      .id("ytm-now-playing")
      .items_center()
      .gap(6)
      .px(8)
      .h(22)
      .max_w(520)
      .rounded(5)
      .cursor_pointer()
      .tooltip(tooltipText)
      .hover((s) => s.bg(t.selected ?? "#334155"))
      .on_click((_e, cx) => this.activateYTM(cx))
      // Music note icon
      .child(
        svg(MUSIC_ICON)
          .size(13)
          .flex_shrink_0()
          .text_color(isPlaying ? accentColor : t.dim)
      )
      // Song title
      .child(
        div()
          .max_w(320)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(isPlaying ? t.foreground : t.muted)
          .child(song.title)
      )
      // Artist
      .when(Boolean(song.artist), (el) =>
        el.child(
          div()
            .max_w(180)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(`· ${song.artist}`)
        )
      )
      // Mini play / pause indicator button
      .child(
        div()
          .flex_shrink_0()
          .px(4)
          .py(1)
          .rounded(3)
          .text_size(10)
          .text_color(isPlaying ? accentColor : t.dim)
          .hover((s) => s.bg(t.hover ?? t.surface))
          .tooltip(isPlaying ? "Pause" : "Play")
          .on_click((e, cx) => {
            e.stop_propagation();
            this.togglePlay(cx);
          })
          .child(isPlaying ? "⏸" : "▶")
      );
  }

  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      // Left: Machine, Branch, Agents
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)))
      )
      // Center spacer
      .child(div().flex_1())
      // Right Corner: YouTube Music Widget (when active)
      .when(Boolean(this.song && this.song.active), (el) =>
        el.child(this.renderMusicWidget(t, this.song, cx))
      )
      // Right Corner: Palette command
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint(t))
      );
  }
}
