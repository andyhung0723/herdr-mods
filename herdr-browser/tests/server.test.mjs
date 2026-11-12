import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NO_BROWSER, processExited, removeStateDir, startDaemon, waitFor } from "./helpers.mjs";

describe("daemon HTTP API", { skip: NO_BROWSER }, () => {
  let daemon;
  let fixture;
  let fixtureOrigin;

  before(async () => {
    fixture = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<title>Fixture</title><button onclick="document.title='clicked'">Go</button>`);
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
    daemon = await startDaemon();
  });

  after(async () => {
    fixture.close();
    if (daemon.proc.exitCode === null) {
      daemon.proc.kill("SIGTERM");
      await processExited(daemon.proc);
    }
    removeStateDir(daemon.stateDir);
  });

  const url = (p) => `http://127.0.0.1:${daemon.port}${p}`;
  const auth = () => ({ Authorization: `Bearer ${daemon.token}` });
  const action = (agentId, body) =>
    fetch(url(`/action/${agentId}`), { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // fetch() refuses to set Host, so the rebinding check needs a raw request.
  const rawRequest = (options) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: daemon.port, ...options }, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      });
      req.on("error", reject);
      req.end();
    });

  test("health is public, everything else needs the token", async () => {
    assert.equal((await fetch(url("/health"))).status, 200);
    assert.equal((await fetch(url("/sessions"))).status, 401);
    assert.equal((await fetch(url("/sessions"), { headers: { Authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(url("/sessions"), { headers: auth() })).status, 200);
  });

  test("rejects foreign Host headers and sends no CORS headers", async () => {
    const rebinding = await rawRequest({ path: "/sessions", headers: { Host: `evil.test:${daemon.port}`, ...auth() } });
    assert.equal(rebinding.statusCode, 403);

    const preflight = await rawRequest({ method: "OPTIONS", path: "/action/claude", headers: { Origin: "https://evil.test" } });
    assert.ok(!Object.keys(preflight.headers).some((h) => h.startsWith("access-control-")));
  });

  test("validates input before touching the browser", async () => {
    assert.equal((await action("Bad Id!", { action: "snapshot" })).status, 400);
    assert.equal((await action("claude-t1", { action: "explode" })).status, 400);
    assert.equal((await action("claude-t1", { action: "navigate", url: "file:///etc/passwd" })).status, 400);
    const badJson = await fetch(url("/action/claude-t1"), { method: "POST", headers: auth(), body: "{" });
    assert.equal(badJson.status, 400);
    assert.equal((await fetch(url("/frame/nobody"), { headers: auth() })).status, 404);
  });

  test("drives a page, reports element errors as 422", async () => {
    const nav = await (await action("claude-t1", { action: "navigate", url: fixtureOrigin, client: { vendor: "claude", terminal: "t1" } })).json();
    assert.equal(nav.title, "Fixture");

    const snap = await (await action("claude-t1", { action: "snapshot" })).json();
    const ref = snap.result.match(/button "Go" \[ref=(e\d+)\]/)?.[1];
    const click = await (await action("claude-t1", { action: "click", ref })).json();
    assert.equal(click.title, "clicked", "title refreshes after driving actions");

    assert.equal((await action("claude-t1", { action: "click", selector: "#missing" })).status, 422);

    const { sessions } = await (await fetch(url("/sessions"), { headers: auth() })).json();
    assert.deepEqual(
      sessions.map((s) => [s.agentId, s.vendor, s.terminal]),
      [["claude-t1", "claude", "t1"]]
    );
  });

  test("human takeover locks out the agent", async () => {
    assert.equal((await action("claude-t1", { action: "set_driver", driver: "human" })).status, 403, "agents cannot take the wheel back");
    assert.equal((await action("claude-t1", { action: "set_driver", driver: "human", source: "human" })).status, 200);
    assert.equal((await action("claude-t1", { action: "reload" })).status, 409);
    assert.equal((await action("claude-t1", { action: "snapshot" })).status, 200, "read-only actions stay allowed");
    assert.equal((await action("claude-t1", { action: "reload", source: "human" })).status, 200);
    assert.equal((await action("claude-t1", { action: "set_driver", driver: "agent", source: "human" })).status, 200);
    assert.equal((await action("claude-t1", { action: "reload" })).status, 200);
  });

  test("frames stream only after a viewer asks", async () => {
    const first = await (await fetch(url("/frame/claude-t1?after=0"), { headers: auth() })).json();
    assert.equal(first.ok, true);
    const frame = await waitFor(async () => {
      const f = await (await fetch(url("/frame/claude-t1?after=0"), { headers: auth() })).json();
      return f.changed ? f : null;
    });
    assert.equal(frame.width, 1280);
    assert.ok(frame.frame.length > 1000);
    const again = await (await fetch(url(`/frame/claude-t1?after=${frame.seq}`), { headers: auth() })).json();
    assert.equal(again.changed, false);
  });

  test("close discards the session", async () => {
    const res = await (await action("claude-t1", { action: "close" })).json();
    assert.equal(res.result.closed, true);
    const { sessions } = await (await fetch(url("/sessions"), { headers: auth() })).json();
    assert.equal(sessions.length, 0);
  });

  test("SIGTERM removes the pid file and closes the browser", async () => {
    const pidFile = path.join(daemon.stateDir, "daemon.pid");
    assert.equal(fs.readFileSync(pidFile, "utf8").trim(), String(daemon.proc.pid));
    const activePort = fs.readFileSync(path.join(daemon.stateDir, "edge-profile", "DevToolsActivePort"), "utf8").split("\n")[0];

    daemon.proc.kill("SIGTERM");
    await processExited(daemon.proc);
    assert.equal(fs.existsSync(pidFile), false);
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${activePort}/json/version`);
        return false;
      } catch {
        return true;
      }
    });
  });
});
