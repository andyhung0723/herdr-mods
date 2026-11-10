// Loadout: resource × account matrix for agent-loadout. Click a cell (or Space) to switch it.
import { View, div } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { notify, props, theme } from "herdr";
import {
  applyPending,
  cellKey,
  failuresOf,
  fetchStatus,
  kindCounts,
  loadConfig,
  nextEnabled,
  summarize,
  toggle,
  visibleRows,
} from "./client.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REFRESH_MS = 30_000;
const COLUMN_WIDTH = 116;
const ROW_HEIGHT = 28;

const CELL_LOOK = {
  ok: { glyph: "✓", color: (t) => t.ansi2 },
  pending: { glyph: "+", color: (t) => t.ansi3 },
  conflict: { glyph: "!", color: (t) => t.ansi1 },
  unresolved: { glyph: "✗", color: (t) => t.ansi1 },
  observed: { glyph: "○", color: (t) => t.accent },
  absent: { glyph: "◌", color: (t) => t.dim },
  off: { glyph: "·", color: (t) => t.dim },
  "n/a": { glyph: "–", color: (t) => t.border },
};

const LEGEND = "✓ on  + pending  ! conflict  ✗ unresolved  ○ observed  ◌ absent  · off  – unsupported";

export default class Loadout extends View {
  init(initialProps, cx) {
    this.overlayId = (initialProps ?? props() ?? {}).overlay ?? null;
    this.config = null;
    this.status = null;
    this.error = null;
    this.loading = true;
    this.busy = new Set();
    this.restartTargets = new Set();
    this.kindFilter = "all";
    this.cursor = { row: 0, col: 0 };
    this.message = null;
    this.query = "";
    this.typing = false;

    this.handle = cx.focus_handle();
    this.handle.focus();
    this.search = InputState.new({ placeholder: "Search  ( / )" });
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value();
      this.cursor = { ...this.cursor, row: 0 };
      cx.notify();
    });
    this.search.on("focus", (_event, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.search.on("blur", (_event, cx) => {
      this.typing = false;
      cx.notify();
    });
    this.search.on("submit", (_event, cx) => this.leaveSearch(cx));
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => {
      if (this.busy.size === 0) this.refresh(cx);
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        this.config ??= await loadConfig();
        this.status = await fetchStatus(this.config);
        this.error = null;
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.loading = false;
      this.clampCursor();
      cx.notify();
    });
  }

  rows() {
    return this.status ? visibleRows(this.status, this.kindFilter, this.query) : [];
  }

  leaveSearch(cx) {
    this.typing = false;
    this.handle.focus();
    cx.notify();
  }

  onSearchKey(event, cx) {
    switch (event.keystroke) {
      case "escape":
        if (this.query) {
          this.search.set_value("");
          this.query = "";
        } else {
          this.leaveSearch(cx);
        }
        break;
      case "enter":
      case "down":
        this.leaveSearch(cx);
        break;
      default:
        return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  clampCursor() {
    const rowCount = this.rows().length;
    const colCount = this.status?.targets.length ?? 0;
    this.cursor = {
      row: Math.max(0, Math.min(this.cursor.row, rowCount - 1)),
      col: Math.max(0, Math.min(this.cursor.col, colCount - 1)),
    };
  }

  toggleCell(row, target, cx) {
    const enabled = nextEnabled(row.cells[target]);
    const key = cellKey(row.resource, target);
    if (enabled === null || this.busy.has(key)) return;

    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await toggle(this.config, row.resource, target, enabled);
        const failures = failuresOf(response);
        if (response.toggle?.changed) this.restartTargets.add(target);
        this.message = failures.length
          ? `⚠ ${failures[0]}`
          : `${row.resource} → ${target}: ${enabled ? "on" : "off"} · restart ${target} sessions`;
        if (failures.length) {
          notify({ title: "Loadout", body: failures.join("\n"), level: "warning" });
        }
        this.status = await fetchStatus(this.config);
      } catch (error) {
        this.message = `✗ ${String(error?.message ?? error)}`;
        notify({ title: "Loadout toggle failed", body: this.message, level: "error" });
      }
      this.busy.delete(key);
      cx.notify();
    });
  }

  applyAll(cx) {
    if (this.busy.has("apply")) return;
    this.busy.add("apply");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await applyPending(this.config);
        const failures = failuresOf(response);
        const changed = (response.results ?? []).filter(({ entry }) =>
          ["create", "replace", "remove"].includes(entry.action),
        );
        for (const { entry } of changed) this.restartTargets.add(entry.target);
        this.message = failures.length
          ? `⚠ ${failures.length} item(s) need attention`
          : `Applied ${changed.length} change(s)`;
        this.status = await fetchStatus(this.config);
      } catch (error) {
        this.message = `✗ ${String(error?.message ?? error)}`;
      }
      this.busy.delete("apply");
      cx.notify();
    });
  }

  cycleFilter(step) {
    const kinds = ["all", ...kindCounts(this.status).map(({ kind }) => kind)];
    const index = kinds.indexOf(this.kindFilter);
    this.kindFilter = kinds[(index + step + kinds.length) % kinds.length];
    this.cursor = { ...this.cursor, row: 0 };
  }

  onKey(event, cx) {
    if (this.typing) return this.onSearchKey(event, cx);
    if (!this.status) return;
    const rows = this.rows();
    const move = (dRow, dCol) => {
      this.cursor = { row: this.cursor.row + dRow, col: this.cursor.col + dCol };
      this.clampCursor();
    };
    switch (event.keystroke) {
      case "up":
      case "k":
        move(-1, 0);
        break;
      case "down":
      case "j":
        move(1, 0);
        break;
      case "left":
      case "h":
        move(0, -1);
        break;
      case "right":
      case "l":
        move(0, 1);
        break;
      case "space":
      case "enter": {
        const row = rows[this.cursor.row];
        if (row) this.toggleCell(row, this.status.targets[this.cursor.col], cx);
        break;
      }
      case "tab":
        this.cycleFilter(1);
        break;
      case "shift-tab":
        this.cycleFilter(-1);
        break;
      case "/":
        this.typing = true;
        this.search.focus();
        break;
      case "r":
        this.refresh(cx);
        break;
      case "a":
        this.applyAll(cx);
        break;
      default:
        return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    return v_flex()
      .id("loadout-root")
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .child(this.renderHeader(t))
      .child(this.renderBody(t))
      .child(this.renderFooter(t));
  }

  renderHeader(t) {
    const summary = this.status ? summarize(this.status) : null;
    const applying = this.busy.has("apply");
    return h_flex()
      .h(46)
      .flex_none()
      .px(16)
      .gap(10)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_semibold().text_size(14).child("Loadout"))
      .child(div().text_color(t.dim).child("skills · hooks · MCP · plugins per account"))
      .child(div().flex_1())
      .when(summary?.pending > 0 || applying, (el) =>
        el.child(
          button(t, "apply-all", applying ? null : `Apply ${summary.pending} pending  (a)`)
            .when(applying, (b) => b.frames(SPIN, 90))
            .on_click((_event, cx) => this.applyAll(cx)),
        ),
      )
      .child(button(t, "refresh", "↻ Refresh  (r)").on_click((_event, cx) => this.refresh(cx)));
  }

  renderBody(t) {
    if (this.loading) {
      return centered(t).child(div().text_color(t.dim).frames(SPIN.map((s) => `${s}  loading…`), 90));
    }
    if (this.error) {
      return centered(t)
        .gap(8)
        .child(div().text_color(t.ansi1).font_semibold().child("Couldn't read the loadout"))
        .child(div().text_color(t.muted).max_w(640).child(this.error));
    }
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(this.renderFilters(t))
      .child(this.renderColumns(t))
      .child(
        v_flex()
          .id("loadout-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(this.rows().map((row, index) => this.renderRow(t, row, index))),
      );
  }

  renderFilters(t) {
    const chips = [{ kind: "all", count: this.status.rows.length }, ...kindCounts(this.status)];
    return h_flex()
      .flex_none()
      .px(16)
      .py(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(this.renderSearch(t))
      .children(
        chips.map(({ kind, count }) => {
          const active = this.kindFilter === kind;
          return div()
            .id(`filter-${kind}`)
            .px(8)
            .py(2)
            .rounded(10)
            .cursor_pointer()
            .text_size(12)
            .bg(active ? t.selected : t.surface)
            .text_color(active ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_event, cx) => {
              this.kindFilter = kind;
              this.cursor = { ...this.cursor, row: 0 };
              cx.notify();
            })
            .child(`${kind} ${count}`);
        }),
      );
  }

  renderSearch(t) {
    const matches = this.query ? `${this.rows().length}` : null;
    return h_flex()
      .id("loadout-search")
      .w(240)
      .h(28)
      .flex_none()
      .px(10)
      .mr(6)
      .gap(6)
      .items_center()
      .rounded(8)
      .border_1()
      .border_color(this.typing ? t.accent : t.border)
      .bg(t.surface)
      .cursor_text()
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .child(div().text_color(t.dim).child("⌕"))
      .child(Input.new(this.search).flex_1().min_w(0).text_size(12).text_color(t.foreground))
      .when(matches !== null, (el) => el.child(div().text_size(11).text_color(t.dim).child(matches)));
  }

  renderColumns(t) {
    return h_flex()
      .flex_none()
      .h(40)
      .px(16)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_1().text_color(t.dim).text_size(12).child("resource"))
      .children(
        this.status.targetDetails.map((target) =>
          v_flex()
            .w(COLUMN_WIDTH)
            .flex_none()
            .items_center()
            .child(div().font_semibold().text_size(12).child(target.name))
            .child(
              this.restartTargets.has(target.name)
                ? div().text_size(10).text_color(t.ansi3).child("↻ restart sessions")
                : div().text_size(10).text_color(t.dim).child(target.tool),
            ),
        ),
      );
  }

  renderRow(t, row, index) {
    const focusedRow = index === this.cursor.row;
    return h_flex()
      .id(`row-${row.resource}`)
      .h(ROW_HEIGHT)
      .flex_none()
      .px(16)
      .items_center()
      .bg(focusedRow ? t.selected : t.popover)
      .hover((s) => s.bg(t.hover))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(8)
          .items_center()
          .child(div().w(84).flex_none().text_size(11).text_color(t.dim).child(row.kind))
          .child(div().truncate().child(row.name))
          .when(row.observe, (el) =>
            el.child(div().text_size(10).text_color(t.accent).child("observe")),
          ),
      )
      .children(
        this.status.targets.map((target, col) =>
          this.renderCell(t, row, target, {
            focused: focusedRow && col === this.cursor.col,
          }),
        ),
      );
  }

  renderCell(t, row, target, { focused }) {
    const cell = row.cells[target] ?? "off";
    const look = CELL_LOOK[cell] ?? CELL_LOOK.off;
    const busy = this.busy.has(cellKey(row.resource, target));
    const toggleable = nextEnabled(cell) !== null;
    return div()
      .id(`cell-${row.resource}-${target}`)
      .w(COLUMN_WIDTH)
      .h(ROW_HEIGHT - 6)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .when(focused, (el) => el.border_1().border_color(t.accent))
      .text_color(look.color(t))
      .when(toggleable, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.raised))
          .on_click((_event, cx) => {
            this.cursor = { row: this.rows().indexOf(row), col: this.status.targets.indexOf(target) };
            this.toggleCell(row, target, cx);
          }),
      )
      .when(busy, (el) => el.frames(SPIN, 90))
      .when(!busy, (el) => el.child(look.glyph));
  }

  renderFooter(t) {
    const summary = this.status ? summarize(this.status) : null;
    const notes = [
      this.message,
      summary?.conflict ? `${summary.conflict} conflict` : null,
      summary?.unresolved ? `${summary.unresolved} unresolved` : null,
      summary?.orphans ? `${summary.orphans} orphan` : null,
      ...(summary?.warnings ?? []).map((warning) => `⚠ ${warning}`),
    ].filter(Boolean);
    return v_flex()
      .flex_none()
      .px(16)
      .py(8)
      .gap(4)
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(11)
      .children(notes.map((note) => div().truncate().text_color(t.muted).child(note)))
      .child(div().text_color(t.dim).child(`${LEGEND}    ↑↓←→ move · space toggle · / search · tab filter`));
  }
}

function button(t, id, label) {
  const el = div()
    .id(`btn-${id}`)
    .px(10)
    .py(4)
    .rounded(6)
    .cursor_pointer()
    .bg(t.raised)
    .text_size(12)
    .hover((s) => s.bg(t.hover));
  return label ? el.child(label) : el;
}

function centered(t) {
  return v_flex().flex_1().items_center().justify_center().bg(t.popover);
}
