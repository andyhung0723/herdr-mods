import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserHub } from "../daemon/browser-hub.mjs";
import { stopEdge } from "../daemon/edge-launcher.mjs";

test("BrowserHub manages isolated multi-agent BrowserContexts", async () => {
  const hub = new BrowserHub();
  after(async () => {
    await hub.destroy();
    stopEdge();
  });

  await hub.init();
  assert.equal(hub.isReady, true);

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
