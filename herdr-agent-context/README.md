# Herdr Enhanced Agent Context (Agent Inspector Panel)

全方位 Agent 資訊與環境能力檢視面板（右側獨立 Sidebar），支援即時解析當前焦點 Agent 的 Rules、Skills、MCP Connectors 與運行環境。

## 功能特色
- **📄 規則與規範 (Rules)**：自動掃描 `CLAUDE.md`、`AGENTS.md`、`GEMINI.md`、`.cursorrules` 等，並支援在面板內直接全文閱讀與複製路徑。
- **⚡ 技能庫 (Skills)**：整合 Claude、Codex 與 Antigravity 的技能（如 50+ 組 prompt/workflow skills），支援分類篩選與查看說明。
- **🔌 連接器 (MCP Connectors)**：解析所有已配置的 MCP 伺服器（Playwright、DevTools、Context7 等）與命令參數。
- **🧭 執行環境 (Overview)**：即時連動當前 Agent、AI 模型、Git 分支與 Dirty 狀態。
- **🖥️ 右側 Sidebar 整合**：於頂部導覽列提供 `Agent` 按鈕，一鍵開啟 532px 寬敞視窗。

## 安裝方式
```bash
python3 herdr-agent-context/install.py
```

## 測試
```bash
node --test herdr-agent-context/tests/context.test.mjs
```
