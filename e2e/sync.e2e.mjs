// P5 雲端同步（真實 UI＋真實 adapter／引擎；Google 登入元件與 Sheets API 在網路層由模擬器回應）
// 兩個瀏覽器 context = 兩台裝置（各自的 IndexedDB）。這不是真實 Google 帳號測試（見 docs/VERIFICATION：真實 OAuth = BLOCKED）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, teardown, createClass, cardOf, waitVal, shot, TEACHER_A, TEACHER_B } from './helpers.mjs';
import { subOfAccessToken } from '../tests/helpers/fake-google.mjs';
import { strayNullTexts } from './helpers.mjs';
import { createSheetsEmulator } from '../tests/helpers/sheets-emulator.mjs';

after(teardown);
const A_TOKEN1 = `at.${TEACHER_A.sub}.1`;
const newEmu = () => createSheetsEmulator({ validTokens: [], tokenOwner: subOfAccessToken });
const openSync = async (page) => {
    const inClass = await page.evaluate(() => document.getElementById('class-view').classList.contains('active'));
    await page.click(inClass ? '#class-sync-badge' : '#db-status-badge');
    await page.waitForSelector('#sync-modal.visible');
};
const closeSync = (page) => page.click('#sync-modal .modal-actions:last-child .btn');
const badge = (page) => page.textContent('#db-status-text');
/**
 * 等狀態徽章出現指定文字。逾時的話，錯誤訊息附上等待期間徽章的每一次變化、目前的 title、navigator.onLine，
 * 讓 CI（只看得到文字紀錄）也能判斷卡在哪裡；不改變等待的條件或時間。
 */
const waitBadge = async (page, re, timeout = 15000) => {
    await page.evaluate(() => {
        const el = document.getElementById('db-status-text'); const t0 = performance.now();
        window.__badgeLog = [`${0}ms ${el?.textContent} | ${document.getElementById('db-status-badge')?.title || ''}`];
        window.__badgeObs?.disconnect();
        window.__badgeObs = new MutationObserver(() => window.__badgeLog.push(`${Math.round(performance.now() - t0)}ms ${el?.textContent} | online=${navigator.onLine}`));
        if (el) window.__badgeObs.observe(el, { childList: true, characterData: true, subtree: true });
    });
    try { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('db-status-text')?.textContent || ''), re.source, { timeout }); }
    catch (e) {
        const info = await page.evaluate(() => ({ now: document.getElementById('db-status-text')?.textContent, title: document.getElementById('db-status-badge')?.title, online: navigator.onLine, log: window.__badgeLog })).catch(() => ({}));
        throw new Error(`badge never matched ${re}: ${JSON.stringify(info)}`, { cause: e });
    }
};

test('two devices sync through Google Sheets: setup, join, offline queue, token expiry, conflict resolution', async () => {
    const emu = newEmu();
    const A = await openApp({ emu }); const B = await openApp({ emu });   // 同一位老師（帳號 A）的兩台裝置
    try {
        // ---- 裝置 A：建立資料、連線、建立試算表
        await createClass(A.page, '同步測試班', 3);
        for (let i = 0; i < 2; i++) await cardOf(A.page, 1).locator('[data-act="score"]').click();
        await waitVal(A.page, 1, 'score', 2);
        await A.page.click('#back-to-dashboard-btn');
        assert.match(await badge(A.page), /僅存本機/);
        await openSync(A.page);
        assert.match(await A.page.textContent('#sync-account'), /teacher\.a@example\.test/);
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
        assert.ok(emu.rows(sheetId, 'Students').every(r => !/at\./.test(JSON.stringify(r))), 'no token stored in the sheet');

        // ---- 裝置 B：全新瀏覽器，貼上同一份試算表
        await openSync(B.page);
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
        emu.revokeToken(A_TOKEN1);
        await cardOf(A.page, 3).locator('[data-act="score"]').click();
        await waitBadge(A.page, /重新連線|授權/);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 3);
        await A.page.evaluate(() => { window.__fakeGoogle.tokenGen = 2; });
        await openSync(A.page);
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /已同步/.test(document.getElementById('db-status-text')?.textContent || ''), null, { timeout: 15000 });
        await closeSync(A.page);
        assert.equal(emu.rows(sheetId, 'ScoreEvents').length, 4, 'queued change uploaded after re-auth');

        // ---- 衝突：兩台都改 1 號的名字
        await B.page.evaluate(() => { window.__fakeGoogle.tokenGen = 2; });
        await openSync(B.page); await B.page.click('#sync-connect'); await waitBadge(B.page, /已同步/); await closeSync(B.page);
        const rename = async (page, name) => {
            await cardOf(page, 1).locator('.name-text').click();
            await page.fill('.name-edit', name); await page.press('.name-edit', 'Enter');
        };
        await rename(A.page, 'A取的名字');
        // BUG-032 附帶發現（測試競態）：徽章在改名前就已經是「已同步」，等徽章會立刻通過，A 其實還沒上傳；
        // B 先上傳就不會有衝突。改成等「A 的改名真的出現在雲端試算表」這個明確條件。
        for (const end = Date.now() + 15000; !JSON.stringify(emu.rows(sheetId, 'Students')).includes('A取的名字');) {
            if (Date.now() > end) throw new Error(`A's rename never reached the sheet; A badge: ${await badge(A.page)}`);
            await new Promise(ok => setTimeout(ok, 100));
        }
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

test('Sheets authorization: denied consent, missing file scope and a different Google account are refused without touching local data', async () => {
    const emu = newEmu();
    const A = await openApp({ emu });
    try {
        await createClass(A.page, '授權測試班', 3);
        await cardOf(A.page, 1).locator('[data-act="score"]').click();
        await waitVal(A.page, 1, 'score', 1);
        await A.page.click('#back-to-dashboard-btn');
        await openSync(A.page);
        // 1) 拒絕授權
        await A.page.evaluate(() => { window.__fakeGoogle.denyScope = true; });
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /拒絕/.test(document.getElementById('sync-modal')?.textContent || ''));
        assert.equal(await A.page.isDisabled('#sync-create'), true);
        // 2) 沒勾選檔案存取權限 → 拒絕並撤銷 token
        await A.page.evaluate(() => { window.__fakeGoogle.denyScope = false; window.__fakeGoogle.noDriveScope = true; });
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /檔案存取/.test(document.getElementById('sync-modal')?.textContent || ''));
        assert.equal(await A.page.isDisabled('#sync-create'), true);
        // 3) 授權視窗選了另一個帳號（B）→ 帳號不符：拒絕、撤銷 token、不能建立試算表
        await A.page.evaluate((b) => { window.__fakeGoogle.noDriveScope = false; window.__fakeGoogle.oauthAccount = b; }, TEACHER_B);
        await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => /帳號與目前登入的帳號不同/.test(document.getElementById('sync-modal')?.textContent || ''));
        assert.equal(await A.page.isDisabled('#sync-create'), true);
        const fg = await A.page.evaluate(() => ({ revoked: window.__fakeGoogle.revoked || [], hint: window.__fakeGoogle.lastHint }));
        assert.ok(fg.revoked.includes(`at.${TEACHER_B.sub}.1`), 'mismatched token is revoked');
        assert.equal(fg.hint, TEACHER_A.email, 'the consent window is pre-selected with the signed-in account');
        assert.equal(emu.books.size, 0, 'nothing was created in any spreadsheet');
        assert.equal(emu.requests.length, 0, 'no Sheets request was made with a refused token');
        // 本機資料完好
        await A.page.keyboard.press('Escape');
        await A.page.click('.class-card:has(h3:text-is("授權測試班"))');
        assert.equal(await waitVal(A.page, 1, 'score', 1), 1);
        assert.deepEqual(A.errors, []);
    } finally { await A.close(); }
});

test('a spreadsheet the signed-in account cannot access is refused (no fallback to another sheet)', async () => {
    const emu = newEmu();
    const A = await openApp({ emu });
    const B = await openApp({ emu, account: TEACHER_B });
    try {
        await openSync(A.page); await A.page.click('#sync-connect');
        await A.page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await A.page.click('#sync-create'); await A.page.waitForSelector('#sync-sheet-link');
        const [sheetA] = [...emu.books.keys()];
        await openSync(B.page); await B.page.click('#sync-connect');
        await B.page.waitForFunction(() => !document.getElementById('sync-create')?.disabled);
        await B.page.fill('#sync-sheet-id', sheetA);
        await B.page.click('#sync-use');
        await B.page.waitForFunction(() => /無法存取這份試算表/.test(document.getElementById('sync-modal')?.textContent || ''));
        assert.equal(await B.page.locator('#sync-sheet-link').count(), 0, 'B keeps no spreadsheet configured');
        assert.equal(emu.books.size, 1, 'no replacement spreadsheet created');
        assert.ok(emu.requests.filter(r => r.owner === TEACHER_B.sub).every(r => r.method === 'GET'), 'B never wrote anything');
        assert.deepEqual(A.errors, []); assert.deepEqual(B.errors, []);
    } finally { await A.close(); await B.close(); }
});
