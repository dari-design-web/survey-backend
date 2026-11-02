# 問卷系統版面設計稿

從 `index.html` 開始，可直接用瀏覽器開啟。所有連結均為設計目錄內的相對路徑。Tailwind CDN 與 Google Fonts 需網路；即使 CDN 不可用，共用 CSS 仍提供基本版面與系統字體。

- `設計系統.md`：色彩、字體、尺寸、元件、固定文案與整合契約。
- `mockups/`：10 頁獨立設計稿，另有 `components.html` 元件及狀態對照。
- `mockups/assets/`：共用樣式、僅供展示的互動與不能兌換的示意 QR。
- `validation/`：元素 id 對照、正式檔案雜湊及檢查結果。
- `tools/generate_mockups.py`：HTML 設計稿產生原始檔，只寫入本設計目錄；若手動修改 HTML，重跑會覆蓋設計稿。

設計稿不載入正式 config／API／共用程式，不連接 Apps Script、不存取相機、不讀寫瀏覽器儲存。請勿把 demo.js 當作正式業務邏輯。

Claude 套用時須同步調整原有 JavaScript 動態模板與樣式。保留 id 只是整合起點，不代表可直接整頁覆蓋。詳見根目錄 `03_Codex執行與驗證.md` 的版面設計章節。
