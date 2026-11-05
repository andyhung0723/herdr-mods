// Scratchpad (随手筆記 / 剪貼暫存區) Mod for Herdr
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import {
  theme, settings, props, closeOverlay, openOverlay, run,
  nextCommand, shared, setShared
} from "herdr";
import { loadStore, saveStore, createDefaultTab, getDefaultStore } from "./storage.js";

const OPEN_OVERLAY = "scratchpad.open-overlay";
const STORE_KEY = "scratchpad.store";

export default class Scratchpad extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "controller");

    if (this.role === "controller") {
      setShared(OPEN_OVERLAY, null);
      cx.spawn(async (cx) => {
        for (;;) {
          const command = await nextCommand();
          if (command !== "toggle") continue;
          try {
            this.toggle(cx);
          } catch (e) {
            console.error("Scratchpad toggle failed:", e);
          }
        }
      });
      return;
    }

    // Dialog mode
    const cached = shared(STORE_KEY);
    this.isCleanDefault = false;
    if (cached && Array.isArray(cached.tabs) && cached.tabs.length > 0) {
      this.tabs = cached.tabs;
      this.activeTabId = cached.activeTabId || this.tabs[0].id;
    } else {
      const def = getDefaultStore();
      this.tabs = def.tabs;
      this.activeTabId = def.activeTabId;
      this.isCleanDefault = true;
    }

    if (this.overlayId) {
      setShared(OPEN_OVERLAY, this.overlayId);
    }

    this.loading = false;
    this.copied = false;
    this.pastedToTerminal = false;
    this.saveTimeout = null;
    this.renamingTabId = null;
    this.renameInput = null;

    this.editor = null;
    this.editorHandle = cx.focus_handle();
    this.handle = cx.focus_handle();

    // Setup initial editor immediately & request focus
    this.setupEditor(this.getActiveTab(), cx);
    this.editorHandle.focus();
    if (cx.timer?.after) {
      cx.timer.after(30, () => this.editorHandle?.focus());
      cx.timer.after(100, () => this.editorHandle?.focus());
    } else {
      setTimeout(() => this.editorHandle?.focus(), 30);
      setTimeout(() => this.editorHandle?.focus(), 100);
    }

    this.load(cx);
  }

  toggle(cx) {
    const current = shared(OPEN_OVERLAY);
    if (current) {
      closeOverlay(current);
      setShared(OPEN_OVERLAY, null);
      return;
    }

    const id = openOverlay({
      mod: "scratchpad",
      kind: "dialog",
      modal: true,
      width: 800,
      height: 560,
      props: { role: "dialog" },
    });
    setShared(OPEN_OVERLAY, id);
  }

  async load(cx) {
    cx.spawn(async (cx) => {
      try {
        const store = await loadStore();
        if (store && Array.isArray(store.tabs) && store.tabs.length > 0) {
          const diskMax = Math.max(...store.tabs.map((t) => t.updatedAt || 0), 0);
          const currentMax = Math.max(...this.tabs.map((t) => t.updatedAt || 0), 0);

          const currentContent = this.getActiveTab()?.content || "";
          const isClean = this.isCleanDefault && !currentContent;

          // Only overwrite if this view was clean default OR disk is strictly newer
          if (isClean || diskMax > currentMax) {
            this.tabs = store.tabs;
            this.activeTabId = store.activeTabId || this.tabs[0].id;
            setShared(STORE_KEY, store);
            this.setupEditor(this.getActiveTab(), cx);
            cx.notify();
          }
        }
      } catch {}
    });
  }

  getActiveTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0];
  }

  setupEditor(tab, cx) {
    this.editor?.release();
    this.editor = null;

    if (!tab) return;
    const t = theme();
    const currentText = tab.content ?? "";

    this.editor = EditorState.new({
      value: currentText,
      language: tab.language || "markdown",
      readonly: false,
      soft_wrap: true,
      line_numbers: true,
      font_family: settings().font_family || "JetBrains Mono",
      font_size: 13,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });

    const onUpdate = () => {
      const activeTab = this.getActiveTab();
      if (activeTab && this.editor) {
        activeTab.content = this.editor.value();
        activeTab.updatedAt = Date.now();
        this.isCleanDefault = false;
        // Immediately sync to shared memory (0ms delay, survives immediate close/Esc)
        setShared(STORE_KEY, {
          activeTabId: this.activeTabId,
          tabs: this.tabs,
        });
        this.scheduleSave();
      }
    };

    this.editor.on("change", onUpdate);
    try {
      this.editor.on("paste_other", onUpdate);
    } catch {}
    try {
      this.editor.on("blur", () => {
        this.saveNow();
      });
    } catch {}

    if (this.editorHandle) {
      this.editorHandle.focus();
    }

    cx.notify();
  }

  scheduleSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
    }, 200);
  }

  saveNow() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    const currentTab = this.getActiveTab();
    if (currentTab && this.editor) {
      currentTab.content = this.editor.value();
      currentTab.updatedAt = Date.now();
      this.isCleanDefault = false;
    }
    const store = {
      activeTabId: this.activeTabId,
      tabs: this.tabs,
    };
    setShared(STORE_KEY, store);
    return saveStore(store);
  }

  switchTab(tabId, cx) {
    if (tabId === this.activeTabId) return;
    // Save content of current tab before switching
    const currentTab = this.getActiveTab();
    if (currentTab && this.editor) {
      currentTab.content = this.editor.value();
      currentTab.updatedAt = Date.now();
    }

    this.activeTabId = tabId;
    this.setupEditor(this.getActiveTab(), cx);
    this.saveNow();
    cx.notify();
  }

  addTab(cx) {
    const currentTab = this.getActiveTab();
    if (currentTab && this.editor) {
      currentTab.content = this.editor.value();
    }

    const newId = "tab-" + Date.now().toString(36);
    const num = this.tabs.length + 1;
    const newTab = createDefaultTab(newId, `Note ${num}`);
    this.tabs.push(newTab);
    this.activeTabId = newId;

    this.setupEditor(newTab, cx);
    this.saveNow();
    cx.notify();
  }

  closeTab(tabId, cx) {
    if (this.tabs.length <= 1) {
      this.clearCurrent(cx);
      return;
    }

    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    this.tabs.splice(idx, 1);
    if (this.activeTabId === tabId) {
      const nextIdx = Math.max(0, idx - 1);
      this.activeTabId = this.tabs[nextIdx].id;
      this.setupEditor(this.getActiveTab(), cx);
    }

    this.saveNow();
    cx.notify();
  }

  startRename(tabId, currentTitle, cx) {
    this.renamingTabId = tabId;
    this.renameInput = InputState.new({ value: currentTitle });
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx));
    cx.notify();
  }

  finishRename(cx) {
    if (this.renamingTabId && this.renameInput) {
      const val = this.renameInput.value()?.trim();
      const tab = this.tabs.find((t) => t.id === this.renamingTabId);
      if (tab && val) {
        tab.title = val;
      }
      this.renamingTabId = null;
      this.renameInput = null;
      this.saveNow();
      cx.notify();
    }
  }

  copyAll(cx) {
    const active = this.getActiveTab();
    const text = this.editor ? this.editor.value() : active?.content || "";
    try {
      cx.write_to_clipboard(text);
    } catch {}

    this.copied = true;
    cx.notify();
    if (cx.timer?.after) {
      cx.timer.after(1500, (cx) => {
        this.copied = false;
        cx.notify();
      });
    } else {
      setTimeout(() => {
        this.copied = false;
        cx.notify();
      }, 1500);
    }
  }

  sendToTerminal(cx) {
    const active = this.getActiveTab();
    const text = this.editor ? this.editor.value() : active?.content || "";
    try {
      run("terminal.paste", { text });
    } catch {}

    this.pastedToTerminal = true;
    cx.notify();
    if (cx.timer?.after) {
      cx.timer.after(1500, (cx) => {
        this.pastedToTerminal = false;
        cx.notify();
      });
    } else {
      setTimeout(() => {
        this.pastedToTerminal = false;
        cx.notify();
      }, 1500);
    }
  }

  clearCurrent(cx) {
    if (this.editor) {
      this.editor.set_value("");
    }
    const active = this.getActiveTab();
    if (active) {
      active.content = "";
      active.updatedAt = Date.now();
    }
    this.saveNow();
    cx.notify();
  }

  async close(cx) {
    await this.saveNow();
    const current = shared(OPEN_OVERLAY);
    setShared(OPEN_OVERLAY, null);
    if (current) {
      try {
        closeOverlay(current);
      } catch {}
    } else if (this.overlayId) {
      try {
        closeOverlay(this.overlayId);
      } catch {}
    }
  }

  renderHeader(t, cx) {
    return h_flex()
      .h(42)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .justify_between()
      .border_b(1)
      .border_color(t.border)
      .bg(t.raised)
      // Left: Logo & Tab List
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(6)
          .items_center()
          .child(
            div()
              .text_size(13)
              .font_semibold()
              .text_color(t.foreground)
              .child("📝")
          )
          // Tabs
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .items_center()
              .overflow_x_scrollbar()
              .children(
                this.tabs.map((tab) => {
                  const isActive = tab.id === this.activeTabId;
                  const isRenaming = this.renamingTabId === tab.id;

                  if (isRenaming && this.renameInput) {
                    return h_flex()
                      .h(26)
                      .px(6)
                      .rounded(5)
                      .bg(t.background)
                      .border_1()
                      .border_color(t.accent)
                      .items_center()
                      .child(Input.new(this.renameInput));
                  }

                  return h_flex()
                    .h(26)
                    .px(8)
                    .gap(6)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .when(isActive, (el) => el.bg(t.background).border_1().border_color(t.border))
                    .when(!isActive, (el) => el.hover((s) => s.bg(t.hover)))
                    .on_click((_e, cx) => this.switchTab(tab.id, cx))
                    .child(
                      div()
                        .text_size(11.5)
                        .font_medium()
                        .text_color(isActive ? t.foreground : t.dim)
                        .truncate()
                        .child(tab.title)
                    )
                    // Close tab button
                    .child(
                      div()
                        .px(2)
                        .rounded(3)
                        .hover((s) => s.bg(t.raised))
                        .text_size(10)
                        .text_color(t.dim)
                        .on_click((e, cx) => {
                          e.stop_propagation?.();
                          this.closeTab(tab.id, cx);
                        })
                        .child("✕")
                    );
                })
              )
              // Add Tab button
              .child(
                div()
                  .px(6)
                  .h(24)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .text_size(13)
                  .font_semibold()
                  .text_color(t.dim)
                  .on_click((_e, cx) => this.addTab(cx))
                  .child("+")
              )
          )
      )
      // Right: Actions
      .child(
        h_flex()
          .gap(6)
          .items_center()
          // Copy All
          .child(
            div()
              .px(8)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .bg(this.copied ? t.ansi2 : t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover))
              .text_size(11)
              .text_color(this.copied ? t.solid_foreground : t.foreground)
              .on_click((_e, cx) => this.copyAll(cx))
              .child(this.copied ? "✓ Copied" : "📋 Copy All")
          )
          // Send to Terminal
          .child(
            div()
              .px(8)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .bg(this.pastedToTerminal ? t.ansi4 : t.background)
              .border_1()
              .border_color(t.border)
              .hover((s) => s.bg(t.hover))
              .text_size(11)
              .text_color(this.pastedToTerminal ? t.solid_foreground : t.foreground)
              .on_click((_e, cx) => this.sendToTerminal(cx))
              .child(this.pastedToTerminal ? "⚡ Sent" : "⚡ To Terminal")
          )
          // Clear
          .child(
            div()
              .px(6)
              .py(3)
              .rounded(5)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_size(11)
              .text_color(t.dim)
              .on_click((_e, cx) => this.clearCurrent(cx))
              .child("🧹 Clear")
          )
          // Close Dialog
          .child(
            div()
              .p(3)
              .rounded(4)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_size(12)
              .text_color(t.dim)
              .on_click(() => this.close())
              .child("✕")
          )
      );
  }

  renderFooter(t) {
    const active = this.getActiveTab();
    const content = this.editor ? this.editor.value() : active?.content || "";
    const lines = content ? content.split("\n").length : 0;
    const chars = content.length;

    return h_flex()
      .h(24)
      .flex_none()
      .px(10)
      .justify_between()
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(10.5)
      .text_color(t.dim)
      .child(
        h_flex()
          .gap(10)
          .child(div().child(`${lines} lines`))
          .child(div().child(`${chars} chars`))
      )
      .child(
        h_flex()
          .gap(6)
          .child(div().child("Esc to close · Ctrl+B s to toggle"))
      );
  }

  render(cx) {
    if (this.role === "controller") {
      return div().size(0);
    }

    const t = theme();

    return v_flex()
      .id("scratchpad-view")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .rounded(12)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.close(cx);
          cx.stop_propagation();
        }
      })
      .child(this.renderHeader(t, cx))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .p(6)
          .bg(t.surface)
          .cursor_text()
          .on_click(() => this.editorHandle?.focus())
          .when(Boolean(this.editor), (el) =>
            el.child(
              Editor.new(this.editor)
                .track_focus(this.editorHandle)
                .size_full()
            )
          )
      )
      .child(this.renderFooter(t));
  }
}
