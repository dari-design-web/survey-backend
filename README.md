# 滿意度調查系統 - 後端 API（Replit）

> Flask + JSON 檔案儲存 + JWT 認證 + CORS
> **此專案僅提供 REST API**；前台介面在另一個 GitHub Pages repo（`survey-frontend`）

---

## 一、快速上手（Replit）

1. 到 [replit.com](https://replit.com) 註冊
2. `+ Create Repl` → 上傳此資料夾，或從 GitHub import
3. 點左下 `Shell`：
   ```bash
   python seed.py        # 建立預設管理者與範例問卷
   python main.py        # 啟動 API（Replit 會自動偵測並提供 https URL）
   ```
4. 上方會出現您的網址，如 `https://survey-backend.您的帳號.repl.co`
5. **複製這個網址**，去前台 repo 改 `config.js` 內 `window.API_BASE`

## 二、必設環境變數（Replit Secrets）

到 Replit 左側「🔒 Secrets」分頁設定：

| Key | Value | 必填 |
|---|---|:---:|
| `JWT_SECRET` | 任意 32 字以上隨機字串 | ✅ |
| `FRONTEND_ORIGINS` | `https://您帳號.github.io`（前台網址，逗號分隔多個） | ✅ |
| `DEFAULT_ADMIN_EMAIL` | 您的管理者 Email | 推薦 |
| `DEFAULT_ADMIN_PASSWORD` | 強密碼 | 推薦 |
| `LINE_CHANNEL_ID` | LINE Login 用（選用） | — |
| `LINE_CHANNEL_SECRET` | 同上 | — |
| `LINE_CALLBACK_URL` | 同上 | — |

`FRONTEND_ORIGINS` 設定範例：
- 一個前台：`https://myname.github.io`
- 多個（含本機開發）：`https://myname.github.io,http://localhost:8000`

## 三、預設帳號

| 角色 | Email | 密碼 |
|---|---|---|
| 超級管理者 | admin@example.com | Admin@123456 |
| 現場工作人員 | staff@example.com | Staff@123456 |

⚠️ 上線前請進前台 `/admin/users.html` 修改密碼。

## 四、API 端點總覽

### 公開（無需驗證）
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 健康檢查 |
| GET | `/api/public/surveys` | 列出啟用中問卷 |
| GET | `/api/public/surveys/<id>` | 取得問卷與題目 |
| GET | `/api/public/coupons/<code>` | 公開查詢兌換券狀態 |
| POST | `/api/public/survey` | 送出問卷（自動產券） |

### 認證
| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/login` | 取 JWT |
| GET | `/api/auth/me` | 驗證目前 token |

### 管理（需 JWT，role=super/admin）
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/dashboard` | 儀表板統計 |
| GET/POST/PUT | `/api/admin/surveys[/:id]` | 問卷 CRUD |
| POST | `/api/admin/surveys/:id/duplicate` | 複製 |
| POST | `/api/admin/surveys/:id/toggle-active` | 啟用切換 |
| POST/PUT/DELETE | `/api/admin/questions[/:id]` | 題目 CRUD |
| GET | `/api/admin/responses` | 填答列表 |
| GET | `/api/admin/responses/:id` | 填答詳細 |
| GET | `/api/admin/coupons` | 兌換券列表 |
| POST | `/api/admin/coupons/:id/void` | 作廢 |
| GET | `/api/admin/admin-users` | 管理者列表（super only） |
| POST/PUT/DELETE | `/api/admin/admin-users[/:id]` | 帳號管理（super only） |
| GET | `/api/admin/export/responses` | Excel 匯出（填答） |
| GET | `/api/admin/export/coupons` | Excel 匯出（兌換券） |
| GET | `/api/admin/export/summary` | Excel 匯出（統計摘要） |

### 核銷（需 JWT，role=super/admin/staff）
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/redeem/lookup?code=XXX` | 查詢券狀態 |
| POST | `/api/redeem` | 執行核銷 |

## 五、資料儲存

所有資料以 JSON 檔案存於 `data/` 目錄：

| 檔案 | 內容 |
|---|---|
| `users.json` | 民眾使用者（匿名，以 device_id 識別） |
| `admin_users.json` | 後台管理者帳號（含 bcrypt 雜湊密碼） |
| `surveys.json` | 問卷主檔 |
| `survey_questions.json` | 題目 |
| `survey_responses.json` | 填答主檔 |
| `survey_answers.json` | 每題答案 |
| `coupons.json` | 兌換券 |
| `redemption_logs.json` | 兌換事件 |
| `audit_logs.json` | 後台操作紀錄 |
| `coupon_sequences.json` | 每日券號流水 |

### 並發控制
- threading.RLock 防止同檔讀寫衝突
- atomic write（先寫 .tmp 再 os.replace）防止崩潰時資料毀損
- Replit 預設 Werkzeug single-thread 開發伺服器，並發很安全
- 若要上 production multi-worker（如 gunicorn），建議改用 PostgreSQL

### 備份
JSON 檔可直接 `cp data/*.json backup/` 備份，或在 Replit Shell 執行：
```bash
tar -czf "backup-$(date +%F).tar.gz" data/
```

## 六、本機開發

```bash
pip install -r requirements.txt
python seed.py
JWT_SECRET=test FRONTEND_ORIGINS='*' python main.py
# API: http://localhost:3000
```

## 七、與前台串接

1. 啟動本後端
2. 編輯前台 `config.js`：
   ```js
   window.API_BASE = "https://您的後端網址.repl.co";
   ```
3. 把前台推到 GitHub Pages
4. 後端 Secrets 設定 `FRONTEND_ORIGINS=https://您帳號.github.io`
5. 完成

## 八、進階：遷移至 PostgreSQL

當資料量 > 10 萬筆或併發很高時：
1. `pip install psycopg2-binary`
2. 改寫 `lib/store.py` 為 SQL 版本（其他檔案大致不變）
3. 把 JSON 匯入 PG（簡單 Python 腳本）

## 九、故障排除

| 症狀 | 原因／解法 |
|---|---|
| 前台 Console 出現 CORS error | 後端 `FRONTEND_ORIGINS` 設定錯誤 |
| 登入 401 | 密碼錯誤、或 `JWT_SECRET` 重啟後變了（token 失效） |
| Excel 下載 401 | JWT 未透過 `?token=` query 傳遞 |
| 重啟後資料消失 | 確認 `data/` 目錄存在且有寫入權限 |
| 「Internal Server Error」 | 看 Replit Console 錯誤訊息 |
