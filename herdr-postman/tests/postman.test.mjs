import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

async function harness({ roleProps = {}, mockHttpResult = null } = {}) {
  const events = [];
  const files = new Map();
  const sharedMap = new Map();
  const storageMap = new Map();

  const api = {
    home: () => "/home/user",
    appHome: () => "/home/user/.config/herdr-app",
    readTextFile: async (p) => files.get(p) ?? null,
    writeTextFile: async (p, text, expected) => {
      const current = files.get(p) ?? null;
      if (current !== expected) throw new Error("stale snapshot");
      files.set(p, text);
      events.push(["writeTextFile", p, text]);
      return null;
    },
    agents: () => [
      {
        address: "t2x",
        pane: "p1",
        space: "sp1",
        space_name: "proj-a",
        tab: "tab1",
        tab_index: 1,
        tab_name: "1 main",
        status: "idle",
        app: "claude-code",
        program: { key: "claude", name: "Claude Code", agent: true },
        title: "claude",
        focused: true,
      },
    ],
    panes: () => [
      {
        pane: "p1",
        terminal: "t2x",
        tab: "tab1",
        title: "claude",
        cwd: "/home/user/proj-a",
        focused: true,
        program: { key: "claude", name: "Claude Code", agent: true },
      },
    ],
    spaces: () => [{ id: "sp1", index: 1, name: "proj-a", folder: "/home/user/proj-a", active: true, tabs: [] }],
    focused: () => ({ space: "sp1", tab: "tab1", pane: "p1", terminal: "t2x", agent: "t2x", cwd: "/home/user/proj-a" }),
    theme: () => ({
      chrome: "#181825",
      surface: "#181825",
      background: "#1e1e2e",
      popover: "#181825",
      raised: "#313244",
      hover: "#45475a",
      selected: "#313244",
      border: "#313244",
      input: "#45475a",
      foreground: "#cdd6f4",
      muted: "#a6adc8",
      dim: "#6c7086",
      accent: "#89b4fa",
      accent_foreground: "#11111b",
      working: "#a6e3a1",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      ansi3: "#f9e2af",
      ansi4: "#89b4fa",
      ansi5: "#cba6f7",
      ansi6: "#94e2d5",
    }),
    props: () => roleProps,
    shared: (k) => sharedMap.get(k) ?? null,
    setShared: (k, v) => sharedMap.set(k, v),
    openOverlay: (spec) => {
      events.push(["openOverlay", spec]);
      return "ov-1";
    },
    closeOverlay: (id) => events.push(["closeOverlay", id]),
    notify: (n) => events.push(["notify", n]),
    hc: async (args) => {
      events.push(["hc", args]);
      return { code: 0, stdout: "ok", stderr: "" };
    },
    exec: async (cmd, args = []) => {
      events.push(["exec", cmd, args]);
      if (cmd === "python3" && args[0] && args[0].endsWith("runner.py")) {
        return {
          code: 0,
          stdout: JSON.stringify(
            mockHttpResult ?? {
              ok: true,
              status: 200,
              statusText: "OK",
              elapsedMs: 42,
              sizeBytes: 27,
              headers: { "Content-Type": "application/json", "Set-Cookie": "sid=secret123" },
              body: '{\n  "status": "healthy"\n}',
              isJson: true,
              truncated: false,
              error: null,
            }
          ),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  const context = vm.createContext({
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
  });

  const synthetic = (values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );

  const makeEl = (type) => {
    const el = { _type: type, _id: null, _children: [], _text: [], _onClick: null, _tooltip: null };
    const proxy = new Proxy(el, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === "id") return (id) => { target._id = id; return proxy; };
        if (prop === "tooltip") return (tip) => { target._tooltip = tip; return proxy; };
        if (prop === "on_click") return (fn) => { target._onClick = fn; return proxy; };
        if (prop === "child") return (c) => {
          if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
          else if (c) target._children.push(c);
          return proxy;
        };
        if (prop === "children") return (arr) => {
          for (const c of arr ?? []) {
            if (typeof c === "string" || typeof c === "number") target._text.push(String(c));
            else if (c) target._children.push(c);
          }
          return proxy;
        };
        if (prop === "when") return (cond, fn) => (cond && typeof fn === "function" ? fn(proxy) : proxy);
        return () => proxy;
      },
    });
    return proxy;
  };

  const findById = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node._id === id) return node;
    for (const c of node._children ?? []) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };

  const createTextState = (opts = {}) => {
    let value = opts?.value ?? "";
    const handlers = {};
    return {
      value: () => value,
      set_value: (next) => { value = String(next ?? ""); },
      on: (ev, fn) => { handlers[ev] = fn; return true; },
      focus: () => {},
      release: () => true,
      _trigger: (ev, cx) => handlers[ev]?.({}, cx),
    };
  };

  const kit = synthetic({ View: class {}, div: () => makeEl("div"), svg: () => makeEl("svg") });
  const base = synthetic({
    v_flex: () => makeEl("v_flex"),
    h_flex: () => makeEl("h_flex"),
    InputState: { new: createTextState },
    Input: { new: () => makeEl("Input") },
    EditorState: { new: createTextState },
    Editor: { new: () => makeEl("Editor") },
  });
  const herdr = synthetic(api);

  const storeCode = await readFile(new URL("../mods/api-client/store.js", import.meta.url), "utf8");
  const storeMod = new vm.SourceTextModule(storeCode, { context });
  await storeMod.link((name) => ({ herdr }[name]));
  await storeMod.evaluate();

  const mainCode = await readFile(new URL("../mods/api-client/main.js", import.meta.url), "utf8");
  const mainMod = new vm.SourceTextModule(mainCode, { context });
  await mainMod.link((name) => ({
    "gpui-kit": kit,
    "gpui-base": base,
    herdr,
    "./store.js": storeMod,
  }[name]));
  await mainMod.evaluate();

  const cx = {
    focus_handle: () => ({ focus: () => {} }),
    timer: { every: () => {}, after: () => {} },
    notify: () => events.push(["notify"]),
    stop_propagation: () => {},
  };

  return { store: storeMod.namespace, View: mainMod.namespace.default, cx, events, files, findById };
}

test("store interpolates {{var}} env vars, query params, and Auth headers cleanly", async () => {
  const { store } = await harness();

  const envVars = [
    { key: "baseUrl", value: "https://api.example.com", enabled: true },
    { key: "token", value: "super-secret-jwt", enabled: true },
    { key: "disabledVar", value: "nope", enabled: false },
  ];

  const req = {
    method: "POST",
    url: "{{baseUrl}}/v1/orders",
    params: [{ key: "limit", value: "20", enabled: true }, { key: "skip", value: "5", enabled: false }],
    headers: [{ key: "X-Trace", value: "abc", enabled: true }],
    auth: { type: "bearer", token: "{{token}}" },
    body: '{"name":"測試訂單"}',
  };

  const built = store.buildFinalRequest(req, envVars);
  assert.equal(built.method, "POST");
  assert.equal(built.url, "https://api.example.com/v1/orders?limit=20");
  assert.equal(built.headers["Authorization"], "Bearer super-secret-jwt");
  assert.equal(built.headers["Content-Type"], "application/json");
  assert.equal(built.headers["X-Trace"], "abc");

  // Basic auth UTF-8 encoding
  const basicBuilt = store.buildFinalRequest(
    { method: "GET", url: "https://api.example.com", auth: { type: "basic", username: "andy", password: "pw" } },
    []
  );
  assert.equal(
    basicBuilt.headers["Authorization"],
    `Basic ${Buffer.from("andy:pw", "utf8").toString("base64")}`
  );
});

test("store safely parses and builds cURL commands without executing shell", async () => {
  const { store } = await harness();

  const parsed = store.parseCurlCommand(
    `curl -X PUT \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer my-token-123" \\\n  --data-raw '{"hello":"世界"}' \\\n  'https://api.example.com/items?foo=bar'` // gitleaks:allow
  );

  assert.equal(parsed.method, "PUT");
  assert.equal(parsed.url, "https://api.example.com/items");
  assert.equal(parsed.auth.type, "bearer");
  assert.equal(parsed.auth.token, "my-token-123");
  assert.equal(parsed.params[0].key, "foo");
  assert.equal(parsed.params[0].value, "bar");
  assert.equal(parsed.body, '{"hello":"世界"}');

  const cmd = store.buildCurlCommand(parsed, [], { redact: true });
  assert.ok(!cmd.includes("my-token-123"), "Redacted cURL must never contain live token");
  assert.ok(cmd.includes("[REDACTED]"));
});

test("security redaction strips tokens, cookies, API keys, and URL secrets from history and Agent prompts", async () => {
  const { store } = await harness();

  const req = {
    method: "POST",
    url: "https://api.example.com/login?token=url-secret&ok=1",
    headers: [
      { key: "Cookie", value: "session=secret-cookie", enabled: true },
      { key: "X-Custom", value: "visible", enabled: true },
    ],
    auth: { type: "bearer", token: "live-bearer-secret" },
    body: '{"user":"andy"}',
  };
  const res = {
    status: 500,
    statusText: "Internal Server Error",
    elapsedMs: 88,
    sizeBytes: 32,
    headers: { "Set-Cookie": "sid=xyz", "Content-Type": "application/json" },
    body: '{"error":"boom"}',
    isJson: true,
  };

  const redactedReq = store.redactRequestForLog(req);
  assert.equal(redactedReq.auth.token, "[REDACTED]");
  assert.ok(redactedReq.url.includes("token=[REDACTED]"));
  assert.equal(redactedReq.headers[0].value, "[REDACTED]");
  assert.equal(redactedReq.headers[1].value, "visible");

  const prompt = store.buildAgentDebugPrompt(req, res, []);
  assert.ok(!prompt.includes("live-bearer-secret"), "Bearer token must be redacted in Agent prompt");
  assert.ok(!prompt.includes("secret-cookie"), "Cookie must be redacted in Agent prompt");
  assert.ok(!prompt.includes("url-secret"), "URL token query param must be redacted in Agent prompt");
  assert.ok(!prompt.includes("sid=xyz"), "Set-Cookie header must be redacted in Agent prompt");
  assert.ok(prompt.includes('{"error":"boom"}'));
});

test("runner.py blocks file:// and ftp:// schemes, blocks CRLF header injection, and executes valid localhost HTTP requests", async () => {
  const runnerPath = path.resolve(import.meta.dirname, "../mods/api-client/runner.py");
  const runRunner = async (payload) => {
    const { stdout } = await execFileAsync(
      "python3",
      [runnerPath, "--payload", JSON.stringify(payload)],
      { encoding: "utf8" }
    );
    return JSON.parse(stdout);
  };

  const blockedFile = await runRunner({ method: "GET", url: "file:///etc/passwd" });
  assert.equal(blockedFile.ok, false);
  assert.equal(blockedFile.statusText, "Blocked");
  assert.match(blockedFile.error, /Blocked URL scheme/);

  const blockedFtp = await runRunner({ method: "GET", url: "ftp://example.com" });
  assert.equal(blockedFtp.ok, false);
  assert.match(blockedFtp.error, /Blocked URL scheme/);

  const blockedCrlf = await runRunner({
    method: "GET",
    url: "http://127.0.0.1:9999",
    headers: { "X-Bad": "a\r\nb" },
  });
  assert.equal(blockedCrlf.ok, false);
  assert.match(blockedCrlf.error, /invalid newline/i);

  // Spin up ephemeral local HTTP server to test real round-trip and unsafe redirect blocking
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect-file") {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      res.end();
      return;
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const okRes = await runRunner({
      method: "POST",
      url: `http://127.0.0.1:${port}/test`,
      body: "{}",
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.status, 201);
    assert.equal(okRes.isJson, true);
    assert.match(okRes.body, /"ok": true/);

    const unsafeRedirRes = await runRunner({
      method: "GET",
      url: `http://127.0.0.1:${port}/redirect-file`,
    });
    assert.equal(unsafeRedirRes.ok, false);
    assert.match(unsafeRedirRes.error, /Blocked URL scheme/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ApiClientView renders panel and dialog modes, executes requests without shell, persists redacted history, and dispatches to Agent", async () => {
  // Panel mode
  const { View, cx, events, files, findById } = await harness({ roleProps: { role: "panel" } });
  const panelView = new View();
  panelView.init({}, cx);
  await new Promise((r) => setTimeout(r, 10));

  const panelTree = panelView.render();
  assert.ok(findById(panelTree, "api-panel-root"), "Should render panel root");
  assert.ok(findById(panelTree, "api-req-body-editor-wrap"), "Should render request editor");
  assert.ok(findById(panelTree, "api-res-pane"), "Should render response pane");

  // Send request with Bearer token
  panelView.urlInput.set_value("https://api.example.com/health?token=raw-token-in-url");
  panelView.currentReq.auth.type = "bearer";
  panelView.authTokenInput.set_value("secret-bearer-token");
  await panelView.handleSend(cx);

  assert.ok(
    events.some(([type, cmd, args]) => type === "exec" && cmd === "python3" && args[0].endsWith("runner.py")),
    "Should invoke runner.py via python3 without shell"
  );
  assert.equal(
    events.some(([type, cmd]) => type === "exec" && cmd === "sh"),
    false,
    "Should never invoke sh"
  );
  assert.ok(
    events.some(([type, cmd, args]) => type === "exec" && cmd === "chmod" && args[0] === "600"),
    "Should enforce chmod 600 on store file"
  );

  assert.equal(panelView.lastResponse.status, 200);
  assert.equal(panelView.history.length, 1);
  assert.equal(panelView.history[0].request.auth.token, "[REDACTED]", "History must store redacted token");
  assert.ok(!files.get("/home/user/.config/herdr-app/api-client.json").includes("raw-token-in-url"));

  // Save request
  panelView.reqNameInput.set_value("Health Check");
  await panelView.handleSaveRequest(cx);
  assert.equal(panelView.savedRequests.length, 1);
  assert.equal(panelView.savedRequests[0].name, "Health Check");

  // Send redacted debug info to Agent
  await panelView.handleSendDebugToAgent(cx);
  const hcCall = events.find(([type]) => type === "hc");
  assert.ok(hcCall, "Should send debug report via hc send");
  assert.ok(!hcCall[1][2].includes("secret-bearer-token"), "Agent prompt must NOT contain live Bearer token");

  // Dialog mode via mod.open (overlay id without explicit role)
  const dialogHarness = await harness({ roleProps: { overlay: "api-client" } });
  const dialogView = new dialogHarness.View();
  dialogView.init({}, dialogHarness.cx);
  await new Promise((r) => setTimeout(r, 10));
  const dialogTree = dialogView.render();
  assert.ok(dialogHarness.findById(dialogTree, "api-dialog-root"), "Should render dialog root");
  assert.ok(dialogHarness.findById(dialogTree, "api-sidebar-scroll"), "Should render dialog left sidebar");
  assert.ok(dialogHarness.findById(dialogTree, "api-btn-close"), "Should render dialog close button");
});
