// v6.2 作業：4 個按鈕（繳交／未繳交／未訂正／已訂正）、逾期自動愛心、小老師登記轉事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRecords, getRecord, buildSimpleChange, simpleState, buildUndoBatch, fillHomeworkDefaults } from '../src/core/homework.js';
import { accrualTimes, pendingIntervals, dueHomeworkHearts, withdrawnHomeworkHearts, heartId, isSchoolDay, autoHeartConfig } from '../src/core/hw-hearts.js';
import { lastUndoableBatch } from '../src/core/homework.js';
import { registrationsToEvents, regEventId } from '../src/core/hw-helper.js';

const T = (s) => Date.parse(`${s}+08:00`);               // 台北時間
const H = 3600_000;
const A = [{ id: 'a1', classId: 'c1', typeId: 't', title: 'L1', assignedDate: '2026-11-23', dueDate: null, archived: false }];
let n = 0;
const ctxAt = (now) => ({ uid: () => `u${String(++n).padStart(5, '0')}`, now, date: '2026-11-23', deviceId: 'dev-test' });
const apply = (events, sids, state, now, assignments = A) => {
    const recs = projectRecords(events, assignments);
    const out = buildSimpleChange({ hwEvents: events, assignments, records: recs, classId: 'c1', assignmentId: 'a1', studentIds: sids, state }, ctxAt(now));
    return { all: [...events, ...out.events], out };
};
const stateOf = (events, sid) => simpleState(getRecord(projectRecords(events, A), 'a1', sid));

// ------------------------------------------------------------------ 4 個按鈕
test('the four buttons map onto submission × correction and need at most two events', () => {
    let ev = [];
    ({ all: ev } = apply(ev, ['s1'], 'needs', T('2026-11-23T08:00:00')));
    assert.equal(stateOf(ev, 's1'), 'needs');
    assert.deepEqual(ev.map(e => [e.field, e.value]), [['submission', 'submitted'], ['correction', 'needs']]);
    assert.ok(ev[1].ts > ev[0].ts, 'correction event is ordered after the submission event');
    ({ all: ev } = apply(ev, ['s1'], 'done', T('2026-11-23T09:00:00')));
    assert.equal(stateOf(ev, 's1'), 'done');
    ({ all: ev } = apply(ev, ['s1'], 'submitted', T('2026-11-23T10:00:00')));
    assert.equal(stateOf(ev, 's1'), 'submitted');
    assert.equal(getRecord(projectRecords(ev, A), 'a1', 's1').correction, 'ungraded');
    ({ all: ev } = apply(ev, ['s1'], 'missing', T('2026-11-23T11:00:00')));
    assert.equal(stateOf(ev, 's1'), 'missing');
    assert.equal(getRecord(projectRecords(ev, A), 'a1', 's1').correction, null);
});

test('「繳交」keeps an existing 不需訂正, and pressing the current state again writes nothing', () => {
    const ev = [
        { id: 'x1', classId: 'c1', assignmentId: 'a1', studentId: 's1', field: 'submission', value: 'submitted', prevIds: [], ts: 1, date: '2026-11-23' },
        { id: 'x2', classId: 'c1', assignmentId: 'a1', studentId: 's1', field: 'correction', value: 'none', prevIds: [], ts: 2, date: '2026-11-23' },
    ];
    const { out } = apply(ev, ['s1'], 'submitted', 10);
    assert.deepEqual([out.events.length, out.unchanged], [0, 1]);
    const { out: o2 } = apply(ev, ['s1'], 'bogus', 10);
    assert.equal(o2.rejected.length, 1);
});

test('a batch of four buttons is one undoable batch (both fields reverted)', () => {
    let ev = [];
    const { all, out } = apply(ev, ['s1', 's2'], 'needs', T('2026-11-23T08:00:00'));
    ev = all;
    assert.ok(out.batchId && out.events.every(e => e.batchId === out.batchId));
    const undo = buildUndoBatch({ hwEvents: ev, records: projectRecords(ev, A), batchId: out.batchId }, ctxAt(T('2026-11-23T08:05:00')));
    ev = [...ev, ...undo.events];
    assert.deepEqual([stateOf(ev, 's1'), stateOf(ev, 's2')], ['unchecked', 'unchecked']);
});

// ------------------------------------------------------------------ 自動愛心
test('24 school hours: Friday 10:00 → next heart Monday 10:00; holidays are skipped too', () => {
    assert.equal(isSchoolDay('2026-11-27'), true);   // 週五
    assert.equal(isSchoolDay('2026-11-28'), false);  // 週六
    const fri = T('2026-11-27T10:00:00');
    assert.deepEqual(accrualTimes(fri, T('2026-12-01T23:00:00'), 24 * H), [T('2026-11-30T10:00:00'), T('2026-12-01T10:00:00')]);
    assert.deepEqual(accrualTimes(fri, T('2026-12-01T23:00:00'), 24 * H, new Set(['2026-11-30'])), [T('2026-12-01T10:00:00')]);
    assert.deepEqual(accrualTimes(fri, T('2026-11-30T09:59:59'), 24 * H), [], 'not yet');
    assert.deepEqual(accrualTimes(T('2026-11-23T08:00:00'), T('2026-11-23T20:00:00'), 4 * H).length, 3, 'a shorter period can accrue several times a day');
});

test('pending intervals follow the same rules as the record projection', () => {
    const e = (id, field, value, ts) => ({ id, classId: 'c1', assignmentId: 'a1', studentId: 's1', field, value, ts });
    const iv = pendingIntervals([e('1', 'submission', 'missing', 10), e('2', 'correction', 'needs', 15), e('3', 'submission', 'submitted', 20), e('4', 'correction', 'needs', 30), e('5', 'correction', 'done', 40), e('6', 'submission', 'bogus', 50)]);
    assert.deepEqual(iv, [{ state: 'missing', start: 10, end: 20, startId: '1' }, { state: 'needs', start: 30, end: 40, startId: '4' }], 'invalid events (correction while missing, unknown value) are ignored');
    assert.deepEqual(pendingIntervals([e('1', 'submission', 'missing', 10)]), [{ state: 'missing', start: 10, end: null, startId: '1' }]);
});

const cls = (o = {}) => ({ id: 'c1', hwAutoHeart: { enabled: true, hours: 24, holidays: [], since: T('2026-11-01T00:00:00'), ...o } });
const due = (events, now, opts = {}) => dueHomeworkHearts({ cls: cls(opts.cfg), hwEvents: events, assignments: opts.assignments || A, studentIds: ['s1', 's2'], existingIds: opts.existing || new Set(), now });

test('a heart every school day while still 未繳交; ids are stable so re-running adds nothing', () => {
    const { all: ev } = apply([], ['s1'], 'missing', T('2026-11-23T08:00:00'));      // 週一 08:00
    const list = due(ev, T('2026-11-26T09:00:00'));                                   // 週四 09:00
    assert.deepEqual(list.map(x => x.accruedAt), [T('2026-11-24T08:00:00'), T('2026-11-25T08:00:00'), T('2026-11-26T08:00:00')]);
    assert.deepEqual(list.map(x => x.n), [1, 2, 3]);
    assert.equal(list[0].id, heartId(ev[0].id, 1));
    assert.deepEqual(due(ev, T('2026-11-26T09:00:00'), { existing: new Set(list.map(x => x.id)) }), [], 'idempotent');
    assert.deepEqual(due(ev, T('2026-11-26T09:00:00'), { existing: new Set([list[0].id]) }).map(x => x.n), [2, 3], 'a heart the teacher removed is never re-added');
});

test('after 繳交 the clock stops (hearts already given are kept); 未訂正 starts a new clock', () => {
    let ev; ({ all: ev } = apply([], ['s1'], 'missing', T('2026-11-23T08:00:00')));
    ({ all: ev } = apply(ev, ['s1'], 'submitted', T('2026-11-25T12:00:00')));
    assert.equal(due(ev, T('2026-12-04T12:00:00')).length, 2, 'Tue + Wed 08:00 only');
    ({ all: ev } = apply(ev, ['s1'], 'needs', T('2026-11-26T09:00:00')));
    const list = due(ev, T('2026-11-27T10:00:00'));
    assert.deepEqual(list.filter(x => x.state === 'needs').map(x => x.accruedAt), [T('2026-11-27T09:00:00') + 1], 'the correction event is 1 ms after its submission event');
});

test('no hearts when disabled, before the start time, for archived homework or removed students', () => {
    const { all: ev } = apply([], ['s1'], 'missing', T('2026-11-23T08:00:00'));
    const now = T('2026-11-26T09:00:00');
    assert.equal(due(ev, now, { cfg: { enabled: false } }).length, 0);
    assert.equal(due(ev, now, { cfg: { since: T('2026-11-24T12:00:00') } }).length, 0, 'BUG-028: a wait that began before the rule was switched on is never counted');
    assert.equal(due(ev, now, { cfg: { since: undefined } }).length, 0, 'no start time → nothing (never back-fills old data)');
    assert.equal(due(ev, now, { assignments: [{ ...A[0], archived: true }] }).length, 0);
    assert.equal(dueHomeworkHearts({ cls: cls(), hwEvents: ev, assignments: A, studentIds: ['s2'], existingIds: new Set(), now }).length, 0);
    assert.equal(due(ev, now, { cfg: { hours: 72 } }).length, 1, 'configurable period');
    assert.equal(autoHeartConfig({ hwAutoHeart: { hours: 9999 } }).hours, 168);
});

test('class defaults: new and upgraded classes get the rule switched on from now (no back-fill)', () => {
    const c = {}; const before = Date.now();
    const fill = (k, v) => { if (c[k] === undefined) { c[k] = v; return true; } return false; };
    assert.equal(fillHomeworkDefaults(c, fill), true);
    assert.equal(c.hwAutoHeart.enabled, true); assert.equal(c.hwAutoHeart.hours, 24);
    assert.ok(c.hwAutoHeart.since >= before);
    assert.equal(fillHomeworkDefaults(c, fill), false, 'existing settings are kept');
});

// ------------------------------------------------------------------ 小老師登記 → 作業事件
const reg = (id, studentId, state, createdAt, extra = {}) => ({ id, seq: Number(id.replace(/\D/g, '')) || 1, assignmentId: 'a1', studentId, state, createdAt, helperSeat: 3, ...extra });

test('helper registrations become ordinary homework events at the registration time, once', () => {
    const regs = [reg('r1', 's1', 'missing', T('2026-11-23T08:00:00')), reg('r2', 's2', 'needs', T('2026-11-23T08:01:00'))];
    const out = registrationsToEvents({ regs, hwEvents: [], assignments: A, studentIds: ['s1', 's2'], classId: 'c1' });
    assert.equal(out.applied, 2);
    assert.deepEqual(out.events.map(e => e.id), [regEventId('r1', 1), regEventId('r2', 1), regEventId('r2', 2)]);
    assert.equal(out.events[0].ts, T('2026-11-23T08:00:00'));
    assert.equal(out.events[0].reason, '小老師 3號登記');
    assert.equal(stateOf(out.events, 's1'), 'missing'); assert.equal(stateOf(out.events, 's2'), 'needs');
    const again = registrationsToEvents({ regs, hwEvents: out.events, assignments: A, studentIds: ['s1', 's2'], classId: 'c1' });
    assert.deepEqual([again.events.length, again.applied], [0, 0], 'pulling twice adds nothing');
    // 逾期愛心從小老師登記的那一刻開始算
    assert.equal(due(out.events, T('2026-11-24T08:00:00')).filter(x => x.studentId === 's1').length, 1);
});

test('a later teacher edit wins; unknown homework, other students and archived homework are skipped', () => {
    const teacher = apply([], ['s1'], 'submitted', T('2026-11-23T09:00:00')).all;
    const regs = [reg('r1', 's1', 'missing', T('2026-11-23T08:30:00')), reg('r2', 'sX', 'missing', 5), reg('r3', 's2', 'missing', 6, { assignmentId: 'nope' }), reg('r4', 's2', 'weird', 7)];
    const out = registrationsToEvents({ regs, hwEvents: teacher, assignments: A, studentIds: ['s1', 's2'], classId: 'c1' });
    assert.equal(out.events.length, 0);
    assert.deepEqual(out.skipped.map(s => s.why), ['學生不在名單上', '作業不存在或已封存', '格式不正確', '老師之後已經改過']);
    const archived = registrationsToEvents({ regs: [reg('r5', 's2', 'missing', 9)], hwEvents: [], assignments: [{ ...A[0], archived: true }], studentIds: ['s2'], classId: 'c1' });
    assert.equal(archived.events.length, 0);
});

test('BUG-027: a heart given before an earlier registration arrived is withdrawn; hearts earned before the work was handed in stay', () => {
    let ev; ({ all: ev } = apply([], ['s1'], 'missing', T('2026-11-23T08:00:00')));
    const given = due(ev, T('2026-11-25T09:00:00')).map(d => ({ id: d.id, accruedAt: d.accruedAt }));   // 週二、週三 08:00 各一顆
    assert.equal(given.length, 2);
    // 之後才收到小老師在週二 07:00 登記的「繳交」→ 週二 08:00 起的兩顆都不該存在
    const late = registrationsToEvents({ regs: [reg('r9', 's1', 'submitted', T('2026-11-24T07:00:00'))], hwEvents: ev, assignments: A, studentIds: ['s1'], classId: 'c1' });
    assert.equal(late.applied, 1);
    const all = [...ev, ...late.events];
    assert.deepEqual(withdrawnHomeworkHearts({ cls: cls(), hwEvents: all, autoHearts: given, now: T('2026-11-25T09:00:00') }).map(h => h.id), given.map(h => h.id));
    // 週三 12:00 才繳交：週二、週三 08:00 的兩顆保留
    const { all: ev2 } = apply(ev, ['s1'], 'submitted', T('2026-11-25T12:00:00'));
    assert.deepEqual(withdrawnHomeworkHearts({ cls: cls(), hwEvents: ev2, autoHearts: given, now: T('2026-11-26T09:00:00') }), []);
    // 老師撤銷過、或之後改了時數設定：不會被撤回
    assert.deepEqual(withdrawnHomeworkHearts({ cls: cls({ hours: 72 }), hwEvents: ev2, autoHearts: given, now: T('2026-11-26T09:00:00') }), []);
    assert.deepEqual(withdrawnHomeworkHearts({ cls: cls(), hwEvents: all, autoHearts: given.map(h => ({ ...h, undone: true })), now: T('2026-11-26T09:00:00') }), []);
});

test('BUG-029: a helper registration never overrides the teacher’s 免交', () => {
    const ev = [{ id: 'ex1', classId: 'c1', assignmentId: 'a1', studentId: 's1', field: 'submission', value: 'exempt', prevIds: [], ts: 5, date: '2026-11-23' }];
    const out = registrationsToEvents({ regs: [reg('r1', 's1', 'missing', 100)], hwEvents: ev, assignments: A, studentIds: ['s1'], classId: 'c1' });
    assert.deepEqual([out.events.length, out.skipped[0].why], [0, '老師設為免交']);
});

test('BUG-030: the undo button counts students, not events (未訂正 writes two events per student)', () => {
    const now = Date.parse('2026-11-23T08:00:00+08:00');
    const { all } = apply([], ['s1', 's2', 's3'], 'needs', now);
    assert.equal(lastUndoableBatch(all, '2026-11-23').n, 3);
});

test('large pulls stay fast (each registration recomputes only its own cell)', () => {
    const sids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...A[0], id: `a${i}` }));
    const regs = [];
    for (let k = 0; k < 3000; k++) regs.push({ id: `r${k}`, seq: k + 1, assignmentId: `a${k % 60}`, studentId: sids[Math.floor(k / 60) % 30], state: ['missing', 'submitted', 'needs', 'done'][Math.floor(k / 7) % 4], createdAt: 1000 + k, helperSeat: 1 });
    const t0 = performance.now();
    const out = registrationsToEvents({ regs, hwEvents: [], assignments: many, studentIds: sids, classId: 'c1' });
    assert.ok(out.applied > 1000);
    assert.ok(performance.now() - t0 < 3000, `took ${Math.round(performance.now() - t0)} ms`);
});
