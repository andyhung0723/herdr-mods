// Multi-tenant Browser Hub managing isolated BrowserContexts per Agent
import { AgentSession } from "./agent-session.mjs";
import { CDPClient } from "./cdp-client.mjs";
import { ensureEdgeRunning } from "./edge-launcher.mjs";

export { normalizeNavigationUrl } from "./url-policy.mjs";

const INIT_BACKOFF_BASE_MS = 1000;
const INIT_BACKOFF_MAX_MS = 30_000;

const DEFAULTS = {
  sweepIntervalMs: 2000,
  // Screencast runs only while a viewer keeps polling frames.
  screencastIdleMs: 5000,
  // A session nobody drove or watched for this long is closed.
  sessionIdleMs: 30 * 60_000,
};

export class BrowserHub {
  constructor(options = {}) {
    this.profileDir = options.profileDir;
    this.options = { ...DEFAULTS, ...options };
    this.port = null;
    this.browserClient = null;
    this.sessions = new Map(); // agentId -> AgentSession
    this.pendingSessions = new Map(); // agentId -> Promise<AgentSession>
    this.isReady = false;

    this.initPromise = null;
    this.initFailures = 0;
    this.nextInitAt = 0;
    this.lastInitError = null;

    this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs);
    this.sweepTimer.unref();
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
  async getOrCreateSession(rawAgentId = "default", meta) {
    await this.init();
    const agentId = String(rawAgentId).trim().toLowerCase() || "default";

    const existing = this.sessions.get(agentId);
    if (existing?.isAlive) {
      existing.updateMeta(meta);
      return existing;
    }

    const pending = this.pendingSessions.get(agentId);
    if (pending) return pending;

    const creation = this.createSession(agentId, meta).finally(() => this.pendingSessions.delete(agentId));
    this.pendingSessions.set(agentId, creation);
    return creation;
  }

  async createSession(agentId, meta) {
    const { browserContextId } = await this.browserClient.send("Target.createBrowserContext", { disposeOnDetach: false });
    const { targetId } = await this.browserClient.send("Target.createTarget", { url: "about:blank", browserContextId });

    const pageClient = new CDPClient(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    await pageClient.connect();

    const session = await AgentSession.attach({
      agentId,
      meta,
      browserContextId,
      targetId,
      pageClient,
      browserClient: this.browserClient,
    });

    pageClient.onDisconnect(() => {
      session.markDead();
      if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
    });

    this.sessions.set(agentId, session);
    return session;
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => s.describe());
  }

  async closeSession(agentId) {
    const s = this.sessions.get(agentId);
    if (!s) return false;
    this.sessions.delete(agentId);
    await s.destroy();
    return true;
  }

  async sweep(now = Date.now()) {
    for (const [agentId, s] of this.sessions) {
      const lastTouched = Math.max(s.lastActivityAt, s.lastViewedAt);
      if (now - lastTouched > this.options.sessionIdleMs) {
        console.log(`Closing idle session ${agentId}`);
        await this.closeSession(agentId).catch(() => {});
        continue;
      }
      await s.stopScreencastIfUnviewed(now, this.options.screencastIdleMs).catch(() => {});
    }
  }

  // `closeBrowser` also shuts down the headless browser, including one adopted
  // from a previous daemon run that this process did not spawn.
  async destroy({ closeBrowser = true } = {}) {
    clearInterval(this.sweepTimer);
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
