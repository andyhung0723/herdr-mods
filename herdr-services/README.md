# Herdr Services Inspector

把本機開發服務（Listening Ports & Dev Servers）與容器（Docker / OrbStack Containers）整合進 Herdr 右側獨立面板，支援即時監控、一鍵釋放卡死 Port 與容器生命週期控制。

## 功能

1. **右上角按鈕 + 右側獨立面板（Right-Side Panel）**
   - 點擊右上角 Tab Bar 的 **`Services`**（`[ ⚡ Services ]`）按鈕即可開關右側面板。
   - **分頁 A：Ports & Processes**：
     - 自動掃描 macOS 監聽中 TCP Ports（`lsof` + `ps` 快速聚合）。
     - 🚀 **Dev Servers** 優先高亮展示（Node.js, Vite, Next.js, FastAPI, PostgreSQL, Redis 等）。
     - 🛡️ **System / Protected** 自動識別防護（如 `ControlCenter`, `rapportd` 等，防止誤殺）。
     - 🌐 **Open in Browser**：點擊直接在瀏覽器開啟 `http://localhost:<port>`。
     - 🛑 **Kill Process**：一鍵發送 `SIGTERM`（或強制 `SIGKILL`）釋放佔用 Port。
     - 支援 `All` 與 `🚀 Dev Only` 快速過濾。
   - **分頁 B：Docker Containers**：
     - 自動檢測 Docker CLI 與背景 Daemon（相容 OrbStack 與 Docker Desktop）。
     - 容器清單卡片：即時狀態燈號（🟢 Running / ⚪ Exited）、名稱、映像檔、Port 映射。
     - 快捷控制：▶️ Start / ⏹️ Stop / 🔄 Restart。
     - 友善離線感知：若 Docker Daemon 未啟動，顯示溫和的提示卡與重試按鈕，不中斷 UI。
2. **快捷鍵彈窗模式**（`Ctrl+B Shift+E`）
   - 按下快捷鍵即可在獨立彈窗快速檢視與釋放 Port。
3. **即時更新**：定時 4 秒自動輪詢與手動 `⟳ Refresh`。

## 安裝

```bash
python3 herdr-services/install.py
```

## 測試

```bash
# Python 探針與安全檢查測試
python3 herdr-services/tests/scanner.test.py

# 前端 GPUI 資料流與元件測試
node --experimental-vm-modules --test herdr-services/tests/services.test.mjs

# 原生 Herdr GPUI 靜態規則校驗
herdr-app check herdr-services/mods/services-inspector
```
