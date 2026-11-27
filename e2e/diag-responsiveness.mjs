// BUG-032 診斷（不是測試門檻，只蒐集證據；CI 的 WebKit 工作單獨執行、結果不影響 45 項 E2E 的判定）。
// 假設：CI 的 Linux WebKit 沒有 GPU（軟體繪圖），全螢幕星空動畫每一格重畫、上面又疊了多層 backdrop-filter 模糊，
// 網頁程序忙到沒有回應 → 一段時間後被瀏覽器關掉（測試看到 "Target page, context or browser has been closed"）。
// 做法：同一個瀏覽器、同樣的操作，分別在「一般」與「減少動態效果」下量：
//   - 網頁主執行緒回應時間（Node 端 page.evaluate 往返）
//   - 每秒畫面數（requestAnimationFrame）
//   - 開關「雲端同步」視窗（有 backdrop-filter 的 modal）時的延遲
// 每一輪的數字直接印到標準輸出（CI 紀錄看得到）。
import { setup, teardown, openApp, createClass, ENGINE } from './helpers.mjs';

const SECONDS = Number(process.env.DIAG_SECONDS || 30);
const say = (s) => console.log(`[diag ${ENGINE}] ${s}`);

const measure = async (label, reducedMotion) => {
    const app = await openApp({ reducedMotion });
    const { page } = app;
    let closed = false; let crashed = false;
    page.on('close', () => { closed = true; say(`${label}: PAGE CLOSED`); });
    page.on('crash', () => { crashed = true; say(`${label}: PAGE CRASH`); });
    try {
        await createClass(page, '診斷班', 20);
        await page.click('#back-to-dashboard-btn');
        await page.evaluate(() => { window.__frames = 0; const tick = () => { window.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
        const lat = []; let timeouts = 0; let lastFrames = 0; const fps = [];
        const end = Date.now() + SECONDS * 1000; let i = 0;
        while (Date.now() < end && !closed && !crashed) {
            const t0 = Date.now();
            const r = await Promise.race([page.evaluate(() => window.__frames).then(f => ({ f })), new Promise(ok => setTimeout(() => ok(null), 5000))]).catch(e => ({ err: e.message }));
            const ms = Date.now() - t0;
            if (!r) { timeouts++; say(`${label}: no answer within 5 s at ${i}`); continue; }
            if (r.err) { say(`${label}: evaluate failed: ${r.err}`); break; }
            lat.push(ms);
            if (i % 2 === 1) { fps.push(r.f - lastFrames); lastFrames = r.f; } else lastFrames = r.f;
            // 每 4 秒開關一次有模糊背景的視窗
            if (i % 8 === 0) {
                const c0 = Date.now();
                try { await page.click('#db-status-badge', { timeout: 10000 }); await page.waitForSelector('#sync-modal.visible', { timeout: 10000 }); await page.keyboard.press('Escape'); say(`${label}: open/close modal ${Date.now() - c0} ms`); }
                catch (e) { say(`${label}: modal step failed after ${Date.now() - c0} ms: ${e.message.split('\n')[0]}`); }
            }
            i++;
            await new Promise(ok => setTimeout(ok, 500));
        }
        const s = [...lat].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null;
        say(`${label}: samples=${lat.length} latency p50=${q(0.5)}ms p95=${q(0.95)}ms max=${s.at(-1) ?? null}ms noAnswer5s=${timeouts} framesPerSecond≈${fps.length ? Math.round(fps.reduce((a, b) => a + b, 0) / fps.length) : 'n/a'} closed=${closed} crashed=${crashed}`);
    } finally { await app.close().catch(() => {}); }
};

try {
    await setup();
    for (let round = 1; round <= Number(process.env.DIAG_ROUNDS || 2); round++) {
        await measure(`round ${round} normal`, 'no-preference');
        await measure(`round ${round} reduced-motion`, 'reduce');
    }
} finally { await teardown(); }
