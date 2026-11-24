// P3 作業：建立作業、批次登記、未登記≠未交、訂正、追蹤清單、投影隱私、復原、持久化、備份往返、類別設定、正向獎勵
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openApp, teardown, importFile, fixturePath, shot } from './helpers.mjs';
import { strayNullTexts } from './helpers.mjs';

after(teardown);
const NAMES = ['代號甲', '代號乙', '代號丙'];

const openHomework = async (page) => {
    await importFile(page, fixturePath('backup-v5.1.json'));
    await page.click('.class-card:has(h3:text-is("測試五一班"))');
    await page.click('.nav-tab[data-tab="homework"]');
    await page.waitForSelector('#homework-tab .hw-banner');
};
const teacher = async (page) => { if ((await page.getAttribute('#hw-view-toggle', 'aria-pressed')) !== 'true') await page.click('#hw-view-toggle'); };
const addAssignment = async (page, typeName, title) => {
    await page.click('#hw-add');
    await page.selectOption('#hw-f-type', { label: typeName });
    await page.fill('#hw-f-title', title);
    await page.click('#hw-f-ok');
    await page.waitForSelector(`.hw-card:has(.hw-title:text-is("${title}"))`);
};
const rowCheckbox = (page, name) => page.locator(`.hw-matrix tbody tr:has(button.linkish:text-is("${name}")) input[type=checkbox]`);
const cell = (page, name) => page.locator(`.hw-matrix tbody tr:has(button.linkish:text-is("${name}")) .hw-cell`).first();
const bigStat = async (page, title) => (await page.locator(`.hw-card:has(.hw-title:text-is("${title}")) .hw-stat.big .hw-stat-v`).textContent()).trim();

test('homework flow: batch, unchecked≠missing, correction, follow-up, privacy, undo, persistence', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await openHomework(page);
        // 預設投影模式：沒有新增按鈕、沒有姓名
        assert.equal(await page.locator('#hw-add').count(), 0);
        await teacher(page);
        await addAssignment(page, '國習', 'L6 P18-21');
        assert.equal(await bigStat(page, 'L6 P18-21'), '0 / 3');
        // 未登記：不算未交
        assert.match(await cell(page, '代號丙').textContent(), /未登記/);
        assert.match(await page.textContent('.hw-follow'), /待補交（0）/);
        // 批次：甲、乙 → 已交
        await rowCheckbox(page, '代號甲').check();
        await rowCheckbox(page, '代號乙').check();
        await page.click('.hw-batch [data-batch="submitted"]');
        await page.waitForFunction(() => /2 \/ 3/.test(document.querySelector('.hw-card .hw-stat.big .hw-stat-v')?.textContent || ''));
        // 其餘未登記 → 未交
        await page.click('.hw-matrix th.hw-col .btn');
        await page.waitForFunction(() => /待補交（1）/.test(document.querySelector('.hw-follow')?.textContent || ''));
        assert.match(await cell(page, '代號丙').textContent(), /未交/);
        // 已交 ≠ 已訂正：甲 已交 → 未批改 → 待訂正
        assert.match(await cell(page, '代號甲').textContent(), /未批改/);
        await cell(page, '代號甲').click();
        await page.click('#hw-cell-modal [data-cor="needs"]');
        await page.waitForFunction(() => /待訂正（1）/.test(document.querySelector('.hw-follow')?.textContent || ''));
        // 未交者不能設定訂正
        await cell(page, '代號丙').click();
        assert.equal(await page.locator('#hw-cell-modal [data-cor="done"]').isDisabled(), true);
        await page.click('#hw-cell-modal .modal-actions .btn');
        assert.deepEqual(await strayNullTexts(page), [], 'no stray "null" text in the cell editor (BUG-007)');
        await shot(page, 'p3-homework-teacher');
        // 投影模式：只有匿名統計，任何姓名都不出現
        await page.click('#hw-view-toggle');
        const publicText = await page.textContent('#homework-tab');
        for (const n of NAMES) assert.ok(!publicText.includes(n), `projection view must not show ${n}`);
        assert.match(publicText, /2 \/ 3/);
        assert.match(publicText, /67%/);
        await shot(page, 'p3-homework-projection');
        // 離開分頁再回來 → 仍是投影模式
        await teacher(page);
        await page.click('.nav-tab[data-tab="students"]');
        await page.click('.nav-tab[data-tab="homework"]');
        assert.equal(await page.getAttribute('#hw-view-toggle', 'aria-pressed'), 'false');
        // 復原上一批（甲乙已交）
        await teacher(page);
        await page.click('#hw-undo-batch');
        await page.waitForFunction(() => /0 \/ 3/.test(document.querySelector('.hw-card .hw-stat.big .hw-stat-v')?.textContent || ''));
        // 持久化：重新整理
        await page.reload();
        await page.waitForFunction(() => document.getElementById('class-dashboard')?.classList.contains('active'));
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        await page.click('.nav-tab[data-tab="homework"]');
        await teacher(page);
        assert.match(await cell(page, '代號丙').textContent(), /未交/);
        assert.match(await cell(page, '代號甲').textContent(), /未登記/);
        // 個人歷程
        await page.click('.hw-matrix button.linkish:text-is("代號甲")');
        await page.waitForSelector('#hw-student-modal.visible');
        assert.ok((await page.locator('#hw-student-modal tbody tr').count()) >= 3, 'history keeps original + undo events');
        await page.click('#hw-student-modal .modal-actions .btn');
        assert.deepEqual(await strayNullTexts(page), [], 'no stray "null" text (BUG-007)');
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('homework settings, reward rule (off by default), backup round trip', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await openHomework(page);
        await teacher(page);
        // 類別設定：新增「週記」、停用「國隨」
        await page.click('#hw-settings');
        await page.fill('#hwt-new', '週記');
        await page.click('#hw-settings-modal .label-row:has(#hwt-new) .btn');
        await page.locator('#hw-settings-modal .hw-type-row:has(input.hwt-name[value="國隨"]) .hwt-active').uncheck();
        assert.equal(await page.isChecked('#hw-reward-on'), false, 'reward rule is off by default');
        await page.check('#hw-reward-on');
        await page.click('#hw-settings-ok');
        await page.click('#hw-add');
        const opts = await page.locator('#hw-f-type option').allTextContents();
        assert.ok(opts.includes('週記'));
        assert.ok(!opts.includes('國隨'));
        await page.click('#hw-edit-modal .modal-actions .btn-secondary');
        await addAssignment(page, '週記', '第 12 週');
        // 全部交齊 → 出現全班獎勵按鈕
        await page.locator('.hw-matrix thead input[type=checkbox]').check();
        await page.click('.hw-batch [data-batch="submitted"]');
        const bonus = page.locator('.hw-card .btn-success', { hasText: '全班交齊' });
        await bonus.waitFor();
        await bonus.click();
        await page.waitForSelector('.hw-tag.good');
        // 備份往返
        await page.click('#back-to-dashboard-btn');
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-data-btn')]);
        const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
        assert.equal(json.version, 6);
        assert.equal(json.hwAssignments.length, 1);
        assert.equal(json.hwEvents.length, 3);
        assert.equal(json.xpEvents.length, 1);
        assert.equal(json.xpEvents[0].source, 'hw-bonus');
        assert.ok(json.classes[0].hwTypes.some(t => t.name === '週記'));
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});
