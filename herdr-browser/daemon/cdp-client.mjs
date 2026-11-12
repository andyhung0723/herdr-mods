// Lightweight native CDP (Chrome DevTools Protocol) Client over WebSocket

export class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.disconnectHandlers = new Set();
    this.isOpen = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        return reject(err);
      }

      const timer = setTimeout(() => {
        reject(new Error(`CDP connection timeout to ${this.wsUrl}`));
      }, 5000);

      this.ws.onopen = () => {
        clearTimeout(timer);
        this.isOpen = true;
        resolve(this);
      };

      this.ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${e.message || "failed to connect"}`));
      };

      this.ws.onclose = () => {
        const wasOpen = this.isOpen;
        this.isOpen = false;
        for (const { reject } of this.pending.values()) {
          reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
        if (wasOpen) this.emitDisconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          // If response to a send request
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              resolve(msg.result);
            }
            return;
          }

          // If an event emission
          if (msg.method) {
            const handlers = this.listeners.get(msg.method);
            if (handlers) {
              for (const h of handlers) {
                try {
                  h(msg.params);
                } catch (err) {
                  console.error(`Error in CDP event handler for ${msg.method}:`, err);
                }
              }
            }
          }
        } catch (err) {
          console.error("Failed to parse CDP message:", err);
        }
      };
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.isOpen) {
      return Promise.reject(new Error("CDP Client is not connected"));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(payload);
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    if (this.listeners.has(method)) {
      this.listeners.get(method).delete(handler);
    }
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  emitDisconnect() {
    for (const h of this.disconnectHandlers) {
      try {
        h();
      } catch (err) {
        console.error("Error in CDP disconnect handler:", err);
      }
    }
  }

  // Intentional close: callers already know, so disconnect handlers are not fired.
  close() {
    this.disconnectHandlers.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
      this.isOpen = false;
    }
  }
}
