// 端對端：真實頁面（Chromium）＋ 模擬後端（Code.gs 於 Node 執行）
// 執行：node test/e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createEnv } = require('./gas-mock');

const WEB = path.join(__dirname, '../web');
const EXEC = 'https://script.google.com/macros/s/TEST/exec';

const env = createEnv();
const pw = env.setup().match(/密碼：(\S+)/)[1];
const ids = env.seedDemo();

// 本機靜態伺服器（config.js 動態替換 API_BASE）
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(WEB, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p.endsWith('config.js')) body = Buffer.from(body.toString().replace('__APPS_SCRIPT_EXEC_URL__', EXEC));
  const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'application/javascript' : 'text/plain';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
  res.end(body);
});

const results = [];
function check(name, cond, extra) { results.push([name, !!cond]); console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : ' ' + (extra || ''))); }

(async () => {
  await new Promise(r => server.listen(8765, r));
  const base = 'http://localhost:8765';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // 外部 CDN 在測試環境無法連線：函式庫改由本機 node_modules 提供，Tailwind 以最小樣式代替
  const NM = path.join(__dirname, 'node_modules');
  const libs = { 'chart.umd.min.js': 'chart.js/dist/chart.umd.js', 'jsQR.js': 'jsqr/dist/jsQR.js', 'Sortable.min.js': 'sortablejs/Sortable.min.js' };
  await ctx.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: 'window.tailwind={};document.head.insertAdjacentHTML("beforeend","<style>.hidden{display:none!important}</style>")' }));
  await ctx.route(/fonts\.googleapis|fonts\.gstatic|api\.qrserver|chart\.googleapis/, r => r.fulfill({ status: 200, body: '' }));
  await ctx.route(/cdn\.jsdelivr\.net/, r => {
    const f = Object.keys(libs).find(k => r.request().url().endsWith(k));
    return f ? r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(NM, libs[f])) }) : r.fulfill({ status: 404, body: '' });
  });
  await ctx.route(EXEC + '**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const out = env.doPost({ postData: { contents: req.postData() } });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out.text });
    }
    const u = new URL(req.url());
    const out = env.doGet({ parameter: Object.fromEntries(u.searchParams) });
    return route.fulfill({ status: 200, contentType: out.file ? 'text/csv' : 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out.text });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // 1. 首頁 → 問卷
  await page.goto(base + '/index.html');
  await page.waitForSelector('text=民眾滿意度調查問卷', { timeout: 8000 });
  check('首頁列出問卷', true);

  await page.goto(base + '/survey.html?id=' + ids.survey_id);
  await page.waitForSelector('form#f input', { timeout: 8000 });
  // 每個題組選第一個選項（radio）；評分選 5；文字題填字
  await page.evaluate(() => {
    const groups = {};
    document.querySelectorAll('form#f input[type=radio]').forEach(el => { (groups[el.name] = groups[el.name] || []).push(el); });
    Object.values(groups).forEach(list => {
      const pick = list.find(x => x.value === '5') || list.find(x => x.value === '9') || list[0];
      pick.checked = true; pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.querySelectorAll('form#f textarea').forEach(t => { t.value = '服務很好'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  });
  await page.screenshot({ path: path.join(__dirname, 'shots/1-survey.png'), fullPage: false });
  await page.click('#submitBtn');
  await page.waitForURL(/success\.html/, { timeout: 8000 });
  await page.waitForSelector('text=/NA-\\d{8}-0001/', { timeout: 8000 });
  const code = (await page.textContent('body')).match(/NA-\d{8}-\d{4}-[0-9A-F]{4}/)[0];
  check('填答送出 → 完成頁顯示兌換券 ' + code, !!code);
  check('兌換券顯示贈品名稱', (await page.innerText('body')).includes('測試贈品'));
  await page.screenshot({ path: path.join(__dirname, 'shots/2-success.png'), fullPage: true });

  // 2. 我的兌換券
  await page.goto(base + '/my-coupons.html');
  await page.waitForSelector('text=' + code, { timeout: 8000 });
  check('我的兌換券列出該券', true);

  // 3. 再填一次 → 提示已有券
  await page.goto(base + '/survey.html?id=' + ids.survey_id);
  await page.waitForSelector('text=您已有一張未使用的兌換券', { timeout: 8000 });
  check('同裝置再開問卷 → 提示已有未使用券', true);

  // 4. 後台登入
  await page.goto(base + '/admin/login.html');
  await page.fill('#e', 'dari25420001@gmail.com');
  await page.fill('input[type=password]', pw);
  await page.click('#btn');
  await page.waitForURL(/dashboard|redeem/, { timeout: 8000 });
  check('後台登入成功', true);
  await page.waitForTimeout(800);
  check('儀表板顯示填答數', (await page.textContent('body')).includes('1'));

  // 5. 贈品庫存頁
  await page.goto(base + '/admin/gifts.html');
  await page.waitForSelector('text=測試贈品', { timeout: 8000 });
  let t = await page.textContent('#list');
  check('贈品頁：實際 20／預留 1／可發 19', /實際庫存\s*20/.test(t) && /已預留\s*1/.test(t) && /可發\s*19/.test(t), t.replace(/\s+/g, ' ').slice(0, 200));
  await page.click('text=＋ 入庫');
  await page.fill('#m_qty', '5');
  await page.click('#m_ok');
  await page.waitForFunction(() => /實際庫存\s*25/.test(document.querySelector('#list').textContent), null, { timeout: 8000 });
  check('入庫 5 → 實際 25', true);
  await page.click('text=－ 耗損');
  await page.fill('#m_qty', '1');
  await page.click('#m_ok');
  await page.waitForSelector('#m_err:has-text("原因")', { timeout: 5000 });
  check('耗損未填原因 → 顯示錯誤', true);
  await page.click('text=取消 >> nth=-1');
  await page.screenshot({ path: path.join(__dirname, 'shots/3-gifts.png'), fullPage: true });

  // 6. 核銷
  await page.goto(base + '/admin/redeem.html');
  await page.fill('#code', code);
  await page.click('#lookupBtn');
  await page.waitForSelector('#confirmBtn', { timeout: 8000 });
  check('核銷查詢顯示贈品', (await page.textContent('body')).includes('測試贈品'));
  await page.click('#confirmBtn');
  await page.waitForSelector('text=核銷成功', { timeout: 8000 });
  check('核銷成功', true);
  await page.screenshot({ path: path.join(__dirname, 'shots/4-redeem.png'), fullPage: true });
  env.Store.reset();
  const s = env.giftStock(ids.gift_id);
  check('核銷後庫存：實際 24／預留 0', s.on_hand === 24 && s.reserved === 0, JSON.stringify(s));

  // 7. 問卷編輯頁：贈品下拉
  await page.goto(base + '/admin/survey-edit.html?id=' + ids.survey_id);
  await page.waitForFunction(() => document.querySelector('#f_gift') && document.querySelector('#f_gift').value !== '', null, { timeout: 8000 });
  check('問卷編輯頁顯示所選贈品', (await page.$eval('#f_gift', el => el.selectedOptions[0].textContent)).includes('測試贈品'));

  // 8. 其他後台頁可載入
  for (const p of ['surveys', 'responses', 'comments', 'coupons', 'export', 'users']) {
    await page.goto(base + '/admin/' + p + '.html');
    await page.waitForTimeout(700);
    const body = (await page.innerText('body')).replace('上次更新錯誤', '');
    const m = body.match(/.{0,30}(失敗|Error|錯誤：).{0,30}/);
    check(`後台 ${p} 頁無錯誤`, !m, m && m[0].replace(/\s+/g, ' '));
  }
  check('系統版本顯示', (await page.textContent('#sysInfo')).includes('3.0.0'));

  check('頁面無 JavaScript 例外', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  const bad = results.filter(r => !r[1]).length;
  console.log(`\n結果：${results.length - bad} 通過，${bad} 失敗`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
