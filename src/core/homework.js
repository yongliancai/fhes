// 作業繳交與訂正（純邏輯）
//
// 資料：
//  - 班級設定 c.hwTypes：作業類別 [{ id, name, active, builtin }]（預設 11 類，ID 固定）
//  - hwAssignments：實際作業 { id, classId, typeId, title, note, assignedDate, dueDate, archived, createdAt, updatedAt }
//  - hwEvents：不可變的狀態變更事件 { id, classId, assignmentId, studentId, field, value, prev, prevIds, ts, date, batchId, deviceId, reason }
//
// 學生×作業的「目前狀態」一律由 hwEvents 依時間重算（projectRecords），所以：
//  - 歷程完整（誰、何時、從什麼改成什麼）；撤銷是寫一筆反向事件，不刪資料
//  - 雲端同步只需「新增事件」，不會整列覆蓋；兩台裝置同時改同一格 → 事件 DAG 出現兩個 head → 標示衝突，由老師決定
//
// 兩個維度分開：
//  - 繳交 submission：unchecked 未登記 / missing 未交 / submitted 已交 / exempt 免交（未登記 ≠ 未交）
//  - 訂正 correction：ungraded 未批改 / needs 待訂正 / done 已訂正 / none 不需訂正（只有「已交」才有訂正狀態；已交 ≠ 已訂正）

export const SUBMISSION = Object.freeze({ unchecked: '未登記', missing: '未交', submitted: '已交', exempt: '免交' });
export const CORRECTION = Object.freeze({ ungraded: '未批改', needs: '待訂正', done: '已訂正', none: '不需訂正' });
export const SUBMISSION_ICON = Object.freeze({ unchecked: '·', missing: '✗', submitted: '✓', exempt: '—' });
export const CORRECTION_ICON = Object.freeze({ ungraded: '○', needs: '✎', done: '★', none: '◇' });

export const DEFAULT_HW_TYPE_NAMES = ['國隨', '國習', '甲本', '乙本', '數課', '數講', '數練', '數重', '數習', '成語', '考卷'];
export const DEFAULT_HW_TYPES = Object.freeze(DEFAULT_HW_TYPE_NAMES.map((name, i) => Object.freeze({ id: `hwt-${String(i + 1).padStart(2, '0')}`, name, active: true, builtin: true })));
export const DEFAULT_HW_REWARD = Object.freeze({ enabled: false, xp: 5 });

/** 班級補值器（registerClassDefaults 用） */
export const fillHomeworkDefaults = (c, fill) => {
    let changed = fill('hwTypes', DEFAULT_HW_TYPES.map(t => ({ ...t })));
    if (!c.hwReward) { c.hwReward = { ...DEFAULT_HW_REWARD }; changed = true; }
    return changed;
};

export const recordKey = (assignmentId, studentId) => `${assignmentId}|${studentId}`;
const byTsId = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const emptyRecord = (assignmentId, studentId) => ({
    assignmentId, studentId, submission: 'unchecked', correction: null,
    submittedAt: null, submittedDate: null, late: false, correctedAt: null, updatedAt: null,
    eventIds: [], heads: { submission: [], correction: [] }, conflict: null, invalid: [],
});

/** 驗證一次變更；回傳錯誤訊息或 null */
export const validateChange = (rec, field, value) => {
    if (field === 'submission') return value in SUBMISSION ? null : `不明的繳交狀態：${value}`;
    if (field === 'correction') {
        if (!(value in CORRECTION)) return `不明的訂正狀態：${value}`;
        if (rec.submission !== 'submitted') return '只有「已交」的作業才能設定訂正狀態';
        return null;
    }
    return `不明的欄位：${field}`;
};

/**
 * 由事件重算所有紀錄。
 * assignments：Map 或陣列（用於判斷補交：繳交日 > 期限）
 * 回傳 Map(recordKey → record)
 */
export const projectRecords = (hwEvents, assignments = []) => {
    const due = new Map((assignments instanceof Map ? [...assignments.values()] : assignments).map(a => [a.id, a.dueDate || null]));
    const groups = new Map();
    for (const ev of hwEvents) {
        const k = recordKey(ev.assignmentId, ev.studentId);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(ev);
    }
    const out = new Map();
    for (const [k, evs] of groups) {
        evs.sort(byTsId);
        const rec = emptyRecord(evs[0].assignmentId, evs[0].studentId);
        for (const ev of evs) {
            rec.eventIds.push(ev.id);
            if (ev.field === 'submission') {
                if (!(ev.value in SUBMISSION)) { rec.invalid.push(ev.id); continue; }
                const before = rec.submission;
                rec.submission = ev.value;
                if (ev.value === 'submitted' && before !== 'submitted') {
                    rec.submittedAt = ev.ts; rec.submittedDate = ev.date;
                    const d = due.get(ev.assignmentId);
                    rec.late = !!(d && ev.date > d);
                    if (rec.correction == null) rec.correction = 'ungraded';
                } else if (ev.value !== 'submitted') {
                    rec.correction = null; rec.submittedAt = null; rec.submittedDate = null; rec.late = false; rec.correctedAt = null;
                }
            } else if (ev.field === 'correction') {
                if (rec.submission !== 'submitted' || !(ev.value in CORRECTION)) { rec.invalid.push(ev.id); continue; }
                rec.correction = ev.value;
                rec.correctedAt = ev.value === 'done' ? ev.ts : null;
            }
            rec.updatedAt = ev.ts;
        }
        // DAG head：同一格同一欄位中，沒有被其他事件當作 prev 的事件
        for (const field of ['submission', 'correction']) {
            const fe = evs.filter(e => e.field === field);
            const referenced = new Set(fe.flatMap(e => e.prevIds || []));
            rec.heads[field] = fe.filter(e => !referenced.has(e.id)).sort(byTsId);
        }
        const conflictField = ['submission', 'correction'].find(f => rec.heads[f].length > 1 && new Set(rec.heads[f].map(e => e.value)).size > 1);
        rec.conflict = conflictField ? { field: conflictField, options: rec.heads[conflictField].map(e => ({ eventId: e.id, value: e.value, ts: e.ts, deviceId: e.deviceId || '' })) } : null;
        out.set(k, rec);
    }
    return out;
};

export const getRecord = (records, assignmentId, studentId) => records.get(recordKey(assignmentId, studentId)) || emptyRecord(assignmentId, studentId);

/**
 * 產生一批狀態變更事件（批次登記）。值相同的學生直接略過（不會重複產生紀錄）；不合法的變更回報在 rejected。
 * ctx：{ uid, now, date, deviceId }
 */
export const buildChangeEvents = ({ records, classId, assignmentId, studentIds, field, value, reason = '', batchId = null }, ctx) => {
    const events = []; const rejected = []; let unchanged = 0;
    const bid = batchId || (studentIds.length > 1 ? `hwb-${ctx.uid()}` : null);
    for (const sid of studentIds) {
        const rec = getRecord(records, assignmentId, sid);
        const err = validateChange(rec, field, value);
        if (err) { rejected.push({ studentId: sid, error: err }); continue; }
        const cur = field === 'submission' ? rec.submission : rec.correction;
        if (cur === value && !rec.conflict) { unchanged++; continue; }
        events.push({
            id: ctx.uid(), classId, assignmentId, studentId: sid, field, value, prev: cur,
            prevIds: rec.heads[field].map(e => e.id), ts: ctx.now, date: ctx.date, batchId: bid, deviceId: ctx.deviceId || '', reason,
        });
    }
    return { events, rejected, unchanged, batchId: bid };
};

/**
 * 復原一批：把該批每一格改回原值。之後若已被改過（head 不是該批事件），保留後來的修改並列在 skipped。
 */
export const buildUndoBatch = ({ hwEvents, records, batchId }, ctx) => {
    const batch = hwEvents.filter(e => e.batchId === batchId);
    const events = []; const skipped = [];
    const undoId = `undo-${batchId}`;
    if (hwEvents.some(e => e.batchId === undoId)) return { events, skipped: batch.map(e => ({ studentId: e.studentId, why: '這一批已經復原過' })), batchId: undoId };
    // 先復原訂正再復原繳交（反向順序）
    for (const ev of [...batch].sort((a, b) => byTsId(b, a))) {
        const rec = getRecord(records, ev.assignmentId, ev.studentId);
        const heads = rec.heads[ev.field];
        if (heads.length !== 1 || heads[0].id !== ev.id) { skipped.push({ studentId: ev.studentId, why: '之後已被修改' }); continue; }
        if (ev.field === 'correction' && rec.submission !== 'submitted') { skipped.push({ studentId: ev.studentId, why: '繳交狀態已改變' }); continue; }
        events.push({ id: ctx.uid(), classId: ev.classId, assignmentId: ev.assignmentId, studentId: ev.studentId, field: ev.field,
            value: ev.prev ?? (ev.field === 'submission' ? 'unchecked' : 'ungraded'), prev: ev.value, prevIds: [ev.id],
            ts: ctx.now, date: ctx.date, batchId: undoId, deviceId: ctx.deviceId || '', reason: '復原上一批', undoOfBatch: batchId });
    }
    return { events, skipped, batchId: undoId };
};

/** 解決衝突：老師選定一個值，新事件同時指向所有 head（DAG 合併後只剩一個 head） */
export const buildResolveEvent = ({ records, classId, assignmentId, studentId, field, value }, ctx) => {
    const rec = getRecord(records, assignmentId, studentId);
    return { id: ctx.uid(), classId, assignmentId, studentId, field, value, prev: field === 'submission' ? rec.submission : rec.correction,
        prevIds: rec.heads[field].map(e => e.id), ts: ctx.now, date: ctx.date, batchId: null, deviceId: ctx.deviceId || '', reason: '解決同步衝突' };
};

/**
 * 單份作業統計（匿名數字，可投影）
 *  繳交率 = 已交 ÷（已交＋未交）；分母排除免交，也不把未登記算成未交
 *  查核覆蓋率 = 已登記（未交/已交/免交）÷ 全部
 *  訂正完成率 = 已訂正 ÷（待訂正＋已訂正）
 */
export const assignmentStats = (records, assignmentId, studentIds) => {
    const s = { total: studentIds.length, unchecked: 0, missing: 0, submitted: 0, exempt: 0, late: 0, ungraded: 0, needs: 0, done: 0, none: 0, conflicts: 0 };
    for (const sid of studentIds) {
        const r = getRecord(records, assignmentId, sid);
        s[r.submission]++;
        if (r.late) s.late++;
        if (r.submission === 'submitted' && r.correction) s[r.correction]++;
        if (r.conflict) s.conflicts++;
    }
    const ratio = (a, b) => b > 0 ? a / b : null;
    s.submitRate = ratio(s.submitted, s.submitted + s.missing);
    s.coverage = ratio(s.total - s.unchecked, s.total);
    s.correctionRate = ratio(s.done, s.needs + s.done);
    s.expected = s.total - s.exempt;
    s.allIn = s.expected > 0 && s.submitted === s.expected;
    return s;
};

/** 教師用清單：待補交（未交）、待訂正；未登記另列提醒，絕不混入未交 */
export const followUpLists = (records, assignments, studentIds) => {
    const missing = [], needs = [], unchecked = [];
    for (const a of assignments) {
        if (a.archived) continue;
        for (const sid of studentIds) {
            const r = getRecord(records, a.id, sid);
            if (r.submission === 'missing') missing.push({ assignment: a, studentId: sid });
            else if (r.submission === 'unchecked') unchecked.push({ assignment: a, studentId: sid });
            if (r.submission === 'submitted' && r.correction === 'needs') needs.push({ assignment: a, studentId: sid });
        }
    }
    return { missing, needs, unchecked };
};

/** 學生個人作業歷程（教師用） */
export const studentHistory = (hwEvents, studentId) => hwEvents.filter(e => e.studentId === studentId).sort((a, b) => byTsId(b, a));

/** 作業類別管理 */
export const addHwType = (c, name, newId) => {
    const n = String(name || '').trim();
    if (!n) throw new Error('請輸入類別名稱');
    if (c.hwTypes.some(t => t.name === n)) throw new Error(`「${n}」已經存在`);
    const t = { id: newId, name: n, active: true, builtin: false };
    c.hwTypes.push(t);
    return t;
};
export const renameHwType = (c, id, name) => {
    const n = String(name || '').trim(); const t = c.hwTypes.find(x => x.id === id);
    if (!t) throw new Error('找不到類別');
    if (!n) throw new Error('請輸入類別名稱');
    if (c.hwTypes.some(x => x.id !== id && x.name === n)) throw new Error(`「${n}」已經存在`);
    t.name = n;
    return t;
};
export const setHwTypeActive = (c, id, active) => { const t = c.hwTypes.find(x => x.id === id); if (!t) throw new Error('找不到類別'); t.active = !!active; return t; };
/** 只有沒用過的自訂類別可以刪除；預設類別或已有作業的類別只能停用（保留歷史） */
export const canDeleteHwType = (c, id, assignments) => {
    const t = c.hwTypes.find(x => x.id === id);
    if (!t) return { ok: false, why: '找不到類別' };
    if (t.builtin) return { ok: false, why: '預設類別不能刪除，可以停用' };
    const used = assignments.filter(a => a.typeId === id).length;
    if (used) return { ok: false, why: `已有 ${used} 份作業使用，只能停用（保留歷史）` };
    return { ok: true };
};
export const typeName = (c, typeId) => c?.hwTypes?.find(t => t.id === typeId)?.name ?? '（已刪除類別）';

export const makeAssignment = ({ classId, typeId, title = '', note = '', assignedDate, dueDate = null }, { uid, now }) => {
    if (!typeId) throw new Error('請選擇作業類別');
    if (!assignedDate) throw new Error('請選擇日期');
    if (dueDate && dueDate < assignedDate) throw new Error('期限不能早於指派日期');
    return { id: uid(), classId, typeId, title: String(title).trim(), note: String(note).trim(), assignedDate, dueDate: dueDate || null, archived: false, createdAt: now, updatedAt: now };
};

/** 複製某天的作業到另一天（期限依原本間隔平移） */
export const copyAssignments = (assignments, fromDate, toDate, addDays, daysBetween, ctx) => assignments
    .filter(a => a.assignedDate === fromDate && !a.archived)
    .map(a => makeAssignment({ classId: a.classId, typeId: a.typeId, title: a.title, note: a.note, assignedDate: toDate,
        dueDate: a.dueDate ? addDays(toDate, daysBetween(a.assignedDate, a.dueDate)) : null }, ctx));

/**
 * 今天最近一批、尚未復原的批次（由事件推算，所以切換分頁或重新整理後仍可復原）。
 * 回傳 { batchId, n, field, value } 或 null
 */
export const lastUndoableBatch = (hwEvents, today) => {
    const undone = new Set(hwEvents.filter(e => e.undoOfBatch).map(e => e.undoOfBatch));
    let best = null;
    for (const e of hwEvents) {
        if (!e.batchId || e.batchId.startsWith('undo-') || e.date !== today || undone.has(e.batchId)) continue;
        if (!best || e.ts > best.ts || (e.ts === best.ts && e.id > best.id)) best = e;
    }
    if (!best) return null;
    const n = hwEvents.filter(e => e.batchId === best.batchId).length;
    return { batchId: best.batchId, n, field: best.field, value: best.value };
};
