// P3 作業：建立作業、批次登記、未登記≠未交、訂正、追蹤清單、投影隱私、復原、持久化、備份往返、類別設定、正向獎勵
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dueHomeworkHearts } from '../src/core/hw-hearts.js';
import { localDate } from '../src/core/dates.js';
import { openApp, teardown, importFile, fixturePath, fixture, shot, OUT, cardVal } from './helpers.mjs';
import { reloadAndSignIn } from './helpers.mjs';
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
        assert.match(await page.textContent('.hw-follow'), /未繳交（0）/);
        // 批次：甲、乙 → 已交
        await rowCheckbox(page, '代號甲').check();
        await rowCheckbox(page, '代號乙').check();
        await page.click('.hw-batch [data-batch="submitted"]');
        await page.waitForFunction(() => /2 \/ 3/.test(document.querySelector('.hw-card .hw-stat.big .hw-stat-v')?.textContent || ''));
        // 其餘未登記 → 未交
        await page.click('.hw-matrix th.hw-col .btn');
        await page.waitForFunction(() => /未繳交（1）/.test(document.querySelector('.hw-follow')?.textContent || ''));
        assert.match(await cell(page, '代號丙').textContent(), /未繳交/);
        // v6.2 四個按鈕：繳交 → 未訂正
        assert.match(await cell(page, '代號甲').textContent(), /✓ 繳交/);
        await cell(page, '代號甲').click();
        assert.deepEqual(await page.locator('#hw-cell-modal [data-simple]').allTextContents(), ['✓ 繳交', '✗ 未繳交', '✎ 未訂正', '★ 已訂正']);
        await page.click('#hw-cell-modal [data-simple="needs"]');
        await page.waitForFunction(() => /未訂正（1）/.test(document.querySelector('.hw-follow')?.textContent || ''));
        assert.match(await cell(page, '代號甲').textContent(), /未訂正/);
        // 免交、清除登記收在「更多」裡；未繳交的人不能設「不需訂正」
        await cell(page, '代號丙').click();
        assert.equal(await page.locator('#hw-cell-modal [data-sub="exempt"]').isVisible(), false, 'teacher-only states are folded away');
        await page.click('#hw-cell-modal .hw-more summary');
        assert.equal(await page.locator('#hw-cell-modal [data-sub="exempt"]').isVisible(), true);
        assert.equal(await page.locator('#hw-cell-modal [data-cor="none"]').isDisabled(), true);
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
        await reloadAndSignIn(page);
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        await page.click('.nav-tab[data-tab="homework"]');
        await teacher(page);
        assert.match(await cell(page, '代號丙').textContent(), /未繳交/);
        assert.match(await cell(page, '代號甲').textContent(), /未登記/, 'undoing the batch clears 繳交, so the later 未訂正 goes with it');
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
        assert.equal(await page.isChecked('#hw-auto-on'), true, 'v6.2 overdue hearts are on by default');
        assert.equal(await page.inputValue('#hw-auto-hours'), '24');
        await page.fill('#hw-auto-holidays', '2027-01-01\n2027-13-40');
        await page.click('#hw-settings-ok');                                    // 日期格式錯誤 → 提示，不儲存
        assert.equal(await page.isVisible('#hw-settings-modal.visible'), true);
        await page.fill('#hw-auto-holidays', '2027-01-01');
        await page.check('#hw-reward-on');
        await page.click('#hw-settings-ok');
        await page.click('#hw-add');
        const opts = await page.locator('#hw-f-type option').allTextContents();
        assert.ok(opts.includes('週記'));
        assert.ok(!opts.includes('國隨'));
        await page.click('#hw-edit-modal .modal-actions .btn-secondary');
        await addAssignment(page, '週記', '第 12 週');
        // 封存與還原
        await addAssignment(page, '考卷', '暫時的');
        await page.locator('.hw-card:has(.hw-title:text-is("暫時的")) .btn', { hasText: '封存' }).click();
        await page.locator('.hw-card:has(.hw-title:text-is("暫時的"))').waitFor({ state: 'detached' });
        await page.check('.hw-archived-toggle input');
        await page.locator('.hw-card.archived:has(.hw-title:text-is("暫時的")) .btn', { hasText: '還原' }).click();
        await page.locator('.hw-card:not(.archived):has(.hw-title:text-is("暫時的"))').waitFor();   // 等還原後重繪完成
        await page.click('.hw-archived-toggle input');
        await page.locator('.hw-archived-toggle').waitFor({ state: 'detached' });                  // 沒有封存的作業 → 切換鈕消失
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
        assert.equal(json.hwAssignments.length, 2);
        assert.equal(json.hwAssignments.filter(a => a.archived).length, 0, 'restored assignment is active again');
        assert.equal(json.hwEvents.length, 3);
        assert.equal(json.xpEvents.length, 1);
        assert.equal(json.xpEvents[0].source, 'hw-bonus');
        assert.ok(json.classes[0].hwTypes.some(t => t.name === '週記'));
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('v6.2 overdue homework adds a heart per school day automatically, once, and the teacher can see why', async () => {
    const now = Date.now(); const day = 86400_000;
    const b = fixture('backup-v5.1.json');
    b.version = 6;
    b.classes[0].hwAutoHeart = { enabled: true, hours: 24, holidays: [], since: now - 30 * day };
    b.hwAssignments = [{ id: 'hw-x', classId: b.classes[0].id, typeId: 'hwt-02', title: 'L9 逾期測試', note: '', assignedDate: localDate(now - 9 * day), dueDate: null, archived: false, createdAt: now - 9 * day, updatedAt: now - 9 * day }];
    b.hwEvents = [{ id: 'hx-1', classId: b.classes[0].id, assignmentId: 'hw-x', studentId: 's3', field: 'submission', value: 'missing', prev: 'unchecked', prevIds: [], ts: now - 8 * day, date: localDate(now - 8 * day), batchId: null, deviceId: 'dev-e2e', reason: '' }];
    const want = dueHomeworkHearts({ cls: b.classes[0], hwEvents: b.hwEvents, assignments: b.hwAssignments, studentIds: ['s3'], existingIds: new Set(), now: now + 60_000 }).length;
    assert.ok(want >= 4, `expected several school days in 8 calendar days, got ${want}`);
    const file = join(OUT, 'v62-overdue-backup.json');
    writeFileSync(file, JSON.stringify(b));
    const app = await openApp();
    const { page } = app;
    try {
        await importFile(page, file);
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        await page.waitForSelector('#student-grid .student-card');
        // 匯出備份確認：自動愛心的筆數、固定 id、原因
        const exportEvents = async () => {
            await page.click('#back-to-dashboard-btn');
            const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-data-btn')]);
            const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
            await page.click('.class-card:has(h3:text-is("測試五一班"))');
            return json.events.filter(e => e.source === 'hw-auto');
        };
        let hearts = await exportEvents();
        assert.ok(hearts.length === want || hearts.length === want + 1, `got ${hearts.length}, want ${want}`);
        assert.ok(hearts.every(e => e.kind === 'heart' && e.delta === 1 && e.targetId === 's3' && e.id.startsWith('hwheart|hx-1|')));
        assert.match(hearts[0].reason, /作業逾期：國習 L9 逾期測試（未繳交）/);
        // 重新整理：不會重複加
        await reloadAndSignIn(page);
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        await page.waitForSelector('#student-grid .student-card');
        const again = await exportEvents();
        assert.equal(again.length, hearts.length, 'running again adds nothing');
        hearts = again;
        assert.ok(await cardVal(page, 3, 'heart') >= hearts.length);
        // 歷程顯示記錄人＝自動
        await page.click('.nav-tab[data-tab="history"]');
        await page.waitForFunction(() => /自動（作業逾期）/.test(document.body.textContent));
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});
