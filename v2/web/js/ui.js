// 共用版面元件（依 v2/design 設計系統）：品牌列、底部導覽、頁尾、圖示
(function () {
  const P = {
    archive: 'M4 8h16v12H4zM3 4h18v4H3zM9 12h6M9 16h6',
    check: 'm5 12 4 4L19 6',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    back: 'm14 5-7 7 7 7',
    gift: 'M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9C4 9 4 3 8 3c3 0 4 6 4 6Zm0 0c8 0 8-6 4-6-3 0-4 6-4 6Z',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    info: 'M12 11v6m0-10v1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    x: 'M18 6 6 18M6 6l12 12',
    pen: 'm4 16-1 5 5-1L21 7l-5-5L4 16Zm9-11 5 5',
    ticket: 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6Zm12 0v12',
    pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10',
    chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
    box: 'M3 9h18v4H3zM5 13v8h14v-8M12 9v12',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    download: 'M12 3v12m-5-5 5 5 5-5M5 21h14',
    msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'
  };
  window.icon = function (name, size) {
    size = size || 20;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;
  };
  window.ORG_NAME = '林口國家檔案館';
  window.ORG_SUB = '附屬服務設施';
  window.REDEEM_RULE = '請於 24 小時內至服務台兌換，逾時自動取消';

  window.brandHeader = function () {
    return `<header class="brand-header"><span class="brand-mark">${icon('archive', 28)}</span>
      <div class="brand-copy">${ORG_NAME}<br><span class="muted">${ORG_SUB}</span></div></header>`;
  };
  window.bottomNav = function (cur) {
    return `<nav class="bottom-nav" aria-label="客人端導覽">
      <a href="index.html" ${cur === 'survey' ? 'aria-current="page"' : ''}>${icon('pen')}填寫問卷</a>
      <a href="my-coupons.html" ${cur === 'coupons' ? 'aria-current="page"' : ''}>${icon('ticket')}我的兌換券</a></nav>
      <footer class="footer"><p>${ORG_NAME}${ORG_SUB}</p><p><a class="link" href="privacy.html">隱私權聲明</a></p></footer>`;
  };
  window.notice = function (kind, iconName, html, role) {
    return `<div class="notice ${kind || ''}" role="${role || 'status'}">${icon(iconName, 24)}<div>${html}</div></div>`;
  };
  window.escHtml = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  // 券狀態：文字＋圖示＋顏色
  window.COUPON_STATE = {
    issued: { label: '未兌換', cls: '', icon: 'check' },
    redeemed: { label: '已兌換', cls: 'gray', icon: 'check' },
    expired: { label: '已逾期', cls: 'red', icon: 'clock' },
    voided: { label: '已作廢', cls: 'gray', icon: 'x' },
    invalid: { label: '無效', cls: 'red', icon: 'x' }
  };
  window.couponBadge = function (status) {
    const s = COUPON_STATE[status] || { label: status, cls: 'gray', icon: 'info' };
    return `<span class="badge ${s.cls}">${icon(s.icon, 16)}${s.label}</span>`;
  };
  // QR Code 在手機上直接產生，券號不會傳給任何外部網站
  window.qrImg = function (text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(String(text));
      qr.make();
      return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: '兌換券 QR Code' })
        .replace('<svg ', '<svg role="img" aria-label="兌換券 QR Code" width="212" height="212" ');
    } catch (e) {
      return '<p class="muted" style="text-align:center">QR Code 無法顯示，請改出示下方券號。</p>';
    }
  };
})();

// 兌換券票券（success.html 與 coupon.html 共用）：有效時才顯示可掃描 QR
window.ticketHTML = function (coupon, survey) {
  const st = coupon.status;
  const active = st === 'issued';
  const fmt = (window.fmtTpe || (x => x));
  const row = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '';
  return `<article class="card ticket">
    <div class="ticket-head">
      ${survey && survey.location_name ? `<p class="eyebrow">${escHtml(survey.location_name)}</p>` : ''}
      <h2>${escHtml((survey && survey.coupon_title) || '贈品兌換券')}</h2>
      <p class="muted">${escHtml((survey && survey.coupon_subtitle) || '感謝您完成滿意度調查')}</p>
      <div style="margin-top:12px">${couponBadge(st)}</div>
      ${survey && survey.gift_image && survey.gift_id === coupon.gift_id ? `<div style="margin-top:16px;display:flex;justify-content:center">${giftImgTag(coupon.gift_id, survey.gift_image, 120)}</div>` : ''}
    </div>
    ${active
      ? `<div class="qr-box" id="qrBox">${qrImg(coupon.qr_code_value || coupon.coupon_code)}</div>
         <p class="muted" style="text-align:center">請將此畫面出示給服務台人員掃描</p>`
      : `<div class="qr-box" id="qrBox" style="flex-direction:column;gap:8px;color:var(--muted)">${icon(COUPON_STATE[st] ? COUPON_STATE[st].icon : 'x', 40)}
           <strong>此券${escHtml((COUPON_STATE[st] || {}).label || '無效')}，無法兌換</strong></div>`}
    <p class="ticket-code mono">${escHtml(coupon.coupon_code)}</p>
    <dl class="meta-list">
      ${row('贈品', coupon.gift_name ? `<strong>${escHtml(coupon.gift_name)}</strong>` : '')}
      ${row('取得時間', escHtml(fmt(coupon.issued_at, 'short')))}
      ${row('兌換期限', `<strong>${escHtml(fmt(coupon.expires_at, 'short'))}</strong>`)}
      ${row('兌換地點', survey && survey.redemption_location ? escHtml(survey.redemption_location) : '')}
      ${row('核銷時間', coupon.redeemed_at ? escHtml(fmt(coupon.redeemed_at, 'short')) : '')}
    </dl>
    ${active ? `<div class="deadline row">${icon('clock', 22)}<div>${REDEEM_RULE}</div></div>` : ''}
  </article>`;
};

window.TERMS = [
  '本券限完成問卷後取得，限本人使用。',
  '請於 24 小時內至服務台兌換，逾時自動取消，恕不補發。',
  '本券不得轉售、兌換現金或折抵其他消費。',
  '贈品數量有限，兌完為止。',
  '主辦單位保有活動內容調整、兌換資格審核及最終解釋之權利。'
];
window.termsHTML = function () {
  return `<details class="card" style="margin-top:24px"><summary>兌換注意事項</summary>
    <ol style="margin:8px 0 0;padding-left:1.4em" class="stack-sm">${TERMS.map(t => `<li>${escHtml(t)}</li>`).join('')}</ol></details>`;
};


// ===== 贈品圖片：依版本快取在本機，避免重複下載 =====
window.giftImgTag = function (giftId, version, size, extraStyle) {
  if (!giftId || !version) return '';
  size = size || 96;
  return `<img data-gift-img="${giftId}" data-ver="${escHtml(version)}" alt="贈品圖片" width="${size}" height="${size}"
    style="width:${size}px;height:${size}px;object-fit:cover;border-radius:12px;background:var(--soft);flex-shrink:0;${extraStyle || ''}">`;
};
window.loadGiftImages = function (root) {
  (root || document).querySelectorAll('img[data-gift-img]:not([src])').forEach(async img => {
    const id = img.dataset.giftImg, ver = img.dataset.ver, key = 'giftimg_' + id + '_' + ver;
    let url = null;
    try { url = localStorage.getItem(key); } catch (_) {}
    if (!url) {
      try {
        url = (await API.get('/api/public/gift-image/' + id)).data_url;
        try { localStorage.setItem(key, url); } catch (_) {}
      } catch (_) { img.remove(); return; }
    }
    img.src = url;
  });
};

// ===== 填答者登入（Google）=====
window.getCustomerToken = function () { try { return localStorage.getItem('survey_ctoken'); } catch (_) { return null; } };
window.setCustomerToken = function (t) { try { t ? localStorage.setItem('survey_ctoken', t) : localStorage.removeItem('survey_ctoken'); } catch (_) {} };
window.customerLogout = function () { setCustomerToken(null); location.reload(); };

// ===== 本機快取（先顯示上次的內容，背景再向後端更新）=====
window.cacheRead = function (key) { try { const v = localStorage.getItem('sc_' + key); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
window.cacheWrite = function (key, val) { try { localStorage.setItem('sc_' + key, JSON.stringify(val)); } catch (_) {} };
/** 取得資料並寫入快取；回傳 Promise */
window.fetchAndCache = function (key, path) { return API.get(path).then(d => { cacheWrite(key, d); return d; }); };

let _publicConfigP = null;
/** 公開設定：有快取就立即回傳（背景更新），沒有才等後端 */
window.publicConfig = function () {
  if (!_publicConfigP) {
    const fresh = fetchAndCache('config', '/api/public/config');
    const cached = cacheRead('config');
    _publicConfigP = cached ? Promise.resolve(cached) : fresh;
    fresh.catch(() => {});
  }
  return _publicConfigP;
};
window.cachedConfigSync = function () { return cacheRead('config'); };

/** App 內建瀏覽器（LINE、Facebook、Instagram、微信等）：Google 不允許在其中授權 */
window.isInAppBrowser = function () {
  return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|WhatsApp|Messenger|KAKAOTALK|Threads|Barcelona|; wv\)/i.test(navigator.userAgent || '');
};
window.copyPageUrl = async function (btn) {
  const url = location.href.replace(/[?&]openExternalBrowser=1/, '');
  try { await navigator.clipboard.writeText(url); btn.textContent = '已複製，請貼到 Safari 或 Chrome'; }
  catch (_) { prompt('請複製以下網址，貼到 Safari 或 Chrome 開啟：', url); }
};

/** 在 container 內顯示「以 Google 帳號登入」卡片；登入成功後重新載入頁面 */
window.renderGoogleLogin = async function (container, reason) {
  const cfg = await publicConfig();
  if (isInAppBrowser()) {
    container.innerHTML = `<div class="card" style="margin-top:24px;text-align:center">
      <div class="state-symbol">${icon('alert', 32)}</div>
      <h2>請改用 Safari 或 Chrome 開啟</h2>
      <p class="muted" style="margin:8px 0 16px">目前是在 App 內建的瀏覽器中，Google 不允許在這裡授權。</p>
      <ol style="text-align:left;margin:0 auto 16px;max-width:320px;line-height:1.9">
        <li>點右上角「⋯」或分享圖示</li>
        <li>選「在瀏覽器開啟」或「以 Safari 開啟」</li>
      </ol>
      <button type="button" class="btn btn-secondary" onclick="copyPageUrl(this)">複製網址</button></div>`;
    return;
  }
  container.innerHTML = `<div class="card" style="margin-top:24px;text-align:center">
    <div class="state-symbol">${icon('users', 32)}</div>
    <h2>請先以 Google 帳號授權</h2>
    <p class="muted" style="margin:8px 0 20px">${escHtml(reason || '每個帳號每月可領一次贈品，授權後即可開始填寫。')}</p>
    <div id="gBtn" style="display:flex;justify-content:center;min-height:44px"></div>
    <p class="muted" style="margin-top:16px">僅用於確認帳號，不會取得密碼，也不保存姓名、Email 或照片。</p>
    <div id="gErr" role="alert" style="color:var(--red);margin-top:12px"></div></div>`;
  const start = () => {
    google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      callback: async (resp) => {
        try {
          const r = await API.post('/api/public/login/google', { credential: resp.credential });
          setCustomerToken(r.ctoken);
          location.reload();
        } catch (e) { document.getElementById('gErr').textContent = '授權失敗：' + e.message; }
      }
    });
    google.accounts.id.renderButton(document.getElementById('gBtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', locale: 'zh-TW' });
  };
  if (window.google && google.accounts && google.accounts.id) return start();
  const sc = document.createElement('script');
  sc.src = 'https://accounts.google.com/gsi/client';
  sc.async = true;
  sc.onload = start;
  sc.onerror = () => { document.getElementById('gErr').textContent = '無法載入 Google 授權，請確認網路後重新整理。'; };
  document.head.appendChild(sc);
};
