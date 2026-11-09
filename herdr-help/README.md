# Herdr Enhanced Help

強化 Herdr 的快捷鍵與速查說明彈窗（`Ctrl+B H` / `Ctrl+B ?`），將所有自訂 Mods 獨立歸類至頂部的 **`Custom Mods & Extensions`** 專屬區塊，並將生硬的指令代碼自動轉化為人類友善的繁體中文/清晰說明。

## 功能

1. **頂部獨立分類（`Custom Mods & Extensions`）**
   - 將所有擴充 Mod 自動置頂，以醒目色彩標註。
   - 包含：
     - `Ctrl+B Shift+A` ➔ **Agent Inspector (Context, Rules, MCP)**
     - `Ctrl+B Shift+E` ➔ **Services (Ports, Dev Servers, Docker)**
     - `Ctrl+B Shift+S` ➔ **Spectra (SDD Status & Tasks)**
     - `Ctrl+B Q` ➔ **Agent Quotas (Usage & Limits)**
     - `Ctrl+B G` ➔ **Git Manager (Fork Graph & Stashes)**
     - `Ctrl+B M` ➔ **Markdown Dual-Column Preview**
     - `Ctrl+B T` ➔ **Toggle Floating Popup Terminal**
     - `Ctrl+B Alt+B` ➔ **Toggle Matrix Digital Rain Loop**
     - `Ctrl+B Shift+B` ➔ **Next Wallpaper Background**
2. **語意化即時搜尋**
   - 支援搜尋功能關鍵字（例如打 `docker`、`ports`、`agent`、`matrix`、`git` 等皆能秒查到快捷鍵）。

## 安裝

```bash
python3 herdr-help/install.py
```
