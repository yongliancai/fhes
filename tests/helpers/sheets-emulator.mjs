// Google Sheets REST 模擬器（測試用，不隨 App 出貨）。
// 支援 adapter 會用到的端點；可注入錯誤：HTTP 狀態、網路中斷、「寫入成功但回應遺失」。
// 同一個模擬器可以同時給 Node 單元測試（fakeFetch）與 Playwright（page.route）使用 → 測的是真正的 adapter 與引擎。
const colIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const parseRange = (range) => {
    const m = decodeURIComponent(range).match(/^([^!]+)!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
    if (!m) throw new Error(`bad range ${range}`);
    return { sheet: m[1], c1: colIndex(m[2]), r1: m[3] ? Number(m[3]) : 1, c2: m[4] ? colIndex(m[4]) : null, r2: m[5] ? Number(m[5]) : null };
};

export const createSheetsEmulator = ({ validTokens = ['test-token'] } = {}) => {
    const books = new Map();
    const tokens = new Set(validTokens);
    const faults = [];
    const writes = [];   // 每次寫入：{ kind: 'append'|'update'|'header'|'create'|'addSheet', sheet, rows }
    let seq = 0;

    const json = (status, body) => ({ status, body });
    const book = (id) => books.get(id);
    const sheetRows = (b, title) => { if (!b.sheets.has(title)) throw Object.assign(new Error('no sheet'), { status: 400, msg: `Unable to parse range: ${title}` }); return b.sheets.get(title); };

    const handleInner = (method, url, body) => {
        const u = new URL(url);
        const path = decodeURIComponent(u.pathname.replace(/^\/v4\/spreadsheets/, ''));
        if (method === 'POST' && path === '') {
            const id = `emu${String(++seq).padStart(4, '0')}abcdefghijklmnopq`;
            books.set(id, { title: body.properties?.title || 'Untitled', sheets: new Map((body.sheets || []).map(s => [s.properties.title, []])) });
            writes.push({ kind: 'create', sheet: '*', rows: 0 });
            return json(200, { spreadsheetId: id, properties: { title: body.properties?.title } });
        }
        const m = path.match(/^\/([^/:]+)(.*)$/);
        const id = m?.[1]; const rest = m?.[2] || '';
        const b = book(id);
        if (!b) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
        if (method === 'GET' && rest === '') return json(200, { properties: { title: b.title }, sheets: [...b.sheets.keys()].map(title => ({ properties: { title } })) });
        if (method === 'POST' && rest === ':batchUpdate') {
            for (const r of body.requests || []) if (r.addSheet) { b.sheets.set(r.addSheet.properties.title, []); writes.push({ kind: 'addSheet', sheet: r.addSheet.properties.title, rows: 0 }); }
            return json(200, { replies: [] });
        }
        if (method === 'GET' && rest === '/values:batchGet') {
            const ranges = u.searchParams.getAll('ranges');
            return json(200, { valueRanges: ranges.map(r => {
                const p = parseRange(r); const rows = sheetRows(b, p.sheet);
                const out = [];
                const last = p.r2 ?? rows.length;
                for (let i = p.r1; i <= last; i++) { const row = rows[i - 1]; if (!row) { if (p.r2 == null) break; continue; } out.push(row.slice(p.c1, p.c2 == null ? undefined : p.c2 + 1)); }
                while (out.length && out[out.length - 1].length === 0) out.pop();
                return { range: r, majorDimension: 'ROWS', ...(out.length ? { values: out } : {}) };
            }) });
        }
        const ap = rest.match(/^\/values\/(.+):append$/);
        if (method === 'POST' && ap) {
            const p = parseRange(ap[1]); const rows = sheetRows(b, p.sheet);
            let lastRow = rows.length; while (lastRow > 0 && !(rows[lastRow - 1] || []).length) lastRow--;
            const start = lastRow + 1;
            (body.values || []).forEach((v, i) => { rows[start - 1 + i] = [...v]; });
            writes.push({ kind: 'append', sheet: p.sheet, rows: body.values.length });
            const end = start + body.values.length - 1;
            return json(200, { updates: { updatedRange: `${p.sheet}!A${start}:Z${end}`, updatedRows: body.values.length } });
        }
        if (method === 'POST' && rest === '/values:batchUpdate') {
            for (const d of body.data || []) {
                const p = parseRange(d.range); const rows = sheetRows(b, p.sheet);
                d.values.forEach((v, i) => { const r = p.r1 + i; const cur = rows[r - 1] || []; const next = [...cur]; v.forEach((x, j) => { next[p.c1 + j] = x; }); rows[r - 1] = next; });
                writes.push({ kind: p.r1 === 1 && d.values.length === 1 ? 'header' : 'update', sheet: p.sheet, rows: d.values.length, range: d.range });
            }
            return json(200, { totalUpdatedRows: (body.data || []).length });
        }
        if (/clear/i.test(rest)) { writes.push({ kind: 'CLEAR', sheet: rest, rows: -1 }); return json(200, {}); }
        return json(400, { error: { code: 400, message: `emulator: unsupported ${method} ${rest}` } });
    };

    /** 處理一個請求；回傳 { status, body } 或丟出 { network: true } */
    const handle = (method, url, body, headers = {}) => {
        const auth = headers.authorization || headers.Authorization || '';
        const fi = faults.findIndex(f => (!f.method || f.method === method) && (!f.match || f.match.test(url)));
        const fault = fi >= 0 ? faults[fi] : null;
        if (fault) { if (--fault.times <= 0) faults.splice(fi, 1); }
        if (fault?.network && !fault.afterApply) throw Object.assign(new TypeError('Failed to fetch'), { network: true });
        if (fault?.status && !fault.afterApply) return json(fault.status, { error: { code: fault.status, message: fault.message || 'injected' } });
        if (!tokens.has(auth.replace(/^Bearer\s+/, ''))) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
        let res;
        try { res = handleInner(method, url, body); } catch (e) { res = json(e.status || 500, { error: { code: e.status || 500, message: e.msg || e.message } }); }
        if (fault?.afterApply) { if (fault.network) throw Object.assign(new TypeError('Failed to fetch'), { network: true }); return json(fault.status || 500, { error: { code: fault.status || 500 } }); }
        return res;
    };

    /** 給 Node 單元測試的 fetch */
    const fetchFn = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        const res = handle(init.method || 'GET', url, body, init.headers || {});
        return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body, text: async () => JSON.stringify(res.body) };
    };

    return {
        fetch: fetchFn, handle, books, writes,
        /** 注入錯誤：{ match: RegExp, method, status, network, afterApply, times } */
        fault: (f) => faults.push({ times: 1, ...f }),
        clearFaults: () => { faults.length = 0; },
        addToken: (t) => tokens.add(t), revokeToken: (t) => tokens.delete(t),
        /** 直接讀某工作表的資料列（第 2 列起） */
        rows: (id, sheet) => (books.get(id)?.sheets.get(sheet) || []).slice(1).filter(r => r && r.length),
        /** 模擬老師在 Google 試算表上手動刪掉某列 */
        deleteRow: (id, sheet, rowNumber) => { books.get(id).sheets.get(sheet).splice(rowNumber - 1, 1); },
        setCell: (id, sheet, rowNumber, col, value) => { books.get(id).sheets.get(sheet)[rowNumber - 1][col] = value; },
    };
};

/** 記憶體版本機資料庫（模擬一台裝置的 IndexedDB + syncState） */
export const createMemoryLocal = (initial = {}) => {
    const tables = new Map(Object.entries(initial).map(([t, items]) => [t, new Map(items.map(x => [String(x.id), structuredClone(x)]))]));
    const state = new Map(); let conflicts = [];
    const tbl = (t) => { if (!tables.has(t)) tables.set(t, new Map()); return tables.get(t); };
    return {
        tables,
        list: async (t) => [...tbl(t).values()].map(x => structuredClone(x)),
        apply: async (t, puts, dels, expected) => {
            const { entityHash } = await import('../../src/core/ids.js');
            const m = tbl(t); let applied = 0; const skipped = [];
            const same = (id) => { const cur = m.get(String(id)); return (cur ? entityHash(cur) : null) === (expected?.get(String(id)) ?? null); };
            for (const e of puts) { if (expected && expected.has(String(e.id)) && !same(e.id)) { skipped.push(String(e.id)); continue; } m.set(String(e.id), structuredClone(e)); applied++; }
            for (const id of dels) { if (expected && expected.has(String(id)) && !same(id)) { skipped.push(String(id)); continue; } m.delete(String(id)); applied++; }
            return { applied, skipped };
        },
        getState: async () => new Map(state),
        setState: async (entries) => { for (const [k, v] of entries) { if (v == null) state.delete(k); else state.set(k, v); } },
        getConflicts: async () => conflicts,
        setConflicts: async (list) => { conflicts = list; },
        // 測試輔助
        put: (t, e) => tbl(t).set(String(e.id), structuredClone(e)),
        get: (t, id) => tbl(t).get(String(id)),
        del: (t, id) => tbl(t).delete(String(id)),
        all: (t) => [...tbl(t).values()],
    };
};
