// E2E 共用：啟動靜態伺服器 + 系統瀏覽器（playwright-core，不下載瀏覽器）
// 本機 Windows 預設 Edge；CI（ubuntu）預設 Chrome。可用 E2E_CHANNEL 覆寫（chrome / msedge / chromium）。
import { chromium, firefox, webkit } from 'playwright-core';
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../scripts/serve.mjs';
import { createTestKeys, fakeGisScript, subOfAccessToken, TEST_CLIENT_ID, TEACHER_A } from '../tests/helpers/fake-google.mjs';
export { TEST_CLIENT_ID, TEACHER_A };
export { TEACHER_B, OTHER_CLIENT_ID } from '../tests/helpers/fake-google.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'test-results');
mkdirSync(OUT, { recursive: true });
export const fixturePath = (name) => join(ROOT, 'tests', 'fixtures', name);
export const fixture = (name) => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

const channel = process.env.E2E_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome');
/** E2E_BROWSER=firefox|webkit：用 playwright 官方建置的 Firefox / WebKit（CI 相容性工作會先安裝） */
export const ENGINE = process.env.E2E_BROWSER || 'chromium';
/**
 * E2E_DIAG=1（CI 的 Firefox/WebKit 工作開啟）：蒐集失敗證據，不改變任何斷言。
 * - 瀏覽器程序自己的 stderr（崩潰訊息）→ test-results/diag-browser-<engine>.log
 * - 每個 context 的 trace（含快照）→ test-results/trace-<engine>-<n>.zip
 * - 每則主控台訊息、頁面錯誤、導覽、崩潰的時間線 → test-results/diag-<engine>.log
 * - 頁面內的 error / unhandledrejection（含 stack）：用來分辨「App 的 JS 丟出」與「瀏覽器內部訊息」
 */
const DIAG = process.env.E2E_DIAG === '1';
const DIAG_LOG = join(OUT, `diag-${ENGINE}.log`);
const diag = (line) => { if (DIAG) appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}
`); };
let diagSeq = 0;

let shared = null;
/** 一個測試檔共用一個瀏覽器與伺服器；每個測試用全新 context（全新 IndexedDB） */
export const setup = async () => {
    if (shared) return shared;
    const { server, url } = await startServer(0);
    const headless = process.env.E2E_HEADED !== '1';
    const logger = DIAG ? { isEnabled: (name) => name === 'browser', log: (name, sev, msg) => appendFileSync(join(OUT, `diag-browser-${ENGINE}.log`), `${new Date().toISOString()} [${sev}] ${msg}
`) } : undefined;
    const browser = ENGINE === 'firefox' ? await firefox.launch({ headless, logger })
        : ENGINE === 'webkit' ? await webkit.launch({ headless, logger })
            : await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless, logger });
    if (DIAG) browser.on('disconnected', () => diag('BROWSER DISCONNECTED'));
    shared = { server, url, browser, keys: await createTestKeys() };
    return shared;
};
export const teardown = async () => {
    if (!shared) return;
    await shared.browser.close(); shared.server.close(); shared = null;
};

/** 假 Google：GIS 程式庫、JWKS、userinfo（每個 context 都要接；外部網路其他一律擋掉） */
export const wireFakeGoogle = async (context) => {
    const { keys } = await setup();
    const revoked = [];   // Google 撤銷端點收到的 token（測試登出／換帳號是否真的撤銷授權）
    await context.route('https://oauth2.googleapis.com/revoke', async (r) => {
        revoked.push(decodeURIComponent(String(r.request().postData() || '').replace(/^token=/, '')));
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await context.route('https://accounts.google.com/gsi/client', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fakeGisScript(keys) }));
    await context.route('https://www.googleapis.com/oauth2/v3/certs', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(keys.jwks) }));
    await context.route('https://openidconnect.googleapis.com/v1/userinfo', async (r) => {
        const sub = subOfAccessToken(((await r.request().allHeaders()).authorization || '').replace(/^Bearer\s+/, ''));
        await r.fulfill(sub ? { status: 200, contentType: 'application/json', body: JSON.stringify({ sub }) } : { status: 401, body: '{}' });
    });
    return { revoked };
};
/** Google 試算表 API → 模擬器（網路層） */
export const wireSheets = async (context, emu) => {
    await context.route('https://sheets.googleapis.com/**', async (r) => {
        const req = r.request();
        let res;
        try { res = emu.handle(req.method(), req.url(), req.postData() ? JSON.parse(req.postData()) : undefined, await req.allHeaders()); }
        catch { await r.abort('failed'); return; }
        await r.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
};

/** 在登入畫面按（假）Google 登入按鈕。mode='ok' 時等到進入主畫面 */
export const signIn = async (page, account = TEACHER_A, mode = 'ok') => {
    await page.waitForSelector('#fake-gsi-btn', { timeout: 10000 });
    await page.evaluate(([a, m]) => { Object.assign(window.__fakeGoogle, { account: a, mode: m }); }, [account, mode]);
    await page.click('#fake-gsi-btn');
    if (mode === 'ok') await page.waitForSelector('#add-class-card', { timeout: 10000 });
};

/** 重新整理後一定回到登入畫面（方案 A）；再用同一個帳號登入 */
export const reloadAndSignIn = async (page, account = TEACHER_A) => {
    await page.reload();
    await page.waitForSelector('#auth-gate', { state: 'visible' });
    await signIn(page, account);
};

/**
 * 開新頁面：自動接受 confirm/alert，回答 prompt（依佇列），收集 console error / pageerror。
 * opts.viewport、opts.reducedMotion、opts.query、opts.emu（Sheets 模擬器）
 * opts.signIn（預設 true：以合成老師帳號登入）、opts.account、opts.clientId（null = 不預設 Client ID）
 */
export const openApp = async (opts = {}) => {
    const { url, browser } = await setup();
    const context = await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 800 },
        reducedMotion: opts.reducedMotion || 'no-preference', locale: 'zh-TW', timezoneId: 'Asia/Taipei', ...(opts.context || {}) });
    // 外部網路一律擋掉（字型等）；Google 相關端點由假 Google／模擬器回應
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    const { revoked } = await wireFakeGoogle(context);
    if (opts.emu) await wireSheets(context, opts.emu);
    const clientId = opts.clientId === undefined ? TEST_CLIENT_ID : opts.clientId;
    if (clientId) await context.addInitScript((cid) => { try { if (!localStorage.getItem('fhes_google_client_id')) localStorage.setItem('fhes_google_client_id', cid); } catch { /* ignore */ } }, clientId);
    const seq = ++diagSeq;
    if (DIAG) {
        await context.tracing.start({ screenshots: true, snapshots: true });
        // 頁面自己的 JS 丟出的錯誤一定會經過這兩個事件；主控台錯誤若沒有對應的這兩個事件，代表不是 App 的程式碼丟出
        await context.addInitScript(() => {
            const out = (kind, e) => console.debug(`[diag-page] ${kind}: ${e?.name || ''} ${e?.message || e} | stack=${(e?.stack || '').replace(/\s+/g, ' ').slice(0, 600)}`);
            addEventListener('error', ev => out('error', ev.error || ev.message));
            addEventListener('unhandledrejection', ev => out('unhandledrejection', ev.reason));
        });
    }
    const page = await context.newPage();
    if (DIAG) {
        diag(`--- context #${seq} opened (${ENGINE})`);
        page.on('framenavigated', f => { if (f === page.mainFrame()) diag(`#${seq} navigated ${f.url().replace(/^https?:\/\/[^/]+/, '')}`); });
        page.on('console', m => diag(`#${seq} console.${m.type()} ${JSON.stringify(m.text()).slice(0, 800)} loc=${JSON.stringify(m.location())}`));
        page.on('pageerror', e => diag(`#${seq} pageerror ${e.name}: ${e.message} stack=${JSON.stringify((e.stack || '').slice(0, 600))}`));
        page.on('crash', () => diag(`#${seq} PAGE CRASH url=${page.url()}`));
        page.on('close', () => diag(`#${seq} page closed`));
        page.on('requestfailed', r => diag(`#${seq} requestfailed ${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    }
    const errors = [];
    const prompts = [];
    const consoleAll = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    // 測試刻意擋掉外部網路（字型）；各瀏覽器的訊息不同：Chromium「net::ERR_FAILED / Failed to load resource」、Firefox「Cross-Origin Request Blocked … fonts.googleapis.com」
    page.on('console', m => { consoleAll.push(m.text()); if (m.type() === 'error' && !/ERR_FAILED|net::|Failed to load resource|Cross-Origin Request Blocked.*fonts\.googleapis\.com/.test(m.text())) errors.push(`console: ${m.text()} @ ${m.location()?.url?.replace(/^.*\//, '') || '?'}:${m.location()?.lineNumber ?? '?'}`); });
    page.on('crash', () => errors.push('page crashed (browser renderer crash)'));
    const dialogs = [];
    page.on('dialog', async d => {
        dialogs.push(d.message());
        if (d.type() === 'prompt') { const v = prompts.shift(); if (v === null) await d.dismiss(); else await d.accept(v ?? ''); }
        else await d.accept();
    });
    await page.goto(url + (opts.query || ''));
    if (opts.signIn !== false) {
        // 等到 App 真的跑起來（「新增班級」卡片由模組腳本產生）；腳本壞掉時立即失敗並附上錯誤
        try { await signIn(page, opts.account || TEACHER_A); }
        catch { throw new Error(`App did not start: ${errors.join(' | ') || 'no page error captured'}`); }
    } else await page.waitForSelector('#auth-gate', { timeout: 10000 });
    const close = async () => {
        if (DIAG) {
            diag(`#${seq} closing; collected errors=${JSON.stringify(errors)}`);
            await context.tracing.stop({ path: join(OUT, `trace-${ENGINE}-${seq}.zip`) }).catch(e => diag(`#${seq} trace stop failed: ${e.message}`));
        }
        await context.close();
    };
    return { page, context, errors, prompts, consoleAll, dialogs, url, revoked, close };
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

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** 頁面水平溢出：回傳超出視窗寬度的可見元素（最多 5 個） */
export const overflow = (page) => page.evaluate(() => {
    const W = document.documentElement.clientWidth; const out = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`document ${document.documentElement.scrollWidth}>${W}`);
    for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).visibility === 'hidden') continue;
        if (el.closest('.table-wrap, .hw-matrix-wrap, .modal:not(.visible), #fx-layer, #confetti-container, canvas, .col-scene, svg')) continue;
        // 固定定位的提示（徽章 toast、通知）平常停在畫面外等待滑入，不會造成頁面捲動
        let fixed = false; for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).position === 'fixed' && !a.classList.contains('modal')) { fixed = true; break; }
        if (fixed) continue;
        if (r.right > W + 1) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')} right=${Math.round(r.right)}`);
        if (out.length >= 5) break;
    }
    return out;
});
export const axe = async (page, include) => {
    await page.addScriptTag({ content: AXE });
    return page.evaluate(async (inc) => {
        const r = await window.axe.run(inc ? { include: [inc] } : document, { resultTypes: ['violations'], rules: { 'color-contrast': { enabled: true } } });
        return r.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(' '), detail: v.nodes[0]?.any?.[0]?.message || '' }));
    }, include || null);
};

