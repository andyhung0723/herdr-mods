import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserHub, normalizeNavigationUrl } from "../daemon/browser-hub.mjs";
import { stopEdge } from "../daemon/edge-launcher.mjs";

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-browser-test-"));
after(() => fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("normalizeNavigationUrl allows web schemes and blocks local/privileged ones", () => {
  assert.equal(normalizeNavigationUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeNavigationUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeNavigationUrl("about:blank"), "about:blank");
  for (const blocked of ["file:///etc/passwd", "FILE:///etc/hosts", "edge://settings", "chrome://version", "javascript:alert(1)", ""]) {
    assert.throws(() => normalizeNavigationUrl(blocked), undefined, blocked);
  }
});

test("BrowserHub manages isolated multi-agent BrowserContexts", async () => {
  const hub = new BrowserHub({ profileDir });
  after(async () => {
    await hub.destroy();
    stopEdge();
  });

  const concurrentInits = [hub.init(), hub.init(), hub.init()];
  assert.equal(new Set(concurrentInits).size, 1, "concurrent init() calls must share one launch");
  await Promise.all(concurrentInits);
  assert.equal(hub.isReady, true);
  assert.notEqual(hub.port, 9222, "must use an OS-assigned debugging port");

  // 1. Create session for Claude
  const claudeSession = await hub.getOrCreateSession("claude");
  assert.ok(claudeSession);
  assert.equal(claudeSession.agentId, "claude");

  // 2. Create session for Codex
  const codexSession = await hub.getOrCreateSession("codex");
  assert.ok(codexSession);
  assert.equal(codexSession.agentId, "codex");

  // Verify BrowserContext isolation (different IDs!)
  assert.notEqual(claudeSession.browserContextId, codexSession.browserContextId);
  assert.notEqual(claudeSession.targetId, codexSession.targetId);

  // 3. Navigate Claude to one page
  await claudeSession.navigate("data:text/html,<html><head><title>Claude Page</title></head><body><h1>Hello Claude</h1><button id='btn'>Click Claude</button></body></html>");
  
  // 4. Navigate Codex to a completely different page
  await codexSession.navigate("data:text/html,<html><head><title>Codex Page</title></head><body><h1>Hello Codex</h1><input id='inp' type='text' /></body></html>");

  // 5. Verify Claude's state
  const claudeSnapshot = await claudeSession.getSnapshot();
  assert.equal(claudeSnapshot.title, "Claude Page");
  assert.ok(JSON.stringify(claudeSnapshot.tree).includes("Hello Claude"));
  assert.equal(JSON.stringify(claudeSnapshot.tree).includes("Hello Codex"), false, "Claude must not see Codex content");

  // 6. Verify Codex's state
  const codexSnapshot = await codexSession.getSnapshot();
  assert.equal(codexSnapshot.title, "Codex Page");
  assert.ok(JSON.stringify(codexSnapshot.tree).includes("Hello Codex"));
  assert.equal(JSON.stringify(codexSnapshot.tree).includes("Hello Claude"), false, "Codex must not see Claude content");

  // 7. Test Click action in Claude
  const clickRes = await claudeSession.click({ selector: "#btn" });
  assert.equal(clickRes.ok, true);

  // 8. Test Type action in Codex
  const typeRes = await codexSession.type({ selector: "#inp", text: "testing codex" });
  assert.equal(typeRes.ok, true);

  // 9. Verify Sessions list
  const sessions = hub.listSessions();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((s) => s.agentId === "claude"));
  assert.ok(sessions.some((s) => s.agentId === "codex"));

  // 10. Close one session
  await hub.closeSession("claude");
  assert.equal(hub.listSessions().length, 1);
  assert.equal(hub.sessions.has("claude"), false);
  assert.equal(hub.sessions.has("codex"), true);
});

test("concurrent getOrCreateSession for one agent yields a single BrowserContext", async () => {
  const hub = new BrowserHub({ profileDir });
  after(async () => {
    await hub.destroy();
    stopEdge();
  });

  const sessions = await Promise.all([1, 2, 3].map(() => hub.getOrCreateSession("burst")));
  assert.equal(new Set(sessions).size, 1);
  const { browserContextIds } = await hub.browserClient.send("Target.getBrowserContexts");
  assert.equal(browserContextIds.length, 1);
});
