// E2E 共用：啟動靜態伺服器 + 系統瀏覽器（playwright-core，不下載瀏覽器）
// 本機 Windows 預設 Edge；CI（ubuntu）預設 Chrome。可用 E2E_CHANNEL 覆寫（chrome / msedge / chromium）。
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'test-results');
mkdirSync(OUT, { recursive: true });
export const fixturePath = (name) => join(ROOT, 'tests', 'fixtures', name);
export const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

const channel = process.env.E2E_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome');

let shared = null;
/** 一個測試檔共用一個瀏覽器與伺服器；每個測試用全新 context（全新 IndexedDB） */
export const setup = async () => {
    if (shared) return shared;
    const { server, url } = await startServer(0);
    const browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: process.env.E2E_HEADED !== '1' });
    shared = { server, url, browser };
    return shared;
};
export const teardown = async () => {
    if (!shared) return;
    await shared.browser.close(); shared.server.close(); shared = null;
};

/**
 * 開新頁面：自動接受 confirm/alert，回答 prompt（依佇列），收集 console error / pageerror。
 * opts.viewport、opts.reducedMotion、opts.query
 */
export const openApp = async (opts = {}) => {
    const { url, browser } = await setup();
    const context = await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 800 },
        reducedMotion: opts.reducedMotion || 'no-preference', locale: 'zh-TW', timezoneId: 'Asia/Taipei', ...(opts.context || {}) });
    // 字型來自 Google Fonts；測試環境擋掉外部網路，避免不穩定（字型缺少不影響功能）
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const page = await context.newPage();
    const errors = [];
    const prompts = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    page.on('dialog', async d => {
        if (d.type() === 'prompt') { const v = prompts.shift(); if (v === null) await d.dismiss(); else await d.accept(v ?? ''); }
        else await d.accept();
    });
    await page.goto(url + (opts.query || ''));
    // 等到 App 真的跑起來（「新增班級」卡片由模組腳本產生）；腳本壞掉時立即失敗並附上錯誤
    try { await page.waitForSelector('#add-class-card', { timeout: 10000 }); }
    catch { throw new Error(`App did not start: ${errors.join(' | ') || 'no page error captured'}`); }
    return { page, context, errors, prompts, close: () => context.close() };
};

export const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });

/** 建立班級並進入 */
export const createClass = async (page, name = '測試班', size = 4) => {
    await page.click('#add-class-card');
    await page.fill('#new-class-name', name);
    await page.fill('#new-class-size', String(size));
    await page.click('#confirm-add-class');
    await page.click(`.class-card:has(h3:text-is("${name}"))`);
    await page.waitForSelector('#student-grid .student-card');
};

export const cardOf = (page, seat) => page.locator('#student-grid .student-card').filter({ has: page.locator(`.student-seat:text-is("${seat}")`) });
export const cardVal = async (page, seat, which) => Number(await cardOf(page, seat).locator(`.${which}-num .val`).textContent());
/** 等到卡片數字變成預期值（點擊後的寫入是非同步的），逾時則回傳當下的值讓 assert 顯示差異 */
export const waitVal = async (page, seat, which, want, timeout = 4000) => {
    const end = Date.now() + timeout;
    let v;
    while (Date.now() < end) { v = await cardVal(page, seat, which); if (v === want) return v; await page.waitForTimeout(50); }
    return v;
};

/** 匯入 fixture（整包取代） */
export const importFile = async (page, path, mode = 'all') => {
    await page.setInputFiles('#file-input', path);
    await page.waitForSelector('#import-modal.visible');
    await page.check(`input[name="import-mode"][value="${mode}"]`);
    await page.click('#import-ok');
    await page.waitForSelector('#import-modal', { state: 'hidden' });
    await page.waitForFunction(() => document.getElementById('class-dashboard')?.classList.contains('active'));
};

/** BUG-007 回歸：畫面上不可出現由 null 轉成的 "null" 文字節點 */
export const strayNullTexts = (page) => page.evaluate(() => {
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.nodeValue.trim() === 'null') out.push(w.currentNode.parentElement?.closest('[id]')?.id || w.currentNode.parentElement?.tagName);
    return out;
});
