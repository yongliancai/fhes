// Google Sheets REST 介接（只用 values.batchGet / values.append / values.batchUpdate / spreadsheets.create / addSheet）。
// 寫入一律 valueInputOption=RAW：學生姓名若以「=」開頭也不會被當成公式（避免公式注入）。
// 不使用 values.clear，也不整個工作表覆蓋。
import { classifyHttp, asSyncError, SyncError } from './engine.js';
import { SYNC_TABLES, tableByName, headerOf, fromRow, FIXED_COLS, SCHEMA_VERSION } from './schema.js';

export const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const lastCol = (n) => String.fromCharCode(64 + n);   // 1→A … 26→Z（欄數 < 27）

/** 從試算表網址或 ID 取出 spreadsheetId */
export const parseSpreadsheetId = (input) => {
    const s = String(input || '').trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
};

const makeRequester = ({ getToken, fetchFn }) => async (method, url, body) => {
    const token = await getToken();
    let r;
    try {
        r = await fetchFn(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (err) { throw asSyncError(err); }
    if (!r.ok) { let t = ''; try { t = await r.text(); } catch { /* ignore */ } throw classifyHttp(r.status, t); }
    return r.status === 204 ? {} : r.json();
};

/** 建立新的試算表（含所有工作表與標題列）；回傳 spreadsheetId */
export const createSpreadsheet = async ({ title, getToken, fetchFn = globalThis.fetch.bind(globalThis), tables = SYNC_TABLES }) => {
    const req = makeRequester({ getToken, fetchFn });
    const out = await req('POST', SHEETS_BASE, { properties: { title }, sheets: tables.map(t => ({ properties: { title: t.sheet } })) });
    const id = out.spreadsheetId;
    if (!id) throw new SyncError('unknown', '建立試算表失敗');
    await req('POST', `${SHEETS_BASE}/${id}/values:batchUpdate`, { valueInputOption: 'RAW',
        data: tables.map(t => ({ range: `${t.sheet}!A1:${lastCol(headerOf(t).length)}1`, values: [headerOf(t)] })) });
    return id;
};

export const createSheetsAdapter = ({ spreadsheetId, getToken, fetchFn = globalThis.fetch.bind(globalThis) }) => {
    const req = makeRequester({ getToken, fetchFn });
    const base = `${SHEETS_BASE}/${spreadsheetId}`;
    let ensured = false;
    const cfgOf = (table) => { const c = tableByName.get(table); if (!c) throw new SyncError('unknown', `未知的資料表 ${table}`); return c; };
    const batchGet = async (ranges) => {
        const out = [];
        for (let i = 0; i < ranges.length; i += 100) {
            const q = ranges.slice(i, i + 100).map(r => `ranges=${encodeURIComponent(r)}`).join('&');
            const res = await req('GET', `${base}/values:batchGet?${q}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
            out.push(...(res.valueRanges || []));
        }
        return out;
    };

    return {
        spreadsheetId,
        /** 缺少的工作表補建；標題列不對就寫入第 1 列（不碰資料列） */
        async ensureSchema(tables = SYNC_TABLES) {
            if (ensured) return;
            const meta = await req('GET', `${base}?fields=${encodeURIComponent('properties.title,sheets.properties.title')}`);
            const have = new Set((meta.sheets || []).map(s => s.properties.title));
            const missing = tables.filter(t => !have.has(t.sheet));
            if (missing.length) await req('POST', `${base}:batchUpdate`, { requests: missing.map(t => ({ addSheet: { properties: { title: t.sheet } } })) });
            const heads = await batchGet(tables.map(t => `${t.sheet}!A1:${lastCol(headerOf(t).length)}1`));
            const fix = tables.filter((t, i) => JSON.stringify((heads[i]?.values || [[]])[0]) !== JSON.stringify(headerOf(t)));
            if (fix.length) await req('POST', `${base}/values:batchUpdate`, { valueInputOption: 'RAW', data: fix.map(t => ({ range: `${t.sheet}!A1:${lastCol(headerOf(t).length)}1`, values: [headerOf(t)] })) });
            ensured = true;
        },
        /** 讀全部資料列的同步欄（A–G） */
        async readAll(tables = SYNC_TABLES) {
            const vr = await batchGet(tables.map(t => `${t.sheet}!A2:${lastCol(FIXED_COLS.length)}`));
            return Object.fromEntries(tables.map((t, i) => [t.table, (vr[i]?.values || []).map((v, j) => fromRow(v, j + 2)).filter(Boolean)]));
        },
        /** 重新讀取指定列（更新前的再確認） */
        async readRows(table, rows) {
            const cfg = cfgOf(table);
            const vr = await batchGet(rows.map(r => `${cfg.sheet}!A${r}:${lastCol(FIXED_COLS.length)}${r}`));
            return rows.map((r, i) => { const v = vr[i]?.values?.[0]; return v ? fromRow(v, r) : null; });
        },
        /** 新增列到最後；回傳每列的列號 */
        async append(table, rows) {
            const cfg = cfgOf(table);
            const res = await req('POST', `${base}/values/${encodeURIComponent(`${cfg.sheet}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
            const m = String(res.updates?.updatedRange || '').match(/![A-Z]+(\d+)/);
            const start = m ? Number(m[1]) : null;
            return rows.map((_, i) => start == null ? null : start + i);
        },
        /** 更新指定列（整列的 A..最後欄） */
        async update(table, items) {
            const cfg = cfgOf(table);
            await req('POST', `${base}/values:batchUpdate`, { valueInputOption: 'RAW',
                data: items.map(it => ({ range: `${cfg.sheet}!A${it.row}:${lastCol(it.values.length)}${it.row}`, values: [it.values] })) });
        },
        schemaVersion: SCHEMA_VERSION,
    };
};
