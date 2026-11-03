// 核心驗收案例（對應交接文件第十節）— 執行：node test/run-tests.js
const assert = require('assert');
const { createEnv } = require('./gas-mock');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
}

function api(env, method, path, body, token) {
  return env.dispatch({ method, path, body, token });
}

function boot() {
  const env = createEnv();
  const msg = env.setup();
  const pw = msg.match(/密碼：(\S+)/)[1];
  const ids = env.seedDemo();
  const login = api(env, 'POST', '/api/auth/login', { email: 'dari25420001@gmail.com', password: pw });
  assert.strictEqual(login.status, 200, JSON.stringify(login));
  const T = login.body.token;
  const s = api(env, 'GET', '/api/public/surveys/' + ids.survey_id).body;
  return { env, T, pw, ids, survey: s.survey, questions: s.questions };
}

function fullAnswers(qs, overrides = {}) {
  return qs.filter(q => q.question_type !== 'section').map(q => {
    let v;
    const opts = Array.isArray(q.options) ? q.options : (q.options ? JSON.parse(q.options) : []);
    if (q.question_type === 'rating') v = '4';
    else if (q.question_type === 'nps') v = '9';
    else if (q.question_type === 'single') v = opts[0];
    else if (q.question_type === 'multiple') v = [opts[0]];
    else v = '環境很整潔，人員很親切';
    if (overrides[q.id] !== undefined) v = overrides[q.id];
    return { questionId: q.id, value: v };
  });
}

function submit(ctx, device, extra = {}) {
  return api(ctx.env, 'POST', '/api/public/survey', Object.assign({
    surveyId: ctx.ids.survey_id, answers: fullAnswers(ctx.questions), deviceId: device,
    clientSubmitId: 'cs-' + Math.random()
  }, extra));
}

console.log('\n公開流程');
test('列表與讀取問卷', () => {
  const c = boot();
  const r = api(c.env, 'GET', '/api/public/surveys');
  assert.strictEqual(r.body.surveys.length, 1);
  assert.strictEqual(c.questions.length, 24);
  assert.strictEqual(c.survey.gift_name, '測試贈品');
});

test('新客人完成問卷 → 一張券、答案可查回、預扣 1', () => {
  const c = boot();
  const r = submit(c, 'devA');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.coupon && /^NA-\d{8}-0001-[0-9A-F]{4}$/.test(r.body.coupon.coupon_code), r.body.coupon && r.body.coupon.coupon_code);
  const g = api(c.env, 'GET', '/api/admin/gifts', null, c.T).body.gifts[0];
  assert.deepStrictEqual([g.on_hand, g.reserved, g.available], [20, 1, 19]);
  const resp = api(c.env, 'GET', '/api/admin/responses', null, c.T).body.rows[0];
  const detail = api(c.env, 'GET', '/api/admin/responses/' + resp.id, null, c.T).body;
  assert.strictEqual(detail.answers.length, 20);
  assert.strictEqual(resp.avg_score, 4);
});

test('連點／網路重送（同 clientSubmitId）→ 同一結果，不重複發券', () => {
  const c = boot();
  const a = submit(c, 'devA', { clientSubmitId: 'same-1' });
  const b = submit(c, 'devA', { clientSubmitId: 'same-1' });
  assert.strictEqual(a.body.coupon.coupon_code, b.body.coupon.coupon_code);
  assert.strictEqual(c.env.Store.all('coupons').length, 1);
  assert.strictEqual(c.env.Store.all('survey_responses').length, 1);
});

test('同問卷已有有效券 → 回傳既有券，不增加預留', () => {
  const c = boot();
  const a = submit(c, 'devA');
  const b = submit(c, 'devA');
  assert.strictEqual(b.body.reason, 'existing_coupon');
  assert.strictEqual(b.body.coupon.coupon_code, a.body.coupon.coupon_code);
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).reserved, 1);
  const pre = api(c.env, 'GET', '/api/public/precheck/' + c.ids.survey_id + '?deviceId=devA').body;
  assert.strictEqual(pre.reason, 'existing_coupon');
});

test('核銷：庫存 −1、預留 −1；第二次核銷顯示已使用且只扣一次', () => {
  const c = boot();
  const code = submit(c, 'devA').body.coupon.coupon_code;
  const r1 = api(c.env, 'POST', '/api/redeem', { code }, c.T);
  const r2 = api(c.env, 'POST', '/api/redeem', { code }, c.T);
  assert.strictEqual(r1.body.ok, true);
  assert.strictEqual(r2.body.status, 'already_redeemed');
  const s = c.env.giftStock(c.ids.gift_id);
  assert.deepStrictEqual([s.on_hand, s.reserved, s.available], [19, 0, 19]);
});

test('同時核銷（鎖被占用）→ 回 503 請重試，不會重複扣', () => {
  const c = boot();
  const code = submit(c, 'devA').body.coupon.coupon_code;
  c.env.__setLockHeld(true);
  const r = api(c.env, 'POST', '/api/redeem', { code }, c.T);
  c.env.__setLockHeld(false);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).on_hand, 20);
});

test('最後一份贈品 → 不超發、不負庫存；之後填答成功但不發券', () => {
  const c = boot();
  // 把庫存調到只剩 1
  const loss = api(c.env, 'POST', '/api/admin/gifts/' + c.ids.gift_id + '/stock', { action: 'count', qty: 1, note: '盤點' }, c.T);
  assert.strictEqual(loss.status, 200, JSON.stringify(loss.body));
  const a = submit(c, 'dev1');
  const b = submit(c, 'dev2');
  assert.ok(a.body.coupon);
  assert.strictEqual(b.body.reason, 'out_of_stock');
  assert.ok(!b.body.coupon);
  const pre = api(c.env, 'GET', '/api/public/precheck/' + c.ids.survey_id + '?deviceId=dev3').body;
  assert.strictEqual(pre.reason, 'out_of_stock');
  const s = c.env.giftStock(c.ids.gift_id);
  assert.deepStrictEqual([s.on_hand, s.reserved, s.available], [1, 1, 0]);
  assert.strictEqual(c.env.Store.all('survey_responses').length, 2); // 答案仍保存
});

test('庫存調整不可低於已預留（避免答應的贈品不見）', () => {
  const c = boot();
  submit(c, 'dev1'); submit(c, 'dev2');
  const r = api(c.env, 'POST', '/api/admin/gifts/' + c.ids.gift_id + '/stock', { action: 'count', qty: 1, note: '盤點' }, c.T);
  assert.strictEqual(r.status, 400);
  const l = api(c.env, 'POST', '/api/admin/gifts/' + c.ids.gift_id + '/stock', { action: 'loss', qty: 2 }, c.T);
  assert.strictEqual(l.status, 400, '耗損未填原因應拒絕');
});

test('券過期 → 不能核銷、預留自動釋放且只釋放一次', () => {
  const c = boot();
  const cp = submit(c, 'devA').body.coupon;
  c.env.Store.update('coupons', cp.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).reserved, 0);
  const r = api(c.env, 'POST', '/api/redeem', { code: cp.coupon_code }, c.T);
  assert.strictEqual(r.body.status, 'expired');
  c.env.reconcile(); c.env.reconcile();
  const s = c.env.giftStock(c.ids.gift_id);
  assert.deepStrictEqual([s.on_hand, s.reserved, s.available], [20, 0, 20]);
  // 過期後可再領新券
  assert.ok(submit(c, 'devA').body.coupon);
});

test('作廢 → 釋放預留；已核銷不可作廢', () => {
  const c = boot();
  const cp = submit(c, 'devA').body.coupon;
  const v = api(c.env, 'POST', '/api/admin/coupons/' + cp.id + '/void', { note: '測試' }, c.T);
  assert.strictEqual(v.body.ok, true);
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).reserved, 0);
  const cp2 = submit(c, 'devB').body.coupon;
  api(c.env, 'POST', '/api/redeem', { code: cp2.coupon_code }, c.T);
  const v2 = api(c.env, 'POST', '/api/admin/coupons/' + cp2.id + '/void', {}, c.T);
  assert.strictEqual(v2.body.ok, false);
});

test('中途失敗恢復：已核銷但缺出庫紀錄 → 對帳補登一次', () => {
  const c = boot();
  const cp = submit(c, 'devA').body.coupon;
  // 模擬：券狀態寫成 redeemed，但寫庫存紀錄前中斷
  c.env.Store.update('coupons', cp.id, { status: 'redeemed', redeemed_at: new Date().toISOString(), redeemed_by: 1 });
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).on_hand, 20);
  const r1 = c.env.reconcile();
  const r2 = c.env.reconcile();
  assert.strictEqual(r1.fixed, 1); assert.strictEqual(r2.fixed, 0);
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).on_hand, 19);
});

test('問卷停用／未開始／已結束 → 列表、直接網址、提交一致拒絕', () => {
  const c = boot();
  const sid = c.ids.survey_id;
  for (const patch of [{ is_active: 0 }, { start_date: '2999-01-01' }, { end_date: '2000-01-01' }]) {
    c.env.Store.update('surveys', sid, Object.assign({ is_active: 1, start_date: null, end_date: null }, patch));
    assert.strictEqual(api(c.env, 'GET', '/api/public/surveys').body.surveys.length, 0);
    assert.notStrictEqual(api(c.env, 'GET', '/api/public/surveys/' + sid).status, 200);
    assert.notStrictEqual(submit(c, 'devX').status, 200);
  }
});

test('必填、條件題與偽造資料 → 後端拒絕', () => {
  const c = boot();
  const req = c.questions.find(q => q.question_type === 'single');
  const rating = c.questions.find(q => q.question_type === 'rating');
  assert.strictEqual(submit(c, 'd', { answers: fullAnswers(c.questions, { [req.id]: '' }) }).status, 400);
  assert.strictEqual(submit(c, 'd', { answers: fullAnswers(c.questions, { [req.id]: '亂填的選項' }) }).status, 400);
  assert.strictEqual(submit(c, 'd', { answers: fullAnswers(c.questions, { [rating.id]: '99' }) }).status, 400);
  assert.strictEqual(submit(c, 'd', { answers: fullAnswers(c.questions).concat([{ questionId: 99999, value: 'x' }]) }).status, 400);
  // 「其他：xxx」與「未使用／不適用」可接受
  const ok = submit(c, 'd', { answers: fullAnswers(c.questions, { [req.id]: '其他：路過', [rating.id]: '未使用／不適用' }) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  // 條件題：依賴題未符合 → 不必填
  const nps = c.questions.find(q => q.question_type === 'nps');
  c.env.Store.update('survey_questions', nps.id, { display_condition: { depends_on: req.id, show_when: ['洽公民眾'] } });
  const ans = fullAnswers(c.questions).filter(a => a.questionId !== nps.id);
  assert.strictEqual(submit(c, 'd2', { answers: ans }).status, 200);
  const ans2 = fullAnswers(c.questions, { [req.id]: '洽公民眾' }).filter(a => a.questionId !== nps.id);
  assert.strictEqual(submit(c, 'd3', { answers: ans2 }).status, 400);
});

test('權限：未登入、staff 不能做管理操作；staff 可核銷', () => {
  const c = boot();
  assert.strictEqual(api(c.env, 'GET', '/api/admin/responses').status, 401);
  assert.strictEqual(api(c.env, 'GET', '/api/admin/responses', null, 'a.b.c').status, 401);
  const cr = api(c.env, 'POST', '/api/admin/admin-users', { name: '現場', email: 'staff@x.com', password: 'Staff12345', role: 'staff' }, c.T);
  assert.strictEqual(cr.status, 200);
  const st = api(c.env, 'POST', '/api/auth/login', { email: 'staff@x.com', password: 'Staff12345' }).body.token;
  assert.strictEqual(api(c.env, 'GET', '/api/admin/responses', null, st).status, 403);
  assert.strictEqual(api(c.env, 'POST', '/api/admin/gifts/1/stock', { action: 'receive', qty: 5 }, st).status, 403);
  const code = submit(c, 'devA').body.coupon.coupon_code;
  assert.strictEqual(api(c.env, 'POST', '/api/redeem', { code }, st).body.ok, true);
  // 停用帳號後 token 立即失效
  const uid = c.env.Store.findOne('admin_users', u => u.email === 'staff@x.com').id;
  api(c.env, 'PUT', '/api/admin/admin-users/' + uid, { name: '現場', role: 'staff', is_active: false }, c.T);
  assert.strictEqual(api(c.env, 'GET', '/api/redeem/lookup?code=' + code, null, st).status, 401);
});

test('登入錯誤 5 次鎖定', () => {
  const c = boot();
  for (let i = 0; i < 5; i++) assert.strictEqual(api(c.env, 'POST', '/api/auth/login', { email: 'dari25420001@gmail.com', password: 'wrong' }).status, 401);
  assert.strictEqual(api(c.env, 'POST', '/api/auth/login', { email: 'dari25420001@gmail.com', password: c.pw }).status, 429);
});

test('問卷改版後查看舊填答 → 保留當時題目文字', () => {
  const c = boot();
  submit(c, 'devA');
  const q = c.questions.find(x => x.question_type === 'rating');
  api(c.env, 'PUT', '/api/admin/questions/' + q.id, Object.assign({}, q, { question_text: '新題目文字' }), c.T);
  const rid = c.env.Store.all('survey_responses')[0].id;
  const d = api(c.env, 'GET', '/api/admin/responses/' + rid, null, c.T).body;
  assert.ok(d.answers.some(a => a.question_text === q.question_text));
  assert.ok(!d.answers.some(a => a.question_text === '新題目文字'));
});

test('庫存對帳：期初 + 入庫 − 核銷 − 耗損 = 實際；紀錄不因查券消失', () => {
  const c = boot();
  const gid = c.ids.gift_id;
  api(c.env, 'POST', '/api/admin/gifts/' + gid + '/stock', { action: 'receive', qty: 10, note: '補貨' }, c.T);
  api(c.env, 'POST', '/api/admin/gifts/' + gid + '/stock', { action: 'loss', qty: 2, note: '破損' }, c.T);
  const code = submit(c, 'devA').body.coupon.coupon_code;
  api(c.env, 'POST', '/api/redeem', { code }, c.T);
  api(c.env, 'GET', '/api/public/my-coupons?deviceId=devA');
  const logs = api(c.env, 'GET', '/api/admin/gifts/' + gid + '/logs', null, c.T).body.logs;
  assert.strictEqual(JSON.stringify(logs.map(l => l.action).reverse()), JSON.stringify(['receive', 'receive', 'loss', 'redeem']));
  assert.strictEqual(c.env.giftStock(gid).on_hand, 20 + 10 - 2 - 1);
  assert.strictEqual(logs[0].on_hand_after, 27);
  assert.strictEqual(c.env.Store.all('coupons').length, 1);
});

test('換新贈品：新增贈品並切換問卷 → 新券掛新贈品', () => {
  const c = boot();
  const g2 = api(c.env, 'POST', '/api/admin/gifts', { name: '帆布袋', initial_qty: 50 }, c.T).body;
  const sv = api(c.env, 'GET', '/api/admin/surveys/' + c.ids.survey_id, null, c.T).body.survey;
  const up = api(c.env, 'PUT', '/api/admin/surveys/' + sv.id, Object.assign({}, sv, { gift_id: g2.id }), c.T);
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const cp = submit(c, 'devZ').body.coupon;
  assert.strictEqual(cp.gift_name, '帆布袋');
  assert.strictEqual(c.env.giftStock(g2.id).available, 49);
});

test('兌換期限 24 小時：逾時未兌換自動取消並回補庫存', () => {
  const c = boot();
  const cp = submit(c, 'devA').body.coupon;
  const hrs = (new Date(cp.expires_at) - new Date(cp.issued_at)) / 3600000;
  assert.strictEqual(hrs, 24);
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).available, 19);
  c.env.Store.update('coupons', cp.id, { expires_at: new Date(Date.now() - 1).toISOString() });
  assert.strictEqual(c.env.giftStock(c.ids.gift_id).available, 20);
  const lk = api(c.env, 'GET', '/api/redeem/lookup?code=' + cp.coupon_code, null, c.T).body.coupon;
  assert.strictEqual(lk.status, 'expired');
  // 後台可改期限（小時）
  const sv = api(c.env, 'GET', '/api/admin/surveys/' + c.ids.survey_id, null, c.T).body.survey;
  api(c.env, 'PUT', '/api/admin/surveys/' + sv.id, Object.assign({}, sv, { coupon_valid_hours: 2 }), c.T);
  const cp2 = submit(c, 'devB').body.coupon;
  assert.strictEqual((new Date(cp2.expires_at) - new Date(cp2.issued_at)) / 3600000, 2);
});

console.log('\nGPT 審查（R1–R6）回歸測試');
test('R1 核銷中途失敗：不超發、可發不為負，重試只出庫一次', () => {
  const c = boot();
  api(c.env, 'POST', '/api/admin/gifts/' + c.ids.gift_id + '/stock', { action: 'count', qty: 1, note: '盤點' }, c.T);
  const cp = submit(c, 'dev1').body.coupon;
  const orig = c.env.Store.update;
  let failOnce = true;
  c.env.Store.update = function (name, id, patch) {
    if (name === 'coupons' && patch.status === 'redeemed' && failOnce) { failOnce = false; throw new Error('模擬寫入失敗'); }
    return orig.apply(this, arguments);
  };
  const r1 = api(c.env, 'POST', '/api/redeem', { code: cp.coupon_code }, c.T);
  assert.strictEqual(r1.status, 500);
  c.env.Store.reset();
  let st = c.env.giftStock(c.ids.gift_id);
  assert.ok(st.available >= 0 && st.available === 0, JSON.stringify(st));
  assert.strictEqual(submit(c, 'dev2').body.reason, 'out_of_stock');      // 不會超發
  const r2 = api(c.env, 'POST', '/api/redeem', { code: cp.coupon_code }, c.T);
  assert.strictEqual(r2.body.ok, true);
  c.env.Store.update = orig;
  c.env.reconcile(); c.env.reconcile();
  st = c.env.giftStock(c.ids.gift_id);
  assert.strictEqual(JSON.stringify([st.on_hand, st.reserved, st.available]), JSON.stringify([0, 0, 0]));
});

test('R1 核銷失敗後券逾期：對帳回補一次', () => {
  const c = boot();
  const cp = submit(c, 'dev1').body.coupon;
  const orig = c.env.Store.update;
  c.env.Store.update = function (name, id, patch) {
    if (name === 'coupons' && patch.status === 'redeemed') throw new Error('x');
    return orig.apply(this, arguments);
  };
  api(c.env, 'POST', '/api/redeem', { code: cp.coupon_code }, c.T);
  c.env.Store.update = orig;
  c.env.Store.reset();
  c.env.Store.update('coupons', cp.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const r = c.env.reconcile(); c.env.reconcile();
  const st = c.env.giftStock(c.ids.gift_id);
  assert.strictEqual(r.fixed, 1);
  assert.strictEqual(JSON.stringify([st.on_hand, st.reserved, st.available]), JSON.stringify([20, 0, 20]));
});

test('R2 等鎖期間帳號被停用 → 寫入被拒', () => {
  const c = boot();
  const orig = c.env.LockService.getScriptLock;
  c.env.LockService.getScriptLock = () => ({
    tryLock() { c.env.Store.reset(); c.env.Store.update('admin_users', 1, { is_active: 0 }); return true; },
    releaseLock() {}
  });
  const r = api(c.env, 'POST', '/api/admin/gifts', { name: '不該建立', initial_qty: 1 }, c.T);
  c.env.LockService.getScriptLock = orig;
  assert.strictEqual(r.status, 401);
  c.env.Store.reset();
  assert.ok(!c.env.Store.all('gifts').some(g => g.name === '不該建立'));
});

test('R4 條件題循環：儲存時拒絕；資料已循環時送出不當機', () => {
  const c = boot();
  const sid = c.ids.survey_id;
  const qa = c.questions.find(q => q.question_type === 'nps'), qb = c.questions.find(q => q.question_type === 'multiple');
  const r1 = api(c.env, 'PUT', '/api/admin/questions/' + qa.id, Object.assign({}, qa, { display_condition: { depends_on: qa.id, show_when: ['1'] } }), c.T);
  assert.strictEqual(r1.status, 400);
  api(c.env, 'PUT', '/api/admin/questions/' + qa.id, Object.assign({}, qa, { display_condition: { depends_on: qb.id, show_when: ['x'] } }), c.T);
  const r2 = api(c.env, 'PUT', '/api/admin/questions/' + qb.id, Object.assign({}, qb, { display_condition: { depends_on: qa.id, show_when: ['1'] } }), c.T);
  assert.strictEqual(r2.status, 400);
  c.env.Store.reset();
  c.env.Store.update('survey_questions', qb.id, { display_condition: { depends_on: qa.id, show_when: ['1'] } });
  const ans = fullAnswers(c.questions).filter(a => a.questionId !== qa.id && a.questionId !== qb.id);
  assert.strictEqual(submit(c, 'dev9', { answers: ans }).status, 200);
});

test('R5 送出中途失敗後重試：只留下一筆填答與一張券', () => {
  const c = boot();
  const orig = c.env.Store.insertMany;
  let failOnce = true;
  c.env.Store.insertMany = function (name) {
    if (name === 'survey_answers' && failOnce) { failOnce = false; throw new Error('模擬寫入失敗'); }
    return orig.apply(this, arguments);
  };
  const a = submit(c, 'devR', { clientSubmitId: 'retry-1' });
  const b = submit(c, 'devR', { clientSubmitId: 'retry-1' });
  c.env.Store.insertMany = orig;
  assert.strictEqual(a.status, 500);
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  c.env.Store.reset();
  assert.strictEqual(c.env.Store.all('survey_responses').length, 1);
  assert.strictEqual(c.env.Store.all('coupons').length, 1);
  assert.strictEqual(c.env.Store.all('survey_answers').length, 20);
});

test('R6 刪除題目後匯出仍保留舊答案（標示已刪除）', () => {
  const c = boot();
  const ta = c.questions.find(q => q.question_type === 'textarea');
  submit(c, 'devA', { answers: fullAnswers(c.questions, { [ta.id]: '舊答案保留' }) });
  api(c.env, 'DELETE', '/api/admin/questions/' + ta.id, null, c.T);
  const csv = api(c.env, 'GET', '/api/admin/export/responses', null, c.T).body.__csv;
  assert.ok(csv.includes('舊答案保留'));
  assert.ok(csv.includes('（已刪除題目）'));
});

test('R5b 其他裝置重用送出編號：不會拿到別人的券', () => {
  const c = boot();
  const a = submit(c, 'devA', { clientSubmitId: 'shared-id' });
  const b = submit(c, 'devB', { clientSubmitId: 'shared-id' });
  assert.strictEqual(b.status, 200);
  assert.ok(!b.body.duplicate);
  assert.notStrictEqual(b.body.coupon.coupon_code, a.body.coupon.coupon_code);
  assert.strictEqual(b.body.deviceId, 'devB');
  const a2 = submit(c, 'devA', { clientSubmitId: 'shared-id' });
  assert.strictEqual(a2.body.duplicate, true);
  assert.strictEqual(a2.body.coupon.coupon_code, a.body.coupon.coupon_code);
});

test('R6b 改題名後匯出：欄名附上曾用題名', () => {
  const c = boot();
  const q = c.questions.find(x => x.question_type === 'textarea');
  submit(c, 'devA', { answers: fullAnswers(c.questions, { [q.id]: '舊題目的回答' }) });
  api(c.env, 'PUT', '/api/admin/questions/' + q.id, Object.assign({}, q, { question_text: '全新的題目文字' }), c.T);
  const csv = api(c.env, 'GET', '/api/admin/export/responses', null, c.T).body.__csv;
  assert.ok(csv.includes('全新的題目文字［曾用題名：' + q.question_text + '］'), csv.split('\n')[0].slice(0, 300));
});

test('G8-L1 舊格式送出編號（升級前）重試：不多存一筆，且仍限同裝置', () => {
  const c = boot();
  const a = submit(c, 'devOld', { clientSubmitId: 'legacy-1' });
  c.env.Store.reset();
  const r = c.env.Store.all('survey_responses')[0];
  c.env.Store.update('survey_responses', r.id, { client_submit_id: 'legacy-1' });   // 模擬舊版格式
  const b = submit(c, 'devOld', { clientSubmitId: 'legacy-1' });
  assert.strictEqual(b.body.duplicate, true);
  assert.strictEqual(b.body.coupon.coupon_code, a.body.coupon.coupon_code);
  const other = submit(c, 'devOther', { clientSubmitId: 'legacy-1' });
  assert.ok(!other.body.duplicate);
  c.env.Store.reset();
  assert.strictEqual(c.env.Store.all('survey_responses').length, 2);
  // 舊格式且 result 為空（中途失敗）→ 同裝置續傳同一筆
  const c2 = boot();
  submit(c2, 'devX', { clientSubmitId: 'legacy-2' });
  c2.env.Store.reset();
  const r2 = c2.env.Store.all('survey_responses')[0];
  c2.env.Store.update('survey_responses', r2.id, { client_submit_id: 'legacy-2', result: null });
  assert.strictEqual(submit(c2, 'devX', { clientSubmitId: 'legacy-2' }).status, 200);
  c2.env.Store.reset();
  assert.strictEqual(c2.env.Store.all('survey_responses').length, 1);
  assert.strictEqual(c2.env.Store.all('coupons').length, 1);
});

console.log('\n每月限領、Google 登入、贈品圖片（3.3.0）');
test('每月限領：本月兌換過任一問卷 → 拒絕，下個月 1 日起可再領', () => {
  const c = boot();
  const cp = submit(c, 'devM').body.coupon;
  api(c.env, 'POST', '/api/redeem', { code: cp.coupon_code }, c.T);
  const r = submit(c, 'devM');
  assert.strictEqual(r.body.reason, 'monthly_limit');
  assert.ok(!r.body.coupon);
  const pre = api(c.env, 'GET', '/api/public/precheck/' + c.ids.survey_id + '?deviceId=devM').body;
  assert.strictEqual(pre.reason, 'monthly_limit');
  assert.ok(/^\d{4}-\d{2}-01$/.test(pre.nextDate), pre.nextDate);
  // 另一份問卷也不行（跨問卷）
  const s2 = api(c.env, 'POST', '/api/admin/surveys', { title: '第二份', is_active: true, generate_coupon: true }, c.T).body.id;
  const q = api(c.env, 'POST', '/api/admin/surveys/' + s2 + '/questions', { question_text: 'Q', question_type: 'text' }, c.T).body.question;
  const r2 = api(c.env, 'POST', '/api/public/survey', { surveyId: s2, answers: [{ questionId: q.id, value: 'x' }], deviceId: 'devM', clientSubmitId: 'm2' });
  assert.strictEqual(r2.body.reason, 'monthly_limit');
  // 上個月兌換的不影響本月
  c.env.Store.reset();
  c.env.Store.update('coupons', cp.id, { redeemed_at: new Date(Date.now() - 40 * 86400000).toISOString() });
  assert.ok(submit(c, 'devM').body.coupon);
});

test('每月限領：逾期未兌換的券不算，可重新領取；有效券跨問卷也會回傳', () => {
  const c = boot();
  const cp = submit(c, 'devE').body.coupon;
  const s2 = api(c.env, 'POST', '/api/admin/surveys', { title: '第二份', is_active: true, generate_coupon: true }, c.T).body.id;
  const q = api(c.env, 'POST', '/api/admin/surveys/' + s2 + '/questions', { question_text: 'Q', question_type: 'text' }, c.T).body.question;
  const r2 = api(c.env, 'POST', '/api/public/survey', { surveyId: s2, answers: [{ questionId: q.id, value: 'x' }], deviceId: 'devE', clientSubmitId: 'e2' });
  assert.strictEqual(r2.body.reason, 'existing_coupon');
  c.env.Store.reset();
  c.env.Store.update('coupons', cp.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.ok(submit(c, 'devE').body.coupon);
});

function googleEnv(sub) {
  const { createEnv } = require('./gas-mock');
  let currentSub = sub;
  const env = createEnv({ UrlFetchApp: { fetch(url) {
    if (url.indexOf('tokeninfo') >= 0) {
      const tok = decodeURIComponent(url.split('id_token=')[1]);
      if (tok === 'bad') return { getResponseCode: () => 400, getContentText: () => '{}' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ aud: '123-abc.apps.googleusercontent.com', iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 600), sub: tok, email_verified: tok.indexOf('unverified') >= 0 ? 'false' : 'true' }) };
    }
    throw new Error('no network');
  } } });
  const pw = env.setup().match(/密碼：(\S+)/)[1];
  const ids = env.seedDemo();
  const T = env.dispatch({ method: 'POST', path: '/api/auth/login', body: { email: 'dari25420001@gmail.com', password: pw } }).body.token;
  return { env, T, ids };
}

test('Google 登入：啟用後未登入不能送出；登入後依帳號限領，換裝置無效', () => {
  const g = googleEnv();
  const set = g.env.dispatch({ method: 'POST', path: '/api/admin/system/google', body: { client_id: '123-abc.apps.googleusercontent.com' }, token: g.T });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  const cfg = g.env.dispatch({ method: 'GET', path: '/api/public/config' }).body;
  assert.strictEqual(cfg.login_required, true);
  const qs = g.env.dispatch({ method: 'GET', path: '/api/public/surveys/' + g.ids.survey_id }).body.questions;
  const ctx = { env: g.env, ids: g.ids, questions: qs };
  assert.strictEqual(submit(ctx, 'dev1').status, 403);
  assert.strictEqual(g.env.dispatch({ method: 'POST', path: '/api/public/login/google', body: { credential: 'bad' } }).status, 401);
  const ct = g.env.dispatch({ method: 'POST', path: '/api/public/login/google', body: { credential: 'user-sub-1' } }).body.ctoken;
  assert.ok(ct);
  const send = (dev, extra) => g.env.dispatch({ method: 'POST', path: '/api/public/survey', ctoken: ct,
    body: Object.assign({ surveyId: g.ids.survey_id, answers: fullAnswers(qs), deviceId: dev, clientSubmitId: 'g' + Math.random() }, extra || {}) });
  const a = send('dev1');
  assert.ok(a.body.coupon, JSON.stringify(a.body));
  assert.strictEqual(a.body.deviceId, null);
  g.env.dispatch({ method: 'POST', path: '/api/redeem', body: { code: a.body.coupon.coupon_code }, token: g.T });
  assert.strictEqual(send('another-phone').body.reason, 'monthly_limit');   // 換裝置也一樣
  // 同一 Google 帳號重新登入 → 同一使用者
  const ct2 = g.env.dispatch({ method: 'POST', path: '/api/public/login/google', body: { credential: 'user-sub-1' } }).body.ctoken;
  const mine = g.env.dispatch({ method: 'GET', path: '/api/public/my-coupons', ctoken: ct2 }).body.coupons;
  assert.strictEqual(mine.length, 1);
  // 帳號只存雜湊，不存原始 sub
  g.env.Store.reset();
  assert.ok(g.env.Store.all('users').every(u => !String(u.external_id).includes('user-sub-1')));
});

test('贈品圖片：上傳、分段儲存、公開讀取、格式與大小檢查、刪除', () => {
  const c = boot();
  const gid = c.ids.gift_id;
  const big = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(99996);
  const up = api(c.env, 'POST', '/api/admin/gifts/' + gid + '/image', { data_url: big }, c.T);
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  c.env.Store.reset();
  assert.strictEqual(c.env.Store.all('gift_images').length, 3);
  const pub = api(c.env, 'GET', '/api/public/gift-image/' + gid).body;
  assert.strictEqual(pub.data_url, big);
  assert.ok(api(c.env, 'GET', '/api/public/surveys/' + c.ids.survey_id).body.survey.gift_image);
  assert.strictEqual(api(c.env, 'POST', '/api/admin/gifts/' + gid + '/image', { data_url: 'javascript:alert(1)' }, c.T).status, 400);
  assert.strictEqual(api(c.env, 'POST', '/api/admin/gifts/' + gid + '/image', { data_url: 'data:image/jpeg;base64,' + 'A'.repeat(130000) }, c.T).status, 400);
  api(c.env, 'DELETE', '/api/admin/gifts/' + gid + '/image', null, c.T);
  assert.strictEqual(api(c.env, 'GET', '/api/public/gift-image/' + gid).status, 404);
});

test('G11 修正：登入旗標、Email 驗證、圖片內容檢查、更新失敗保留舊圖', () => {
  // F1：無贈品、缺貨時也帶 need_login
  const g = googleEnv();
  g.env.dispatch({ method: 'POST', path: '/api/admin/system/google', body: { client_id: '123-abc.apps.googleusercontent.com' }, token: g.T });
  const pre = () => g.env.dispatch({ method: 'GET', path: '/api/public/precheck/' + g.ids.survey_id + '?deviceId=x' }).body;
  assert.strictEqual(pre().need_login, true);
  g.env.Store.reset(); g.env.Store.update('surveys', g.ids.survey_id, { gift_id: null, generate_coupon: 0 });
  const p2 = pre();
  assert.strictEqual(p2.need_login, true, JSON.stringify(p2));
  // F3：Email 未驗證拒絕
  assert.strictEqual(g.env.dispatch({ method: 'POST', path: '/api/public/login/google', body: { credential: 'unverified-1' } }).status, 401);
  assert.strictEqual(g.env.dispatch({ method: 'POST', path: '/api/public/login/google', body: { credential: 'ok-1' } }).status, 200);

  const c = boot();
  const gid = c.ids.gift_id;
  const up = d => api(c.env, 'POST', '/api/admin/gifts/' + gid + '/image', { data_url: d }, c.T);
  // F6：宣告 PNG 但內容不是 PNG → 拒絕；真 PNG 檔頭 → 接受
  assert.strictEqual(up('data:image/png;base64,' + Buffer.from('Hello world, this is not an image at all!').toString('base64')).status, 400);
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]).toString('base64');
  assert.strictEqual(up(png).status, 200);
  const webp = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40)]).toString('base64');
  // F2：新圖寫入失敗時，舊圖仍在
  c.env.Store.reset();
  const orig = c.env.Store.insertMany;
  c.env.Store.insertMany = function (name) { if (name === 'gift_images') throw new Error('寫入失敗'); return orig.apply(this, arguments); };
  assert.strictEqual(up(webp).status, 500);
  c.env.Store.insertMany = orig;
  c.env.Store.reset();
  const still = api(c.env, 'GET', '/api/public/gift-image/' + gid);
  assert.strictEqual(still.status, 200);
  assert.strictEqual(still.body.data_url, png);
  // 重試成功後只留新版
  assert.strictEqual(up(webp).status, 200);
  c.env.Store.reset();
  assert.strictEqual(api(c.env, 'GET', '/api/public/gift-image/' + gid).body.data_url, webp);
  assert.ok(c.env.Store.all('gift_images').every(x => x.data === webp || webp.indexOf(x.data) >= 0));
});

test('評分題：可自訂兩端說明、可關閉「未使用／不適用」', () => {
  const c = boot();
  const qs = api(c.env, 'GET', '/api/public/surveys/' + c.ids.survey_id).body.questions;
  const rq = qs.find(q => q.question_type === 'rating');
  const send = (val, dev) => api(c.env, 'POST', '/api/public/survey', { surveyId: c.ids.survey_id, deviceId: dev, clientSubmitId: 'r' + Math.random(),
    answers: fullAnswers(qs).map(a => a.questionId === rq.id ? { questionId: rq.id, value: val } : a) });
  // 舊題目（未設定）仍可選不適用
  assert.strictEqual(send('未使用／不適用', 'rA').status, 200);
  // 設定成不提供不適用
  c.env.Store.reset();
  c.env.Store.update('survey_questions', rq.id, { options: ['非常不願意', '非常願意'] });
  c.env.dispatch({ method: 'POST', path: '/api/admin/system/reconcile', token: c.T });
  c.env.Store.reset();
  assert.strictEqual(send('未使用／不適用', 'rB').status, 400);
  assert.strictEqual(send(4, 'rC').status, 200);
});

test('後台帳號：可只建帳號不填 Email，用帳號或 Email 登入', () => {
  const c = boot();
  const mk = body => api(c.env, 'POST', '/api/admin/admin-users', body, c.T);
  assert.strictEqual(mk({ name: '現場一', username: 'Staff01', password: 'abcd1234', role: 'staff' }).status, 200);
  assert.strictEqual(mk({ name: '重複', username: 'staff01', password: 'abcd1234', role: 'staff' }).status, 400);
  assert.strictEqual(mk({ name: '格式錯', username: 'a b', password: 'abcd1234', role: 'staff' }).status, 400);
  assert.strictEqual(mk({ name: '都沒填', password: 'abcd1234', role: 'staff' }).status, 400);
  const lg = (login, password) => c.env.dispatch({ method: 'POST', path: '/api/auth/login', body: { login, password } });
  const r = lg('STAFF01', 'abcd1234');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.user.role, 'staff');
  assert.strictEqual(lg('staff01', 'wrongpass').status, 401);
  // 舊版前端以 email 欄位送出、舊帳號用 Email 登入仍可
  assert.strictEqual(c.env.dispatch({ method: 'POST', path: '/api/auth/login', body: { email: 'dari25420001@gmail.com', password: c.pw } }).status, 200);
  // 刪除：從列表消失、不能登入、舊 token 失效、帳號可重新使用；不能刪自己
  const list = () => api(c.env, 'GET', '/api/admin/admin-users', null, c.T).body.users;
  const sid = list().find(u => u.username === 'staff01').id;
  const st = r.body.token;
  assert.strictEqual(api(c.env, 'DELETE', '/api/admin/admin-users/' + sid, null, c.T).status, 200);
  assert.ok(!list().some(u => u.id === sid));
  assert.strictEqual(lg('staff01', 'abcd1234').status, 401);
  assert.strictEqual(api(c.env, 'GET', '/api/redeem/lookup?code=X', null, st).status, 401);
  assert.strictEqual(mk({ name: '新人', username: 'staff01', password: 'abcd1234', role: 'staff' }).status, 200);
  const me = list().find(u => u.role === 'super').id;
  assert.strictEqual(api(c.env, 'DELETE', '/api/admin/admin-users/' + me, null, c.T).status, 400);
});

console.log('\n後台與匯出');
test('儀表板、意見、兌換券列表、我的兌換券', () => {
  const c = boot();
  submit(c, 'devA'); submit(c, 'devB');
  const d = api(c.env, 'GET', '/api/admin/dashboard', null, c.T).body;
  assert.strictEqual(d.cards.totalResponses, 2);
  assert.strictEqual(d.cards.todayResponses, 2);
  assert.strictEqual(d.cards.issuedCoupons, 2);
  assert.strictEqual(d.npsSummary.score, 100);
  assert.ok(d.categoricalDist.length >= 7);
  assert.strictEqual(api(c.env, 'GET', '/api/admin/comments', null, c.T).body.total, 4);
  assert.strictEqual(api(c.env, 'GET', '/api/admin/coupons?status=issued', null, c.T).body.rows.length, 2);
  assert.strictEqual(api(c.env, 'GET', '/api/public/my-coupons?deviceId=devA').body.coupons.length, 1);
});

test('CSV 匯出（含 doGet 下載）', () => {
  const c = boot();
  submit(c, 'devA');
  for (const k of ['responses', 'coupons', 'summary', 'chart/nps-distribution', 'question/' + c.questions[1].id]) {
    const r = api(c.env, 'GET', '/api/admin/export/' + k, null, c.T);
    assert.strictEqual(r.status, 200, k + ' ' + JSON.stringify(r.body));
    assert.ok(r.body.__csv.startsWith('﻿'));
  }
  const out = c.env.doGet({ parameter: { path: '/api/admin/export/coupons', token: c.T, status: 'issued' } });
  assert.ok(out.file.endsWith('.csv'));
  assert.ok(out.text.includes('NA-'));
  assert.strictEqual(JSON.parse(c.env.doGet({ parameter: { path: '/api/admin/export/coupons' } }).text).status, 401);
});

test('問卷 CRUD、複製（條件題 id 轉換）、題目刪除', () => {
  const c = boot();
  const cr = api(c.env, 'POST', '/api/admin/surveys', { title: '鐵道問卷', is_active: true, generate_coupon: true, coupon_code_prefix: 'rb-1' }, c.T);
  const sid = cr.body.id;
  assert.strictEqual(c.env.Store.get('surveys', sid).coupon_code_prefix, 'RB1');
  const q1 = api(c.env, 'POST', '/api/admin/surveys/' + sid + '/questions', { question_text: 'A?', question_type: 'single', options: '["是","否"]', is_required: true }, c.T).body.question;
  api(c.env, 'POST', '/api/admin/surveys/' + sid + '/questions', { question_text: 'B?', question_type: 'text', display_condition: { depends_on: q1.id, show_when: ['是'] } }, c.T);
  const dup = api(c.env, 'POST', '/api/admin/surveys/' + sid + '/duplicate', {}, c.T).body.id;
  const dq = api(c.env, 'GET', '/api/admin/surveys/' + dup, null, c.T).body.questions;
  assert.strictEqual(dq[1].display_condition.depends_on, dq[0].id);
  api(c.env, 'DELETE', '/api/admin/questions/' + dq[1].id, null, c.T);
  assert.strictEqual(api(c.env, 'GET', '/api/admin/surveys/' + dup, null, c.T).body.questions.length, 1);
  // 無贈品設定的問卷：不限量發券（與舊版相同）
  const r = api(c.env, 'POST', '/api/public/survey', { surveyId: sid, answers: [{ questionId: q1.id, value: '否' }], deviceId: 'x', clientSubmitId: 'z' });
  assert.ok(r.body.coupon && r.body.coupon.coupon_code.startsWith('RB1-'));
});

test('公式注入防護：= 開頭的文字不被當公式', () => {
  const c = boot();
  const ta = c.questions.find(q => q.question_type === 'textarea');
  submit(c, 'devA', { answers: fullAnswers(c.questions, { [ta.id]: '=HYPERLINK("x")' }) });
  const sh = c.env.__sheets.survey_answers.data;
  assert.ok(sh.some(r => r.includes('\'=HYPERLINK("x")')));
  c.env.Store.reset();
  assert.ok(c.env.Store.all('survey_answers').some(a => a.answer_text === '=HYPERLINK("x")'));
});

test('自動更新：GitHub 版本相同時不動作', () => {
  const env = createEnv({ UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => env.CODE_VERSION }) } });
  const r = env.selfUpdate(true);
  assert.strictEqual(r.updated, false);
});

console.log(`\n結果：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
