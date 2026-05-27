# 滿意度調查系統 - 前台靜態網站（GitHub Pages）

> 純靜態 HTML/CSS/JS，**所有頁面（含後台管理）皆位於此**
> 透過 fetch 呼叫後端 API（Replit）

---

## 一、3 步驟部署至 GitHub Pages

### 步驟 1：上傳到 GitHub
1. 到 [github.com](https://github.com) 註冊 → 點 `+ New repository`
2. 命名（建議 `satisfaction-survey`）→ Public → Create
3. 把整個 `survey-frontend` 資料夾**裡面所有檔案**上傳（用 GitHub 網頁拖拉即可，無需 git 指令）

### 步驟 2：啟用 GitHub Pages
1. 進入該 repo → `Settings` 分頁 → 左側 `Pages`
2. Source 選 `Deploy from a branch`
3. Branch 選 `main`，資料夾選 `/ (root)` → Save
4. 等 1-2 分鐘，Pages 會給您網址，例：
   `https://您的帳號.github.io/satisfaction-survey/`

### 步驟 3：設定後端 API 網址
編輯 `config.js`：
```js
window.API_BASE = "https://您的後端.replit-app-name.repl.co";
```

並到 **Replit 後端 Secrets** 把 `FRONTEND_ORIGINS` 設為您的 GitHub Pages 網址（例：`https://您的帳號.github.io`）。

完成！手機掃 QR 或開啟首頁即可使用。

---

## 二、頁面清單

### 前台公開（民眾用）
| 檔案 | 用途 |
|---|---|
| `index.html` | 首頁：列出進行中問卷 |
| `survey.html?id=N` | 問卷填寫頁（純匿名） |
| `success.html?code=XXX` | 送出成功 + 兌換券 QR |
| `coupon.html?code=XXX` | 兌換券獨立顯示頁 |

### 後台管理（需登入）
| 檔案 | 角色 | 用途 |
|---|---|---|
| `admin/login.html` | 全部 | 管理者登入 |
| `admin/dashboard.html` | super/admin | 統計儀表板 |
| `admin/surveys.html` | super/admin | 問卷管理列表 |
| `admin/survey-edit.html?id=N` | super/admin | 編輯問卷與題目 |
| `admin/responses.html` | super/admin | 填答資料 |
| `admin/coupons.html` | super/admin | 兌換券管理 |
| `admin/redeem.html` | 全部 | 核銷頁（含相機掃描） |
| `admin/users.html` | super | 管理者帳號 |
| `admin/export.html` | super/admin | Excel 匯出 |

---

## 三、QR Code 設計

民眾掃描的 QR Code 內含網址：
```
https://您的帳號.github.io/satisfaction-survey/survey.html?id=1
```
這是「**問卷的 QR**」，貼在現場即可。

兌換券的 QR Code 由系統前端用 JS 即時產生，內容是兌換券編號（如 `GIFT-20260526-0001`），工作人員 `admin/redeem.html` 掃描即可核銷。

---

## 四、預設管理者帳號

`python seed.py` 在後端建立：
| 角色 | Email | 密碼 |
|---|---|---|
| 超級管理者 | admin@example.com | Admin@123456 |
| 現場工作人員 | staff@example.com | Staff@123456 |

⚠️ **上線前進 `admin/users.html` 改密碼**

---

## 五、本機測試

GitHub Pages 部署前，本機可用 Python 內建伺服器測：
```bash
cd survey-frontend
python -m http.server 8000
# 開啟 http://localhost:8000
```

`config.js` 在本機可設為 `window.API_BASE = "http://localhost:3000";`
（同時後端 `FRONTEND_ORIGINS` 加入 `http://localhost:8000`）

---

## 六、目錄結構

```
survey-frontend/
├── README.md
├── config.js                  # API_BASE 設定（部署時必改）
├── index.html                 # 首頁
├── survey.html                # 問卷填寫
├── success.html               # 送出成功 + 兌換券
├── coupon.html                # 兌換券獨立頁
├── js/
│   ├── api.js                 # API client（含 JWT 自動帶入）
│   └── common.js              # Tailwind 設定 + 後台 header 注入
└── admin/
    ├── login.html
    ├── dashboard.html
    ├── surveys.html
    ├── survey-edit.html
    ├── responses.html
    ├── coupons.html
    ├── redeem.html
    ├── users.html
    └── export.html
```

---

## 七、技術說明

- **無 build step**：純靜態 HTML 直接 commit 到 GitHub Pages 即可
- **Tailwind CSS**：CDN 引入，無需編譯
- **Chart.js**：CDN 引入，儀表板用
- **qrcode.js + jsQR**：CDN 引入，QR 產生與掃描皆 client-side
- **JWT**：登入後存於 `localStorage.survey_admin_token`，所有 API 自動帶上 `Authorization: Bearer ...`
- **device_id**：民眾匿名識別存於 `localStorage.survey_device_id`，作為 30 天兌換限制依據

---

## 八、自訂外觀

- **改主色**：編輯 `js/common.js` 內 `colors.brand`
- **改 LOGO**：替換 `index.html` 與後台 header 內的 📋 emoji
- **改字體**：head 內 Google Fonts `Noto Sans TC` 可換其他

---

## 九、常見問題

| 症狀 | 解法 |
|---|---|
| 開啟首頁顯示「無法連線伺服器」 | 確認 `config.js` 的 `API_BASE` 正確且後端已啟動 |
| 後台登入無反應 | 開瀏覽器 Console 看是否 CORS error，檢查後端 `FRONTEND_ORIGINS` |
| 兌換券 QR Code 沒顯示 | 確認 `qrcode.min.js` 載入成功（網路問題可換 CDN） |
| Excel 下載失敗 | 確認已登入（JWT 有效）且後端 `/api/admin/export/*` 正常 |
| GitHub Pages 改了 config.js 但網頁沒變 | GitHub Pages 有 ~1 分鐘 cache，強制 reload (Ctrl+F5) |

---

## 十、保留擴充

- [ ] LINE Login 整合（schema 已支援，需加 OAuth callback page）
- [ ] PWA / 離線快取
- [ ] 多語系 i18n
- [ ] 主題切換（深色模式）

---

**版權**：本系統為示範與內部使用之原始碼，可自行修改與部署。
