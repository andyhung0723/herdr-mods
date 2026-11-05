// Markdown Preview mod for Herdr
// Dual-column layout: Left sidebar for file list & search, right area for rich preview.
// Supports Pane split, Overlay / Dialog popup, and auto live-refreshing.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import {
  theme, props, closeOverlay, run, readTextFile, exec,
  spaces, focused, panes
} from "herdr";

function resolveLocation() {
  const f = focused();
  const allSpaces = spaces();
  const space = allSpaces.find((s) => s.id === f?.space) ?? allSpaces.find((s) => s.active) ?? allSpaces[0];
  const allPanes = panes();
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  
  // Find pane in current space or active tab
  const cwd = allPanes.find((p) => tabs.has(p.tab) && p.cwd)?.cwd
    || (f?.pane ? allPanes.find((p) => p.pane === f.pane)?.cwd : null)
    || f?.cwd
    || space?.folder
    || ".";

  const on = space?.machine ?? null;
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
    this.showSidebar = true;
    this.filter = "";
    this.currentCwd = "";

    // Search filter input
    this.input = InputState.new({ placeholder: "Search .md files…" });
    this.input.on("change", (_e, cx) => {
      this.filter = (this.input.value() || "").trim().toLowerCase();
      cx.notify();
    });

    this.handle = cx.focus_handle();
    this.handle.focus();

    // Initial load & discovery
    this.bootstrap(this.initialFile, cx);

    // Watch for live changes (every 1.5s)
    cx.timer.every(1500, (cx) => {
      if (this.filePath && !this.loading) {
        this.pollChanges(cx);
      }
    });
  }

  async discoverFiles(cwd, on) {
    try {
      const script = `
        TARGET="$1"
        [ -d "$TARGET" ] && cd "$TARGET"
        find . -maxdepth 3 \\( -name "*.md" -o -name "*.markdown" \\) \\
          -not -path "*/.*" \\
          -not -path "*/node_modules/*" \\
          -not -path "*/Library/*" \\
          -not -path "*/Pictures/*" \\
          2>/dev/null | sort | head -n 60
      `;
      const r = await exec("sh", ["-c", script, "sh", cwd], { on });
      const raw = (r?.stdout || "").trim();
      if (raw) {
        const list = raw
          .split("\n")
          .map((line) => line.trim().replace(/^\.\//, ""))
          .filter(Boolean);

        // Put README.md or AGENTS.md first if present
        list.sort((a, b) => {
          const aBase = a.toLowerCase();
          const bBase = b.toLowerCase();
          if (aBase === "readme.md") return -1;
          if (bBase === "readme.md") return 1;
          if (aBase === "agents.md") return -1;
          if (bBase === "agents.md") return 1;
          return a.localeCompare(b);
        });
        if (list.length > 0) return list;
      }
    } catch {
      // Fallback
    }

    // Direct fallback probe for common files
    const fallbacks = ["README.md", "readme.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.txt"];
    const found = [];
    for (const fb of fallbacks) {
      try {
        const check = await readTextFile(`${cwd}/${fb}`, { on });
        if (check !== null) found.push(fb);
      } catch {}
    }
    return found;
  }

  bootstrap(targetFile, cx) {
    this.loading = true;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const { cwd, on } = resolveLocation();
        this.currentCwd = cwd;
        const files = await this.discoverFiles(cwd, on);
        this.availableFiles = files;

        let selected = targetFile;
        if (!selected) {
          if (files.length > 0) {
            selected = files[0];
          }
        }

        if (selected) {
          if (!this.availableFiles.includes(selected)) {
            this.availableFiles.unshift(selected);
          }
          await this.loadFileContent(selected, cwd, on);
        } else {
          this.loading = false;
          this.error = `No Markdown files found in: ${cwd}`;
          this.content = null;
        }
      } catch (err) {
        this.loading = false;
        this.error = String(err);
      } finally {
        cx.notify();
      }
    });
  }

  async loadFileContent(selected, cwd, on) {
    const fullPath = selected.startsWith("/") ? selected : `${cwd}/${selected}`;
    const text = await readTextFile(fullPath, { on });

    if (text === null) {
      this.loading = false;
      this.error = `File not found: ${selected}`;
      this.content = null;
    } else {
      this.filePath = fullPath;
      this.fileName = selected;
      this.content = text;
      this.lastHash = text.length + ":" + text.slice(0, 80);
      this.loading = false;
      this.error = null;
    }
  }

  loadFile(selected, cx) {
    this.loading = true;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const { cwd, on } = resolveLocation();
        this.currentCwd = cwd;
        await this.loadFileContent(selected, cwd, on);
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

  filteredFiles() {
    if (!this.filter) return this.availableFiles;
    return this.availableFiles.filter((f) => f.toLowerCase().includes(this.filter));
  }

  render(cx) {
    const t = theme();
    const isOverlay = Boolean(this.overlayId);
    const files = this.filteredFiles();

    return v_flex()
      .id("markdown-preview-root")
      .track_focus(this.handle)
      .size_full()
      .bg(t.background)
      .when(isOverlay, (el) => el.rounded(12))
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          this.close();
          cx.stop_propagation();
        }
      })
      // Top Master Toolbar (Height 40px)
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          // Sidebar Toggle Button
          .child(
            h_flex()
              .px(6)
              .h(24)
              .rounded(4)
              .items_center()
              .gap(4)
              .cursor_pointer()
              .when(this.showSidebar, (el) => el.bg(t.raised))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.showSidebar = !this.showSidebar;
                cx.notify();
              })
              .child(div().text_size(12).text_color(t.muted).child("☰ Files"))
              .when(this.availableFiles.length > 0, (el) =>
                el.child(
                  div()
                    .text_size(11)
                    .px(4)
                    .rounded(3)
                    .bg(t.background)
                    .text_color(t.dim)
                    .child(String(this.availableFiles.length))
                )
              )
          )
          // Live status dot
          .child(
            div()
              .w(8)
              .h(8)
              .rounded(4)
              .bg(this.filePath ? t.ansi2 : t.muted)
          )
          // Current file name
          .child(
            div()
              .font_semibold()
              .text_size(13)
              .text_color(t.foreground)
              .child(this.fileName ?? "Markdown Preview")
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
                this.bootstrap(this.fileName, cx);
              })
              .child(div().text_size(12).text_color(t.muted).child("↻ Refresh"))
          )
          // Split Pane button (in Overlay mode)
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
      // Main Body: Dual-column layout (flex_1, items_stretch)
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .items_stretch()
          // Left File List Column
          .when(this.showSidebar, (el) =>
            el.child(
              v_flex()
                .w(260)
                .h_full()
                .flex_none()
                .bg(t.surface)
                .border_r(1)
                .border_color(t.border)
                // Filter box container (Height 44px, pinned to top)
                .child(
                  h_flex()
                    .h(44)
                    .flex_none()
                    .px(8)
                    .items_center()
                    .border_b(1)
                    .border_color(t.border)
                    .child(
                      Input.new(this.input)
                        .w_full()
                        .h(28)
                        .px(8)
                        .rounded(6)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(12)
                        .text_color(t.foreground)
                    )
                )
                // Files scrollable list
                .child(
                  v_flex()
                    .id("md-file-list")
                    .flex_1()
                    .min_h(0)
                    .overflow_y_scrollbar()
                    .p(4)
                    .gap(2)
                    .when(files.length === 0, (emptyEl) =>
                      emptyEl.child(
                        v_flex()
                          .p(10)
                          .gap(4)
                          .child(
                            div()
                              .text_size(12)
                              .text_color(t.dim)
                              .child(this.filter ? "No matching files" : "No .md files found")
                          )
                          .when(Boolean(this.currentCwd), (cEl) =>
                            cEl.child(
                              div()
                                .text_size(10.5)
                                .text_color(t.dim)
                                .child(`in ${this.currentCwd.split("/").pop() || this.currentCwd}`)
                            )
                          )
                      )
                    )
                    .children(
                      files.map((file) => {
                        const isSelected = file === this.fileName;
                        const parts = file.split("/");
                        const base = parts.pop();
                        const dir = parts.length > 0 ? parts.join("/") + "/" : "";

                        return h_flex()
                          .id(`md-file-${file}`)
                          .p(6)
                          .rounded(6)
                          .gap(6)
                          .items_center()
                          .cursor_pointer()
                          .when(isSelected, (s) => s.bg(t.raised))
                          .when(!isSelected, (s) => s.hover((h) => h.bg(t.hover)))
                          .on_click((_e, cx) => {
                            if (file !== this.fileName) {
                              this.loadFile(file, cx);
                            }
                          })
                          // File icon
                          .child(div().text_size(13).child("📄"))
                          // File name & directory path
                          .child(
                            v_flex()
                              .flex_1()
                              .min_w(0)
                              .child(
                                div()
                                  .truncate()
                                  .text_size(12)
                                  .font_medium()
                                  .text_color(isSelected ? t.accent : t.foreground)
                                  .child(base)
                              )
                              .when(Boolean(dir), (dirEl) =>
                                dirEl.child(
                                  div()
                                    .truncate()
                                    .text_size(10.5)
                                    .text_color(t.dim)
                                    .child(dir)
                                )
                              )
                          );
                      })
                    )
                )
            )
          )
          // Right Preview Area
          .child(
            v_flex()
              .id("markdown-body")
              .flex_1()
              .h_full()
              .min_w(0)
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
                    .child(div().text_size(14).font_semibold().text_color(t.ansi1).child("Notice"))
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
          )
      );
  }
}
