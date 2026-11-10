import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const MOCK_SONG_ACTIVE = {
  active: true,
  title: "夜に駆ける",
  artist: "YOASOBI",
  playing: true,
  app: "YouTube Music",
  source: "Edge PWA",
};

const MOCK_SONG_INACTIVE = {
  active: false,
  title: "",
  artist: "",
  playing: false,
  app: "YouTube Music",
  source: null,
};

async function harness({ mockSong = MOCK_SONG_ACTIVE } = {}) {
  const events = [];
  const api = {
    home: () => "/Users/dev",
    appHome: () => "/Users/dev/.config/herdr-app",
    spaces: () => [{ active: true, machine: "This computer", branch: "main" }],
    agents: () => [{ address: "t1", status: "working" }, { address: "t2", status: "idle" }],
    theme: () => ({
      chrome: "#181825",
      border: "#313244",
      muted: "#a6adc8",
      dim: "#6c7086",
      foreground: "#cdd6f4",
      selected: "#313244",
      hover: "#45475a",
      ansi2: "#a6e3a1",
      blocked: "#fab387",
    }),
    run: (act) => events.push(["run", act]),
    window: () => ({ platform: "macos" }),
    keys: () => [{ section: "global", action: "app.palette", keys: "cmd-shift-p" }],
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3") {
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "status") {
          return { code: 0, stdout: JSON.stringify(mockSong), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "activate") {
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (args.includes("--action") && args[args.indexOf("--action") + 1] === "toggle") {
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    },
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
  const base = synthetic({ h_flex: () => element });
  const herdr = synthetic(api);

  const mainCode = await readFile(new URL("../mods/workspace-status/main.js", import.meta.url), "utf8");
  const main = new vm.SourceTextModule(mainCode, { context });
  await main.link((name) => ({ "gpui-kit": kit, "gpui-base": base, herdr }[name]));
  await main.evaluate();

  const cx = {
    timer: { every: () => {} },
    notify: () => events.push(["notify"]),
  };

  return { View: main.namespace.default, cx, events };
}

test("workspace status renders YouTube Music widget in bottom-right corner when playing", async () => {
  const { View, cx } = await harness({ mockSong: MOCK_SONG_ACTIVE });

  const view = new View();
  view.init({}, cx);
  await view.pollMusic(cx);

  assert.ok(view.song);
  assert.equal(view.song.active, true);
  assert.equal(view.song.title, "夜に駆ける");
  assert.equal(view.song.artist, "YOASOBI");
  assert.equal(view.song.playing, true);

  const rendered = view.render(cx);
  assert.ok(rendered);
});

test("workspace status handles inactive state cleanly without crashing", async () => {
  const { View, cx } = await harness({ mockSong: MOCK_SONG_INACTIVE });

  const view = new View();
  view.init({}, cx);
  await view.pollMusic(cx);

  assert.ok(view.song);
  assert.equal(view.song.active, false);

  const rendered = view.render(cx);
  assert.ok(rendered);
});

test("activate and toggle actions call python probe", async () => {
  const { View, cx, events } = await harness();

  const view = new View();
  view.init({}, cx);

  await view.activateYTM(cx);
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("activate")));

  await view.togglePlay(cx);
  assert.ok(events.some((e) => e[0] === "exec" && e[2].includes("toggle")));
});
