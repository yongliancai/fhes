// 舊資料轉移（ADR-012）：登入功能上線前，資料存在未分帳號的 IndexedDB「classroomPowerhouseV5」
// （v5.1 或早期 v6），或更早 v4 的 localStorage 快取。這些資料不屬於任何 Google 帳號。
// 流程：偵測 → 橫幅提示 → 預覽（班名與筆數）→ 老師逐班勾選 → 先下載舊資料完整備份 → 複製到「目前登入帳號」
//       → 可「復原這次匯入」。舊資料原封不動，只有老師另外按「從這台電腦移除舊資料」（兩次確認＋先下載備份）才刪除。
import { h, makeModal, fill } from './dom.js';
import { legacySummary, planLegacyImport, planUndoImport, hasLegacyContent } from '../core/legacy.js';
import { BACKUP_TABLES, isV4Data } from '../core/backup.js';

export const LEGACY_DB = 'classroomPowerhouseV5';
export const LEGACY_V4_KEY = 'classroomPowerhouse_cache_v4';
const S_KEY = (t) => t === 'dailySnapshots' ? 'snapshots' : t;

/** 不建立資料庫的情況下讀取舊資料庫；不存在時回傳 null */
export const readLegacyDb = async () => {
    if (indexedDB.databases) {
        try { const list = await indexedDB.databases(); if (!list.some(d => d.name === LEGACY_DB)) return null; } catch { /* 有些瀏覽器不支援，改用下面的方法 */ }
    }
    const db = await new Promise((ok) => {
        let created = false;
        const r = indexedDB.open(LEGACY_DB);
        r.onupgradeneeded = (ev) => { if (ev.oldVersion === 0) { created = true; r.transaction.abort(); } };
        r.onsuccess = () => ok(created ? (r.result.close(), null) : r.result);
        r.onerror = () => ok(null);
    });
    if (!db) return null;
    try {
        const names = [...db.objectStoreNames];
        const out = { meta: {} };
        for (const t of BACKUP_TABLES) out[t] = names.includes(t) ? await getAll(db, t) : [];
        if (names.includes('meta')) out.meta = Object.fromEntries((await getAll(db, 'meta')).map(m => [m.key, m.value]));
        out.version = db.version;
        return out;
    } finally { db.close(); }
};
const getAll = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

/** v4 localStorage 快取（只有從未開過 v5 的電腦才會有） */
export const readLegacyV4 = (convertV4) => {
    let raw; try { raw = localStorage.getItem(LEGACY_V4_KEY); } catch { return null; }
    if (!raw) return null;
    try { const arr = JSON.parse(raw); return isV4Data(arr) && arr.length ? { raw, payload: { ...Object.fromEntries(BACKUP_TABLES.map(t => [t, []])), ...convertV4(arr), meta: {} } } : null; }
    catch { return null; }
};

/**
 * app：{ S, $, dbWrite, setMeta, notify, downloadFile, stampForFile, buildBackupOf(payload), exportAccountBackup(), convertV4, refresh(), afterDataChange() }
 */
export const initLegacyUI = (app) => {
    const { S, $ } = app;
    let source = null;      // { kind: 'db'|'v4', payload, raw? }
    const modal = makeModal('legacy-modal', { wide: true, label: '舊資料轉移' });

    const detect = async () => {
        const db = await readLegacyDb().catch(() => null);
        if (db && hasLegacyContent(db)) source = { kind: 'db', payload: db };
        else { const v4 = readLegacyV4(app.convertV4); source = v4 && hasLegacyContent(v4.payload) ? { kind: 'v4', ...v4 } : null; }
        renderBanner();
        return source;
    };

    const renderBanner = () => {
        const slot = $('legacy-banner'); if (!slot) return;
        const imp = S.meta.legacyImport;
        if (!source && !imp) { fill(slot); slot.hidden = true; return; }
        if (source && S.meta.legacyDismissed && !imp) { fill(slot); slot.hidden = true; return; }
        slot.hidden = false;
        const n = source ? legacySummary(source.payload).length : 0;
        fill(slot,
            h('span', { text: imp ? `已從這台電腦的舊資料匯入 ${imp.classIds.length} 個班級到此帳號。` : `這台電腦有 ${n} 個「登入功能上線前」的舊班級資料，尚未歸屬任何帳號。` }),
            h('button', { class: 'btn btn-secondary mini', id: 'legacy-open', text: imp ? '查看／復原' : '預覽並選擇是否匯入', onclick: open }));
    };

    const open = () => { render(); modal.open(); };
    const render = () => {
        const imp = S.meta.legacyImport;
        const rows = source ? legacySummary(source.payload) : [];
        const have = new Set(S.classes.filter(c => !c.deleted).map(c => String(c.id)));
        fill(modal.card,
            h('h2', { text: '📦 這台電腦上的舊資料' }),
            h('p', { class: 'setup-note', text: '登入功能上線前，班級資料存在這台電腦的瀏覽器，不屬於任何 Google 帳號。系統不會自動把它們給任何帳號；請確認是你的班級後，再勾選匯入到「目前登入的帳號」。' }),
            h('ol', { class: 'muted' }, ['匯入前會先下載一份舊資料的完整備份。', '匯入是「複製」：舊資料仍保留在這台電腦，其他帳號登入時仍會看到這個提示。', '帳號裡已經有的同一個班級不會被覆蓋（會略過）。', '匯入後可以按「復原這次匯入」。'].map(t => h('li', { text: t }))),
            source ? h('fieldset', { class: 'legacy-list' }, h('legend', { text: `舊資料（${source.kind === 'v4' ? 'v4 快取' : `資料庫版本 ${source.payload.version}`}）` }),
                rows.map(r => h('label', { class: 'inline-check legacy-row' },
                    h('input', { type: 'checkbox', value: r.id, dataset: { legacyClass: r.id }, disabled: have.has(r.id) ? true : null }),
                    h('span', { text: `${r.name}：${r.students} 位學生、${r.events} 筆加扣分、${r.homework} 筆作業紀錄、${r.grants} 個收藏${have.has(r.id) ? '（帳號中已有，略過）' : ''}` })))) : h('p', { class: 'muted', text: '這台電腦已經沒有舊資料。' }),
            h('div', { class: 'modal-actions wrap' },
                source ? h('button', { class: 'btn btn-primary', id: 'legacy-import', text: '下載備份並匯入勾選的班級', onclick: doImport }) : null,
                source && !imp ? h('button', { class: 'btn btn-secondary', id: 'legacy-dismiss', text: '這不是我的資料（此帳號不再提示）', onclick: dismiss }) : null,
                imp ? h('button', { class: 'btn btn-secondary', id: 'legacy-undo', text: `復原這次匯入（移除 ${imp.classIds.length} 個匯入的班級）`, onclick: undo }) : null),
            source ? h('details', { class: 'hw-hist' }, h('summary', { text: '從這台電腦移除舊資料' }),
                h('p', { class: 'muted', text: '確定所有老師都已匯入自己的班級後才需要。會先下載備份，之後可用「載入備份」找回。' }),
                h('button', { class: 'btn btn-danger', id: 'legacy-remove', text: '下載備份後移除舊資料', onclick: removeLegacy })) : null,
            h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-secondary', text: '關閉', onclick: () => modal.close() })));
    };

    const downloadLegacyBackup = () => {
        if (source.kind === 'v4') app.downloadFile(`班級動力站_舊資料v4原始備份_${app.stampForFile()}.json`, source.raw);
        else app.downloadFile(`班級動力站_舊資料備份_${app.stampForFile()}.json`, JSON.stringify(app.buildBackupOf(source.payload)));
    };

    const doImport = async () => {
        const ids = [...modal.card.querySelectorAll('input[data-legacy-class]:checked')].map(i => i.value);
        if (!ids.length) { alert('請先勾選要匯入的班級。'); return; }
        const plan = planLegacyImport(source.payload, ids, S.classes.map(c => c.id));
        if (!plan.imported.length) { alert('勾選的班級帳號中都已經有了，沒有匯入任何資料。'); return; }
        if (!confirm(`確定把 ${plan.imported.length} 個班級（${plan.counts.students} 位學生、${plan.counts.events} 筆紀錄）匯入目前登入的帳號？\n會先下載舊資料備份。`)) return;
        downloadLegacyBackup();
        if (S.classes.length) await app.exportAccountBackup('班級動力站_匯入舊資料前帳號備份');
        const puts = Object.fromEntries(Object.entries(plan.puts).filter(([, v]) => v.length));
        await app.dbWrite(puts);
        for (const [t, items] of Object.entries(puts)) S[S_KEY(t)] = S[S_KEY(t)].concat(items);
        const prev = S.meta.legacyImport;
        await app.setMeta('legacyImport', { at: Date.now(), classIds: [...new Set([...(prev?.classIds || []), ...plan.imported])], source: source.kind });
        await app.refresh();
        app.afterDataChange();
        app.notify(`已匯入 ${plan.imported.length} 個班級${plan.skipped.length ? `（略過 ${plan.skipped.length} 個）` : ''}`, 4000);
        render(); renderBanner();
    };

    const undo = async () => {
        const imp = S.meta.legacyImport; if (!imp) return;
        const dels = planUndoImport({ ...S, dailySnapshots: S.snapshots }, imp.classIds);
        const total = Object.values(dels).reduce((n, a) => n + a.length, 0);
        if (!confirm(`復原匯入：從此帳號移除 ${imp.classIds.length} 個匯入的班級（共 ${total} 筆資料，包含匯入後新增的紀錄）。\n會先下載此帳號的備份；舊資料本身不受影響。確定？`)) return;
        await app.exportAccountBackup('班級動力站_復原匯入前帳號備份');
        await app.dbWrite({}, Object.fromEntries(Object.entries(dels).filter(([, v]) => v.length)));
        for (const [t, ids] of Object.entries(dels)) { const set = new Set(ids); S[S_KEY(t)] = S[S_KEY(t)].filter(x => !set.has(x.id)); }
        await app.setMeta('legacyImport', null);
        await app.refresh();
        app.afterDataChange();
        app.notify('已復原匯入', 3000);
        render(); renderBanner();
    };

    const dismiss = async () => { await app.setMeta('legacyDismissed', true); modal.close(); renderBanner(); };

    const removeLegacy = async () => {
        if (!confirm('從這台電腦移除所有「未歸屬帳號」的舊資料？\n其他老師若還沒匯入自己的班級，將需要用備份檔找回。')) return;
        if (!confirm('再次確認：會先下載備份，然後移除。')) return;
        downloadLegacyBackup();
        if (source.kind === 'db') await new Promise((ok, no) => { const r = indexedDB.deleteDatabase(LEGACY_DB); r.onsuccess = ok; r.onerror = () => no(r.error); r.onblocked = ok; });
        try { localStorage.removeItem(LEGACY_V4_KEY); } catch { /* 忽略 */ }
        source = null;
        app.notify('已移除這台電腦上的舊資料（備份已下載）', 4000);
        render(); renderBanner();
    };

    return { detect, open, renderBanner };
};
