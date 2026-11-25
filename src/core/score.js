// 個人分數／愛心／小隊分數的計算規則（v5.1 語意，抽出成純函式以便測試）。
// 不可改變的規則：
//  1. 只有 status = confirmed（或舊資料沒有 status）才計入。
//  2. 愛心依生效時間逐筆累加，每一步最少 0。
//  3. 兌換（redeem）會減少可用分數，但不減少累計獲得（earned）。
//  4. 小隊分數與個人分數各自獨立，不互相加總。

export const EVENT_DEFAULTS = Object.freeze({ session: '其他', status: 'confirmed', recordedBy: 'teacher', reviewNote: '', redeem: false });

export const isCounted = (e) => (e.status || 'confirmed') === 'confirmed';
export const effTs = (e) => e.confirmedAt || e.ts;          // 生效時間（隔天確認 → 確認當下）
export const effDate = (e) => e.confirmedDate || e.date;    // 生效日（計入哪一天的結算）
export const byEffTs = (a, b) => effTs(a) - effTs(b);

/** 套用一筆紀錄到 { score, earned, heart } */
export const applyTo = (t, e) => {
    if (e.kind === 'heart') t.heart = Math.max(0, t.heart + e.delta);
    else { t.score += e.delta; if (!e.redeem) t.earned += e.delta; }
};

export const emptyTotal = () => ({ score: 0, heart: 0, earned: 0 });

/** 套用到個人／小隊的總表（Map）；未確認的紀錄直接略過 */
export const applyEventToTotals = (totals, groupTotals, e) => {
    if (!isCounted(e)) return;
    if (e.targetType === 'student') {
        const t = totals.get(e.targetId) || emptyTotal();
        applyTo(t, e);
        totals.set(e.targetId, t);
    } else if (e.targetType === 'group') {
        const k = `${e.classId}|${e.targetId}`;
        groupTotals.set(k, (groupTotals.get(k) || 0) + e.delta);
    }
};

/** 純函式：由全部紀錄重算個人與小隊總表 */
export const computeTotals = (events) => {
    const totals = new Map(); const groupTotals = new Map();
    [...events].sort(byEffTs).forEach(e => applyEventToTotals(totals, groupTotals, e));
    return { totals, groupTotals };
};

/** 舊紀錄補欄位；回傳是否有補 */
export const normalizeEvent = (e) => {
    let changed = false;
    for (const [k, v] of Object.entries(EVENT_DEFAULTS)) if (e[k] === undefined || e[k] === null) { e[k] = v; changed = true; }
    return changed;
};
