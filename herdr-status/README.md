# Herdr Workspace Status (Unified AI Agent Status Bar)

強化 Herdr 底層主狀態列（`workspace-status`），整合 **AI Agent 統一狀態列（Claude Code / OpenAI Codex / Google Antigravity）**、**目錄與 Git 分支指示** 與 **輸入法指示**。YouTube Music 播放列已移到 `herdr-chrome` 的 sidebar。

## 畫面佈局

- **由左至右**：`[📁 Agent 目前目錄]  [🌿 Git 分支]  [輸入法]  [統一 AI Agent 狀態列]  [⚡ N agents]`
  - 內容超出寬度時自動來回捲動，滑鼠移上去暫停，也可以用滾輪捲動。
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

### 2. 輸入法指示（IME Badge）
- `mods/enhanced-status/ime-watcher.swift` 監聽 macOS 輸入法切換，把目前狀態寫入 `/tmp/herdr-ime.json`，狀態列再讀這個檔顯示 `注` / `倉` / `拼` / `ABC` 等 badge。
- 安裝時以 `swiftc` 現場編譯（需要 Xcode Command Line Tools），並註冊 LaunchAgent `com.herdr.ime-watcher` 常駐。沒有 `swiftc` 時只略過這個功能，badge 固定顯示 `ABC`。
- 除錯：`~/.config/herdr-app/mods/enhanced-status/ime-watcher --once` 印出目前判讀結果。

## 安裝

```bash
python3 herdr-status/install.py
```

## 測試

```bash
node --experimental-vm-modules --test herdr-status/tests/status.test.mjs
```
