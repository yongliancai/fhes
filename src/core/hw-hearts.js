// v6.2 作業逾期自動愛心（純函式）。
// 規則（使用者 2026-11-26 決定，之後可調整）：
//   - 「未繳交」或「未訂正」從被登記的那一刻開始計時。
//   - 只算上課日：週六、週日與老師標記的放假日不計時（Asia/Taipei）。
//   - 每累計 hours（預設 24）小時的上課時間，自動加一顆愛心；一直沒改就每天再加一顆。
//   - 之後補交或訂正，已經加的愛心保留（老師可以手動消除）。
//   - 只計算 since（啟用時間）之後「才開始」的等待；升級或重新開啟前就已經是未繳交的不追溯（BUG-028）。封存的作業不再加。
//   - 後來收到「更早」的登記（例如小老師在老師開電腦前就登記了繳交），已加但其實不該加的愛心會被撤回（BUG-027，withdrawnHomeworkHearts）。
// 每顆愛心的 id 是固定的（由開始狀態的事件 id ＋第幾顆組成）：多台裝置、重複執行都不會重複加；
// 老師撤銷或刪除後也不會再自動加回來（呼叫端用所有既有事件 id 判斷）。
import { localDate, addDays } from './dates.js';
import { SUBMISSION, CORRECTION, simpleOf, DEFAULT_HW_AUTO_HEART } from './homework.js';

const TZ_OFFSET_MS = 8 * 3600_000;                     // 台灣沒有日光節約時間
export const MAX_DAYS_SCANNED = 800;
const dayStart = (ds) => Date.parse(`${ds}T00:00:00Z`) - TZ_OFFSET_MS;
const weekday = (ds) => new Date(`${ds}T00:00:00Z`).getUTCDay();
export const isSchoolDay = (ds, holidays = new Set()) => { const w = weekday(ds); return w !== 0 && w !== 6 && !holidays.has(ds); };

/** 設定補值與範圍檢查 */
export const autoHeartConfig = (cls) => {
    const c = { ...DEFAULT_HW_AUTO_HEART, ...(cls?.hwAutoHeart || {}) };
    const hours = Number(c.hours);
    return {
        enabled: !!c.enabled,
        hours: Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.round(hours))) : 24,
        holidays: new Set((Array.isArray(c.holidays) ? c.holidays : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))),
        since: Number.isFinite(c.since) ? c.since : null,
    };
};

/**
 * 從 from 到 upto，每累計 periodMs 的「上課日時間」產生一個時刻。
 * 回傳時刻陣列（第 1 顆、第 2 顆…）
 */
export const accrualTimes = (from, upto, periodMs, holidays = new Set()) => {
    const out = [];
    if (!(upto > from) || !(periodMs > 0)) return out;
    let acc = 0; let ds = localDate(from);
    for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
        const next = addDays(ds, 1);
        const s = Math.max(from, dayStart(ds)); const e = Math.min(upto, dayStart(next));
        if (s >= upto) break;
        if (e > s && isSchoolDay(ds, holidays)) {
            let t = s;
            while (acc + (e - t) >= periodMs) { t += periodMs - acc; acc = 0; out.push(t); }
            acc += e - t;
        }
        ds = next;
    }
    return out;
};

const byTsId = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const PENDING = new Set(['missing', 'needs']);

/**
 * 一格（某生×某作業）的「待處理」區間：[{ state: 'missing'|'needs', start, end, startId }]。
 * 重算規則與 projectRecords 相同（不合法的事件略過）。end = null 表示到現在仍未處理。
 */
export const pendingIntervals = (cellEvents) => {
    const out = []; let sub = 'unchecked'; let cor = null; let open = null;
    for (const ev of [...cellEvents].sort(byTsId)) {
        if (ev.field === 'submission') {
            if (!(ev.value in SUBMISSION)) continue;
            const before = sub; sub = ev.value;
            if (sub === 'submitted' && before !== 'submitted') cor = 'ungraded';
            else if (sub !== 'submitted') cor = null;
        } else if (ev.field === 'correction') {
            if (sub !== 'submitted' || !(ev.value in CORRECTION)) continue;
            cor = ev.value;
        } else continue;
        const st = simpleOf(sub, cor);
        if (open && open.state !== st) { open.end = ev.ts; out.push(open); open = null; }
        if (!open && PENDING.has(st)) open = { state: st, start: ev.ts, end: null, startId: ev.id };
    }
    if (open) out.push(open);
    return out;
};

export const heartId = (startEventId, n) => `hwheart|${startEventId}|${n}`;

/**
 * 計算現在應該存在、但還沒建立的自動愛心。
 * @param {{ cls, hwEvents, assignments, studentIds: Iterable<string>, existingIds: Set<string>, now: number }} p
 * @returns {Array<{ id, assignmentId, studentId, state, accruedAt, n }>}
 */
export const dueHomeworkHearts = ({ cls, hwEvents, assignments, studentIds, existingIds, now }) => {
    const cfg = autoHeartConfig(cls);
    if (!cfg.enabled || cfg.since === null) return [];
    const period = cfg.hours * 3600_000;
    const live = new Set(assignments.filter(a => a.classId === cls.id && !a.archived).map(a => a.id));
    const sids = new Set([...studentIds].map(String));
    const cells = new Map();
    for (const e of hwEvents) {
        if (e.classId !== cls.id || !live.has(e.assignmentId) || !sids.has(String(e.studentId))) continue;
        const k = `${e.assignmentId}|${e.studentId}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(e);
    }
    const out = [];
    for (const evs of cells.values()) {
        const { assignmentId, studentId } = evs[0];
        for (const iv of pendingIntervals(evs)) {
            if (iv.start < cfg.since) continue;
            const to = Math.min(iv.end ?? now, now);
            accrualTimes(iv.start, to, period, cfg.holidays).forEach((t, i) => {
                const id = heartId(iv.startId, i + 1);
                if (!existingIds.has(id)) out.push({ id, assignmentId, studentId: String(studentId), state: iv.state, accruedAt: t, n: i + 1 });
            });
        }
    }
    return out.sort((a, b) => a.accruedAt - b.accruedAt || (a.id < b.id ? -1 : 1));
};

const parseHeartId = (id) => { const m = /^hwheart\|(.+)\|(\d+)$/.exec(String(id)); return m ? { startId: m[1], n: Number(m[2]) } : null; };

/**
 * 已經建立、但依現在的事件來看不該存在的自動愛心（BUG-027）：
 * 等待其實在愛心時刻之前就結束了（較晚才收到的較早登記／另一台裝置的同步），或開始等待的事件已不再開始一段等待。
 * 老師已經撤銷（undone）或已撤回過的不再處理。
 * @param {{ cls, hwEvents, autoHearts: Array<{ id, accruedAt, undone? }>, now: number }} p
 */
export const withdrawnHomeworkHearts = ({ cls, hwEvents, autoHearts, now }) => {
    const cells = new Map();
    for (const e of hwEvents) if (e.classId === cls.id) { const k = `${e.assignmentId}|${e.studentId}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(e); }
    const intervals = new Map(); void now;
    const byEvent = new Map(hwEvents.filter(e => e.classId === cls.id).map(e => [e.id, e]));
    const out = [];
    for (const h of autoHearts) {
        if (h.undone || h.revoked || !Number.isFinite(h.accruedAt)) continue;
        const p = parseHeartId(h.id); if (!p) continue;
        const start = byEvent.get(p.startId); if (!start) continue;          // 事件還沒同步到這台：不判斷
        const k = `${start.assignmentId}|${start.studentId}`;
        if (!intervals.has(k)) intervals.set(k, pendingIntervals(cells.get(k) || []));
        const iv = intervals.get(k).find(x => x.startId === p.startId);
        // 只看「等待是否在這顆愛心的時刻之前就結束了」；之後改了時數設定，已經加的不會因此被撤回
        if (!iv || (iv.end !== null && iv.end <= h.accruedAt)) out.push(h);
    }
    return out;
};
