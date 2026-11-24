// P4 圖鑑／XP／棲地：小隊 XP 不乘人數、解鎖與能量、逐步揭露、收藏不因扣分消失、持久化、特殊收藏與標籤、減少動態、美術總覽截圖
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, teardown, createClass, shot, setup } from './helpers.mjs';

after(teardown);

const toGroups = async (page) => { await page.click('.nav-tab[data-tab="groups"]'); await page.waitForSelector('#groups-area .group-column'); };
const groupPlus = async (page, g, times) => {
    for (let i = 0; i < times; i++) await page.click(`.group-column[data-group-id="${g}"] .score-btn[data-amount="1"]`);
    await page.waitForFunction(([g, t]) => document.querySelector(`.group-column[data-group-id="${g}"] .group-xp`)?.textContent === `XP ${t}`, [g, times]);
};
const openCollection = async (page) => { await page.click('.nav-tab[data-tab="collection"]'); await page.waitForSelector('#collection-tab .col-grid'); };

test('group XP is not multiplied by members; unlock spends energy; sequential reveal; items survive penalties; persistence', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '圖鑑測試班', 6);
        await toGroups(page);
        await page.fill('#group-count-input', '2'); await page.dispatchEvent('#group-count-input', 'change');
        await page.click('#random-group-btn');                  // 6 人分 2 組 → 每組 3 人
        await groupPlus(page, 1, 12);
        assert.equal(await page.textContent('.group-column[data-group-id="1"] .group-xp'), 'XP 12', 'group +1 ×12 = 12 XP, not 36');
        // 個人加分 → 該生小隊 XP +1
        await page.click('.nav-tab[data-tab="students"]');
        await page.locator('#student-grid .student-card').first().locator('[data-act="score"]').click();
        await toGroups(page);
        const xp1 = await page.textContent('.group-column[data-group-id="1"] .group-xp');
        const xp2 = await page.textContent('.group-column[data-group-id="2"] .group-xp');
        assert.ok([xp1, xp2].includes('XP 13') || [xp1, xp2].includes('XP 1'), `student +1 went to their own group (${xp1}, ${xp2})`);

        await openCollection(page);
        await page.click('.col-owner[data-owner="1"]');
        const energy0 = Number(await page.textContent('#col-energy'));
        assert.ok(energy0 >= 12);
        assert.equal(await page.textContent('.col-card[data-item="land-06"] .col-name'), '？？？', 'rare is hidden until commons are collected');
        await page.click('.col-card[data-item="land-01"]');
        await page.click('#col-unlock');
        await page.waitForSelector('#col-celebrate.visible');
        await shot(page, 'p4-unlock-celebrate');
        await page.click('#col-celebrate .btn');
        assert.equal(Number(await page.textContent('#col-energy')), energy0 - 10);
        assert.equal(await page.locator('.col-card[data-item="land-01"].owned').count(), 1);
        assert.equal(await page.locator('.scene-creatures .scene-actor').count(), 1);
        // 互動不消耗任何東西
        await page.locator('.scene-creatures .scene-actor').first().click({ force: true });   // 角色一直在晃動（待機動畫），Playwright 的穩定判定永遠不成立
        assert.equal(Number(await page.textContent('#col-energy')), energy0 - 10);
        // 扣小隊分數不影響收藏與 XP
        await toGroups(page);
        await page.click('.group-column[data-group-id="1"] .score-btn[data-amount="-1"]');
        await openCollection(page);
        await page.click('.col-owner[data-owner="1"]');
        assert.equal(await page.locator('.col-card[data-item="land-01"].owned').count(), 1);
        assert.equal(Number(await page.textContent('#col-energy')), energy0 - 10, 'negative score does not reduce XP');
        // 重新整理後仍在
        await page.reload();
        await page.waitForFunction(() => document.getElementById('class-dashboard')?.classList.contains('active'));
        await page.click('.class-card:has(h3:text-is("圖鑑測試班"))');
        await openCollection(page);
        await page.click('.col-owner[data-owner="1"]');
        assert.equal(await page.locator('.col-card[data-item="land-01"].owned').count(), 1);
        await shot(page, 'p4-collection-land');
        // 其他小隊沒有這件收藏（不同組不互相覆蓋）
        await page.click('.col-owner[data-owner="2"]');
        assert.equal(await page.locator('.col-card[data-item="land-01"].owned').count(), 0);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('special items: max 2 tags, disabled tag not selectable, teacher grant, tag delete keeps items; reduced motion', async () => {
    const app = await openApp();
    const { page } = app;
    try {
        await createClass(page, '特殊收藏班', 3);
        await openCollection(page);
        await page.click('.col-world[data-world="special"]');
        await page.click('#sp-add');
        await page.fill('#sp-name', '聖誕帽貓咪');
        await page.selectOption('#sp-base', 'land-01');
        const boxes = page.locator('#sp-edit-modal .sp-tag');
        await boxes.nth(0).check(); await boxes.nth(1).check(); await boxes.nth(2).check();
        await page.click('#sp-ok');                               // 3 個標籤 → alert 被接受，不會儲存
        assert.equal(await page.isVisible('#sp-edit-modal'), true, 'editor stays open on validation error');
        await boxes.nth(2).uncheck();
        await page.click('#sp-ok');
        await page.waitForSelector('.col-card.special:has(.col-name:text-is("聖誕帽貓咪"))');
        // 自訂標籤：新增後刪除（兩次確認自動接受）→ 收藏仍在
        await page.click('#sp-tags');
        await page.fill('#tag-new', '運動會');
        await page.click('#tag-modal .label-row:has(#tag-new) .btn');
        await page.locator('#tag-modal .tag-row:has(input.tag-name-input[value="運動會"]) .btn').click();
        await page.locator('#tag-modal .tag-row:has(input.tag-name-input[value="運動會"])').waitFor({ state: 'detached' });   // 刪除是非同步（兩次確認＋儲存＋重繪）
        // 停用預設標籤「節慶限定」
        await page.locator('#tag-modal .tag-row:has(.tag-name:text-is("節慶限定（預設）")) .tag-active').uncheck();
        await page.click('#tag-ok');
        await page.click('#sp-add');
        assert.equal(await page.locator('#sp-edit-modal .sp-tag[value="tag-festival"]').isDisabled(), true, 'disabled tag cannot be chosen for a new item');
        await page.click('#sp-edit-modal .modal-actions .btn-secondary');
        // 老師頒發特殊收藏
        await page.click('.col-card.special .col-card-hit');
        await page.click('#col-teacher-grant');                   // prompt → 空字串會被要求重填；helpers 預設回答 ''
        assert.equal(await page.locator('.col-card.special.owned').count(), 0);
        app.prompts.push('聖誕節活動');
        await page.click('#col-teacher-grant');
        await page.waitForSelector('#col-celebrate.visible');
        await page.click('#col-celebrate .btn');
        assert.equal(await page.locator('.col-card.special.owned').count(), 1);
        await shot(page, 'p4-special');
        // 減少動態
        await page.click('#motion-btn');
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('reduce-motion')), true);
        await page.click('.col-world[data-world="land"]');
        const dur = await page.evaluate(() => { const a = document.querySelector('.actor-bob'); return a ? getComputedStyle(a).animationDuration : '0s'; });
        assert.ok(['0s', '1e-06s', '0.001ms'].includes(dur) || parseFloat(dur) < 0.01, `animations stopped (${dur})`);
        assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
});

test('art gallery: all 72 original placeholder creatures and 6 habitats render without errors', async () => {
    const { url, browser } = await setup();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1900 } });
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto(url + 'tests/fixtures/backup-v4.json');
        const n = await page.evaluate(async () => {
            document.documentElement.innerHTML = '<body style="margin:0;background:#0b1530"></body>';
            const { CATALOG } = await import('/src/data/catalog.js');
            const { creatureSVG } = await import('/src/art/creatures.js');
            const { sceneSVG } = await import('/src/art/scenes.js');
            const grid = document.createElement('div');
            grid.style.cssText = 'display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:8px;color:#fff;font:12px sans-serif;text-align:center';
            for (const it of CATALOG) { const d = document.createElement('div'); d.append(creatureSVG(it, { size: 96 })); const p = document.createElement('div'); p.textContent = it.name; d.append(p); grid.append(d); }
            document.body.append(grid);
            const scenes = document.createElement('div');
            scenes.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px';
            for (const w of ['land', 'ocean', 'sky', 'tech', 'prehistoric', 'fantasy']) { const { svg } = sceneSVG(w, { decorLevel: 6 }); svg.style.width = '100%'; svg.style.height = 'auto'; scenes.append(svg); }
            document.body.append(scenes);
            return document.querySelectorAll('svg.creature').length;
        });
        assert.equal(n, 72);
        await page.screenshot({ path: 'test-results/p4-art-gallery.png', fullPage: true });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});
