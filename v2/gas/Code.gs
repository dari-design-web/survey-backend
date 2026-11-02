/**
 * 滿意度問卷 + 贈品兌換券 + 贈品庫存 — Google Apps Script 後端（V3）
 *
 * 取代原 Replit Flask + Neon。資料存在「綁定的 Google 試算表」各分頁。
 * 前台（GitHub Pages）以 POST text/plain JSON 呼叫：
 *   { method: 'GET'|'POST'|'PUT'|'DELETE', path: '/api/...?...', body: {...}, token: '...' }
 * 回應：{ status: 200, body: {...} }
 * 下載（CSV）：GET  <exec網址>?path=/api/admin/export/...&token=...
 *
 * 首次安裝：在 Apps Script 編輯器執行 setup()，再「部署 → 網頁應用程式」。
 * 版本：見 CODE_VERSION。原始碼來源：GitHub dari-design-web/survey-backend /v2/gas/
 */

var CODE_VERSION = '3.3.2';
var GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/dari-design-web/survey-backend/main/v2/gas/';
var TZ = 'Asia/Taipei';
var JWT_TTL_HOURS = 8;
var ROLES_ALL = ['super', 'admin', 'staff'];
var ROLES_MGR = ['super', 'admin'];

// ============================================================
// 資料表結構（n=數字、s=文字、j=JSON）
// ============================================================
var SCHEMA = {
  surveys: {
    id: 'n', title: 's', description: 's', location_name: 's',
    start_date: 's', end_date: 's', is_active: 'n', generate_coupon: 'n',
    gift_id: 'n', coupon_valid_days: 'n', coupon_valid_hours: 'n', redemption_interval_days: 'n',
    redemption_location: 's', coupon_title: 's', coupon_subtitle: 's',
    coupon_code_prefix: 's', thank_you_message: 's',
    next_action_label: 's', next_action_url: 's', next_action_hint: 's',
    created_at: 's', updated_at: 's'
  },
  survey_questions: {
    id: 'n', survey_id: 'n', question_text: 's', question_type: 's',
    is_required: 'n', options: 'j', sort_order: 'n', is_active: 'n',
    include_in_statistics: 'n', is_satisfaction_score: 'n', is_overall_score: 'n',
    display_condition: 'j', created_at: 's', updated_at: 's'
  },
  users: { id: 'n', external_id: 's', name: 's', phone: 's', email: 's', created_at: 's' },
  survey_responses: {
    id: 'n', survey_id: 'n', user_id: 'n', client_submit_id: 's',
    submitted_at: 's', result: 'j'
  },
  survey_answers: {
    id: 'n', response_id: 'n', question_id: 'n', question_text: 's', question_type: 's',
    answer_text: 's', answer_value: 'n', created_at: 's'
  },
  coupons: {
    id: 'n', coupon_code: 's', survey_id: 'n', response_id: 'n', user_id: 'n',
    gift_id: 'n', gift_name: 's', qr_code_value: 's', status: 's',
    issued_at: 's', expires_at: 's', redeemed_at: 's', redeemed_by: 'n',
    voided_at: 's', voided_by: 'n'
  },
  gifts: {
    id: 'n', name: 's', description: 's', is_active: 'n', low_stock_alert: 'n', image_version: 's',
    // 以下三欄為「顯示用快照」，真正數字一律由 stock_logs 與 coupons 計算
    on_hand: 'n', reserved: 'n', available: 'n',
    created_at: 's', updated_at: 's'
  },
  stock_logs: {
    id: 'n', gift_id: 'n', action: 's', on_hand_delta: 'n', coupon_id: 'n',
    admin_user_id: 'n', note: 's', on_hand_after: 'n', created_at: 's'
  },
  redemption_logs: {
    id: 'n', coupon_id: 'n', user_id: 'n', action: 's', status_before: 's',
    status_after: 's', admin_user_id: 'n', note: 's', created_at: 's'
  },
  admin_users: {
    id: 'n', name: 's', email: 's', password_hash: 's', role: 's',
    is_active: 'n', last_login_at: 's', created_at: 's'
  },
  audit_logs: {
    id: 'n', admin_user_id: 'n', action: 's', target_type: 's', target_id: 's',
    detail: 's', created_at: 's'
  },
  coupon_sequences: { id: 'n', seq_key: 's', seq: 'n' },
  // 贈品圖片（方形 JPEG，前端已縮小）：base64 依 45,000 字元切段存放，避開儲存格上限
  gift_images: { id: 'n', gift_id: 'n', ver: 's', seq: 'n', data: 's', created_at: 's' }
};

// ============================================================
// 儲存層：每個請求內快取整張分頁
// ============================================================
var Store = (function () {
  var cache = {};

  function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

  function fields(name) { return Object.keys(SCHEMA[name]); }

  function sheet(name) {
    var sp = ss();
    var sh = sp.getSheetByName(name);
    var flds = fields(name);
    if (!sh) {
      sh = sp.insertSheet(name);
      sh.getRange(1, 1, 1, flds.length).setValues([flds]);
      sh.setFrozenRows(1);
      // 文字欄位設為純文字，避免日期／數字被自動轉換
      flds.forEach(function (f, i) {
        if (SCHEMA[name][f] !== 'n') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      });
    }
    return sh;
  }

  function decode(type, v) {
    if (v === '' || v === null || v === undefined) return null;
    if (type === 'n') { var n = Number(v); return isNaN(n) ? null : n; }
    if (type === 'j') {
      try { return JSON.parse(String(v)); } catch (e) { return String(v); }
    }
    var s = String(v);
    if (/^'[=+\-@]/.test(s)) s = s.slice(1);
    return s;
  }

  function encode(type, v) {
    if (v === null || v === undefined) return '';
    if (type === 'n') {
      if (typeof v === 'boolean') return v ? 1 : 0;
      var n = Number(v); return isNaN(n) ? '' : n;
    }
    if (type === 'j') return JSON.stringify(v);
    var s = String(v);
    if (/^[=+@]/.test(s)) s = "'" + s;   // 防公式注入
    return s;
  }

  function load(name) {
    if (cache[name]) return cache[name];
    var sh = sheet(name);
    var values = sh.getDataRange().getValues();
    var header = values[0] || [];
    var flds = fields(name);
    // 欄位補齊（日後新增欄位時）
    var missing = flds.filter(function (f) { return header.indexOf(f) < 0; });
    if (missing.length) {
      var start = header.length + 1;
      sh.getRange(1, start, 1, missing.length).setValues([missing]);
      missing.forEach(function (f, i) {
        if (SCHEMA[name][f] !== 'n') sh.getRange(1, start + i, sh.getMaxRows(), 1).setNumberFormat('@');
      });
      header = header.concat(missing);
    }
    var col = {};
    header.forEach(function (h, i) { col[h] = i; });
    var items = [], rowOf = {}, maxId = 0;
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (row[col.id] === '' || row[col.id] === null) continue;
      var obj = {};
      flds.forEach(function (f) { obj[f] = decode(SCHEMA[name][f], row[col[f]]); });
      items.push(obj);
      rowOf[obj.id] = r + 1;
      if (obj.id > maxId) maxId = obj.id;
    }
    cache[name] = { sh: sh, header: header, col: col, items: items, rowOf: rowOf, maxId: maxId };
    return cache[name];
  }

  function toRow(t, obj) {
    var row = [];
    for (var i = 0; i < t.header.length; i++) {
      var f = t.header[i];
      row.push(obj.hasOwnProperty(f) ? encode(typeOf(t, f), obj[f]) : '');
    }
    return row;
  }

  function typeOf(t, f) { return t.types[f] || 's'; }

  function prep(name) {
    var t = load(name);
    if (!t.types) t.types = SCHEMA[name];
    return t;
  }

  function all(name) { return prep(name).items; }

  function get(name, id) {
    id = Number(id);
    var items = all(name);
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function findOne(name, pred) {
    var items = all(name);
    for (var i = 0; i < items.length; i++) if (pred(items[i])) return items[i];
    return null;
  }

  function find(name, pred) { return all(name).filter(pred); }

  function insertMany(name, objs) {
    if (!objs.length) return [];
    touch(name);
    var t = prep(name);
    var startRow = t.sh.getLastRow() + 1;
    var rows = objs.map(function (o) {
      t.maxId += 1;
      o.id = t.maxId;
      SCHEMA_FILL(name, o);
      return toRow(t, o);
    });
    t.sh.getRange(startRow, 1, rows.length, t.header.length).setValues(rows);
    objs.forEach(function (o, i) {
      t.items.push(o);
      t.rowOf[o.id] = startRow + i;
    });
    return objs;
  }

  function insert(name, obj) { return insertMany(name, [obj])[0]; }

  function update(name, id, patch) {
    touch(name);
    var t = prep(name);
    var it = get(name, id);
    if (!it) return null;
    for (var k in patch) if (patch.hasOwnProperty(k) && SCHEMA[name].hasOwnProperty(k)) it[k] = patch[k];
    t.sh.getRange(t.rowOf[it.id], 1, 1, t.header.length).setValues([toRow(t, it)]);
    return it;
  }

  function remove(name, id) {
    touch(name);
    var t = prep(name);
    id = Number(id);
    var r = t.rowOf[id];
    if (!r) return;
    t.sh.deleteRow(r);
    t.items = t.items.filter(function (x) { return x.id !== id; });
    delete t.rowOf[id];
    for (var k in t.rowOf) if (t.rowOf[k] > r) t.rowOf[k] -= 1;
  }

  function reset() { cache = {}; }

  // 問卷、題目、贈品有變動 → 讓公開頁快取失效
  function touch(name) {
    if (name === 'surveys' || name === 'survey_questions' || name === 'gifts' || name === 'gift_images') bumpPublicCache();
  }

  return { all: all, get: get, find: find, findOne: findOne, insert: insert,
           insertMany: insertMany, update: update, remove: remove, reset: reset, sheet: sheet };
})();

// ============================================================
// 公開頁快取（問卷列表、問卷內容）：減少讀試算表的次數
// ============================================================
function publicCacheGen() {
  try { return CacheService.getScriptCache().get('pubgen') || '0'; } catch (e) { return '0'; }
}
function bumpPublicCache() {
  try { CacheService.getScriptCache().put('pubgen', String(Date.now()) + Math.random(), 21600); } catch (e) { /* ignore */ }
}

function SCHEMA_FILL(name, o) {
  Object.keys(SCHEMA[name]).forEach(function (f) { if (!o.hasOwnProperty(f)) o[f] = null; });
}

// ============================================================
// 共用工具
// ============================================================
function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function tpeDate(d) { return Utilities.formatDate(d || new Date(), TZ, 'yyyy-MM-dd'); }
function tpeDateOfIso(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso).slice(0, 10) : tpeDate(d);
}
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function parseDate(s) { if (!s) return null; var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function bool01(v) { return v ? 1 : 0; }
function str(v) { return v === null || v === undefined ? '' : String(v); }

function HttpError(status, message) { this.status = status; this.message = message; }

function fail(status, message) { throw new HttpError(status, message); }

function shortLabel(text, maxLen) {
  maxLen = maxLen || 28;
  if (!text) return '';
  var first = String(text).split('\n')[0].trim();
  var prefixes = ['請問您對', '請問您', '您對', '您'];
  for (var i = 0; i < prefixes.length; i++) {
    if (first.indexOf(prefixes[i]) === 0) { first = first.slice(prefixes[i].length); break; }
  }
  first = first.replace(/[？?的滿意度]+$/, '');
  if (first.length > maxLen) first = first.slice(0, maxLen) + '…';
  return first || String(text).split('\n')[0];
}

function parseList(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    var p = JSON.parse(raw);
    return Array.isArray(p) ? p : [raw];
  } catch (e) { return [raw]; }
}

function questionOptions(q) {
  var o = q.options;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = o.split('\n'); } }
  return Array.isArray(o) ? o.map(String) : [];
}

// ============================================================
// 認證：JWT（HS256）、密碼雜湊
// ============================================================
function props() { return PropertiesService.getScriptProperties(); }

function jwtSecret() {
  var s = props().getProperty('JWT_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props().setProperty('JWT_SECRET', s); }
  return s;
}

function b64url(bytesOrStr) {
  return Utilities.base64EncodeWebSafe(bytesOrStr).replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString('UTF-8');
}

function signToken(u) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(Utilities.newBlob(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).getBytes());
  var payload = b64url(Utilities.newBlob(JSON.stringify({
    sub: u.id, name: u.name, email: u.email, role: u.role,
    iat: now, exp: now + JWT_TTL_HOURS * 3600
  })).getBytes());
  var sig = b64url(Utilities.computeHmacSha256Signature(header + '.' + payload, jwtSecret()));
  return header + '.' + payload + '.' + sig;
}

function verifyToken(tok) {
  if (!tok) return null;
  var parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  var sig = b64url(Utilities.computeHmacSha256Signature(parts[0] + '.' + parts[1], jwtSecret()));
  if (sig !== parts[2]) return null;
  try {
    var p = JSON.parse(b64urlDecode(parts[1]));
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    // 帳號被停用或角色變更時立即生效
    var u = Store.get('admin_users', p.sub);
    if (!u || !u.is_active || u.role !== p.role) return null;
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  } catch (e) { return null; }
}

function bytesToHex(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

function hashPassword(plain, salt, iterations) {
  salt = salt || Utilities.getUuid().replace(/-/g, '');
  iterations = iterations || 300;
  var h = salt + ':' + plain;
  for (var i = 0; i < iterations; i++) {
    h = bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + plain, Utilities.Charset.UTF_8));
  }
  return 'sha256$' + iterations + '$' + salt + '$' + h;
}

function verifyPassword(plain, stored) {
  if (!stored || !plain) return false;
  var p = String(stored).split('$');
  if (p.length !== 4 || p[0] !== 'sha256') return false;
  return hashPassword(plain, p[2], Number(p[1])) === stored;
}

function audit(ctx, action, targetType, targetId, detail) {
  Store.insert('audit_logs', {
    admin_user_id: ctx.user ? ctx.user.id : null, action: action,
    target_type: targetType || null, target_id: targetId === undefined || targetId === null ? null : String(targetId),
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    created_at: nowIso()
  });
}

// ============================================================
// 贈品庫存（核心規則）
//   實際庫存 on_hand = Σ stock_logs.on_hand_delta
//   預留 reserved    = 該贈品「已發出、未核銷、未過期」的券數
//   可用 available   = on_hand − reserved
//   發券時須 available ≥ 1（= 預扣）；核銷時寫一筆 −1 的 redeem 紀錄
//   券逾期或作廢 → 自動不再計入 reserved（只會釋放一次，因為是即時計算）
// ============================================================
function giftStock(giftId, at) {
  giftId = Number(giftId);
  var now = at || new Date();
  var onHand = 0, outByCoupon = {};
  Store.all('stock_logs').forEach(function (l) {
    if (l.gift_id !== giftId) return;
    onHand += (l.on_hand_delta || 0);
    if (l.coupon_id && (l.action === 'redeem' || l.action === 'reconcile')) outByCoupon[l.coupon_id] = (outByCoupon[l.coupon_id] || 0) + (l.on_hand_delta || 0);
  });
  var reserved = 0;
  Store.all('coupons').forEach(function (c) {
    if (c.gift_id !== giftId || c.status !== 'issued') return;
    var exp = parseDate(c.expires_at);
    if (exp && exp <= now) return;
    if ((outByCoupon[c.id] || 0) < 0) return;   // 已出庫、核銷尚未完成：不再重複預留
    reserved += 1;
  });
  return { on_hand: onHand, reserved: reserved, available: onHand - reserved };
}

function refreshGiftSnapshot(giftId) {
  if (!giftId) return;
  var s = giftStock(giftId);
  Store.update('gifts', giftId, { on_hand: s.on_hand, reserved: s.reserved, available: s.available, updated_at: nowIso() });
  return s;
}

function addStockLog(giftId, action, delta, couponId, adminId, note) {
  var after = giftStock(giftId).on_hand + delta;
  return Store.insert('stock_logs', {
    gift_id: Number(giftId), action: action, on_hand_delta: delta, coupon_id: couponId || null,
    admin_user_id: adminId || null, note: note || '', on_hand_after: after, created_at: nowIso()
  });
}

// ============================================================
// 兌換券
// ============================================================
function couponSeq(dateKey, prefix) {
  var key = prefix + '_' + dateKey;
  var row = Store.findOne('coupon_sequences', function (x) { return x.seq_key === key; });
  if (!row) { Store.insert('coupon_sequences', { seq_key: key, seq: 1 }); return 1; }
  Store.update('coupon_sequences', row.id, { seq: row.seq + 1 });
  return row.seq;
}

function generateCouponCode(prefix) {
  var p = (str(prefix).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)) || 'GIFT';
  var dateKey = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  var seq = couponSeq(dateKey, p);
  var rand = Utilities.getUuid().replace(/-/g, '').slice(0, 4).toUpperCase();
  return p + '-' + dateKey + '-' + ('000' + seq).slice(-4) + '-' + rand;
}

function displayStatus(c, now) {
  if (c.status === 'issued') {
    var exp = parseDate(c.expires_at);
    if (exp && exp <= (now || new Date())) return 'expired';
  }
  return c.status;
}

/** 台灣時間下個月 1 日 00:00 */
function nextMonthStart(now) {
  var ym = tpeDate(now).slice(0, 7).split('-');
  var y = Number(ym[0]), m = Number(ym[1]);     // m：1–12
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, -8, 0, 0));
}

/**
 * 領券資格（每個帳號／裝置）：
 *  1) 手上已有尚未使用、未逾期的券（任何問卷）→ 回傳那張券
 *  2) 本月（台灣時間自然月）已兌換過任何問卷的贈品 → 下個月 1 日起才能再領
 *  逾期未兌換或作廢的券不算，可以重新領取。
 */
function checkEligibility(userId, surveyId) {
  var now = new Date();
  var mine = Store.find('coupons', function (c) { return c.user_id === userId; });
  if (!mine.length) return { eligible: true };
  var valid = mine.filter(function (c) { return displayStatus(c, now) === 'issued'; })
    .sort(function (a, b) { return (a.survey_id === surveyId ? 0 : 1) - (b.survey_id === surveyId ? 0 : 1) || (str(b.issued_at) < str(a.issued_at) ? -1 : 1); });
  if (valid.length) {
    return { eligible: false, reason: 'existing_coupon', message: '您已有一張尚未使用的兌換券。', existing_coupon: valid[0] };
  }
  var month = tpeDate(now).slice(0, 7);
  var used = mine.filter(function (c) { return c.status === 'redeemed' && tpeDateOfIso(c.redeemed_at || c.issued_at).slice(0, 7) === month; });
  if (used.length) {
    var nxt = nextMonthStart(now);
    return { eligible: false, reason: 'monthly_limit',
      message: '每個帳號每月限領一次，您本月已兌換過贈品，' + tpeDate(nxt) + ' 起可再領取。',
      next_eligible_date: nxt.toISOString() };
  }
  return { eligible: true };
}

function giftAvailableForSurvey(s) {
  if (!s.gift_id) return { ok: true };
  var g = Store.get('gifts', s.gift_id);
  if (!g || !g.is_active) return { ok: false };
  var st = giftStock(g.id);
  return { ok: st.available >= 1, gift: g, stock: st };
}

function issueCoupon(userId, s, responseId) {
  var g = s.gift_id ? Store.get('gifts', s.gift_id) : null;
  var now = new Date();
  var code = generateCouponCode(s.coupon_code_prefix || 'GIFT');
  var c = Store.insert('coupons', {
    coupon_code: code, survey_id: s.id, response_id: responseId, user_id: userId,
    gift_id: g ? g.id : null, gift_name: g ? g.name : null, qr_code_value: code,
    status: 'issued', issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + couponValidHours(s) * 3600000).toISOString(),
    redeemed_at: null, redeemed_by: null, voided_at: null, voided_by: null
  });
  Store.insert('redemption_logs', {
    coupon_id: c.id, user_id: userId, action: 'issue', status_before: null, status_after: 'issued',
    admin_user_id: null, note: '問卷完成發券', created_at: nowIso()
  });
  if (g) refreshGiftSnapshot(g.id);
  return c;
}

/** 兌換期限（小時）。預設 24 小時；逾時未兌換即取消，預留自動回到可發庫存 */
function couponValidHours(s) {
  if (s.coupon_valid_hours) return s.coupon_valid_hours;
  if (s.coupon_valid_days) return s.coupon_valid_days * 24;
  return 24;
}

function markExpired(c) {
  if (c.status === 'issued' && displayStatus(c) === 'expired') {
    Store.update('coupons', c.id, { status: 'expired' });
    Store.insert('redemption_logs', {
      coupon_id: c.id, user_id: c.user_id, action: 'expire', status_before: 'issued', status_after: 'expired',
      admin_user_id: null, note: '逾期', created_at: nowIso()
    });
    if (c.gift_id) refreshGiftSnapshot(c.gift_id);
    return true;
  }
  return false;
}

function redeemCoupon(code, adminId) {
  code = str(code).trim();
  var c = Store.findOne('coupons', function (x) { return x.coupon_code === code; });
  if (!c) return { ok: false, status: 'invalid', message: '無效兌換券：查無此編號。' };
  if (markExpired(c)) return { ok: false, status: 'expired', message: '此券已逾期。', coupon: c };
  if (c.status === 'redeemed') return { ok: false, status: 'already_redeemed', message: '此券已於 ' + c.redeemed_at + ' 使用過。', coupon: c };
  if (c.status === 'expired') return { ok: false, status: 'expired', message: '此券已逾期。', coupon: c };
  if (c.status === 'voided') return { ok: false, status: 'voided', message: '此券已被作廢。', coupon: c };
  if (c.status !== 'issued') return { ok: false, status: 'invalid', message: '此券狀態異常。', coupon: c };
  // 先寫出庫紀錄（每張券最多一筆），再改券狀態。中途失敗時只會「少算可發」，不會超發；
  // 重試時不會重複出庫，未完成者由每日對帳處理。
  if (c.gift_id && couponStockNet(c.id) === 0) addStockLog(c.gift_id, 'redeem', -1, c.id, adminId, '核銷 ' + c.coupon_code);
  var updated = Store.update('coupons', c.id, { status: 'redeemed', redeemed_at: nowIso(), redeemed_by: adminId });
  if (c.gift_id) refreshGiftSnapshot(c.gift_id);
  Store.insert('redemption_logs', {
    coupon_id: c.id, user_id: c.user_id, action: 'redeem', status_before: 'issued', status_after: 'redeemed',
    admin_user_id: adminId, note: '工作人員核銷', created_at: nowIso()
  });
  return { ok: true, status: 'redeemed', message: '核銷成功！', coupon: updated };
}

/** 某張券在庫存紀錄中的淨出庫數（核銷 −1、對帳回補 +1） */
function couponStockNet(couponId) {
  var n = 0;
  Store.all('stock_logs').forEach(function (l) {
    if (l.coupon_id === couponId && (l.action === 'redeem' || l.action === 'reconcile')) n += (l.on_hand_delta || 0);
  });
  return n;
}

function intervalDays(s) {
  var v = s.redemption_interval_days;
  return v === null || v === undefined || v === '' || isNaN(Number(v)) ? 30 : Math.max(0, Number(v));
}

function voidCoupon(id, adminId, note) {
  var c = Store.get('coupons', id);
  if (!c) return { ok: false, message: '查無此兌換券。' };
  if (c.status === 'redeemed') return { ok: false, message: '已核銷之券無法作廢。' };
  if (c.status === 'voided') return { ok: false, message: '此券已作廢。' };
  var before = c.status;
  Store.update('coupons', c.id, { status: 'voided', voided_at: nowIso(), voided_by: adminId });
  Store.insert('redemption_logs', {
    coupon_id: c.id, user_id: c.user_id, action: 'void', status_before: before, status_after: 'voided',
    admin_user_id: adminId, note: note || '管理者作廢', created_at: nowIso()
  });
  if (c.gift_id) refreshGiftSnapshot(c.gift_id);
  return { ok: true, message: '已作廢。' };
}

// ============================================================
// 公開 API
// ============================================================
function publicSurvey(s) {
  var g = s.gift_id ? Store.get('gifts', s.gift_id) : null;
  return {
    id: s.id, title: s.title, description: s.description, location_name: s.location_name,
    coupon_title: s.coupon_title, coupon_subtitle: s.coupon_subtitle,
    redemption_location: s.redemption_location, thank_you_message: s.thank_you_message,
    is_active: s.is_active, generate_coupon: s.generate_coupon,
    gift_name: g ? g.name : null, gift_id: g ? g.id : null, gift_image: g && g.image_version ? g.image_version : null,
    next_action_label: s.next_action_label || '', next_action_url: s.next_action_url || '',
    next_action_hint: s.next_action_hint || ''
  };
}

function publicQuestion(q) {
  return {
    id: q.id, question_text: q.question_text, question_type: q.question_type,
    is_required: q.is_required, options: q.options, sort_order: q.sort_order || 0,
    display_condition: q.display_condition
  };
}

function surveyOpenState(s) {
  if (!s) return 'not_found';
  if (!s.is_active) return 'inactive';
  var today = tpeDate();
  if (s.start_date && s.start_date > today) return 'not_started';
  if (s.end_date && s.end_date < today) return 'ended';
  return 'open';
}

var CLOSED_MSG = { not_found: '找不到此問卷', inactive: '此問卷已停用', not_started: '此問卷尚未開始', ended: '此問卷已結束' };

function requireOpenSurvey(sid) {
  var s = Store.get('surveys', sid);
  var st = surveyOpenState(s);
  if (st !== 'open') fail(st === 'not_found' ? 404 : 403, CLOSED_MSG[st]);
  return s;
}

function sortQuestions(qs) {
  return qs.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id; });
}

function apiListSurveys() {
  var items = Store.all('surveys').filter(function (s) { return surveyOpenState(s) === 'open'; })
    .map(publicSurvey).sort(function (a, b) { return b.id - a.id; });
  return { surveys: items };
}

function apiGetSurvey(ctx, m) {
  var s = requireOpenSurvey(Number(m[1]));
  var qs = sortQuestions(Store.find('survey_questions', function (q) { return q.survey_id === s.id && q.is_active; }));
  return { survey: publicSurvey(s), questions: qs.map(publicQuestion) };
}

function apiGetCoupon(ctx, m) {
  var code = decodeURIComponent(m[1]);
  var c = Store.findOne('coupons', function (x) { return x.coupon_code === code; });
  if (!c) fail(404, 'not_found');
  var s = Store.get('surveys', c.survey_id);
  var out = {};
  for (var k in c) out[k] = c[k];
  out.status = displayStatus(c);
  delete out.user_id; delete out.redeemed_by; delete out.voided_by;
  return { coupon: out, survey: s ? publicSurvey(s) : null };
}

// ============================================================
// 填答者身分：啟用 Google 登入後以 Google 帳號辨識；未啟用時沿用裝置識別碼
// ============================================================
function googleClientId() { return props().getProperty('GOOGLE_CLIENT_ID') || ''; }
function loginRequired() { return !!googleClientId(); }

function sha256Hex(text) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

function signJwt(payload) {
  var header = b64url(Utilities.newBlob(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).getBytes());
  var body = b64url(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  return header + '.' + body + '.' + b64url(Utilities.computeHmacSha256Signature(header + '.' + body, jwtSecret()));
}

function readJwt(tok) {
  if (!tok) return null;
  var parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  if (b64url(Utilities.computeHmacSha256Signature(parts[0] + '.' + parts[1], jwtSecret())) !== parts[2]) return null;
  try {
    var p = JSON.parse(b64urlDecode(parts[1]));
    return p.exp && p.exp >= Math.floor(Date.now() / 1000) ? p : null;
  } catch (e) { return null; }
}

/** 客人登入憑證（30 天）：只含系統內部使用者編號 */
function signCustomer(u) {
  var now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: u.id, role: 'customer', iat: now, exp: now + 30 * 86400 });
}

function customerFromToken(tok) {
  var p = readJwt(tok);
  if (!p || p.role !== 'customer') return null;
  return Store.get('users', p.sub);
}

/** 依目前模式找出填答者；create=true 時（送出問卷）不存在就建立裝置使用者 */
function resolveUser(ctx, deviceId, create) {
  if (loginRequired()) {
    var u = customerFromToken(ctx.ctoken);
    if (!u && create) fail(403, '請先登入 Google 帳號再填寫問卷');
    return u;
  }
  if (!deviceId) return null;
  var found = userByDevice(deviceId);
  if (found || !create) return found;
  return Store.insert('users', { external_id: 'device:' + deviceId, name: '匿名民眾', phone: null, email: null, created_at: nowIso() });
}

function apiPublicConfig() {
  return { ok: true, login_required: loginRequired(), google_client_id: googleClientId() || null };
}

/** Google 登入：驗證 ID token，帳號只存「google:」＋ sub 的雜湊，不存姓名與 Email */
function apiGoogleLogin(ctx) {
  var cid = googleClientId();
  if (!cid) fail(400, '尚未啟用 Google 登入');
  var cred = str((ctx.body || {}).credential);
  if (!cred || cred.length > 4096) fail(400, '登入資料不完整');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail(401, 'Google 登入驗證失敗，請再試一次');
  var p = JSON.parse(res.getContentText());
  if (p.aud !== cid) fail(401, 'Google 登入驗證失敗（用戶端不符）');
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') fail(401, 'Google 登入驗證失敗');
  if (!p.exp || Number(p.exp) * 1000 < Date.now()) fail(401, 'Google 登入已逾時，請重新登入');
  if (!p.sub) fail(401, 'Google 登入驗證失敗');
  // 只接受 Google 已驗證 Email 的帳號（帳號鍵仍是 sub，不以 Email 識別）
  if (!(p.email_verified === true || p.email_verified === 'true')) fail(401, '此 Google 帳號的 Email 尚未驗證，請改用其他帳號');
  var key = 'google:' + sha256Hex('google|' + p.sub).slice(0, 40);
  // 驗證向 Google 查詢較慢，放在鎖外；只有建立使用者時才取得鎖，避免拖慢發券與核銷
  var u = Store.findOne('users', function (x) { return x.external_id === key; });
  if (!u) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) fail(503, '目前使用人數較多，請稍後再試一次');
    try {
      Store.reset();
      u = Store.findOne('users', function (x) { return x.external_id === key; }) ||
        Store.insert('users', { external_id: key, name: 'Google 使用者', phone: null, email: null, created_at: nowIso() });
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
  }
  return { ok: true, ctoken: signCustomer(u) };
}

function apiSetGoogleClient(ctx) {
  var cid = str((ctx.body || {}).client_id).trim();
  if (cid && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cid)) fail(400, 'Client ID 格式不正確（應為 xxxx.apps.googleusercontent.com）');
  if (cid) props().setProperty('GOOGLE_CLIENT_ID', cid); else props().deleteProperty('GOOGLE_CLIENT_ID');
  bumpPublicCache();
  audit(ctx, 'set_google_client', 'system', null, { enabled: !!cid });
  return { ok: true, login_required: !!cid };
}

function userByDevice(deviceId) {
  if (!deviceId) return null;
  return Store.findOne('users', function (x) { return x.external_id === 'device:' + deviceId; });
}

function apiMyCoupons(ctx) {
  var u = resolveUser(ctx, ctx.query.deviceId, false);
  if (!u) return { ok: true, coupons: [], need_login: loginRequired() };
  var now = new Date();
  var cutoff = addDays(now, -30);
  var surveys = {};
  Store.all('surveys').forEach(function (s) { surveys[s.id] = s; });
  var order = { issued: 0, expired: 1, redeemed: 2, voided: 3, invalid: 4 };
  // 新版：只「隱藏」超過 30 天的舊券，不刪除資料（統計與庫存憑據需保留）
  var keep = Store.find('coupons', function (c) { return c.user_id === u.id; }).map(function (c) {
    var st = displayStatus(c, now);
    var ref = st === 'redeemed' ? c.redeemed_at : st === 'voided' ? (c.voided_at || c.issued_at) : st === 'expired' ? c.expires_at : null;
    if (ref && parseDate(ref) < cutoff) return null;
    var s = surveys[c.survey_id] || {};
    return {
      id: c.id, coupon_code: c.coupon_code, qr_code_value: c.qr_code_value, status: st,
      issued_at: c.issued_at, expires_at: c.expires_at, redeemed_at: c.redeemed_at,
      survey_id: c.survey_id, survey_title: s.title, location_name: s.location_name,
      coupon_title: s.coupon_title, redemption_location: s.redemption_location, gift_name: c.gift_name, gift_id: c.gift_id
    };
  }).filter(Boolean);
  keep.sort(function (a, b) { return (order[a.status] - order[b.status]) || (b.id - a.id); });
  return { ok: true, coupons: keep, deleted_count: 0 };
}

function apiPrecheck(ctx, m) {
  var s = Store.get('surveys', Number(m[1]));
  var st = surveyOpenState(s);
  if (st !== 'open') fail(404, CLOSED_MSG[st]);
  var u = resolveUser(ctx, ctx.query.deviceId, false);
  var needLogin = loginRequired() && !u;
  if (!s.generate_coupon) return { ok: true, eligible: true, generate_coupon: false, login_required: loginRequired(), need_login: needLogin };
  var stockOk = giftAvailableForSurvey(s).ok;
  var out = { ok: true, generate_coupon: true, login_required: loginRequired(), need_login: needLogin };
  if (u) {
    var r = checkEligibility(u.id, s.id);
    if (!r.eligible) {
      out.eligible = false; out.reason = r.reason; out.message = r.message;
      if (r.next_eligible_date) out.nextDate = tpeDate(new Date(r.next_eligible_date));
      if (r.existing_coupon) out.existingCouponCode = r.existing_coupon.coupon_code;
      return out;
    }
  }
  if (!stockOk) {
    out.eligible = false; out.reason = 'out_of_stock';
    out.message = '本期贈品已兌換完畢，仍歡迎填寫問卷提供意見。';
    return out;
  }
  out.eligible = u ? true : 'new';
  return out;
}

/** 評分題設定存在 options：第 1 行＝1 分說明、第 2 行＝5 分說明；含「未使用／不適用」則提供該選項。未設定（舊題目）時沿用預設並提供。 */
var RATING_NA = '未使用／不適用';
function ratingAllowsNA(opts) {
  if (!opts || !opts.length) return true;
  return opts.indexOf(RATING_NA) >= 0;
}

function conditionMet(q, ansByQ, qmap, seen) {
  seen = seen || {};
  if (seen[q.id]) return false;          // 循環設定：視為不顯示，避免無限遞迴
  seen[q.id] = true;
  var cond = q.display_condition;
  if (!cond || typeof cond !== 'object') return true;
  var dep = Number(cond.depends_on), accept = cond.show_when;
  if (!dep || !accept) return true;
  if (!qmap[dep]) return true;
  // 依賴題本身不顯示 → 此題也不顯示
  if (!conditionMet(qmap[dep], ansByQ, qmap, seen)) return false;
  var a = ansByQ[dep];
  if (!a) return false;
  var v = a.value;
  if (v === null || v === undefined || v === '') return false;
  var list = (Array.isArray(accept) ? accept : [accept]).map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (!list.length) return true;
  var vals = Array.isArray(v) ? v : [v];
  return vals.some(function (item) {
    var s = String(item);
    return list.some(function (x) { return s === x || s.indexOf(x) === 0; });
  });
}

function isEmptyAnswer(v) { return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length); }

function matchesOption(val, opts) {
  if (!opts.length) return true;
  var s = String(val);
  return opts.some(function (o) { return s === o || s.indexOf(o + '：') === 0 || s.indexOf(o + ':') === 0; });
}

/** 驗證並整理答案，回傳 answer rows（不含 response_id） */
function validateAnswers(s, answers) {
  var qs = Store.find('survey_questions', function (q) { return q.survey_id === s.id && q.is_active; });
  var qmap = {};
  qs.forEach(function (q) { qmap[q.id] = q; });
  var ansByQ = {};
  answers.forEach(function (a) {
    if (!a || a.questionId === undefined || a.questionId === null) return;
    var qid = Number(a.questionId);
    if (!qmap[qid]) fail(400, '答案包含不屬於此問卷的題目');
    ansByQ[qid] = a;
  });
  var rows = [];
  sortQuestions(qs).forEach(function (q) {
    if (q.question_type === 'section') return;
    var visible = conditionMet(q, ansByQ, qmap);
    var a = ansByQ[q.id];
    var v = a ? a.value : null;
    if (!visible) return;                       // 隱藏題不儲存
    var title = String(q.question_text || '').split('\n')[0];
    if (isEmptyAnswer(v)) {
      if (q.is_required) fail(400, '必填題未填：' + title);
      return;
    }
    var t = q.question_type, text = null, value = null, opts = questionOptions(q);
    if (t === 'rating' || t === 'nps') {
      var num = Number(v);
      if (v === RATING_NA && t === 'rating') {
        if (!ratingAllowsNA(opts)) fail(400, '此題沒有「未使用／不適用」選項：' + title);
        text = String(v);
      }
      else if (isNaN(num) || num !== Math.floor(num) || (t === 'rating' && (num < 1 || num > 5)) || (t === 'nps' && (num < 0 || num > 10))) {
        fail(400, '分數超出範圍：' + title);
      } else { value = num; text = String(num); }
    } else if (t === 'multiple') {
      var arr = Array.isArray(v) ? v : [v];
      arr = arr.map(function (x) { return String(x).slice(0, 500); });
      arr.forEach(function (x) { if (!matchesOption(x, opts)) fail(400, '選項不正確：' + title); });
      text = JSON.stringify(arr);
    } else if (t === 'single' || t === 'select') {
      if (Array.isArray(v)) fail(400, '答案格式錯誤：' + title);
      if (!matchesOption(v, opts)) fail(400, '選項不正確：' + title);
      text = String(v).slice(0, 500);
    } else {
      text = String(Array.isArray(v) ? v.join('、') : v).slice(0, 2000);
      if (t === 'phone' && !/^[0-9+\-() ]{6,20}$/.test(text)) fail(400, '電話格式不正確：' + title);
    }
    rows.push({ question_id: q.id, question_text: q.question_text, question_type: t, answer_text: text, answer_value: value });
  });
  return rows;
}

function apiSubmitSurvey(ctx) {
  var b = ctx.body || {};
  if (!b.surveyId) fail(400, '缺少 surveyId');
  if (!Array.isArray(b.answers)) fail(400, 'answers 格式錯誤');
  if (b.answers.length > 300) fail(400, '答案數量異常');
  var s = requireOpenSurvey(Number(b.surveyId));
  var clientId = str(b.clientSubmitId).slice(0, 64) || null;

  // 重送去重：同一 clientSubmitId 回傳第一次的結果
  var deviceId = str(b.deviceId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!deviceId) deviceId = Utilities.getUuid().replace(/-/g, '');
  var existingUser = resolveUser(ctx, deviceId, false);
  if (loginRequired() && !existingUser) fail(403, '請先登入 Google 帳號再填寫問卷');

  // 去重只在「同一問卷＋同一裝置＋同一送出編號」時成立；其他裝置重用編號視為另一筆
  var dup = null;
  if (clientId && existingUser) {
    dup = Store.findOne('survey_responses', function (r) {
      // 新格式「編號@使用者」；相容 3.2.0 以前未加後綴的舊格式（仍限同問卷＋同使用者）
      return (r.client_submit_id === clientId + '@' + existingUser.id || r.client_submit_id === clientId) &&
        r.survey_id === s.id && r.user_id === existingUser.id;
    });
    if (dup && dup.result) { var res = dup.result; res.duplicate = true; return res; }
  }

  var rows = validateAnswers(s, b.answers);

  var u = existingUser || resolveUser(ctx, deviceId, true);

  var now = nowIso();
  var resp;
  if (dup) {
    // 上次送出中途失敗：沿用同一筆填答，清掉不完整的答案後重寫
    resp = dup;
    Store.find('survey_answers', function (a) { return a.response_id === dup.id; })
      .map(function (a) { return a.id; }).forEach(function (id) { Store.remove('survey_answers', id); });
  } else {
    resp = Store.insert('survey_responses', {
      survey_id: s.id, user_id: u.id, client_submit_id: clientId ? clientId + '@' + u.id : null, submitted_at: now, result: null
    });
  }
  Store.insertMany('survey_answers', rows.map(function (r) {
    r.response_id = resp.id; r.created_at = now; return r;
  }));

  var payload = { ok: true, message: '問卷送出成功，感謝您的回饋！', deviceId: loginRequired() ? null : deviceId, survey: publicSurvey(s) };
  if (s.generate_coupon) {
    var el = checkEligibility(u.id, s.id);
    var already = Store.findOne('coupons', function (x) { return x.response_id === resp.id; });
    if (already) {
      payload.message = '問卷送出成功，兌換券已產生！';
      payload.coupon = already;
    } else if (el.eligible) {
      if (giftAvailableForSurvey(s).ok) {
        var c = issueCoupon(u.id, s, resp.id);
        payload.message = '問卷送出成功，兌換券已產生！';
        payload.coupon = c;
      } else {
        payload.reason = 'out_of_stock';
        payload.message = '問卷送出成功！本期贈品已兌換完畢，感謝您的回饋。';
      }
    } else if (el.reason === 'existing_coupon') {
      payload.reason = 'existing_coupon';
      payload.message = '問卷送出成功，您已有一張未使用的兌換券。';
      payload.coupon = el.existing_coupon;
    } else {
      payload.reason = el.reason;
      payload.message = el.message;
      payload.nextDate = el.next_eligible_date || '';
    }
  }
  Store.update('survey_responses', resp.id, { result: payload });
  return payload;
}

// ============================================================
// 認證 API
// ============================================================
function apiLogin(ctx) {
  var b = ctx.body || {};
  var email = str(b.email).trim().toLowerCase(), pw = str(b.password);
  if (!email || !pw) fail(400, '缺少帳號或密碼');
  var cache = CacheService.getScriptCache();
  var key = 'loginfail:' + email;
  var fails = Number(cache.get(key) || 0);
  if (fails >= 5) fail(429, '登入失敗次數過多，請 10 分鐘後再試');
  var u = Store.findOne('admin_users', function (x) { return str(x.email).toLowerCase() === email; });
  if (!u || !u.is_active || !verifyPassword(pw, u.password_hash)) {
    cache.put(key, String(fails + 1), 600);
    fail(401, '帳號或密碼錯誤');
  }
  cache.remove(key);
  Store.update('admin_users', u.id, { last_login_at: nowIso() });
  var user = { id: u.id, name: u.name, email: u.email, role: u.role };
  return { ok: true, token: signToken(user), user: user };
}

// ============================================================
// 後台：問卷與題目
// ============================================================
function surveyPayload(b) {
  var prefix = str(b.coupon_code_prefix || 'GIFT').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'GIFT';
  var url = str(b.next_action_url).trim();
  if (url && !/^https?:\/\//i.test(url)) fail(400, '下一步引導網址須以 http:// 或 https:// 開頭');
  var giftId = b.gift_id ? Number(b.gift_id) : null;
  if (giftId && !Store.get('gifts', giftId)) fail(400, '指定的贈品不存在');
  return {
    title: b.title || '未命名問卷', description: b.description || null,
    location_name: b.location_name || null,
    start_date: b.start_date || null, end_date: b.end_date || null,
    is_active: bool01(b.is_active), generate_coupon: bool01(b.generate_coupon),
    gift_id: giftId,
    coupon_valid_hours: Math.max(1, Math.min(24 * 365, parseInt(b.coupon_valid_hours, 10) || 24)),
    coupon_valid_days: null,
    redemption_interval_days: Math.max(0, isNaN(parseInt(b.redemption_interval_days, 10)) ? 30 : parseInt(b.redemption_interval_days, 10)),
    redemption_location: b.redemption_location || null,
    coupon_title: b.coupon_title || '贈品兌換券',
    coupon_subtitle: b.coupon_subtitle || '感謝您完成滿意度調查',
    coupon_code_prefix: prefix, thank_you_message: b.thank_you_message || null,
    next_action_label: str(b.next_action_label).trim(), next_action_url: url,
    next_action_hint: str(b.next_action_hint).trim(),
    updated_at: nowIso()
  };
}

function apiAdminListSurveys() {
  var qc = {}, rc = {};
  Store.all('survey_questions').forEach(function (q) { qc[q.survey_id] = (qc[q.survey_id] || 0) + 1; });
  Store.all('survey_responses').forEach(function (r) { rc[r.survey_id] = (rc[r.survey_id] || 0) + 1; });
  var rows = Store.all('surveys').map(function (s) {
    var o = {}; for (var k in s) o[k] = s[k];
    o.question_count = qc[s.id] || 0; o.response_count = rc[s.id] || 0;
    var g = s.gift_id ? Store.get('gifts', s.gift_id) : null;
    o.gift_name = g ? g.name : null;
    return o;
  }).sort(function (a, b) { return b.id - a.id; });
  return { surveys: rows };
}

function apiAdminGetSurvey(ctx, m) {
  var s = Store.get('surveys', Number(m[1]));
  if (!s) fail(404, 'not_found');
  return { survey: s, questions: sortQuestions(Store.find('survey_questions', function (q) { return q.survey_id === s.id; })) };
}

function apiCreateSurvey(ctx) {
  var p = surveyPayload(ctx.body || {});
  p.created_at = nowIso();
  var s = Store.insert('surveys', p);
  audit(ctx, 'create_survey', 'survey', s.id, { title: s.title });
  return { ok: true, id: s.id };
}

function apiUpdateSurvey(ctx, m) {
  var id = Number(m[1]);
  if (!Store.get('surveys', id)) fail(404, 'not_found');
  Store.update('surveys', id, surveyPayload(ctx.body || {}));
  audit(ctx, 'update_survey', 'survey', id);
  return { ok: true };
}

function apiDuplicateSurvey(ctx, m) {
  var src = Store.get('surveys', Number(m[1]));
  if (!src) fail(404, 'not_found');
  var p = {}; for (var k in src) if (k !== 'id') p[k] = src[k];
  p.title = (p.title || '') + ' (複製)'; p.is_active = 0;
  p.created_at = nowIso(); p.updated_at = nowIso();
  var ns = Store.insert('surveys', p);
  var idMap = {};
  var srcQs = sortQuestions(Store.find('survey_questions', function (q) { return q.survey_id === src.id; }));
  srcQs.forEach(function (q) {
    var nq = {}; for (var k2 in q) if (k2 !== 'id') nq[k2] = q[k2];
    nq.survey_id = ns.id; nq.created_at = nowIso();
    idMap[q.id] = Store.insert('survey_questions', nq);
  });
  // 條件題的依賴題目 id 轉為新題目 id
  srcQs.forEach(function (q) {
    var dc = q.display_condition;
    if (dc && dc.depends_on && idMap[Number(dc.depends_on)]) {
      var ndc = { depends_on: idMap[Number(dc.depends_on)].id, show_when: dc.show_when };
      Store.update('survey_questions', idMap[q.id].id, { display_condition: ndc });
    }
  });
  audit(ctx, 'duplicate_survey', 'survey', ns.id);
  return { ok: true, id: ns.id };
}

function apiToggleSurvey(ctx, m) {
  var s = Store.get('surveys', Number(m[1]));
  if (!s) fail(404, 'not_found');
  var nxt = s.is_active ? 0 : 1;
  Store.update('surveys', s.id, { is_active: nxt, updated_at: nowIso() });
  audit(ctx, 'toggle_survey_active', 'survey', s.id, { is_active: nxt });
  return { ok: true, is_active: nxt };
}

function questionPayload(b) {
  var dc = b.display_condition;
  if (!(dc && typeof dc === 'object' && dc.depends_on && dc.show_when)) dc = null;
  var types = ['section', 'single', 'multiple', 'select', 'rating', 'nps', 'text', 'textarea', 'phone'];
  var t = types.indexOf(b.question_type) >= 0 ? b.question_type : 'text';
  return {
    question_text: b.question_text || '未命名題目', question_type: t,
    is_required: bool01(b.is_required), options: b.options === undefined ? null : b.options,
    sort_order: parseInt(b.sort_order, 10) || 0,
    is_active: b.is_active === false ? 0 : 1,
    include_in_statistics: b.include_in_statistics === false ? 0 : 1,
    is_satisfaction_score: bool01(b.is_satisfaction_score),
    is_overall_score: bool01(b.is_overall_score),
    display_condition: dc, updated_at: nowIso()
  };
}

/** 條件題設定檢查：依賴題須在同一問卷、不能依賴自己、不能形成循環 */
function checkCondition(surveyId, qid, dc) {
  if (!dc) return;
  var dep = Number(dc.depends_on);
  if (qid && dep === qid) fail(400, '顯示條件不能依賴題目本身');
  var depQ = Store.get('survey_questions', dep);
  if (!depQ || depQ.survey_id !== surveyId) fail(400, '顯示條件的依賴題目不存在或不屬於此問卷');
  var seen = {}, cur = depQ;
  while (cur && cur.display_condition && cur.display_condition.depends_on) {
    if (seen[cur.id]) break;
    seen[cur.id] = true;
    var next = Number(cur.display_condition.depends_on);
    if (qid && next === qid) fail(400, '顯示條件形成循環（A 依賴 B、B 又依賴 A），請修改');
    cur = Store.get('survey_questions', next);
  }
}

function apiCreateQuestion(ctx, m) {
  var sid = Number(m[1]);
  if (!Store.get('surveys', sid)) fail(404, 'not_found');
  var p = questionPayload(ctx.body || {});
  checkCondition(sid, null, p.display_condition);
  p.survey_id = sid; p.created_at = nowIso();
  var q = Store.insert('survey_questions', p);
  audit(ctx, 'create_question', 'question', q.id);
  return { ok: true, id: q.id, question: q };
}

function apiUpdateQuestion(ctx, m) {
  var id = Number(m[1]);
  var old = Store.get('survey_questions', id);
  if (!old) fail(404, 'not_found');
  var p = questionPayload(ctx.body || {});
  checkCondition(old.survey_id, id, p.display_condition);
  var q = Store.update('survey_questions', id, p);
  audit(ctx, 'update_question', 'question', id);
  return { ok: true, question: q };
}

function apiDeleteQuestion(ctx, m) {
  // 已填答的歷史答案保留題目文字快照，不受刪除影響
  Store.remove('survey_questions', Number(m[1]));
  audit(ctx, 'delete_question', 'question', m[1]);
  return { ok: true };
}

// ============================================================
// 後台：填答、意見、兌換券
// ============================================================
function indexBy(list, key) { var o = {}; list.forEach(function (x) { o[x[key]] = x; }); return o; }
function groupBy(list, key) { var o = {}; list.forEach(function (x) { (o[x[key]] = o[x[key]] || []).push(x); }); return o; }

function inDateRange(iso, df, dt) {
  var d = tpeDateOfIso(iso);
  if (df && d < df) return false;
  if (dt && d > dt) return false;
  return true;
}

function apiListResponses(ctx) {
  var q = ctx.query;
  var sid = q.survey_id ? Number(q.survey_id) : null;
  var minS = q.min_score !== undefined && q.min_score !== '' ? Number(q.min_score) : null;
  var maxS = q.max_score !== undefined && q.max_score !== '' ? Number(q.max_score) : null;
  var surveys = indexBy(Store.all('surveys'), 'id');
  var users = indexBy(Store.all('users'), 'id');
  var qmap = indexBy(Store.all('survey_questions'), 'id');
  var ansBy = groupBy(Store.all('survey_answers'), 'response_id');
  var cBy = indexBy(Store.all('coupons'), 'response_id');
  var rows = [];
  Store.all('survey_responses').forEach(function (r) {
    if (sid && r.survey_id !== sid) return;
    if (!inDateRange(r.submitted_at, q.date_from, q.date_to)) return;
    var sat = [], overall = null;
    (ansBy[r.id] || []).forEach(function (a) {
      var qq = qmap[a.question_id];
      if (!qq || a.answer_value === null) return;
      if (qq.is_satisfaction_score) sat.push(a.answer_value);
      if (qq.is_overall_score && overall === null) overall = a.answer_value;
    });
    var avg = sat.length ? Math.round(sat.reduce(function (x, y) { return x + y; }, 0) / sat.length * 100) / 100 : null;
    if (minS !== null && (avg === null || avg < minS)) return;
    if (maxS !== null && (avg === null || avg > maxS)) return;
    var s = surveys[r.survey_id] || {}, u = users[r.user_id] || {}, c = cBy[r.id] || {};
    rows.push({
      id: r.id, submitted_at: r.submitted_at, survey_id: r.survey_id, survey_title: s.title,
      location_name: s.location_name, user_id: r.user_id, user_name: u.name, phone: u.phone, email: u.email,
      avg_score: avg, overall_score: overall, sat_count: sat.length,
      coupon_code: c.coupon_code, coupon_status: c.coupon_code ? displayStatus(c) : null
    });
  });
  rows.sort(function (a, b) { return b.id - a.id; });
  return { rows: rows.slice(0, 500) };
}

function apiGetResponse(ctx, m) {
  var rid = Number(m[1]);
  var r = Store.get('survey_responses', rid);
  if (!r) fail(404, 'not_found');
  var s = Store.get('surveys', r.survey_id) || {}, u = Store.get('users', r.user_id) || {};
  var qmap = indexBy(Store.all('survey_questions'), 'id');
  var answers = Store.find('survey_answers', function (a) { return a.response_id === rid; }).map(function (a) {
    var q = qmap[a.question_id] || {};
    var o = {}; for (var k in a) o[k] = a[k];
    o.question_text = a.question_text || q.question_text;    // 優先使用填答當下的題目快照
    o.question_type = a.question_type || q.question_type;
    o.sort_order = q.sort_order || 0;
    return o;
  }).sort(function (a, b) { return a.sort_order - b.sort_order; });
  var coupon = Store.findOne('coupons', function (c) { return c.response_id === rid; });
  var resp = {}; for (var k in r) if (k !== 'result') resp[k] = r[k];
  resp.survey_title = s.title; resp.location_name = s.location_name;
  resp.user_name = u.name; resp.phone = u.phone; resp.email = u.email;
  return { response: resp, answers: answers, coupon: coupon };
}

function textareaComments(sid, df, dt) {
  var qmap = indexBy(Store.all('survey_questions'), 'id');
  var rmap = indexBy(Store.all('survey_responses'), 'id');
  var smap = indexBy(Store.all('surveys'), 'id');
  var out = [];
  Store.all('survey_answers').forEach(function (a) {
    var type = a.question_type || (qmap[a.question_id] || {}).question_type;
    if (type !== 'textarea') return;
    var txt = str(a.answer_text).trim();
    if (!txt) return;
    var r = rmap[a.response_id];
    if (!r) return;
    if (sid && r.survey_id !== sid) return;
    if (!inDateRange(r.submitted_at, df, dt)) return;
    var s = smap[r.survey_id] || {};
    out.push({
      answer_id: a.id, response_id: r.id, question_id: a.question_id,
      question_text: str(a.question_text || (qmap[a.question_id] || {}).question_text).split('\n')[0],
      answer_text: txt.slice(0, 2000), submitted_at: r.submitted_at,
      survey_id: r.survey_id, survey_title: s.title, location_name: s.location_name
    });
  });
  out.sort(function (a, b) { return str(b.submitted_at) < str(a.submitted_at) ? -1 : 1; });
  return out;
}

function apiListComments(ctx) {
  var q = ctx.query;
  var page = Math.max(1, parseInt(q.page, 10) || 1);
  var size = Math.max(1, Math.min(200, parseInt(q.page_size, 10) || 50));
  var all = textareaComments(q.survey_id ? Number(q.survey_id) : null, q.date_from, q.date_to);
  return {
    items: all.slice((page - 1) * size, page * size), total: all.length, page: page,
    page_size: size, total_pages: Math.max(1, Math.ceil(all.length / size))
  };
}

function filteredCoupons(q) {
  var users = indexBy(Store.all('users'), 'id');
  var now = new Date();
  return Store.all('coupons').filter(function (c) {
    var st = displayStatus(c, now);
    if (q.status && st !== q.status) return false;
    if (q.search) {
      var t = String(q.search).toLowerCase(), u = users[c.user_id] || {};
      if (str(c.coupon_code).toLowerCase().indexOf(t) < 0 && str(u.phone).toLowerCase().indexOf(t) < 0 &&
          str(u.email).toLowerCase().indexOf(t) < 0) return false;
    }
    return inDateRange(c.issued_at, q.date_from, q.date_to);
  }).sort(function (a, b) { return b.id - a.id; });
}

function apiListCoupons(ctx) {
  var surveys = indexBy(Store.all('surveys'), 'id'), users = indexBy(Store.all('users'), 'id');
  var admins = indexBy(Store.all('admin_users'), 'id');
  var rows = filteredCoupons(ctx.query).slice(0, 500).map(function (c) {
    var o = {}; for (var k in c) o[k] = c[k];
    o.status = displayStatus(c);
    var s = surveys[c.survey_id] || {}, u = users[c.user_id] || {}, a = admins[c.redeemed_by] || {};
    o.survey_title = s.title; o.user_name = u.name; o.phone = u.phone; o.email = u.email; o.redeemer_name = a.name;
    return o;
  });
  return { rows: rows };
}

function apiVoidCoupon(ctx, m) {
  var r = voidCoupon(Number(m[1]), ctx.user.id, (ctx.body || {}).note || '');
  audit(ctx, 'void_coupon', 'coupon', m[1]);
  return r;
}

// ============================================================
// 核銷
// ============================================================
function apiRedeemLookup(ctx) {
  var code = str(ctx.query.code).trim();
  if (!code) return { ok: false, message: '請提供兌換券編號' };
  var c = Store.findOne('coupons', function (x) { return x.coupon_code === code; });
  if (!c) return { ok: false, message: '無效兌換券：查無此編號' };
  var s = Store.get('surveys', c.survey_id) || {}, u = Store.get('users', c.user_id) || {};
  var prev = Store.find('coupons', function (x) {
    return x.user_id === c.user_id && x.status === 'redeemed' && x.id !== c.id;
  }).sort(function (a, b) { return str(b.redeemed_at) < str(a.redeemed_at) ? -1 : 1; });
  var interval = intervalDays(s);
  var lastSame = Store.find('coupons', function (x) {
    return x.user_id === c.user_id && x.survey_id === c.survey_id && x.status === 'redeemed';
  }).sort(function (a, b) { return str(b.redeemed_at) < str(a.redeemed_at) ? -1 : 1; })[0];
  var nxt = lastSame ? addDays(new Date(lastSame.redeemed_at), interval) : null;
  return { ok: true, coupon: {
    id: c.id, code: c.coupon_code, status: displayStatus(c), survey_title: s.title, gift_name: c.gift_name, gift_id: c.gift_id,
    user: { name: u.name, phone: u.phone, email: u.email },
    issued_at: c.issued_at, expires_at: c.expires_at, redeemed_at: c.redeemed_at,
    lastRedeemedBeforeThis: prev.length ? prev[0].redeemed_at : null,
    nextEligibleDate: nxt ? nxt.toISOString() : null
  } };
}

function apiRedeem(ctx) {
  var code = str((ctx.body || {}).code).trim();
  if (!code) fail(400, '請提供兌換券編號');
  var r = redeemCoupon(code, ctx.user.id);
  audit(ctx, 'redeem', 'coupon', r.coupon ? r.coupon.id : null, { code: code, status: r.status });
  return r;
}

// ============================================================
// 後台：贈品庫存
// ============================================================
function giftRow(g) {
  var st = giftStock(g.id);
  var o = {}; for (var k in g) o[k] = g[k];
  o.on_hand = st.on_hand; o.reserved = st.reserved; o.available = st.available;
  o.low_stock = g.low_stock_alert !== null && st.available <= g.low_stock_alert;
  o.surveys = Store.find('surveys', function (s) { return s.gift_id === g.id; })
    .map(function (s) { return { id: s.id, title: s.title, is_active: s.is_active }; });
  return o;
}

function apiListGifts() {
  return { gifts: Store.all('gifts').map(giftRow).sort(function (a, b) { return b.is_active - a.is_active || b.id - a.id; }) };
}

function apiCreateGift(ctx) {
  var b = ctx.body || {};
  var name = str(b.name).trim();
  if (!name) fail(400, '請填寫贈品名稱');
  var qty = parseInt(b.initial_qty, 10) || 0;
  if (qty < 0) fail(400, '期初數量不可為負數');
  var g = Store.insert('gifts', {
    name: name, description: str(b.description).trim() || null, is_active: 1,
    low_stock_alert: b.low_stock_alert === '' || b.low_stock_alert === undefined || b.low_stock_alert === null ? 10 : Math.max(0, parseInt(b.low_stock_alert, 10) || 0),
    on_hand: 0, reserved: 0, available: 0, created_at: nowIso(), updated_at: nowIso()
  });
  if (qty > 0) addStockLog(g.id, 'receive', qty, null, ctx.user.id, '期初入庫');
  refreshGiftSnapshot(g.id);
  audit(ctx, 'create_gift', 'gift', g.id, { name: name, qty: qty });
  return { ok: true, id: g.id, gift: giftRow(Store.get('gifts', g.id)) };
}

function apiUpdateGift(ctx, m) {
  var id = Number(m[1]);
  var g = Store.get('gifts', id);
  if (!g) fail(404, 'not_found');
  var b = ctx.body || {};
  var patch = { updated_at: nowIso() };
  if (b.name !== undefined) { if (!str(b.name).trim()) fail(400, '請填寫贈品名稱'); patch.name = str(b.name).trim(); }
  if (b.description !== undefined) patch.description = str(b.description).trim() || null;
  if (b.is_active !== undefined) patch.is_active = bool01(b.is_active);
  if (b.low_stock_alert !== undefined) patch.low_stock_alert = Math.max(0, parseInt(b.low_stock_alert, 10) || 0);
  Store.update('gifts', id, patch);
  audit(ctx, 'update_gift', 'gift', id, patch);
  return { ok: true, gift: giftRow(Store.get('gifts', id)) };
}

/** action: receive（入庫 +qty）、loss（耗損 −qty）、count（盤點：實際數量設為 qty） */
function apiGiftStock(ctx, m) {
  var id = Number(m[1]);
  var g = Store.get('gifts', id);
  if (!g) fail(404, 'not_found');
  var b = ctx.body || {};
  var qty = parseInt(b.qty, 10);
  var note = str(b.note).trim().slice(0, 300);
  if (isNaN(qty) || qty < 0) fail(400, '數量須為 0 以上的整數');
  var st = giftStock(id), delta;
  if (b.action === 'receive') { if (qty < 1) fail(400, '入庫數量須大於 0'); delta = qty; }
  else if (b.action === 'loss') { if (qty < 1) fail(400, '耗損數量須大於 0'); if (!note) fail(400, '耗損請填寫原因'); delta = -qty; }
  else if (b.action === 'count') { if (!note) fail(400, '盤點調整請填寫說明'); delta = qty - st.on_hand; if (delta === 0) return { ok: true, message: '數量相同，未調整', gift: giftRow(g) }; }
  else fail(400, '未知的庫存操作');
  if (st.on_hand + delta < st.reserved) {
    fail(400, '調整後實際數量（' + (st.on_hand + delta) + '）會少於已發出未兌換的券（' + st.reserved +
      ' 張）。請先確認現場數量，必要時作廢無法兌換的券。');
  }
  addStockLog(id, b.action, delta, null, ctx.user.id, note || (b.action === 'receive' ? '入庫' : ''));
  refreshGiftSnapshot(id);
  audit(ctx, 'gift_stock_' + b.action, 'gift', id, { qty: qty, delta: delta, note: note });
  return { ok: true, gift: giftRow(Store.get('gifts', id)) };
}

function apiGiftImageUpload(ctx, m) {
  var id = Number(m[1]);
  if (!Store.get('gifts', id)) fail(404, 'not_found');
  var data = str((ctx.body || {}).data_url);
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(data)) fail(400, '圖片格式不正確（請上傳 JPG、PNG 或 WebP）');
  if (data.length > 120000) fail(400, '圖片太大，請重新選擇（系統會自動縮小，若仍失敗請換一張）');
  checkImageBytes(data);
  // 先寫入新版分段，成功後才切換現行版本，最後清掉舊版；中途失敗時舊圖仍可使用
  var ver = String(Date.now());
  var chunks = [];
  for (var i = 0; i < data.length; i += 45000) chunks.push({ gift_id: id, ver: ver, seq: chunks.length, data: data.slice(i, i + 45000), created_at: nowIso() });
  Store.insertMany('gift_images', chunks);
  Store.update('gifts', id, { image_version: ver, updated_at: nowIso() });
  removeGiftImage(id, ver);
  audit(ctx, 'gift_image_upload', 'gift', id, { bytes: data.length });
  return { ok: true, gift: giftRow(Store.get('gifts', id)) };
}

/** 檢查解碼後的檔頭與宣告格式一致（JPEG／PNG／WebP） */
function checkImageBytes(dataUrl) {
  var mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  var b;
  try { b = Utilities.base64Decode(dataUrl.slice(dataUrl.indexOf(',') + 1)); } catch (e) { fail(400, '圖片內容無法讀取，請換一張'); }
  var u = function (i) { return b[i] & 0xff; };
  var asc = function (i, n) { var t = ''; for (var k = 0; k < n; k++) t += String.fromCharCode(u(i + k)); return t; };
  var ok = b.length > 32 && (
    (mime === 'image/jpeg' && u(0) === 0xff && u(1) === 0xd8 && u(2) === 0xff) ||
    (mime === 'image/png' && u(0) === 0x89 && asc(1, 3) === 'PNG') ||
    (mime === 'image/webp' && asc(0, 4) === 'RIFF' && asc(8, 4) === 'WEBP'));
  if (!ok) fail(400, '圖片內容與格式不符，請換一張');
}

/** 刪除贈品圖片分段；keepVer 有值時保留該版本 */
function removeGiftImage(id, keepVer) {
  Store.find('gift_images', function (x) { return x.gift_id === id && (!keepVer || x.ver !== keepVer); }).map(function (x) { return x.id; })
    .forEach(function (rid) { Store.remove('gift_images', rid); });
}

function apiGiftImageDelete(ctx, m) {
  var id = Number(m[1]);
  if (!Store.get('gifts', id)) fail(404, 'not_found');
  removeGiftImage(id);
  Store.update('gifts', id, { image_version: null, updated_at: nowIso() });
  audit(ctx, 'gift_image_delete', 'gift', id);
  return { ok: true };
}

function apiGiftImage(ctx, m) {
  var id = Number(m[1]);
  var g = Store.get('gifts', id) || {};
  if (!g.image_version) fail(404, 'not_found');
  var mine = Store.find('gift_images', function (x) { return x.gift_id === id; });
  var parts = mine.filter(function (x) { return x.ver === g.image_version; });
  if (!parts.length) parts = mine.filter(function (x) { return !x.ver; });   // 3.3.0 舊資料沒有版本欄
  parts.sort(function (a, b) { return a.seq - b.seq; });
  if (!parts.length) fail(404, 'not_found');
  return { ok: true, data_url: parts.map(function (p) { return p.data; }).join(''), version: g.image_version || null };
}

var STOCK_ACTION_ZH = { receive: '入庫', loss: '耗損', count: '盤點調整', redeem: '核銷出庫', reconcile: '系統補登' };

function apiGiftLogs(ctx, m) {
  var id = Number(m[1]);
  var admins = indexBy(Store.all('admin_users'), 'id');
  var logs = Store.find('stock_logs', function (l) { return l.gift_id === id; })
    .sort(function (a, b) { return b.id - a.id; }).slice(0, 300).map(function (l) {
      var o = {}; for (var k in l) o[k] = l[k];
      o.action_label = STOCK_ACTION_ZH[l.action] || l.action;
      o.admin_name = (admins[l.admin_user_id] || {}).name || null;
      return o;
    });
  return { logs: logs };
}

// ============================================================
// 後台：帳號
// ============================================================
function apiListAdmins() {
  return { users: Store.all('admin_users').map(function (u) {
    var o = {}; for (var k in u) if (k !== 'password_hash') o[k] = u[k]; return o;
  }) };
}

function checkPasswordStrength(pw) {
  if (str(pw).length < 8) fail(400, '密碼至少 8 個字元');
}

function apiCreateAdmin(ctx) {
  var b = ctx.body || {};
  var email = str(b.email).trim().toLowerCase();
  if (!b.name || !email || !b.password || !b.role) fail(400, '必填欄位不完整');
  if (ROLES_ALL.indexOf(b.role) < 0) fail(400, '角色不正確');
  checkPasswordStrength(b.password);
  if (Store.findOne('admin_users', function (x) { return str(x.email).toLowerCase() === email; })) fail(400, '此 Email 已存在');
  var u = Store.insert('admin_users', {
    name: b.name, email: email, password_hash: hashPassword(b.password), role: b.role,
    is_active: 1, last_login_at: null, created_at: nowIso()
  });
  audit(ctx, 'create_admin_user', 'admin_user', u.id);
  return { ok: true, id: u.id };
}

function apiUpdateAdmin(ctx, m) {
  var id = Number(m[1]);
  var u = Store.get('admin_users', id);
  if (!u) fail(404, 'not_found');
  var b = ctx.body || {};
  if (b.role && ROLES_ALL.indexOf(b.role) < 0) fail(400, '角色不正確');
  if (id === ctx.user.id && (b.role && b.role !== 'super' || !b.is_active)) fail(400, '不能停用自己或移除自己的超級管理者權限');
  var patch = { name: b.name || u.name, role: b.role || u.role, is_active: bool01(b.is_active) };
  if (b.password) { checkPasswordStrength(b.password); patch.password_hash = hashPassword(b.password); }
  Store.update('admin_users', id, patch);
  audit(ctx, 'update_admin_user', 'admin_user', id);
  return { ok: true };
}

function apiDeactivateAdmin(ctx, m) {
  var id = Number(m[1]);
  if (id === ctx.user.id) fail(400, '不能刪除自己');
  Store.update('admin_users', id, { is_active: 0 });
  audit(ctx, 'deactivate_admin_user', 'admin_user', id);
  return { ok: true };
}

// ============================================================
// 儀表板統計
// ============================================================
function counter() { var c = {}; c.add = function (k, n) { c[k] = (c[k] || 0) + (n || 1); }; return c; }
function counterItems(c) {
  return Object.keys(c).filter(function (k) { return k !== 'add'; })
    .map(function (k) { return { label: k, c: c[k] }; }).sort(function (a, b) { return b.c - a.c; });
}
function round(x, d) { var p = Math.pow(10, d || 0); return Math.round(x * p) / p; }
function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }

function dashboardStats(sid, df, dt) {
  var questions = Store.all('survey_questions'), responses = Store.all('survey_responses');
  var answers = Store.all('survey_answers'), coupons = Store.all('coupons');
  if (sid) {
    questions = questions.filter(function (q) { return q.survey_id === sid; });
    responses = responses.filter(function (r) { return r.survey_id === sid; });
    coupons = coupons.filter(function (c) { return c.survey_id === sid; });
  }
  responses = responses.filter(function (r) { return inDateRange(r.submitted_at, df, dt); });
  coupons = coupons.filter(function (c) { return inDateRange(c.issued_at, df, dt); });
  var rset = {}; responses.forEach(function (r) { rset[r.id] = r; });
  answers = answers.filter(function (a) { return rset[a.response_id]; });
  var qmap = indexBy(questions, 'id');

  var today = tpeDate(), mstart = today.slice(0, 7) + '-01';
  var rdate = {}; responses.forEach(function (r) { rdate[r.id] = tpeDateOfIso(r.submitted_at); });
  var todayN = 0, monthN = 0;
  responses.forEach(function (r) { if (rdate[r.id] === today) todayN++; if (rdate[r.id] >= mstart) monthN++; });

  function vals(pred) {
    return answers.filter(function (a) { var q = qmap[a.question_id]; return q && a.answer_value !== null && pred(q); })
      .map(function (a) { return a.answer_value; });
  }
  var overallVals = vals(function (q) { return q.is_overall_score; });
  var satQs = sortQuestions(questions.filter(function (q) { return q.is_satisfaction_score; }));
  var satisfactionAvg = [];
  satQs.forEach(function (q) {
    var v = answers.filter(function (a) { return a.question_id === q.id && a.answer_value !== null; }).map(function (a) { return a.answer_value; });
    if (v.length) satisfactionAvg.push({ id: q.id, label: shortLabel(q.question_text), avg: round(avg(v), 2), n: v.length });
  });

  var cmap = { issued: 0, redeemed: 0, expired: 0, voided: 0, invalid: 0 };
  var now = new Date();
  coupons.forEach(function (c) { var st = displayStatus(c, now); cmap[st] = (cmap[st] || 0) + 1; });
  var totalC = 0; for (var k in cmap) totalC += cmap[k];

  var perResp = {};
  answers.forEach(function (a) {
    var q = qmap[a.question_id];
    if (q && q.is_satisfaction_score && a.answer_value !== null) (perResp[a.response_id] = perResp[a.response_id] || []).push(a.answer_value);
  });
  var monthNeg = 0;
  Object.keys(perResp).forEach(function (rid) { if (avg(perResp[rid]) <= 2 && rdate[rid] >= mstart) monthNeg++; });

  var daily = counter(); responses.forEach(function (r) { daily.add(rdate[r.id]); });
  var dailyTrend = [];
  for (var i = 29; i >= 0; i--) {
    var d = tpeDate(addDays(new Date(), -i));
    if (daily[d]) dailyTrend.push({ d: d, c: daily[d] });
  }
  var monthly = counter(); responses.forEach(function (r) { if (rdate[r.id]) monthly.add(rdate[r.id].slice(0, 7)); });
  var monthlyTrend = Object.keys(monthly).filter(function (x) { return x !== 'add'; }).sort().slice(-12)
    .map(function (mm) { return { m: mm, c: monthly[mm] }; });

  function distFor(pred) {
    var c = counter();
    answers.forEach(function (a) {
      var q = qmap[a.question_id];
      if (!q || !pred(q) || !a.answer_text) return;
      parseList(a.answer_text).forEach(function (x) { if (x) c.add(String(x)); });
    });
    return counterItems(c);
  }
  var purposeDist = distFor(function (q) { return /身分別|來訪目的/.test(q.question_text || ''); });
  var serviceDist = distFor(function (q) { return /使用或參與|使用服務/.test(q.question_text || ''); });

  var categoricalDist = [];
  sortQuestions(questions.slice()).forEach(function (q) {
    if (['single', 'multiple', 'select'].indexOf(q.question_type) < 0 || !q.is_active) return;
    var items = distFor(function (qq) { return qq.id === q.id; });
    var total = items.reduce(function (s, x) { return s + x.c; }, 0);
    categoricalDist.push({ q_id: q.id, q_text: str(q.question_text).split('\n')[0].trim(), q_type: q.question_type, total: total,
      items: items.map(function (x) { return { label: x.label, c: x.c, pct: total ? round(x.c / total * 100, 1) : 0 }; }) });
  });

  var scoreC = {}, satAll = vals(function (q) { return q.is_satisfaction_score; });
  satAll.forEach(function (v) { scoreC[Math.floor(v)] = (scoreC[Math.floor(v)] || 0) + 1; });
  var overallDist = [];
  for (var s1 = 1; s1 <= 5; s1++) overallDist.push({ score: s1, c: scoreC[s1] || 0, pct: satAll.length ? round((scoreC[s1] || 0) / satAll.length * 100, 1) : 0 });

  var npsVals = vals(function (q) { return q.question_type === 'nps'; });
  var npsC = {}; npsVals.forEach(function (v) { npsC[Math.floor(v)] = (npsC[Math.floor(v)] || 0) + 1; });
  var npsDist = [];
  for (var s2 = 0; s2 <= 10; s2++) npsDist.push({ score: s2, c: npsC[s2] || 0, pct: npsVals.length ? round((npsC[s2] || 0) / npsVals.length * 100, 1) : 0 });
  var npsSummary = { promoters: 0, passives: 0, detractors: 0, promoters_pct: 0, passives_pct: 0, detractors_pct: 0, score: null, total: 0 };
  if (npsVals.length) {
    var pro = (npsC[9] || 0) + (npsC[10] || 0), pas = (npsC[7] || 0) + (npsC[8] || 0), det = npsVals.length - pro - pas, n = npsVals.length;
    npsSummary = { promoters: pro, passives: pas, detractors: det, promoters_pct: round(pro / n * 100, 1),
      passives_pct: round(pas / n * 100, 1), detractors_pct: round(det / n * 100, 1), score: round((pro - det) / n * 100, 1), total: n };
  }

  var open = [];
  answers.forEach(function (a) {
    var type = a.question_type || (qmap[a.question_id] || {}).question_type;
    var txt = str(a.answer_text).trim();
    if (type !== 'textarea' || !txt) return;
    open.push({ answer_id: a.id, response_id: a.response_id,
      question_text: shortLabel(a.question_text || (qmap[a.question_id] || {}).question_text, 40),
      answer_text: txt.slice(0, 500), submitted_at: (rset[a.response_id] || {}).submitted_at || '' });
  });
  open.sort(function (a, b) { return str(b.submitted_at) < str(a.submitted_at) ? -1 : 1; });
  var mc = counter(); open.forEach(function (o) { mc.add(tpeDateOfIso(o.submitted_at).slice(0, 7)); });
  var months = [], y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
  for (var j = 0; j < 12; j++) { months.unshift(y + '-' + ('0' + mo).slice(-2)); mo--; if (!mo) { mo = 12; y--; } }

  return {
    cards: {
      totalResponses: responses.length, todayResponses: todayN, monthResponses: monthN,
      overallAvg: overallVals.length ? round(avg(overallVals), 2) : null,
      totalCoupons: totalC, issuedCoupons: cmap.issued, redeemedCoupons: cmap.redeemed,
      expiredCoupons: cmap.expired, voidedCoupons: cmap.voided,
      redemptionRate: totalC ? round(cmap.redeemed / totalC * 100, 1) : 0, monthNegative: monthNeg
    },
    satisfactionAvg: satisfactionAvg,
    couponStatus: Object.keys(cmap).map(function (k2) { return { label: k2, c: cmap[k2] }; }),
    dailyTrend: dailyTrend, monthlyTrend: monthlyTrend, purposeDist: purposeDist, serviceDist: serviceDist,
    categoricalDist: categoricalDist, overallDist: overallDist, npsDist: npsDist, npsSummary: npsSummary,
    keywords: countKeywords(open.slice(0, 100).map(function (o) { return o.answer_text; })),
    recentComments: open.slice(0, 30),
    monthlyComments: months.map(function (mm) { return { m: mm, c: mc[mm] || 0 }; })
  };
}

function countKeywords(texts) {
  var cats = [
    ['環境整潔', ['整潔', '清潔', '髒', '臭', '亂', '味道']],
    ['動線指標', ['動線', '指標', '迷路', '找不到', '指引', '標示']],
    ['服務態度', ['態度', '人員', '冷淡', '熱情', '親切', '不耐煩']],
    ['設備問題', ['設備', '故障', '壞掉', '當機', '無法使用', '機器']],
    ['停車問題', ['停車', '車位', '繳費', '車牌', '充電樁']],
    ['價格意見', ['價格', '貴', '便宜', '收費', '費用', '優惠']],
    ['排隊等候', ['排隊', '等待', '等候', '人多', '太久']],
    ['安全疑慮', ['安全', '危險', '監視', '保全', '昏暗']]
  ];
  var counts = {}, other = 0;
  texts.forEach(function (t) {
    var hit = false;
    cats.forEach(function (c) {
      if (c[1].some(function (kw) { return t.indexOf(kw) >= 0; })) { counts[c[0]] = (counts[c[0]] || 0) + 1; hit = true; }
    });
    if (!hit) other++;
  });
  var out = cats.filter(function (c) { return counts[c[0]]; }).map(function (c) { return { label: c[0], c: counts[c[0]] }; });
  if (other) out.push({ label: '其他建議', c: other });
  return out;
}

function apiDashboard(ctx) {
  var q = ctx.query;
  return dashboardStats(q.survey_id ? Number(q.survey_id) : null, q.date_from, q.date_to);
}

// ============================================================
// CSV 匯出（Excel 可直接開啟；含 BOM 以正確顯示中文）
// ============================================================
function csvCell(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }
function fmtTpe(iso) { var d = parseDate(iso); return d ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss') : ''; }
var STATUS_ZH = { issued: '未兌換', redeemed: '已兌換', expired: '已逾期', voided: '已作廢', invalid: '無效' };

function metaRows(title, q) {
  var s = q.survey_id ? Store.get('surveys', Number(q.survey_id)) : null;
  var range = q.date_from && q.date_to ? q.date_from + ' ~ ' + q.date_to : q.date_from ? q.date_from + ' 起' : q.date_to ? q.date_to + ' 前' : '全部期間';
  return [[title], ['問卷', s ? s.title : '全部問卷（合計）'], ['日期區間', range], ['匯出時間', fmtTpe(new Date().toISOString())], []];
}

function exportResponses(q) {
  var sid = q.survey_id ? Number(q.survey_id) : null;
  var surveys = indexBy(Store.all('surveys'), 'id'), users = indexBy(Store.all('users'), 'id');
  var cBy = indexBy(Store.all('coupons'), 'response_id');
  var resps = Store.all('survey_responses').filter(function (r) {
    return (!sid || r.survey_id === sid) && inDateRange(r.submitted_at, q.date_from, q.date_to);
  }).sort(function (a, b) { return b.id - a.id; });
  var qs = Store.all('survey_questions').filter(function (x) { return (!sid || x.survey_id === sid) && x.question_type !== 'section'; })
    .sort(function (a, b) { return a.survey_id - b.survey_id || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id; });
  var ansMap = {}, rset = {}, extra = {};
  resps.forEach(function (r) { rset[r.id] = true; });
  var qset = {}; qs.forEach(function (x) { qset[x.id] = true; });
  Store.all('survey_answers').forEach(function (a) {
    (ansMap[a.response_id] = ansMap[a.response_id] || {})[a.question_id] = a;
    // 已刪除的題目：用答案內保存的題目文字補一欄，避免舊答案在匯出中消失
    if (rset[a.response_id] && !qset[a.question_id] && !extra[a.question_id]) {
      extra[a.question_id] = { id: a.question_id, question_text: (a.question_text || ('題目 #' + a.question_id)) + '（已刪除題目）' };
    }
  });
  qs = qs.concat(Object.keys(extra).map(function (k) { return extra[k]; }));
  // 題目改過文字：欄名附上填答當時曾用的題名，避免以新題意解讀舊答案
  var oldTitles = {};
  Store.all('survey_answers').forEach(function (a) {
    if (!rset[a.response_id] || !qset[a.question_id] || !a.question_text) return;
    (oldTitles[a.question_id] = oldTitles[a.question_id] || {})[a.question_text] = true;
  });
  function header(x) {
    var olds = Object.keys(oldTitles[x.id] || {}).filter(function (t) { return t !== x.question_text; });
    return olds.length ? x.question_text + '［曾用題名：' + olds.join('；') + '］' : x.question_text;
  }
  var rows = [['填寫時間', '問卷名稱', '場域名稱', '匿名識別'].concat(qs.map(header)).concat(['兌換券編號', '兌換券狀態', '贈品'])];
  resps.forEach(function (r) {
    var s = surveys[r.survey_id] || {}, c = cBy[r.id] || {}, u = users[r.user_id] || {};
    var row = [fmtTpe(r.submitted_at), s.title, s.location_name, 'U' + r.user_id];
    qs.forEach(function (x) {
      var a = (ansMap[r.id] || {})[x.id];
      if (!a) row.push('');
      else if (a.answer_value !== null) row.push(a.answer_value);
      else row.push(parseList(a.answer_text).join('、'));
    });
    row.push(c.coupon_code || '', c.coupon_code ? STATUS_ZH[displayStatus(c)] : '', c.gift_name || '');
    rows.push(row);
  });
  return rows;
}

function exportCoupons(q) {
  var surveys = indexBy(Store.all('surveys'), 'id'), admins = indexBy(Store.all('admin_users'), 'id');
  var rows = [['兌換券編號', '問卷名稱', '贈品', '產生時間', '有效期限', '狀態', '核銷時間', '核銷人員', '匿名識別']];
  filteredCoupons(q).forEach(function (c) {
    rows.push([c.coupon_code, (surveys[c.survey_id] || {}).title, c.gift_name, fmtTpe(c.issued_at), fmtTpe(c.expires_at),
      STATUS_ZH[displayStatus(c)], fmtTpe(c.redeemed_at), (admins[c.redeemed_by] || {}).name || '', 'U' + c.user_id]);
  });
  return rows;
}

function exportSummary(q) {
  var st = dashboardStats(q.survey_id ? Number(q.survey_id) : null, q.date_from, q.date_to), c = st.cards;
  var rows = metaRows('統計摘要', q);
  rows.push(['項目', '數值']);
  [['總問卷填寫數', c.totalResponses], ['今日問卷填寫數', c.todayResponses], ['本月問卷填寫數', c.monthResponses],
   ['平均整體滿意度', c.overallAvg], ['產生兌換券數', c.totalCoupons], ['未兌換', c.issuedCoupons],
   ['已兌換', c.redeemedCoupons], ['逾期', c.expiredCoupons], ['作廢', c.voidedCoupons],
   ['兌換率 (%)', c.redemptionRate], ['本月不滿意回饋數', c.monthNegative]].forEach(function (r) { rows.push(r); });
  rows.push([], ['評分項目', '平均', '樣本數']);
  st.satisfactionAvg.forEach(function (r) { rows.push([r.label, r.avg, r.n]); });
  rows.push([], ['關鍵字類別', '提及次數']);
  st.keywords.forEach(function (r) { rows.push([r.label, r.c]); });
  rows.push([], ['贈品', '實際庫存', '已預留', '可發']);
  Store.all('gifts').forEach(function (g) { var s = giftStock(g.id); rows.push([g.name, s.on_hand, s.reserved, s.available]); });
  return rows;
}

var CHART_NAMES = {
  'daily-trend': '每日填寫趨勢', 'monthly-trend': '每月填寫趨勢', 'satisfaction-avg': '各項滿意度平均',
  'score-distribution': '滿意度評分分布', 'nps-distribution': 'NPS推薦分數分布',
  'identity-distribution': '民眾身分別分布', 'service-distribution': '使用服務類型分布',
  'coupon-status': '兌換券狀態', 'monthly-comments': '每月民眾意見數量'
};

function exportChart(name, q) {
  if (!CHART_NAMES[name]) fail(400, 'invalid chart name');
  var st = dashboardStats(q.survey_id ? Number(q.survey_id) : null, q.date_from, q.date_to);
  var rows = metaRows(CHART_NAMES[name], q);
  function dist(items) {
    var total = items.reduce(function (s, r) { return s + r.c; }, 0);
    rows.push(['類別', '筆數', '百分比']);
    items.forEach(function (r) { rows.push([r.label, r.c, (total ? round(r.c / total * 100, 1) : 0) + '%']); });
    rows.push(['合計', total, '100%']);
  }
  if (name === 'daily-trend') { rows.push(['日期', '填寫筆數']); st.dailyTrend.forEach(function (r) { rows.push([r.d, r.c]); }); }
  else if (name === 'monthly-trend') { rows.push(['月份', '填寫筆數']); st.monthlyTrend.forEach(function (r) { rows.push([r.m, r.c]); }); }
  else if (name === 'satisfaction-avg') { rows.push(['題目', '平均分數', '樣本數']); st.satisfactionAvg.forEach(function (r) { rows.push([r.label, r.avg, r.n]); }); }
  else if (name === 'score-distribution' || name === 'nps-distribution') {
    var list = name === 'score-distribution' ? st.overallDist : st.npsDist;
    rows.push(['分數', '筆數', '百分比']);
    list.forEach(function (r) { rows.push([r.score + ' 分', r.c, r.pct + '%']); });
    if (name === 'nps-distribution') {
      var s = st.npsSummary;
      rows.push([], ['推薦者 (9-10 分)', s.promoters, s.promoters_pct + '%'], ['中立者 (7-8 分)', s.passives, s.passives_pct + '%'],
        ['批評者 (0-6 分)', s.detractors, s.detractors_pct + '%'], ['NPS 分數', s.score === null ? 'N/A' : s.score]);
    }
  }
  else if (name === 'identity-distribution') dist(st.purposeDist);
  else if (name === 'service-distribution') dist(st.serviceDist);
  else if (name === 'coupon-status') dist(st.couponStatus.filter(function (r) { return r.c; }).map(function (r) { return { label: STATUS_ZH[r.label] || r.label, c: r.c }; }));
  else if (name === 'monthly-comments') { rows.push(['月份', '意見數量']); st.monthlyComments.forEach(function (r) { rows.push([r.m, r.c]); }); }
  return rows;
}

function exportQuestion(qid, q) {
  var qq = Store.get('survey_questions', qid);
  if (!qq) fail(404, 'not_found');
  var qx = {}; for (var k in q) qx[k] = q[k]; qx.survey_id = qq.survey_id;
  var st = dashboardStats(qq.survey_id, q.date_from, q.date_to);
  var item = st.categoricalDist.filter(function (x) { return x.q_id === qid; })[0];
  var rows = metaRows(str(qq.question_text).split('\n')[0], qx);
  rows.push(['選項', '筆數', '百分比']);
  if (item) item.items.forEach(function (r) { rows.push([r.label, r.c, r.pct + '%']); });
  return rows;
}

function handleExport(ctx, m) {
  var kind = m[1], rows, name;
  if (kind === 'responses') { rows = exportResponses(ctx.query); name = 'responses'; }
  else if (kind === 'coupons') { rows = exportCoupons(ctx.query); name = 'coupons'; }
  else if (kind === 'summary') { rows = exportSummary(ctx.query); name = 'summary'; }
  else if (kind.indexOf('chart/') === 0) { rows = exportChart(kind.slice(6), ctx.query); name = CHART_NAMES[kind.slice(6)]; }
  else if (kind.indexOf('question/') === 0) { rows = exportQuestion(Number(kind.slice(9)), ctx.query); name = 'question_' + kind.slice(9); }
  else fail(404, 'not_found');
  audit(ctx, 'export_' + kind.split('/')[0]);
  return { __csv: toCsv(rows), __filename: name + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmm') + '.csv' };
}

// ============================================================
// 系統：版本、自動更新（從 GitHub 拉最新已測試版本）
// ============================================================
function apiSystemInfo() {
  return { ok: true, version: CODE_VERSION, google_client_id: googleClientId() || null, auto_update: props().getProperty('AUTO_UPDATE') !== 'off',
    last_update: props().getProperty('LAST_UPDATE') || null, last_update_error: props().getProperty('LAST_UPDATE_ERROR') || null };
}

function apiSystemUpdate(ctx) {
  var r = selfUpdate(true);
  audit(ctx, 'system_update', 'system', null, r);
  return r;
}

/** 檢查 GitHub 上的 VERSION；有新版就更新本專案程式並重新部署同一個網址 */
function selfUpdate(manual) {
  try {
    var remote = UrlFetchApp.fetch(GITHUB_RAW_BASE + 'VERSION?t=' + Date.now(), { muteHttpExceptions: true });
    if (remote.getResponseCode() !== 200) throw new Error('讀取 GitHub VERSION 失敗：HTTP ' + remote.getResponseCode());
    var ver = remote.getContentText().trim();
    if (ver === CODE_VERSION) return { ok: true, updated: false, version: ver, message: '已是最新版本 ' + ver };
    var code = UrlFetchApp.fetch(GITHUB_RAW_BASE + 'Code.gs?t=' + Date.now()).getContentText();
    var manifest = UrlFetchApp.fetch(GITHUB_RAW_BASE + 'appsscript.json?t=' + Date.now()).getContentText();
    if (code.indexOf("var CODE_VERSION = '" + ver + "'") < 0) throw new Error('GitHub 上的 Code.gs 與 VERSION 不一致，暫不更新');
    var sid = ScriptApp.getScriptId();
    var base = 'https://script.googleapis.com/v1/projects/' + sid;
    var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    function call(method, url, payload) {
      var res = UrlFetchApp.fetch(url, { method: method, headers: auth, contentType: 'application/json',
        payload: payload ? JSON.stringify(payload) : undefined, muteHttpExceptions: true });
      if (res.getResponseCode() >= 300) throw new Error(method + ' ' + url.replace(base, '') + ' → ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
      return JSON.parse(res.getContentText() || '{}');
    }
    call('put', base + '/content', { files: [
      { name: 'Code', type: 'SERVER_JS', source: code },
      { name: 'appsscript', type: 'JSON', source: manifest }
    ] });
    var v = call('post', base + '/versions', { description: 'v' + ver + ' from GitHub' });
    var deps = call('get', base + '/deployments').deployments || [];
    var n = 0;
    deps.forEach(function (d) {
      var cfg = d.deploymentConfig || {};
      if (!cfg.versionNumber) return;  // 跳過 HEAD 測試部署
      call('put', base + '/deployments/' + d.deploymentId, { deploymentConfig: {
        scriptId: sid, versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: 'v' + ver } });
      n++;
    });
    props().setProperty('LAST_UPDATE', nowIso() + ' → ' + ver);
    props().deleteProperty('LAST_UPDATE_ERROR');
    return { ok: true, updated: true, version: ver, deployments: n, message: '已更新至 ' + ver };
  } catch (e) {
    props().setProperty('LAST_UPDATE_ERROR', nowIso() + ' ' + e.message);
    if (manual) return { ok: false, message: e.message };
    return { ok: false };
  }
}

// ============================================================
// 排程工作（setup() 會建立）
// ============================================================
/** 每小時：自動更新 */
function cronAutoUpdate() {
  if (props().getProperty('AUTO_UPDATE') === 'off') return;
  selfUpdate(false);
}

/** 每天：把逾期券標記為 expired、補登遺漏的核銷出庫紀錄、更新贈品快照 */
function cronDaily() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    Store.reset();
    reconcile();
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}

/**
 * 對帳（每天自動執行；super 可手動執行）：
 *  - 已核銷但沒有出庫紀錄 → 補一筆 −1
 *  - 未核銷（逾期／作廢）卻有出庫紀錄（核銷中途失敗）→ 回補 +1
 *  - 未過期、未核銷但已有出庫紀錄 → 視為核銷進行中，保留（可發數會暫時少 1，不會超發）
 *  - 逾期券標記為 expired，並重算贈品快照
 */
function reconcile() {
  var fixed = 0, expired = 0, now = new Date();
  var net = {};
  Store.all('stock_logs').forEach(function (l) {
    if (l.coupon_id && (l.action === 'redeem' || l.action === 'reconcile')) net[l.coupon_id] = (net[l.coupon_id] || 0) + (l.on_hand_delta || 0);
  });
  Store.all('coupons').slice().forEach(function (c) {
    if (markExpired(c)) expired++;
    if (!c.gift_id) return;
    var n = net[c.id] || 0;
    if (c.status === 'redeemed' && n === 0) { addStockLog(c.gift_id, 'reconcile', -1, c.id, null, '補登核銷出庫 ' + c.coupon_code); fixed++; }
    else if (c.status !== 'redeemed' && displayStatus(c, now) !== 'issued' && n < 0) {
      addStockLog(c.gift_id, 'reconcile', -n, c.id, null, '核銷未完成，回補庫存 ' + c.coupon_code); fixed++;
    }
  });
  Store.all('gifts').forEach(function (g) { refreshGiftSnapshot(g.id); });
  return { fixed: fixed, expired: expired };
}

// ============================================================
// 安裝
// ============================================================
/**
 * 首次在 Apps Script 編輯器執行。會建立所有分頁、排程、超級管理者帳號。
 * 預設帳號 Email 為部署者 Google 帳號；密碼會顯示在「執行紀錄」中，登入後請立即修改。
 */
function setup() {
  Object.keys(SCHEMA).forEach(function (n) { Store.sheet(n); });
  var def = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('工作表1') || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  if (def && SpreadsheetApp.getActiveSpreadsheet().getSheets().length > 1) SpreadsheetApp.getActiveSpreadsheet().deleteSheet(def);
  jwtSecret();
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cronDaily').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('cronAutoUpdate').timeBased().everyHours(1).create();
  var email = (Session.getEffectiveUser().getEmail() || 'admin@example.com').toLowerCase();
  var msg;
  if (!Store.findOne('admin_users', function (u) { return u.role === 'super'; })) {
    var pw = 'Sv-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    Store.insert('admin_users', { name: '系統管理員', email: email, password_hash: hashPassword(pw), role: 'super',
      is_active: 1, last_login_at: null, created_at: nowIso() });
    msg = '已建立超級管理者：' + email + ' 密碼：' + pw + ' （登入後請到「帳號」頁修改）';
  } else msg = '超級管理者已存在，未變更帳號。';
  Logger.log(msg);
  return msg;
}

/** 選用：建立範例問卷（原 seed_v2 的 20 題民眾滿意度問卷）與一個測試贈品 */
function seedDemo() {
  var g = Store.insert('gifts', { name: '測試贈品', description: '測試用', is_active: 1, low_stock_alert: 5,
    on_hand: 0, reserved: 0, available: 0, created_at: nowIso(), updated_at: nowIso() });
  addStockLog(g.id, 'receive', 20, null, null, '期初入庫（測試）');
  refreshGiftSnapshot(g.id);
  var s = Store.insert('surveys', {
    title: '民眾滿意度調查問卷',
    description: '親愛的民眾您好：\n感謝您撥冗填寫本問卷。為持續提升本場域之服務品質、環境設施、動線指引與整體使用體驗，誠摯邀請您提供寶貴意見。\n\n本問卷約需 3 分鐘完成，填答內容僅作為服務改善、營運分析及統計研究使用，不會作為其他用途。相關資料將依個人資料保護法及相關規定妥善處理。\n\n完成問卷後，系統將產生贈品兌換券，請依兌換券說明至指定地點兌換。',
    location_name: '林口國家檔案館附屬服務設施', start_date: null, end_date: null, is_active: 1, generate_coupon: 1,
    gift_id: g.id, coupon_valid_hours: 24, redemption_interval_days: 30, redemption_location: '服務台（營業時間 09:00-17:00）',
    coupon_title: '民眾滿意度調查贈品兌換券', coupon_subtitle: '感謝您完成滿意度調查', coupon_code_prefix: 'NA',
    thank_you_message: '感謝您完成本次滿意度調查！\n您的意見將作為我們持續改善服務品質、環境設施與整體體驗的重要參考。\n請於 24 小時內出示下方兌換券 QR Code 至指定地點兌換贈品，逾時將自動取消。',
    next_action_label: '', next_action_url: '', next_action_hint: '', created_at: nowIso(), updated_at: nowIso()
  });
  var R = ['非常願意', '願意', '普通', '不太願意', '完全不願意'];
  var items = [
    ['第一部分｜基本資料', 'section', 0, ['以下基本資料僅作為統計分析使用，請依實際情況選填。']],
    ['請問您的身分別為？', 'single', 1, ['一般民眾', '洽公民眾', '遊客／參觀民眾', '附近居民', '工作人員／業務往來人員', '其他']],
    ['請問您本次主要使用或參與的服務為？', 'single', 1, ['洽公服務', '展覽參觀', '停車服務', '餐飲服務', '文創商店／商品購買', '活動參與', '休憩停留', '其他']],
    ['請問您是第幾次到訪本場域？', 'single', 1, ['第一次', '第2～3次', '第4次以上', '經常到訪', '不確定']],
    ['請問您的年齡區間為？', 'single', 1, ['18歲以下', '19～30歲', '31～45歲', '46～60歲', '61歲以上', '不方便透露']],
    ['請問您本次主要同行對象為？', 'single', 1, ['自行前來', '與家人同行', '與朋友同行', '與同事同行', '團體參訪', '其他']],
    ['第二部分｜服務與環境滿意度', 'section', 0, ['請依照您本次實際體驗感受進行評分。\n1 分＝非常不滿意，5 分＝非常滿意；若未使用該項服務，請點選「未使用／不適用」。']],
    ['您對本場域整體服務品質的滿意度？', 'rating', 1, null, 1],
    ['您對現場環境整潔與維護狀況的滿意度？', 'rating', 1, null, 1],
    ['您對現場動線安排與指標清楚度的滿意度？', 'rating', 1, null, 1],
    ['您對工作人員服務態度與協助品質的滿意度？', 'rating', 1, null, 1],
    ['您對現場設施設備便利性的滿意度？\n（例如：出入口、電梯、洗手間、休憩空間、服務櫃台、繳費設備、資訊看板等）', 'rating', 1, null, 1],
    ['您對現場安全性與秩序維護的滿意度？\n（例如：照明、地面安全、動線安全、人員管理、緊急協助等）', 'rating', 1, null, 1],
    ['您對等候時間、辦理效率或服務流程順暢度的滿意度？', 'rating', 1, null, 1],
    ['您對資訊取得便利性的滿意度？\n（例如：公告資訊、網站資訊、現場說明、QR Code、客服或導覽資訊等）', 'rating', 1, null, 1],
    ['您對本次整體體驗的滿意度？', 'rating', 1, null, 1, 1],
    ['第三部分｜再訪與推薦意願', 'section', 0, null],
    ['請問您未來是否願意再次來訪或使用本場域服務？', 'single', 1, R],
    ['請問您是否願意推薦親友前來本場域？', 'single', 1, R],
    ['若以 0 至 10 分表示推薦意願，您會給幾分？\n（0 分代表完全不會推薦，10 分代表非常願意推薦）', 'nps', 1, null],
    ['第四部分｜意見回饋', 'section', 0, null],
    ['請問您本次體驗中，最滿意的地方是什麼？', 'textarea', 0, null],
    ['請問您認為本場域最需要改善的地方是什麼？', 'textarea', 0, null],
    ['若未來本場域增加服務、活動或設施，您希望優先增加哪些項目？（可複選）', 'multiple', 0,
      ['更多休憩座位', '更清楚的指標導引', '更多餐飲服務', '更多文創商品', '更多親子友善設施', '更多展覽或活動', '更便利的停車服務', '更完整的線上資訊', '其他建議']]
  ];
  Store.insertMany('survey_questions', items.map(function (it, i) {
    return { survey_id: s.id, question_text: it[0], question_type: it[1], is_required: it[2],
      options: it[3] ? JSON.stringify(it[3]) : null, sort_order: (i + 1) * 10, is_active: 1,
      include_in_statistics: it[1] === 'section' ? 0 : 1, is_satisfaction_score: it[4] || 0, is_overall_score: it[5] || 0,
      display_condition: null, created_at: nowIso(), updated_at: nowIso() };
  }));
  Logger.log('已建立範例問卷 ID=' + s.id + '、測試贈品 ID=' + g.id + '（20 份）');
  return { survey_id: s.id, gift_id: g.id };
}

// ============================================================
// 路由
// ============================================================
var ROUTES = [
  // [method, regex, handler, roles(null=公開), write(需鎖)]
  ['GET', /^\/api\/health$/, function () { return { ok: true, version: CODE_VERSION }; }, null, false],
  ['GET', /^\/api\/public\/surveys$/, apiListSurveys, null, false, true],
  ['GET', /^\/api\/public\/surveys\/(\d+)$/, apiGetSurvey, null, false, true],
  ['GET', /^\/api\/public\/coupons\/([^/]+)$/, apiGetCoupon, null, false],
  ['GET', /^\/api\/public\/my-coupons$/, apiMyCoupons, null, false],
  ['GET', /^\/api\/public\/precheck\/(\d+)$/, apiPrecheck, null, false],
  ['POST', /^\/api\/public\/survey$/, apiSubmitSurvey, null, true],
  ['GET', /^\/api\/public\/config$/, apiPublicConfig, null, false, true],
  ['POST', /^\/api\/public\/login\/google$/, apiGoogleLogin, null, false],
  ['GET', /^\/api\/public\/gift-image\/(\d+)$/, apiGiftImage, null, false, true],
  ['POST', /^\/api\/auth\/login$/, apiLogin, null, true],
  ['GET', /^\/api\/auth\/me$/, function (ctx) { return { user: ctx.user }; }, ROLES_ALL, false],

  ['GET', /^\/api\/admin\/dashboard$/, apiDashboard, ROLES_MGR, false],
  ['GET', /^\/api\/admin\/surveys$/, apiAdminListSurveys, ROLES_MGR, false],
  ['POST', /^\/api\/admin\/surveys$/, apiCreateSurvey, ROLES_MGR, true],
  ['GET', /^\/api\/admin\/surveys\/(\d+)$/, apiAdminGetSurvey, ROLES_MGR, false],
  ['PUT', /^\/api\/admin\/surveys\/(\d+)$/, apiUpdateSurvey, ROLES_MGR, true],
  ['POST', /^\/api\/admin\/surveys\/(\d+)\/duplicate$/, apiDuplicateSurvey, ROLES_MGR, true],
  ['POST', /^\/api\/admin\/surveys\/(\d+)\/toggle-active$/, apiToggleSurvey, ROLES_MGR, true],
  ['POST', /^\/api\/admin\/surveys\/(\d+)\/questions$/, apiCreateQuestion, ROLES_MGR, true],
  ['PUT', /^\/api\/admin\/questions\/(\d+)$/, apiUpdateQuestion, ROLES_MGR, true],
  ['DELETE', /^\/api\/admin\/questions\/(\d+)$/, apiDeleteQuestion, ROLES_MGR, true],
  ['GET', /^\/api\/admin\/responses$/, apiListResponses, ROLES_MGR, false],
  ['GET', /^\/api\/admin\/responses\/(\d+)$/, apiGetResponse, ROLES_MGR, false],
  ['GET', /^\/api\/admin\/comments$/, apiListComments, ROLES_MGR, false],
  ['GET', /^\/api\/admin\/coupons$/, apiListCoupons, ROLES_MGR, false],
  ['POST', /^\/api\/admin\/coupons\/(\d+)\/void$/, apiVoidCoupon, ROLES_MGR, true],
  ['GET', /^\/api\/admin\/gifts$/, apiListGifts, ROLES_MGR, false],
  ['POST', /^\/api\/admin\/gifts$/, apiCreateGift, ROLES_MGR, true],
  ['PUT', /^\/api\/admin\/gifts\/(\d+)$/, apiUpdateGift, ROLES_MGR, true],
  ['POST', /^\/api\/admin\/gifts\/(\d+)\/stock$/, apiGiftStock, ROLES_MGR, true],
  ['GET', /^\/api\/admin\/gifts\/(\d+)\/logs$/, apiGiftLogs, ROLES_MGR, false],
  ['POST', /^\/api\/admin\/gifts\/(\d+)\/image$/, apiGiftImageUpload, ROLES_MGR, true],
  ['DELETE', /^\/api\/admin\/gifts\/(\d+)\/image$/, apiGiftImageDelete, ROLES_MGR, true],
  ['POST', /^\/api\/admin\/system\/google$/, apiSetGoogleClient, ['super'], true],
  ['GET', /^\/api\/admin\/admin-users$/, apiListAdmins, ['super'], false],
  ['POST', /^\/api\/admin\/admin-users$/, apiCreateAdmin, ['super'], true],
  ['PUT', /^\/api\/admin\/admin-users\/(\d+)$/, apiUpdateAdmin, ['super'], true],
  ['DELETE', /^\/api\/admin\/admin-users\/(\d+)$/, apiDeactivateAdmin, ['super'], true],
  ['GET', /^\/api\/admin\/export\/(.+)$/, handleExport, ROLES_MGR, true],
  ['GET', /^\/api\/admin\/system$/, apiSystemInfo, ['super'], false],
  ['POST', /^\/api\/admin\/system\/update$/, apiSystemUpdate, ['super'], true],
  ['POST', /^\/api\/admin\/system\/reconcile$/, function (ctx) { var r = reconcile(); audit(ctx, 'reconcile', 'system', null, r); return r; }, ['super'], true],

  ['GET', /^\/api\/redeem\/lookup$/, apiRedeemLookup, ROLES_ALL, false],
  ['POST', /^\/api\/redeem$/, apiRedeem, ROLES_ALL, true]
];

function parseQuery(qs) {
  var out = {};
  if (!qs) return out;
  qs.split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
    var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  });
  return out;
}

/** 核心分派：回傳 { status, body } */
function dispatch(req) {
  Store.reset();
  var method = String(req.method || 'GET').toUpperCase();
  var full = String(req.path || '');
  var qi = full.indexOf('?');
  var path = qi < 0 ? full : full.slice(0, qi);
  var query = parseQuery(qi < 0 ? '' : full.slice(qi + 1));
  var route = null, m = null, pathMatched = false;
  for (var i = 0; i < ROUTES.length; i++) {
    var mm = path.match(ROUTES[i][1]);
    if (mm) { pathMatched = true; if (ROUTES[i][0] === method) { route = ROUTES[i]; m = mm; break; } }
  }
  if (!route) return { status: pathMatched ? 405 : 404, body: { error: pathMatched ? 'method_not_allowed' : 'not_found' } };
  var ctx = { method: method, path: path, query: query, body: req.body || {}, user: null, ctoken: req.ctoken || null };
  if (route[3]) {
    ctx.user = verifyToken(req.token || query.token);
    if (!ctx.user) return { status: 401, body: { error: 'Unauthorized' } };
    if (route[3].indexOf(ctx.user.role) < 0) return { status: 403, body: { error: 'Forbidden' } };
  }
  var lock = null, cacheKey = null;
  if (route[5]) {
    // 起訖日以台灣日期判斷，日期加進快取鍵，跨日自動失效
    cacheKey = 'pub:' + publicCacheGen() + ':' + tpeDate() + ':' + full;
    try {
      var hit = CacheService.getScriptCache().get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (e0) { /* ignore */ }
  }
  try {
    if (route[4]) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) return { status: 503, body: { ok: false, message: '目前使用人數較多，請稍後再試一次' } };
      Store.reset();   // 取得鎖之後重新讀取，避免用到別人寫入前的舊資料
      if (route[3]) {
        // 鎖內重新驗證：等待期間被停用、刪除或降權者一律拒絕
        ctx.user = verifyToken(req.token || query.token);
        if (!ctx.user) return { status: 401, body: { error: 'Unauthorized' } };
        if (route[3].indexOf(ctx.user.role) < 0) return { status: 403, body: { error: 'Forbidden' } };
      }
    }
    var body = route[2](ctx, m);
    if (lock) SpreadsheetApp.flush();
    var out = { status: 200, body: body };
    if (cacheKey) {
      try { var str_ = JSON.stringify(out); if (str_.length < 90000) CacheService.getScriptCache().put(cacheKey, str_, 300); } catch (e1) { /* ignore */ }
    }
    return out;
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { ok: false, error: e.message, message: e.message } };
    console.error(e && e.stack || e);
    return { status: 500, body: { ok: false, error: 'internal_error', message: '系統忙碌或發生錯誤，請稍後再試' } };
  } finally {
    if (lock) try { lock.releaseLock(); } catch (e2) { /* ignore */ }
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return jsonOut({ status: 400, body: { error: 'bad_request' } }); }
  return jsonOut(dispatch(req));
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.path) return jsonOut({ status: 200, body: { name: 'Satisfaction Survey API (Apps Script)', version: CODE_VERSION } });
  var path = p.path;
  var extra = [];
  for (var k in p) if (k !== 'path' && k !== 'token') extra.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]));
  if (extra.length) path += (path.indexOf('?') < 0 ? '?' : '&') + extra.join('&');
  var r = dispatch({ method: 'GET', path: path, token: p.token });
  if (r.status === 200 && r.body && r.body.__csv !== undefined) {
    return ContentService.createTextOutput(r.body.__csv).setMimeType(ContentService.MimeType.CSV).downloadAsFile(r.body.__filename);
  }
  return jsonOut(r);
}
