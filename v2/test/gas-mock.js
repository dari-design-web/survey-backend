// 本機測試用：模擬 Google Apps Script 服務，載入 Code.gs 執行
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeSheet(name) {
  const data = []; // 2D
  const sh = {
    name, data,
    getMaxRows: () => 1000,
    getLastRow: () => data.length,
    getRange(r, c, nr = 1, nc = 1) {
      return {
        setValues(vals) {
          for (let i = 0; i < nr; i++) {
            while (data.length < r + i) data.push([]);
            for (let j = 0; j < nc; j++) {
              let v = vals[i][j];
              data[r + i - 1][c + j - 1] = v;
            }
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) row.push((data[r + i - 1] || [])[c + j - 1] ?? '');
            out.push(row);
          }
          return out;
        },
        setNumberFormat() { return this; }
      };
    },
    getDataRange() {
      const nc = Math.max(0, ...data.map(r => r.length));
      return { getValues: () => data.map(r => { const x = r.slice(); while (x.length < nc) x.push(''); return x.map(v => v === undefined ? '' : v); }) };
    },
    setFrozenRows() {},
    deleteRow(r) { data.splice(r - 1, 1); }
  };
  return sh;
}

function createEnv(opts = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; }
  };
  const propStore = {};
  const cacheStore = {};
  let lockHeld = false;
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({
      tryLock() { if (lockHeld) return false; lockHeld = true; return true; },
      waitLock() { lockHeld = true; },
      releaseLock() { lockHeld = false; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => propStore[k] ?? null, setProperty: (k, v) => { propStore[k] = String(v); }, deleteProperty: k => { delete propStore[k]; }
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => cacheStore[k] ?? null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; }
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate(d, tz, fmt) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          .formatToParts(d).map(x => [x.type, x.value]));
        if (p.hour === '24') p.hour = '00';
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      base64EncodeWebSafe(x) {
        const buf = typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => (b + 256) % 256));
        return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      },
      base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)),
      newBlob(x) {
        const bytes = typeof x === 'string' ? Array.from(Buffer.from(x, 'utf8')).map(b => (b > 127 ? b - 256 : b)) : x;
        return { getBytes: () => bytes, getDataAsString: () => Buffer.from(bytes.map(b => (b + 256) % 256)).toString('utf8') };
      },
      computeHmacSha256Signature(input, key) {
        return Array.from(crypto.createHmac('sha256', key).update(input, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
      },
      computeDigest(alg, input) {
        return Array.from(crypto.createHash('sha256').update(input, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' }
    },
    ContentService: {
      MimeType: { JSON: 'json', CSV: 'csv' },
      createTextOutput(t) { const o = { text: t, setMimeType() { return o; }, downloadAsFile(n) { o.file = n; return o; } }; return o; }
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'dari25420001@gmail.com' }) },
    ScriptApp: {
      getProjectTriggers: () => [], deleteTrigger() {},
      newTrigger: () => { const b = { timeBased: () => b, everyDays: () => b, everyHours: () => b, atHour: () => b, create: () => ({}) }; return b; },
      getScriptId: () => 'SCRIPTID', getOAuthToken: () => 'tok'
    },
    UrlFetchApp: opts.UrlFetchApp || { fetch() { throw new Error('no network in test'); } },
    Logger: { log() {} },
    Date, JSON, Math
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/Code.gs'), 'utf8'), ctx);
  ctx.__sheets = sheets;
  ctx.__setLockHeld = v => { lockHeld = v; };
  return ctx;
}

module.exports = { createEnv };
