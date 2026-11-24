// 班級設定的預設值與補值（v5.1 起）。新欄位一律以「補值」方式加入，不改動既有值。

export const DEFAULT_PENALTY_REASONS = ['講話', '走動', '傳紙條', '吵鬧', '作業', '其他'];
export const DEFAULT_CLEAR_REASONS = ['表現改善', '主動幫忙', '老師另訂'];
export const DEFAULT_REDEEM_ITEMS = [{ name: '小文具', cost: 10 }, { name: '自選座位一天', cost: 20 }, { name: '當一天小老師', cost: 15 }, { name: '優先選打掃工作', cost: 10 }];
export const SESSIONS = ['早自修', '午休', '其他'];
export const DEFAULT_SESSION_TIMES = { '早自修': ['07:30', '08:40'], '午休': ['12:20', '13:30'] };

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 額外的補值器（作業、圖鑑模組註冊進來），讓班級物件集中在一處補齊 */
const extraFillers = [];
export const registerClassDefaults = (fn) => { if (!extraFillers.includes(fn)) extraFillers.push(fn); };

/** 補上班級設定；回傳是否有補 */
export function ensureClassDefaults(c) {
    let changed = false;
    const fill = (k, v) => { if (c[k]) return false; c[k] = v; changed = true; return true; };
    fill('penaltyReasons', [...DEFAULT_PENALTY_REASONS]);
    fill('clearReasons', [...DEFAULT_CLEAR_REASONS]);
    fill('redeemItems', DEFAULT_REDEEM_ITEMS.map(x => ({ ...x })));
    fill('sessionTimes', clone(DEFAULT_SESSION_TIMES));
    fill('scoreReasons', []);
    for (const f of extraFillers) if (f(c, fill)) changed = true;
    return changed;
}

export const newClassObj = (name, groupCount = 4, { id, now = Date.now() } = {}) => {
    const c = { id, name, groupCount, scoreReasons: [], createdAt: now, updatedAt: now, deleted: false };
    ensureClassDefaults(c);
    return c;
};

/** 目前時段：依班級設定的早自修、午休時間 */
export const sessionAt = (c, hm) => {
    const st = c?.sessionTimes || DEFAULT_SESSION_TIMES;
    for (const k of ['早自修', '午休']) { const [a, b] = st[k] || []; if (a && b && hm >= a && hm < b) return k; }
    return '其他';
};
