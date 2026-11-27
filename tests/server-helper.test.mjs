// v6.2 後端：小老師登記全班作業（權限、驗證、冪等、收件匣、發布後的覆蓋規則）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedClass, publish, TEACHER_B } from './helpers/server-harness.mjs';
import { buildClassProjection } from '../src/core/student-projection.js';
import { classData } from './helpers/v62-fixture.mjs';

const setHelper = (H, A, sid, helper) => H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${A.accounts.get(sid).accountId}/helper`, { helper });
const register = (H, s, body) => H.s(s, 'POST', '/api/student/helper/register', { assignmentId: 'hw-a2', state: 'missing', idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`, ...body });
const inbox = (H, A, after = 0) => H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/homework-registrations?after=${after}`);

const setup = async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const helper = await H.activate(A.accounts.get('cls-a-s3'));
    return { H, A, helper };
};

test('only accounts the teacher marked as 小老師 can see or register; turning it off takes effect immediately', async () => {
    const { H, A, helper } = await setup();
    assert.equal((await H.s(helper, 'GET', '/api/student/helper')).statusCode, 403);
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'] })).statusCode, 403);
    assert.equal((await H.s(helper, 'GET', '/api/student/me')).json().helper, false);
    const on = await setHelper(H, A, 'cls-a-s3', true);
    assert.equal(on.statusCode, 200); assert.equal(on.json().helper, true);
    assert.equal((await H.s(helper, 'GET', '/api/student/me')).json().helper, true);
    assert.equal((await H.s(helper, 'GET', '/api/student/helper')).statusCode, 200);
    await setHelper(H, A, 'cls-a-s3', false);
    assert.equal((await H.s(helper, 'GET', '/api/student/helper')).statusCode, 403, 'no re-login needed to lose the permission');
    // 其他老師不能指定別班的小老師
    const tB = await H.teacherSession(TEACHER_B);
    assert.equal((await H.t(tB, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${A.accounts.get('cls-a-s3').accountId}/helper`, { helper: true })).statusCode, 404);
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${A.accounts.get('cls-a-s3').accountId}/helper`, { helper: 'yes' })).statusCode, 400);
});

test('the helper view lists classmates and states only — no scores, hearts or other classes', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    const v = (await H.s(helper, 'GET', '/api/student/helper')).json();
    assert.equal(v.selfId, 'cls-a-s3');
    assert.deepEqual(v.students.map(s => s.seat), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(Object.keys(v.students[0]).sort(), ['name', 'seat', 'studentId']);
    assert.deepEqual(v.assignments.map(a => a.assignmentId).sort(), ['hw-a1', 'hw-a2']);
    const text = JSON.stringify(v);
    for (const bad of ['score', 'earned', 'heart', 'cls-b', '測試趙小乙', 'groupId', 'xp']) assert.ok(!text.includes(bad), `helper view leaks ${bad}`);
    assert.ok(['submitted', 'missing', 'needs', 'done', 'unchecked', 'exempt'].includes(v.states['hw-a1']['cls-a-s1']));
});

test('registration rules: not yourself, only classmates on the list, known homework, valid state, CSRF, no extra fields', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s3'] })).json().error, 'self');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1', 'cls-a-s3'] })).statusCode, 403, 'self hidden inside a batch');
    assert.equal((await register(H, helper, { studentIds: ['cls-b-s1'] })).statusCode, 400, 'other class');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s8'] })).statusCode, 400, 'removed student (not published)');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'], assignmentId: 'hw-b1' })).statusCode, 404, 'other class homework');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'], assignmentId: 'hw-a-arch' })).statusCode, 404, 'archived homework');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'], state: 'exempt' })).statusCode, 400, '免交 is teacher-only');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'], classId: 'cls-b' })).statusCode, 400, 'extra identity field');
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1', 'cls-a-s1'] })).statusCode, 400, 'duplicates');
    assert.equal((await H.s({ ...helper, csrf: 'wrong-csrf-token-value' }, 'POST', '/api/student/helper/register', { assignmentId: 'hw-a2', studentIds: ['cls-a-s1'], state: 'missing', idempotencyKey: 'csrf-test-1' })).statusCode, 403);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM hw_registrations').get().n, 0, 'nothing was stored');
    // 一般學生（非小老師）也不能
    const other = await H.activate(A.accounts.get('cls-a-s1'));
    assert.equal((await register(H, other, { studentIds: ['cls-a-s2'] })).statusCode, 403);
});

test('a registration shows up for the helper at once, is idempotent, and reaches the teacher inbox with local ids', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    const r = await register(H, helper, { studentIds: ['cls-a-s1', 'cls-a-s2'], state: 'needs', idempotencyKey: 'batch-key-0001' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().states['cls-a-s1'], r.json().states['cls-a-s2']], ['needs', 'needs']);
    const again = await register(H, helper, { studentIds: ['cls-a-s1', 'cls-a-s2'], state: 'needs', idempotencyKey: 'batch-key-0001' });
    assert.deepEqual([again.json().replay, H.db.prepare('SELECT COUNT(*) n FROM hw_registrations').get().n], [true, 2]);
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'], state: 'done', idempotencyKey: 'batch-key-0001' })).statusCode, 409);
    const box = (await inbox(H, A)).json();
    assert.deepEqual(box.registrations.map(x => [x.studentId, x.state, x.helperStudentId, x.helperSeat]), [['cls-a-s1', 'needs', 'cls-a-s3', 3], ['cls-a-s2', 'needs', 'cls-a-s3', 3]]);
    assert.equal(box.registrations[0].createdAt, H.clock.t);
    assert.deepEqual((await inbox(H, A, box.next)).json().registrations, [], 'cursor');
    assert.equal((await H.t(await H.teacherSession(TEACHER_B), 'GET', `/api/teacher/classes/${A.classKey}/homework-registrations`)).statusCode, 404, 'other teacher');
    assert.equal((await H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/homework-registrations?after=-1`)).statusCode, 400);
});

test('after the teacher publishes with inboxSeq, the projection is the truth again (teacher edits win)', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    await register(H, helper, { studentIds: ['cls-a-s1'], state: 'missing' });
    const { next } = (await inbox(H, A)).json();
    // 老師收取後決定改成已訂正，重新發布（投影裡 s1 = done），並告訴後端已收取到 next
    const fx = A.fixture;
    fx.hwEvents.push({ id: 'tx1', classId: 'cls-a', assignmentId: 'hw-a2', studentId: 'cls-a-s1', field: 'submission', value: 'submitted', prevIds: [], ts: H.clock.t + 10, date: '2026-11-25' },
        { id: 'tx2', classId: 'cls-a', assignmentId: 'hw-a2', studentId: 'cls-a-s1', field: 'correction', value: 'done', prevIds: [], ts: H.clock.t + 11, date: '2026-11-25' });
    const p2 = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    const before = (await H.s(helper, 'GET', '/api/student/helper')).json().states['hw-a2']['cls-a-s1'];
    assert.equal(before, 'missing', 'pending registration overlays the old projection');
    const pub = await H.t(A.token, 'PUT', `/api/teacher/classes/${A.classKey}/projection`, { version: 2, hash: await (await import('../src/core/student-projection.js')).projectionHash(p2), projection: p2, inboxSeq: next });
    assert.equal(pub.statusCode, 200);
    assert.equal((await H.s(helper, 'GET', '/api/student/helper')).json().states['hw-a2']['cls-a-s1'], 'done');
    // 舊版教師端（沒有帶 inboxSeq）仍可發布
    assert.equal((await publish(H, A.token, A.classKey, p2, 3)).statusCode, 200);
});

test('per-helper daily registration cap', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    const ids = ['cls-a-s1', 'cls-a-s2', 'cls-a-s4', 'cls-a-s5', 'cls-a-s6', 'cls-a-s7'];
    H.db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 2998)
        INSERT INTO hw_registrations (id, class_id, helper_account_id, helper_local_id, assignment_id, local_student_id, state, local_date, idempotency_key, created_at)
        SELECT 'fill-' || value, ?, ?, 'cls-a-s3', 'hw-a2', 'cls-a-s1', 'missing', '2026-11-25', 'fill-' || value, 1 FROM n`).run(A.classKey, A.accounts.get('cls-a-s3').accountId);
    assert.equal((await register(H, helper, { studentIds: ids })).statusCode, 429);
    assert.equal((await register(H, helper, { studentIds: ids.slice(0, 2) })).statusCode, 200);
});

test('review fixes: inbox_seq never goes back, removed students lose helper powers, 免交 cannot be registered', async () => {
    const { H, A, helper } = await setup();
    await setHelper(H, A, 'cls-a-s3', true);
    await register(H, helper, { studentIds: ['cls-a-s1'], state: 'missing' });
    const { next } = (await inbox(H, A)).json();
    const fx = A.fixture;
    const p2 = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    const { projectionHash } = await import('../src/core/student-projection.js');
    await H.t(A.token, 'PUT', `/api/teacher/classes/${A.classKey}/projection`, { version: 2, hash: await projectionHash(p2), projection: p2, inboxSeq: next });
    await publish(H, A.token, A.classKey, p2, 3);                     // 舊版教師端（沒有 inboxSeq）
    assert.equal(H.db.prepare('SELECT inbox_seq FROM classes WHERE id = ?').get(A.classKey).inbox_seq, next, 'inbox_seq is not reset to 0');
    // 免交
    fx.hwEvents.push({ id: 'ex-1', classId: 'cls-a', assignmentId: 'hw-a2', studentId: 'cls-a-s2', field: 'submission', value: 'exempt', prevIds: [], ts: H.clock.t, date: '2026-11-25' });
    const p3 = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    await publish(H, A.token, A.classKey, p3, 4);
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s2'] })).json().error, 'exempt');
    // 小老師被移出名單（轉出）→ 不能再當小老師
    fx.students.find(s => s.id === 'cls-a-s3').removed = true;
    const p4 = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    await publish(H, A.token, A.classKey, p4, 5);
    assert.equal((await H.s(helper, 'GET', '/api/student/helper')).statusCode, 403);
    assert.equal((await register(H, helper, { studentIds: ['cls-a-s1'] })).statusCode, 403);
});
