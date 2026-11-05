Herdr popup terminal

狀態：已備妥安裝資產，尚未安裝到 Herdr。JavaScript 生命週期測試已通過；
目前執行環境無法連上 Herdr 控制 socket，原生 check 在 macOS 初始化未返回，
因此尚未驗證原生繪製、焦點與實際快捷鍵。安裝腳本會先執行原生 check，失敗不安裝。

安裝（在一般本機 Terminal 或 Herdr shell 中執行）：

  python3 herdr-popup/install.py --clone-from main --layout main-popup

預覽變更，不寫檔或執行 Herdr 命令：

  python3 herdr-popup/install.py --clone-from main --layout main-popup --dry-run

安裝會透過 Herdr 原生命令複製並切換到 main-popup，保留原 main。
新增一個零高度 controller 及 main-popup 專用的 Ctrl+B T 快捷鍵。
設定變更前會建立備份；既有快捷鍵衝突或不同內容的同名 mod 都會中止。
popup-terminal mod 會執行 hc 查詢與啟動 shell，沒有 HTTP 請求；
新 shell 會載入使用者原有 shell 設定。

使用：

- Ctrl+B，放開後按 T：開啟／收起 popup。
- 每個工作空間有一個 shell；首次啟動目錄為當前終端機目錄。
- 收起後 shell 和其中的程式繼續執行，再開啟時保留目錄、環境與畫面。
- Esc 交給終端程式；按標頭「收起」或同一快捷鍵關閉浮層。
- exit 或 Ctrl+D 結束 shell；下一次開啟會建立新的 shell。
- terminal 沒有被放進 tabs 或 panes，不會改變既有分割。
- 本機與遠端工作空間都會在各自的機器啟動 shell。

驗證實際使用：

1. 開啟 popup，執行 export POPUP_TEST=retained，再執行 cd /tmp。
2. 用快捷鍵收起，再用快捷鍵打開，執行 pwd 與 echo "$POPUP_TEST"。
   預期仍是 /tmp 與 retained。
3. 確認開啟時可直接打字，收起後回到原終端機；Esc 能傳入 Vim 等程式。
4. 在另一個工作空間開啟，確認 shell 獨立；exit 後重開能建立新 shell。
5. 檢查 herdr-app status 與 keys.error / layout.error，確認無新錯誤。

開發驗證：

  node --experimental-vm-modules --test herdr-popup/tests/*.test.mjs
  herdr-app check herdr-popup/mods/popup-terminal

JS 測試使用 hc／GPUI mock，驗證狀態和命令，不取代 Herdr 原生驗證。

復原：

- herdr-app do layout.switch --name main 可回到原版面。
- 安裝腳本會印出 keys.json 與 main-popup.json 的備份位置。
- 移除前可用 hc ls 查詢 labels 中 herdr.popup-terminal 所標記的 shell；
  它們不因收起 popup 或關閉 Herdr 而終止，請對確認過的 address 執行 hc kill。

實作使用 Herdr GPUI 原生 layout 與 theme()；DS 沒有這種原生 terminal overlay，
此部分為自訂實作，未安裝 Web 元件或 CSS。
