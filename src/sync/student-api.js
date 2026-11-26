// v6.2 教師端呼叫學生系統 API（ADR-017、ADR-020）。
// - 教師工作階段（Bearer）只放在這個閉包的記憶體裡；不寫入任何儲存空間、不放網址、不記錄。
// - 只送出投影（每生最小資料），絕不送 Google access token、試算表 ID 或全班原始資料。
import { buildClassProjection, projectionHash, validateProjection } from '../core/student-projection.js';

export class StudentApiError extends Error {
    constructor(status, code, message, body = null) { super(message); this.status = status; this.code = code; this.body = body; }
}

/**
 * @param {{ base: string, fetchFn?: typeof fetch, now?: () => number }} opts
 */
export const createStudentApi = ({ base, fetchFn = (...a) => fetch(...a), now = () => Date.now() }) => {
    const root = String(base || '').replace(/\/+$/, '');
    let token = null; let expiresAt = 0;
    const classKeys = new Map();                 // 本機班級 ID → classKey（記憶體）
    const lastVersion = new Map();               // classKey → 這台最後發布的版本

    const call = async (method, path, body) => {
        if (!token || now() >= expiresAt) throw new StudentApiError(401, 'unauthenticated', '學生系統的連線已過期，請登出後重新登入');
        let r;
        try {
            r = await fetchFn(root + path, { method, credentials: 'omit', cache: 'no-store', headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        } catch { throw new StudentApiError(0, 'network', '連不上學生系統，請確認網路後再試'); }
        const data = await r.json().catch(() => ({}));
        if (r.status === 401) { token = null; throw new StudentApiError(401, 'unauthenticated', '學生系統的連線已過期，請登出後重新登入'); }
        if (!r.ok) throw new StudentApiError(r.status, data.error || 'error', data.message || `學生系統回應 ${r.status}`, data);
        return data;
    };

    const api = {
        get connected() { return !!token && now() < expiresAt; },
        /** 用登入時取得的 ID token 換教師工作階段（只用一次）。handoff 用完由呼叫端丟棄。 */
        async connect(handoff) {
            if (!handoff?.credential || !handoff?.nonce) throw new StudentApiError(0, 'no_credential', '沒有可用的登入憑證');
            let r;
            try { r = await fetchFn(`${root}/api/teacher/session`, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: handoff.credential, nonce: handoff.nonce }) }); }
            catch { throw new StudentApiError(0, 'network', '連不上學生系統'); }
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new StudentApiError(r.status, data.error || 'error', data.message || '無法連線學生系統');
            token = data.token; expiresAt = data.expiresAt;
            return { expiresAt };
        },
        async disconnect() { if (token) { try { await call('POST', '/api/teacher/logout'); } catch { /* 已失效也沒關係 */ } } token = null; classKeys.clear(); },
        async classKey(cls) {
            if (classKeys.has(cls.id)) return classKeys.get(cls.id);
            const { classKey } = await call('POST', '/api/teacher/classes', { localClassId: String(cls.id), name: String(cls.name || '').slice(0, 60) });
            classKeys.set(cls.id, classKey);
            return classKey;
        },
        async listAccounts(cls) { return call('GET', `/api/teacher/classes/${encodeURIComponent(await api.classKey(cls))}/accounts`); },
        async createAccounts(cls, studentIds) { return call('POST', `/api/teacher/classes/${encodeURIComponent(await api.classKey(cls))}/accounts`, { students: studentIds.map(id => ({ localStudentId: String(id) })) }); },
        async accountAction(cls, accountId, action) {
            if (!['reset', 'disable', 'enable'].includes(action)) throw new Error('不明的動作');
            return call('POST', `/api/teacher/classes/${encodeURIComponent(await api.classKey(cls))}/accounts/${encodeURIComponent(accountId)}/${action}`, {});
        },
        async careSummary(cls) { return call('GET', `/api/teacher/classes/${encodeURIComponent(await api.classKey(cls))}/care-summary`); },
        async setHelper(cls, accountId, helper) { return call('POST', `/api/teacher/classes/${encodeURIComponent(await api.classKey(cls))}/accounts/${encodeURIComponent(accountId)}/helper`, { helper: !!helper }); },
        /** 收取小老師登記（after 之後的全部；分頁自動接續）。回傳 { registrations, next } */
        async pullRegistrations(cls, after = 0) {
            const key = encodeURIComponent(await api.classKey(cls));
            const all = []; let cur = Math.max(0, Math.floor(Number(after) || 0));
            for (let i = 0; i < 40; i++) {
                const r = await call('GET', `/api/teacher/classes/${key}/homework-registrations?after=${cur}`);
                all.push(...r.registrations); cur = r.next;
                if (!r.more) break;
            }
            return { registrations: all, next: cur };
        },
        /**
         * 發布一個班級。版本＝現在時間（且大於這台上次發布的版本）；overrideVersion 用於「以這台的資料覆蓋」較新的版本。
         * 回傳伺服器回應；409 stale 時丟出 StudentApiError（body.currentVersion）。
         */
        async publish(data, { today, nameMode, overrideVersion, inboxSeq = 0 } = {}) {
            const projection = buildClassProjection(data, { today, nameMode });
            const errors = validateProjection(projection);
            if (errors.length) throw new StudentApiError(0, 'invalid_projection', `資料檢查沒有通過：${errors.slice(0, 3).join('、')}`);
            const key = await api.classKey(data.cls);
            const version = Math.max(overrideVersion || 0, (lastVersion.get(key) || 0) + 1, now());
            const res = await call('PUT', `/api/teacher/classes/${encodeURIComponent(key)}/projection`, { version, hash: await projectionHash(projection), projection, inboxSeq: Math.max(0, Math.floor(inboxSeq)) });
            lastVersion.set(key, res.version);
            return { ...res, projection };
        },
    };
    return api;
};
