# Herdr Spectra Status

把 [Spectra](https://github.com/kaochenlong/spectra-app)（SDD / OpenSpec）的專案狀態整合進 Herdr 右側獨立面板（比照 Agent Inspector），不用另外開 Spectra.app 就能即時檢視規格與任務進度。**唯讀**，支援新版 Spectra v3（`.spectra.yaml` / `docs/spectra/`）與舊版 OpenSpec（`openspec/`）。

## 功能

1. **右上角按鈕 + 右側獨立面板（Right-Side Panel）**
   - 點擊右上角 Tab Bar 的 **`Spectra`** 按鈕即可開關右側面板。
   - 自動跟隨目前 Focus Agent / Pane 的 `cwd`，向上尋找含 `.spectra.yaml`、`docs/spectra/`、`openspec/` 或 `.spectra/` 的專案根目錄（若位於父層容器目錄也會自動向下探測一層子目錄）。
   - 分頁切換：
     - **Tasks**：顯示當前選中 Change 的進度條、**Artifact DAG**（`proposal → design → specs → tasks`，點擊可開啟 Markdown Preview）與可摺疊的 **Tasks Checklist**。
     - **Changes**：列出所有進行中、已完成與 Parked 的 Changes，點擊即可切換檢視。
     - **Specs**：列出所有 Domain Specs，點擊直接以 Markdown Preview 開啟 `spec.md`。
   - 頂部支援 **`Spectra ↗`**（在 `Spectra.app` 開啟專案）、**`Popup`**（展開大視窗）與重新整理按鈕，並具備窄寬度自適應排版。
2. **詳細彈窗模式**（`Ctrl+B Shift+S`）
   - 雙欄寬版檢視，支援 `↑/↓`（或 `j/k`）切換、`r` 重新整理、`Esc` 關閉。
3. **即時更新**：透過 `watchFolder(<root>/<spec_dir>)` 自動監聽規格與任務勾選變動。

## 安裝

```bash
python3 herdr-tabs/install.py
python3 herdr-spectra/install.py
```

## 測試

```bash
node --experimental-vm-modules --test herdr-spectra/tests/spectra.test.mjs
```
