# 滿意度問卷＋贈品兌換＋贈品庫存（V3：GitHub Pages + Google Apps Script）

- `web/`：前台與後台頁面（GitHub Pages）
- `gas/`：Apps Script 後端（`Code.gs`、`appsscript.json`、`VERSION`）
- `docs/`：規劃決策、實作規格、部署說明
- `test/`：本機測試（`cd test && npm i && node run-tests.js && node e2e.js`）

只有通過測試的版本才會更新 `gas/VERSION`；Apps Script 每小時比對此檔自動更新。
舊版（Replit 後端）頁面仍在 repo 根目錄，未受影響。
