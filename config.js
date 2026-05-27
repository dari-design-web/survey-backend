// ⚠️ 部署前請改為您的 Replit 後端網址（含 https://，結尾無 /）
window.API_BASE = "https://5e10ca53-93d5-416e-ade1-7b011c11278c-00-1l7n71pr9yo4b.pike.replit.dev";

// 兌換券前端公開檢視頁路徑（QR Code 內含的網址會指向這裡）
window.COUPON_PAGE_URL = function (code) {
  return location.origin + location.pathname.replace(/[^\/]*$/, "") + "coupon.html?code=" + encodeURIComponent(code);
};
