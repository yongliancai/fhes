// v6.2 學生系統（真瀏覽器）：教師端連線學生系統、發帳號、發布；學生登入、改密碼、看資料、照顧動物。
// 後端是真正的 server/src/app.mjs（記憶體資料庫），Google 公開金鑰換成本次測試的金鑰；全部合成資料。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, openApp, createClass, shot, overflow, axe, OUT, ENGINE, testTls } from './helpers.mjs';
import { buildApp } from '../server/src/app.mjs';
import { openDb } from '../server/src/db.mjs';
import { GOOGLE_CLIENT_ID } from '../src/config.js';
import { signJwt, basePayload, TEACHER_B, TEACHER_A, ADMIN } from '../tests/helpers/fake-google.mjs';
import { buildClassProjection, projectionHash } from '../src/core/student-projection.js';
import { buildFixture, classData } from '../tests/helpers/v62-fixture.mjs';
import { ROOT } from './helpers.mjs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

let api = null;
const startApi = async (teacherOrigin) => {
    if (api) return api;
    const { keys } = await setup();
    const config = { clientId: GOOGLE_CLIENT_ID, teacherOrigins: [teacherOrigin], teacherAllow: ['@example.test'], studentOrigins: [], ipSalt: 'e2e-salt-0123456789', cookieSecure: true, staticRoot: ROOT, adminEmails: [ADMIN.email] };
    const db = openDb(':memory:');
    // HTTPS（自簽）：和正式環境一樣用 __Host- + Secure Cookie；WebKit 在 http 不保存 Secure Cookie
    const app = buildApp({ db, config, jwks: async () => keys.jwks, https: testTls() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `https://127.0.0.1:${app.server.address().port}`;
    config.studentOrigins.push(url);
    api = { app, db, url, keys };
    return api;
};
after(async () => { await api?.app.close(); await teardown(); });

/** 用測試金鑰簽一張「老師乙」的 Google ID token，直接呼叫 API 發布含有惡意字串的合成班級（測 XSS 與園區） */
const seedViaApi = async (A, mutate = (fx) => fx) => {
    const priv = await webcrypto.subtle.importKey('jwk', A.keys.goodPrivateJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const nonce = `e2e-nonce-${Date.now()}`;
    const credential = await signJwt(priv, basePayload({ account: TEACHER_B, clientId: GOOGLE_CLIENT_ID, nonce }));
    // Node 端直接呼叫測試 API：只信任這次產生的自簽憑證（不關閉憑證檢查）
    const call = (method, path, body, token) => new Promise((ok, bad) => {
        const req = httpsRequest(A.url + path, { method, ca: testTls().cert, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
            let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(data || '{}') }));
        });
        req.on('error', bad); if (body) req.write(JSON.stringify(body)); req.end();
    });
    const { json: { token } } = await call('POST', '/api/teacher/session', { credential, nonce });
    const fx = mutate(buildFixture());
    const { json: { classKey } } = await call('POST', '/api/teacher/classes', { localClassId: `cls-a-${Date.now()}`, name: '合成甲班' }, token);
    const projection = buildClassProjection(classData(fx, 'cls-a'), { today: new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Taipei' }).format(new Date()) });
    const created = (await call('POST', `/api/teacher/classes/${classKey}/accounts`, { students: projection.students.map(s => ({ localStudentId: s.studentId })) }, token)).json.created;
    const pub = await call('PUT', `/api/teacher/classes/${classKey}/projection`, { version: Date.now(), hash: await projectionHash(projection), projection }, token);
    assert.equal(pub.status, 200);
    return { accounts: new Map(created.map(a => [a.localStudentId, a])), classKey, token, call };
};

/** 學生端：獨立的瀏覽器 context（不同的人、不同的裝置） */
const openStudent = async (A, { viewport = { width: 390, height: 844 }, bypassCSP = false } = {}) => {
    const { browser } = await setup();
    // Firefox 沒有手機模擬（isMobile 會直接丟錯）：一樣用手機尺寸的視窗檢查版面，只是不開 isMobile
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', bypassCSP, hasTouch: mobile, ...(ENGINE === 'firefox' ? {} : { isMobile: mobile }) });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    // WebKit：Playwright 截圖時會注入一段 <style>，被頁面的嚴格 CSP 擋下並印出「Refused to apply a stylesheet」。
    // 那不是 App 的行為：只在截圖進行中、只在 WebKit、只略過這一句；其他任何錯誤（包括截圖以外的 CSP 違規）照樣算失敗。
    let shooting = false;
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        if (shooting && ENGINE === 'webkit' && /^Refused to apply a stylesheet/.test(m.text())) return;
        errors.push(`console: ${m.text()}`);
    });
    const snap = async (name) => { shooting = true; try { await shot(page, name); await page.waitForTimeout(100); } finally { shooting = false; } };
    await page.goto(`${A.url}/student.html`);
    return { page, context, errors, snap };
};
const studentLogin = async (page, username, password) => {
    await page.fill('#stu-user', username); await page.fill('#stu-pass', password);
    await page.click('.stu-login button[type="submit"]');
};
const changePassword = async (page, current, next) => {
    await page.waitForSelector('#stu-new');
    await page.fill('#stu-cur', current); await page.fill('#stu-new', next); await page.fill('#stu-new2', next);
    await page.click('.stu-login button[type="submit"]');
};

test('teacher: connect, issue accounts (shown once), publish; student: first login, password change, sees only own data', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const t = await openApp({ studentApi: A.url });
    const { page } = t;
    await createClass(page, '合成學生系統班', 3);
    await page.waitForSelector('#student-system-btn:not([hidden])');
    await page.click('#student-system-btn');
    await page.waitForSelector('#student-status[data-status="ok"]', { timeout: 10000 });
    await page.click('#stu-create-all');
    await page.waitForSelector('.stu-new');
    const slips = await page.$$eval('.stu-new tbody tr', rows => rows.map(r => [...r.children].map(td => td.textContent)));
    assert.equal(slips.length, 3);
    const [seat1, , username1, password1] = slips[0];
    assert.equal(seat1, '1'); assert.match(username1, /^[a-z]{3}\d{4}$/); assert.match(password1, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    await shot(page, 'v62-teacher-accounts');
    await page.click('#stu-publish');
    await page.waitForFunction(() => /上次發布：\d/.test(document.querySelector('#stu-published-at')?.textContent || ''));
    // 關閉後初始密碼從畫面與 DOM 消失
    await page.click('#student-modal .modal-actions .btn');
    assert.equal(await page.locator('text=' + password1).count(), 0, 'initial password is gone after closing');
    assert.equal(t.errors.length, 0, t.errors.join('\n'));
    // 教師端沒有把學生系統的 token 寫進任何儲存空間
    const stored = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage }, ck: document.cookie }));
    assert.ok(!/token|Bearer/i.test(stored.replace(/fhes_google_client_id/g, '')), stored);

    const S = await openStudent(A);
    await studentLogin(S.page, username1, password1);
    const pwResponse = S.page.waitForResponse(r => r.url().endsWith('/api/student/password'));
    await changePassword(S.page, password1, 'Moon-Garden-77');
    const setCookie = (await (await pwResponse).allHeaders())['set-cookie'] || '';
    await S.page.waitForSelector('.stu-stats');
    assert.equal(await S.page.textContent('h2'), '1號，你好！');
    assert.deepEqual(await S.page.$$eval('.stu-stat-num', n => n.map(x => x.textContent)), ['0', '0']);
    // 瀏覽器裡沒有任何資料：只有 HttpOnly Cookie（JS 讀不到）
    const storage = await S.page.evaluate(async () => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie, idb: (await indexedDB.databases?.())?.length || 0 }));
    assert.deepEqual(storage, { ls: 0, ss: 0, ck: '', idb: 0 });
    const cookies = await S.context.cookies();
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, '__Host-fhes_sid');
    assert.ok(cookies[0].httpOnly && cookies[0].secure, JSON.stringify({ ...cookies[0], value: '(hidden)' }));
    // 伺服器送出的 Cookie 一定是 SameSite=Strict（三個瀏覽器都檢查回應標頭）
    assert.match(setCookie, /^__Host-fhes_sid=[^;]+;.*SameSite=Strict/i, 'Set-Cookie has SameSite=Strict');
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i); assert.match(setCookie, /Path=\//i); assert.doesNotMatch(setCookie, /Domain=/i);
    // Cookie 儲存區回報的 SameSite：Playwright WebKit（2026-11-27 在 Windows 確認）把收到的 Strict 回報成 "None"；上面已用回應標頭驗證，其他瀏覽器另外再查儲存區
    if (ENGINE !== 'webkit') assert.equal(cookies[0].sameSite, 'Strict');
    await S.snap('v62-student-growth-mobile');
    // 老師停用 → 學生下一次操作就回到登入畫面
    await page.click('#student-system-btn');
    const row = page.locator('.stu-table tbody tr').first();
    await row.locator('button:text("停用")').click();
    await page.waitForSelector('.stu-table tbody tr >> text=已停用');
    await S.page.click('.stu-tab[data-tab="homework"]');
    await S.page.waitForSelector('#stu-user');
    assert.ok(await S.page.isVisible('text=登入已經過期'));
    assert.deepEqual(S.errors.filter(e => !/401|Failed to load resource/.test(e)), []);
    await S.context.close(); await t.close();
});

test('student zoo: care is decided by the server (3 per day), names with HTML stay text, CSP holds, mobile layout fits', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const evil = '<img src=x onerror="window.__pwned=1">小明';
    const seeded = await seedViaApi(A, (fx) => { fx.students[0].name = evil; fx.hwAssignments[0].title = '<script>window.__pwned=2</script>作業'; return fx; });
    const acc = seeded.accounts.get('cls-a-s1');
    const S = await openStudent(A);
    await studentLogin(S.page, acc.username, acc.initialPassword);
    await changePassword(S.page, acc.initialPassword, 'Star-River-2026');
    await S.page.waitForSelector('.stu-stats');
    assert.equal(await S.page.textContent('h2'), `${evil}，你好！`, 'name rendered as text');
    assert.deepEqual(await S.page.$$eval('.stu-stat-num', n => n.map(x => x.textContent)), ['3', '5']);
    // BUG-031：很長、沒有空白的姓名不能把手機頁面撐寬（CI 的 Linux 字型在 390px 就超出；這裡用 320px 在每個平台都抓得到）
    assert.deepEqual(await overflow(S.page), [], 'growth page fits at 390px');
    await S.page.setViewportSize({ width: 320, height: 700 });
    assert.deepEqual(await overflow(S.page), [], 'growth page fits at 320px');
    await S.page.click('.stu-tab[data-tab="homework"]');
    await S.page.waitForSelector('.stu-hw');
    assert.deepEqual(await overflow(S.page), [], 'homework page fits at 320px');
    await S.page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await S.page.isVisible('.stu-badge[data-state="submitted"]:text("繳交")'));
    assert.ok(await S.page.isVisible('.stu-badge[data-state="needs"]:text("未訂正")'), 'v6.2 four simple states');
    await S.page.click('.stu-chip:text("未訂正")');
    assert.equal(await S.page.locator('.stu-hw').count(), 1);
    await S.page.click('.stu-tab[data-tab="zoo"]');
    await S.page.waitForSelector('.stu-scene svg .scene-actor');
    assert.equal(await S.page.locator('.scene-actor').count(), 2, 'only group 1 animals (revoked one hidden)');
    await S.page.focus('.scene-actor >> nth=0'); await S.page.keyboard.press('Enter');   // 鍵盤也能選動物（動物一直在動，滑鼠點擊等不到「靜止」）
    const results = [];
    for (let i = 0; i < 4; i++) {
        await S.page.evaluate(() => document.querySelector('.stu-care-panel .stu-note')?.remove());
        await S.page.click('.stu-care-actions button[data-action="feed"]');
        await S.page.waitForSelector('.stu-care-panel .stu-note');
        results.push(await S.page.textContent('.stu-care-panel .stu-note'));
    }
    assert.ok(results.slice(0, 3).every(t => t.includes('+1')), results.join(' | '));
    assert.ok(results[3].includes('不計入'));
    assert.ok(await S.page.isVisible('text=今天的照顧次數用完了'));
    assert.ok(await S.page.isVisible('text=小組累計照顧 3 次'));
    assert.equal(await S.page.evaluate(() => window.__pwned), undefined, 'no injected script ran');
    assert.deepEqual(await overflow(S.page), []);
    await S.snap('v62-student-zoo-mobile');
    const cspViolations = S.errors.filter(e => /Content Security Policy|Refused to/.test(e));
    assert.deepEqual(cspViolations, [], 'the page works under the strict CSP');
    // 第一次開頁面時 /api/student/me 回 401（還沒登入）是預期的；瀏覽器會把它印成 console 錯誤。其他錯誤一律不允許。
    assert.deepEqual(S.errors.filter(e => !/status of 401/.test(e)), []);
    // 伺服器確實只記了 3 次
    assert.equal(A.db.prepare('SELECT COUNT(*) n FROM group_care_events WHERE slot IS NOT NULL').get().n, 3);
    await S.context.close();
});

test('小老師: teacher marks a helper, the helper registers a classmate on a phone, the teacher app receives it as homework events', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const t = await openApp({ studentApi: A.url });
    const { page } = t;
    await createClass(page, '合成小老師班', 3);
    await page.click('.nav-tab[data-tab="homework"]');
    await page.click('#hw-view-toggle');
    await page.click('#hw-add');
    await page.selectOption('#hw-f-type', { label: '國習' });
    await page.fill('#hw-f-title', 'L7 小老師測試');
    await page.click('#hw-f-ok');
    await page.waitForSelector('.hw-card:has(.hw-title:text-is("L7 小老師測試"))');
    // 發帳號、指定 2 號為小老師、發布
    await page.click('.nav-tab[data-tab="students"]');
    await page.click('#student-system-btn');
    await page.waitForSelector('#student-status[data-status="ok"]', { timeout: 10000 });
    await page.click('#stu-create-all');
    await page.waitForSelector('.stu-new');
    const slips = await page.$$eval('.stu-new tbody tr', rows => rows.map(r => [...r.children].map(td => td.textContent)));
    const [, , helperUser, helperPass] = slips[1];
    await page.locator('.stu-accounts tbody tr').nth(1).locator('input.stu-helper').check();
    await page.waitForFunction(() => /設為小老師/.test(document.body.textContent));
    await page.click('#stu-publish');
    await page.waitForFunction(() => /上次發布：\d/.test(document.querySelector('#stu-published-at')?.textContent || ''));
    await page.click('#student-modal .modal-actions .btn');

    const S = await openStudent(A);
    await studentLogin(S.page, helperUser, helperPass);
    await changePassword(S.page, helperPass, 'Helper-Tree-58');
    await S.page.click('.stu-tab[data-tab="helper"]');
    await S.page.waitForSelector('.stu-reg-list .stu-reg');
    assert.equal(await S.page.locator('.stu-reg').count(), 3);
    assert.equal(await S.page.locator('.stu-reg').nth(1).locator('button').count(), 0, 'no buttons on the helper\'s own row');
    assert.ok(await S.page.isVisible('text=自己的作業請交給老師登記'));
    await S.page.locator('.stu-reg').nth(0).locator('button[data-state="missing"]').click();
    await S.page.waitForSelector('.stu-reg >> nth=0 >> .stu-badge:text("未繳交")');
    await S.page.locator('.stu-reg').nth(2).locator('button[data-state="needs"]').click();
    await S.page.waitForSelector('.stu-reg >> nth=2 >> .stu-badge:text("未訂正")');
    assert.deepEqual(await overflow(S.page), []);
    await S.snap('v62-helper-register-mobile');
    const text = await S.page.textContent('#stu-body');
    assert.ok(!/分數|愛心|XP/.test(text), 'the helper screen shows no scores or hearts');
    assert.equal(A.db.prepare('SELECT COUNT(*) n FROM hw_registrations').get().n, 2);

    // 教師端收取 → 變成老師的作業紀錄（記錄是小老師登記的）
    await page.click('.nav-tab[data-tab="students"]');
    await page.click('#student-system-btn');
    await page.waitForSelector('#stu-pull');
    await page.click('#stu-pull');
    await page.waitForFunction(() => /收到小老師登記 2 筆/.test(document.body.textContent));
    await page.click('#student-modal .modal-actions .btn');
    await page.click('.nav-tab[data-tab="homework"]');
    await page.click('#hw-view-toggle');
    await page.waitForSelector('.hw-matrix');
    const cells = await page.$$eval('.hw-matrix tbody .hw-cell', b => b.map(x => x.textContent));
    assert.match(cells[0], /未繳交/); assert.match(cells[1], /未登記/); assert.match(cells[2], /未訂正/);
    await page.locator('.hw-matrix tbody .hw-cell').first().click();
    await page.click('#hw-cell-modal .hw-hist summary');
    assert.match(await page.textContent('#hw-cell-modal .hw-hist'), /小老師 2號登記/);
    await page.click('#hw-cell-modal .modal-actions .btn');
    // 再收一次不會重複
    await page.click('.nav-tab[data-tab="students"]');
    await page.click('#student-system-btn');
    await page.click('#stu-pull');
    await page.waitForFunction(() => /沒有新的小老師登記/.test(document.body.textContent));
    await page.click('#student-modal .modal-actions .btn');
    // 老師取消小老師 → 學生下一次操作就沒有權限，分頁消失
    await page.click('#student-system-btn');
    await page.locator('.stu-accounts tbody tr').nth(1).locator('input.stu-helper').uncheck();
    await page.waitForFunction(() => /不再是小老師/.test(document.body.textContent));
    await S.page.locator('.stu-reg').nth(0).locator('button[data-state="submitted"]').click();
    await S.page.waitForSelector('text=老師已經取消你的小老師身分');
    assert.equal(await S.page.locator('.stu-tab[data-tab="helper"]').count(), 0);
    assert.deepEqual(S.errors.filter(e => !/status of (401|403)/.test(e)), []);
    assert.deepEqual(t.errors, []);
    await S.context.close(); await t.close();
});

/** Node 端扮演學生（帶 Cookie、CSRF、Origin）；只信任這次的自簽憑證 */
const studentClient = (A) => {
    let cookie = ''; let csrf = '';
    const call = (method, path, body) => new Promise((ok, bad) => {
        const req = httpsRequest(A.url + path, { method, ca: testTls().cert, headers: { 'content-type': 'application/json', origin: A.url, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-fhes-csrf': csrf } : {}) } }, (res) => {
            const sc = res.headers['set-cookie']?.find(c => c.startsWith('__Host-fhes_sid=')); if (sc) cookie = sc.split(';')[0];
            let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
            res.on('end', () => { const json = JSON.parse(data || '{}'); if (json.csrf) csrf = json.csrf; ok({ status: res.statusCode, json }); });
        });
        req.on('error', bad); if (body) req.write(JSON.stringify(body)); req.end();
    });
    return { call, async signInAndChange(username, password, next) { await call('POST', '/api/student/login', { username, password }); const r = await call('POST', '/api/student/password', { currentPassword: password, newPassword: next }); assert.equal(r.status, 200, JSON.stringify(r.json)); } };
};

test('P2 teacher: invitation with QR; a join request is approved by choosing the local student; D3 reset buttons; remove from class', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const t = await openApp({ studentApi: A.url });
    const { page } = t;
    await createClass(page, '合成邀請班', 3);
    await page.click('#student-system-btn');
    await page.waitForSelector('#student-status[data-status="ok"]', { timeout: 10000 });
    await page.click('#stu-create-all');
    await page.waitForSelector('.stu-new');
    const slips = await page.$$eval('.stu-new tbody tr', rows => rows.map(r => [...r.children].map(td => td.textContent)));
    // 1 號登入過（D3：老師只能送重設申請）；2 號還沒（老師可以重發）
    const s1 = studentClient(A); await s1.signInAndChange(slips[0][2], slips[0][3], 'Comet-Field-41');
    await page.click('#student-modal .modal-actions .btn');
    await page.click('#student-system-btn');
    const row = (n) => page.locator('.stu-accounts tbody tr').nth(n);
    await row(0).locator('button[data-action="reset-request"]').waitFor();
    assert.equal(await row(0).locator('button[data-action="reset"]').count(), 0, 'no direct reset after the first sign-in');
    assert.equal(await row(1).locator('button[data-action="reset"]').count(), 1);
    await row(0).locator('button[data-action="reset-request"]').click();
    await page.waitForFunction(() => /已送出重設申請/.test(document.body.textContent));
    const m1 = A.db.prepare('SELECT user_id FROM password_credentials WHERE username = ?').get(slips[0][2]).user_id;
    assert.equal(A.db.prepare("SELECT COUNT(*) n FROM password_reset_requests r JOIN student_accounts m ON m.id = r.member_id WHERE m.user_id = ? AND r.status = 'pending'").get(m1).n, 1);
    // 3 號被移出本班；他的帳號還在，但看不到本班
    await row(2).locator('button[data-action="remove"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.stu-accounts tbody tr')[2]?.textContent.includes('未建立'));
    const s3 = studentClient(A); await s3.signInAndChange(slips[2][2], slips[2][3], 'River-Stone-58');
    assert.deepEqual((await s3.call('GET', '/api/student/me')).json.classes, []);
    // 邀請碼＋QR：只顯示一次
    await page.click('#stu-invite-create');
    await page.waitForSelector('#stu-invite-code');
    const code = await page.textContent('#stu-invite-code');
    assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.ok((await page.getAttribute('svg.stu-qr path', 'd')).length > 200, 'QR code is drawn');
    await shot(page, 'v62-teacher-invite');
    // 學生用邀請碼申請（名字含 HTML：老師畫面只當文字）
    const j = await s3.call('POST', '/api/student/join', { code, displayName: '<b>三號</b>', seatHint: 3 });
    assert.equal(j.status, 200); assert.equal(j.json.status, 'pending');
    assert.deepEqual((await s3.call('GET', '/api/student/me')).json.classes, [], 'a request alone gives no access');
    await page.click('#student-modal .modal-actions .btn');
    assert.equal(await page.locator('#stu-invite-code').count(), 0, 'the code is gone after closing');
    await page.click('#student-system-btn');
    const req = page.locator('.stu-requests tbody tr').first();
    await req.waitFor();
    assert.equal(await req.locator('td').first().textContent(), '<b>三號</b>');
    assert.equal(await page.locator('.stu-requests b').count(), 0, 'no HTML is rendered from the student’s text');
    const options = await req.locator('select option').allTextContents();
    assert.deepEqual(options.length, 2, `only the unbound student is offered: ${options}`);
    await req.locator('select').selectOption({ index: 1 });
    await req.locator('button:text("核准")').click();
    await page.waitForFunction(() => !document.querySelector('.stu-requests') && document.querySelectorAll('.stu-accounts tbody tr')[2]?.textContent.includes('使用中'));
    assert.equal((await s3.call('GET', '/api/student/me')).json.classes.length, 1, 'approved → the student now has this class');
    assert.deepEqual(t.errors, []);
    await t.close();
});

test('P2 admin page: only the platform owner gets in; approves a reset request (new password shown once) and suspends a teacher', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const B = await seedViaApi(A);
    const [acc] = [...B.accounts.values()];
    const st = studentClient(A); await st.signInAndChange(acc.username, acc.initialPassword, 'Harbor-Light-36');
    const rq = await B.call('POST', `/api/teacher/classes/${B.classKey}/accounts/${acc.accountId}/reset-request`, {}, B.token);
    assert.equal(rq.status, 200);
    const t = await openApp({ studentApi: A.url, signIn: false, query: 'admin.html', waitFor: '#fake-gsi-btn' });
    const { page } = t;
    // 一般老師（在名單上）不是管理員
    await page.evaluate((a) => { Object.assign(window.__fakeGoogle, { account: a, mode: 'ok' }); }, TEACHER_A);
    await page.click('#fake-gsi-btn');
    await page.waitForFunction(() => /管理權限/.test(document.querySelector('#auth-status')?.textContent || ''));
    assert.equal(await page.isVisible('#adm-app'), false);
    await page.evaluate((a) => { Object.assign(window.__fakeGoogle, { account: a, mode: 'ok' }); }, ADMIN);
    await page.click('#fake-gsi-btn');
    // 其他測試可能留下別的待處理申請：只處理這一筆
    const mine = page.locator(`#adm-pending tbody tr[data-request="${rq.json.requestId}"]`);
    await mine.waitFor();
    assert.equal(await mine.locator('td.mono').textContent(), acc.username);
    await mine.locator('button:text("核准並產生新密碼")').click();
    await page.waitForSelector('#adm-initial-password');
    const pw = await page.textContent('#adm-initial-password');
    assert.match(pw, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.equal((await st.call('GET', '/api/student/me')).status, 401, 'the student was signed out everywhere');
    const again = studentClient(A);
    assert.equal((await again.call('POST', '/api/student/login', { username: acc.username, password: pw })).json.mustChangePassword, true);
    await shot(page, 'v62-admin');
    // 停權老師乙：他的工作階段立即失效；恢復
    const tB = A.db.prepare('SELECT teacher_id FROM classes WHERE id = ?').get(B.classKey).teacher_id;
    const tr = page.locator(`#adm-teachers tr[data-teacher="${tB}"]`);
    await tr.locator('button:text("停權")').click();
    await tr.locator('text=已停權').waitFor();
    assert.equal((await B.call('GET', `/api/teacher/classes/${B.classKey}/accounts`, undefined, B.token)).status, 401);
    await tr.locator('button:text("恢復")').click();
    await tr.locator('text=使用中').waitFor();
    // 管理工作階段沒有寫進任何儲存空間
    const stored = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage }, ck: document.cookie }));
    assert.ok(!/token|Bearer/i.test(stored.replace(/fhes_google_client_id/g, '')), stored);
    assert.deepEqual(t.errors.filter(e => !/40[13]/.test(e)), []);
    await t.close();
});

test('student page accessibility (axe) on desktop and login screen', async () => {
    const { url } = await setup();
    const A = await startApi(url.replace(/\/$/, ''));
    const seeded = await seedViaApi(A);
    const acc = seeded.accounts.get('cls-a-s4');
    const S = await openStudent(A, { viewport: { width: 1280, height: 800 }, bypassCSP: true });   // axe 用內嵌腳本注入，只在這個檢查用的 context 放寬 CSP
    await S.page.waitForSelector('#stu-user');
    assert.deepEqual(await axe(S.page), [], 'login screen');
    await studentLogin(S.page, acc.username, acc.initialPassword);
    await changePassword(S.page, acc.initialPassword, 'Blue-Whale-Song-9');
    await S.page.waitForSelector('.stu-stats');
    assert.deepEqual(await axe(S.page), [], 'growth');
    await S.page.click('.stu-tab[data-tab="zoo"]');
    await S.page.waitForSelector('.stu-scene');
    assert.deepEqual(await axe(S.page), [], 'zoo');
    await S.snap('v62-student-zoo-desktop');
    await S.context.close();
    assert.ok(OUT && join);
});

test('rollback A: with STUDENT_API_BASE empty the teacher app shows no student system (v6.1 behaviour)', async () => {
    const t = await openApp();                        // repo config：STUDENT_API_BASE = ''
    await createClass(t.page, '合成回滾班', 2);
    assert.equal(await t.page.isVisible('#student-system-btn'), false);
    assert.equal(await t.page.locator('#student-modal').count(), 0);
    assert.deepEqual(t.errors, []);
    await t.close();
});
