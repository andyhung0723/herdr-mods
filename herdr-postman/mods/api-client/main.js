// API Client (Postman/Bruno style) mod for Herdr.
// Supports Right-Side Panel mode and Popup Dialog mode (Ctrl+B r).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor } from "gpui-base";
import {
  theme,
  props,
  closeOverlay,
  openOverlay,
  setShared,
  shared,
  notify,
} from "herdr";
import {
  METHODS,
  AUTH_TYPES,
  GLOBAL_PROJECT,
  SHARED_STORE_VERSION_KEY,
  uid,
  isSensitiveKey,
  createEmptyRequest,
  redactRequestForLog,
  redactHeaderValue,
  parseCurlCommand,
  buildCurlCommand,
  loadStore,
  saveStore,
  executeHttpRequest,
  resolveActiveProject,
  resolveAvailableAgents,
  sendDebugToAgent,
  copyTextToClipboard,
} from "./store.js";

const MOD = "api-client";
const OVERLAY_KEY = "api-client.open-overlay";

const ICON_API = `mods/${MOD}/api.svg`;
const ICON_SEND = `mods/${MOD}/send.svg`;
const ICON_PLUS = `mods/${MOD}/plus.svg`;
const ICON_TRASH = `mods/${MOD}/trash.svg`;
const ICON_COPY = `mods/${MOD}/copy.svg`;
const ICON_EXTERNAL = `mods/${MOD}/external-link.svg`;
const ICON_X = `mods/${MOD}/x.svg`;
const ICON_EYE = `mods/${MOD}/eye.svg`;
const ICON_BOOKMARK = `mods/${MOD}/bookmark.svg`;

const REQUEST_TABS = ["body", "params", "headers", "auth", "env"];
const SIDEBAR_TABS = ["saved", "history", "env"];

function withAlpha(hex, alphaHex = "22") {
  if (typeof hex !== "string" || !hex.startsWith("#")) return `#3b82f6${alphaHex}`;
  return hex.slice(0, 7) + alphaHex;
}

function methodColors(t, method) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") {
    const fg = t.ansi2 ?? t.working ?? "#a6e3a1";
    return { fg, bg: withAlpha(fg, "22") };
  }
  if (m === "POST") {
    const fg = t.accent ?? "#89b4fa";
    return { fg, bg: withAlpha(fg, "22") };
  }
  if (m === "PUT" || m === "PATCH") {
    const fg = t.ansi3 ?? t.blocked ?? "#f9e2af";
    return { fg, bg: withAlpha(fg, "22") };
  }
  if (m === "DELETE") {
    const fg = t.ansi1 ?? "#f38ba8";
    return { fg, bg: withAlpha(fg, "22") };
  }
  const fg = t.muted ?? "#a6adc8";
  return { fg, bg: withAlpha(fg, "22") };
}

function statusColors(t, status) {
  const code = Number(status || 0);
  if (code >= 200 && code < 300) {
    const fg = t.ansi2 ?? t.working ?? "#a6e3a1";
    return { fg, bg: withAlpha(fg, "26") };
  }
  if (code >= 300 && code < 400) {
    const fg = t.accent ?? "#89b4fa";
    return { fg, bg: withAlpha(fg, "26") };
  }
  if (code >= 400 && code < 500) {
    const fg = t.ansi3 ?? t.blocked ?? "#f9e2af";
    return { fg, bg: withAlpha(fg, "26") };
  }
  const fg = t.ansi1 ?? "#f38ba8";
  return { fg, bg: withAlpha(fg, "26") };
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function maskSecret(val) {
  const s = String(val ?? "");
  if (!s) return "";
  if (s.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, s.length - 4))}${s.slice(-4)}`;
}

function safeNotify(payload) {
  try {
    if (typeof notify === "function") notify(payload);
  } catch {}
}

export default class ApiClientView extends View {
  init(initialProps, cx) {
    const runtimeProps = typeof props === "function" ? props() : {};
    const p = { ...(runtimeProps || {}), ...(initialProps || {}) };
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "panel");
    this.asyncCx = cx;

    this.loaded = false;
    this.savedRequests = [];
    this.history = [];
    this.environments = [];
    this.activeEnvId = "env_local";
    this.preferredAgentCli = "claude";
    this.lastExpectedRaw = null;
    this.lastStoreVersion = shared(SHARED_STORE_VERSION_KEY) ?? null;

    this.activeProject = resolveActiveProject();
    this.currentReq = createEmptyRequest(this.activeProject.path, this.activeProject.name);
    this.lastResponse = null;

    this.reqTab = "body"; // body | params | headers | auth | env | saved | history
    this.sidebarTab = "saved"; // saved | history | env (used in dialog mode)
    this.resTab = "body"; // body | headers
    this.scopeSaved = "project"; // project | all
    this.showMethodPicker = false;
    this.showCurlImport = false;
    this.showSecrets = false;
    this.sending = false;
    this.selectedAgentAddress = null;
    this.editingRowId = null;
    this.feedbackMsg = "";
    this.syncingInputs = false;

    const t = typeof theme === "function" ? theme() : {};
    const editorSyntax = {
      keyword: t.ansi5 ?? "#cba6f7",
      string: t.ansi2 ?? "#a6e3a1",
      comment: t.dim ?? "#6c7086",
      function: t.ansi4 ?? "#89b4fa",
      type: t.ansi3 ?? "#f9e2af",
      number: t.ansi1 ?? "#f38ba8",
      constant: t.ansi6 ?? "#94e2d5",
    };

    this.handle = cx.focus_handle();
    this.urlInput = InputState.new({ placeholder: "https://api.example.com/v1/users or {{baseUrl}}/health" });
    this.reqNameInput = InputState.new({ placeholder: "Request name (e.g. Get User Profile)" });
    this.curlImportInput = InputState.new({ placeholder: "Paste cURL command here and press Enter…" });
    this.newRowKeyInput = InputState.new({ placeholder: "Key" });
    this.newRowValInput = InputState.new({ placeholder: "Value" });
    this.authTokenInput = InputState.new({ placeholder: "Bearer token or {{token}}" });
    this.authUserInput = InputState.new({ placeholder: "Username" });
    this.authPassInput = InputState.new({ placeholder: "Password" });
    this.authApiKeyNameInput = InputState.new({ placeholder: "Header/Param name (X-API-Key)", value: "X-API-Key" });
    this.authApiKeyValInput = InputState.new({ placeholder: "API Key or {{apiKey}}" });

    this.reqBodyEditor = EditorState.new({
      language: "json",
      value: "",
      font_size: 11.5,
      line_numbers: true,
      folding: true,
      soft_wrap: true,
      syntax: editorSyntax,
    });

    this.resBodyEditor = EditorState.new({
      language: "json",
      value: "// Response body will appear here after clicking Send",
      font_size: 11.5,
      line_numbers: true,
      folding: true,
      readonly: true,
      soft_wrap: true,
      syntax: editorSyntax,
    });

    this.bindInputListeners();

    if (this.role === "dialog") {
      this.handle.focus();
      cx.timer?.after?.(120, () => this.urlInput.focus());
    }

    this.reloadStore(cx);

    cx.timer?.every?.(1000, (tcx) => {
      let dirty = false;
      const proj = resolveActiveProject();
      if (proj.path !== this.activeProject.path) {
        this.activeProject = proj;
        dirty = true;
      }
      const sharedVer = shared(SHARED_STORE_VERSION_KEY);
      if (sharedVer && sharedVer !== this.lastStoreVersion) {
        this.lastStoreVersion = sharedVer;
        this.reloadStore(tcx);
        return;
      }
      if (dirty) tcx?.notify?.();
    });
  }

  bindInputListeners() {
    this.urlInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.url = this.urlInput.value();
    });
    this.urlInput.on("submit", (_e, subCx) => this.handleSend(subCx));

    this.reqNameInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.name = this.reqNameInput.value();
    });
    this.reqNameInput.on("submit", (_e, subCx) => this.handleSaveRequest(subCx));

    this.curlImportInput.on("submit", (_e, subCx) => this.handleImportCurl(subCx));
    this.newRowValInput.on("submit", (_e, subCx) => this.handleSaveKvRow(subCx));

    this.authTokenInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.auth.token = this.authTokenInput.value();
    });
    this.authUserInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.auth.username = this.authUserInput.value();
    });
    this.authPassInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.auth.password = this.authPassInput.value();
    });
    this.authApiKeyNameInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.auth.apiKeyName = this.authApiKeyNameInput.value();
    });
    this.authApiKeyValInput.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.auth.apiKeyValue = this.authApiKeyValInput.value();
    });

    this.reqBodyEditor.on("change", () => {
      if (this.syncingInputs) return;
      this.currentReq.body = this.reqBodyEditor.value();
    });
  }

  loadRequestIntoForm(req, clickCx) {
    this.syncingInputs = true;
    try {
      const cloned = JSON.parse(JSON.stringify(req));
      const base = createEmptyRequest(this.activeProject.path, this.activeProject.name);
      this.currentReq = {
        ...base,
        ...cloned,
        params: Array.isArray(cloned.params) && cloned.params.length ? cloned.params : base.params,
        headers: Array.isArray(cloned.headers) && cloned.headers.length ? cloned.headers : base.headers,
        auth: { ...base.auth, ...(cloned.auth || {}) },
      };
      this.urlInput.set_value(this.currentReq.url || "");
      this.reqNameInput.set_value(this.currentReq.name || "");
      this.authTokenInput.set_value(this.currentReq.auth.token || "");
      this.authUserInput.set_value(this.currentReq.auth.username || "");
      this.authPassInput.set_value(this.currentReq.auth.password || "");
      this.authApiKeyNameInput.set_value(this.currentReq.auth.apiKeyName || "X-API-Key");
      this.authApiKeyValInput.set_value(this.currentReq.auth.apiKeyValue || "");
      this.reqBodyEditor.set_value(this.currentReq.body || "");
      this.editingRowId = null;
      this.showMethodPicker = false;
    } finally {
      this.syncingInputs = false;
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  getActiveEnv() {
    return (
      this.environments.find((e) => e.id === this.activeEnvId) ||
      this.environments[0] ||
      { id: "env_local", name: "Local", vars: [] }
    );
  }

  getActiveEnvVars() {
    return this.getActiveEnv().vars || [];
  }

  async reloadStore(cx) {
    const store = await loadStore();
    this.savedRequests = store.savedRequests;
    this.history = store.history;
    this.environments = store.environments;
    this.activeEnvId = store.activeEnvId;
    this.preferredAgentCli = store.preferredAgentCli || "claude";
    this.lastExpectedRaw = store.lastExpectedRaw ?? null;
    this.loaded = true;
    (this.asyncCx ?? cx)?.notify?.();
  }

  async persistStore(cx) {
    const serialized = await saveStore({
      savedRequests: this.savedRequests,
      history: this.history,
      environments: this.environments,
      activeEnvId: this.activeEnvId,
      preferredAgentCli: this.preferredAgentCli,
      lastExpectedRaw: this.lastExpectedRaw,
    });
    this.lastExpectedRaw = serialized;
    this.lastStoreVersion = shared(SHARED_STORE_VERSION_KEY) ?? this.lastStoreVersion;
    (this.asyncCx ?? cx)?.notify?.();
  }

  openWideDialog() {
    if (this.overlayId) return;
    const existing = shared(OVERLAY_KEY);
    if (existing) closeOverlay(existing);
    const id = openOverlay({
      mod: MOD,
      kind: "dialog",
      width: 960,
      height: 680,
      props: { role: "dialog" },
    });
    setShared(OVERLAY_KEY, id);
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  // --- Actions ------------------------------------------------------------

  syncCurrentInputsFromState() {
    this.currentReq.url = this.urlInput.value();
    this.currentReq.name = this.reqNameInput.value();
    this.currentReq.body = this.reqBodyEditor.value();
    this.currentReq.auth.token = this.authTokenInput.value();
    this.currentReq.auth.username = this.authUserInput.value();
    this.currentReq.auth.password = this.authPassInput.value();
    this.currentReq.auth.apiKeyName = this.authApiKeyNameInput.value();
    this.currentReq.auth.apiKeyValue = this.authApiKeyValInput.value();
  }

  async handleSend(clickCx) {
    if (this.sending) return;
    this.syncCurrentInputsFromState();
    if (!this.currentReq.url.trim()) {
      this.feedbackMsg = "Enter a request URL first";
      this.urlInput.focus?.();
      (clickCx ?? this.asyncCx)?.notify?.();
      return;
    }

    this.sending = true;
    this.feedbackMsg = "Sending request…";
    (clickCx ?? this.asyncCx)?.notify?.();

    const envVars = this.getActiveEnvVars();
    const res = await executeHttpRequest(this.currentReq, envVars);

    this.sending = false;
    this.lastResponse = res;
    this.resBodyEditor.set_value(
      res.error
        ? `// Request Error\n// ${res.error}`
        : res.body || `// Empty response (${res.status} ${res.statusText})`
    );

    if (res.error) {
      this.feedbackMsg = res.error;
    } else {
      this.feedbackMsg = `${res.status} ${res.statusText} · ${res.elapsedMs} ms`;
    }

    // Store REDACTED snapshot in history so credentials are never persisted in history logs.
    const historyEntry = {
      id: uid("hist"),
      timestamp: Date.now(),
      request: redactRequestForLog(JSON.parse(JSON.stringify(this.currentReq))),
      status: res.status || 0,
      statusText: res.statusText || "",
      elapsedMs: res.elapsedMs || 0,
      sizeBytes: res.sizeBytes || 0,
    };
    this.history = [historyEntry, ...this.history].slice(0, 40);

    (this.asyncCx ?? clickCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  async handleSaveRequest(clickCx) {
    this.syncCurrentInputsFromState();
    let name = (this.currentReq.name || "").trim();
    if (!name || name === "Untitled Request") {
      const cleanUrl = (this.currentReq.url || "").trim();
      const withoutOrigin = cleanUrl.replace(/^https?:\/\/[^/]+/i, "");
      name = withoutOrigin || cleanUrl || "Untitled Request";
    }

    const toSave = {
      ...JSON.parse(JSON.stringify(this.currentReq)),
      id: this.currentReq.id || uid("req"),
      name,
      project: this.currentReq.project || this.activeProject.path,
      projectName: this.currentReq.projectName || this.activeProject.name,
      updatedAt: Date.now(),
    };

    const idx = this.savedRequests.findIndex((r) => r.id === toSave.id);
    if (idx >= 0) {
      this.savedRequests = this.savedRequests.map((r, i) => (i === idx ? toSave : r));
    } else {
      this.savedRequests = [toSave, ...this.savedRequests];
    }

    this.currentReq = toSave;
    this.syncingInputs = true;
    this.reqNameInput.set_value(name);
    this.syncingInputs = false;
    this.feedbackMsg = `Saved "${name}"`;
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  handleNewRequest(clickCx) {
    const fresh = createEmptyRequest(this.activeProject.path, this.activeProject.name);
    this.loadRequestIntoForm(fresh, clickCx);
    this.lastResponse = null;
    this.resBodyEditor.set_value("// Ready for new request");
    this.feedbackMsg = "New request";
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  async handleDeleteSaved(reqId, clickCx) {
    this.savedRequests = this.savedRequests.filter((r) => r.id !== reqId);
    this.feedbackMsg = "Removed saved request";
    (clickCx ?? this.asyncCx)?.notify?.();
    await this.persistStore(this.asyncCx);
  }

  handleFormatJsonBody(clickCx) {
    const raw = this.reqBodyEditor.value();
    if (!raw.trim()) return;
    try {
      const formatted = JSON.stringify(JSON.parse(raw), null, 2);
      this.syncingInputs = true;
      this.reqBodyEditor.set_value(formatted);
      this.currentReq.body = formatted;
      this.syncingInputs = false;
      this.feedbackMsg = "Formatted JSON";
    } catch {
      this.feedbackMsg = "Invalid JSON body";
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  handleImportCurl(clickCx) {
    const raw = this.curlImportInput.value().trim();
    if (!raw) return;
    try {
      const parsed = parseCurlCommand(raw);
      const next = {
        ...createEmptyRequest(this.activeProject.path, this.activeProject.name),
        ...parsed,
        name: parsed.url.replace(/^https?:\/\/[^/]+/i, "").slice(0, 40) || "Imported cURL",
      };
      this.loadRequestIntoForm(next, clickCx);
      this.curlImportInput.set_value("");
      this.showCurlImport = false;
      this.feedbackMsg = `Imported ${next.method} request from cURL`;
    } catch (err) {
      this.feedbackMsg = err?.message || "Failed to parse cURL";
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  async handleCopyCurl(clickCx) {
    this.syncCurrentInputsFromState();
    const cmd = buildCurlCommand(this.currentReq, this.getActiveEnvVars(), { redact: false });
    const res = await copyTextToClipboard(cmd, clickCx ?? this.asyncCx);
    this.feedbackMsg = res.ok ? "Copied cURL to clipboard" : res.error || "Copy failed";
    (this.asyncCx ?? clickCx)?.notify?.();
  }

  async handleCopyResponse(clickCx) {
    if (!this.lastResponse?.body) return;
    const res = await copyTextToClipboard(this.lastResponse.body, clickCx ?? this.asyncCx);
    this.feedbackMsg = res.ok ? "Copied response body" : res.error || "Copy failed";
    (this.asyncCx ?? clickCx)?.notify?.();
  }

  async handleSendDebugToAgent(clickCx) {
    this.syncCurrentInputsFromState();
    const { selected } = resolveAvailableAgents(this.selectedAgentAddress);
    if (!selected) {
      this.feedbackMsg = "No running Agent terminal found";
      (clickCx ?? this.asyncCx)?.notify?.();
      return;
    }

    const res = await sendDebugToAgent(this.currentReq, this.lastResponse, this.getActiveEnvVars(), {
      agentAddress: selected.address,
    });
    if (res.ok) {
      this.feedbackMsg = `Sent redacted debug report to ${selected.shortLabel}`;
      safeNotify({
        title: "Sent API Debug Info to Agent",
        body: `${selected.label}: ${this.currentReq.method} ${this.currentReq.url}`,
        level: "success",
      });
    } else {
      this.feedbackMsg = res.error || "Failed to send to Agent";
    }
    (this.asyncCx ?? clickCx)?.notify?.();
  }

  cycleTargetAgent(clickCx) {
    const { candidates, selected } = resolveAvailableAgents(this.selectedAgentAddress);
    if (candidates.length === 0) {
      this.selectedAgentAddress = null;
    } else {
      const idx = selected ? candidates.findIndex((c) => c.address === selected.address) : -1;
      this.selectedAgentAddress = candidates[(idx + 1) % candidates.length].address;
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  cycleEnvironment(clickCx) {
    if (this.environments.length === 0) return;
    const idx = this.environments.findIndex((e) => e.id === this.activeEnvId);
    this.activeEnvId = this.environments[(idx + 1) % this.environments.length].id;
    (clickCx ?? this.asyncCx)?.notify?.();
    this.persistStore(this.asyncCx);
  }

  getActiveKvCollection() {
    if (this.reqTab === "params") return { kind: "params", list: this.currentReq.params };
    if (this.reqTab === "headers") return { kind: "headers", list: this.currentReq.headers };
    if (this.reqTab === "env") return { kind: "env", list: this.getActiveEnvVars() };
    return null;
  }

  startEditKvRow(row, clickCx) {
    this.editingRowId = row.id;
    this.newRowKeyInput.set_value(row.key || "");
    this.newRowValInput.set_value(row.value || "");
    (clickCx ?? this.asyncCx)?.notify?.();
    this.asyncCx?.timer?.after?.(40, () => this.newRowValInput.focus?.());
  }

  async handleSaveKvRow(clickCx) {
    const target = this.getActiveKvCollection();
    if (!target) return;
    const key = this.newRowKeyInput.value().trim();
    const value = this.newRowValInput.value();
    if (!key) return;

    const list = target.list.filter((r) => r.key || r.value);
    if (this.editingRowId) {
      const idx = list.findIndex((r) => r.id === this.editingRowId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], key, value };
      } else {
        list.push({ id: uid("kv"), key, value, enabled: true });
      }
      this.editingRowId = null;
    } else {
      list.push({ id: uid("kv"), key, value, enabled: true });
    }

    if (target.kind === "params") this.currentReq.params = list;
    else if (target.kind === "headers") this.currentReq.headers = list;
    else if (target.kind === "env") {
      const env = this.getActiveEnv();
      env.vars = list;
      await this.persistStore(this.asyncCx);
    }

    this.newRowKeyInput.set_value("");
    this.newRowValInput.set_value("");
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  async handleToggleKvRow(kind, rowId, clickCx) {
    const update = (list) => list.map((r) => (r.id === rowId ? { ...r, enabled: r.enabled === false } : r));
    if (kind === "params") this.currentReq.params = update(this.currentReq.params);
    else if (kind === "headers") this.currentReq.headers = update(this.currentReq.headers);
    else if (kind === "env") {
      const env = this.getActiveEnv();
      env.vars = update(env.vars || []);
      await this.persistStore(this.asyncCx);
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  async handleDeleteKvRow(kind, rowId, clickCx) {
    const filter = (list) => list.filter((r) => r.id !== rowId);
    if (kind === "params") this.currentReq.params = filter(this.currentReq.params);
    else if (kind === "headers") this.currentReq.headers = filter(this.currentReq.headers);
    else if (kind === "env") {
      const env = this.getActiveEnv();
      env.vars = filter(env.vars || []);
      await this.persistStore(this.asyncCx);
    }
    if (this.editingRowId === rowId) {
      this.editingRowId = null;
      this.newRowKeyInput.set_value("");
      this.newRowValInput.set_value("");
    }
    (clickCx ?? this.asyncCx)?.notify?.();
  }

  // --- Rendering ----------------------------------------------------------

  renderHeader(t, selectedAgent, candidateCount) {
    const proj = this.activeProject;
    const activeEnv = this.getActiveEnv();
    return v_flex()
      .w_full()
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .items_center()
              .gap(6)
              .child(svg(ICON_API).size(14).flex_none().text_color(t.accent ?? "#89b4fa"))
              .child(div().flex_none().text_size(13).font_bold().text_color(t.foreground).child("API Client"))
              .child(
                h_flex()
                  .min_w(0)
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .bg(withAlpha(t.accent ?? "#89b4fa", "22"))
                  .text_size(10)
                  .font_semibold()
                  .text_color(t.accent ?? "#89b4fa")
                  .items_center()
                  .child(div().max_w(110).truncate().child(proj.name))
              )
          )
          .child(
            h_flex()
              .flex_none()
              .items_center()
              .gap(4)
              .child(
                h_flex()
                  .id("api-btn-new")
                  .px(6)
                  .h(20)
                  .gap(3)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                  .on_click((_e, clickCx) => this.handleNewRequest(clickCx))
                  .child(svg(ICON_PLUS).size(10.5).flex_none())
                  .child("New")
              )
              .child(
                h_flex()
                  .id("api-btn-save")
                  .px(7)
                  .h(20)
                  .gap(3)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.foreground)
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .on_click((_e, clickCx) => this.handleSaveRequest(clickCx))
                  .child(svg(ICON_BOOKMARK).size(10.5).flex_none().text_color(t.accent ?? "#89b4fa"))
                  .child("Save")
              )
              .when(this.role === "panel", (el) =>
                el.child(
                  h_flex()
                    .id("api-btn-popup")
                    .px(6)
                    .h(20)
                    .gap(3)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.raised ?? t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .tooltip("Open wide API Client dialog (Ctrl+B r)")
                    .on_click(() => this.openWideDialog())
                    .child("Popup")
                    .child(svg(ICON_EXTERNAL).size(10).flex_none())
                )
              )
              .when(this.role === "dialog", (el) =>
                el.child(
                  div()
                    .id("api-btn-close")
                    .size(22)
                    .rounded(4)
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .bg(t.raised ?? t.surface)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .tooltip("Close (Esc)")
                    .on_click(() => this.close())
                    .child(svg(ICON_X).size(12).flex_none())
                )
              )
          )
      )
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .flex_wrap()
          .child(
            h_flex()
              .id("api-btn-cycle-agent")
              .flex_1()
              .min_w(120)
              .h(20)
              .px(6)
              .gap(5)
              .rounded(4)
              .bg(t.surface ?? t.background)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover ?? t.selected))
              .items_center()
              .tooltip("Target Agent for 'Send to Agent' (redacted)")
              .on_click((_e, clickCx) => this.cycleTargetAgent(clickCx))
              .child(
                div()
                  .size(6)
                  .rounded(3)
                  .flex_none()
                  .bg(selectedAgent ? (t.ansi2 ?? "#a6e3a1") : (t.dim ?? "#6c7086"))
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(10.5)
                  .text_color(t.foreground)
                  .child(
                    selectedAgent
                      ? `Agent: ${selectedAgent.shortLabel}${candidateCount > 1 ? ` (${candidateCount})` : ""}`
                      : "Agent: none"
                  )
              )
          )
          .child(
            h_flex()
              .flex_none()
              .gap(4)
              .items_center()
              .child(
                h_flex()
                  .id("api-btn-env-cycle")
                  .px(6)
                  .h(20)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.surface ?? t.background)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                  .tooltip("Click to switch active environment ({{var}})")
                  .on_click((_e, clickCx) => this.cycleEnvironment(clickCx))
                  .child(`Env: ${activeEnv.name}`)
              )
              .child(
                h_flex()
                  .id("api-btn-toggle-curl")
                  .px(6)
                  .h(20)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.showCurlImport ? (t.selected ?? t.hover) : (t.surface ?? t.background))
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(this.showCurlImport ? t.foreground : t.muted)
                  .hover((s) => s.bg(t.hover ?? t.selected))
                  .on_click((_e, clickCx) => {
                    this.showCurlImport = !this.showCurlImport;
                    clickCx.notify();
                  })
                  .child("cURL")
              )
              .child(
                h_flex()
                  .id("api-btn-copy-curl")
                  .px(6)
                  .h(20)
                  .gap(3)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.surface ?? t.background)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                  .on_click((_e, clickCx) => this.handleCopyCurl(clickCx))
                  .child(svg(ICON_COPY).size(10).flex_none())
                  .child("Copy cURL")
              )
          )
      );
  }

  renderUrlBar(t) {
    const mStyle = methodColors(t, this.currentReq.method);
    return v_flex()
      .w_full()
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface ?? t.background)
      .when(this.showCurlImport, (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(6)
            .items_center()
            .child(
              Input.new(this.curlImportInput)
                .flex_1()
                .min_w(0)
                .h(26)
                .px(8)
                .rounded(5)
                .border_1()
                .border_color(t.accent ?? t.border)
                .bg(t.background)
                .text_size(11)
                .text_color(t.foreground)
            )
            .child(
              h_flex()
                .id("api-curl-import-go")
                .flex_none()
                .px(8)
                .h(26)
                .rounded(5)
                .items_center()
                .cursor_pointer()
                .bg(t.accent ?? "#89b4fa")
                .text_size(11)
                .font_medium()
                .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
                .on_click((_e, clickCx) => this.handleImportCurl(clickCx))
                .child("Import")
            )
        )
      )
      .child(
        h_flex()
          .w_full()
          .gap(6)
          .items_center()
          .child(
            Input.new(this.reqNameInput)
              .flex_1()
              .min_w(0)
              .h(22)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(11)
              .text_color(t.muted)
          )
          .when(Boolean(this.feedbackMsg), (el) =>
            el.child(
              div()
                .max_w(180)
                .truncate()
                .text_size(10)
                .text_color(t.dim)
                .child(this.feedbackMsg)
            )
          )
      )
      .child(
        h_flex()
          .w_full()
          .gap(6)
          .items_center()
          .child(
            h_flex()
              .id("api-btn-method")
              .flex_none()
              .px(8)
              .h(28)
              .rounded(6)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .bg(mStyle.bg)
              .border_1()
              .border_color(mStyle.fg)
              .text_size(11)
              .font_bold()
              .text_color(mStyle.fg)
              .tooltip("Click to choose HTTP method")
              .on_click((_e, clickCx) => {
                this.showMethodPicker = !this.showMethodPicker;
                clickCx.notify();
              })
              .child(this.currentReq.method)
          )
          .child(
            Input.new(this.urlInput)
              .flex_1()
              .min_w(0)
              .h(28)
              .px(8)
              .rounded(6)
              .border_1()
              .border_color(t.input ?? t.border)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.foreground)
          )
          .child(
            h_flex()
              .id("api-btn-send")
              .flex_none()
              .px(10)
              .h(28)
              .gap(4)
              .rounded(6)
              .items_center()
              .cursor_pointer()
              .bg(t.accent ?? "#89b4fa")
              .text_size(11.5)
              .font_semibold()
              .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
              .on_click((_e, clickCx) => this.handleSend(clickCx))
              .child(svg(ICON_SEND).size(11.5).flex_none())
              .child(this.sending ? "…" : "Send")
          )
      )
      .when(this.showMethodPicker, (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(4)
            .flex_wrap()
            .children(
              METHODS.map((m) => {
                const ms = methodColors(t, m);
                const on = this.currentReq.method === m;
                return h_flex()
                  .id(`api-method-${m}`)
                  .flex_none()
                  .px(7)
                  .h(20)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(on ? ms.bg : (t.raised ?? t.background))
                  .border_1()
                  .border_color(on ? ms.fg : t.border)
                  .text_size(10)
                  .font_bold()
                  .text_color(on ? ms.fg : t.muted)
                  .on_click((_e, clickCx) => {
                    this.currentReq.method = m;
                    this.showMethodPicker = false;
                    clickCx.notify();
                  })
                  .child(m);
              })
            )
        )
      );
  }

  renderRequestTabs(t, includeLists = false) {
    const pCount = this.currentReq.params.filter((r) => r.key).length;
    const hCount = this.currentReq.headers.filter((r) => r.key).length;
    const eCount = this.getActiveEnvVars().filter((r) => r.key).length;

    const tabs = [
      { id: "body", label: "Body" },
      { id: "params", label: `Params (${pCount})` },
      { id: "headers", label: `Headers (${hCount})` },
      { id: "auth", label: "Auth" },
      { id: "env", label: `Env (${eCount})` },
    ];
    if (includeLists) {
      tabs.push({ id: "saved", label: `Saved (${this.savedRequests.length})` });
      tabs.push({ id: "history", label: `History (${this.history.length})` });
    }

    return h_flex()
      .w_full()
      .flex_none()
      .px(10)
      .py(5)
      .gap(4)
      .flex_wrap()
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .children(
        tabs.map((tab) => {
          const on = this.reqTab === tab.id;
          return h_flex()
            .id(`api-req-tab-${tab.id}`)
            .flex_none()
            .px(7)
            .h(20)
            .rounded(4)
            .items_center()
            .cursor_pointer()
            .bg(on ? (t.selected ?? t.raised) : "#00000000")
            .border_1()
            .border_color(on ? (t.input ?? t.border) : "#00000000")
            .text_size(10.5)
            .font_medium()
            .text_color(on ? t.foreground : t.muted)
            .when(!on, (el) => el.hover((s) => s.bg(t.hover ?? t.selected)))
            .on_click((_e, clickCx) => {
              this.reqTab = tab.id;
              this.editingRowId = null;
              clickCx.notify();
            })
            .child(tab.label);
        })
      );
  }

  renderKvEditor(t, kind, rows) {
    const activeRows = (rows || []).filter((r) => r && (r.key || r.value));
    const showSecretToggle = kind === "headers" || kind === "env";

    return v_flex()
      .w_full()
      .flex_none()
      .gap(6)
      .child(
        h_flex()
          .w_full()
          .gap(4)
          .items_center()
          .child(
            Input.new(this.newRowKeyInput)
              .flex_1()
              .min_w(0)
              .h(24)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.input ?? t.border)
              .bg(t.background)
              .text_size(11)
              .text_color(t.foreground)
          )
          .child(
            Input.new(this.newRowValInput)
              .flex_1()
              .min_w(0)
              .h(24)
              .px(7)
              .rounded(4)
              .border_1()
              .border_color(t.input ?? t.border)
              .bg(t.background)
              .text_size(11)
              .text_color(t.foreground)
          )
          .child(
            h_flex()
              .id(`api-kv-save-${kind}`)
              .flex_none()
              .px(8)
              .h(24)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.accent ?? "#89b4fa")
              .text_size(10.5)
              .font_medium()
              .text_color(t.accent_foreground ?? t.accentForeground ?? "#ffffff")
              .on_click((_e, clickCx) => this.handleSaveKvRow(clickCx))
              .child(this.editingRowId ? "Update" : "Add")
          )
          .when(showSecretToggle, (el) =>
            el.child(
              h_flex()
                .id(`api-kv-secrets-${kind}`)
                .flex_none()
                .px(6)
                .h(24)
                .gap(3)
                .rounded(4)
                .items_center()
                .cursor_pointer()
                .bg(this.showSecrets ? (t.selected ?? t.raised) : (t.surface ?? t.background))
                .border_1()
                .border_color(t.border)
                .text_size(10)
                .text_color(this.showSecrets ? t.foreground : t.dim)
                .tooltip(this.showSecrets ? "Hide secret values" : "Reveal secret values")
                .on_click((_e, clickCx) => {
                  this.showSecrets = !this.showSecrets;
                  clickCx.notify();
                })
                .child(svg(ICON_EYE).size(11).flex_none())
            )
          )
      )
      .when(activeRows.length === 0, (el) =>
        el.child(
          div()
            .py(10)
            .text_size(11)
            .text_color(t.dim)
            .child(`No ${kind} entries yet. Add one above.`)
        )
      )
      .children(
        activeRows.map((row) => {
          const sensitive = isSensitiveKey(row.key);
          const displayVal = sensitive && !this.showSecrets ? maskSecret(row.value) : row.value;
          const isEnabled = row.enabled !== false;
          return h_flex()
            .id(`api-kv-row-${kind}-${row.id}`)
            .w_full()
            .flex_none()
            .px(7)
            .py(4)
            .gap(6)
            .rounded(5)
            .items_center()
            .bg(t.surface ?? t.background)
            .border_1()
            .border_color(this.editingRowId === row.id ? (t.accent ?? t.border) : t.border)
            .child(
              div()
                .id(`api-kv-toggle-${kind}-${row.id}`)
                .size(14)
                .rounded(3)
                .flex_none()
                .cursor_pointer()
                .border_1()
                .border_color(isEnabled ? (t.accent ?? "#89b4fa") : t.border)
                .bg(isEnabled ? (t.accent ?? "#89b4fa") : "#00000000")
                .on_click((_e, clickCx) => this.handleToggleKvRow(kind, row.id, clickCx))
            )
            .child(
              div()
                .w(100)
                .flex_none()
                .truncate()
                .text_size(11)
                .font_medium()
                .text_color(isEnabled ? t.foreground : t.dim)
                .child(row.key)
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(sensitive && !this.showSecrets ? t.dim : t.muted)
                .cursor_pointer()
                .tooltip("Click to edit")
                .on_click((_e, clickCx) => this.startEditKvRow(row, clickCx))
                .child(displayVal || "(empty)")
            )
            .child(
              div()
                .id(`api-kv-del-${kind}-${row.id}`)
                .size(18)
                .rounded(4)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover((s) => s.bg(withAlpha(t.ansi1 ?? "#f38ba8", "22")))
                .on_click((_e, clickCx) => this.handleDeleteKvRow(kind, row.id, clickCx))
                .child(svg(ICON_TRASH).size(10.5).text_color(t.dim))
            );
        })
      );
  }

  renderAuthEditor(t) {
    const auth = this.currentReq.auth || { type: "none" };
    return v_flex()
      .w_full()
      .flex_none()
      .gap(8)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .flex_wrap()
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .flex_wrap()
              .children(
                AUTH_TYPES.map((type) => {
                  const on = auth.type === type;
                  const label =
                    type === "none"
                      ? "No Auth"
                      : type === "bearer"
                      ? "Bearer"
                      : type === "basic"
                      ? "Basic"
                      : "API Key";
                  return h_flex()
                    .id(`api-auth-type-${type}`)
                    .flex_none()
                    .px(8)
                    .h(22)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(on ? (t.accent ?? "#89b4fa") : (t.surface ?? t.background))
                    .border_1()
                    .border_color(on ? (t.accent ?? "#89b4fa") : t.border)
                    .text_size(10.5)
                    .font_medium()
                    .text_color(on ? (t.accent_foreground ?? t.accentForeground ?? "#ffffff") : t.muted)
                    .on_click((_e, clickCx) => {
                      this.currentReq.auth.type = type;
                      clickCx.notify();
                    })
                    .child(label);
                })
              )
          )
          .child(
            h_flex()
              .flex_none()
              .gap(4)
              .items_center()
              .child(
                h_flex()
                  .id("api-auth-ssl-toggle")
                  .px(7)
                  .h(22)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.surface ?? t.background)
                  .border_1()
                  .border_color(this.currentReq.verifySsl !== false ? (t.ansi2 ?? t.border) : (t.ansi3 ?? t.border))
                  .text_size(10)
                  .text_color(this.currentReq.verifySsl !== false ? (t.ansi2 ?? t.muted) : (t.ansi3 ?? t.muted))
                  .tooltip("Toggle TLS certificate verification")
                  .on_click((_e, clickCx) => {
                    this.currentReq.verifySsl = this.currentReq.verifySsl === false;
                    clickCx.notify();
                  })
                  .child(this.currentReq.verifySsl !== false ? "SSL: ON" : "SSL: OFF")
              )
              .child(
                h_flex()
                  .id("api-auth-secrets-toggle")
                  .px(7)
                  .h(22)
                  .gap(4)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.showSecrets ? (t.selected ?? t.raised) : (t.surface ?? t.background))
                  .border_1()
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(this.showSecrets ? t.foreground : t.dim)
                  .on_click((_e, clickCx) => {
                    this.showSecrets = !this.showSecrets;
                    clickCx.notify();
                  })
                  .child(svg(ICON_EYE).size(11).flex_none())
                  .child(this.showSecrets ? "Hide" : "Reveal")
              )
          )
      )
      .when(auth.type === "bearer", (el) => {
        const masked = !this.showSecrets && Boolean(auth.token);
        return el.child(
          masked
            ? div()
                .w_full()
                .p(8)
                .rounded(5)
                .bg(t.surface ?? t.background)
                .border_1()
                .border_color(t.border)
                .text_size(11)
                .text_color(t.dim)
                .child(`Bearer token hidden (${maskSecret(auth.token)}). Click Reveal to edit.`)
            : Input.new(this.authTokenInput)
                .w_full()
                .h(28)
                .px(8)
                .rounded(5)
                .border_1()
                .border_color(t.input ?? t.border)
                .bg(t.background)
                .text_size(11.5)
                .text_color(t.foreground)
        );
      })
      .when(auth.type === "basic", (el) => {
        const masked = !this.showSecrets && Boolean(auth.password);
        return el.child(
          v_flex()
            .w_full()
            .gap(6)
            .child(
              Input.new(this.authUserInput)
                .w_full()
                .h(26)
                .px(8)
                .rounded(5)
                .border_1()
                .border_color(t.input ?? t.border)
                .bg(t.background)
                .text_size(11.5)
                .text_color(t.foreground)
            )
            .child(
              masked
                ? div()
                    .w_full()
                    .p(7)
                    .rounded(5)
                    .bg(t.surface ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(`Password hidden (${maskSecret(auth.password)}). Click Reveal to edit.`)
                : Input.new(this.authPassInput)
                    .w_full()
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .border_1()
                    .border_color(t.input ?? t.border)
                    .bg(t.background)
                    .text_size(11.5)
                    .text_color(t.foreground)
            )
        );
      })
      .when(auth.type === "apikey", (el) => {
        const masked = !this.showSecrets && Boolean(auth.apiKeyValue);
        return el.child(
          v_flex()
            .w_full()
            .gap(6)
            .child(
              h_flex()
                .w_full()
                .gap(6)
                .child(
                  Input.new(this.authApiKeyNameInput)
                    .flex_1()
                    .min_w(0)
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .border_1()
                    .border_color(t.input ?? t.border)
                    .bg(t.background)
                    .text_size(11.5)
                    .text_color(t.foreground)
                )
                .child(
                  h_flex()
                    .id("api-auth-key-in")
                    .flex_none()
                    .px(8)
                    .h(26)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.surface ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(t.foreground)
                    .on_click((_e, clickCx) => {
                      this.currentReq.auth.apiKeyIn =
                        this.currentReq.auth.apiKeyIn === "query" ? "header" : "query";
                      clickCx.notify();
                    })
                    .child(`In: ${auth.apiKeyIn === "query" ? "Query" : "Header"}`)
                )
            )
            .child(
              masked
                ? div()
                    .w_full()
                    .p(7)
                    .rounded(5)
                    .bg(t.surface ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(`API Key hidden (${maskSecret(auth.apiKeyValue)}). Click Reveal to edit.`)
                : Input.new(this.authApiKeyValInput)
                    .w_full()
                    .h(26)
                    .px(8)
                    .rounded(5)
                    .border_1()
                    .border_color(t.input ?? t.border)
                    .bg(t.background)
                    .text_size(11.5)
                    .text_color(t.foreground)
            )
        );
      })
      .when(auth.type === "none", (el) =>
        el.child(
          div()
            .p(8)
            .text_size(11)
            .text_color(t.dim)
            .child("No authentication headers configured. Tip: use {{token}} with Env variables so secrets stay isolated.")
        )
      );
  }

  renderSavedList(t) {
    const items =
      this.scopeSaved === "all" || this.activeProject.isGlobal
        ? this.savedRequests
        : this.savedRequests.filter(
            (r) => !r.project || r.project === GLOBAL_PROJECT || r.project === this.activeProject.path
          );

    return v_flex()
      .w_full()
      .flex_none()
      .gap(6)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .child(div().text_size(10.5).font_semibold().text_color(t.muted).child("SAVED REQUESTS"))
          .child(
            h_flex()
              .id("api-scope-toggle")
              .px(6)
              .h(18)
              .rounded(4)
              .items_center()
              .cursor_pointer()
              .bg(t.surface ?? t.background)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.dim)
              .on_click((_e, clickCx) => {
                this.scopeSaved = this.scopeSaved === "project" ? "all" : "project";
                clickCx.notify();
              })
              .child(this.scopeSaved === "project" ? "Project" : "All")
          )
      )
      .when(items.length === 0, (el) =>
        el.child(
          div()
            .py(10)
            .text_size(11)
            .text_color(t.dim)
            .child("No saved requests yet. Click Save in header to bookmark one.")
        )
      )
      .children(
        items.map((item) => {
          const ms = methodColors(t, item.method);
          const active = this.currentReq.id === item.id;
          return h_flex()
            .id(`api-saved-${item.id}`)
            .w_full()
            .flex_none()
            .p(6)
            .gap(6)
            .rounded(6)
            .items_center()
            .cursor_pointer()
            .bg(active ? (t.selected ?? t.raised) : (t.surface ?? t.background))
            .border_1()
            .border_color(active ? (t.accent ?? t.border) : t.border)
            .hover((s) => s.bg(t.hover ?? t.selected))
            .on_click((_e, clickCx) => this.loadRequestIntoForm(item, clickCx))
            .child(
              div()
                .flex_none()
                .px(4)
                .h(16)
                .rounded(3)
                .bg(ms.bg)
                .text_size(9)
                .font_bold()
                .text_color(ms.fg)
                .flex()
                .items_center()
                .child(item.method)
            )
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().w_full().truncate().text_size(11.5).font_medium().text_color(t.foreground).child(item.name || "Untitled"))
                .child(div().w_full().truncate().text_size(10).text_color(t.dim).child(item.url || ""))
            )
            .child(
              div()
                .id(`api-saved-del-${item.id}`)
                .size(18)
                .rounded(4)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .hover((s) => s.bg(withAlpha(t.ansi1 ?? "#f38ba8", "22")))
                .on_click((_e, clickCx) => {
                  clickCx.stop_propagation?.();
                  this.handleDeleteSaved(item.id, clickCx);
                })
                .child(svg(ICON_TRASH).size(10.5).text_color(t.dim))
            );
        })
      );
  }

  renderHistoryList(t) {
    return v_flex()
      .w_full()
      .flex_none()
      .gap(5)
      .when(this.history.length === 0, (el) =>
        el.child(div().py(10).text_size(11).text_color(t.dim).child("No requests sent yet."))
      )
      .children(
        this.history.map((h) => {
          const req = h.request || {};
          const ms = methodColors(t, req.method);
          const sc = h.status ? statusColors(t, h.status) : null;
          return h_flex()
            .id(`api-hist-${h.id}`)
            .w_full()
            .flex_none()
            .p(6)
            .gap(6)
            .rounded(6)
            .items_center()
            .cursor_pointer()
            .bg(t.surface ?? t.background)
            .border_1()
            .border_color(t.border)
            .hover((s) => s.bg(t.hover ?? t.selected))
            .on_click((_e, clickCx) => this.loadRequestIntoForm(req, clickCx))
            .child(
              div()
                .flex_none()
                .px(4)
                .h(16)
                .rounded(3)
                .bg(ms.bg)
                .text_size(9)
                .font_bold()
                .text_color(ms.fg)
                .flex()
                .items_center()
                .child(req.method || "GET")
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.foreground)
                .child(req.url || "")
            )
            .when(Boolean(sc), (el) =>
              el.child(
                div()
                  .flex_none()
                  .px(4)
                  .h(15)
                  .rounded(3)
                  .bg(sc.bg)
                  .text_size(9.5)
                  .font_bold()
                  .text_color(sc.fg)
                  .flex()
                  .items_center()
                  .child(String(h.status))
              )
            );
        })
      );
  }

  renderRequestContent(t, isDialog = false) {
    if (this.reqTab === "body") {
      return v_flex()
        .w_full()
        .flex_none()
        .gap(6)
        .child(
          h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .child(div().text_size(10.5).text_color(t.dim).child("JSON / Raw Request Body (supports {{var}})"))
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(
                  h_flex()
                    .id("api-body-format")
                    .px(7)
                    .h(20)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.surface ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .on_click((_e, clickCx) => this.handleFormatJsonBody(clickCx))
                    .child("Format JSON")
                )
                .child(
                  h_flex()
                    .id("api-body-clear")
                    .px(7)
                    .h(20)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.surface ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.dim)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .on_click((_e, clickCx) => {
                      this.syncingInputs = true;
                      this.reqBodyEditor.set_value("");
                      this.currentReq.body = "";
                      this.syncingInputs = false;
                      clickCx.notify();
                    })
                    .child("Clear")
                )
            )
        )
        .child(
          div()
            .id("api-req-body-editor-wrap")
            .w_full()
            .h(isDialog ? 170 : 156)
            .flex_none()
            .rounded(6)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .overflow_hidden()
            .child(Editor.new(this.reqBodyEditor).size_full())
        );
    }

    if (this.reqTab === "params") return this.renderKvEditor(t, "params", this.currentReq.params);
    if (this.reqTab === "headers") return this.renderKvEditor(t, "headers", this.currentReq.headers);
    if (this.reqTab === "auth") return this.renderAuthEditor(t);
    if (this.reqTab === "env") return this.renderKvEditor(t, "env", this.getActiveEnvVars());
    if (this.reqTab === "saved") return this.renderSavedList(t);
    if (this.reqTab === "history") return this.renderHistoryList(t);
    return null;
  }

  renderResponsePane(t, isDialog = false) {
    const res = this.lastResponse;
    const sc = res && res.status > 0 ? statusColors(t, res.status) : null;
    const headerEntries = Object.entries(res?.headers || {});

    return v_flex()
      .id("api-res-pane")
      .flex_1()
      .min_h(isDialog ? 180 : 140)
      .min_w(0)
      .w_full()
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .flex_none()
          .px(10)
          .py(6)
          .gap(6)
          .items_center()
          .justify_between()
          .flex_wrap()
          .bg(t.surface ?? t.background)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_wrap()
              .child(div().text_size(11).font_bold().text_color(t.foreground).child("Response"))
              .when(Boolean(sc), (el) =>
                el.child(
                  div()
                    .px(6)
                    .h(18)
                    .rounded(4)
                    .bg(sc.bg)
                    .text_size(10)
                    .font_bold()
                    .text_color(sc.fg)
                    .flex()
                    .items_center()
                    .child(`${res.status} ${res.statusText || ""}`.trim())
                )
              )
              .when(Boolean(res?.error), (el) =>
                el.child(
                  div()
                    .px(6)
                    .h(18)
                    .rounded(4)
                    .bg(withAlpha(t.ansi1 ?? "#f38ba8", "26"))
                    .text_size(10)
                    .font_bold()
                    .text_color(t.ansi1 ?? "#f38ba8")
                    .flex()
                    .items_center()
                    .child("Error")
                )
              )
              .when(Boolean(res), (el) =>
                el.child(
                  div()
                    .text_size(10)
                    .text_color(t.dim)
                    .child(`${res.elapsedMs ?? 0} ms · ${formatBytes(res.sizeBytes)}`)
                )
              )
              .child(
                h_flex()
                  .id("api-res-tab-body")
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.resTab === "body" ? (t.selected ?? t.raised) : "#00000000")
                  .text_size(10)
                  .text_color(this.resTab === "body" ? t.foreground : t.muted)
                  .on_click((_e, clickCx) => {
                    this.resTab = "body";
                    clickCx.notify();
                  })
                  .child("Body")
              )
              .child(
                h_flex()
                  .id("api-res-tab-headers")
                  .px(6)
                  .h(18)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.resTab === "headers" ? (t.selected ?? t.raised) : "#00000000")
                  .text_size(10)
                  .text_color(this.resTab === "headers" ? t.foreground : t.muted)
                  .on_click((_e, clickCx) => {
                    this.resTab = "headers";
                    clickCx.notify();
                  })
                  .child(`Headers (${headerEntries.length})`)
              )
          )
          .child(
            h_flex()
              .flex_none()
              .gap(4)
              .items_center()
              .when(Boolean(res?.body), (el) =>
                el.child(
                  h_flex()
                    .id("api-res-copy")
                    .px(6)
                    .h(20)
                    .gap(3)
                    .rounded(4)
                    .items_center()
                    .cursor_pointer()
                    .bg(t.raised ?? t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover ?? t.selected).text_color(t.foreground))
                    .on_click((_e, clickCx) => this.handleCopyResponse(clickCx))
                    .child(svg(ICON_COPY).size(10).flex_none())
                    .child("Copy")
                )
              )
              .child(
                h_flex()
                  .id("api-btn-send-agent")
                  .px(7)
                  .h(20)
                  .gap(4)
                  .rounded(4)
                  .items_center()
                  .cursor_pointer()
                  .bg(t.raised ?? t.background)
                  .border_1()
                  .border_color(t.accent ?? t.border)
                  .text_size(10)
                  .font_medium()
                  .text_color(t.accent ?? t.foreground)
                  .tooltip("Send redacted request & response summary to target Agent")
                  .on_click((_e, clickCx) => this.handleSendDebugToAgent(clickCx))
                  .child(svg(ICON_SEND).size(10).flex_none())
                  .child("Send to Agent")
              )
          )
      )
      .child(
        this.resTab === "body"
          ? div()
              .id("api-res-body-editor-wrap")
              .flex_1()
              .min_h(0)
              .min_w(0)
              .w_full()
              .p(8)
              .overflow_hidden()
              .child(
                div()
                  .size_full()
                  .rounded(6)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .overflow_hidden()
                  .child(Editor.new(this.resBodyEditor).size_full())
              )
          : v_flex()
              .id("api-res-headers-scroll")
              .flex_1()
              .min_h(0)
              .min_w(0)
              .w_full()
              .overflow_y_scrollbar()
              .p(10)
              .gap(4)
              .when(headerEntries.length === 0, (el) =>
                el.child(div().text_size(11).text_color(t.dim).child("No response headers yet."))
              )
              .children(
                headerEntries.map(([k, v]) =>
                  h_flex()
                    .w_full()
                    .flex_none()
                    .gap(8)
                    .py(3)
                    .px(6)
                    .rounded(4)
                    .bg(t.surface ?? t.background)
                    .child(div().w(140).flex_none().truncate().text_size(11).font_medium().text_color(t.foreground).child(k))
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .text_size(11)
                        .text_color(t.muted)
                        .child(isSensitiveKey(k) && !this.showSecrets ? redactHeaderValue(k, v) : String(v))
                    )
                )
              )
      );
  }

  renderDialogSidebar(t) {
    const sideTabs = [
      { id: "saved", label: `Saved (${this.savedRequests.length})` },
      { id: "history", label: `History (${this.history.length})` },
      { id: "env", label: "Env" },
    ];

    return v_flex()
      .w(270)
      .flex_none()
      .h_full()
      .min_h(0)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .flex_none()
          .px(8)
          .py(6)
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .children(
            sideTabs.map((st) => {
              const on = this.sidebarTab === st.id;
              return h_flex()
                .id(`api-side-tab-${st.id}`)
                .flex_1()
                .h(22)
                .rounded(4)
                .items_center()
                .justify_center()
                .cursor_pointer()
                .bg(on ? (t.selected ?? t.raised) : "#00000000")
                .text_size(10.5)
                .font_medium()
                .text_color(on ? t.foreground : t.muted)
                .on_click((_e, clickCx) => {
                  this.sidebarTab = st.id;
                  clickCx.notify();
                })
                .child(st.label);
            })
          )
      )
      .child(
        v_flex()
          .id("api-sidebar-scroll")
          .flex_1()
          .min_h(0)
          .min_w(0)
          .w_full()
          .overflow_y_scrollbar()
          .p(8)
          .gap(6)
          .when(this.sidebarTab === "saved", (el) => el.child(this.renderSavedList(t)))
          .when(this.sidebarTab === "history", (el) => el.child(this.renderHistoryList(t)))
          .when(this.sidebarTab === "env", (el) =>
            el.child(
              v_flex()
                .w_full()
                .flex_none()
                .gap(8)
                .child(div().text_size(10.5).font_semibold().text_color(t.muted).child("ENVIRONMENTS"))
                .children(
                  this.environments.map((env) => {
                    const active = env.id === this.activeEnvId;
                    return h_flex()
                      .id(`api-side-env-${env.id}`)
                      .w_full()
                      .flex_none()
                      .p(7)
                      .rounded(6)
                      .items_center()
                      .justify_between()
                      .cursor_pointer()
                      .bg(active ? (t.selected ?? t.raised) : (t.surface ?? t.background))
                      .border_1()
                      .border_color(active ? (t.accent ?? t.border) : t.border)
                      .on_click((_e, clickCx) => {
                        this.activeEnvId = env.id;
                        this.reqTab = "env";
                        clickCx.notify();
                        this.persistStore(this.asyncCx);
                      })
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(env.name))
                      .child(
                        div()
                          .text_size(10)
                          .text_color(t.dim)
                          .child(`${(env.vars || []).filter((v) => v.key).length} vars`)
                      );
                  })
                )
            )
          )
      );
  }

  render() {
    const t = theme();
    const { candidates, selected: selectedAgent } = resolveAvailableAgents(this.selectedAgentAddress);

    if (this.role === "dialog") {
      return v_flex()
        .id("api-dialog-root")
        .track_focus(this.handle)
        .on_key_down((e, keyCx) => {
          if (e.key === "escape") {
            this.close();
            keyCx.stop_propagation();
          }
        })
        .size_full()
        .bg(t.popover ?? t.background)
        .rounded(14)
        .border_1()
        .border_color(t.border)
        .shadow_lg()
        .text_color(t.foreground)
        .overflow_hidden()
        .child(this.renderHeader(t, selectedAgent, candidates.length))
        .child(
          h_flex()
            .flex_1()
            .min_h(0)
            .min_w(0)
            .w_full()
            .child(this.renderDialogSidebar(t))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .min_h(0)
                .h_full()
                .child(this.renderUrlBar(t))
                .child(this.renderRequestTabs(t, false))
                .child(
                  v_flex()
                    .id("api-dialog-req-scroll")
                    .w_full()
                    .h(220)
                    .flex_none()
                    .min_w(0)
                    .overflow_y_scrollbar()
                    .p(10)
                    .gap(8)
                    .child(this.renderRequestContent(t, true))
                )
                .child(this.renderResponsePane(t, true))
            )
        );
    }

    // Right-side panel mode
    return v_flex()
      .id("api-panel-root")
      .track_focus(this.handle)
      .size_full()
      .min_w(0)
      .min_h(0)
      .text_color(t.foreground)
      .overflow_hidden()
      .child(this.renderHeader(t, selectedAgent, candidates.length))
      .child(this.renderUrlBar(t))
      .child(this.renderRequestTabs(t, true))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .min_w(0)
          .w_full()
          .child(
            v_flex()
              .id("api-panel-req-scroll")
              .w_full()
              .h(210)
              .flex_none()
              .min_w(0)
              .overflow_y_scrollbar()
              .p(10)
              .gap(8)
              .child(this.renderRequestContent(t, false))
          )
          .child(this.renderResponsePane(t, false))
      );
  }
}
