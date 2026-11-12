// Loadout: resource × account matrix for agent-loadout. Click a cell (or Space) to switch it.
import { View, div } from "gpui-kit";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { notify, props, theme } from "herdr";
import {
  applyPending,
  cellKey,
  failuresOf,
  fetchHistory,
  fetchStatus,
  kindCounts,
  latestUndoable,
  loadConfig,
  nextEnabled,
  release,
  releasable,
  restoreFailures,
  summarize,
  toggle,
  undo,
  undoable,
  visibleRows,
  visibleTargets,
} from "./client.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REFRESH_MS = 30_000;
const COLUMN_WIDTH = 112;
const ROW_HEIGHT = 28;
const KIND_WIDTH = 84;

const CELL_LOOK = {
  ok: { glyph: "✓", label: "on", color: (t) => t.ansi2 },
  pending: { glyph: "+", label: "pending apply", color: (t) => t.ansi3 },
  conflict: { glyph: "!", label: "conflict", color: (t) => t.ansi1 },
  unresolved: { glyph: "✗", label: "unresolved", color: (t) => t.ansi1 },
  observed: { glyph: "○", label: "observed (app-managed)", color: (t) => t.accent },
  absent: { glyph: "◌", label: "observed, absent", color: (t) => t.dim },
  inherited: { glyph: "↥", label: "shared by all Codex profiles", color: (t) => t.accent },
  off: { glyph: "·", label: "off", color: (t) => t.dim },
  "n/a": { glyph: "–", label: "unsupported", color: (t) => t.border },
};

const KEYS = [
  ["↑↓←→ hjkl", "move"],
  ["space", "toggle"],
  ["x", "release (keep files)"],
  ["a", "apply pending"],
  ["u", "undo / redo"],
  ["/", "search"],
  ["tab", "kind filter"],
  ["1–9", "show / hide account"],
  ["0", "all accounts"],
  ["r", "refresh"],
  ["?", "this help"],
  ["esc", "close"],
];

const FOOTER_KEYS = [
  ["space", "toggle"],
  ["x", "release"],
  ["u", "undo"],
  ["1–9", "accounts"],
  ["?", "help"],
];

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
    this.accounts = new Set();
    this.showHelp = false;
    this.cursor = { row: 0, col: 0 };
    this.message = null;
    this.query = "";
    this.typing = false;
    this.lastRun = null;

    this.handle = cx.focus_handle();
    this.handle.focus();
    this.search = InputState.new({ placeholder: "Search resources" });
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
    this.refresh(cx, { history: true });
    cx.timer.every(REFRESH_MS, (cx) => {
      if (this.busy.size === 0) this.refresh(cx);
    });
  }

  refresh(cx, { history = false } = {}) {
    cx.spawn(async (cx) => {
      try {
        this.config ??= await loadConfig();
        this.status = await fetchStatus(this.config);
        if (history) this.lastRun = latestUndoable(await fetchHistory(this.config));
        this.error = null;
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.loading = false;
      this.clampCursor();
      cx.notify();
    });
  }

  targets() {
    return this.status ? visibleTargets(this.status, this.accounts) : [];
  }

  targetDetails() {
    const shown = new Set(this.targets());
    return this.status.targetDetails.filter((target) => shown.has(target.name));
  }

  rows() {
    return this.status
      ? visibleRows(this.status, this.kindFilter, this.query, this.targets())
      : [];
  }

  toggleAccount(name) {
    if (name === null) this.accounts = new Set();
    else if (this.accounts.has(name)) this.accounts.delete(name);
    else this.accounts.add(name);
    if (this.accounts.size === this.status.targets.length) this.accounts = new Set();
    this.cursor = { row: 0, col: 0 };
    this.clampCursor();
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
    const colCount = this.targets().length;
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
        this.lastRun =
          undoable(response, `toggle ${row.resource} ${target} ${enabled ? "on" : "off"}`) ??
          this.lastRun;
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
        this.lastRun = undoable(response, "apply") ?? this.lastRun;
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

  releaseCell(row, target, cx) {
    const key = cellKey(row.resource, target);
    if (!releasable(row.cells[target]) || this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await release(this.config, row.resource, target);
        this.lastRun = undoable(response, `release ${row.resource} ${target}`) ?? this.lastRun;
        const kept = response.released?.length ?? 0;
        this.message = `${row.resource} released on ${target} · ${kept ? `${kept} item(s) kept in place, now unmanaged` : "manifest only"} · u to undo`;
        this.status = await fetchStatus(this.config);
      } catch (error) {
        this.message = `✗ ${String(error?.message ?? error)}`;
        notify({ title: "Loadout release failed", body: this.message, level: "error" });
      }
      this.busy.delete(key);
      cx.notify();
    });
  }

  undoLast(cx) {
    const last = this.lastRun;
    if (!last || this.busy.has("undo")) return;
    this.busy.add("undo");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await undo(this.config, last.run);
        const failures = restoreFailures(response);
        for (const result of response.results ?? []) this.restartTargets.add(result.target);
        this.lastRun = undoable(response, `restore ${last.label}`);
        this.message = failures.length
          ? `⚠ undo left ${failures.length} item(s) alone: ${failures[0]}`
          : `Undid ${last.label} · u to redo`;
        if (failures.length) {
          notify({ title: "Loadout undo", body: failures.join("\n"), level: "warning" });
        }
        this.status = await fetchStatus(this.config);
      } catch (error) {
        this.message = `✗ ${String(error?.message ?? error)}`;
        notify({ title: "Loadout undo failed", body: this.message, level: "error" });
      }
      this.busy.delete("undo");
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
        if (row) this.toggleCell(row, this.targets()[this.cursor.col], cx);
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
      case "x": {
        const row = rows[this.cursor.row];
        if (row) this.releaseCell(row, this.targets()[this.cursor.col], cx);
        break;
      }
      case "u":
        this.undoLast(cx);
        break;
      case "?":
      case "shift-?":
      case "shift-/":
        this.showHelp = !this.showHelp;
        break;
      case "escape":
        if (!this.showHelp) return;
        this.showHelp = false;
        break;
      default: {
        const digit = /^[0-9]$/.test(event.keystroke) ? Number(event.keystroke) : null;
        if (digit === null) return;
        if (digit === 0) this.toggleAccount(null);
        else if (digit <= this.status.targets.length) this.toggleAccount(this.status.targets[digit - 1]);
        else return;
      }
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
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_semibold().text_size(14).child("Loadout"))
      .child(div().text_color(t.dim).text_size(12).truncate().child("resources per account"))
      .child(div().flex_1())
      .when(summary?.pending > 0 || applying, (el) =>
        el.child(
          button(t, "apply-all", applying ? null : `Apply ${summary.pending} pending`, "a", { primary: true })
            .when(applying, (b) => b.frames(SPIN, 90))
            .on_click((_event, cx) => this.applyAll(cx)),
        ),
      )
      .when(this.lastRun !== null, (el) =>
        el.child(
          button(t, "undo", this.busy.has("undo") ? null : `↶ ${shorten(this.lastRun.label, 28)}`, "u")
            .tooltip(`Undo: ${this.lastRun.label}`)
            .when(this.busy.has("undo"), (b) => b.frames(SPIN, 90))
            .on_click((_event, cx) => this.undoLast(cx)),
        ),
      )
      .child(button(t, "refresh", "↻ Refresh", "r").on_click((_event, cx) => this.refresh(cx)));
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
    const rows = this.rows();
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(this.renderToolbar(t))
      .child(this.renderColumns(t))
      .child(
        rows.length === 0
          ? centered(t)
              .gap(6)
              .child(div().text_color(t.muted).child("Nothing matches"))
              .child(div().text_size(11).text_color(t.dim).child("esc clears the search · 0 shows every account · tab changes the kind"))
          : v_flex()
              .id("loadout-rows")
              .flex_1()
              .min_h(0)
              .overflow_y_scrollbar()
              .children(rows.map((row, index) => this.renderRow(t, row, index))),
      );
  }

  renderToolbar(t) {
    const kinds = [{ kind: "all", count: this.status.rows.length }, ...kindCounts(this.status)];
    return v_flex()
      .flex_none()
      .px(16)
      .py(10)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(this.renderSearch(t))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).flex_none().child("Accounts"))
          .child(
            h_flex()
              .flex_none()
              .gap(4)
              .child(chip(t, "account-all", "All", null, this.accounts.size === 0, (cx) => this.pick(cx, () => this.toggleAccount(null))))
              .children(
                this.status.targets.map((name, index) =>
                  chip(t, `account-${name}`, name, null, this.accounts.has(name), (cx) =>
                    this.pick(cx, () => this.toggleAccount(name)),
                  ).tooltip(`${index + 1} to show / hide`),
                ),
              ),
          ),
      )
      .child(
        h_flex()
          .flex_wrap()
          .gap_x(4)
          .gap_y(4)
          .items_center()
          .children(
            kinds.map(({ kind, count }) =>
              chip(t, `kind-${kind}`, kind === "all" ? "All kinds" : kind, count, this.kindFilter === kind, (cx) =>
                this.pick(cx, () => {
                  this.kindFilter = kind;
                  this.cursor = { ...this.cursor, row: 0 };
                }),
              ),
            ),
          ),
      );
  }

  pick(cx, change) {
    change();
    this.clampCursor();
    cx.notify();
  }

  renderSearch(t) {
    const matches = this.query ? `${this.rows().length}` : null;
    return h_flex()
      .id("loadout-search")
      .w(260)
      .h(28)
      .flex_none()
      .px(10)
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
      .child(
        matches !== null
          ? div().text_size(11).text_color(t.dim).child(matches)
          : kbd(t, "/"),
      );
  }

  renderColumns(t) {
    return h_flex()
      .flex_none()
      .h(42)
      .px(16)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .flex_1()
          .gap(8)
          .text_size(11)
          .text_color(t.dim)
          .child(div().w(KIND_WIDTH).flex_none().child("kind"))
          .child(div().child("resource")),
      )
      .children(
        this.targetDetails().map((target) =>
          v_flex()
            .w(COLUMN_WIDTH)
            .flex_none()
            .items_center()
            .gap(1)
            .child(div().font_semibold().text_size(12).truncate().child(target.name))
            .child(
              this.restartTargets.has(target.name)
                ? div().text_size(10).text_color(t.ansi3).child("↻ restart sessions")
                : div().text_size(10).text_color(t.dim).child(columnNote(target)),
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
          .child(div().w(KIND_WIDTH).flex_none().text_size(11).text_color(t.dim).child(row.kind))
          .child(div().truncate().child(row.name))
          .when(row.observe, (el) =>
            el.child(div().text_size(10).text_color(t.accent).child("observe")),
          ),
      )
      .children(
        this.targets().map((target, col) =>
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
      .tooltip(`${target}: ${look.label}`)
      .when(toggleable, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.raised))
          .on_click((_event, cx) => {
            this.cursor = { row: this.rows().indexOf(row), col: this.targets().indexOf(target) };
            this.toggleCell(row, target, cx);
          }),
      )
      .when(busy, (el) => el.frames(SPIN, 90))
      .when(!busy, (el) => el.child(look.glyph));
  }

  renderFooter(t) {
    return v_flex()
      .flex_none()
      .border_t(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(11)
      .when(this.showHelp, (el) => el.child(this.renderHelp(t)))
      .child(
        h_flex()
          .h(34)
          .px(16)
          .gap(16)
          .items_center()
          .child(h_flex().flex_1().min_w(0).gap(10).items_center().children(this.statusNotes(t)))
          .child(
            h_flex()
              .flex_none()
              .gap(12)
              .items_center()
              .children(FOOTER_KEYS.map(([key, label]) => keyHint(t, key, label))),
          ),
      );
  }

  /** The left side of the footer: the last action's result, else what needs attention. */
  statusNotes(t) {
    const summary = this.status ? summarize(this.status) : null;
    if (this.message) return [div().truncate().text_color(t.muted).child(this.message)];
    if (!summary) return [];
    const notes = [
      summary.pending ? [t.ansi3, `+ ${summary.pending} pending`] : null,
      summary.conflict ? [t.ansi1, `! ${summary.conflict} conflict`] : null,
      summary.unresolved ? [t.ansi1, `✗ ${summary.unresolved} unresolved`] : null,
      summary.orphans ? [t.ansi3, `${summary.orphans} orphan`] : null,
      summary.warnings.length ? [t.ansi3, `⚠ ${summary.warnings.length} warning${summary.warnings.length > 1 ? "s" : ""} · ? to read`] : null,
    ].filter(Boolean);
    if (notes.length === 0) return [div().text_color(t.ansi2).child("✓ every account matches the manifest")];
    return notes.map(([color, text]) => div().flex_none().text_color(color).child(text));
  }

  renderHelp(t) {
    const warnings = this.status ? summarize(this.status).warnings : [];
    const section = (title) => div().text_size(10).font_semibold().text_color(t.dim).child(title.toUpperCase());
    return v_flex()
      .px(16)
      .py(12)
      .gap(10)
      .border_b(1)
      .border_color(t.border)
      .child(section("Cells"))
      .child(
        h_flex()
          .flex_wrap()
          .gap_x(18)
          .gap_y(6)
          .children(
            Object.values(CELL_LOOK).map((look) =>
              h_flex()
                .gap(6)
                .items_center()
                .child(div().w(12).text_color(look.color(t)).child(look.glyph))
                .child(div().text_color(t.muted).child(look.label)),
            ),
          ),
      )
      .child(section("Keys"))
      .child(
        h_flex()
          .flex_wrap()
          .gap_x(18)
          .gap_y(6)
          .children(KEYS.map(([key, label]) => keyHint(t, key, label))),
      )
      .when(warnings.length > 0, (el) =>
        el
          .child(section("Warnings"))
          .children(warnings.map((warning) => div().text_color(t.ansi3).child(`⚠ ${warning}`))),
      );
  }
}

/** Under an account name: its tool unless the name already says so, and its tags. */
function columnNote(target) {
  const parts = target.name.startsWith(target.tool) ? [] : [target.tool];
  return [...parts, ...target.tags].join(" · ") || "personal";
}

function chip(t, id, label, count, active, onClick) {
  return h_flex()
    .id(id)
    .flex_none()
    .gap(5)
    .items_center()
    .px(9)
    .h(24)
    .rounded(12)
    .cursor_pointer()
    .text_size(12)
    .border_1()
    .border_color(active ? t.accent : t.border)
    .bg(active ? t.selected : t.surface)
    .text_color(active ? t.foreground : t.muted)
    .hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => onClick(cx))
    .child(label)
    .when(count !== null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))));
}

function kbd(t, key) {
  return div()
    .flex_none()
    .px(5)
    .rounded(4)
    .border_1()
    .border_color(t.border)
    .bg(t.raised)
    .text_size(10)
    .text_color(t.muted)
    .child(key);
}

function keyHint(t, key, label) {
  return h_flex()
    .flex_none()
    .gap(5)
    .items_center()
    .child(kbd(t, key))
    .child(div().text_color(t.dim).child(label));
}

function button(t, id, label, key, { primary = false } = {}) {
  const el = h_flex()
    .id(`btn-${id}`)
    .flex_none()
    .gap(6)
    .items_center()
    .px(10)
    .h(28)
    .rounded(6)
    .cursor_pointer()
    .bg(primary ? t.selected : t.raised)
    .when(primary, (b) => b.border_1().border_color(t.accent))
    .text_size(12)
    .hover((s) => s.bg(t.hover));
  return label ? el.child(label).when(Boolean(key), (b) => b.child(kbd(t, key))) : el;
}

function shorten(label, max = 36) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function centered(t) {
  return v_flex().flex_1().items_center().justify_center().bg(t.popover);
}
