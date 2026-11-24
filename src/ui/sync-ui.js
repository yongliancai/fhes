// 雲端同步 UI：Google 帳號連線、試算表建立／指定、狀態、排程與重試、衝突處理。
// 取代 v5 的 Firebase 設定畫面。舊的 Firebase 遠端資料不會被讀取、修改或刪除。
import { h, makeModal, fill } from './dom.js';
import { entityHash } from '../core/ids.js';
import { createSyncEngine, backoffMs, asSyncError, diffKeys } from '../sync/engine.js';
import { createSheetsAdapter, createSpreadsheet, parseSpreadsheetId } from '../sync/sheets-adapter.js';
import { createGoogleAuth, isValidClientId } from '../sync/google-auth.js';
import { SYNC_TABLES } from '../sync/schema.js';

const TABLE_LABEL = { classes: '班級', students: '學生', events: '加扣分紀錄', dailySnapshots: '每日結算', hwAssignments: '作業', hwEvents: '作業紀錄', xpEvents: 'XP', specialItems: '特殊收藏', grants: '收藏', settings: '設定', syncMeta: '裝置' };
const LEGACY_FB_KEY = 'classroomPowerhouse_fbConfig';

/**
 * app：{ S, S_KEY, dbWrite, dbGetAll, dbDelete, setMeta, notify, appVersion, deviceId, onRemoteChange, localDateTime, $ }
 */
export const initSyncUI = (app) => {
    const { S } = app;
    const cfg = () => S.meta.sync || {};
    const saveCfg = (patch) => app.setMeta('sync', { ...cfg(), ...patch });
    let auth = null; let engine = null;
    let syncState = new Map();
    let timer = null; let running = false; let again = false; let attempt = 0;
    /** 老師對衝突的選擇先排隊：若剛好有背景同步在跑，下一輪一定會套用（BUG-005） */
    const queuedResolutions = new Map();
    let status = { kind: 'local', text: '僅存本機', pending: 0 };

    // ------------------------------------------------------------ 本機資料存取（IndexedDB + 記憶體 S）
    const SPECIAL = {
        settings: {
            list: () => [{ id: 'lastSettledDate', value: S.meta.lastSettledDate || {} }],
            put: async (e) => { if (e.id === 'lastSettledDate') await app.setMeta('lastSettledDate', e.value || {}); },
            del: async () => {},
        },
        syncMeta: {
            list: () => [{ id: app.deviceId(), lastSyncAt: S.meta.lastSyncAt || 0, appVersion: app.appVersion }, ...Object.values(S.meta.syncPeers || {})],
            put: async (e) => { if (e.id !== app.deviceId()) await app.setMeta('syncPeers', { ...(S.meta.syncPeers || {}), [e.id]: e }); },
            del: async (id) => { const p = { ...(S.meta.syncPeers || {}) }; delete p[id]; await app.setMeta('syncPeers', p); },
        },
    };
    const local = {
        list: async (table) => SPECIAL[table] ? SPECIAL[table].list() : (S[app.S_KEY(table)] || []),
        apply: async (table, puts, dels, expected) => {
            const cur = new Map((await local.list(table)).map(e => [String(e.id), e]));
            const same = (id) => (cur.has(id) ? entityHash(cur.get(id)) : null) === (expected.get(id) ?? null);
            const okPuts = puts.filter(e => !expected.has(String(e.id)) || same(String(e.id)));
            const okDels = dels.filter(id => !expected.has(String(id)) || same(String(id)));
            const skipped = [...puts.filter(e => !okPuts.includes(e)).map(e => String(e.id)), ...dels.filter(id => !okDels.includes(id)).map(String)];
            if (SPECIAL[table]) { for (const e of okPuts) await SPECIAL[table].put(e); for (const id of okDels) await SPECIAL[table].del(id); }
            else {
                const k = app.S_KEY(table);
                const putIds = new Set(okPuts.map(e => String(e.id))); const delIds = new Set(okDels.map(String));
                S[k] = S[k].filter(x => !putIds.has(String(x.id)) && !delIds.has(String(x.id))).concat(okPuts);
                await app.dbWrite(okPuts.length ? { [table]: okPuts } : {}, okDels.length ? { [table]: okDels } : {});
            }
            return { applied: okPuts.length + okDels.length, skipped };
        },
        getState: async () => new Map(syncState),
        setState: async (entries) => {
            const puts = []; const dels = [];
            for (const [k, v] of entries) { if (v == null) { syncState.delete(k); dels.push(k); } else { syncState.set(k, v); puts.push({ key: k, ...v }); } }
            await app.dbWrite(puts.length ? { syncState: puts } : {}, dels.length ? { syncState: dels } : {});
        },
        getConflicts: async () => S.meta.syncConflicts || [],
        setConflicts: async (list) => app.setMeta('syncConflicts', list),
    };

    const loadSyncState = async () => { syncState = new Map((await app.dbGetAll('syncState')).map(({ key, ...v }) => [key, v])); };

    // ------------------------------------------------------------ 狀態徽章
    const setStatus = (kind, text) => {
        status = { ...status, kind, text };
        const dotCls = 'db-dot' + ({ ok: ' connected', syncing: ' syncing', error: ' error', warn: ' error', pending: ' syncing' }[kind] || '');
        // 總覽與班級畫面各有一個狀態徽章（老師在班級畫面也要看得到「需要重新連線」）
        for (const [d, t, b] of [['db-dot', 'db-status-text', 'db-status-badge'], ['class-sync-dot', 'class-sync-text', 'class-sync-badge']]) {
            if (app.$(d)) app.$(d).className = dotCls;
            if (app.$(t)) app.$(t).textContent = text;
            if (app.$(b)) app.$(b).dataset.state = kind;
        }
        if (modal.el.classList.contains('visible')) renderModal();
    };
    const refreshIdle = async () => {
        const c = cfg();
        const pend = engine ? await engine.pending() : 0;
        status.pending = pend;
        const conflicts = (S.meta.syncConflicts || []).length;
        if (!c.spreadsheetId) return setStatus('local', '僅存本機');
        if (conflicts) return setStatus('warn', `⚠ 同步衝突 ${conflicts} 筆`);
        if (!auth?.isConnected()) return setStatus('warn', pend ? `需要重新連線（${pend} 筆待同步）` : '需要重新連線 Google');
        if (!navigator.onLine) return setStatus('pending', `離線中（${pend} 筆待同步）`);
        if (pend) return setStatus('pending', `${pend} 筆待同步`);
        setStatus('ok', c.lastSyncAt ? `已同步 ${app.localDateTime(c.lastSyncAt).slice(11)}` : '已連線');
    };

    // ------------------------------------------------------------ 同步執行與排程
    const buildEngine = () => {
        const c = cfg();
        if (!c.spreadsheetId || !auth) { engine = null; return; }
        const remote = createSheetsAdapter({ spreadsheetId: c.spreadsheetId, getToken: () => auth.getToken() });
        engine = createSyncEngine({ local, remote, deviceId: app.deviceId(), tables: SYNC_TABLES });
    };
    const runSync = async ({ resolutions = [], manual = false } = {}) => {
        resolutions.forEach(r => queuedResolutions.set(r.key, r.use));
        if (!engine) { if (manual) openModal(); return null; }
        if (running) { again = true; return null; }
        if (!auth.isConnected()) { await refreshIdle(); if (manual) openModal(); return null; }
        if (!navigator.onLine) { await refreshIdle(); return null; }
        running = true; clearTimeout(timer);
        setStatus('syncing', '同步中…');
        const taken = [...queuedResolutions].map(([key, use]) => ({ key, use }));
        queuedResolutions.clear();
        try {
            await app.setMeta('lastSyncAt', Date.now());
            const r = await engine.sync({ resolutions: taken });
            attempt = 0;
            await saveCfg({ lastSyncAt: r.at, lastError: null, lastStats: r });
            if (r.pulled) app.onRemoteChange();
            if (manual) app.notify(`同步完成：上傳 ${r.pushed}、下載 ${r.pulled}${r.conflicts ? `、衝突 ${r.conflicts}` : ''}${r.raced ? `、${r.raced} 筆稍後重試` : ''}`, 3500);
            if (r.badRows || r.duplicates) app.notify(`試算表中有 ${r.badRows} 列無法讀取、${r.duplicates} 列重複，已略過（請勿手動修改 A–G 欄）`, 6000);
            if (r.raced) schedule(3000);
            return r;
        } catch (err) {
            taken.forEach(r => { if (!queuedResolutions.has(r.key)) queuedResolutions.set(r.key, r.use); });   // 失敗就放回去，下次再套用
            const e = asSyncError(err);
            await saveCfg({ lastError: { kind: e.kind, message: e.message, at: Date.now() } });
            if (e.kind === 'auth') auth.invalidate();
            if (e.retryable) { const wait = backoffMs(attempt++); timer = setTimeout(() => runSync(), wait); setStatus('pending', `${e.message}（${Math.round(wait / 1000)} 秒後重試）`); }
            else setStatus('error', e.message);
            if (manual) app.notify(e.message, 5000);
            return null;
        } finally {
            running = false;
            if (!timer || attempt === 0) await refreshIdle().catch(() => {});
            if (again) { again = false; schedule(500); }
        }
    };
    const schedule = (delay = 4000) => {
        if (!cfg().spreadsheetId) { refreshIdle(); return; }
        clearTimeout(timer);
        timer = setTimeout(() => runSync(), delay);
        refreshIdle();
    };
    window.addEventListener('online', () => schedule(500));
    window.addEventListener('offline', () => refreshIdle());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(1500); });

    // ------------------------------------------------------------ 連線與試算表
    const connect = async () => {
        const clientId = (app.$('sync-client-id')?.value ?? cfg().clientId ?? '').trim();
        if (!isValidClientId(clientId)) { alert('請先填入正確的 OAuth Client ID（格式：數字-英數.apps.googleusercontent.com）。設定方式見說明文件。'); return; }
        if (clientId !== cfg().clientId) await saveCfg({ clientId });
        auth = createGoogleAuth({ clientId });
        try {
            setStatus('syncing', '等待 Google 授權…');
            await auth.connect({ prompt: cfg().consented ? '' : 'consent' });
            await saveCfg({ consented: true });
            buildEngine();
            app.notify('已連接 Google 帳號');
            if (cfg().spreadsheetId) await runSync({ manual: true });
        } catch (err) { const e = asSyncError(err); await saveCfg({ lastError: { kind: e.kind, message: e.message, at: Date.now() } }); setStatus('error', e.message); alert(e.message); }
        renderModal(); refreshIdle();
    };
    const createSheet = async () => {
        if (!auth?.isConnected()) { alert('請先連接 Google 帳號。'); return; }
        try {
            setStatus('syncing', '建立試算表…');
            const id = await createSpreadsheet({ title: `班級經營動力站 雲端紀錄（${app.localDateTime(Date.now()).slice(0, 10)}）`, getToken: () => auth.getToken() });
            await saveCfg({ spreadsheetId: id });
            syncState.clear(); await app.dbWrite({}, {}, ['syncState']);
            buildEngine();
            await runSync({ manual: true });
        } catch (err) { const e = asSyncError(err); setStatus('error', e.message); alert(e.message); }
        renderModal();
    };
    const useSheet = async () => {
        const id = parseSpreadsheetId(app.$('sync-sheet-id')?.value);
        if (!id) { alert('請貼上 Google 試算表的網址或 ID。'); return; }
        if (cfg().spreadsheetId && cfg().spreadsheetId !== id && !confirm('改用另一份試算表？\n本機資料不會刪除，會與新試算表合併；有不同的地方會列為衝突讓你決定。')) return;
        await saveCfg({ spreadsheetId: id });
        syncState.clear(); await app.dbWrite({}, {}, ['syncState']);
        buildEngine();
        if (auth?.isConnected()) await runSync({ manual: true });
        renderModal();
    };
    const disconnect = async () => {
        if (!confirm('中斷雲端同步？\n本機資料與 Google 試算表的內容都會保留，只是不再同步。')) return;
        clearTimeout(timer);
        await auth?.disconnect().catch(() => {});
        auth = null; engine = null;
        await saveCfg({ spreadsheetId: null, lastSyncAt: null, lastError: null });
        syncState.clear(); await app.dbWrite({}, {}, ['syncState']);
        await app.setMeta('syncConflicts', []);
        renderModal(); refreshIdle();
    };
    const resolve = async (key, use) => {
        const r = await runSync({ resolutions: [{ key, use }], manual: true });
        if (r) app.notify(use === 'local' ? '已用本機版本更新雲端' : '已改用雲端版本');
        renderModal();
    };

    // ------------------------------------------------------------ 設定視窗
    const modal = makeModal('sync-modal', { wide: true, label: '雲端同步設定' });
    const openModal = () => { renderModal(); modal.open(); };
    const renderModal = () => {
        const c = cfg();
        const connected = !!auth?.isConnected();
        const conflicts = S.meta.syncConflicts || [];
        const legacy = (() => { try { return !!localStorage.getItem(LEGACY_FB_KEY); } catch { return false; } })();
        const sheetUrl = c.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit` : null;
        fill(modal.card, 
            h('h2', { text: '☁️ 雲端同步（Google 帳號＋Google 試算表）' }),
            h('p', { class: 'setup-note', text: '不設定也能使用，資料存在這台電腦。設定後，資料會同步到「你自己的」Google 試算表，可在多台電腦使用。請先確認符合學校的個人資料規定；試算表預設不分享給任何人。' }),
            legacy ? h('p', { class: 'hw-banner teacher', text: '偵測到舊版 Firebase 設定：v6 已不再連線 Firebase，舊雲端資料不會被讀取或刪除。若需要舊雲端資料，請用 v5.1 版「匯出備份」後，在這裡「載入備份」。' }) : null,
            h('h3', { class: 'hw-sec', text: '1. Google 帳號' }),
            h('div', { class: 'field' }, h('label', { for: 'sync-client-id', text: 'OAuth Client ID（公開識別碼，不是密碼；建立方式見說明文件 GOOGLE-SHEETS-SETUP）' }),
                h('input', { id: 'sync-client-id', type: 'text', value: c.clientId || '', placeholder: '1234567890-xxxx.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false' })),
            h('div', { class: 'modal-actions wrap' },
                h('button', { class: 'btn btn-primary', id: 'sync-connect', text: connected ? '✅ 已連線（重新授權）' : (c.consented ? '🔄 重新連線 Google' : '🔐 連接 Google 帳號'), onclick: connect }),
                c.spreadsheetId || connected ? h('button', { class: 'btn btn-danger', id: 'sync-disconnect', text: '中斷同步', onclick: disconnect }) : null),
            h('h3', { class: 'hw-sec', text: '2. 試算表' }),
            c.spreadsheetId ? h('p', {}, '目前：', h('a', { href: sheetUrl, target: '_blank', rel: 'noopener', id: 'sync-sheet-link', text: '開啟 Google 試算表 ↗' }), h('span', { class: 'muted', text: `（${c.spreadsheetId.slice(0, 8)}…）` })) : h('p', { class: 'muted', text: '尚未指定。第一台電腦請按「建立新的試算表」；其他電腦請貼上同一份試算表的網址。' }),
            h('div', { class: 'modal-actions wrap' },
                h('button', { class: 'btn btn-success', id: 'sync-create', disabled: connected ? null : true, text: '＋ 建立新的試算表', onclick: createSheet }),
                h('input', { id: 'sync-sheet-id', type: 'text', placeholder: '或貼上試算表網址／ID', style: 'flex:2 1 220px' }),
                h('button', { class: 'btn btn-secondary', id: 'sync-use', text: '使用這份', onclick: useSheet })),
            h('h3', { class: 'hw-sec', text: '3. 狀態' }),
            h('ul', { class: 'sync-status' },
                h('li', { text: `狀態：${status.text}` }),
                h('li', { text: `待同步：${status.pending} 筆（存在本機，不會遺失）` }),
                h('li', { text: `上次同步：${c.lastSyncAt ? app.localDateTime(c.lastSyncAt) : '—'}` }),
                c.lastError ? h('li', { class: 'warn', text: `上次錯誤：${c.lastError.message}（${app.localDateTime(c.lastError.at)}）` }) : null,
                c.lastStats ? h('li', { class: 'muted', text: `上次結果：上傳 ${c.lastStats.pushed}、下載 ${c.lastStats.pulled}、衝突 ${c.lastStats.conflicts}` }) : null),
            h('div', { class: 'modal-actions wrap' }, h('button', { class: 'btn btn-primary', id: 'sync-now', disabled: engine && connected ? null : true, text: '🔄 立即同步', onclick: () => runSync({ manual: true }) })),
            conflicts.length ? h('h3', { class: 'hw-sec warn', text: `⚠ 衝突 ${conflicts.length} 筆：兩台裝置改了同一筆資料，請選擇要保留哪一個` }) : null,
            conflicts.length ? h('div', { class: 'sync-conflicts' }, conflicts.map(cf => h('div', { class: 'sync-conflict', dataset: { key: cf.key } },
                h('strong', { text: `${TABLE_LABEL[cf.table] || cf.table}：${summary(cf.local || cf.remote)}` }),
                h('span', { class: 'muted', text: `不同的欄位：${diffKeys(cf.local, cf.remote).join('、')}` }),
                h('div', { class: 'sync-cmp' },
                    h('div', {}, h('b', { text: '這台電腦' }), h('pre', { text: preview(cf.local, cf.remote) })),
                    h('div', {}, h('b', { text: `雲端（${cf.remoteDevice || '其他裝置'}）` }), h('pre', { text: preview(cf.remote, cf.local) }))),
                h('div', { class: 'modal-actions wrap' },
                    h('button', { class: 'btn btn-secondary', dataset: { use: 'local' }, text: '用這台電腦的', onclick: () => resolve(cf.key, 'local') }),
                    h('button', { class: 'btn btn-secondary', dataset: { use: 'remote' }, text: '用雲端的', onclick: () => resolve(cf.key, 'remote') }))))) : null,
            h('details', { class: 'hw-hist' }, h('summary', { text: '同步怎麼運作？' }),
                h('ul', {}, ['每次修改先存在這台電腦，再自動同步（離線也能用）。', '只會新增或更新有變動的那幾列，不會整張表覆蓋。', '兩台電腦改到同一筆資料時，不會自動蓋掉，會在這裡讓你選。',
                    'Google 授權約 1 小時過期，過期時請按「重新連線」；這段時間的修改都會保留。', '請不要手動修改試算表的 A–G 欄（同步用）；H 欄之後是給你閱讀的。'].map(t => h('li', { text: t })))),
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => modal.close() })));
    };
    const summary = (e) => !e ? '（已刪除）' : e.name ? `${e.seat ? `${e.seat}號 ` : ''}${e.name}` : e.reason ? `${e.date || ''} ${e.reason}` : e.title || e.id;
    const preview = (a, b) => { if (!a) return '（已刪除）'; const keys = diffKeys(a, b).filter(k => !k.startsWith('（')); return keys.map(k => `${k}: ${JSON.stringify(a[k])}`).join('\n') || '（相同）'; };

    app.$('db-status-badge')?.addEventListener('click', openModal);
    app.$('class-sync-badge')?.addEventListener('click', openModal);
    app.$('reload-cloud-btn')?.addEventListener('click', () => runSync({ manual: true }));

    return {
        async init() {
            await loadSyncState();
            const c = cfg();
            if (c.clientId && c.spreadsheetId) { auth = createGoogleAuth({ clientId: c.clientId }); buildEngine(); }
            await refreshIdle();
        },
        schedule, runSync, openModal, status: () => status,
    };
};
