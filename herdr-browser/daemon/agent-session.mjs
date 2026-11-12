// One agent's isolated page: navigation, real input events, AX snapshots,
// on-demand screencast, and the agent/human driver lock.
import { renderAxSnapshot } from "./ax-snapshot.mjs";
import { normalizeNavigationUrl } from "./url-policy.mjs";

const LOAD_TIMEOUT_MS = 15_000;
const VIEWPORT = { width: 1280, height: 800 };

// Errors caused by the caller's input or page state (not daemon faults).
export class ActionError extends Error {}

export class HumanDrivingError extends ActionError {
  constructor() {
    super("A human has taken over this browser session. Wait, or ask the user to hand control back.");
  }
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

// Accepts CDP/DOM key names ("Enter", "ArrowUp") and GPUI names ("enter", "up").
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
NAMED_KEYS.up = NAMED_KEYS.arrowup;
NAMED_KEYS.down = NAMED_KEYS.arrowdown;
NAMED_KEYS.left = NAMED_KEYS.arrowleft;
NAMED_KEYS.right = NAMED_KEYS.arrowright;
NAMED_KEYS.esc = NAMED_KEYS.escape;
NAMED_KEYS.return = NAMED_KEYS.enter;

// "Enter", "Control+a", "shift-tab" → CDP key event fields.
export function parseKeyChord(chord) {
  const parts = String(chord ?? "").split(/[+-](?=.)/).filter(Boolean);
  if (parts.length === 0) throw new ActionError("key is required");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (!bit) throw new ActionError(`Unknown modifier "${m}" in "${chord}"`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[keyName.toLowerCase()];
  if (named) return { ...named, modifiers };
  if ([...keyName].length === 1) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: /[a-z]/i.test(keyName) ? `Key${upper}` : "", keyCode: upper.charCodeAt(0), text: keyName, modifiers };
  }
  throw new ActionError(`Unknown key "${keyName}"`);
}

export class AgentSession {
  constructor({ agentId, meta, browserContextId, targetId, pageClient, browserClient }) {
    this.agentId = agentId;
    this.vendor = meta?.vendor ?? null;
    this.terminal = meta?.terminal ?? null;
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.pageClient = pageClient;
    this.browserClient = browserClient;

    this.currentUrl = "about:blank";
    this.currentTitle = "New Tab";
    this.driver = "agent";
    this.isAlive = true;
    this.lastActivityAt = Date.now();
    this.lastViewedAt = 0;

    this.frame = null; // { seq, data, width, height, at }
    this.frameSeq = 0;
    this.screencasting = false;
    this.refs = new Map();
    this.actionChain = Promise.resolve();

    pageClient.on("Page.frameNavigated", ({ frame }) => {
      if (frame?.parentId == null && frame?.url) this.currentUrl = frame.url;
    });
    pageClient.on("Page.loadEventFired", () => this.refreshTitleAndUrl());
    pageClient.on("Page.screencastFrame", (params) => this.handleScreencastFrame(params));
  }

  static async attach({ pageClient, ...rest }) {
    await Promise.all([pageClient.send("Page.enable"), pageClient.send("DOM.enable"), pageClient.send("Runtime.enable")]);
    await pageClient.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    return new AgentSession({ pageClient, ...rest });
  }

  updateMeta(meta) {
    if (meta?.vendor) this.vendor = meta.vendor;
    if (meta?.terminal) this.terminal = meta.terminal;
  }

  // Actions on one page run strictly in order, even when an agent issues parallel tool calls.
  exclusive(fn) {
    const run = this.actionChain.then(fn);
    this.actionChain = run.catch(() => {});
    return run;
  }

  markDead() {
    this.isAlive = false;
    this.screencasting = false;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  setDriver(driver) {
    if (driver !== "agent" && driver !== "human") throw new ActionError(`driver must be "agent" or "human"`);
    this.driver = driver;
    return { driver };
  }

  assertAgentMayAct() {
    if (this.driver === "human") throw new HumanDrivingError();
  }

  describe() {
    return {
      agentId: this.agentId,
      vendor: this.vendor,
      terminal: this.terminal,
      url: this.currentUrl,
      title: this.currentTitle,
      driver: this.driver,
      frameSeq: this.frame?.seq ?? 0,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ── viewing ────────────────────────────────────────────────────────────

  async noteViewed() {
    this.lastViewedAt = Date.now();
    if (this.screencasting || !this.isAlive) return;
    this.screencasting = true;
    try {
      await this.pageClient.send("Page.startScreencast", { format: "jpeg", quality: 70, ...toMaxSize(VIEWPORT), everyNthFrame: 1 });
    } catch (err) {
      this.screencasting = false;
      throw err;
    }
  }

  async stopScreencastIfUnviewed(now, idleMs) {
    if (!this.screencasting || now - this.lastViewedAt < idleMs) return;
    this.screencasting = false;
    await this.pageClient.send("Page.stopScreencast").catch(() => {});
  }

  handleScreencastFrame({ data, metadata, sessionId }) {
    this.frameSeq += 1;
    this.frame = {
      seq: this.frameSeq,
      data,
      width: metadata?.deviceWidth ?? VIEWPORT.width,
      height: metadata?.deviceHeight ?? VIEWPORT.height,
      at: Date.now(),
    };
    this.pageClient.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  }

  frameAfter(seq) {
    if (!this.frame || this.frame.seq <= seq) return { seq: this.frame?.seq ?? 0, changed: false };
    const { data, ...rest } = this.frame;
    return { ...rest, changed: true, frame: data };
  }

  // ── navigation ─────────────────────────────────────────────────────────

  waitForEvent(method, timeoutMs) {
    let off;
    let timer;
    const promise = new Promise((resolve) => {
      off = this.pageClient.on(method, () => resolve(true));
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return promise.finally(() => {
      off();
      clearTimeout(timer);
    });
  }

  async afterNavigation(loaded) {
    const didLoad = await loaded;
    await this.refreshTitleAndUrl();
    return { url: this.currentUrl, title: this.currentTitle, loaded: didLoad };
  }

  async navigate(url) {
    const target = normalizeNavigationUrl(url);
    const loaded = this.waitForEvent("Page.loadEventFired", LOAD_TIMEOUT_MS);
    const res = await this.pageClient.send("Page.navigate", { url: target });
    if (res.errorText) {
      loaded.catch(() => {});
      throw new ActionError(`Navigation to ${target} failed: ${res.errorText}`);
    }
    // Same-document navigations (hash changes) fire no load event.
    return this.afterNavigation(res.loaderId ? loaded : Promise.resolve(true));
  }

  async reload() {
    const loaded = this.waitForEvent("Page.loadEventFired", LOAD_TIMEOUT_MS);
    await this.pageClient.send("Page.reload");
    return this.afterNavigation(loaded);
  }

  async goHistory(delta) {
    const { currentIndex, entries } = await this.pageClient.send("Page.getNavigationHistory");
    const entry = entries[currentIndex + delta];
    if (!entry) throw new ActionError(delta < 0 ? "No previous page in history" : "No next page in history");
    const loaded = this.waitForEvent("Page.loadEventFired", LOAD_TIMEOUT_MS);
    await this.pageClient.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    return this.afterNavigation(loaded);
  }

  async refreshTitleAndUrl() {
    try {
      const res = await this.pageClient.send("Runtime.evaluate", {
        expression: "({ title: document.title, url: location.href })",
        returnByValue: true,
      });
      const value = res?.result?.value;
      if (value) {
        this.currentTitle = value.title || "Untitled";
        this.currentUrl = value.url || this.currentUrl;
      }
    } catch {}
  }

  // ── element targeting ──────────────────────────────────────────────────

  async resolveNode({ ref, selector }) {
    if (ref) {
      const backendNodeId = this.refs.get(ref);
      if (!backendNodeId) throw new ActionError(`Unknown ref "${ref}"; take a new browser_snapshot`);
      return { backendNodeId };
    }
    if (selector) {
      const res = await this.pageClient.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
      });
      if (res.exceptionDetails) throw new ActionError(`Invalid selector: ${selector}`);
      const objectId = res.result?.objectId;
      if (!objectId) throw new ActionError(`Element not found: ${selector}`);
      return { objectId };
    }
    return null;
  }

  async centerOf(node) {
    await this.pageClient.send("DOM.scrollIntoViewIfNeeded", node).catch(() => {});
    let quads;
    try {
      ({ quads } = await this.pageClient.send("DOM.getContentQuads", node));
    } catch {
      throw new ActionError("Element is no longer attached; take a new browser_snapshot");
    }
    const quad = quads?.[0];
    if (!quad) throw new ActionError("Element is not visible (no layout box)");
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
  }

  // ── input ──────────────────────────────────────────────────────────────

  async click({ ref, selector, x, y, button = "left", clickCount = 1 }) {
    const node = await this.resolveNode({ ref, selector });
    let point;
    if (node) point = await this.centerOf(node);
    else if (Number.isFinite(x) && Number.isFinite(y)) point = { x, y };
    else throw new ActionError("click needs ref, selector, or x and y");

    const base = { ...point, button, clickCount };
    await this.pageClient.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.pageClient.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.pageClient.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return { clickedAt: point };
  }

  async type({ ref, selector, text = "", clear = false, submit = false }) {
    const node = await this.resolveNode({ ref, selector });
    if (node) {
      await this.pageClient.send("DOM.scrollIntoViewIfNeeded", node).catch(() => {});
      try {
        await this.pageClient.send("DOM.focus", node);
      } catch {
        throw new ActionError("Element cannot receive focus");
      }
    }
    if (clear) {
      await this.selectAllInFocused();
      if (!text) await this.pressKey("Backspace");
    }
    // insertText fires real beforeinput/input events, so React/Vue controlled inputs see it.
    if (text) await this.pageClient.send("Input.insertText", { text: String(text) });
    if (submit) await this.pressKey("Enter");
    return { typed: [...String(text)].length, submitted: Boolean(submit) };
  }

  async selectAllInFocused() {
    await this.pageClient.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.activeElement;
        if (!el) return;
        if (typeof el.select === "function") return el.select();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      })()`,
    });
  }

  async pressKey(chord, { text } = {}) {
    const k = parseKeyChord(chord);
    const typedText = k.modifiers & ~MODIFIER_BITS.shift ? undefined : (text ?? k.text);
    const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.pageClient.send("Input.dispatchKeyEvent", {
      type: typedText ? "keyDown" : "rawKeyDown",
      ...common,
      ...(typedText && { text: typedText, unmodifiedText: typedText }),
    });
    await this.pageClient.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    return { key: chord };
  }

  async scroll({ dx = 0, dy = 0, x = VIEWPORT.width / 2, y = VIEWPORT.height / 2 }) {
    await this.pageClient.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    return { scrolled: { dx, dy } };
  }

  // ── inspection ─────────────────────────────────────────────────────────

  async screenshot() {
    const res = await this.pageClient.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
    return res.data;
  }

  async snapshot() {
    await this.refreshTitleAndUrl();
    const { nodes } = await this.pageClient.send("Accessibility.getFullAXTree");
    const { text, refs } = renderAxSnapshot(nodes, { url: this.currentUrl, title: this.currentTitle });
    this.refs = refs;
    return text;
  }

  async evaluate(script) {
    const res = await this.pageClient.send("Runtime.evaluate", {
      expression: String(script ?? ""),
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new ActionError(`Script threw: ${detail}`);
    }
    return res.result?.value;
  }

  async destroy() {
    this.markDead();
    try {
      this.pageClient.close();
    } catch {}
    await this.browserClient.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    await this.browserClient.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId }).catch(() => {});
  }
}

function toMaxSize({ width, height }) {
  return { maxWidth: width, maxHeight: height };
}
