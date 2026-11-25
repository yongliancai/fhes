// 同步引擎（ADR-009）：本機 IndexedDB ⇄ Google 試算表，三方內容雜湊比對。
//
// 每筆資料比較三個雜湊：本機目前 L、雲端目前 R、上次同步成功時 B（syncState）。
//   L == R            → 已一致（記錄 B）
//   從沒同步過（無 B）  → 只有本機有：新增到雲端；只有雲端有：下載；兩邊不同：衝突
//   只有本機變了       → 上傳（只改那一列；寫入前再讀一次該列確認沒被別台改過）
//   只有雲端變了       → 下載
//   兩邊都變了         → 衝突：不自動覆蓋，交給老師選「用本機」或「用雲端」
// 保證：
//   - 絕不整表覆蓋；只 append 新列或更新特定列
//   - 刪除寫成墓碑（deleted=1，資料保留）
//   - 冪等：append 回應遺失但實際成功 → 下次讀到同 id 同內容 → 視為一致，不會重複新增
//   - 雲端確認寫入成功前，不把資料標成「已同步」
import { entityHash } from '../core/ids.js';
import { SYNC_TABLES, toRow } from './schema.js';

export class SyncError extends Error {
    constructor(kind, message, { status = 0, retryable = false } = {}) { super(message); this.kind = kind; this.status = status; this.retryable = retryable; }
}
/** 由 HTTP 狀態／錯誤分類 */
export const classifyHttp = (status, body = '') => {
    if (status === 401) return new SyncError('auth', 'Google 授權已過期或被撤銷，請重新連線。', { status });
    if (status === 429 || (status === 403 && /rate|quota/i.test(body))) return new SyncError('rate', 'Google 試算表暫時限制請求次數，稍後自動重試。', { status, retryable: true });
    // BUG-014（真實 Google 驗收時發現）：Cloud 專案沒啟用 Sheets API 也是 403，不能說成「沒有這份試算表的權限」
    if (status === 403 && /SERVICE_DISABLED|has not been used in project|API_DISABLED|accessNotConfigured/i.test(body)) return new SyncError('config', '這個 OAuth 用戶端所在的 Google Cloud 專案尚未啟用「Google Sheets API」。請管理者到 Google Cloud →「API 和服務 → 程式庫」啟用後，等幾分鐘再試（見設定說明）。', { status });
    if (status === 403) return new SyncError('permission', '沒有這份試算表的存取權限。', { status });
    if (status === 404) return new SyncError('notfound', '找不到試算表（可能已被刪除或沒有權限）。', { status });
    if (status >= 500) return new SyncError('server', 'Google 伺服器暫時錯誤，稍後自動重試。', { status, retryable: true });
    if (status === 400) return new SyncError('bad-request', `Google 回應格式錯誤（400）：${String(body).slice(0, 120)}`, { status });
    return new SyncError('unknown', `同步失敗（HTTP ${status}）`, { status });
};
export const asSyncError = (err) => {
    if (err instanceof SyncError) return err;
    if (err && (err.name === 'TypeError' || err.name === 'AbortError' || /network|fetch|offline/i.test(String(err.message)))) return new SyncError('network', '網路連線中斷，資料已保存在本機，恢復連線後會自動同步。', { retryable: true });
    return new SyncError('unknown', String(err?.message || err));
};
/** 退避：5s, 15s, 45s, 2m, 5m… */
export const backoffMs = (attempt) => Math.min(5 * 60_000, 5_000 * Math.pow(3, Math.max(0, attempt)));

const key = (table, id) => `${table}|${id}`;
/** 只差在這些「記帳欄位」的兩個版本不算真正衝突：取較新的（BUG-006：改學生名字會同時更新班級 updatedAt） */
export const BOOKKEEPING_KEYS = Object.freeze(['updatedAt', 'lastSyncAt']);
export const autoMergeChoice = (L, R) => {
    if (!L || !R) return null;
    const diff = [...new Set([...Object.keys(L), ...Object.keys(R)])].filter(k => JSON.stringify(L[k]) !== JSON.stringify(R[k]));
    if (!diff.length || !diff.every(k => BOOKKEEPING_KEYS.includes(k))) return null;
    return (Number(L.updatedAt ?? L.lastSyncAt) || 0) > (Number(R.updatedAt ?? R.lastSyncAt) || 0) ? 'local' : 'remote';
};
const hashOrNull = (entity) => entity == null ? null : entityHash(entity);

/** 雲端同 id 多列（理論上不該發生）：取 rev 最大、同 rev 取最上面一列 */
export const dedupeRows = (rows) => {
    const best = new Map(); let duplicates = 0;
    for (const r of rows) {
        const cur = best.get(r.id);
        if (!cur) { best.set(r.id, r); continue; }
        duplicates++;
        if (r.rev > cur.rev || (r.rev === cur.rev && r.row < cur.row)) best.set(r.id, r);
    }
    return { byId: best, duplicates };
};

/**
 * local：{ list(table), apply(table, puts, deleteIds, expectedHashes), getState(), setState(entries), getConflicts(), setConflicts(list) }
 * remote：{ ensureSchema(tables), readAll(tables), readRows(table, rowNumbers), append(table, rows), update(table, [{row, values}]) }
 */
export const createSyncEngine = ({ local, remote, deviceId, now = () => Date.now(), tables = SYNC_TABLES }) => {
    /** 本機待上傳筆數（不連網也能算） */
    const pending = async () => {
        const state = await local.getState(); let n = 0;
        for (const cfg of tables) {
            const items = await local.list(cfg.table);
            const ids = new Set();
            for (const e of items) { ids.add(String(e.id)); const st = state.get(key(cfg.table, e.id)); if (!st || st.hash !== entityHash(e)) n++; }
            for (const [k, st] of state) if (k.startsWith(cfg.table + '|') && st.hash !== null && !ids.has(k.slice(cfg.table.length + 1))) n++;
        }
        return n;
    };

    /**
     * 執行一次同步。resolutions：[{ key, use: 'local'|'remote' }]（老師處理衝突的選擇）
     * 回傳統計；網路/授權錯誤丟出 SyncError（已完成的部分保持一致，未完成的下次再來）
     */
    const sync = async ({ resolutions = [] } = {}) => {
        const res = new Map(resolutions.map(r => [r.key, r.use]));
        const stats = { pulled: 0, pushed: 0, appended: 0, updated: 0, conflicts: 0, raced: 0, duplicates: 0, badRows: 0, at: now() };
        await remote.ensureSchema(tables);
        const remoteAll = await remote.readAll(tables);
        const state = await local.getState();
        const conflicts = [];
        const prevConflicts = new Map((await local.getConflicts()).map(c => [c.key, c]));

        for (const cfg of tables) {
            const rows = remoteAll[cfg.table] || [];
            const bad = new Set(rows.filter(r => r.bad).map(r => r.id));
            stats.badRows += bad.size;
            const { byId: remoteById, duplicates } = dedupeRows(rows.filter(r => !r.bad));
            stats.duplicates += duplicates;
            const items = await local.list(cfg.table);
            const localById = new Map(items.map(e => [String(e.id), e]));
            const ids = new Set([...localById.keys(), ...remoteById.keys()]);
            for (const [k] of state) if (k.startsWith(cfg.table + '|')) ids.add(k.slice(cfg.table.length + 1));

            const puts = [], dels = [], expected = new Map(), stateAfterPull = [];
            const appends = [], updates = [];
            for (const id of ids) {
                if (bad.has(id)) continue;                         // 雲端該列損壞：不碰，回報給老師
                const k = key(cfg.table, id);
                const L = localById.get(id) ?? null; const lh = hashOrNull(L);
                const R = remoteById.get(id) ?? null; const rh = R ? (R.deleted ? null : entityHash(R.entity)) : undefined;
                const st = state.get(k);
                const pull = () => {
                    if (rh === null || rh === undefined) { if (L) { dels.push(id); expected.set(id, lh); } }
                    else { puts.push(R.entity); expected.set(id, lh); }
                    stateAfterPull.push([k, { hash: rh ?? null, rev: R?.rev ?? 0, row: R?.row ?? null }]);
                };
                const push = () => {
                    if (R) updates.push({ id, k, row: R.row, expectRev: R.rev, values: toRow(cfg, { id, rev: R.rev + 1, hash: lh ?? '', updatedAt: now(), deleted: !L, device: deviceId, entity: L ?? R.entity }), lh, rev: R.rev + 1 });
                    else if (L) appends.push({ id, k, values: toRow(cfg, { id, rev: 1, hash: lh, updatedAt: now(), deleted: false, device: deviceId, entity: L }), lh });
                };
                if (R && (lh ?? null) === (rh ?? null)) {
                    if (!st || st.hash !== (lh ?? null) || st.rev !== R.rev) stateAfterPull.push([k, { hash: lh ?? null, rev: R.rev, row: R.row }]);
                    continue;
                }
                if (!R && !L) { if (st) stateAfterPull.push([k, null]); continue; }
                // 雲端整列不見了（App 刪除一定寫墓碑，所以這是有人手動刪列或清空工作表）→ 不刪本機，重新上傳
                if (!R && L && st) { push(); continue; }
                const choice = res.get(k);
                if (choice === 'remote') { pull(); continue; }
                if (choice === 'local') { push(); continue; }
                if (!st) {
                    if (!R) push();
                    else if (!L) { if (rh !== null) pull(); else stateAfterPull.push([k, { hash: null, rev: R.rev, row: R.row }]); }
                    else { const auto = autoMergeChoice(L, R.deleted ? null : R.entity); if (auto === 'local') push(); else if (auto === 'remote') pull(); else conflicts.push(conflictOf(cfg, id, L, R, prevConflicts.get(k))); }
                    continue;
                }
                const localChanged = (lh ?? null) !== st.hash;
                const remoteChanged = !R ? st.hash !== null : (rh ?? null) !== st.hash || R.rev !== st.rev;
                if (localChanged && remoteChanged) {
                    const auto = autoMergeChoice(L, R && !R.deleted ? R.entity : null);
                    if (auto === 'local') push(); else if (auto === 'remote') pull(); else conflicts.push(conflictOf(cfg, id, L, R, prevConflicts.get(k)));
                }
                else if (remoteChanged) pull();
                else if (localChanged) push();
            }

            // 1) 先套用下載（套用時再確認本機沒有在這段時間被改過）
            if (puts.length || dels.length) {
                const applied = await local.apply(cfg.table, puts, dels, expected);
                stats.pulled += applied.applied;
                const skipped = new Set(applied.skipped || []);
                await local.setState(stateAfterPull.filter(([k]) => !skipped.has(k.slice(cfg.table.length + 1))));
            } else if (stateAfterPull.length) await local.setState(stateAfterPull);

            // 2) 新增列（append）。回應遺失也安全：下次讀到同內容就視為一致
            if (appends.length) {
                const rowNumbers = await remote.append(cfg.table, appends.map(a => a.values));
                await local.setState(appends.map((a, i) => [a.k, { hash: a.lh, rev: 1, row: rowNumbers[i] ?? null }]));
                stats.appended += appends.length; stats.pushed += appends.length;
            }
            // 3) 更新列：寫入前再讀一次，rev 被別台改過就放棄（下次變成衝突），不盲目覆蓋
            if (updates.length) {
                const fresh = await remote.readRows(cfg.table, updates.map(u => u.row));
                const freshByRow = new Map(fresh.filter(Boolean).map(r => [r.row, r]));
                const ok = updates.filter(u => { const f = freshByRow.get(u.row); return f && f.id === u.id && f.rev === u.expectRev; });
                stats.raced += updates.length - ok.length;
                if (ok.length) {
                    await remote.update(cfg.table, ok.map(u => ({ row: u.row, values: u.values })));
                    await local.setState(ok.map(u => [u.k, { hash: u.lh ?? null, rev: u.rev, row: u.row }]));
                    stats.updated += ok.length; stats.pushed += ok.length;
                }
            }
        }
        stats.conflicts = conflicts.length;
        await local.setConflicts(conflicts);
        return stats;
    };

    const conflictOf = (cfg, id, L, R, prev) => ({
        key: key(cfg.table, id), table: cfg.table, sheet: cfg.sheet, id, local: L, remote: R.deleted ? null : R.entity,
        remoteDevice: R.device, remoteUpdatedAt: R.updatedAt, detectedAt: prev?.detectedAt ?? now(),
    });

    return { sync, pending };
};

/** 衝突摘要：列出兩邊不同的欄位（給老師看） */
export const diffKeys = (a, b) => {
    if (!a || !b) return ['（其中一邊已刪除）'];
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
};
