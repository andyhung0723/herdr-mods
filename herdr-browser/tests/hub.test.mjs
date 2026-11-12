import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ActionError, HumanDrivingError, parseKeyChord } from "../daemon/agent-session.mjs";
import { BrowserHub, normalizeNavigationUrl } from "../daemon/browser-hub.mjs";
import { stopEdge } from "../daemon/edge-launcher.mjs";
import { NO_BROWSER } from "./helpers.mjs";

test("normalizeNavigationUrl allows web schemes and blocks local/privileged ones", () => {
  assert.equal(normalizeNavigationUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeNavigationUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeNavigationUrl("about:blank"), "about:blank");
  for (const blocked of ["file:///etc/passwd", "FILE:///etc/hosts", "edge://settings", "chrome://version", "javascript:alert(1)", ""]) {
    assert.throws(() => normalizeNavigationUrl(blocked), undefined, blocked);
  }
});

test("parseKeyChord understands CDP and GPUI key names", () => {
  assert.equal(parseKeyChord("Enter").key, "Enter");
  assert.equal(parseKeyChord("enter").keyCode, 13);
  assert.equal(parseKeyChord("up").key, "ArrowUp");
  assert.deepEqual(
    [parseKeyChord("Shift+Tab").key, parseKeyChord("Shift+Tab").modifiers],
    ["Tab", 8]
  );
  assert.equal(parseKeyChord("cmd-shift-s").modifiers, 4 | 8);
  assert.equal(parseKeyChord("a").text, "a");
  assert.throws(() => parseKeyChord("hyper+x"), ActionError);
});

describe("BrowserHub (needs Edge/Chrome)", { skip: NO_BROWSER }, () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-test-"));
  let hub;
  let origin;
  let server;

  before(async () => {
    hub = new BrowserHub({ profileDir, sessionIdleMs: 60_000, screencastIdleMs: 200 });
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<title>${req.url.slice(1)}</title>`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await hub.destroy();
    stopEdge();
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const page = (body, title = "T") => `data:text/html,${encodeURIComponent(`<title>${title}</title>${body}`)}`;



  test("init is single-flight and uses an OS-assigned debugging port", async () => {
    const inits = [hub.init(), hub.init(), hub.init()];
    assert.equal(new Set(inits).size, 1);
    await Promise.all(inits);
    assert.equal(hub.isReady, true);
    assert.notEqual(hub.port, 9222);
  });

  test("sessions are isolated BrowserContexts and concurrent creation is single-flight", async () => {
    const burst = await Promise.all([1, 2, 3].map(() => hub.getOrCreateSession("claude-t1", { vendor: "claude", terminal: "t1" })));
    assert.equal(new Set(burst).size, 1);
    const claude = burst[0];
    const codex = await hub.getOrCreateSession("codex-t2", { vendor: "codex", terminal: "t2" });
    assert.notEqual(claude.browserContextId, codex.browserContextId);

    await claude.navigate(`${origin}/Claude`);
    await claude.evaluate("document.cookie = 'who=claude'; localStorage.setItem('who', 'claude')");
    await codex.navigate(`${origin}/Codex`);
    assert.equal(await claude.evaluate("document.cookie"), "who=claude");
    assert.equal(await codex.evaluate("document.cookie"), "", "cookies must not leak across contexts");
    assert.equal(await codex.evaluate("localStorage.getItem('who')"), null, "storage must not leak across contexts");

    const listed = hub.listSessions().find((s) => s.agentId === "claude-t1");
    assert.equal(listed.vendor, "claude");
    assert.equal(listed.terminal, "t1");
    assert.equal(listed.title, "Claude");
  });

  test("navigate waits for load and surfaces network errors", async () => {
    const s = await hub.getOrCreateSession("nav");
    const res = await s.navigate(page("<script>window.addEventListener('load',()=>document.title='Loaded')</script>"));
    assert.equal(res.loaded, true);
    assert.equal(s.currentTitle, "Loaded");

    await assert.rejects(s.navigate("http://127.0.0.1:1/"), (err) => err instanceof ActionError && /ERR_/.test(err.message));
  });

  test("back returns to the previous page", async () => {
    const s = await hub.getOrCreateSession("history");
    await s.navigate(page("", "First"));
    await s.navigate(page("", "Second"));
    await s.goHistory(-1);
    assert.equal(s.currentTitle, "First");
    await assert.rejects(s.goHistory(-5), ActionError);
  });

  test("snapshot refs drive real click and type events", async () => {
    const s = await hub.getOrCreateSession("input");
    await s.navigate(
      page(`
        <button onclick="document.title='clicked:'+event.isTrusted">Go</button>
        <form onsubmit="event.preventDefault();document.title='submitted:'+this.q.value">
          <input name="q" aria-label="Query" value="old" oninput="window.inputs=(window.inputs||0)+1">
        </form>`)
    );

    const snap = await s.snapshot();
    const buttonRef = snap.match(/button "Go" \[ref=(e\d+)\]/)?.[1];
    const inputRef = snap.match(/textbox "Query".*\[ref=(e\d+)\]/)?.[1];
    assert.ok(buttonRef && inputRef, snap);

    await s.click({ ref: buttonRef });
    assert.equal(await s.evaluate("document.title"), "clicked:true", "click must be a trusted event");

    await s.type({ ref: inputRef, text: "new", clear: true, submit: true });
    assert.equal(await s.evaluate("document.title"), "submitted:new");
    assert.ok((await s.evaluate("window.inputs")) > 0, "input events must fire for controlled inputs");

    await assert.rejects(s.click({ ref: "e999" }), ActionError);
    await assert.rejects(s.click({ selector: "#missing" }), ActionError);
  });

  test("human takeover blocks agent actions until handed back", async () => {
    const s = await hub.getOrCreateSession("driver");
    s.setDriver("human");
    assert.throws(() => s.assertAgentMayAct(), HumanDrivingError);
    s.setDriver("agent");
    assert.doesNotThrow(() => s.assertAgentMayAct());
    assert.throws(() => s.setDriver("robot"), ActionError);
  });

  test("screencast runs only while viewed", async () => {
    const s = await hub.getOrCreateSession("viewer");
    await s.navigate(page("<h1 style='font-size:80px'>frame</h1>"));
    assert.equal(s.screencasting, false);

    await s.noteViewed();
    const deadline = Date.now() + 5000;
    while (!s.frame && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(s.frame, "a frame should arrive once viewed");
    assert.equal(s.frameAfter(s.frame.seq).changed, false);
    assert.equal(s.frameAfter(0).changed, true);

    await s.stopScreencastIfUnviewed(Date.now() + 1000, 200);
    assert.equal(s.screencasting, false);
  });

  test("sweep closes sessions idle past the TTL", async () => {
    const s = await hub.getOrCreateSession("stale");
    s.lastActivityAt = 0;
    s.lastViewedAt = 0;
    await hub.sweep(Date.now());
    assert.equal(hub.sessions.has("stale"), false);
    assert.equal(s.isAlive, false);
  });

  test("exclusive() serializes actions on one session", async () => {
    const s = await hub.getOrCreateSession("serial");
    const order = [];
    const slow = s.exclusive(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("first");
    });
    const fast = s.exclusive(async () => order.push("second"));
    const failing = s.exclusive(async () => {
      throw new Error("boom");
    });
    const after = s.exclusive(async () => order.push("third"));
    await Promise.all([slow, fast, failing.catch(() => {}), after]);
    assert.deepEqual(order, ["first", "second", "third"], "a failed action must not break the chain");
  });
});
