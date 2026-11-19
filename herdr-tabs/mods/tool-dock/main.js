import { View, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, run, theme, shared, setShared, layout } from "herdr";

const PANELS = [
  { id: "files", label: "Files", icon: "mods/files/file.svg" },
  { id: "changes", label: "Git", icon: "mods/workspace-chrome/git-branch.svg" },
  { id: "context", label: "Agent", icon: "mods/workspace-chrome/layers.svg" },
  { id: "spectra", label: "Spectra", icon: "mods/spectra-status/spectra.svg" },
  { id: "services", label: "Services", icon: "mods/services-inspector/services.svg" },
  { id: "todo", label: "Todo", icon: "mods/todo-list/todo.svg" },
  { id: "api", label: "API", icon: "mods/api-client/api.svg" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class ToolDock extends View {
  init() {
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.pending = null;
    this.space = undefined;
  }

  // Remember side panel state per space: switching spaces restores that space's choice.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            setShared("panel.override", { hidden: false, active: want, at: Date.now() });
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else {
            setShared("panel.override", { hidden: true, active: body?.active ?? null, at: Date.now() });
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const rawPanels = shared("workspace.panels");
    const enabled = Array.isArray(rawPanels)
      ? [...new Set([...rawPanels, "context", "spectra", "services", "todo", "api"])]
      : PANELS.map((p) => p.id);

    this.syncPanel(space, panel, body, enabled);

    const stop = (_e, cx) => cx.stop_propagation();
    const override = shared("panel.override");
    const useOverride = override && typeof override === "object" && Date.now() - (override.at || 0) < 1000;
    const isHidden = useOverride ? override.hidden : Boolean(panel?.hidden);
    const activeId = useOverride ? override.active : body?.active;

    const dockItem = ({ id, label, icon }) => {
      const on = Boolean(panel && !isHidden && activeId === id);
      return h_flex()
        .id(`panel-${id}`)
        .h(32)
        .rounded(8)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .tooltip(label)
        .border(1)
        .border_color(on ? (t.input ?? t.border) : "#00000000")
        .bg(on ? t.selected : "#00000000")
        .text_color(on ? t.foreground : t.muted)
        .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", stop)
        .on_click((_e, clickCx) => {
          if (on) {
            this.pending = { want: null, until: Date.now() + 1500 };
            if (space) {
              this.panels[space.id] = null;
              localStorage.setItem("panels", JSON.stringify(this.panels));
            }
            setShared("panel.override", { hidden: true, active: activeId ?? id, at: Date.now() });
            run("layout.hide", { id: "panel" });
          } else {
            this.pending = { want: id, until: Date.now() + 1500 };
            if (space) {
              this.panels[space.id] = id;
              localStorage.setItem("panels", JSON.stringify(this.panels));
            }
            setShared("panel.override", { hidden: false, active: id, at: Date.now() });
            run("layout.select", { stack: "panel-body", child: id });
            run("layout.show", { id: "panel" });
          }
          clickCx?.notify?.();
        })
        .child(svg(icon).size(15).flex_none());
    };

    const items = PANELS.filter((p) => enabled.includes(p.id)).map(dockItem);

    return v_flex()
      .id("tool-dock")
      .size_full()
      .py(8)
      .px(6)
      .gap(4)
      .items_stretch()
      .children(items);
  }
}
