# Herdr Workspace Status (Unified AI Agent Status Bar & YouTube Music)

強化 Herdr 底層主狀態列（`workspace-status`），整合 **AI Agent 統一狀態列（Claude Code / OpenAI Codex / Google Antigravity）**、**目錄與 Git 分支指示** 與 **YouTube Music 即時音樂控制卡**。

## 畫面佈局

- **左側環境資訊**：
  - `[🌿 Git 分支] · [⚡ N agents]`
- **右側狀態與控制區（靠右對齊）**：
  - `[📁 Agent 目前目錄完整路徑]  [統一 AI Agent 狀態列]  [▶ ♫ 音樂控制]  [⌘⇧P 指令提示]`
  - 中間由彈性 Spacer 推移，當資訊精簡時靠右收闔。
  - 點擊目錄路徑即可一鍵複製完整絕對路徑至剪貼簿。

## 功能

### 1. 統一 AI Agent 狀態列（靠右對齊、優先顯示當前 Agent）
- **優先顯示當前 Active Agent**：
  - 聚焦於 **Claude Code** 終端：展開顯示 Model 名稱（如 `Opus 5.5`）、推理強度標籤（如 `med`）、即時 Context 佔比（`ctx 45%`）、5 小時配額（`5h 48%`）、7 天配額（`7d 10%`）以及累積花費（`$64.20`）；兩側以精緻小 Badge 顯示 Codex 與 Antigravity 狀態。
  - 聚焦於 **OpenAI Codex** 終端：展開顯示 Model 名稱（如 `gpt-6.1-sol`）、推理強度標籤（如 `med`）、7 天配額（`7d 36%`）；兩側以小 Badge 顯示 Claude 與 Antigravity。
  - 聚焦於 **Google Antigravity** 終端：展開顯示 Model 名稱（如 `Gemini 3.8 Flash`）、5 小時剩餘配額（`5h 87%`）、7 天剩餘配額（`7d 82%`）；兩側以小 Badge 顯示 Claude 與 Codex。
  - **一般終端／Neutral 模式**：三者以對齊的小膠囊徽章並列顯示，資訊一目了然。
- **即時數據無縫同步**：
  - Claude Code：直接讀取 session 寫出的 `/tmp/claude-statusline-input.json`（<1ms 無阻塞），並具備 `~/.claude.json` fallback。
  - Codex：即時讀取 `~/.codex/config.toml` 與 RPC/SQLite 統計。
  - Antigravity：即時讀取 `~/.gemini/antigravity-cli/settings.json` 與 usage limit 探測。
- **快捷交互**：
  - 滑鼠 Hover：顯示完整配額重置倒數（如 `resets in 2h 14m`）、詳細 Token 與 Cost 統計。
  - 點擊任一 Agent 膠囊／徽章：直接開啟 `agent-quotas` 儀表板彈窗。

### 2. 右下角 YouTube Music Now Playing 動態音樂卡
- 當電腦上打開 YouTube Music 聽歌時，右下角狀態列（`commands` 旁）即時顯示：
  - **播放中**：`▶ ♫ [歌曲名稱] · [歌手]`（綠色/青色高亮）
  - **暫停時**：`⏸ [歌曲名稱]`（柔和暗灰）
  - **未開啟或無音樂時**：自動收合隱藏。
- 點擊歌曲文字：一鍵喚醒 YouTube Music 切換到最前台。
- 點擊 `⏸` / `▶`：直接暫停／繼續播放。

## 安裝

```bash
python3 herdr-status/install.py
```

## 測試

```bash
node --experimental-vm-modules --test herdr-status/tests/status.test.mjs
```
