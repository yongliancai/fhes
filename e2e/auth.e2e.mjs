// Google 登入（方案 A）＋帳號資料隔離。真實 UI、真實驗證程式；Google 端由測試用假 GIS（真的 RS256 簽章）、JWKS、userinfo 與 Sheets 模擬器回應。
// 這不是真實 Google 帳號測試（docs/VERIFICATION.md：真實 OAuth = BLOCKED）。帳號一律為 example.test 合成帳號。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openApp, teardown, signIn, createClass, cardOf, waitVal, shot, overflow, axe, TEACHER_A, TEACHER_B } from './helpers.mjs';
import { VIEWPORTS } from './viewports.mjs';
import { createSheetsEmulator } from '../tests/helpers/sheets-emulator.mjs';
import { subOfAccessToken } from '../tests/helpers/fake-google.mjs';

after(teardown);
const newEmu = () => createSheetsEmulator({ validTokens: [], tokenOwner: subOfAccessToken });

/** 這個 origin 的所有 IndexedDB 名稱 */
const dbNames = (page) => page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).sort());
/** 鎖定狀態：登入畫面可見、主程式畫面不可見、頁面上沒有任何班級／學生卡片 */
const assertLocked = async (page, why) => {
    await page.waitForSelector('#auth-gate', { state: 'visible' });
    const st = await page.evaluate(() => ({
        locked: document.body.classList.contains('locked'),
        visibleScreens: [...document.querySelectorAll('.app-screen')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.id),
        classCards: document.querySelectorAll('.class-card[data-id]').length,
        studentCards: document.querySelectorAll('.student-card').length,
        account: document.getElementById('account-slot')?.textContent || '',
    }));
    assert.deepEqual(st, { locked: true, visibleScreens: [], classCards: 0, studentCards: 0, account: '' }, why);
};
const openAccount = async (page) => { await page.click('#account-btn'); await page.waitForSelector('#account-modal.visible'); };
const statusText = (page) => page.textContent('#auth-status');
/** 登入畫面是靜態 HTML，會比模組腳本早出現；提示文字要等腳本寫入 */
const waitStatus = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('auth-status')?.textContent || ''), re.source, { timeout: 10000 });

test('not signed in: login screen only, no account database is opened, nothing is rendered; keyboard reaches the sign-in button', async () => {
    const app = await openApp({ signIn: false });
    const { page } = app;
    try {
        await assertLocked(page, 'fresh visit is locked');
        assert.deepEqual((await dbNames(page)).filter(n => n.startsWith('fhes-acct-')), [], 'no account DB before sign-in');
        assert.match(await page.textContent('#auth-gate'), /班級經營動力站/);
        // 鍵盤：Tab 可以到登入按鈕，Enter 可登入
        await page.waitForSelector('#fake-gsi-btn');
        let focused = '';
        for (let i = 0; i < 8 && focused !== 'fake-gsi-btn'; i++) { await page.keyboard.press('Tab'); focused = await page.evaluate(() => document.activeElement?.id || ''); }
        assert.equal(focused, 'fake-gsi-btn', 'sign-in button is keyboard reachable');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#add-class-card');
        assert.match(await page.textContent('#account-slot'), /teacher\.a@example\.test/);
        assert.equal((await dbNames(page)).filter(n => n.startsWith('fhes-acct-')).length, 1);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('cancelled sign-in and every kind of invalid ID token keep the app locked', async () => {
    const app = await openApp({ signIn: false });
    const { page } = app;
    try {
        await signIn(page, TEACHER_A, 'cancel');
        await page.waitForTimeout(300);
        await assertLocked(page, 'cancel does not unlock');
        const cases = { badsig: /簽章/, expired: /過期/, wrongaud: /不是發給本系統/, wrongiss: /不是 Google 發出/, nonce: /重複使用/, algnone: /不接受的憑證格式/, nosub: /帳號識別碼/ };
        for (const [mode, re] of Object.entries(cases)) {
            await signIn(page, TEACHER_A, mode);
            await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('auth-status')?.textContent || ''), re.source, { timeout: 5000 });
            await assertLocked(page, `${mode} token must not unlock`);
            assert.deepEqual((await dbNames(page)).filter(n => n.startsWith('fhes-acct-')), [], `${mode}: no account DB opened`);
        }
        await shot(page, 'auth-invalid-token');
        // 之後用正確的登入仍可進入
        await signIn(page, TEACHER_A, 'ok');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('account isolation: A signs out, B cannot see A data; switching clears the previous teacher from the screen; reload never bypasses login', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '甲老師的班', 3);
        await page.click('#back-to-dashboard-btn');
        const dbA = (await dbNames(page)).filter(n => n.startsWith('fhes-acct-'));
        // 重新整理不能繞過登入
        await page.reload();
        await assertLocked(page, 'reload locks');
        await page.goto(app.url + '#class-view');
        await assertLocked(page, 'deep link locks');
        await signIn(page, TEACHER_A);
        assert.equal(await page.locator('.class-card:has(h3:text-is("甲老師的班"))').count(), 1);
        // 切換帳號 → B
        await openAccount(page);
        await page.click('#acct-switch');
        await assertLocked(page, 'switch locks first');
        await waitStatus(page, /選擇要使用的 Google 帳號/);
        await signIn(page, TEACHER_B);
        assert.match(await page.textContent('#account-slot'), /teacher\.b@example\.test/);
        const body = await page.textContent('body');
        assert.ok(!body.includes('甲老師的班'), 'B never sees A class name anywhere on the page');
        assert.ok(!body.includes('teacher.a@example.test'), 'no trace of A account on the page');
        assert.equal(await page.locator('.class-card[data-id]').count(), 0);
        const dbs = (await dbNames(page)).filter(n => n.startsWith('fhes-acct-'));
        assert.equal(dbs.length, 2, 'each account has its own database');
        assert.notEqual(dbs.find(n => !dbA.includes(n)), undefined);
        assert.ok(dbs.every(n => !n.includes(TEACHER_A.sub) && !n.includes('example.test')), 'database names do not contain sub or email');
        await createClass(page, '乙老師的班', 2);
        await page.click('#back-to-dashboard-btn');
        // 登出 B → A 再登入：只看到 A 自己的
        await openAccount(page);
        await page.click('#acct-signout');
        await assertLocked(page, 'sign-out locks');
        await waitStatus(page, /已登出/);
        await signIn(page, TEACHER_A);
        assert.equal(await page.locator('.class-card:has(h3:text-is("甲老師的班"))').count(), 1);
        assert.equal(await page.locator('.class-card:has(h3:text-is("乙老師的班"))').count(), 0);
        await shot(page, 'auth-account-a-dashboard');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('A offline queue is never pushed to B spreadsheet; it syncs to A sheet when A signs in again', async () => {
    const emu = newEmu();
    const app = await openApp({ emu });
    const { page, context } = app;
    const openSync = async () => { await page.click('#db-status-badge'); await page.waitForSelector('#sync-modal.visible'); };
    const waitBadge = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('db-status-text')?.textContent || ''), re.source, { timeout: 15000 });
    try {
        await createClass(page, '佇列測試班', 3);
        await page.click('#back-to-dashboard-btn');
        await openSync(); await page.click('#sync-connect');
        await page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await page.click('#sync-create'); await page.waitForSelector('#sync-sheet-link');
        await page.keyboard.press('Escape');
        await waitBadge(/已同步/);
        const [sheetA] = [...emu.books.keys()];
        const eventsBefore = emu.rows(sheetA, 'ScoreEvents').length;
        // A 離線加分 → 待同步
        await context.setOffline(true);
        await page.click('.class-card:has(h3:text-is("佇列測試班"))');
        await cardOf(page, 1).locator('[data-act="score"]').click();
        await waitVal(page, 1, 'score', 1);
        await waitBadge(/離線中|待同步/);
        await page.click('#back-to-dashboard-btn');
        await openAccount(page);
        assert.match(await page.textContent('#account-modal'), /1 筆資料尚未同步/);
        // 登出（仍離線）→ 恢復網路 → B 登入並建立自己的試算表、同步
        await page.click('#acct-signout');
        await page.waitForSelector('#auth-gate', { state: 'visible' });
        await waitStatus(page, /目前離線/);
        await assertLocked(page, 'offline sign-out locks in place');
        assert.ok(!(await page.textContent('body')).includes('佇列測試班'), 'class name gone from the page after offline sign-out');
        // 恢復網路：瀏覽器的 online 事件會自動重新載入到乾淨的登入畫面（保險起見也手動送一次，頁面可能已在重新載入）
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => {});
        await signIn(page, TEACHER_B);
        const reqsBeforeB = emu.requests.length;
        await openSync(); await page.click('#sync-connect');
        await page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await page.click('#sync-create'); await page.waitForSelector('#sync-sheet-link');
        await page.keyboard.press('Escape');
        await waitBadge(/已同步/);
        const sheetB = [...emu.books.keys()].find(id => id !== sheetA);
        assert.equal(emu.rows(sheetB, 'ScoreEvents').length, 0, 'B sheet has none of A events');
        assert.equal(emu.rows(sheetB, 'Classes').length, 0, 'B sheet has none of A classes');
        assert.ok(emu.requests.slice(reqsBeforeB).every(r => r.owner === TEACHER_B.sub), 'every request after B signed in used B credentials');
        assert.ok(emu.requests.slice(reqsBeforeB).every(r => !r.url.includes(sheetA)), 'B session never touched A sheet');
        assert.equal(emu.rows(sheetA, 'ScoreEvents').length, eventsBefore, 'A sheet unchanged while B was signed in');
        // A 回來：重新授權後，離線時的那一筆上傳到 A 的試算表
        await openAccount(page); await page.click('#acct-signout');
        await signIn(page, TEACHER_A);
        await openSync(); await page.click('#sync-connect');
        await page.keyboard.press('Escape');
        await waitBadge(/已同步/);
        assert.equal(emu.rows(sheetA, 'ScoreEvents').length, eventsBefore + 1, 'A queued change reached A sheet');
        assert.deepEqual(app.errors.filter(e => !/ERR_INTERNET_DISCONNECTED/.test(e)), []);
    } finally { await app.close(); }
});

test('shared browser: signing out in one tab locks the other tab of the same account', async () => {
    const app = await openApp();
    const { page, context } = app;
    try {
        await createClass(page, '共用電腦班', 2);
        const page2 = await context.newPage();
        await page2.goto(app.url);
        await signIn(page2, TEACHER_A);
        await page2.waitForSelector('.class-card:has(h3:text-is("共用電腦班"))');
        await page.click('#back-to-dashboard-btn');
        await openAccount(page);
        await page.click('#acct-signout');
        await assertLocked(page, 'tab 1 locked');
        await assertLocked(page2, 'tab 2 locked too');
        await waitStatus(page2, /另一個分頁登出/);
    } finally { await app.close(); }
});

test('offline reopen: login screen explains that network is needed and nothing is unlocked; online again → sign-in works', async () => {
    const app = await openApp();
    const { page, context } = app;
    try {
        await createClass(page, '離線重開班', 2);
        // 模擬離線重開：瀏覽器回報離線，且 Google 無法連線（App 檔案來自快取／本機）
        await context.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => !localStorage.getItem('__simOffline') }); });
        const blockGis = (r) => r.abort('internetdisconnected');
        await context.route('https://accounts.google.com/gsi/client', blockGis);
        await page.evaluate(() => localStorage.setItem('__simOffline', '1'));
        await page.reload();
        await page.waitForFunction(() => /沒有網路/.test(document.getElementById('auth-status')?.textContent || ''));
        await assertLocked(page, 'offline reopen stays locked');
        // 瀏覽器說已連線，但 Google 仍連不上 → 明確提示，仍鎖定
        await page.evaluate(() => { localStorage.removeItem('__simOffline'); window.dispatchEvent(new Event('online')); });
        await page.waitForFunction(() => /無法載入 Google 登入元件/.test(document.getElementById('auth-status')?.textContent || ''));
        await assertLocked(page, 'Google unreachable stays locked');
        // 真的恢復連線 → 可以登入，資料還在
        await context.unroute('https://accounts.google.com/gsi/client', blockGis);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await signIn(page, TEACHER_A);
        assert.equal(await page.locator('.class-card:has(h3:text-is("離線重開班"))').count(), 1, 'data kept on this device');
    } finally { await app.close(); }
});

test('session expires after 12 hours: app locks itself and asks to sign in again', async () => {
    const app = await openApp({ signIn: false });
    const { page } = app;
    try {
        await page.clock.install();
        await page.reload();
        await signIn(page, TEACHER_A);
        await createClass(page, '時效測試班', 2);
        // 註：playwright 的 clock.fastForward 在這裡偶爾完全沒有前進（測試工具行為，見 BUG-LOG harness notes），
        // 改用 setSystemTime 設定時間，再 runFor 31 秒讓看門狗的 30 秒計時器確實觸發
        const t0 = await page.evaluate(() => Date.now());
        await page.clock.setSystemTime(t0 + 11 * 3600_000 + 58 * 60_000);
        await page.clock.runFor(31_000);
        assert.equal(await page.evaluate(() => document.body.classList.contains('locked')), false, 'still signed in before 12h');
        await page.clock.setSystemTime(t0 + 12 * 3600_000 + 60_000);
        await page.clock.runFor(31_000);
        await page.waitForSelector('#auth-gate', { state: 'visible', timeout: 10000 });
        await assertLocked(page, 'expired session locked');
        await waitStatus(page, /超過 12 小時/);
    } finally { await app.close(); }
});

test('no credential ever lands in localStorage, sessionStorage, IndexedDB, cookies, the URL, the console or a backup file', async () => {
    const emu = newEmu();
    const app = await openApp({ emu });
    const { page } = app;
    try {
        await createClass(page, '外洩檢查班', 2);
        await page.click('#back-to-dashboard-btn');
        await page.click('#db-status-badge'); await page.click('#sync-connect');
        await page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await page.click('#sync-create'); await page.waitForSelector('#sync-sheet-link');
        await page.keyboard.press('Escape');
        const secrets = await page.evaluate(() => ({ idToken: window.__fakeGoogle.lastCredential, accessToken: window.__fakeGoogle.lastAccessToken }));
        assert.ok(secrets.idToken?.startsWith('eyJ') && secrets.accessToken, 'test obtained both tokens');
        const dl = page.waitForEvent('download');
        await page.click('#export-data-btn');
        const backupText = readFileSync(await (await dl).path(), 'utf8');
        const stored = await page.evaluate(async () => {
            const dump = { local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, url: location.href, idb: {} };
            for (const { name } of await indexedDB.databases()) {
                const db = await new Promise(ok => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); });
                for (const s of db.objectStoreNames) dump.idb[`${name}/${s}`] = await new Promise(ok => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => ok(r.result); });
                db.close();
            }
            return JSON.stringify(dump);
        });
        const haystacks = { storage: stored, console: app.consoleAll.join('\n'), backup: backupText, sheet: JSON.stringify([...emu.books.values()].map(b => [...b.sheets.values()])) };
        for (const [where, text] of Object.entries(haystacks)) {
            assert.ok(!text.includes(secrets.idToken), `ID token found in ${where}`);
            assert.ok(!text.includes(secrets.idToken.split('.')[1]), `ID token payload found in ${where}`);
            assert.ok(!text.includes(secrets.accessToken), `access token found in ${where}`);
            assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.eyJ/.test(text), `JWT-looking string found in ${where}`);
        }
        // 帳號識別：資料庫名稱、localStorage 都沒有 sub 或 email
        assert.ok(!stored.includes(TEACHER_A.sub), 'sub not stored');
        // 登出：先停止同步並向 Google 撤銷試算表授權，再清空畫面
        assert.deepEqual(app.revoked, []);
        await openAccount(page);
        await page.click('#acct-signout');
        await waitStatus(page, /已登出/);
        assert.deepEqual(app.revoked, [secrets.accessToken], 'Sheets access token revoked at Google on sign-out');
    } finally { await app.close(); }
});

test('shared computer: "sign out and remove this account data" downloads a backup, deletes only this account database', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '要移除的班', 2);
        await page.click('#back-to-dashboard-btn');
        await openAccount(page); await page.click('#acct-signout');
        await signIn(page, TEACHER_B); await createClass(page, '乙保留的班', 2); await page.click('#back-to-dashboard-btn');
        await openAccount(page); await page.click('#acct-signout');
        await signIn(page, TEACHER_A);
        const before = (await dbNames(page)).filter(n => n.startsWith('fhes-acct-'));
        await openAccount(page);
        await page.click('#account-modal details summary');
        const dl = page.waitForEvent('download');
        await page.click('#acct-wipe');
        assert.match((await dl).suggestedFilename(), /移除本機資料前備份/);
        await assertLocked(page, 'locked after wipe');
        const after = (await dbNames(page)).filter(n => n.startsWith('fhes-acct-'));
        assert.equal(after.length, before.length - 1, 'exactly one account database removed');
        await signIn(page, TEACHER_B);
        assert.equal(await page.locator('.class-card:has(h3:text-is("乙保留的班"))').count(), 1, 'other account untouched');
        await openAccount(page); await page.click('#acct-signout');
        await signIn(page, TEACHER_A);
        assert.equal(await page.locator('.class-card[data-id]').count(), 0, 'A data removed from this device');
    } finally { await app.close(); }
});

test('missing / invalid OAuth Client ID: setup field, format check, then sign-in works', async () => {
    const app = await openApp({ signIn: false, clientId: null });
    const { page } = app;
    try {
        await page.waitForFunction(() => /尚未設定 Google 登入/.test(document.getElementById('auth-status')?.textContent || ''));
        assert.equal(await page.locator('#fake-gsi-btn').count(), 0);
        await page.fill('#auth-client-id', 'GOCSPX-not-a-client-id');
        await page.click('#auth-client-save');
        assert.match(await statusText(page), /格式不正確/);
        await page.fill('#auth-client-id', '1234567890-testclientabc.apps.googleusercontent.com');
        await page.click('#auth-client-save');
        await signIn(page, TEACHER_A);
    } finally { await app.close(); }
});

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    test(`login screen and account dialog: no overflow and no serious a11y violations on ${vpName}`, async () => {
        const app = await openApp({ signIn: false, viewport: vp });
        const { page } = app;
        try {
            await page.waitForSelector('#fake-gsi-btn');
            assert.deepEqual(await overflow(page), [], 'login screen overflow');
            assert.deepEqual(await axe(page, '#auth-gate'), [], 'login screen a11y');
            await shot(page, `auth-login-${vpName}`);
            await signIn(page, TEACHER_A);
            await openAccount(page);
            assert.deepEqual(await overflow(page), [], 'account dialog overflow');
            assert.deepEqual(await axe(page, '#account-modal'), [], 'account dialog a11y');
            await shot(page, `auth-account-${vpName}`);
            assert.deepEqual(app.errors, []);
        } finally { await app.close(); }
    });
}
