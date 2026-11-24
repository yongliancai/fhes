// XP 帳本（ADR-008）：小組 XP 與全班 XP 是兩本獨立的帳，由事件「推算」而來，不存累計數字。
//
// 來源一：分數事件（events），必須帶 xpv（v6 起建立的事件才有，舊資料不補發 XP）
//   - 個人加分 +N（已確認、非兌換、未被復原/撤銷）→ 該生「當時所屬小組」(xpGroup) 小組 XP +N；全班 XP +N
//   - 小組加分 +N → 該小組 XP +N（只算一次，絕不乘以組員人數）；全班 XP +N
//   - 扣分、負分、兌換、愛心 → 不產生也不扣回 XP
//   - 誤操作被復原/撤銷（undone / revoked）→ 該筆不再產生 XP（等於沖銷），已取得的收藏不受影響
// 來源二：xpEvents（老師頒發的全班/小組 XP、作業全班交齊獎勵），voided=true 不計
import { isCounted, effTs } from './score.js';

export const XP_VERSION = 1;
export const groupKey = (classId, g) => `${classId}|${g}`;

/** 一筆分數事件產生的 XP 分錄（可能 0～2 筆） */
export const xpEntriesOfEvent = (e) => {
    if (!e.xpv || !isCounted(e) || e.undone || e.revoked || e.undoOf) return [];
    if (e.kind !== 'score' || e.redeem || !(e.delta > 0)) return [];
    const ts = effTs(e);
    const out = [{ scope: 'class', key: e.classId, delta: e.delta, ts, sourceId: e.id }];
    if (e.targetType === 'group') out.push({ scope: 'group', key: groupKey(e.classId, e.targetId), delta: e.delta, ts, sourceId: e.id });
    else if (e.targetType === 'student' && e.xpGroup != null) out.push({ scope: 'group', key: groupKey(e.classId, e.xpGroup), delta: e.delta, ts, sourceId: e.id });
    return out;
};

export const xpEntriesOfManual = (x) => {
    if (x.voided || !Number.isFinite(x.delta)) return [];
    const key = x.scope === 'group' ? groupKey(x.classId, x.scopeId) : x.classId;
    return [{ scope: x.scope === 'group' ? 'group' : 'class', key, delta: x.delta, ts: x.ts, sourceId: x.id }];
};

/** 全部分錄（依時間） */
export const xpLedger = (events, xpEvents = []) =>
    [...events.flatMap(xpEntriesOfEvent), ...xpEvents.flatMap(xpEntriesOfManual)].sort((a, b) => a.ts - b.ts);

/** 加總：{ group: Map(key→xp), cls: Map(classId→xp) }；since：只算某時間之後（獎勵期間） */
export const sumXp = (ledger, since = 0) => {
    const group = new Map(); const cls = new Map();
    for (const x of ledger) {
        if (x.ts < since) continue;
        const m = x.scope === 'group' ? group : cls;
        m.set(x.key, (m.get(x.key) || 0) + x.delta);
    }
    return { group, cls };
};

/** 某個擁有者（小組或全班）在 since 之後獲得的 XP */
export const xpOf = (ledger, scope, key, since = 0) => ledger.reduce((n, x) => n + (x.scope === scope && x.key === key && x.ts >= since ? x.delta : 0), 0);

/** 全班里程碑（公共棲地裝飾 / 班級紀念物），由全班 XP 解鎖；預設值可由老師調整 */
export const DEFAULT_CLASS_MILESTONES = Object.freeze([
    { xp: 20, name: '星光小徑', icon: '✨' },
    { xp: 50, name: '彩虹橋', icon: '🌈' },
    { xp: 100, name: '大樹屋', icon: '🌳' },
    { xp: 180, name: '噴泉廣場', icon: '⛲' },
    { xp: 300, name: '觀星塔', icon: '🔭' },
    { xp: 500, name: '班級紀念碑', icon: '🏛️' },
]);
export const milestoneState = (classXp, milestones = DEFAULT_CLASS_MILESTONES) => {
    const reached = milestones.filter(m => classXp >= m.xp);
    const next = milestones.find(m => classXp < m.xp) || null;
    return { reached, next, toNext: next ? next.xp - classXp : 0 };
};
