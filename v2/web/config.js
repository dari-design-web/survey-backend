// 後端：Google Apps Script 網頁應用程式網址（部署後取得，結尾為 /exec）
window.API_BASE = "__APPS_SCRIPT_EXEC_URL__";

// 兌換券前端公開檢視頁路徑（QR Code 內含的網址會指向這裡）
window.COUPON_PAGE_URL = function (code) {
  return location.origin + location.pathname.replace(/[^\/]*$/, "") + "coupon.html?code=" + encodeURIComponent(code);
};
