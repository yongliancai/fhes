// P5 雲端同步（真實 UI＋真實 adapter／引擎；Google 登入元件與 Sheets API 在網路層由模擬器回應）
// 兩個瀏覽器 context = 兩台裝置（各自的 IndexedDB）。這不是真實 Google 帳號測試（見 docs/VERIFICATION：真實 OAuth = BLOCKED）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, teardown, createClass, cardOf, waitVal, shot } from './helpers.mjs';
import { strayNullTexts } from './helpers.mjs';
import { createSheetsEmulator } from '../tests/helpers/sheets-emulator.mjs';

after(teardown);
const CLIENT_ID = '1234567890-testclientabc.apps.googleusercontent.com';
const FAKE_GIS = `window.google = { accounts: { oauth2: {
  initTokenClient: (o) => ({ requestAccessToken: () => setTimeout(() => window.__denyScope ? o.callback({ error: 'access_denied' }) : o.callback({ access_token: window.__fakeToken || 'test-token', expires_in: window.__fakeExpires || 3600, scope: o.scope }), 20) }),
  hasGrantedAllScopes: () => true, revoke: (t, cb) => cb && cb() } } };`;

const wireGoogle = async (context, emu) => {
    await context.route('https://accounts.google.com/gsi/client', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GIS }));
    await context.route('https://sheets.googleapis.com/**', async (r) => {
        const req = r.request();
        let res;
        try { res = emu.handle(req.method(), req.url(), req.postData() ? JSON.parse(req.postData()) : undefined, await req.allHeaders()); }
        catch { await r.abort('failed'); return; }
        await r.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
};
const openSync = async (page) => {
    const inClass = await page.evaluate(() => document.getElementById('class-view').classList.contains('active'));
    await page.click(inClass ? '#class-sync-badge' : '#db-status-badge');
    await page.waitForSelector('#sync-modal.visible');
};
const closeSync = (page) => page.click('#sync-modal .modal-actions:last-child .btn');
const badge = (page) => page.textContent('#db-status-text');
const waitBadge = (page, re, timeout = 15000) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('db-status-text')?.textContent || ''), re.source, { timeout });

test('two devices sync through Google Sheets: setup, join, offline queue, token expiry, conflict resolution', async () => {
    const emu = createSheetsEmulator();
    const A = await openApp(); const B = await openApp();
    await wireGoogle(A.context, emu); await wireGoogle(B.context, emu);
    try {
        // ---- 裝置 A：建立資料、連線、建立試算表
        await createClass(A.page, '同步測試班', 3);
        for (let i = 0; i < 2; i++) await cardOf(A.page, 1).locator('[data-act="score"]').click();
        await waitVal(A.page, 1, 'score', 2);
        await A.page.click('#back-to-dashboard-btn');
        assert.match(await badge(A.page), /僅存本機/);
        await openSync(A.page);
        await A.page.fill('#sync-client-id', CLIENT_ID);
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await A.page.click('#sync-create');
        await A.page.waitForSelector('#sync-sheet-link');
        await shot(A.page, 'p5-sync-settings');
        await closeSync(A.page);
        await waitBadge(A.page, /已同步/);
        const [sheetId] = [...emu.books.keys()];
        assert.equal(emu.rows(sheetId, 'Students').length, 3);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 2);
        assert.ok(emu.rows(sheetId, 'Students').every(r => !/test-token/.test(JSON.stringify(r))), 'no token stored in the sheet');

        // ---- 裝置 B：全新瀏覽器，貼上同一份試算表
        await openSync(B.page);
        await B.page.fill('#sync-client-id', CLIENT_ID);
        await B.page.click('#sync-connect');
        await B.page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await B.page.fill('#sync-sheet-id', `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`);
        await B.page.click('#sync-use');
        await closeSync(B.page);
        await B.page.waitForSelector('.class-card:has(h3:text-is("同步測試班"))');
        await B.page.click('.class-card:has(h3:text-is("同步測試班"))');
        assert.equal(await waitVal(B.page, 1, 'score', 2), 2, 'device B sees device A data');

        // ---- 離線：A 斷網後加分 → 待同步；恢復網路後自動上傳
        await A.page.click('.class-card:has(h3:text-is("同步測試班"))');
        await A.context.setOffline(true);
        await cardOf(A.page, 2).locator('[data-act="score"]').click();
        await waitVal(A.page, 2, 'score', 1);
        await waitBadge(A.page, /離線中|待同步/);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 2, 'nothing uploaded while offline');
        await A.context.setOffline(false);
        await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
        await waitBadge(A.page, /已同步/);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 3);
        await B.page.click('#back-to-dashboard-btn');
        await B.page.click('#reload-cloud-btn');
        await waitBadge(B.page, /已同步/);
        await B.page.click('.class-card:has(h3:text-is("同步測試班"))');
        assert.equal(await waitVal(B.page, 2, 'score', 1), 1);

        // ---- 授權過期：Google 拒絕舊 token → 顯示需要重新連線，修改保留；重新連線後同步
        emu.revokeToken('test-token'); emu.addToken('token-2');
        await cardOf(A.page, 3).locator('[data-act="score"]').click();
        await waitBadge(A.page, /重新連線|授權/);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 3);
        await A.page.evaluate(() => { window.__fakeToken = 'token-2'; });
        await openSync(A.page);
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /已同步/.test(document.getElementById('db-status-text')?.textContent || ''), null, { timeout: 15000 });
        await closeSync(A.page);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 4, 'queued change uploaded after re-auth');

        // ---- 衝突：兩台都改 1 號的名字
        await B.page.evaluate(() => { window.__fakeToken = 'token-2'; });
        await openSync(B.page); await B.page.click('#sync-connect'); await waitBadge(B.page, /已同步/); await closeSync(B.page);
        const rename = async (page, name) => {
            await cardOf(page, 1).locator('.name-text').click();
            await page.fill('.name-edit', name); await page.press('.name-edit', 'Enter');
        };
        await rename(A.page, 'A取的名字');
        await waitBadge(A.page, /已同步/);
        await B.context.setOffline(true);
        await rename(B.page, 'B取的名字');
        await B.context.setOffline(false);
        await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
        await waitBadge(B.page, /衝突/);
        assert.match(JSON.stringify(emu.rows(sheetId, 'Students')), /A取的名字/, 'cloud copy not overwritten');
        await openSync(B.page);
        await B.page.waitForSelector('.sync-conflict');
        await shot(B.page, 'p5-sync-conflict');
        assert.equal(await B.page.locator('.sync-conflict').count(), 1, 'only the real (student name) conflict is shown');
        await B.page.click('.sync-conflict [data-use="remote"]');
        await B.page.waitForFunction(() => !document.querySelector('.sync-conflict'));
        await closeSync(B.page);
        await B.page.waitForSelector('#student-grid .student-card .name-text:text-is("A取的名字")');
        assert.ok(!emu.writes.some(w => w.kind === 'CLEAR'), 'no whole-sheet clear');
        assert.deepEqual(await strayNullTexts(B.page), [], 'no stray "null" text (BUG-007)');
        assert.deepEqual(A.errors, []); assert.deepEqual(B.errors.filter(e => !/net::ERR_INTERNET_DISCONNECTED/.test(e)), []);
    } finally { await A.close(); await B.close(); }
});

test('wrong client id format and denied consent are handled without breaking the app', async () => {
    const emu = createSheetsEmulator();
    const A = await openApp();
    await wireGoogle(A.context, emu);
    try {
        await openSync(A.page);
        await A.page.fill('#sync-client-id', 'my-secret-password');
        await A.page.click('#sync-connect');                // alert 被自動接受
        assert.equal(emu.books.size, 0);
        await A.page.fill('#sync-client-id', CLIENT_ID);
        await A.page.evaluate(() => { window.__denyScope = true; });
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /拒絕/.test(document.getElementById('sync-modal')?.textContent || ''));
        assert.equal(await A.page.isDisabled('#sync-create'), true);
        assert.deepEqual(A.errors, []);
    } finally { await A.close(); }
});
