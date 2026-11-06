# Herdr Agents Mod (Enhanced Subagent Activity Tracking)

增強版 Herdr Agents 側邊欄面板，支援即時統計與顯示每位 Agent 當前擁有的 Subagent 運作狀態。

## 功能特色
- **⚡ 即時運作計數 Badge**：若 Agent 底下有子代理正在執行任務（working），顯示如 `⚡ 2/3` 的動態工作標籤。
- **! 阻礙/錯誤提示 Badge**：若子代理需要使用者確認或遇到錯誤（blocked），顯示如 `! 1/2` 的警告標籤。
- **展開/收合同步**：不論展開或收合子代理列表，最外層 Agent 列皆能一目了然掌握背景執行狀態。
- **懸浮詳細提示 (Tooltip)**：滑鼠移至標籤時，顯示精確分類統計（如 `3 subagents: 2 working, 0 needs you, 1 idle`）。

## 安裝方式
```bash
python3 herdr-agents/install.py
```

## 測試
```bash
node --test herdr-agents/tests/agents.test.mjs
```
