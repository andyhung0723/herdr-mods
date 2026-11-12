import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MOCK_SCAN_DATA = {
  timestamp: 1794216000,
  ports: [
    {
      port: 5173,
      pid: 12345,
      name: "vite",
      user: "dev",
      address: "127.0.0.1:5173",
      proto: "IPv4",
      command: "vite dev --port 5173",
      category: "dev",
      ipcDesc: "",
      isDev: true,
      isProtected: false,
      url: "http://localhost:5173",
    },
    {
      port: 44438,
      pid: 55227,
      name: "zed",
      user: "dev",
      address: "127.0.0.1:44438",
      proto: "IPv4",
      command: "/Applications/Zed.app/Contents/MacOS/zed",
      category: "ipc",
      ipcDesc: "Zed editor CLI & IPC",
      isDev: false,
      isProtected: false,
      url: "",
    },
    {
      port: 5000,
      pid: 709,
      name: "ControlCe",
      user: "dev",
      address: "*:5000",
      proto: "IPv4/IPv6",
      command: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
      category: "system",
      ipcDesc: "",
      isDev: false,
      isProtected: true,
      url: "",
    },
  ],
  docker: {
    installed: true,
    running: true,
    containers: [
      {
        id: "c123456789ab",
        names: "postgres-db",
        image: "postgres:15-alpine",
        status: "Up 2 hours",
        state: "running",
        ports: "0.0.0.0:5432->5432/tcp",
        created: "2 hours ago",
      },
      {
        id: "d987654321fe",
        names: "redis-cache",
        image: "redis:7",
        status: "Exited (0) 10 minutes ago",
        state: "exited",
        ports: "",
        created: "5 hours ago",
      },
    ],
    error: null,
  },
};

async function harness() {
  const events = [];
  const api = {
    home: () => "/home/user",
    appHome: () => "/home/user/.config/herdr-app",
    layout: () => ({ id: "root", children: [{ id: "panel", size: { px: 420 } }] }),
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "scan") {
          return { code: 0, stdout: JSON.stringify(MOCK_SCAN_DATA), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "kill-pid") {
          return { code: 0, stdout: JSON.stringify({ ok: true, pid: Number(args[args.indexOf("--pid") + 1]) }), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "docker-action") {
          return { code: 0, stdout: JSON.stringify({ ok: true, container: "c123456789ab", action: "restart" }), stderr: "" };
        }
      }
      if (cmd === "open") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "Unknown command" };
    },
    theme: () => ({
      chrome: "#181825",
      surface: "#181825",
      background: "#1e1e2e",
      sidebar: "#181825",
      border: "#313244",
      selected: "#313244",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      accentForeground: "#ffffff",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      blocked: "#fab387",
    }),
    props: () => ({}),
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "overlay-services";
    },
    setShared: (k, v) => events.push(["setShared", k, v]),
    shared: () => null,
  };

  const context = vm.createContext({});
  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      },
      { context }
    );

  const element = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(element) : element);
        return () => element;
      },
    }
  );

  const kit = synthetic({ View: class {}, div: () => element, svg: () => element });
  const base = synthetic({ v_flex: () => element, h_flex: () => element });
  const herdr = synthetic(api);

  const collectorCode = await readFile(new URL("../mods/services-inspector/collector.js", import.meta.url), "utf8");
  const collector = new vm.SourceTextModule(collectorCode, { context });
  await collector.link((name) => ({ herdr }[name]));
  await collector.evaluate();

  const mainCode = await readFile(new URL("../mods/services-inspector/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr, "./collector.js": collector }[name]));
  await main.evaluate();

  const pending = [];
  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    spawn: (fn) => {
      pending.push(Promise.resolve().then(() => fn(cx)));
    },
    timer: { every: (ms) => events.push(["timer.every", ms]) },
    notify: () => events.push(["notify"]),
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  return { api, collector: collector.namespace, View: main.namespace.default, cx, events, settle };
}

test("collector fetchServicesData, killProcess, and controlDocker invoke scanner correctly", async () => {
  const { collector, events } = await harness();

  const data = await collector.fetchServicesData({ force: true });
  assert.equal(data.ports.length, 3);
  assert.equal(data.ports[0].port, 5173);
  assert.equal(data.ports[1].port, 44438);
  assert.equal(data.ports[1].category, "ipc");
  assert.equal(data.docker.containers.length, 2);

  const killRes = await collector.killProcess(12345, 15);
  assert.equal(killRes.ok, true);
  assert.equal(killRes.pid, 12345);

  const dockerRes = await collector.controlDocker("c123456789ab", "restart");
  assert.equal(dockerRes.ok, true);

  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("kill-pid")));
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("docker-action")));
});

test("services view renders ports list, dev filtering, and docker containers", async () => {
  const { View, cx, settle } = await harness();

  const view = new View();
  view.init({}, cx);
  await settle();

  assert.equal(view.role, "panel");
  assert.equal(view.activeTab, "ports");
  assert.ok(view.data);
  assert.equal(view.data.ports.length, 3);

  // Render ports tab
  const portsElement = view.render(cx);
  assert.ok(portsElement);

  // Switch to dev filter
  view.filterMode = "dev";
  assert.ok(view.render(cx));

  // Switch to ipc filter
  view.filterMode = "ipc";
  assert.ok(view.render(cx));

  // Switch to docker tab
  view.activeTab = "docker";
  assert.ok(view.render(cx));
  assert.equal(view.data.docker.containers[0].names, "postgres-db");
});

test("kill action triggers reload", async () => {
  const { View, cx, settle, events } = await harness();

  const view = new View();
  view.init({}, cx);
  await settle();

  await view.handleKill(12345, cx);
  assert.equal(view.killingPid, null);
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("kill-pid")));
});
