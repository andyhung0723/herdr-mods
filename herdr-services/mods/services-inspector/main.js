// Services (Ports & Docker) Inspector mod for Herdr.
// Supports Right-Side Panel mode (like Agent/Spectra Inspector) and Popup Dialog mode.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, closeOverlay, openOverlay, setShared, shared,
  exec, home, layout,
} from "herdr";
import { fetchServicesData, killProcess, controlDocker } from "./collector.js";

const MOD = "services-inspector";
const ICON = `mods/${MOD}/services.svg`;
const OVERLAY_KEY = "services-inspector.open-overlay";

function getPanelWidth() {
  const l = typeof layout === "function" ? layout() : null;
  const find = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const found = find(child, id);
        if (found) return found;
      }
    }
    return null;
  };
  const panel = find(l, "panel");
  const px = panel?.size?.px;
  return typeof px === "number" && !isNaN(px) ? px : null;
}

export default class ServicesInspector extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "panel");
    this.data = null;
    this.loading = false;
    this.error = null;

    this.activeTab = "ports"; // "ports" | "docker"
    this.filterMode = "all"; // "all" | "dev"
    this.searchQuery = "";

    this.killingPid = null;
    this.dockerActionId = null;
    this.lastWidthBucket = null;
    this.reloadInflight = false;

    this.handle = cx.focus_handle();
    if (this.role === "dialog") this.handle.focus();

    // Fast check: responsive width & periodic refresh
    cx.timer.every(1000, (tcx) => {
      const w = getPanelWidth();
      const bucket = w === null ? "normal" : w < 360 ? "very-narrow" : w < 420 ? "narrow" : "normal";
      if (bucket !== this.lastWidthBucket) {
        this.lastWidthBucket = bucket;
        tcx?.notify?.();
      }
    });

    // Auto-refresh services every 4 seconds
    cx.timer.every(4000, (tcx) => {
      this.reload(tcx, false);
    });

    this.reload(cx, true);
  }

  async reload(cx, force = false) {
    if (this.reloadInflight) return;
    this.reloadInflight = true;
    if (force || !this.data) {
      this.loading = true;
      cx?.notify?.();
    }
    try {
      const res = await fetchServicesData({ mode: "all", force });
      this.data = res;
      this.error = null;
    } catch (err) {
      this.error = String(err);
    } finally {
      this.loading = false;
      this.reloadInflight = false;
      cx?.notify?.();
    }
  }

  async handleKill(pid, cx) {
    if (!pid || this.killingPid) return;
    this.killingPid = pid;
    cx?.notify?.();
    try {
      const res = await killProcess(pid, 15);
      if (!res.ok) {
        // Try SIGKILL if SIGTERM was rejected or failed
        await killProcess(pid, 9);
      }
      await this.reload(cx, true);
    } catch (err) {
      console.error("Kill failed:", err);
    } finally {
      this.killingPid = null;
      cx?.notify?.();
    }
  }

  async handleDockerAction(containerId, action, cx) {
    if (!containerId || this.dockerActionId) return;
    this.dockerActionId = `${containerId}:${action}`;
    cx?.notify?.();
    try {
      await controlDocker(containerId, action);
      await this.reload(cx, true);
    } catch (err) {
      console.error("Docker action failed:", err);
    } finally {
      this.dockerActionId = null;
      cx?.notify?.();
    }
  }

  async handleOpenUrl(url, cx) {
    if (!url) return;
    try {
      await exec("open", [url]);
    } catch (err) {
      console.error("Open URL failed:", err);
    }
  }

  // --- Rendering ------------------------------------------------------------

  render(cx) {
    const t = theme();
    const isNarrow = this.lastWidthBucket === "narrow" || this.lastWidthBucket === "very-narrow";
    const isVeryNarrow = this.lastWidthBucket === "very-narrow";

    const ports = this.data?.ports ?? [];
    const docker = this.data?.docker ?? { installed: false, running: false, containers: [] };

    const devPorts = ports.filter((p) => p.category === "dev");
    const ipcPorts = ports.filter((p) => p.category === "ipc");
    const systemPorts = ports.filter((p) => p.category === "system" || p.isProtected);
    const otherPorts = ports.filter((p) => p.category === "other" && !p.isProtected);

    const dockerContainers = docker.containers ?? [];
    const dockerRunning = dockerContainers.filter((c) => c.state === "running").length;

    return v_flex()
      .track_focus(this.handle)
      .size_full()
      .bg(t.sidebar ?? t.background)
      .text_color(t.foreground)
      .overflow_hidden()
      // 1. Header Toolbar
      .child(this.renderHeader(t, ports.length, dockerContainers.length, dockerRunning, isVeryNarrow, cx))
      // 2. Filter / Search Bar
      .child(this.renderFilterBar(t, devPorts.length, ipcPorts.length, otherPorts.length + systemPorts.length, isNarrow, cx))
      // 3. Main Content Area
      .child(
        v_flex()
          .flex_1()
          .overflow_y_scrollbar()
          .p(10)
          .gap(8)
          .child(
            this.activeTab === "ports"
              ? this.renderPortsView(t, devPorts, ipcPorts, otherPorts, systemPorts, isNarrow, cx)
              : this.renderDockerView(t, docker, isNarrow, cx)
          )
      );
  }

  renderHeader(t, portCount, dockerTotal, dockerRunning, isVeryNarrow, cx) {
    return h_flex()
      .px(12)
      .py(9)
      .gap(8)
      .items_center()
      .justify_between()
      .border_b(1, t.border)
      .bg(t.background)
      // Left: Icon + Title
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(svg(ICON).size(16).text_color(t.accent ?? "#89b4fa"))
          .child(
            div()
              .text_size(13)
              .font_bold()
              .text_color(t.foreground)
              .child("Services")
          )
      )
      // Center: Sub-tab switcher
      .child(
        h_flex()
          .items_center()
          .gap(4)
          .p(2)
          .rounded(6)
          .bg(t.surface ?? t.background)
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .px(8)
              .py(3)
              .rounded(4)
              .cursor_pointer()
              .when(this.activeTab === "ports", (el) => el.bg(t.selected ?? "#334155"))
              .text_color(this.activeTab === "ports" ? t.foreground : t.muted)
              .on_click(() => {
                this.activeTab = "ports";
                cx.notify();
              })
              .child(div().text_size(11.5).font_medium().child(isVeryNarrow ? `Ports` : `Ports (${portCount})`))
          )
          .child(
            h_flex()
              .items_center()
              .gap(4)
              .px(8)
              .py(3)
              .rounded(4)
              .cursor_pointer()
              .when(this.activeTab === "docker", (el) => el.bg(t.selected ?? "#334155"))
              .text_color(this.activeTab === "docker" ? t.foreground : t.muted)
              .on_click(() => {
                this.activeTab = "docker";
                cx.notify();
              })
              .child(
                div()
                  .text_size(11.5)
                  .font_medium()
                  .child(
                    isVeryNarrow
                      ? `Docker`
                      : dockerRunning > 0
                      ? `Docker (${dockerRunning}/${dockerTotal})`
                      : `Docker (${dockerTotal})`
                  )
              )
          )
      )
      // Right: Refresh & Actions
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(
            div()
              .px(6)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .bg(t.surface ?? t.background)
              .text_size(11)
              .text_color(this.loading ? t.accent : t.muted)
              .on_click(() => this.reload(cx, true))
              .child(this.loading ? "⟳ ..." : "⟳ Refresh")
          )
          .when(this.role === "dialog", (el) =>
            el.child(
              div()
                .px(6)
                .py(2)
                .rounded(4)
                .cursor_pointer()
                .bg(t.surface)
                .text_size(11)
                .text_color(t.muted)
                .on_click(() => closeOverlay(this.overlayId))
                .child("✕")
            )
          )
      );
  }

  renderFilterBar(t, devCount, ipcCount, otherCount, isNarrow, cx) {
    if (this.activeTab !== "ports") return div();

    const total = devCount + ipcCount + otherCount;
    return h_flex()
      .px(12)
      .py(5)
      .gap(6)
      .items_center()
      .border_b(1, t.border)
      .bg(t.surface ?? t.background)
      .child(
        h_flex()
          .gap(4)
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .when(this.filterMode === "all", (el) => el.bg(t.accent ?? "#89b4fa"))
              .text_color(this.filterMode === "all" ? (t.accentForeground ?? "#ffffff") : t.muted)
              .on_click(() => {
                this.filterMode = "all";
                cx.notify();
              })
              .child(`All (${total})`)
          )
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .when(this.filterMode === "dev", (el) => el.bg(t.accent ?? "#89b4fa"))
              .text_color(this.filterMode === "dev" ? (t.accentForeground ?? "#ffffff") : t.muted)
              .on_click(() => {
                this.filterMode = "dev";
                cx.notify();
              })
              .child(`🚀 Dev (${devCount})`)
          )
          .child(
            div()
              .px(7)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .when(this.filterMode === "ipc", (el) => el.bg(t.accent ?? "#89b4fa"))
              .text_color(this.filterMode === "ipc" ? (t.accentForeground ?? "#ffffff") : t.muted)
              .on_click(() => {
                this.filterMode = "ipc";
                cx.notify();
              })
              .child(`📦 App IPC (${ipcCount})`)
          )
      );
  }

  renderPortsView(t, devPorts, ipcPorts, otherPorts, systemPorts, isNarrow, cx) {
    let list = [];
    if (this.filterMode === "dev") list = devPorts;
    else if (this.filterMode === "ipc") list = ipcPorts;
    else list = [...devPorts, ...ipcPorts, ...otherPorts, ...systemPorts];

    if (list.length === 0) {
      const emptyMsg =
        this.filterMode === "dev"
          ? "No Web Dev Servers running. (Vite, Next.js, and web frameworks will appear here)."
          : this.filterMode === "ipc"
          ? "No Desktop App IPC connections found."
          : "No listening ports found.";

      return div()
        .p(24)
        .items_center()
        .justify_center()
        .text_center()
        .child(
          v_flex()
            .gap(6)
            .child(div().text_size(13).font_bold().text_color(t.muted).child("No Matching Ports"))
            .child(div().text_size(11).text_color(t.dim).child(emptyMsg))
        );
    }

    const container = v_flex().gap(6);

    // Section 1: Dev Ports
    if ((this.filterMode === "all" || this.filterMode === "dev") && devPorts.length > 0) {
      container.child(
        h_flex()
          .items_center()
          .gap(6)
          .px(4)
          .pt(2)
          .child(div().text_size(11).font_bold().text_color(t.ansi2 ?? "#a6e3a1").child("🚀 DEV SERVERS & WEBSITES"))
          .child(div().text_size(10.5).text_color(t.dim).child(`(${devPorts.length})`))
      );
      for (const p of devPorts) {
        container.child(this.renderPortCard(t, p, isNarrow, cx));
      }
    }

    // Section 2: App IPC Ports
    if ((this.filterMode === "all" || this.filterMode === "ipc") && ipcPorts.length > 0) {
      container.child(
        h_flex()
          .items_center()
          .gap(6)
          .px(4)
          .pt(this.filterMode === "all" ? 6 : 2)
          .child(div().text_size(11).font_bold().text_color(t.accent ?? "#89b4fa").child("📦 DESKTOP APPS & LOCAL IPC"))
          .child(div().text_size(10.5).text_color(t.dim).child(`(${ipcPorts.length})`))
      );
      for (const p of ipcPorts) {
        container.child(this.renderPortCard(t, p, isNarrow, cx));
      }
    }

    // Section 3: Other / System Services
    const systemAndOther = [...otherPorts, ...systemPorts];
    if (this.filterMode === "all" && systemAndOther.length > 0) {
      container.child(
        h_flex()
          .items_center()
          .gap(6)
          .px(4)
          .pt(6)
          .child(div().text_size(11).font_bold().text_color(t.muted).child("⚙️ SYSTEM & LOCAL SERVICES"))
          .child(div().text_size(10.5).text_color(t.dim).child(`(${systemAndOther.length})`))
      );
      for (const p of systemAndOther) {
        container.child(this.renderPortCard(t, p, isNarrow, cx));
      }
    }

    return container;
  }

  renderPortCard(t, p, isNarrow, cx) {
    const isKilling = this.killingPid === p.pid;
    const isDev = p.category === "dev";
    const isIpc = p.category === "ipc";

    const portColor = isDev
      ? (t.ansi2 ?? "#a6e3a1")
      : isIpc
      ? (t.accent ?? "#89b4fa")
      : p.isProtected
      ? (t.dim ?? "#6c7086")
      : (t.muted ?? "#a6adc8");

    const subtitle = p.ipcDesc ? `${p.ipcDesc} • ${p.command || p.name}` : (p.command || p.address);

    return h_flex()
      .p(8)
      .rounded(6)
      .bg(t.surface ?? t.background)
      .border_1()
      .border_color(t.border)
      .gap(8)
      .items_center()
      .justify_between()
      // Left info
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .gap(8)
          // Port badge
          .child(
            v_flex()
              .min_w(52)
              .items_center()
              .justify_center()
              .px(6)
              .py(3)
              .rounded(4)
              .bg(t.selected ?? "#334155")
              .child(div().text_size(12).font_bold().text_color(portColor).child(`:${p.port}`))
          )
          // Details
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .child(div().text_size(12).font_bold().text_color(t.foreground).truncate().child(p.name))
                  .when(isDev, (el) =>
                    el.child(
                      div()
                        .px(4)
                        .py(1)
                        .rounded(3)
                        .bg(t.background)
                        .text_size(9.5)
                        .font_medium()
                        .text_color(t.ansi2 ?? "#a6e3a1")
                        .child("Dev")
                    )
                  )
                  .when(isIpc, (el) =>
                    el.child(
                      div()
                        .px(4)
                        .py(1)
                        .rounded(3)
                        .bg(t.background)
                        .text_size(9.5)
                        .font_medium()
                        .text_color(t.accent ?? "#89b4fa")
                        .child("App IPC")
                    )
                  )
                  .child(div().text_size(10.5).text_color(t.dim).child(`PID ${p.pid}`))
                  .when(p.proto && p.proto.includes("/"), (el) =>
                    el.child(
                      div()
                        .px(4)
                        .py(1)
                        .rounded(3)
                        .bg(t.background)
                        .text_size(9.5)
                        .text_color(t.muted)
                        .child(p.proto)
                    )
                  )
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(isIpc ? (t.accent ?? "#89b4fa") : t.muted)
                  .truncate()
                  .child(subtitle)
              )
          )
      )
      // Right Actions
      .child(
        h_flex()
          .items_center()
          .gap(4)
          // Open URL Button: only shown if p.url is present!
          .when(Boolean(p.url), (el) =>
            el.child(
              div()
                .px(7)
                .py(3)
                .rounded(4)
                .cursor_pointer()
                .bg(t.background)
                .text_size(11)
                .text_color(t.ansi2 ?? "#a6e3a1")
                .on_click(() => this.handleOpenUrl(p.url, cx))
                .child("🌐 Open")
            )
          )
          // Kill Button: available for dev, ipc, or other (as long as not system-protected)
          .when(!p.isProtected, (el) =>
            el.child(
              div()
                .px(7)
                .py(3)
                .rounded(4)
                .cursor_pointer()
                .bg(isKilling ? (t.selected ?? "#334155") : (t.ansi1 ?? "#f38ba8"))
                .text_size(11)
                .font_medium()
                .text_color(isKilling ? t.muted : (t.accentForeground ?? "#ffffff"))
                .on_click(() => this.handleKill(p.pid, cx))
                .child(isKilling ? "Killing..." : "Kill")
            )
          )
          .when(Boolean(p.isProtected), (el) =>
            el.child(
              div()
                .px(6)
                .py(2)
                .rounded(4)
                .bg(t.background)
                .text_size(10)
                .text_color(t.dim)
                .child("🛡️ System")
            )
          )
      );
  }

  renderDockerView(t, docker, isNarrow, cx) {
    if (!docker.installed) {
      return div()
        .p(20)
        .rounded(6)
        .bg(t.surface ?? t.background)
        .border_1()
        .border_color(t.border)
        .child(
          v_flex()
            .gap(6)
            .child(div().text_size(13).font_bold().text_color(t.ansi1 ?? "#f38ba8").child("🐳 Docker CLI Not Found"))
            .child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .child("Please install Docker Desktop or OrbStack to manage containers.")
            )
        );
    }

    if (!docker.running) {
      return div()
        .p(16)
        .rounded(6)
        .bg(t.surface ?? t.background)
        .border_1()
        .border_color(t.border)
        .child(
          v_flex()
            .gap(8)
            .child(
              h_flex()
                .items_center()
                .gap(6)
                .child(div().text_size(13).font_bold().text_color(t.blocked ?? "#e3814f").child("🐳 Docker Daemon Offline"))
            )
            .child(
              div()
                .text_size(11.5)
                .text_color(t.muted)
                .child("OrbStack or Docker Desktop is currently stopped.")
            )
            .when(Boolean(docker.error), (el) =>
              el.child(
                div()
                  .p(8)
                  .rounded(4)
                  .bg(t.background)
                  .text_size(10.5)
                  .text_color(t.dim)
                  .truncate()
                  .child(docker.error)
              )
            )
            .child(
              div()
                .px(8)
                .py(4)
                .rounded(4)
                .cursor_pointer()
                .bg(t.selected ?? "#334155")
                .text_size(11.5)
                .text_color(t.foreground)
                .on_click(() => this.reload(cx, true))
                .child("⟳ Check Again")
            )
        );
    }

    const containers = docker.containers ?? [];
    if (containers.length === 0) {
      return div()
        .p(24)
        .items_center()
        .justify_center()
        .text_center()
        .child(
          v_flex()
            .gap(6)
            .child(div().text_size(14).font_bold().text_color(t.muted).child("No Docker Containers"))
            .child(div().text_size(11).text_color(t.dim).child("Containers from docker run or docker compose will appear here."))
        );
    }

    const containerList = v_flex().gap(6);
    for (const c of containers) {
      containerList.child(this.renderDockerCard(t, c, isNarrow, cx));
    }
    return containerList;
  }

  renderDockerCard(t, c, isNarrow, cx) {
    const isRunning = c.state === "running";
    const statusColor = isRunning ? (t.ansi2 ?? "#a6e3a1") : t.muted;
    const isActionInflight = Boolean(this.dockerActionId && this.dockerActionId.startsWith(c.id));

    return h_flex()
      .p(8)
      .rounded(6)
      .bg(t.surface ?? t.background)
      .border_1()
      .border_color(t.border)
      .gap(8)
      .items_center()
      .justify_between()
      // Left info
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .items_center()
          .gap(8)
          // Status indicator dot
          .child(
            div()
              .w(8)
              .h(8)
              .rounded(4)
              .bg(statusColor)
          )
          // Container name & image
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .child(div().text_size(12).font_bold().text_color(t.foreground).truncate().child(c.names || c.id))
                  .child(div().text_size(10).text_color(t.dim).child(c.id))
              )
              .child(
                div()
                  .text_size(10.5)
                  .text_color(t.muted)
                  .truncate()
                  .child(c.image)
              )
              .when(Boolean(c.ports), (el) =>
                el.child(
                  div()
                    .text_size(10)
                    .text_color(t.accent ?? "#89b4fa")
                    .truncate()
                    .child(c.ports)
                )
              )
          )
      )
      // Right Actions: Start / Stop / Restart
      .child(
        h_flex()
          .items_center()
          .gap(4)
          .when(isRunning, (el) =>
            el
              .child(
                div()
                  .px(6)
                  .py(3)
                  .rounded(4)
                  .cursor_pointer()
                  .bg(t.background)
                  .text_size(11)
                  .text_color(t.foreground)
                  .on_click(() => this.handleDockerAction(c.id, "restart", cx))
                  .child(isActionInflight ? "..." : "🔄 Restart")
              )
              .child(
                div()
                  .px(6)
                  .py(3)
                  .rounded(4)
                  .cursor_pointer()
                  .bg(t.ansi1 ?? "#f38ba8")
                  .text_size(11)
                  .text_color(t.accentForeground ?? "#ffffff")
                  .on_click(() => this.handleDockerAction(c.id, "stop", cx))
                  .child(isActionInflight ? "..." : "⏹ Stop")
              )
          )
          .when(!isRunning, (el) =>
            el.child(
              div()
                .px(7)
                .py(3)
                .rounded(4)
                .cursor_pointer()
                .bg(t.ansi2 ?? "#a6e3a1")
                .text_size(11)
                .text_color("#181825")
                .on_click(() => this.handleDockerAction(c.id, "start", cx))
                .child(isActionInflight ? "..." : "▶ Start")
            )
          )
      );
  }
}
