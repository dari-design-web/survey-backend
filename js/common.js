// 共用：Tailwind 設定、後台 header 注入、登出
(function () {
  // Tailwind 自訂主題（CDN 模式）
  if (window.tailwind) {
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['"Noto Sans TC"', '"Microsoft JhengHei"', '"PingFang TC"', 'sans-serif'] },
          colors: {
            brand: { 50: '#EFF6FF', 100: '#DBEAFE', 500: '#3B82F6',
                     600: '#2563EB', 700: '#1D4ED8', 900: '#1E3A8A' }
          }
        }
      }
    };
  }

  // 後台 header 自動注入
  window.renderAdminHeader = function (currentTab) {
    const u = (function () {
      try {
        const tok = API.getToken();
        if (!tok) return null;
        const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return { name: p.name, email: p.email, role: p.role };
      } catch (_) { return null; }
    })();
    if (!u) {
      if (!location.pathname.endsWith('login.html')) location.href = 'login.html';
      return;
    }
    const canDash = u.role === 'super' || u.role === 'admin';
    const tabs = [
      canDash && ['dashboard', 'dashboard.html', '儀表板'],
      canDash && ['surveys', 'surveys.html', '問卷管理'],
      canDash && ['responses', 'responses.html', '填答資料'],
      canDash && ['coupons', 'coupons.html', '兌換券'],
      ['redeem', 'redeem.html', '核銷'],
      canDash && ['export', 'export.html', '匯出'],
      u.role === 'super' && ['users', 'users.html', '帳號']
    ].filter(Boolean);

    document.body.insertAdjacentHTML('afterbegin', `
      <header class="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <a href="dashboard.html" class="flex items-center gap-2 font-bold text-slate-900">
            <span class="inline-block w-7 h-7 rounded bg-brand-600 text-white text-center leading-7 text-sm">📋</span>
            <span class="text-base">滿意度管理系統</span>
          </a>
          <nav class="hidden md:flex items-center gap-1">
            ${tabs.map(([k, u, l]) =>
              `<a href="${u}" class="px-3 py-2 text-sm rounded ${k === currentTab ? 'bg-brand-50 text-brand-700 font-medium' : 'hover:bg-slate-100'}">${l}</a>`
            ).join('')}
          </nav>
          <div class="flex items-center gap-3">
            <span class="text-sm text-slate-600 hidden sm:block">${u.name} <span class="text-xs text-slate-400">(${u.role})</span></span>
            <button onclick="logout()" class="text-sm text-slate-500 hover:text-red-600">登出</button>
          </div>
        </div>
        <nav class="md:hidden border-t border-slate-200 px-3 py-2 flex overflow-x-auto gap-1 text-xs">
          ${tabs.map(([k, u, l]) =>
            `<a href="${u}" class="px-2 py-1 rounded whitespace-nowrap ${k === currentTab ? 'text-brand-700 font-bold' : 'hover:bg-slate-100'}">${l}</a>`
          ).join('')}
        </nav>
      </header>`);
  };

  window.logout = function () {
    API.clearToken();
    location.href = 'login.html';
  };
})();
