# Herdr Workspace Status (with YouTube Music Now Playing)

強化 Herdr 底層狀態列（`workspace-status`），在**右下角**即時同步電腦上 **YouTube Music App（Edge PWA / 瀏覽器）** 目前正在播放的歌曲資訊（曲名、歌手與播放狀態）。

## 功能

1. **右下角 Now Playing 動態音樂卡**
   - 當您在電腦上打開 YouTube Music 聽歌時，右下角狀態列（`commands` 旁）會即時顯示：
     - **播放中**：`▶ ♫ [歌曲名稱] · [歌手]`（綠色/青色高亮）
     - **暫停時**：`⏸ [歌曲名稱]`（柔和暗灰）
     - **未開啟或無音樂時**：自動優雅收合隱藏，完全不干擾畫面。
2. **快捷互動操作**
   - 點擊歌曲文字：一鍵喚醒並將 YouTube Music App 切換到最前台。
   - 點擊 `⏸` / `▶`：直接暫停／繼續播放。
3. **免帳號、純本機探測**
   - 0.05 秒輕量本機探測，不走網路請求，零負擔。

## 安裝

```bash
python3 herdr-status/install.py
```

## 測試

```bash
node --experimental-vm-modules --test herdr-status/tests/status.test.mjs
```
