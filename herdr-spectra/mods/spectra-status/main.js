// Spectra (SDD) Inspector & Status mod for Herdr — read-only.
// Supports Right-Side Panel mode (like Agent Inspector) and Popup Dialog mode.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, closeOverlay, openOverlay, setShared, shared,
  focused, panes, spaces, agents, exec, watchFolder, home, layout,
} from "herdr";
import {
  findSpectraRoot, collectOverview, collectChangeDetail, resolveSpectraBin, basename,
} from "./collector.js";

const MOD = "spectra-status";
const ICON = `mods/${MOD}/spectra.svg`;
const OVERLAY_KEY = "spectra-status.open-overlay";
const ROOT_KEY = "spectra-status.last-root";

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return null;
}

function getPanelWidth() {
  try {
    const root = typeof layout === "function" ? layout() : null;
    const panel = findNode(root, "panel");
    const px = panel?.size?.px;
    return typeof px === "number" && px > 0 ? px : null;
  } catch {
    return null;
  }
}

function cleanPath(p) {
  if (!p) return "";
  try {
    const h = typeof home === "function" ? home() : "";
    if (h && p.startsWith(h)) return "~" + p.slice(h.length);
  } catch {}
  return p;
}

function statusColor(t, status) {
  switch (status) {
    case "done":
      return t.ansi2 ?? "#a6e3a1";
    case "in-progress":
      return t.accent ?? "#89b4fa";
    case "ready":
      return t.blocked || "#e3814f";
    case "blocked":
      return t.ansi1 ?? "#f38ba8";
    case "parked":
      return t.dim;
    default:
      return t.muted;
  }
}

function progressBar(t, percent, color, height = 4) {
  return h_flex()
    .h(height)
    .w_full()
    .rounded(2)
    .bg(t.background)
    .overflow_hidden()
    .child(
      div()
        .h_full()
        .w(`${Math.max(percent > 0 ? 2 : 0, Math.min(100, percent))}%`)
        .bg(color)
        .rounded(2)
    );
}

function resolveFocusedCwd() {
  const focus = (typeof focused === "function" ? focused() : null) || {};
  const allAgents = (typeof agents === "function" ? agents() : null) || [];
  const allSpaces = (typeof spaces === "function" ? spaces() : null) || [];
  const allPanes = (typeof panes === "function" ? panes() : null) || [];

  const activeSpace =
    allSpaces.find((s) => s.id === focus?.space) ??
    allSpaces.find((s) => s.active) ??
    allSpaces[0];

  const activeTabId = focus?.tab || activeSpace?.tabs?.find((t) => t.active)?.id;

  let activePane = focus?.pane ? allPanes.find((p) => p.pane === focus.pane) : null;
  if (!activePane && activeTabId) {
    activePane =
      allPanes.find((p) => p.tab === activeTabId && p.focused) ??
      allPanes.find((p) => p.tab === activeTabId && p.program?.agent) ??
      allPanes.find((p) => p.tab === activeTabId);
  }
  if (!activePane) {
    activePane = allPanes.find((p) => p.focused && p.cwd);
  }

  let currentAgent = focus?.agent ? allAgents.find((a) => a.address === focus.agent) : null;
  if (!currentAgent && activePane) {
    currentAgent = allAgents.find(
      (a) => a.pane === activePane.pane || (activePane.terminal && a.address === activePane.terminal)
    );
  }
  if (!currentAgent && activeTabId) {
    currentAgent = allAgents.find((a) => a.tab === activeTabId);
  }
  if (!currentAgent && activeSpace) {
    currentAgent = allAgents.find((a) => a.space === activeSpace.id && a.focused);
  }

  return (
    currentAgent?.cwd ||
    activePane?.cwd ||
    focus?.cwd ||
    activeSpace?.folder ||
    activeSpace?.cwd ||
    ""
  );
}

export default class SpectraStatus extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "panel");
    this.root = p.root ?? null;
    this.data = p.initialData ?? null;
    this.loading = false;
    this.error = null;

    this.activeTab = "tasks"; // "tasks" | "changes" | "specs"
    this.selected = p.selected ?? null; // { name, parked }
    this.details = new Map(); // name -> detail
    this.detailLoading = false;
    this.collapsed = new Set();

    this.lastCwd = null;
    this.lastWidthBucket = null;
    this.watchRoot = null;
    this.watchGen = 0;
    this.reloadInflight = false;
    this.reloadQueued = false;

    this.handle = cx.focus_handle();
    if (this.role === "dialog") this.handle.focus();

    // Fast dirty-check every 500ms: follows focused pane/agent & panel width changes immediately
    cx.timer.every(500, (tcx) => {
      this.syncCwd(tcx);
      const w = getPanelWidth();
      const bucket = w === null ? "normal" : w < 380 ? "very-narrow" : w < 420 ? "narrow" : "normal";
      if (bucket !== this.lastWidthBucket) {
        this.lastWidthBucket = bucket;
        tcx?.notify?.();
      }
    });
    // Fallback revalidation every 15s
    cx.timer.every(15000, (tcx) => this.reload(tcx));

    this.syncCwd(cx, true);
  }

  // --- Data ---------------------------------------------------------------

  syncCwd(cx, force = false) {
    let cwd = resolveFocusedCwd();
    if (!cwd && this.role === "dialog") cwd = shared(ROOT_KEY) || this.root || "";
    if (!force && cwd === this.lastCwd) return;
    this.lastCwd = cwd;

    cx.spawn(async (scx) => {
      let root = await findSpectraRoot(cwd).catch(() => null);
      if (!root && this.role === "dialog") root = this.root || shared(ROOT_KEY) || null;
      if (root === this.root && this.data && !force) return;
      if (root !== this.root) {
        this.root = root;
        this.data = null;
        this.details.clear();
        this.selected = null;
      }
      if (root) setShared(ROOT_KEY, root);
      await this.reload(scx);
      this.startWatch(root, this.data?.specDir || "openspec", scx);
    });
  }

  startWatch(root, specDir, cx) {
    const target = root ? `${root}/${specDir}` : null;
    if (this.watchRoot === target) return;
    this.watchRoot = target;
    const gen = ++this.watchGen;
    if (!target || typeof watchFolder !== "function") return;
    cx.spawn(async (wcx) => {
      while (gen === this.watchGen) {
        try {
          await watchFolder(target);
        } catch {
          break;
        }
        if (gen !== this.watchGen) break;
        this.details.clear();
        await this.reload(wcx);
      }
    });
  }

  async reload(cx) {
    if (this.reloadInflight) {
      this.reloadQueued = true;
      return;
    }
    this.reloadInflight = true;
    const root = this.root;
    if (!root) {
      this.data = null;
      this.reloadInflight = false;
      cx?.notify?.();
      return;
    }
    this.loading = true;
    cx?.notify?.();
    try {
      const overview = await collectOverview(root);
      if (root !== this.root) return;
      this.data = overview;
      this.error = overview.available ? null : overview.error;
      const all = [...(overview.changes ?? []), ...(overview.parked ?? [])];
      if (!this.selected || !all.some((c) => c.name === this.selected.name && c.parked === this.selected.parked)) {
        const focus = overview.focus;
        this.selected = focus
          ? { name: focus.name, parked: false }
          : all[0]
          ? { name: all[0].name, parked: all[0].parked }
          : null;
      }
      await this.loadDetail(cx, true);
    } catch (err) {
      this.error = String(err);
    } finally {
      this.loading = false;
      this.reloadInflight = false;
      cx?.notify?.();
      if (this.reloadQueued) {
        this.reloadQueued = false;
        this.reload(cx);
      }
    }
  }

  async loadDetail(cx, force = false) {
    const sel = this.selected;
    if (!sel || !this.root) return;
    const key = `${sel.parked ? "parked:" : ""}${sel.name}`;
    if (!force && this.details.has(key)) return;
    this.detailLoading = true;
    cx?.notify?.();
    try {
      const detail = await collectChangeDetail(this.root, sel.name, sel.parked);
      if (detail) this.details.set(key, detail);
    } catch {}
    this.detailLoading = false;
    cx?.notify?.();
  }

  select(cx, change, switchToTasks = false) {
    this.selected = { name: change.name, parked: Boolean(change.parked) };
    if (switchToTasks) this.activeTab = "tasks";
    this.collapsed.clear();
    cx.spawn(async (scx) => this.loadDetail(scx));
    cx?.notify?.();
  }

  moveSelection(cx, delta) {
    const all = [...(this.data?.changes ?? []), ...(this.data?.parked ?? [])];
    if (!all.length) return;
    const idx = all.findIndex((c) => c.name === this.selected?.name && c.parked === this.selected?.parked);
    const next = all[Math.max(0, Math.min(all.length - 1, (idx < 0 ? 0 : idx) + delta))];
    this.select(cx, next);
  }

  // --- Actions ------------------------------------------------------------

  openDetailedDialog() {
    if (this.overlayId) return;
    const existing = shared(OVERLAY_KEY);
    if (existing) closeOverlay(existing);
    const id = openOverlay({
      mod: MOD,
      kind: "dialog",
      width: 900,
      height: 680,
      props: { role: "dialog", root: this.root, initialData: this.data, selected: this.selected },
    });
    setShared(OVERLAY_KEY, id);
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  openMarkdown(file) {
    if (!file) return;
    if (this.overlayId) this.close();
    openOverlay({
      mod: "markdown-preview",
      kind: "dialog",
      width: 0.85,
      height: 0.85,
      props: { file },
    });
  }

  async openInSpectraApp() {
    if (!this.root) return;
    const bin = await resolveSpectraBin();
    const res = await exec(bin, [this.root], { cwd: this.root, timeout: 8000 }).catch(() => null);
    if (res?.code !== 0) {
      await exec("open", ["-a", "Spectra", this.root]).catch(() => null);
    }
  }

  // --- Right-Side Panel Mode (like Agent Inspector) -----------------------

  renderPanelHeader(t, isNarrow, isVeryNarrow) {
    const d = this.data;
    const focus = d?.focus;
    const projectLabel = d?.project || (this.root ? basename(this.root) : "No Project");
    const hasRoot = Boolean(this.root);

    return v_flex()
      .w_full()
      .p(10)
      .gap(isNarrow ? 4 : 6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(svg(ICON).size(16).flex_none().text_color(t.accent ?? t.working ?? t.foreground))
              .when(!isVeryNarrow, (el) =>
                el.child(div().text_size(13.5).font_bold().text_color(t.foreground).child("Spectra"))
              )
              .child(
                div()
                  .px(6)
                  .h(18)
                  .flex_none()
                  .rounded(4)
                  .bg(((hasRoot ? (t.working ?? "#10b981") : t.dim) || "#3b82f6") + "22")
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(hasRoot ? (t.working ?? "#10b981") : t.dim)
                  .flex()
                  .items_center()
                  .child(hasRoot ? `🎯 ${projectLabel}` : "No Spec")
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .flex_none()
              .when(hasRoot, (el) =>
                el.child(
                  div()
                    .id("btn-open-spectra-app")
                    .px(6)
                    .h(20)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Open project in Spectra.app")
                    .on_click(() => this.openInSpectraApp())
                    .flex()
                    .items_center()
                    .child(isVeryNarrow ? "App ↗" : "Spectra ↗")
                )
              )
              .when(hasRoot && !isVeryNarrow, (el) =>
                el.child(
                  div()
                    .id("btn-expand-spectra-dialog")
                    .px(6)
                    .h(20)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Open wide popup dialog (Ctrl+B Shift+S)")
                    .on_click(() => this.openDetailedDialog())
                    .flex()
                    .items_center()
                    .child("Popup")
                )
              )
              .child(
                div()
                  .id("btn-refresh-spectra")
                  .size(22)
                  .rounded(4)
                  .flex()
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("Refresh Spectra status")
                  .on_click((_e, cx) => {
                    this.details.clear();
                    this.reload(cx);
                  })
                  .child(
                    svg("mods/workspace-chrome/clock.svg")
                      .size(13)
                      .text_color(this.loading ? (t.working ?? t.foreground) : t.dim)
                  )
              )
          )
      )
      .child(
        h_flex()
          .w_full()
          .gap(8)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .items_center()
              .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none())
              .child(div().flex_1().min_w(0).truncate().child(cleanPath(this.root || this.lastCwd) || "No workspace"))
          )
          .when(Boolean(focus && !isNarrow), (el) =>
            el.child(
              div()
                .flex_none()
                .text_color(statusColor(t, focus.status))
                .child(`${focus.completedTasks}/${focus.totalTasks} tasks (${focus.percent}%)`)
            )
          )
      );
  }

  renderTabButton(t, id, label, iconSvg, count = null, isNarrow = false, isVeryNarrow = false) {
    const on = this.activeTab === id;
    return h_flex()
      .id(`spectra-tab-${id}`)
      .h(26)
      .px(isNarrow ? 6 : 8)
      .gap(isNarrow ? 4 : 5)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.activeTab = id;
        cx.notify();
      })
      .when(!isVeryNarrow, (el) => el.child(svg(iconSvg).size(13).flex_none()))
      .child(div().text_size(isNarrow ? 11.5 : 12).font_medium().child(label))
      .when(count !== null && (!isNarrow || on), (el) =>
        el.child(
          div()
            .px(5)
            .h(16)
            .rounded(8)
            .bg(on ? t.raised : t.chrome)
            .text_size(10.5)
            .text_color(on ? t.accent ?? t.foreground : t.dim)
            .flex()
            .items_center()
            .child(String(count))
        )
      );
  }

  renderPanelTasksTab(t, isNarrow) {
    const d = this.data;
    const allChanges = [...(d?.changes ?? []), ...(d?.parked ?? [])];
    const sel = this.selected;

    let body = v_flex().flex_1().w_full().p(12).gap(12).overflow_y_scrollbar();

    if (!allChanges.length) {
      return body.child(
        v_flex()
          .p(16)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .items_center()
          .gap(4)
          .child(div().text_size(12).font_medium().text_color(t.muted).child("No active changes"))
          .child(div().text_size(11).text_color(t.dim).child("Create one with `/spectra-propose` or `spectra new change`"))
      );
    }

    // Change selector pill bar when project has multiple changes
    if (allChanges.length > 1) {
      let pills = h_flex().gap(4).flex_wrap();
      for (const c of allChanges) {
        const isSel = sel?.name === c.name && sel?.parked === c.parked;
        const cColor = statusColor(t, c.status);
        pills = pills.child(
          h_flex()
            .id(`pill-change-${c.parked ? "p-" : ""}${c.name}`)
            .px(7)
            .h(22)
            .gap(5)
            .items_center()
            .rounded(5)
            .border(1)
            .border_color(isSel ? cColor : t.border)
            .bg(isSel ? t.selected : t.raised)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.select(cx, c))
            .child(div().size(6).rounded(3).flex_none().bg(cColor))
            .child(div().text_size(11).text_color(isSel ? t.foreground : t.muted).child(c.name))
            .child(
              div()
                .text_size(10)
                .text_color(cColor)
                .child(c.totalTasks ? `${c.completedTasks}/${c.totalTasks}` : c.status)
            )
        );
      }
      body = body.child(pills);
    }

    return body.child(this.renderChangeDetailContent(t, isNarrow));
  }

  renderChangeDetailContent(t, isNarrow = false) {
    const sel = this.selected;
    if (!sel) {
      return div().text_size(12).text_color(t.dim).child("Select a change to inspect");
    }

    const key = `${sel.parked ? "parked:" : ""}${sel.name}`;
    const detail = this.details.get(key);
    const change = [...(this.data?.changes ?? []), ...(this.data?.parked ?? [])].find(
      (c) => c.name === sel.name && c.parked === sel.parked
    );
    const color = statusColor(t, change?.status);

    let out = v_flex()
      .gap(12)
      // Summary card
      .child(
        v_flex()
          .p(10)
          .gap(6)
          .rounded(8)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(13)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(sel.name)
              )
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .flex_none()
                  .border_1()
                  .border_color(color)
                  .text_size(10)
                  .text_color(color)
                  .child(change?.status ?? "")
              )
          )
          .when(Boolean(change?.summary), (el) =>
            el.child(div().text_size(11.5).text_color(t.muted).child(change.summary))
          )
          .when(Boolean(change?.totalTasks), (el) =>
            el.child(
              h_flex()
                .items_center()
                .gap(8)
                .child(div().flex_1().child(progressBar(t, change.percent, color, 5)))
                .child(
                  div()
                    .text_size(11)
                    .flex_none()
                    .font_medium()
                    .text_color(color)
                    .child(`${change.completedTasks}/${change.totalTasks} (${change.percent}%)`)
                )
            )
          )
      );

    if (!detail) {
      return out.child(div().text_size(11.5).text_color(t.dim).child(this.detailLoading ? "Loading artifacts & tasks…" : ""));
    }

    // Artifact DAG chips
    if (detail.artifacts.length) {
      let chips = h_flex().gap(5).flex_wrap();
      detail.artifacts.forEach((a, idx) => {
        const c = statusColor(t, a.status);
        let chip = h_flex()
          .id(`artifact-${a.id}`)
          .px(7)
          .h(22)
          .gap(4)
          .items_center()
          .rounded(5)
          .border_1()
          .border_color(t.border)
          .bg(t.raised)
          .child(div().w(6).h(6).rounded(3).bg(c))
          .child(div().text_size(11).text_color(t.foreground).child(a.id))
          .when(!isNarrow, (el) => el.child(div().text_size(10).text_color(c).child(a.status)));
        if (a.file) {
          chip = chip
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip(`Open ${a.outputPath} in Markdown Preview`)
            .on_click(() => this.openMarkdown(a.file));
        }
        if (idx > 0 && !isNarrow) {
          chips = chips.child(div().text_size(10).text_color(t.dim).child("→"));
        }
        chips = chips.child(chip);
      });
      out = out.child(
        v_flex()
          .gap(5)
          .child(div().text_size(10.5).font_bold().text_color(t.muted).child("ARTIFACT DAG (CLICK TO PREVIEW)"))
          .child(chips)
      );
    }

    // Task checklist sections
    if (detail.sections.length) {
      let tasks = v_flex().gap(8);
      detail.sections.forEach((s, sIdx) => {
        const sKey = `${sIdx}`;
        const isCollapsed = this.collapsed.has(sKey);
        const sDone = s.completed >= s.total;
        let block = v_flex()
          .p(8)
          .gap(5)
          .rounded(7)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id(`section-${sIdx}`)
              .items_center()
              .justify_between()
              .gap(6)
              .cursor_pointer()
              .on_click((_e, cx) => {
                if (this.collapsed.has(sKey)) this.collapsed.delete(sKey);
                else this.collapsed.add(sKey);
                cx.notify();
              })
              .child(
                h_flex()
                  .flex_1()
                  .gap(5)
                  .items_center()
                  .min_w(0)
                  .child(div().text_size(10).text_color(t.dim).flex_none().child(isCollapsed ? "▸" : "▾"))
                  .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(s.title))
              )
              .child(
                div()
                  .px(5)
                  .h(16)
                  .rounded(4)
                  .flex_none()
                  .bg((sDone ? (t.ansi2 ?? "#10b981") : t.accent ?? "#3b82f6") + "22")
                  .text_size(10)
                  .font_semibold()
                  .text_color(sDone ? (t.ansi2 ?? "#10b981") : (t.accent ?? t.foreground))
                  .flex()
                  .items_center()
                  .child(`${s.completed}/${s.total}`)
              )
          );
        if (!isCollapsed) {
          for (const task of s.tasks) {
            block = block.child(
              h_flex()
                .gap(6)
                .items_start()
                .pl(12)
                .child(
                  div()
                    .text_size(11.5)
                    .flex_none()
                    .text_color(task.done ? (t.ansi2 ?? "#10b981") : t.dim)
                    .child(task.done ? "☑" : "☐")
                )
                .when(Boolean(task.id), (el) =>
                  el.child(div().text_size(11).flex_none().font_semibold().text_color(t.dim).child(task.id))
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .text_size(11.5)
                    .text_color(task.done ? t.muted : t.foreground)
                    .child(task.text)
                )
            );
          }
        }
        tasks = tasks.child(block);
      });
      out = out.child(
        v_flex()
          .gap(6)
          .child(div().text_size(10.5).font_bold().text_color(t.muted).child("TASKS CHECKLIST"))
          .child(tasks)
      );
    }

    return out;
  }

  renderPanelChangesTab(t) {
    const d = this.data;
    const changes = d?.changes ?? [];
    const parked = d?.parked ?? [];

    let list = v_flex().flex_1().w_full().p(12).gap(8).overflow_y_scrollbar();

    if (!changes.length && !parked.length) {
      return list.child(div().text_size(12).text_color(t.dim).child("No changes found in this project."));
    }

    if (changes.length) {
      list = list.child(div().text_size(10.5).font_bold().text_color(t.muted).child(`ACTIVE & COMPLETED (${changes.length})`));
      for (const c of changes) {
        list = list.child(this.renderChangeCard(t, c));
      }
    }

    if (parked.length) {
      list = list.child(div().pt(6).text_size(10.5).font_bold().text_color(t.muted).child(`PARKED (${parked.length})`));
      for (const c of parked) {
        list = list.child(this.renderChangeCard(t, c));
      }
    }

    return list;
  }

  renderChangeCard(t, c) {
    const isSel = this.selected?.name === c.name && this.selected?.parked === c.parked;
    const color = statusColor(t, c.status);
    return v_flex()
      .id(`card-change-${c.parked ? "p-" : ""}${c.name}`)
      .p(10)
      .gap(5)
      .rounded(8)
      .bg(isSel ? t.selected : t.raised)
      .border(1)
      .border_color(isSel ? color : t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(cx, c, true))
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .gap(6)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(c.name))
          .child(
            div()
              .text_size(10.5)
              .flex_none()
              .font_medium()
              .text_color(color)
              .child(c.totalTasks ? `${c.completedTasks}/${c.totalTasks} (${c.percent}%)` : c.status)
          )
      )
      .child(progressBar(t, c.percent, color, 4))
      .when(Boolean(c.summary), (el) =>
        el.child(div().text_size(11).text_color(t.dim).truncate().child(c.summary))
      );
  }

  renderPanelSpecsTab(t) {
    const specs = this.data?.specs ?? [];
    let list = v_flex().flex_1().w_full().p(12).gap(6).overflow_y_scrollbar();

    if (!specs.length) {
      return list.child(div().text_size(12).text_color(t.dim).child("No domain specs found in this project."));
    }

    list = list.child(div().text_size(10.5).font_bold().text_color(t.muted).child(`DOMAIN SPECS (${specs.length})`));
    for (const s of specs) {
      list = list.child(
        h_flex()
          .id(`panel-spec-${s.id}`)
          .p(9)
          .gap(8)
          .items_center()
          .justify_between()
          .rounded(7)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .cursor_pointer()
          .hover((st) => st.bg(t.hover))
          .tooltip("Open spec.md in Markdown Preview")
          .on_click(() => this.openMarkdown(`${s.path}/spec.md`))
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(svg("mods/workspace-chrome/file-text.svg").size(13).flex_none().text_color(t.accent))
              .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(s.id))
          )
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child("spec.md ↗"))
      );
    }
    return list;
  }

  renderPanel(t) {
    const panelWidth = getPanelWidth();
    const isNarrow = panelWidth !== null && panelWidth < 420;
    const isVeryNarrow = panelWidth !== null && panelWidth < 380;
    const d = this.data;
    const changesCount = (d?.changes?.length ?? 0) + (d?.parked?.length ?? 0);
    const specsCount = d?.specs?.length ?? 0;
    const focus = d?.focus;
    const tasksCount = focus?.totalTasks ? `${focus.completedTasks}/${focus.totalTasks}` : null;

    let content;
    if (!this.root) {
      content = v_flex()
        .flex_1()
        .p(16)
        .items_center()
        .justify_center()
        .gap(6)
        .child(div().text_size(12.5).font_medium().text_color(t.muted).child("No Spectra project in current workspace"))
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child("Switch to a project containing `.spectra.yaml`, `docs/spectra/`, or `openspec/`")
        );
    } else if (d && !d.available) {
      content = v_flex()
        .flex_1()
        .p(16)
        .items_center()
        .justify_center()
        .child(div().text_size(12).text_color(t.ansi1).child(d.error || "spectra CLI unavailable"));
    } else {
      content = v_flex()
        .flex_1()
        .w_full()
        .min_h(0)
        .when(this.activeTab === "tasks", (el) => el.child(this.renderPanelTasksTab(t, isNarrow)))
        .when(this.activeTab === "changes", (el) => el.child(this.renderPanelChangesTab(t)))
        .when(this.activeTab === "specs", (el) => el.child(this.renderPanelSpecsTab(t)));
    }

    return v_flex()
      .id("spectra-panel")
      .size_full()
      .bg(t.chrome)
      .child(this.renderPanelHeader(t, isNarrow, isVeryNarrow))
      .child(
        h_flex()
          .w_full()
          .px(isNarrow ? 6 : 8)
          .py(4)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(this.renderTabButton(t, "tasks", "Tasks", ICON, tasksCount, isNarrow, isVeryNarrow))
          .child(this.renderTabButton(t, "changes", "Changes", "mods/workspace-chrome/layers.svg", changesCount, isNarrow, isVeryNarrow))
          .child(this.renderTabButton(t, "specs", "Specs", "mods/workspace-chrome/file-text.svg", specsCount, isNarrow, isVeryNarrow))
      )
      .child(content);
  }

  // --- Dialog Mode (Ctrl+B Shift+S) ---------------------------------------

  renderButton(t, id, label, onClick, tooltip) {
    const btn = h_flex()
      .id(id)
      .px(8)
      .h(24)
      .flex_none()
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .text_size(11.5)
      .text_color(t.foreground)
      .on_click((_e, cx) => onClick(cx))
      .child(label);
    return tooltip ? btn.tooltip(tooltip) : btn;
  }

  renderSidebarList(t) {
    const d = this.data;
    let list = v_flex()
      .id("spectra-change-list")
      .w(290)
      .flex_none()
      .h_full()
      .p(8)
      .gap(4)
      .border_r(1)
      .border_color(t.border)
      .overflow_y_scrollbar();

    if (!d?.available) return list;

    list = list.child(div().px(6).pt(4).text_size(10.5).font_semibold().text_color(t.dim).child(`CHANGES (${d.changes.length})`));
    for (const c of d.changes) list = list.child(this.renderChangeCard(t, c));

    if (d.parked.length) {
      list = list.child(div().px(6).pt(8).text_size(10.5).font_semibold().text_color(t.dim).child(`PARKED (${d.parked.length})`));
      for (const c of d.parked) list = list.child(this.renderChangeCard(t, c));
    }

    list = list.child(div().px(6).pt(8).text_size(10.5).font_semibold().text_color(t.dim).child(`SPECS (${d.specs.length})`));
    for (const s of d.specs) {
      list = list.child(
        h_flex()
          .id(`spec-${s.id}`)
          .px(10)
          .py(5)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((st) => st.bg(t.hover))
          .tooltip("Open spec.md in Markdown Preview")
          .on_click(() => this.openMarkdown(`${s.path}/spec.md`))
          .child(div().text_size(11.5).text_color(t.muted).min_w(0).truncate().child(s.id))
      );
    }
    return list;
  }

  renderDialog(t) {
    const d = this.data;
    let body;
    if (!this.root) {
      body = v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(6)
        .child(div().text_size(13).text_color(t.muted).child("No Spectra project found"))
        .child(div().text_size(11.5).text_color(t.dim).child("Focus a pane inside a folder with .spectra.yaml, docs/spectra/, or openspec/"));
    } else if (d && !d.available) {
      body = v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .child(div().text_size(12).text_color(t.ansi1).child(d.error || "spectra CLI unavailable"));
    } else {
      body = h_flex()
        .flex_1()
        .min_h(0)
        .child(this.renderSidebarList(t))
        .child(
          v_flex()
            .id("spectra-detail")
            .flex_1()
            .min_w(0)
            .h_full()
            .p(16)
            .overflow_y_scrollbar()
            .child(this.renderChangeDetailContent(t, false))
        );
    }

    return v_flex()
      .id("spectra-dialog")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .rounded(12)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          this.close();
          cx.stop_propagation();
        } else if (e.key === "down" || e.key === "j") {
          this.moveSelection(cx, 1);
          cx.stop_propagation();
        } else if (e.key === "up" || e.key === "k") {
          this.moveSelection(cx, -1);
          cx.stop_propagation();
        } else if (e.key === "r") {
          this.details.clear();
          this.reload(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(16)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(svg(ICON).size(18).flex_none().text_color(t.accent))
          .child(div().font_semibold().text_size(14).text_color(t.foreground).flex_none().child("Spectra"))
          .when(Boolean(d?.project || this.root), (el) =>
            el.child(
              div()
                .text_size(12)
                .text_color(t.muted)
                .min_w(0)
                .truncate()
                .tooltip(this.root || "")
                .child(`· ${d?.project || basename(this.root)}`)
            )
          )
          .child(div().flex_1())
          .when(this.loading, (el) => el.child(div().text_size(11).text_color(t.dim).flex_none().child("Updating…")))
          .child(
            this.renderButton(t, "spectra-refresh", "↻ Refresh", (cx) => {
              this.details.clear();
              this.reload(cx);
            })
          )
          .when(Boolean(this.root), (el) =>
            el.child(
              this.renderButton(t, "spectra-open-app", "Open in Spectra ↗", () => this.openInSpectraApp(), "Open this project in Spectra.app")
            )
          )
      )
      .child(body)
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .px(16)
          .items_center()
          .justify_between()
          .bg(t.surface)
          .border_t(1)
          .border_color(t.border)
          .child(div().text_size(11).text_color(t.dim).min_w(0).truncate().child(this.root || ""))
          .child(div().text_size(11).text_color(t.dim).flex_none().child("↑↓ select · r refresh · Esc close"))
      );
  }

  render(cx) {
    const t = theme();
    if (this.role === "dialog") return this.renderDialog(t, cx);
    return this.renderPanel(t, cx);
  }
}
