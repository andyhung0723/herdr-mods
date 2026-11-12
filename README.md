# Herdr Mods (`herdr-mods`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)]()
[![Herdr](https://img.shields.io/badge/Designed%20for-Herdr%20App-purple.svg)]()
[![Tests](https://img.shields.io/badge/Tests-All%20Passing-brightgreen.svg)]()

為 [Herdr](https://herdr.dev/) 桌面版打造的專業級模組套裝（Monorepo of Custom Mods）。  
整合了 **AI Agent 治理、Git 與 GitHub Hub、服務與連接埠監控、快速筆記、即時音樂與客製化 UI 增強**，將 Herdr 打造為全方位的 AI 開發作戰駕駛艙（Cockpit）。

---

## 🌟 模組套件一覽 (Mods Catalog)

整個儲存庫共收錄 **18 個高品質原生 Mods**，依功能劃分為四大領域：

### 🤖 1. AI Agent 治理與監控 (Agentic Workflow)

| Mod 目錄 | 模組名稱 | 觸發方式 / 位置 | 說明 |
| :--- | :--- | :--- | :--- |
| [`herdr-quotas`](./herdr-quotas) | `agent-quotas` | 狀態列儀表 / 點擊開啟面板 | 即時監控 **Claude Code** (5h/週/額度)、**OpenAI Codex** (Token/週配額) 與 **Google Antigravity** (Gemini 5h/週模型池) 的剩餘額度。 |
| [`herdr-agent-context`](./herdr-agent-context) | `enhanced-agent-context` | 右側面板 `Agent` 按鈕 | **Agent Inspector**：即時解析目前焦點 Agent 的 Rules (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)、Skills、MCP Connectors 與運行環境。 |
| [`herdr-agents`](./herdr-agents) | `agents` | 側邊欄面板 | **Subagent 活躍追蹤**：即時統計每位 Agent 底下子代理人的運作狀態徽章（如 `⚡ 2/3`）。 |
| [`herdr-loadout`](./herdr-loadout) | `loadout` | `Ctrl+B L` | **Agent Loadout 矩陣**：對接 `agent-loadout` CLI，視覺化切換不同 Agent 帳號的 Skills、Hooks、MCP 與 Plugins 開關。 |

---

### 🛠️ 2. 開發者工具與版本控制 (Developer Tools & Git)

| Mod 目錄 | 模組名稱 | 觸發方式 / 位置 | 說明 |
| :--- | :--- | :--- | :--- |
| [`herdr-git`](./herdr-git) | `enhanced-git` | `Ctrl+B G` / 右側 `Git` | 互動式 **Git Graph**、分支切換、暫存/未暫存差異對照、一鍵 Commit & Sync，支援巢狀與父子 Repo 自動解析。 |
| [`herdr-github`](./herdr-github) | `github-hub` | Git 面板切換 `GitHub` | **GitHub Hub**：整合 Pull Requests、Actions CI 與 Issues，支援檢視 CI 失敗紀錄與 PR Diff，一鍵指派 Agent 除錯。 |
| [`herdr-services`](./herdr-services) | `services-inspector` | `Ctrl+B Shift+E` / 右側 `Services` | 掃描本機 Listening Ports、Dev Servers 與 Docker 容器，支援一鍵釋放卡死的 Port 與容器重啟。 |
| [`herdr-spectra`](./herdr-spectra) | `spectra-status` | 右側 `Spectra` 按鈕 | **Spectra SDD 面板**：整合規格驅動開發（SDD / OpenSpec），即時檢視規格檔案與任務 Checklist 進度。 |

---

### 📝 3. 生產力浮層與輔助 (Productivity & Overlays)

| Mod 目錄 | 模組名稱 | 觸發方式 / 位置 | 說明 |
| :--- | :--- | :--- | :--- |
| [`herdr-scratchpad`](./herdr-scratchpad) | `scratchpad` | `Ctrl+B S` | 多分頁臨時筆記本，支援毫秒級同步持久化、一鍵複製全部內容。 |
| [`herdr-markdown`](./herdr-markdown) | `markdown-preview` | `Ctrl+B M` | 原生雙欄 Markdown 即時預覽（左側檔案樹 + 右側渲染），支援文件相對導航與超連結。 |
| [`herdr-popup`](./herdr-popup) | `popup-terminal` | `Ctrl+B T` | 零高度 Controller 的全域彈出終端機，隨時呼叫與收起。 |
| [`herdr-help`](./herdr-help) | `enhanced-help` | `Ctrl+B H` | 將自訂 Mods 獨立歸類至頂部專屬區塊的增強型快捷鍵速查說明表。 |

---

### 🎨 4. 介面美化與視窗增強 (UI & Aesthetics)

| Mod 目錄 | 模組名稱 | 觸發方式 / 位置 | 說明 |
| :--- | :--- | :--- | :--- |
| [`herdr-chrome`](./herdr-chrome) | `enhanced-workspace-chrome` | 頂部 Chrome 列 | 動態即時時間與日期、點擊複製時間戳記、附帶可愛走動與搖尾巴的柯基犬動畫。 |
| [`herdr-files`](./herdr-files) | `enhanced-files` | 左側檔案樹 | 新增 VS Code 等級右鍵選單（新建檔案/資料夾、重新命名、重複、刪除、複製路徑、在 Path Finder 中開啟）。 |
| [`herdr-tabs`](./herdr-tabs) | `enhanced-tabs` | 頂部分頁列 | 整合 Git、Agent、Spectra、Services 等右側獨立面板快速開關切換按鈕。 |
| [`herdr-status`](./herdr-status) | `workspace-status` | 右下角狀態列 | 透過 macOS `MediaRemote` 即時同步 YouTube Music（PWA / 瀏覽器）當前播放歌曲與播放/暫停控制。 |
| [`herdr-spaces`](./herdr-spaces) | `enhanced-spaces` | Space 切換區 | 增強版工作空間圖示與 Spaces 切換指示。 |
| [`herdr-wallpaper`](./herdr-wallpaper) | `wallpaper-carousel` | 背景 | 自動桌布輪播器，包含 32 幀無縫循環的平滑駭客任務代碼雨（Matrix Rain）。 |

---

## ⌨️ 預設快捷鍵速查 (Default Keybindings)

安裝各 Mod 後，Herdr 會自動寫入 `~/.config/herdr-app/keys.json`：

| 快捷鍵 | 動作 | 對應 Mod |
| :--- | :--- | :--- |
| `Ctrl+B G` | 開啟全螢幕 Git Graph 與版本管理 | `enhanced-git` |
| `Ctrl+B S` | 開啟多分頁暫存筆記本 (Scratchpad) | `scratchpad` |
| `Ctrl+B M` | 開啟雙欄 Markdown 原生預覽視窗 | `markdown-preview` |
| `Ctrl+B T` | 開啟 / 收起浮層終端機 (Popup Terminal) | `popup-terminal` |
| `Ctrl+B L` | 開啟 Agent Loadout 資源帳號矩陣 | `loadout` |
| `Ctrl+B Shift+E` | 開啟本機服務與容器檢視面板 (Services) | `services-inspector` |
| `Ctrl+B H` | 開啟增強版快捷鍵速查說明彈窗 | `enhanced-help` |

---

## 📦 安裝說明 (Installation)

各 Mod 資料夾內均附帶獨立的安裝腳本 `install.py`，安裝時會自動執行以下流程：
1. 執行 `herdr-app check` 驗證 Mod 代碼結構與 GPUIKit 規範。
2. 自動備份既有的 `keys.json` 與 layout 設定檔至 `~/.config/herdr-app/backups/`。
3. 若快捷鍵已被佔用會主動提示並中止，保證不覆蓋您原有的按鍵設定。
4. 將模組複製至 `~/.config/herdr-app/mods/<mod-name>`。

### 安裝特定 Mod
例如安裝 `agent-quotas` 額度監控或 `enhanced-git`：

```bash
# 預覽安裝計畫（Dry-run，不寫入任何檔案）
python3 herdr-quotas/install.py --dry-run

# 正式安裝
python3 herdr-quotas/install.py
python3 herdr-git/install.py
```

### 批次安裝全部 Mods
若要一次安裝所有功能：

```bash
for d in herdr-*; do
  if [ -f "$d/install.py" ]; then
    echo "Installing $d..."
    python3 "$d/install.py"
  fi
done
```

> **提示**：安裝完成後，重新啟動 Herdr 桌面應用程式或在命令列執行 `herdr-app do app.reload` 即可生效。

---

## 🧪 測試套件 (Testing)

每個 Mod 均包含針對 GPUIKit 元件、生命週期與狀態機的完整單元測試。

```bash
# 測試特定 Mod
cd herdr-git && node --experimental-vm-modules --test tests/git.test.mjs

# 執行所有模組的單元測試
for d in herdr-*; do
  if [ -d "$d/tests" ]; then
    echo "=== Testing $d ==="
    (cd "$d" && node --experimental-vm-modules --test tests/*.test.mjs 2>/dev/null || true)
  fi
done
```

---

## 🏗️ 模組架構 (Architecture)

```text
herdr-mods/
├── herdr-<mod-name>/
│   ├── mods/<mod-name>/       # Mod 實際程式碼（將安裝至 ~/.config/herdr-app/mods/）
│   │   ├── mod.json           # Herdr Mod 宣告檔（place, role, version）
│   │   ├── main.js            # GPUIKit 介面元件與邏輯
│   │   ├── gpui-kit.d.ts      # TypeScript 宣告支援
│   │   └── *.svg              # 模組圖示與資產
│   ├── install.py             # 安全安裝器（相依檢查、衝突預防、自動備份）
│   └── tests/                 # 單元測試套件
├── icons/                     # 供 Herdr 顯示用的高解析向量圖示
├── programs.json              # Herdr Agent 終端圖示關聯配置
└── LICENSE                    # MIT 授權條款
```

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 授權。
