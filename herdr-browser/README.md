# Herdr Agent Browser Hub

為 Herdr 打造的受控瀏覽器中心與多 Agent 隔離協作系統（支援 Microsoft Edge / Chromium）。

---

## 功能特點

1. **左側邊欄導航 + 中間主視圖切換**：
   - 左側側邊欄整合 `Agent Browser` 小卡片，即時列出各 Agent（Claude Code、Codex、Antigravity）當前正在操作的網頁與標題。
   - 點擊卡片，中間主面板立即透過 `layout.select` 平滑切換為高解析度全螢幕瀏覽器畫布；點擊終端機隨時切回。

2. **零桌面亂彈視窗（Zero Rogue Windows）**：
   - 以受控模式 (`--headless=new`) 啟動單一 Microsoft Edge 核心處理程序。
   - 所有網頁畫面均透過原生 CDP Screencast 串流到 Herdr 內部，絕不在使用者的 macOS 桌面上彈出任何視窗或搶走視窗焦點。

3. **多 Agent 暫態無痕隔離（BrowserContext Isolation）**：
   - 每個 Agent 連線時獲派獨立的無痕 `BrowserContext`，Cookie、LocalStorage 與分頁互相完全隔離，不污染日常個人 Edge Profile。
   - 強制單例 Page 限制，防止 AI 在重試迴圈中開出一堆無效分頁。

4. **人機雙向協作（Human-in-the-Loop）**：
   - 頂部導航列提供 URL 顯示、上一頁/下一頁、重新整理與 Agent 切換分頁。
   - 支援「AI Driving」與「Human Takeover」一鍵切換，遇 CAPTCHA 或登入驗證時可直接接管點擊。

---

## 快速安裝

在一般終端機或 Herdr shell 中執行：

```bash
python3 herdr-browser/install.py
```

這會自動完成：
- 檢查並安裝 `agent-browser-sidebar` 與 `agent-browser-main` 兩個 Herdr Mod。
- 更新版面配置（在側邊欄加入 Browser 小部件，並將主工作區包裝為 Stack 支援即時切換）。
- 自動為 Claude Code 配置 `herdr-browser` MCP 服務（`~/.claude.json`）。

---

## 啟動守護程序（Daemon）

在背景終端機中啟動 Browser Hub Daemon：

```bash
node herdr-browser/daemon/server.mjs
```

---

## 測試與驗證

執行單元測試：

```bash
node --test herdr-browser/tests/*.test.mjs
```

執行 Herdr 原生模組檢查：

```bash
herdr-app check herdr-browser/mods/agent-browser-sidebar
herdr-app check herdr-browser/mods/agent-browser-main
```
