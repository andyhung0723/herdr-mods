# Herdr Agent Browser Hub

> **已封存（2026-11-13）**：不再安裝或維護。在 Herdr pane 裡看 screencast 畫面不夠精準，無法拿來做前端驗收或 RWD；這類需求改用 Playwright Test（device projects、`toHaveScreenshot`、HTML report / trace viewer）、Playwright MCP 與 chrome-devtools-mcp。程式碼保留作參考，`install.py` 仍可用。

為 Herdr 打造的受控瀏覽器中心：每個 Agent pane 擁有自己隔離的 headless Edge 分頁，畫面串回 Herdr，必要時人可以接手操作。

---

## 功能特點

1. **每個 Agent pane 一個隔離 session**
   - Session id = `<vendor>-<terminal>`，例如 `claude-t25`、`codex-t1x`。vendor 取自 MCP client 的 `clientInfo.name`（或 `--agent=`），terminal 取自 Herdr 注入的 `HC_TERMINAL_ID`。
   - 每個 session 是獨立的 `BrowserContext`，Cookie 與 Storage 互不相通，也不碰日常 Edge profile。
   - Herdr terminal 結束後 60 秒內自動關閉對應 session；閒置 30 分鐘的 session 也會回收。

2. **給 Agent 用的工具（MCP）**
   - `browser_snapshot` 回傳精簡的 accessibility tree，互動元素帶 `[ref=eN]`；`browser_click` / `browser_type` 直接吃 ref。
   - 點擊、輸入、按鍵都是真實的 CDP input event（`isTrusted: true`），React/Vue 受控元件也能正確收到。
   - `browser_navigate` 會等待 load，網路錯誤（例如 `ERR_CONNECTION_REFUSED`）會回報成錯誤。
   - 同一 session 的動作依序執行，即使 agent 平行呼叫工具也不會亂序。

3. **Herdr UI**
   - 側邊欄 `Agent Browser` 卡片列出所有 session（`Claude · Space / Tab`），焦點 agent 會加框；點擊後主面板切到瀏覽器畫面。
   - 主畫面保持長寬比顯示即時畫面，提供上一頁、下一頁、重新整理與 session 切換。
   - 只在主畫面可見時才 screencast，畫面不在時不消耗 CPU。

4. **Human Takeover**
   - 點「AI Driving」切成「You're driving」後，滑鼠點擊、滾輪、鍵盤都會轉送到頁面（`cmd-` 快捷鍵保留給 Herdr）。
   - 接手期間 agent 的操作會被拒絕，並收到「人類接手中」的錯誤訊息，切回後恢復。

---

## 安裝

需要 `herdr-app`、Node 22+、Microsoft Edge（或 Chrome）。請在主 checkout 執行（MCP 註冊會寫入 installer 所在的絕對路徑）：

```bash
python3 herdr-browser/install.py --dry-run   # 先看會改什麼
python3 herdr-browser/install.py
```

這會：
- 複製 `agent-browser-sidebar` 與 `agent-browser-main` 兩個 mod，並更新 layout（側邊欄卡片 + `work-main-stack`）。
- 有 agent-loadout（`loadout` CLI）時，把 `mcp:herdr-browser` 加進 loadout manifest 並 `loadout apply --only mcp:herdr-browser`（Claude 與 Codex 的所有 target）。Codex 需要的 `env_vars = ["HC_TERMINAL_ID"]` 會一併寫入。
- 沒有 loadout 時，印出手動註冊指令。`--skip-mcp` 可跳過這一步。

安裝後重開 Claude Code / Codex session 讓 MCP 生效。

---

## Daemon

Agent 第一次呼叫 `browser_*` 工具時，若 daemon 沒在跑會自動在背景啟動（log：`~/.config/herdr-browser/daemon.log`）。也可以手動啟動：

```bash
node herdr-browser/daemon/server.mjs
kill "$(cat ~/.config/herdr-browser/daemon.pid)"   # 停止（同時關閉 headless Edge）
```

`daemon.log` 超過 5 MiB 時，下次自動啟動會輪替成 `daemon.log.1`。

### 安全模型

- Daemon 只綁 `127.0.0.1:9223`，不回 CORS header，並檢查 `Host`（防 DNS rebinding）。
- 除了 `/health`，所有 endpoint 都需要 `Authorization: Bearer <token>`；token 在 `~/.config/herdr-browser/token`（0600），daemon 首次啟動時產生。
- `navigate` 只允許 `http:`、`https:`、`about:`、`data:`，擋掉 `file:`、`edge:`、`chrome:` 等。
- Edge 使用 `--remote-debugging-port=0`，profile 放在 `~/.config/herdr-browser/edge-profile`，實際 port 從 `DevToolsActivePort` 讀取；不會接上其他佔用 9222 的瀏覽器。
- 「誰在操控」（agent / human）是協調用的鎖，不是安全邊界：兩種 client 都持有同一個 token。

### 架構

```
Claude Code / Codex ──stdio──▶ mcp-server.mjs ──HTTP+token──▶ server.mjs ──CDP──▶ headless Edge
                                                                  ▲                 (1 BrowserContext / agent pane)
Herdr mods (sidebar, main) ──────────HTTP+token───────────────────┘
   main view: GET /frame?after=seq → 寫入 ~/.config/herdr-app/cache/agent-browser/f-*.jpg → image()
```

Herdr 的 `image()` 只能讀 app home 底下的相對路徑，而且以路徑做 cache，所以每張 frame 用新檔名寫入，只保留最近 3 張。

---

## 測試與驗證

需要 Edge/Chrome 的測試在找不到瀏覽器時會自動 skip；每個測試用隨機 port 與暫存 state dir，不會碰到正在跑的 daemon。

```bash
node --test herdr-browser/tests/*.test.mjs
herdr-app check herdr-browser/mods/agent-browser-sidebar
herdr-app check herdr-browser/mods/agent-browser-main
```
