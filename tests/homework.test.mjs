// 作業繳交／訂正（src/core/homework.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_HW_TYPES, fillHomeworkDefaults, projectRecords, getRecord, buildChangeEvents, buildUndoBatch, buildResolveEvent,
    assignmentStats, followUpLists, validateChange, addHwType, renameHwType, setHwTypeActive, canDeleteHwType, makeAssignment, copyAssignments, studentHistory,
} from '../src/core/homework.js';
import { ensureClassDefaults, registerClassDefaults } from '../src/core/classes.js';
import { addDays } from '../src/core/dates.js';

let n = 0; let clock = 1000;
const ctx = (over = {}) => ({ uid: () => `u${++n}`, now: (clock += 10), date: '2026-11-24', deviceId: 'devA', ...over });
const A = { id: 'A1', classId: 'c', typeId: 'hwt-02', assignedDate: '2026-11-24', dueDate: '2026-11-25' };
const kids = ['s1', 's2', 's3', 's4'];
const apply = (events, change, c = ctx()) => {
    const out = buildChangeEvents({ records: projectRecords(events, [A]), classId: 'c', assignmentId: 'A1', ...change }, c);
    events.push(...out.events);
    return out;
};

test('11 default homework types with fixed ids and names in the confirmed order', () => {
    assert.deepEqual(DEFAULT_HW_TYPES.map(t => t.name), ['國隨', '國習', '甲本', '乙本', '數課', '數講', '數練', '數重', '數習', '成語', '考卷']);
    assert.equal(new Set(DEFAULT_HW_TYPES.map(t => t.id)).size, 11);
    assert.ok(DEFAULT_HW_TYPES.every(t => t.builtin && t.active));
});
test('class defaults back-fill homework types once and keep teacher edits', () => {
    registerClassDefaults(fillHomeworkDefaults);
    const c = { id: 'c' };
    assert.equal(ensureClassDefaults(c), true);
    assert.equal(c.hwTypes.length, 11);
    assert.deepEqual(c.hwReward, { enabled: false, xp: 5 }, 'homework never links to XP by default');
    c.hwTypes[0].name = '國語隨堂';
    assert.equal(ensureClassDefaults(c), false);
    assert.equal(c.hwTypes[0].name, '國語隨堂');
});

test('unchecked is not missing: an untouched record is 未登記 and never appears in the missing list', () => {
    const recs = projectRecords([], [A]);
    assert.equal(getRecord(recs, 'A1', 's1').submission, 'unchecked');
    const lists = followUpLists(recs, [A], kids);
    assert.equal(lists.missing.length, 0);
    assert.equal(lists.unchecked.length, 4);
});

test('submitted is not corrected: submitting sets correction to 未批改, needs/done are separate', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1'], field: 'submission', value: 'submitted' });
    let r = getRecord(projectRecords(ev, [A]), 'A1', 's1');
    assert.equal(r.submission, 'submitted');
    assert.equal(r.correction, 'ungraded');
    apply(ev, { studentIds: ['s1'], field: 'correction', value: 'needs' });
    r = getRecord(projectRecords(ev, [A]), 'A1', 's1');
    assert.equal(r.correction, 'needs');
    assert.equal(r.correctedAt, null);
    apply(ev, { studentIds: ['s1'], field: 'correction', value: 'done' });
    r = getRecord(projectRecords(ev, [A]), 'A1', 's1');
    assert.equal(r.correction, 'done');
    assert.ok(r.correctedAt > 0, 'correction time is recorded');
});

test('correction cannot be set unless the homework was submitted (negative case)', () => {
    assert.match(validateChange(getRecord(new Map(), 'A1', 's1'), 'correction', 'needs'), /已交/);
    const out = buildChangeEvents({ records: new Map(), classId: 'c', assignmentId: 'A1', studentIds: ['s1'], field: 'correction', value: 'done' }, ctx());
    assert.equal(out.events.length, 0);
    assert.equal(out.rejected.length, 1);
});

test('late submission records the submission date and late flag', () => {
    const ev = [];
    apply(ev, { studentIds: ['s2'], field: 'submission', value: 'missing' });
    apply(ev, { studentIds: ['s2'], field: 'submission', value: 'submitted' }, ctx({ date: '2026-11-27' }));
    const r = getRecord(projectRecords(ev, [A]), 'A1', 's2');
    assert.equal(r.submittedDate, '2026-11-27');
    assert.equal(r.late, true);
});

test('repeating the same status does not create duplicate records', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'submitted' });
    const out = apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'submitted' });
    assert.equal(out.events.length, 0);
    assert.equal(out.unchanged, 2);
    assert.equal(ev.length, 2);
});

test('batch registration then undo restores every cell and keeps the history', () => {
    const ev = [];
    apply(ev, { studentIds: ['s4'], field: 'submission', value: 'exempt' });
    const batch = apply(ev, { studentIds: ['s1', 's2', 's3'], field: 'submission', value: 'submitted' });
    assert.ok(batch.batchId);
    let recs = projectRecords(ev, [A]);
    assert.equal(assignmentStats(recs, 'A1', kids).submitted, 3);
    const undo = buildUndoBatch({ hwEvents: ev, records: recs, batchId: batch.batchId }, ctx());
    assert.equal(undo.events.length, 3);
    ev.push(...undo.events);
    recs = projectRecords(ev, [A]);
    assert.deepEqual(kids.map(s => getRecord(recs, 'A1', s).submission), ['unchecked', 'unchecked', 'unchecked', 'exempt']);
    assert.equal(ev.length, 7, 'original events are kept; undo adds compensating events');
    const again = buildUndoBatch({ hwEvents: ev, records: recs, batchId: batch.batchId }, ctx());
    assert.equal(again.events.length, 0, 'a batch cannot be undone twice');
});

test('undo skips cells changed after the batch (later edits are never clobbered)', () => {
    const ev = [];
    const batch = apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'missing' });
    apply(ev, { studentIds: ['s2'], field: 'submission', value: 'submitted' });
    const undo = buildUndoBatch({ hwEvents: ev, records: projectRecords(ev, [A]), batchId: batch.batchId }, ctx());
    assert.equal(undo.events.length, 1);
    assert.deepEqual(undo.skipped.map(s => s.studentId), ['s2']);
});

test('statistics: denominators exclude exempt and unchecked; coverage and correction rate are separate', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'submitted' });
    apply(ev, { studentIds: ['s3'], field: 'submission', value: 'missing' });
    apply(ev, { studentIds: ['s1'], field: 'correction', value: 'needs' });
    apply(ev, { studentIds: ['s2'], field: 'correction', value: 'done' });
    const s = assignmentStats(projectRecords(ev, [A]), 'A1', [...kids, 's5']);
    // s4 免交、s5 未登記
    apply(ev, { studentIds: ['s4'], field: 'submission', value: 'exempt' });
    const s2 = assignmentStats(projectRecords(ev, [A]), 'A1', [...kids, 's5']);
    assert.equal(s.submitRate, 2 / 3);
    assert.equal(s2.submitRate, 2 / 3, 'exempt does not change the submit rate');
    assert.equal(s2.coverage, 4 / 5);
    assert.equal(s2.correctionRate, 1 / 2);
    assert.equal(s2.expected, 4);
    assert.equal(s2.allIn, false);
});

test('two devices editing the same cell offline produce a visible conflict, not a silent overwrite', () => {
    const base = [];
    apply(base, { studentIds: ['s1'], field: 'submission', value: 'missing' });
    const devA = [...base]; const devB = [...base];
    apply(devA, { studentIds: ['s1'], field: 'submission', value: 'submitted' }, ctx({ deviceId: 'A' }));
    apply(devB, { studentIds: ['s1'], field: 'submission', value: 'exempt' }, ctx({ deviceId: 'B' }));
    const merged = [...new Map([...devA, ...devB].map(e => [e.id, e])).values()];
    let r = getRecord(projectRecords(merged, [A]), 'A1', 's1');
    assert.ok(r.conflict, 'conflict detected');
    assert.equal(r.conflict.field, 'submission');
    assert.deepEqual(r.conflict.options.map(o => o.value).sort(), ['exempt', 'submitted']);
    // 老師選定「已交」→ 單一 head，衝突消失
    merged.push(buildResolveEvent({ records: projectRecords(merged, [A]), classId: 'c', assignmentId: 'A1', studentId: 's1', field: 'submission', value: 'submitted' }, ctx()));
    r = getRecord(projectRecords(merged, [A]), 'A1', 's1');
    assert.equal(r.conflict, null);
    assert.equal(r.submission, 'submitted');
});

test('same edit from two devices (same value) is not reported as a conflict', () => {
    const devA = []; const devB = [];
    apply(devA, { studentIds: ['s1'], field: 'submission', value: 'submitted' }, ctx({ deviceId: 'A' }));
    apply(devB, { studentIds: ['s1'], field: 'submission', value: 'submitted' }, ctx({ deviceId: 'B' }));
    assert.equal(getRecord(projectRecords([...devA, ...devB], [A]), 'A1', 's1').conflict, null);
});

test('projection is order-independent (sync can deliver events in any order)', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'submitted' });
    apply(ev, { studentIds: ['s1'], field: 'correction', value: 'needs' });
    apply(ev, { studentIds: ['s2'], field: 'submission', value: 'missing' });
    const a = projectRecords(ev, [A]); const b = projectRecords([...ev].reverse(), [A]);
    for (const s of ['s1', 's2']) {
        const { heads: _h1, eventIds: _e1, ...ra } = getRecord(a, 'A1', s);
        const { heads: _h2, eventIds: _e2, ...rb } = getRecord(b, 'A1', s);
        assert.deepEqual(ra, rb);
    }
});

test('moving submitted → missing clears the correction state (no orphan correction)', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1'], field: 'submission', value: 'submitted' });
    apply(ev, { studentIds: ['s1'], field: 'correction', value: 'needs' });
    apply(ev, { studentIds: ['s1'], field: 'submission', value: 'missing' });
    const r = getRecord(projectRecords(ev, [A]), 'A1', 's1');
    assert.equal(r.correction, null);
    assert.equal(followUpLists(projectRecords(ev, [A]), [A], ['s1']).needs.length, 0);
});

test('follow-up lists: missing and needs-correction are teacher lists; archived assignments are excluded', () => {
    const ev = [];
    apply(ev, { studentIds: ['s1'], field: 'submission', value: 'missing' });
    apply(ev, { studentIds: ['s2'], field: 'submission', value: 'submitted' });
    apply(ev, { studentIds: ['s2'], field: 'correction', value: 'needs' });
    const recs = projectRecords(ev, [A]);
    const l = followUpLists(recs, [A], kids);
    assert.deepEqual(l.missing.map(x => x.studentId), ['s1']);
    assert.deepEqual(l.needs.map(x => x.studentId), ['s2']);
    assert.equal(followUpLists(recs, [{ ...A, archived: true }], kids).missing.length, 0);
    assert.equal(studentHistory(ev, 's2').length, 2);
});

test('type management: add, rename (stable id), disable, delete rules', () => {
    const c = { hwTypes: DEFAULT_HW_TYPES.map(t => ({ ...t })) };
    const t = addHwType(c, '週記', 'hwt-x');
    assert.throws(() => addHwType(c, '週記', 'hwt-y'), /已經存在/);
    renameHwType(c, 'hwt-x', '週記本');
    assert.equal(c.hwTypes.find(x => x.id === 'hwt-x').name, '週記本');
    setHwTypeActive(c, 'hwt-01', false);
    assert.equal(c.hwTypes[0].active, false);
    assert.equal(canDeleteHwType(c, 'hwt-01', []).ok, false, 'builtin cannot be deleted');
    assert.equal(canDeleteHwType(c, t.id, [{ typeId: t.id }]).ok, false, 'used type cannot be deleted');
    assert.equal(canDeleteHwType(c, t.id, []).ok, true);
});

test('assignments: validation and copying a day keeps the due-date gap', () => {
    const c2 = { uid: () => `a${++n}`, now: 1 };
    assert.throws(() => makeAssignment({ classId: 'c', typeId: 'hwt-01', assignedDate: '2026-11-24', dueDate: '2026-11-20' }, c2), /期限/);
    const a = makeAssignment({ classId: 'c', typeId: 'hwt-01', title: ' L6 ', assignedDate: '2026-11-24', dueDate: '2026-11-26' }, c2);
    assert.equal(a.title, 'L6');
    const daysBetween = (x, y) => Math.round((Date.parse(y) - Date.parse(x)) / 86400000);
    const copies = copyAssignments([a], '2026-11-24', '2026-11-25', addDays, daysBetween, c2);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].assignedDate, '2026-11-25');
    assert.equal(copies[0].dueDate, '2026-11-27');
    assert.notEqual(copies[0].id, a.id);
});

test('last undoable batch is derived from stored events (survives reloads), today only, once', async () => {
    const { lastUndoableBatch } = await import('../src/core/homework.js');
    const ev = [];
    apply(ev, { studentIds: ['s1', 's2'], field: 'submission', value: 'submitted' });
    apply(ev, { studentIds: ['s3'], field: 'submission', value: 'missing' }); // single change: not a batch
    const b = lastUndoableBatch(ev, '2026-11-24');
    assert.equal(b.n, 2);
    assert.equal(b.value, 'submitted');
    assert.equal(lastUndoableBatch(ev, '2026-11-25'), null, 'only today');
    ev.push(...buildUndoBatch({ hwEvents: ev, records: projectRecords(ev, [A]), batchId: b.batchId }, ctx()).events);
    assert.equal(lastUndoableBatch(ev, '2026-11-24'), null, 'already undone');
});
