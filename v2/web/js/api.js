// API client wrapper（V3：後端改為 Google Apps Script）
// 頁面用法不變：
//   const surveys = await API.get('/api/public/surveys');
//   const res = await API.post('/api/auth/login', { email, password });
// 實際傳輸：一律以 POST text/plain 送到 Apps Script 網址（避免跨網域預檢），
// 內容 { method, path, body, token }，回應 { status, body }。

window.API = (function () {
  const TOKEN_KEY = 'survey_admin_token';

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() :
      Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  // 同一頁面送出問卷時固定一組編號：連點或網路重送都只算一次
  let submitId = null;

  async function send(payload) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(window.API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload),
          redirect: 'follow'
        });
        const data = await r.json();
        // 503 = 鎖忙碌，稍候自動重試
        if (data.status === 503 && attempt < 2) { await new Promise(res => setTimeout(res, 800 * (attempt + 1))); continue; }
        return data;
      } catch (e) {
        lastErr = e;
        // 只有 GET 或帶去重編號的送出才自動重試，避免重複動作
        const safe = payload.method === 'GET' || (payload.body && payload.body.clientSubmitId);
        if (!safe || attempt >= 2) break;
        await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    throw new Error('網路連線失敗，請確認網路後再試一次' + (lastErr ? '（' + lastErr.message + '）' : ''));
  }

  async function req(method, path, body) {
    if (!window.API_BASE || window.API_BASE.indexOf('script.google.com') < 0) {
      throw new Error('尚未設定後端網址（config.js 的 API_BASE）');
    }
    if (method === 'POST' && path === '/api/public/survey') {
      if (!submitId) submitId = newId();
      body = Object.assign({ clientSubmitId: submitId }, body || {});
    }
    let ctoken;
    try { ctoken = localStorage.getItem('survey_ctoken') || undefined; } catch (_) {}
    const res = await send({ method, path, body, token: getToken() || undefined, ctoken });
    const status = res.status || 500;
    const data = res.body || {};
    if (status === 401) {
      clearToken();
      if (location.pathname.includes('/admin/') && !location.pathname.endsWith('login.html')) {
        location.href = 'login.html';
        return new Promise(() => {});
      }
    }
    if (status >= 400) throw new Error(data.message || data.error || ('HTTP ' + status));
    return data;
  }

  function downloadUrl(path) {
    // 下載類（CSV）直接開 Apps Script 的 GET 網址，token 放 query string
    return window.API_BASE + '?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(getToken() || '');
  }

  return {
    get: (path) => req('GET', path),
    post: (path, body) => req('POST', path, body || {}),
    put: (path, body) => req('PUT', path, body || {}),
    del: (path) => req('DELETE', path),
    getToken, setToken, clearToken,
    downloadUrl,
  };
})();
