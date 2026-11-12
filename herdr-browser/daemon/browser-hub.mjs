// Multi-tenant Browser Hub managing isolated BrowserContexts per Agent
import fs from "node:fs";
import { ensureEdgeRunning } from "./edge-launcher.mjs";
import { CDPClient } from "./cdp-client.mjs";

const FRAMES_DIR = "/tmp/herdr-browser-frames";
try {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
} catch {}

export class BrowserHub {
  constructor(options = {}) {
    this.port = options.port || 9222;
    this.browserClient = null;
    this.sessions = new Map(); // agentId -> AgentSession
    this.isReady = false;
  }

  async init() {
    if (this.isReady) return;
    const { wsEndpoint } = await ensureEdgeRunning(this.port);
    this.browserClient = new CDPClient(wsEndpoint);
    await this.browserClient.connect();
    this.isReady = true;
  }

  async getOrCreateSession(rawAgentId = "default") {
    await this.init();
    const agentId = String(rawAgentId).trim().toLowerCase() || "default";

    if (this.sessions.has(agentId)) {
      const existing = this.sessions.get(agentId);
      if (existing.isAlive) return existing;
    }

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

  async destroy() {
    for (const s of this.sessions.values()) {
      await s.destroy().catch(() => {});
    }
    this.sessions.clear();
    if (this.browserClient) {
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

  async navigate(url) {
    let target = String(url || "").trim();
    if (
      !target.startsWith("http://") &&
      !target.startsWith("https://") &&
      !target.startsWith("file://") &&
      !target.startsWith("about:") &&
      !target.startsWith("data:")
    ) {
      target = "http://" + target;
    }
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
