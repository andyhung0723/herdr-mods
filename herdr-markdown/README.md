# Herdr Markdown Preview

為 Herdr 桌面版打造的高效 Markdown 原生預覽套件，提供三種完整的使用體驗：

1. **浮動彈出視窗（Overlay / Popup）**：隨時隨地按下快捷鍵（`Ctrl+B M`）彈出置頂預覽，支援 `Esc` 或右上角按鈕關閉。
2. **分割面板（Split Pane）**：獨立於目前終端旁邊分割出即時預覽面板，支援多檔切換、手動重新載入與定時自動熱更新（AI Agent 修改文件時即時同步）。
3. **強化版檔案樹面板（Enhanced Files）**：在右側抽屜點選任何 `.md` 檔案時，上方提供 `[ Preview | Code ]` 切換鈕與 `[ ⧉ Split ]` 分割按鈕。

---

## 包含的模組

* **`mods/markdown-preview/`**：核心預覽模組，支援作為獨立 Pane 或 Dialog / Overlay 運行。
* **`mods/enhanced-files/`**：基於官方 `files` 擴充的檔案樹模組，直接在檔案瀏覽器中內建 Markdown 預覽。

---

## 快速安裝

在一般本機 Terminal 或 Herdr shell 中執行：

```bash
python3 herdr-markdown/install.py
```

預覽變更（不寫入檔案）：

```bash
python3 herdr-markdown/install.py --dry-run
```

安裝腳本會自動完成：
1. 執行 `herdr-app check` 驗證所有模組渲染相容性。
2. 複製模組至 `~/.config/herdr-app/mods/`。
3. 自動備份並於 `keys.json` 中配置 `ctrl-b m` 快捷鍵。
4. 自動備份並更新 `main-popup.json` 版面中的檔案面板為 `enhanced-files`。

---

## 使用方式

### 1. 浮動視窗 (Overlay / Popup)
* **快捷鍵**：按下 `Ctrl+B`，放開後按 `M`。
* **關閉**：按下 `Esc` 或點擊右上角 `✕`。
* **一鍵轉分割**：在浮動視窗右上角點擊 `⧉ Split`，立即轉為右側分割面板並關閉浮層。

### 2. 分割面板 (Split Pane)
在 Herdr 中透過 CLI 指令開啟右側分割面板：
```bash
# 自動尋找當前工作空間的 README.md 或候選 Markdown
herdr-app do pane.split '{"direction":"right","mod":"markdown-preview"}'

# 或指定開啟特定 Markdown 檔案
herdr-app do pane.split '{"direction":"right","mod":"markdown-preview","props":{"file":"docs/guide.md"}}'
```

### 3. 檔案樹切換 (Enhanced Files)
* 在右側 Files 面板點擊任一 `.md` / `.markdown` 檔案。
* 預設以漂亮的 Markdown 排版顯示。
* 可點擊上方 `Preview` / `Code` 隨時切換渲染檢視與語法原始碼。

---

## 測試與驗證

執行單元測試：
```bash
node --experimental-vm-modules --test herdr-markdown/tests/*.test.mjs
```

執行 Herdr 原生模組檢查：
```bash
herdr-app check herdr-markdown/mods/markdown-preview
herdr-app check herdr-markdown/mods/enhanced-files
```
