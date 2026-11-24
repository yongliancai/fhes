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
