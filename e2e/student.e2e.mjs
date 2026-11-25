// v6.2 學生系統（真瀏覽器）：教師端連線學生系統、發帳號、發布；學生登入、改密碼、看資料、照顧動物。
// 後端是真正的 server/src/app.mjs（記憶體資料庫），Google 公開金鑰換成本次測試的金鑰；全部合成資料。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teardown, openApp, createClass, shot, overflow, axe, OUT } from './helpers.mjs';
import { buildApp } from '../server/src/app.mjs';
import { openDb } from '../server/src/db.mjs';
import { GOOGLE_CLIENT_ID } from '../src/config.js';
import { signJwt, basePayload, TEACHER_B } from '../tests/helpers/fake-google.mjs';
import { buildClassProjection, projectionHash } from '../src/core/student-projection.js';
import { buildFixture, classData } from '../tests/helpers/v62-fixture.mjs';
import { ROOT } from './helpers.mjs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

let api = null;
const startApi = async (teacherOrigin) => {
    if (api) return api;
    const { keys } = await setup();
    const config = { clientId: GOOGLE_CLIENT_ID, teacherOrigins: [teacherOrigin], teacherAllow: ['@example.test'], studentOrigins: [], ipSalt: 'e2e-salt-0123456789', cookieSecure: true, staticRoot: ROOT };
    const db = openDb(':memory:');
    const app = buildApp({ db, config, jwks: async () => keys.jwks });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${app.server.address().port}`;
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
    const call = async (method, path, body, token) => {
        const r = await fetch(A.url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json() };
    };
    const { json: { token } } = await call('POST', '/api/teacher/session', { credential, nonce });
    const fx = mutate(buildFixture());
    const { json: { classKey } } = await call('POST', '/api/teacher/classes', { localClassId: `cls-a-${Date.now()}`, name: '合成甲班' }, token);
    const projection = buildClassProjection(classData(fx, 'cls-a'), { today: new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Taipei' }).format(new Date()) });
    const created = (await call('POST', `/api/teacher/classes/${classKey}/accounts`, { students: projection.students.map(s => ({ localStudentId: s.studentId })) }, token)).json.created;
    const pub = await call('PUT', `/api/teacher/classes/${classKey}/projection`, { version: Date.now(), hash: await projectionHash(projection), projection }, token);
    assert.equal(pub.status, 200);
    return { accounts: new Map(created.map(a => [a.localStudentId, a])), classKey, token };
};

/** 學生端：獨立的瀏覽器 context（不同的人、不同的裝置） */
const openStudent = async (A, { viewport = { width: 390, height: 844 }, bypassCSP = false } = {}) => {
    const { browser } = await setup();
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', bypassCSP, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(`${A.url}/student.html`);
    return { page, context, errors };
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
    await changePassword(S.page, password1, 'Moon-Garden-77');
    await S.page.waitForSelector('.stu-stats');
    assert.equal(await S.page.textContent('h2'), '1號，你好！');
    assert.deepEqual(await S.page.$$eval('.stu-stat-num', n => n.map(x => x.textContent)), ['0', '0']);
    // 瀏覽器裡沒有任何資料：只有 HttpOnly Cookie（JS 讀不到）
    const storage = await S.page.evaluate(async () => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie, idb: (await indexedDB.databases?.())?.length || 0 }));
    assert.deepEqual(storage, { ls: 0, ss: 0, ck: '', idb: 0 });
    const cookies = await S.context.cookies();
    assert.equal(cookies.length, 1); assert.equal(cookies[0].name, '__Host-fhes_sid');
    assert.ok(cookies[0].httpOnly && cookies[0].secure && cookies[0].sameSite === 'Strict');
    await shot(S.page, 'v62-student-growth-mobile');
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
    await S.page.click('.stu-tab[data-tab="homework"]');
    await S.page.waitForSelector('.stu-hw');
    assert.ok(await S.page.isVisible('text=繳交：已交'));
    assert.ok(await S.page.isVisible('text=訂正：待訂正'), 'submitted and correction shown separately');
    await S.page.click('.stu-chip:text("待訂正")');
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
    await shot(S.page, 'v62-student-zoo-mobile');
    const cspViolations = S.errors.filter(e => /Content Security Policy|Refused to/.test(e));
    assert.deepEqual(cspViolations, [], 'the page works under the strict CSP');
    // 第一次開頁面時 /api/student/me 回 401（還沒登入）是預期的；瀏覽器會把它印成 console 錯誤。其他錯誤一律不允許。
    assert.deepEqual(S.errors.filter(e => !/status of 401/.test(e)), []);
    // 伺服器確實只記了 3 次
    assert.equal(A.db.prepare('SELECT COUNT(*) n FROM group_care_events WHERE slot IS NOT NULL').get().n, 3);
    await S.context.close();
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
    await shot(S.page, 'v62-student-zoo-desktop');
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
