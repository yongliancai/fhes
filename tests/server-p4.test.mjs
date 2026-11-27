// v6.2 多班級 P4：同一位學生在 3 個班（2 位老師），分數、作業、XP、收藏、照顧、小老師、收件匣完全獨立。
// 三個班都用正式流程加入：甲班＝老師發的帳號；乙班＝乙老師印的個別綁定碼；丙班＝甲老師另一班的邀請碼＋核准。全部合成資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedClass, publish, TEACHER_B } from './helpers/server-harness.mjs';
import { buildFixture, classData } from './helpers/v62-fixture.mjs';
import { buildClassProjection } from '../src/core/student-projection.js';

const TODAY = '2026-11-25';
const key = (tag) => `${tag}-${Math.random().toString(36).slice(2, 12)}`.replace(/[^A-Za-z0-9_-]/g, '');
const memberId = (C, local) => C.accounts.get(local).accountId;

/**
 * A：甲老師 cls-a，X＝cls-a-s1（老師發的帳號，第 1 組：land-01、land-02）
 * B：乙老師 cls-a（改名「合成乙老師班」），X 用綁定碼成為 cls-a-s4（第 2 組：ocean-01、sp-1）
 * C：甲老師 cls-b，X 用邀請碼申請、老師核准成 cls-b-s1（第 1 組：sky-01）
 * 注意 A 和 B 的本機學生 ID 是同一組字串（cls-a-s1…）：只能靠班級分開。
 */
const threeClasses = async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    const fxB = buildFixture(); fxB.classes[0].name = '合成乙老師班';
    const B = await seedClass(H, { account: TEACHER_B, fixture: fxB });
    const C = await seedClass(H, { classId: 'cls-b' });
    const X = await H.activate(A.accounts.get('cls-a-s1'));
    const mA = memberId(A, 'cls-a-s1');

    // 乙班：先把原本發給 cls-a-s4 的帳號移出，再印綁定碼給 X
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/${memberId(B, 'cls-a-s4')}/remove`, {})).statusCode, 200);
    const cc = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s4' }] })).json().codes[0];
    const rb = await H.s(X, 'POST', '/api/student/redeem', { code: cc.code });
    assert.equal(rb.statusCode, 200, rb.body); assert.equal(rb.json().kind, 'claim');
    const mB = rb.json().id;

    // 丙班：邀請碼 → 待審 → 老師選 cls-b-s1 核准
    assert.equal((await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/accounts/${memberId(C, 'cls-b-s1')}/remove`, {})).statusCode, 200);
    const inv = (await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/invitations`, {})).json();
    const rc = await H.s(X, 'POST', '/api/student/redeem', { code: inv.code, displayName: '合成學生X' });
    assert.equal(rc.statusCode, 200, rc.body); assert.equal(rc.json().kind, 'invite');
    const reqs = (await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/join-requests`)).json().requests;
    assert.equal(reqs.length, 1);
    const ap = await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/join-requests/${reqs[0].id}/approve`, { localStudentId: 'cls-b-s1' });
    assert.equal(ap.statusCode, 200, ap.body);
    const mC = ap.json().accountId;

    const me = (await H.s(X, 'GET', '/api/student/me')).json();
    assert.deepEqual(me.classes.map(c => c.id).sort(), [mA, mB, mC].sort(), 'X is in exactly three classes');
    return { H, A, B, C, X, mA, mB, mC, M: { A: mA, B: mB, C: mC } };
};
const get = (H, X, m, sub) => H.s(X, 'GET', `/api/student/classes/${m}/${sub}`);
const care = (H, X, m, itemId, k = key('care')) => H.s(X, 'POST', `/api/student/classes/${m}/care`, { itemId, action: 'feed', idempotencyKey: k });
const setHelper = (H, C, m, helper) => H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/accounts/${m}/helper`, { helper });
const register = (H, X, m, body) => H.s(X, 'POST', `/api/student/classes/${m}/helper/register`, { assignmentId: 'hw-a2', state: 'missing', idempotencyKey: key('reg'), ...body });
const inbox = async (H, C) => (await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/homework-registrations`)).json();
const careTotal = async (H, C) => Object.fromEntries((await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/care-summary`)).json().groups.map(g => [g.groupId, g.care.total]));

test('P4: three classes show three different scores, homework, XP and collections — each exactly what that class published', async () => {
    const { H, A, B, C, X, M } = await threeClasses();
    const want = { A: [A, 'cls-a-s1'], B: [B, 'cls-a-s4'], C: [C, 'cls-b-s1'] };
    const seen = {};
    for (const [k, [cls, local]] of Object.entries(want)) {
        const p = cls.projection.students.find(s => s.studentId === local);
        const g = cls.projection.groups.find(x => x.groupId === p.groupId);
        const d = (await get(H, X, M[k], 'dashboard')).json();
        const hw = (await get(H, X, M[k], 'homework')).json();
        const zoo = (await get(H, X, M[k], 'zoo')).json();
        assert.equal(d.className, cls.projection.className, `${k}: class name`);
        assert.deepEqual([d.me.name, d.me.seat, d.me.score], [p.name, p.seat, p.score], `${k}: score`);
        assert.deepEqual(hw.homework, p.homework, `${k}: homework`);
        assert.equal(d.group.xp, g.xp, `${k}: group XP`); assert.deepEqual(zoo.group.xp, g.xp);
        assert.deepEqual(zoo.group.animals, g.animals, `${k}: collection`);
        seen[k] = { score: d.me.score, hw: JSON.stringify(hw.homework), animals: zoo.group.animals.map(a => a.itemId).join(), xp: JSON.stringify(g.xp) };
    }
    for (const f of ['score', 'hw', 'animals', 'xp']) assert.equal(new Set(Object.values(seen).map(s => s[f])).size, 3, `${f} differs in all three classes`);
    // 每一班的回應都不含另外兩班的作業標題、動物、名字或 classKey
    const foreign = {
        A: [...C.projection.students.map(s => s.name), 'hw-b1', 'sky-01', B.projection.className, B.classKey, C.classKey],
        B: [...C.projection.students.map(s => s.name), 'hw-b1', 'sky-01', 'land-01', A.projection.className, A.classKey, C.classKey],
        C: ['測試王小明', '測試林小強', 'hw-a1', 'land-01', 'ocean-01', A.projection.className, B.projection.className, A.classKey, B.classKey],
    };
    for (const [k, words] of Object.entries(foreign)) {
        for (const sub of ['dashboard', 'homework', 'zoo']) {
            const body = (await get(H, X, M[k], sub)).body;
            for (const w of words) assert.ok(!body.includes(w), `${k}/${sub} leaked ${w}`);
        }
    }
});

test('P4: care 3+3+3 — three counted in each class, the fourth in each is not; each teacher sees only their own class’s care', async () => {
    const { H, A, B, C, X, M } = await threeClasses();
    const animal = { A: 'land-01', B: 'ocean-01', C: 'sky-01' };
    // 三個班交錯、同時送出（每班 5 次），每班剛好 3 次計入
    const reqs = [];
    for (let i = 0; i < 5; i++) for (const k of ['A', 'B', 'C']) reqs.push(care(H, X, M[k], animal[k]).then(r => [k, r.json().counted]));
    const out = await Promise.all(reqs);
    for (const k of ['A', 'B', 'C']) assert.equal(out.filter(([kk, c]) => kk === k && c).length, 3, `class ${k}: 3 counted`);
    for (const k of ['A', 'B', 'C']) assert.deepEqual((await get(H, X, M[k], 'zoo')).json().myToday, { used: 3, limit: 3 });
    assert.deepEqual(await careTotal(H, A), { 1: 3, 2: 0, 3: 0 });
    assert.deepEqual(await careTotal(H, B), { 1: 0, 2: 3, 3: 0 }, 'teacher B sees X’s care in group 2 only, not class A’s');
    assert.deepEqual(await careTotal(H, C), { 1: 3, 2: 0 });
    // 用 A 班的成員代號照顧 B、C 才有的動物 → 404，不記錄
    const before = H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n;
    for (const it of ['ocean-01', 'sky-01']) assert.equal((await care(H, X, M.A, it)).statusCode, 404);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, before);
    // 第二天：三班都重新有 3 次
    H.advance(24 * 3600_000);
    const X2 = await H.login(X.username, X.password);              // 閒置 24 小時，工作階段已過期
    for (const k of ['A', 'B', 'C']) assert.equal((await care(H, X2, M[k], animal[k])).json().counted, true);
});

test('P4: resending is idempotent per class — the same key in another class is a separate action, a replay never counts twice', async () => {
    const { H, X, M } = await threeClasses();
    const k = 'same-key-in-every-class';
    const a1 = (await care(H, X, M.A, 'land-01', k)).json();
    const a2 = (await care(H, X, M.A, 'land-01', k)).json();
    const b1 = (await care(H, X, M.B, 'ocean-01', k)).json();
    assert.deepEqual([a1.counted, a1.replay, a2.counted, a2.replay, b1.counted, b1.replay], [true, false, true, true, true, false]);
    assert.equal((await get(H, X, M.A, 'zoo')).json().myToday.used, 1, 'the replay in A did not use a second action');
    assert.equal((await care(H, X, M.A, 'land-02', k)).statusCode, 409, 'same key, different animal in the same class → conflict');
    assert.equal((await care(H, X, M.C, 'sky-01', k)).json().replay, false, 'a key used in A and B is still new in C');
});

test('P4: 小老師 only in class A — B and C refuse, A cannot register B’s students (same local ids), and only A’s teacher receives it', async () => {
    const { H, A, B, C, X, M } = await threeClasses();
    await setHelper(H, A, M.A, true);
    const me = (await H.s(X, 'GET', '/api/student/me')).json();
    assert.deepEqual(Object.fromEntries(me.classes.map(c => [c.id, c.helper])), { [M.A]: true, [M.B]: false, [M.C]: false });
    for (const k of ['B', 'C']) {
        const v = await get(H, X, M[k], 'helper');
        assert.equal(v.statusCode, 403, `${k}: not a helper there`); assert.equal(v.json().error, 'not_helper');
        assert.equal((await register(H, X, M[k], { studentIds: [k === 'B' ? 'cls-a-s2' : 'cls-b-s2'], assignmentId: k === 'B' ? 'hw-a2' : 'hw-b1' })).statusCode, 403);
    }
    // A 的小老師畫面只有 A 班的同學和作業
    const view = (await get(H, X, M.A, 'helper')).json();
    assert.deepEqual(view.students.map(s => s.studentId), A.projection.students.map(s => s.studentId).sort((x, y) => Number(x.split('s')[2]) - Number(y.split('s')[2])));
    assert.ok(!JSON.stringify(view).includes('hw-b1') && !JSON.stringify(view).includes('cls-b-'), 'nothing from class C');
    // 丙班的學生、丙班的作業 → 拒絕
    assert.equal((await register(H, X, M.A, { studentIds: ['cls-b-s2'] })).json().error, 'bad_student');
    assert.equal((await register(H, X, M.A, { studentIds: ['cls-a-s2'], assignmentId: 'hw-b1' })).statusCode, 404);
    // 'cls-a-s2' 在 A、B 兩班都有：用 A 的成員代號登記，只進 A 班老師的收件匣
    const ok = await register(H, X, M.A, { studentIds: ['cls-a-s2'] });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await inbox(H, A)).registrations.length, 1);
    assert.equal((await inbox(H, B)).registrations.length, 0, 'teacher B gets nothing although B also has a cls-a-s2');
    assert.equal((await inbox(H, C)).registrations.length, 0);
    // A 取消小老師 → 立刻失效；B 指定 → 只在 B 有效
    await setHelper(H, A, M.A, false);
    await setHelper(H, B, M.B, true);
    assert.equal((await get(H, X, M.A, 'helper')).statusCode, 403);
    assert.equal((await get(H, X, M.B, 'helper')).statusCode, 200);
    assert.equal((await get(H, X, M.C, 'helper')).statusCode, 403);
    // 別班老師不能指定（甲老師拿乙班的成員代號）
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${M.B}/helper`, { helper: true })).statusCode, 404);
});

test('P4: teacher edits win per class — A’s pending registration overlays only A; after A publishes with inboxSeq the projection is the truth; B is untouched', async () => {
    const { H, A, B, X, M } = await threeClasses();
    await setHelper(H, A, M.A, true); await setHelper(H, B, M.B, true);
    const stateIn = async (k, sid) => (await get(H, X, M[k], 'helper')).json().states['hw-a2'][sid];
    const bBefore = await stateIn('B', 'cls-a-s2');
    await register(H, X, M.A, { studentIds: ['cls-a-s2'], state: 'missing' });
    assert.equal(await stateIn('A', 'cls-a-s2'), 'missing', 'A shows the pending registration at once');
    assert.equal(await stateIn('B', 'cls-a-s2'), bBefore, 'B (same local id) is not affected');
    // 甲老師收取後決定這位同學其實交了而且訂正完，重新發布並告知已收取到哪裡
    const { next } = await inbox(H, A);
    A.fixture.hwEvents.push(
        { id: 'p4-1', classId: 'cls-a', assignmentId: 'hw-a2', studentId: 'cls-a-s2', field: 'submission', value: 'submitted', prevIds: [], ts: H.clock.t + 1, date: TODAY },
        { id: 'p4-2', classId: 'cls-a', assignmentId: 'hw-a2', studentId: 'cls-a-s2', field: 'correction', value: 'done', prevIds: [], ts: H.clock.t + 2, date: TODAY });
    const p2 = buildClassProjection(classData(A.fixture, 'cls-a'), { today: TODAY });
    const { projectionHash } = await import('../src/core/student-projection.js');
    assert.equal((await H.t(A.token, 'PUT', `/api/teacher/classes/${A.classKey}/projection`, { version: 2, hash: await projectionHash(p2), projection: p2, inboxSeq: next })).statusCode, 200);
    assert.equal(await stateIn('A', 'cls-a-s2'), 'done', 'teacher’s decision wins over the helper’s registration');
    assert.equal(await stateIn('B', 'cls-a-s2'), bBefore);
    // 乙班的登記不會被甲老師的 inboxSeq 吃掉
    await register(H, X, M.B, { studentIds: ['cls-a-s3'], state: 'missing' });
    assert.equal(await stateIn('B', 'cls-a-s3'), 'missing');
    assert.equal((await inbox(H, B)).registrations.length, 1);
});

test('P4: changing group in class C moves X’s zoo there only; today’s used actions and the old group’s history stay; A and B are unchanged', async () => {
    const { H, C, X, M } = await threeClasses();
    for (let i = 0; i < 2; i++) await care(H, X, M.C, 'sky-01');
    const zA = (await get(H, X, M.A, 'zoo')).json(); const zB = (await get(H, X, M.B, 'zoo')).json();
    C.fixture.students.find(s => s.id === 'cls-b-s1').group = 2;
    const p2 = buildClassProjection(classData(C.fixture, 'cls-b'), { today: TODAY });
    assert.equal((await publish(H, C.token, C.classKey, p2, 2)).statusCode, 200);
    const zC = (await get(H, X, M.C, 'zoo')).json();
    assert.equal(zC.group.groupId, 2); assert.deepEqual(zC.group.animals.map(a => a.itemId), ['sky-02']);
    assert.equal(zC.myToday.used, 2, 'moving group does not give extra actions today');
    assert.equal((await care(H, X, M.C, 'sky-01')).statusCode, 404, 'the old group’s animal is no longer X’s');
    assert.equal((await care(H, X, M.C, 'sky-02')).json().counted, true);
    assert.equal((await care(H, X, M.C, 'sky-02')).json().counted, false, '2 before + 1 after = 3');
    assert.deepEqual(await careTotal(H, C), { 1: 2, 2: 1 }, 'group 1 keeps its history');
    assert.deepEqual((await get(H, X, M.A, 'zoo')).json().group, zA.group);
    assert.deepEqual((await get(H, X, M.B, 'zoo')).json().group, zB.group);
    assert.equal((await care(H, X, M.A, 'land-01')).json().counted, true, 'A still has all 3 actions');
});

test('P4: leaving or being removed ends access at once; the teacher’s published data and care history stay; rejoining the same day gives no extra care', async () => {
    const { H, A, B, C, X, M } = await threeClasses();
    for (let i = 0; i < 3; i++) await care(H, X, M.C, 'sky-01');
    await setHelper(H, B, M.B, true);
    // 自己退出丙班
    assert.equal((await H.s(X, 'POST', `/api/student/classes/${M.C}/leave`, {})).statusCode, 200);
    for (const sub of ['dashboard', 'homework', 'zoo', 'helper']) assert.equal((await get(H, X, M.C, sub)).statusCode, 404, `C/${sub} after leaving`);
    assert.equal((await care(H, X, M.C, 'sky-01')).statusCode, 404);
    assert.deepEqual(await careTotal(H, C), { 1: 3, 2: 0 }, 'the teacher’s care statistics do not change');
    assert.equal((await get(H, X, M.A, 'dashboard')).statusCode, 200);
    assert.equal((await get(H, X, M.B, 'helper')).statusCode, 200, 'helper rights in B survive leaving C');
    // 乙老師把 X 移出；同一份投影再發布新版本仍然成功，投影裡那位本機學生的資料原封不動，只是 X 看不到了
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/${M.B}/remove`, {})).statusCode, 200);
    assert.equal((await publish(H, B.token, B.classKey, B.projection, 2)).statusCode, 200);
    assert.ok(H.db.prepare('SELECT 1 FROM student_projections WHERE class_id = ? AND local_student_id = ?').get(B.classKey, 'cls-a-s4'), 'projection row stays (teacher data)');
    for (const sub of ['dashboard', 'homework', 'zoo', 'helper']) assert.equal((await get(H, X, M.B, sub)).statusCode, 404, `B/${sub} after removal`);
    assert.equal((await register(H, X, M.B, { studentIds: ['cls-a-s2'] })).statusCode, 404);
    assert.deepEqual((await H.s(X, 'GET', '/api/student/me')).json().classes.map(c => c.id), [M.A]);
    assert.equal((await get(H, X, M.A, 'dashboard')).statusCode, 200, 'class A is untouched');
    // 同一天重新加入丙班（老師再核准同一位本機學生）：沿用同一筆成員資料，今天已用的照顧次數不會重來，小老師身分也不會回來
    const inv = (await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/invitations`, {})).json();
    assert.equal((await H.s(X, 'POST', '/api/student/redeem', { code: inv.code, displayName: '合成學生X' })).statusCode, 200);
    const rq = (await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/join-requests`)).json().requests[0];
    const back = (await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/join-requests/${rq.id}/approve`, { localStudentId: 'cls-b-s1' })).json();
    assert.equal(back.accountId, M.C, 'same member row as before');
    assert.equal(back.helper, false);
    assert.equal((await get(H, X, M.C, 'zoo')).json().myToday.used, 3);
    assert.equal((await care(H, X, M.C, 'sky-01')).json().counted, false, 'leave-and-rejoin does not reset today’s limit');
    // 甲老師把 X 從甲班的名單拿掉（轉出）但帳號還在：甲班顯示「還沒發布你的資料」，其他班不受影響
    A.fixture.students.find(s => s.id === 'cls-a-s1').removed = true;
    assert.equal((await publish(H, A.token, A.classKey, buildClassProjection(classData(A.fixture, 'cls-a'), { today: TODAY }), 2)).statusCode, 200);
    assert.equal((await get(H, X, M.A, 'dashboard')).json().published, false);
    assert.equal((await get(H, X, M.C, 'dashboard')).json().published, true);
});
