// v5.1 既有功能回歸（真實瀏覽器 + 全新 IndexedDB）：加分、扣分/消除、兌換、秩序記錄→待確認→確認、
// 備份匯出往返、v4/v5/v5.1 合成備份導入後數字正確。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openApp, teardown, createClass, cardOf, waitVal, importFile, fixturePath, fixture, shot } from './helpers.mjs';

after(teardown);

test('scoring, penalty with reason, clear, redeem keep v5.1 semantics', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '回歸測試班', 4);
        const card = cardOf(page, 1);
        for (let i = 0; i < 3; i++) await card.locator('[data-act="score"]').click();
        assert.equal(await waitVal(page, 1, 'score', 3), 3);
        // 扣分：必選原因
        await card.locator('[data-act="penalty"]').click();
        await page.waitForSelector('#reason-modal.visible');
        await page.locator('#reason-grid .reason-btn', { hasText: '講話' }).click();
        assert.equal(await waitVal(page, 1, 'heart', 1), 1);
        // 消除
        await card.locator('[data-act="clear"]').click();
        await page.locator('#reason-grid .reason-btn', { hasText: '表現改善' }).click();
        assert.equal(await waitVal(page, 1, 'heart', 0), 0);
        // 兌換：其他（自填 2 分）→ 可用 1，累計獲得仍 3
        await card.locator('[data-act="redeem"]').click();
        await page.locator('#reason-grid .reason-btn', { hasText: '其他' }).click();
        await page.fill('#reason-other-name', '測試貼紙');
        await page.fill('#reason-other-cost', '2');
        await page.click('#reason-other-ok');
        assert.equal(await waitVal(page, 1, 'score', 1), 1);
        assert.match(await card.locator('.score-num').getAttribute('title'), /累計獲得 3/);
        await shot(page, 'p2-legacy-scoring');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('order-recording records stay pending until the teacher confirms', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '秩序測試班', 4);
        await page.click('#record-start-btn');
        await page.check('input[name="record-session"][value="午休"]');
        const recorderId = await cardOf(page, 1).getAttribute('data-id');
        await page.selectOption('#record-recorder', recorderId);
        await page.click('#record-start-ok');
        await page.waitForSelector('#record-overlay:not([hidden])');
        assert.equal(await page.locator(`#record-grid .seat-btn[data-sid="${recorderId}"]`).isDisabled(), true, 'recorder cannot record self');
        await page.locator('#record-grid .seat-btn', { hasText: /^2$/ }).click();
        await page.locator('#record-reason-grid [data-reason="走動"]').click();
        await page.click('#record-end');
        await page.waitForSelector('#record-overlay[hidden]', { state: 'attached' });
        assert.equal(await waitVal(page, 2, 'heart', 0), 0, 'pending record is not counted');
        assert.match(await page.textContent('#pending-btn'), /\(1\)/);
        await page.click('#pending-btn');
        await page.click('#pending-confirm-all');
        await page.click('#pending-close');
        assert.equal(await waitVal(page, 2, 'heart', 1), 1, 'confirmed record counts');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('export backup → re-import round trip keeps every number', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '往返測試班', 3);
        for (let i = 0; i < 5; i++) await cardOf(page, 2).locator('[data-act="score"]').click();
        await page.click('#back-to-dashboard-btn');
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-data-btn')]);
        const path = await dl.path();
        const json = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(json.format, 'classroom-powerhouse');
        assert.equal(json.events.length, 5);
        await importFile(page, path);
        await page.click('.class-card:has(h3:text-is("往返測試班"))');
        assert.equal(await waitVal(page, 2, 'score', 5), 5);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

for (const [file, cls, seat, which, want] of [
    ['backup-v4.json', '測試四年級', 1, 'score', 5],
    ['backup-v5.json', '測試五班', 2, 'heart', 2],
    ['backup-v5.1.json', '測試五一班', 1, 'score', 6],
    ['backup-v5.1.json', '測試五一班', 2, 'heart', 1],
]) {
    test(`import ${file}: ${cls} seat ${seat} ${which} = ${want}`, async () => {
        const app = await openApp();
        const { page } = app;
        try {
            const fx = fixture(file);
            const path = file === 'backup-v4.json' ? await writeTemp(fx.data) : fixturePath(file);
            await importFile(page, path);
            await page.click(`.class-card:has(h3:text-is("${cls}"))`);
            await page.waitForSelector('#student-grid .student-card');
            assert.equal(await waitVal(page, seat, which, want), want);
            if (file === 'backup-v5.1.json') assert.match(await page.textContent('#pending-btn'), /\(1\)/, 'pending record survives import');
            assert.deepEqual(app.errors, []);
        } finally { await app.close(); }
    });
}

/** v4 fixture 存成「班級陣列」原始格式 */
const writeTemp = async (data) => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const p = join(mkdtempSync(join(tmpdir(), 'fhes-v4-')), 'v4.json');
    writeFileSync(p, JSON.stringify(data));
    return p;
};

test('legacy v5.1 IndexedDB (no account) is never auto-assigned; teacher previews, backs up, imports, numbers match; undo works; legacy copy untouched', async () => {
    const { setup, wireFakeGoogle, signIn, TEST_CLIENT_ID } = await import('./helpers.mjs');
    const { url, browser } = await setup();
    const context = await browser.newContext({ timezoneId: 'Asia/Taipei', acceptDownloads: true });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await wireFakeGoogle(context);
    await context.addInitScript((cid) => { try { localStorage.setItem('fhes_google_client_id', cid); } catch { /* ignore */ } }, TEST_CLIENT_ID);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    const downloads = [];
    page.on('download', d => downloads.push(d.suggestedFilename()));
    try {
        // 先在同一個 origin（任一靜態檔）用 v5.1 的 schema（version 1）寫入資料：模擬升級前的老師電腦
        await page.goto(url + 'tests/fixtures/backup-v5.1.json');
        const fx = fixture('backup-v5.1.json');
        await page.evaluate(async (fx) => {
            const db = await new Promise((ok, no) => {
                const r = indexedDB.open('classroomPowerhouseV5', 1);
                r.onupgradeneeded = () => {
                    const d = r.result;
                    d.createObjectStore('classes', { keyPath: 'id' });
                    d.createObjectStore('students', { keyPath: 'id' }).createIndex('classId', 'classId');
                    const ev = d.createObjectStore('events', { keyPath: 'id' }); ev.createIndex('classId', 'classId'); ev.createIndex('date', 'date');
                    d.createObjectStore('dailySnapshots', { keyPath: 'id' }).createIndex('classId', 'classId');
                    d.createObjectStore('meta', { keyPath: 'key' });
                };
                r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
            });
            const tx = db.transaction(['classes', 'students', 'events', 'dailySnapshots', 'meta'], 'readwrite');
            fx.classes.forEach(x => tx.objectStore('classes').put(x));
            fx.students.forEach(x => tx.objectStore('students').put(x));
            fx.events.forEach(x => tx.objectStore('events').put(x));
            fx.dailySnapshots.forEach(x => tx.objectStore('dailySnapshots').put(x));
            tx.objectStore('meta').put({ key: 'dataVersion', value: 5.1 });
            await new Promise((ok) => { tx.oncomplete = ok; });
            db.close();
        }, fx);
        await page.goto(url);
        // 未登入：看不到任何班級
        await page.waitForSelector('#auth-gate');
        assert.equal(await page.locator('.class-card').count(), 0, 'nothing rendered before sign-in');
        await signIn(page);
        // 登入後：舊資料「沒有」被自動指定給這個帳號，只出現提示
        assert.equal(await page.locator('.class-card:has(h3:text-is("測試五一班"))').count(), 0, 'legacy class is not auto-assigned');
        await page.waitForSelector('#legacy-banner:not([hidden])');
        await page.click('#legacy-open');
        await page.waitForSelector('#legacy-modal.visible');
        assert.match(await page.textContent('#legacy-modal'), /測試五一班/);
        await shot(page, 'auth-legacy-preview');
        // 沒勾選不能匯入
        await page.click('#legacy-import');
        assert.equal(await page.locator('.class-card:has(h3:text-is("測試五一班"))').count(), 0);
        // 勾選 → 先下載舊資料備份 → 匯入
        await page.check('#legacy-modal input[data-legacy-class]');
        const dl = page.waitForEvent('download');
        await page.click('#legacy-import');
        await dl;
        assert.ok(downloads.some(n => /舊資料備份/.test(n)), `legacy backup downloaded first: ${downloads}`);
        await page.keyboard.press('Escape');
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        assert.equal(await waitVal(page, 1, 'score', 6), 6);
        assert.equal(await waitVal(page, 2, 'heart', 1), 1);
        assert.match(await page.textContent('#pending-btn'), /\(1\)/);
        await page.click('.nav-tab[data-tab="homework"]');
        await page.waitForSelector('#homework-tab .hw-banner');
        // 帳號資料庫是新的 v2；舊資料庫仍是 v1、內容不變
        const dbs = await page.evaluate(async () => {
            const open = (n) => new Promise(ok => { const r = indexedDB.open(n); r.onsuccess = () => { const d = r.result; const out = { v: d.version, stores: [...d.objectStoreNames].sort() }; d.close(); ok(out); }; });
            const names = (await indexedDB.databases()).map(d => d.name);
            const acct = names.find(n => n.startsWith('fhes-acct-'));
            return { names, acct: await open(acct), legacy: await open('classroomPowerhouseV5') };
        });
        assert.equal(dbs.legacy.v, 1, 'legacy database is not upgraded or modified');
        assert.equal(dbs.acct.v, 2);
        for (const s of ['hwAssignments', 'hwEvents', 'xpEvents', 'specialItems', 'grants', 'syncState']) assert.ok(dbs.acct.stores.includes(s), s);
        // 復原這次匯入
        await page.click('#back-to-dashboard-btn');
        await page.click('#legacy-open');
        await page.click('#legacy-undo');
        await page.waitForFunction(() => !document.querySelector('.class-card[data-id]'));
        assert.equal(await page.locator('.class-card:has(h3:text-is("測試五一班"))').count(), 0, 'undo removed the imported class');
        // 重新整理 → 必須再登入；舊資料仍在，提示仍在
        await page.reload();
        await page.waitForSelector('#auth-gate');
        await signIn(page);
        await page.waitForSelector('#legacy-banner:not([hidden])');
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('legacy v4 localStorage cache is no longer auto-migrated into whoever signs in; it is offered for explicit import', async () => {
    const { openApp: open, signIn: login, TEACHER_B } = await import('./helpers.mjs');
    const app = await open({ signIn: false });
    const { page } = app;
    try {
        await page.evaluate((arr) => localStorage.setItem('classroomPowerhouse_cache_v4', JSON.stringify(arr)), fixture('backup-v4.json').data);
        await page.reload();
        await login(page, TEACHER_B);
        assert.equal(await page.locator('.class-card:has(h3:text-is("測試四年級"))').count(), 0, 'v4 cache is not assigned automatically');
        await page.waitForSelector('#legacy-banner:not([hidden])');
        await page.click('#legacy-open');
        assert.match(await page.textContent('#legacy-modal'), /v4 快取/);
        await page.check('#legacy-modal input[data-legacy-class]');
        await page.click('#legacy-import');
        await page.keyboard.press('Escape');
        await page.click('.class-card:has(h3:text-is("測試四年級"))');
        assert.equal(await waitVal(page, 1, 'score', 5), 5);
        assert.ok(await page.evaluate(() => !!localStorage.getItem('classroomPowerhouse_cache_v4')), 'the v4 cache itself is kept');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('rollback export: "v5.1 相容備份" downloads a version-5.1 file with every score event', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '回退測試班', 2);
        for (let i = 0; i < 3; i++) await cardOf(page, 1).locator('[data-act="score"]').click();
        await waitVal(page, 1, 'score', 3);
        await page.click('#back-to-dashboard-btn');
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-v51-btn')]);
        const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
        assert.equal(json.version, 5.1);
        assert.equal(json.events.length, 3);
        assert.equal(json.hwEvents, undefined);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('daily settlement snapshot and day CSV (v5.1 features) still work', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '結算測試班', 2);
        for (let i = 0; i < 2; i++) await cardOf(page, 1).locator('[data-act="score"]').click();
        await waitVal(page, 1, 'score', 2);
        await page.click('.nav-tab[data-tab="history"]');
        await page.click('#settle-today-btn');
        await page.waitForFunction(() => /已於/.test(document.getElementById('history-status')?.textContent || ''));
        const row = await page.locator('#history-summary tbody tr').first().textContent();
        assert.match(row, /\+2/);
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#history-csv-day')]);
        const csv = readFileSync(await dl.path(), 'utf8');
        assert.match(csv, /時段/); assert.match(csv, /記錄人/);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});
