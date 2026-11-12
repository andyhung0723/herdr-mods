// Multi-tenant Browser Hub managing isolated BrowserContexts per Agent
import fs from "node:fs";
import { ensureEdgeRunning } from "./edge-launcher.mjs";
import { CDPClient } from "./cdp-client.mjs";

const FRAMES_DIR = "/tmp/herdr-browser-frames";
try {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
} catch {}

const INIT_BACKOFF_BASE_MS = 1000;
const INIT_BACKOFF_MAX_MS = 30_000;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:", "data:"]);

// Scheme-less input ("localhost:3000", "example.com") defaults to http://.
// file:, chrome:, edge:, javascript: etc. are rejected: they would let any
// caller of the daemon read local files or reach privileged browser pages.
export function normalizeNavigationUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("URL is required");

  const hasAuthorityScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const isOpaqueAllowed = /^(about|data):/i.test(raw);
  const candidate = hasAuthorityScheme || isOpaqueAllowed ? raw : `http://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" (allowed: ${[...ALLOWED_PROTOCOLS].join(", ")})`);
  }
  return parsed.href;
}

export class BrowserHub {
  constructor(options = {}) {
    this.profileDir = options.profileDir;
    this.port = null;
    this.browserClient = null;
    this.sessions = new Map(); // agentId -> AgentSession
    this.pendingSessions = new Map(); // agentId -> Promise<AgentSession>
    this.isReady = false;

    this.initPromise = null;
    this.initFailures = 0;
    this.nextInitAt = 0;
    this.lastInitError = null;
  }

  // Single-flight with exponential backoff: concurrent callers share one launch
  // attempt, and a failing browser is not relaunched on every poll.
  init() {
    if (this.isReady) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    const waitMs = this.nextInitAt - Date.now();
    if (waitMs > 0) {
      return Promise.reject(
        new Error(`Browser unavailable (retry in ${Math.ceil(waitMs / 1000)}s): ${this.lastInitError}`)
      );
    }

    this.initPromise = this.connectBrowser()
      .then(() => {
        this.initFailures = 0;
        this.nextInitAt = 0;
        this.lastInitError = null;
      })
      .catch((err) => {
        this.initFailures += 1;
        this.nextInitAt = Date.now() + Math.min(INIT_BACKOFF_MAX_MS, INIT_BACKOFF_BASE_MS * 2 ** (this.initFailures - 1));
        this.lastInitError = err.message;
        throw err;
      })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  async connectBrowser() {
    const { port, wsEndpoint } = await ensureEdgeRunning({ profileDir: this.profileDir });
    const client = new CDPClient(wsEndpoint);
    await client.connect();
    client.onDisconnect(() => this.handleBrowserDisconnect(client));
    this.port = port;
    this.browserClient = client;
    this.isReady = true;
  }

  // Browser crashed or was killed: drop every session so the next request relaunches cleanly.
  handleBrowserDisconnect(client) {
    if (this.browserClient !== client) return;
    console.error("Browser connection lost; sessions dropped, will relaunch on next request.");
    for (const s of this.sessions.values()) s.markDead();
    this.sessions.clear();
    this.browserClient = null;
    this.port = null;
    this.isReady = false;
  }

  status() {
    return {
      isReady: this.isReady,
      launching: Boolean(this.initPromise),
      lastError: this.lastInitError,
      sessions: this.sessions.size,
    };
  }

  // Single-flight per agent: concurrent first calls must not each create a BrowserContext.
  async getOrCreateSession(rawAgentId = "default") {
    await this.init();
    const agentId = String(rawAgentId).trim().toLowerCase() || "default";

    const existing = this.sessions.get(agentId);
    if (existing?.isAlive) return existing;

    const pending = this.pendingSessions.get(agentId);
    if (pending) return pending;

    const creation = this.createSession(agentId).finally(() => this.pendingSessions.delete(agentId));
    this.pendingSessions.set(agentId, creation);
    return creation;
  }

  async createSession(agentId) {
    // 1. Create an isolated BrowserContext (Option A: Ephemeral, no cookies leak)
    const { browserContextId } = await this.browserClient.send("Target.createBrowserContext");

    // 2. Create Target Page inside this BrowserContext
    const { targetId } = await this.browserClient.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
      width: 1280,
      height: 800,
      enableBeginFrameControl: false,
    });

    // 3. Connect CDP to this specific target Page
    const pageWsUrl = `ws://127.0.0.1:${this.port}/devtools/page/${targetId}`;
    const pageClient = new CDPClient(pageWsUrl);
    await pageClient.connect();

    // 4. Initialize domains
    await pageClient.send("Page.enable");
    await pageClient.send("DOM.enable");
    await pageClient.send("Runtime.enable");

    const session = new AgentSession({
      agentId,
      browserContextId,
      targetId,
      pageClient,
      browserClient: this.browserClient,
      onClose: () => this.sessions.delete(agentId),
    });

    pageClient.onDisconnect(() => {
      session.markDead();
      if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
    });

    // 5. Start Screencast for UI preview
    await session.startScreencasting();

    this.sessions.set(agentId, session);
    return session;
  }

  listSessions() {
    const list = [];
    for (const [id, s] of this.sessions) {
      list.push({
        agentId: id,
        targetId: s.targetId,
        url: s.currentUrl,
        title: s.currentTitle,
        hasFrame: Boolean(s.lastFrame),
        updatedAt: s.lastFrameTime,
      });
    }
    return list;
  }

  async closeSession(agentId) {
    const s = this.sessions.get(agentId);
    if (s) {
      await s.destroy();
      this.sessions.delete(agentId);
    }
  }

  // `closeBrowser` also shuts down the headless browser, including one adopted
  // from a previous daemon run that this process did not spawn.
  async destroy({ closeBrowser = true } = {}) {
    for (const s of this.sessions.values()) {
      await s.destroy().catch(() => {});
    }
    this.sessions.clear();
    if (this.browserClient) {
      if (closeBrowser) await this.browserClient.send("Browser.close", {}, 3000).catch(() => {});
      this.browserClient.close();
      this.browserClient = null;
    }
    this.isReady = false;
  }
}

export class AgentSession {
  constructor({ agentId, browserContextId, targetId, pageClient, browserClient, onClose }) {
    this.agentId = agentId;
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.pageClient = pageClient;
    this.browserClient = browserClient;
    this.onClose = onClose;

    this.currentUrl = "about:blank";
    this.currentTitle = "New Tab";
    this.lastFrame = null;
    this.lastFrameTime = Date.now();
    this.frameListeners = new Set();
    this.isAlive = true;

    // Listen to lifecycle events
    this.pageClient.on("Page.loadEventFired", async () => {
      await this.updateTitleAndUrl();
    });

    this.pageClient.on("Page.frameNavigated", (params) => {
      if (params?.frame?.parentId == null && params?.frame?.url) {
        this.currentUrl = params.frame.url;
      }
    });
  }

  async updateTitleAndUrl() {
    try {
      const res = await this.pageClient.send("Runtime.evaluate", {
        expression: "JSON.stringify({ title: document.title, url: window.location.href })",
        returnByValue: true,
      });
      if (res?.result?.value) {
        const parsed = JSON.parse(res.result.value);
        this.currentTitle = parsed.title || "Untitled";
        this.currentUrl = parsed.url || this.currentUrl;
      }
    } catch {}
  }

  async startScreencasting() {
    this.pageClient.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      this.lastFrame = data; // base64 JPEG
      this.lastFrameTime = Date.now();
      const framePath = `${FRAMES_DIR}/${this.agentId}.jpg`;
      fs.writeFile(framePath, Buffer.from(data, "base64"), () => {});

      for (const cb of this.frameListeners) {
        try {
          cb(data, metadata);
        } catch {}
      }
      try {
        await this.pageClient.send("Page.screencastFrameAck", { sessionId });
      } catch {}
    });

    await this.pageClient.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    if (this.lastFrame) {
      listener(this.lastFrame, {});
    }
    return () => this.frameListeners.delete(listener);
  }

  markDead() {
    this.isAlive = false;
    this.frameListeners.clear();
  }

  async navigate(url) {
    const target = normalizeNavigationUrl(url);
    const res = await this.pageClient.send("Page.navigate", { url: target });
    this.currentUrl = target;
    await this.updateTitleAndUrl();
    return res;
  }

  async click({ selector, x, y }) {
    if (typeof x === "number" && typeof y === "number") {
      await this.pageClient.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await this.pageClient.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return { ok: true, clickedAt: { x, y } };
    }

    if (selector) {
      // Find element and click via JS evaluate
      const expr = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: "Element not found" };
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          const rect = el.getBoundingClientRect();
          el.click();
          return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `;
      const evalRes = await this.pageClient.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      return evalRes?.result?.value || { ok: false, error: "Evaluation failed" };
    }

    throw new Error("Either selector or (x, y) coordinates must be provided for click");
  }

  async type({ selector, text, clear = false }) {
    if (selector) {
      const expr = `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: "Element not found" };
          el.focus();
          ${clear ? 'el.value = "";' : ""}
          return { ok: true };
        })()
      `;
      const evalRes = await this.pageClient.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      if (!evalRes?.result?.value?.ok) {
        return evalRes?.result?.value || { ok: false };
      }
    }

    // Type text keystroke by keystroke
    for (const char of String(text)) {
      await this.pageClient.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        unmodifiedText: char,
      });
      await this.pageClient.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
        unmodifiedText: char,
      });
    }
    return { ok: true, typedLength: text.length };
  }

  async screenshot(format = "jpeg") {
    const res = await this.pageClient.send("Page.captureScreenshot", {
      format,
      quality: 80,
    });
    return res.data; // base64
  }

  async getSnapshot() {
    const expr = `
      (() => {
        function cleanNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent.trim();
            return t ? t : null;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return null;
          const tag = node.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return null;
          
          const item = { tag };
          if (node.id) item.id = node.id;
          if (node.className && typeof node.className === 'string') item.class = node.className.trim();
          if (node.getAttribute('role')) item.role = node.getAttribute('role');
          if (node.getAttribute('aria-label')) item.ariaLabel = node.getAttribute('aria-label');
          if (node.getAttribute('placeholder')) item.placeholder = node.getAttribute('placeholder');
          if (tag === 'a' && node.href) item.href = node.href;
          if (['input', 'textarea', 'select'].includes(tag)) item.value = node.value;
          
          const children = [];
          for (const c of node.childNodes) {
            const res = cleanNode(c);
            if (res) children.push(res);
          }
          if (children.length > 0) item.children = children;
          return item;
        }
        return JSON.stringify({
          url: window.location.href,
          title: document.title,
          tree: cleanNode(document.body)
        });
      })()
    `;
    const res = await this.pageClient.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    return res?.result?.value ? JSON.parse(res.result.value) : { error: "Snapshot failed" };
  }

  async evaluate(script) {
    const res = await this.pageClient.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  }

  async destroy() {
    this.isAlive = false;
    this.frameListeners.clear();
    if (this.pageClient) {
      try {
        await this.pageClient.send("Page.stopScreencast").catch(() => {});
        this.pageClient.close();
      } catch {}
      this.pageClient = null;
    }
    if (this.browserClient) {
      try {
        await this.browserClient.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
        await this.browserClient.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId }).catch(() => {});
      } catch {}
    }
    if (this.onClose) this.onClose();
  }
}
