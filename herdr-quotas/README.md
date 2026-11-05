# Herdr Agent Quotas

為 Herdr 桌面版打造的 Coding Agent 額度與用量監控套件，支援 **Claude Code**、**OpenAI Codex** 與 **Google Antigravity**。

---

## 功能特點

1. **左側邊欄常駐監控（Sidebar Widget）**：
   * 緊湊內嵌於側邊欄 `Agents` 清單下方（高約 96px）。
   * 顯示三種 Agent 的即時狀態與水位進度條：
     * **Claude Code**：7 天累積上限與額外額度進度條（自動依水位變色：綠/黃/紅）。
     * **Codex**：ChatGPT 訂閱方案（如 `PROLITE`）與今日 Token 消耗總量。
     * **Antigravity**：當前模型（`Gemini 3.8 Flash`）與今日執行步驟數。
   * **點擊卡片**：直接彈出詳細儀表板！

2. **詳細彈窗儀表板（Popup Dashboard）**：
   * **快捷鍵**：按下 **`Ctrl+B Q`**（Q = Quota）隨時呼出。
   * **Claude 詳情**：5 小時與 7 天窗口使用率、**重設時間倒數計時**、額外額度金額（`$121.96 / $170.00`）、帳號與組織名稱。
   * **Codex 詳情**：訂閱方案、當前模型、今日 Token 總量與活躍任務次數。
   * **Antigravity 詳情**：當前模型、今日總交談輪次、執行步驟與連線狀態。
   * 支援 `↻ Refresh` 手動重新整理，按 `Esc` 隨時關閉。

---

## 快速安裝

在一般本機 Terminal 或 Herdr shell 中執行：

```bash
python3 herdr-quotas/install.py
```

預覽變更（不寫入檔案）：

```bash
python3 herdr-quotas/install.py --dry-run
```

---

## 測試與驗證

執行單元測試：
```bash
node --experimental-vm-modules --test herdr-quotas/tests/*.test.mjs
```

執行 Herdr 原生檢查：
```bash
herdr-app check herdr-quotas/mods/agent-quotas
```
