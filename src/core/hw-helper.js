// v6.2 小老師登記 → 教師端作業事件（純函式）。
// 小老師在學生系統按的「繳交／未繳交／未訂正／已訂正」先存在後端；教師端收取後，依登記時間轉成一般的作業事件。
// 規則：
//   - 事件 id 固定（hwr|登記 id|序號）：重複收取、多台裝置收取都不會重複。
//   - 事件時間＝小老師登記的時間（逾期愛心從這一刻開始計時）。
//   - 老師在登記之後已經改過這一格：以老師為準，這筆登記略過。
//   - 老師設為「免交」的格子，小老師不能改（BUG-029）。
//   - 只重算有變動的那一格（大量登記時教師端不會卡住）。
//   - 只接受這個班級、未封存的作業，以及名單上的學生。
import { projectRecords, getRecord, buildSimpleChange, isSimpleState } from './homework.js';
import { localDate } from './dates.js';

export const HELPER_DEVICE = 'helper';
export const regEventId = (regId, n) => `hwr|${regId}|${n}`;

/**
 * @param {{ regs: Array<{ id, seq, assignmentId, studentId, state, createdAt, helperSeat }>, hwEvents, assignments, studentIds: Iterable<string>, classId: string }} p
 *   hwEvents、assignments 可以是全部資料（會依 classId 過濾）
 * @returns {{ events: object[], applied: number, skipped: Array<{ id, why }> }}
 */
export const registrationsToEvents = ({ regs, hwEvents, assignments, studentIds, classId }) => {
    const myAssignments = assignments.filter(a => a.classId === classId);
    const live = new Map(myAssignments.filter(a => !a.archived).map(a => [String(a.id), a]));
    const sids = new Set([...studentIds].map(String));
    const cells = new Map();
    for (const e of hwEvents) if (e.classId === classId) { const k = `${e.assignmentId}|${e.studentId}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(e); }
    const have = new Set(hwEvents.filter(e => e.classId === classId).map(e => e.id));
    const events = []; const skipped = []; let applied = 0;
    for (const r of [...regs].sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))) {
        if (have.has(regEventId(r.id, 1))) { skipped.push({ id: r.id, why: '已經收取過' }); continue; }
        const a = live.get(String(r.assignmentId));
        if (!a) { skipped.push({ id: r.id, why: '作業不存在或已封存' }); continue; }
        if (!sids.has(String(r.studentId))) { skipped.push({ id: r.id, why: '學生不在名單上' }); continue; }
        if (!isSimpleState(r.state) || !Number.isFinite(r.createdAt)) { skipped.push({ id: r.id, why: '格式不正確' }); continue; }
        const key = `${a.id}|${String(r.studentId)}`;
        const cell = cells.get(key) || [];
        const records = projectRecords(cell, myAssignments);
        const rec = getRecord(records, a.id, String(r.studentId));
        if (rec.updatedAt !== null && rec.updatedAt > r.createdAt) { skipped.push({ id: r.id, why: '老師之後已經改過' }); continue; }
        if (rec.submission === 'exempt') { skipped.push({ id: r.id, why: '老師設為免交' }); continue; }
        let n = 0;
        const out = buildSimpleChange({
            hwEvents: cell, assignments: myAssignments, records, classId, assignmentId: a.id, studentIds: [String(r.studentId)], state: r.state,
            reason: `小老師${r.helperSeat != null ? ` ${r.helperSeat}號` : ''}登記`,
        }, { uid: () => regEventId(r.id, ++n), now: r.createdAt, date: localDate(r.createdAt), deviceId: HELPER_DEVICE });
        if (out.events.length) { events.push(...out.events); cells.set(key, [...cell, ...out.events]); out.events.forEach(e => have.add(e.id)); applied++; }
        else skipped.push({ id: r.id, why: '狀態沒有改變' });
    }
    return { events, applied, skipped };
};
