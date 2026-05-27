// API client wrapper
// 用法：const surveys = await API.get('/api/public/surveys');
//      const res = await API.post('/api/auth/login', { email, password });
//      API.setToken(res.token);

window.API = (function () {
  const TOKEN_KEY = 'survey_admin_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function req(method, path, body) {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tok = getToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;

    const opts = { method, headers, credentials: 'include' };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const r = await fetch(window.API_BASE + path, opts);
    if (r.status === 401) {
      clearToken();
      if (location.pathname.includes('/admin/') && !location.pathname.endsWith('login.html')) {
        location.href = 'login.html';
        return;
      }
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || data.error || ('HTTP ' + r.status));
      return data;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  }

  function downloadUrl(path) {
    // 加 token 至 query string，用於下載類 GET
    const tok = getToken();
    return window.API_BASE + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok || '');
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
