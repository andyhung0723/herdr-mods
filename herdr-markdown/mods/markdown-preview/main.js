// Markdown Preview mod for Herdr
// Supports Pane split, Overlay / Dialog popup, and auto live-refreshing.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import {
  theme, props, closeOverlay, run, readTextFile, exec,
  spaces, focused, panes, notify
} from "herdr";

function resolveLocation() {
  const space = spaces().find((s) => s.active) ?? spaces()[0];
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f?.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder || ".";
  return { cwd, on, space: space?.id, spaceName: space?.name || "Workspace" };
}

export default class MarkdownPreview extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.initialFile = p.file ?? null;
    this.filePath = null;
    this.fileName = null;
    this.content = null;
    this.error = null;
    this.loading = true;
    this.lastHash = null;
    this.availableFiles = [];
    this.showFileSelector = false;

    this.handle = cx.focus_handle();
    this.handle.focus();

    // Initial load
    this.loadFile(this.initialFile, cx);

    // Watch for live changes (every 1.5s)
    cx.timer.every(1500, (cx) => {
      if (this.filePath && !this.loading) {
        this.pollChanges(cx);
      }
    });
  }

  async discoverFiles(cwd, on) {
    try {
      const r = await exec("sh", ["-c", 'find . -maxdepth 2 -name "*.md" -not -path "*/.*" 2>/dev/null | head -n 15'], { cwd, on });
      if (r.code === 0 && r.stdout) {
        return r.stdout
          .split("\n")
          .map((line) => line.trim().replace(/^\.\//, ""))
          .filter(Boolean);
      }
    } catch {
      // Fallback
    }
    return [];
  }

  loadFile(targetFile, cx) {
    this.loading = true;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const { cwd, on } = resolveLocation();
        let selected = targetFile;

        // If no file specified, search default candidates
        if (!selected) {
          const candidates = ["README.md", "readme.md", "AGENTS.md", "README.txt"];
          for (const cand of candidates) {
            const check = await readTextFile(`${cwd}/${cand}`, { on });
            if (check !== null) {
              selected = cand;
              break;
            }
          }

          // If still none, scan directory
          if (!selected) {
            const files = await this.discoverFiles(cwd, on);
            this.availableFiles = files;
            if (files.length > 0) {
              selected = files[0];
            }
          }
        }

        if (!selected) {
          this.loading = false;
          this.error = "No Markdown file found in current workspace.";
          this.content = null;
          cx.notify();
          return;
        }

        const fullPath = selected.startsWith("/") ? selected : `${cwd}/${selected}`;
        const text = await readTextFile(fullPath, { on });

        if (text === null) {
          this.loading = false;
          this.error = `File not found: ${selected}`;
          this.content = null;
        } else {
          this.filePath = fullPath;
          this.fileName = selected.split("/").pop();
          this.content = text;
          this.lastHash = text.length + ":" + text.slice(0, 80);
          this.loading = false;
          this.error = null;
        }

        // Also fetch candidate files list in background for switching
        const found = await this.discoverFiles(cwd, on);
        if (found.length > 0) {
          this.availableFiles = found;
        }
      } catch (err) {
        this.loading = false;
        this.error = String(err);
      } finally {
        cx.notify();
      }
    });
  }

  pollChanges(cx) {
    if (!this.filePath) return;
    const { on } = resolveLocation();

    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.filePath, { on });
        if (text !== null) {
          const hash = text.length + ":" + text.slice(0, 80);
          if (hash !== this.lastHash) {
            this.content = text;
            this.lastHash = hash;
            cx.notify();
          }
        }
      } catch {
        // Silently ignore poll errors
      }
    });
  }

  openInSplit(cx) {
    if (!this.filePath) return;
    run("pane.split", {
      direction: "right",
      mod: "markdown-preview",
      props: { file: this.filePath }
    });
    if (this.overlayId) {
      closeOverlay(this.overlayId);
    }
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
    }
  }

  render(cx) {
    const t = theme();
    const isOverlay = Boolean(this.overlayId);

    return v_flex()
      .id("markdown-preview-root")
      .track_focus(this.handle)
      .size_full()
      .bg(t.background)
      .rounded(isOverlay ? 12 : 0)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          this.close();
          cx.stop_propagation();
        }
      })
      // Header Bar
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          // Live status dot
          .child(
            div()
              .w(8)
              .h(8)
              .rounded(4)
              .bg(this.filePath ? t.ansi2 : t.muted)
          )
          // File title / switcher button
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.showFileSelector = !this.showFileSelector;
                cx.notify();
              })
              .child(
                div()
                  .font_semibold()
                  .text_size(13)
                  .text_color(t.foreground)
                  .child(this.fileName ?? "Markdown Preview")
              )
              .when(this.availableFiles.length > 1, (el) =>
                el.child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(this.showFileSelector ? "▲" : "▼")
                )
              )
          )
          // Spacer
          .child(div().flex_1())
          // Refresh Button
          .child(
            h_flex()
              .px(6)
              .h(24)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.loadFile(this.filePath, cx);
              })
              .child(div().text_size(12).text_color(t.muted).child("↻ Refresh"))
          )
          // Split Pane button (especially handy in Overlay mode)
          .when(isOverlay && Boolean(this.filePath), (el) =>
            el.child(
              h_flex()
                .px(6)
                .h(24)
                .rounded(4)
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.openInSplit(cx);
                })
                .child(div().text_size(12).text_color(t.muted).child("⧉ Split"))
            )
          )
          // Close button (if overlay)
          .when(isOverlay, (el) =>
            el.child(
              h_flex()
                .w(24)
                .h(24)
                .rounded(4)
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.close())
                .child(div().text_size(13).text_color(t.muted).child("✕"))
            )
          )
      )
      // Dropdown File Selector
      .when(this.showFileSelector && this.availableFiles.length > 0, (el) =>
        el.child(
          v_flex()
            .flex_none()
            .p(6)
            .gap(2)
            .bg(t.popover)
            .border_b(1)
            .border_color(t.border)
            .children(
              this.availableFiles.map((file) =>
                h_flex()
                  .p(6)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.showFileSelector = false;
                    this.loadFile(file, cx);
                  })
                  .child(
                    div()
                      .text_size(12)
                      .text_color(file === this.fileName ? t.accent : t.foreground)
                      .child(file)
                  )
              )
            )
        )
      )
      // Content Area
      .child(
        v_flex()
          .id("markdown-body")
          .flex_1()
          .min_h(0)
          .p(16)
          .overflow_y_scrollbar()
          .when(this.loading && !this.content, (el) =>
            el.child(
              div().p(16).text_size(13).text_color(t.dim).child("Loading Markdown…")
            )
          )
          .when(Boolean(this.error) && !this.content, (el) =>
            el.child(
              v_flex()
                .p(16)
                .gap(8)
                .child(div().text_size(14).font_semibold().text_color(t.ansi1).child("Error"))
                .child(div().text_size(13).text_color(t.muted).child(this.error))
            )
          )
          .when(Boolean(this.content), (el) =>
            el.child(
              TextView.markdown("preview-text", this.content || "*Empty file*")
                .selectable(true)
                .scrollable(true)
            )
          )
      );
  }
}
