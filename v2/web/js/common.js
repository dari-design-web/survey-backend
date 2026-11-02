// 共用：Tailwind 設定、後台 header 注入、登出
(function () {
  // 共用樣式與元件（設計系統 v2/design）：由本檔自動載入，各頁不必個別引用
  const base = (document.currentScript && document.currentScript.src || '').replace(/js\/common\.js.*$/, '');
  const V = (document.currentScript && (document.currentScript.src.match(/\?v=([^&]+)/) || [])[1]) || '';
  document.write('<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="' + base + 'css/design.css?v=' + V + '">' +
    '<link rel="stylesheet" href="' + base + 'css/theme.css?v=' + V + '">' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"><\/script>' +
    '<script src="' + base + 'js/ui.js?v=' + V + '"><\/script>');

  // Tailwind 自訂主題（CDN 模式）：品牌色改為設計系統的墨綠
  if (window.tailwind) {
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['"Noto Sans TC"', '"Microsoft JhengHei"', '"PingFang TC"', 'sans-serif'] },
          colors: {
            brand: { 50: '#EAF2EC', 100: '#DCE9E0', 200: '#BFD6C8', 300: '#93B8A6', 400: '#5E8F7F', 500: '#2F6A5E',
                     600: '#234F46', 700: '#183D35', 800: '#123029', 900: '#0D241E' }
          }
        }
      }
    };
  }

  function tokenUser() {
    try {
      const tok = API.getToken();
      if (!tok) return null;
      const b64 = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
      const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
      return { name: p.name, email: p.email, role: p.role };
    } catch (_) { return null; }
  }

  // 後台導覽：桌機左側欄、手機上方列（依角色顯示）
  window.renderAdminHeader = function (currentTab) {
    const u = tokenUser();
    if (!u) {
      if (!location.pathname.endsWith('login.html')) location.href = 'login.html';
      return;
    }
    const mgr = u.role === 'super' || u.role === 'admin';
    const tabs = [
      mgr && ['dashboard', 'dashboard.html', '營運總覽', 'chart'],
      mgr && ['surveys', 'surveys.html', '問卷設計', 'pen'],
      mgr && ['responses', 'responses.html', '填答資料', 'list'],
      mgr && ['comments', 'comments.html', '民眾意見', 'msg'],
      mgr && ['coupons', 'coupons.html', '兌換券', 'ticket'],
      mgr && ['gifts', 'gifts.html', '贈品庫存', 'gift'],
      ['redeem', 'redeem.html', '現場核銷', 'scan'],
      mgr && ['export', 'export.html', '資料匯出', 'download'],
      u.role === 'super' && ['users', 'users.html', '帳號與系統', 'users']
    ].filter(Boolean);
    const cur = k => k === currentTab ? 'aria-current="page"' : '';
    const roleZh = { super: '超級管理者', admin: '管理者', staff: '現場人員' }[u.role] || u.role;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    document.body.classList.add('has-sidebar');
    document.body.insertAdjacentHTML('afterbegin', `
      <aside class="sidebar admin-sidebar" aria-label="後台導覽">
        <div class="sidebar-brand">${icon('archive', 28)}<strong>服務問卷管理</strong>${ORG_NAME}<br>${ORG_SUB}</div>
        <nav class="side-nav">${tabs.map(([k, href, l, ic]) => `<a href="${href}" ${cur(k)}>${icon(ic)}${l}</a>`).join('')}</nav>
        <div class="sidebar-foot">讓每一份回饋<br>成為更好的服務。</div>
      </aside>
      <div class="mobile-admin"><div class="between"><strong>服務問卷管理</strong>
        <button onclick="logout()" class="btn" style="color:#fff;border-color:#fff;background:transparent;min-height:44px">登出</button></div>
        <nav aria-label="後台導覽">${tabs.map(([k, href, l]) => `<a href="${href}" ${cur(k)}>${l}</a>`).join('')}</nav></div>
      <div class="admin-top"><span>${ORG_NAME}${ORG_SUB}</span>
        <div class="row"><span class="muted">${esc(u.name)}（${roleZh}）</span>
        <button onclick="logout()" class="btn btn-plain">登出</button></div></div>`);
  };

  window.logout = function () {
    API.clearToken();
    location.href = 'login.html';
  };

  // === 時區轉換：UTC ISO 字串 → 台灣時間 (UTC+8) ===
  // 用法：fmtTpe('2026-05-28T07:01:30+00:00') → '2026-05-28 15:01:30'
  //       fmtTpe(isoStr, 'short')              → '2026-05-28 15:01'  (省略秒)
  //       fmtTpe(isoStr, 'date')               → '2026-05-28'         (僅日期)
  window.fmtTpe = function (iso, mode) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(0, 19).replace('T', ' ');
      const base = {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour12: false,
      };
      if (mode === 'date') {
        return d.toLocaleString('sv-SE', base);
      }
      const opts = { ...base, hour: '2-digit', minute: '2-digit' };
      if (mode !== 'short') opts.second = '2-digit';
      // sv-SE 會輸出 'YYYY-MM-DD HH:mm:ss' 格式
      return d.toLocaleString('sv-SE', opts);
    } catch (_) {
      return String(iso).slice(0, 19).replace('T', ' ');
    }
  };
})();
