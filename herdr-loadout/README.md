# Herdr Loadout

[agent-loadout](../../agent-loadout) 的 Herdr 桌面版介面：資源 × 帳號矩陣，點一下就切換某個 skill / hook / MCP / plugin 在某個帳號（`claude`、`claude-work`、`codex`、`codex-work`）的開關。

## 功能

- **矩陣檢視**：每列一個資源，每欄一個帳號；格子顯示 `✓ on`、`+ pending`、`! conflict`、`✗ unresolved`、`○ observed`、`◌ absent`、`· off`、`– unsupported`。
- **切換**：點格子或游標移過去按 `Space`，等同 `loadout toggle <resource> <target> on|off`。只改 manifest 那一行 `to`，並只 apply 該資源。
- **重開提示**：切換過的帳號欄位標示 `↻ restart sessions`（skills / MCP / hooks 在 session 啟動時載入）。
- **Apply pending**：manifest 在外部被改過時，標題列出現 `Apply N pending`（`a`）。
- **Release**（`x`）：`loadout release <resource> <target>`。這個帳號不再由 loadout 管理，但檔案留在原處，不會刪除。跟 `Space` 關閉不同，`Space` 會移除。
- **Undo**（`u`，或標題列的 `↶ Undo …`）：`loadout restore <run>`，還原上一次的 toggle / apply / release，連 manifest 那一行也一起還原。開啟時會取 `loadout history` 最近一次的 run。之後被改過的項目會保持原樣並發 toast。undo 本身也能再 undo，等於 redo。
- **篩選**：依種類篩選（`Tab` / `Shift-Tab` 或點 chip）；依帳號篩選（`1`–`9` 顯示／隱藏第 N 個帳號，`0` 回到全部，或點右上的 Accounts chip），只留選到的帳號欄，選到的帳號都不支援的資源整列隱藏。
- **說明**：`?` 展開格子圖例、全部快捷鍵與 warnings；footer 平時只顯示狀態與常用鍵。
- 失敗（conflict、unresolved、寫檔錯誤）會發 toast，並在底部顯示。

| 鍵 | 動作 |
| --- | --- |
| `↑↓` / `jk` | 上下移動 |
| `←→` / `hl` | 切換帳號欄 |
| `Space` / `Enter` | 切換開關 |
| `Tab` / `Shift-Tab` | 切換種類篩選 |
| `1`–`9` / `0` | 顯示／隱藏第 N 個帳號 / 全部帳號 |
| `/` | 搜尋 |
| `?` | 圖例、快捷鍵、warnings |
| `r` | 重新整理 |
| `a` | 套用所有 pending |
| `x` | release 游標所在格（保留檔案） |
| `u` | undo 上一次的 run |
| `Esc` | 關閉 |

## 安裝

```bash
python3 herdr-loadout/install.py              # 用 loadout 預設的 manifest / state
python3 herdr-loadout/install.py --dry-run    # 只預覽

# 在不動真實設定的沙盒裡試玩
python3 herdr-loadout/install.py --manifest /path/to/preview/loadout.toml --state /path/to/preview/state.json
```

安裝程式會：

1. 跑 `herdr-app check`；
2. 複製 mod 到 `~/.config/herdr-app/mods/loadout`；
3. 寫入 `config.json`，內容是 node（需 >= 24）與 `agent-loadout/bin/loadout.js` 的絕對路徑。從 GUI 啟動的 Herdr 不會繼承 nvm 的 `PATH`，所以 mod 不依賴 `PATH`；
4. 綁定 `ctrl-b l` → `mod.open:loadout`。該鍵已被其他功能佔用時會拒絕安裝，可用 `--key` 改鍵。

## 架構

- `client.js`：呼叫 `loadout … --json`（接受 exit 0/2），以及純邏輯（`nextEnabled`、`releasable`、`visibleRows`、`summarize`、`failuresOf`、`undoable`）。這個模組不依賴 UI，測試時以假的 `herdr` 模組載入。
- 逾時：讀取（`status`、`history`）60 秒；寫入（toggle、apply、release、restore）300 秒，因為可能要等 keychain 授權視窗。herdr `exec` 上限是 600 秒，不需要背景工作。
- `main.js`：只負責 UI 與鍵盤；資料一律來自 `loadout status --json`，不自行解析任何設定檔。
- 每 30 秒重新整理一次；有操作進行中時會跳過。

## 測試

```bash
node --experimental-vm-modules --test herdr-loadout/tests/*.test.mjs
herdr-app check herdr-loadout/mods/loadout
```
