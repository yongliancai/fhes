// P6 響應式與無障礙：手機／平板／筆電／投影四種尺寸不可水平溢出；axe-core 無 critical/serious 違規；截圖
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORTS } from './viewports.mjs';
import { openApp, teardown, importFile, fixturePath, shot, overflow, axe } from './helpers.mjs';

after(teardown);

const screens = [
    ['dashboard', async () => {}],
    ['students', async (p) => { await p.click('.class-card:has(h3:text-is("測試五一班"))'); await p.waitForSelector('#student-grid .student-card'); }],
    ['homework', async (p) => { await p.click('.nav-tab[data-tab="homework"]'); await p.waitForSelector('#homework-tab .hw-banner'); await p.click('#hw-view-toggle'); }],
    ['collection', async (p) => { await p.click('.nav-tab[data-tab="collection"]'); await p.waitForSelector('#collection-tab .col-grid'); }],
    ['history', async (p) => { await p.click('.nav-tab[data-tab="history"]'); await p.waitForSelector('#history-summary'); }],
    ['sync-dialog', async (p) => { await p.click('#class-sync-badge'); await p.waitForSelector('#sync-modal.visible'); }],
];

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    test(`no horizontal overflow on ${vpName} (${vp.width}×${vp.height}) across main screens`, async () => {
        const app = await openApp({ viewport: vp });
        const { page } = app;
        try {
            await importFile(page, fixturePath('backup-v5.1.json'));
            await page.click('#backup-reminder-later').catch(() => {});
            const problems = {};
            for (const [name, go] of screens) {
                await go(page);
                await page.waitForTimeout(650);   // 等畫面切換的淡入動畫結束再量與截圖
                const o = await overflow(page);
                if (o.length) problems[name] = o;
                await shot(page, `p6-${vpName}-${name}`);
            }
            assert.deepEqual(problems, {}, JSON.stringify(problems, null, 1));
            assert.deepEqual(app.errors, []);
        } finally { await app.close(); }
    });
}

test('axe-core: no critical/serious accessibility violations on the main screens (laptop)', async () => {
    const app = await openApp({ viewport: VIEWPORTS.laptop });
    const { page } = app;
    try {
        await importFile(page, fixturePath('backup-v5.1.json'));
        await page.click('#backup-reminder-later').catch(() => {});
        const found = {};
        for (const [name, go] of screens) {
            await go(page);
            await page.waitForTimeout(650);   // 與溢出測試相同：等畫面淡入動畫結束再量對比（Firefox 會量到半透明中的顏色）
            const v = await axe(page, name === 'sync-dialog' ? '#sync-modal' : null);
            if (v.length) found[name] = v;
        }
        assert.deepEqual(found, {}, JSON.stringify(found, null, 1));
    } finally { await app.close(); }
});

test('keyboard: tabs, homework cell editor and collection cards are reachable and operable with the keyboard', async () => {
    const app = await openApp({ viewport: VIEWPORTS.laptop });
    const { page } = app;
    try {
        await importFile(page, fixturePath('backup-v5.1.json'));
        await page.click('#backup-reminder-later').catch(() => {});
        await page.focus('.class-card:has(h3:text-is("測試五一班"))').catch(() => {});
        await page.click('.class-card:has(h3:text-is("測試五一班"))');
        await page.focus('.nav-tab[data-tab="collection"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#collection-tab .col-grid');
        await page.focus('.col-card[data-item="land-01"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#col-detail-modal.visible');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#col-detail-modal', { state: 'hidden' });
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});
