// v6.2 多班級 P2：教師自助註冊、班級邀請與加入申請、個別綁定碼、移出／退出、D3 重設申請與平台管理員。
// Gate：靠 Email、網域或邀請碼都拿不到別人班級的權限。全部合成資料、記憶體資料庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, migrationsUpTo, SCHEMA_VERSION } from '../server/src/db.mjs';
import { runAdminCli } from '../server/admin.mjs';
import { normalizeCode } from '../server/src/passwords.mjs';
import { makeHarness, seedClass, TEACHER_A, TEACHER_B, ADMIN, STUDENT_ORIGIN, TEACHER_ORIGIN } from './helpers/server-harness.mjs';

const DAY = 86400_000;
const STRANGER = Object.freeze({ sub: '100000000000000000077', email: 'new.teacher@elsewhere.example', name: '自助老師' });

/** 甲班（老師甲）＋乙班（老師乙，同一個本機班級 ID）；X＝甲班 cls-a-s1，已改好密碼 */
const world = async (opts) => {
    const H = await makeHarness(opts);
    const A = await seedClass(H);
    const B = await seedClass(H, { account: TEACHER_B });
    const X = await H.activate(A.accounts.get('cls-a-s1'));
    return { H, A, B, X };
};
const invite = async (H, C, body = {}) => (await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/invitations`, body)).json();
const join_ = (H, sess, code, displayName = '新同學', extra = {}) => H.s(sess, 'POST', '/api/student/join', { code, displayName, ...extra });
const requests = async (H, C) => (await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/join-requests`)).json().requests;
const approve = (H, C, id, localStudentId) => H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/join-requests/${id}/approve`, { localStudentId });
const removeLocal = async (H, C, localStudentId) => H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/accounts/${C.accounts.get(localStudentId).accountId}/remove`, {});
const myClasses = async (H, sess) => (await H.s(sess, 'GET', '/api/student/me')).json().classes;

// ------------------------------------------------------------------ 資料庫 v3 → v4
test('v3 → v4 migration: existing sessions survive, first-login state is backfilled, new tables exist; a failure rolls back to v3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fhes-p2-'));
    try {
        const file = join(dir, 'v3.db');
        const db = openDb(file, { upTo: 3 });
        const T = 1_790_000_000_000;
        db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('u_t_1', ?, ?), ('u_s_1', ?, ?), ('u_s_2', ?, ?), ('u_s_3', ?, ?)").run(T, T, T, T, T, T, T, T);
        db.prepare("INSERT INTO teachers (id, account_hash, created_at, user_id) VALUES ('t_1', 'h1', ?, 'u_t_1')").run(T);
        db.prepare("INSERT INTO classes (id, teacher_id, local_class_id, name, created_at) VALUES ('c_1', 't_1', 'cls', '甲', ?)").run(T);
        const cred = db.prepare('INSERT INTO password_credentials (user_id, username, password_hash, must_change, issued_by_class_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
        cred.run('u_s_1', 'aaa1111', 'x', 1, 'c_1', T, T);           // 從沒登入過
        cred.run('u_s_2', 'aaa2222', 'x', 0, 'c_1', T, T + 5);       // 改過密碼（一定登入過）
        cred.run('u_s_3', 'aaa3333', 'x', 1, 'c_1', T, T);           // 登入過但還沒改密碼
        const mem = db.prepare("INSERT INTO student_accounts (id, class_id, user_id, local_student_id, last_login_at, created_at, updated_at) VALUES (?, 'c_1', ?, ?, ?, ?, ?)");
        mem.run('s_1', 'u_s_1', 'st-1', null, T, T); mem.run('s_2', 'u_s_2', 'st-2', null, T, T); mem.run('s_3', 'u_s_3', 'st-3', T + 9, T, T);
        db.prepare("INSERT INTO sessions (id_hash, kind, subject_id, created_at, last_seen, expires_at) VALUES ('tsess', 'teacher', 't_1', ?, ?, ?), ('ssess', 'student', 'u_s_2', ?, ?, ?)").run(T, T, T + 9e9, T, T, T + 9e9);
        // 中途失敗 → 仍是 v3、什麼都沒變
        assert.throws(() => migrate(db, [...migrationsUpTo(3), `${migrationsUpTo(4)[3]}\nSELECT * FROM no_such_table;`]), /no_such_table/);
        assert.equal(db.pragma('user_version', { simple: true }), 3);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'class_invitations'").get().n, 0);
        db.close();
        const v4 = openDb(file);
        assert.equal(v4.pragma('user_version', { simple: true }), SCHEMA_VERSION);
        assert.deepEqual(v4.prepare('SELECT user_id, first_login_at FROM password_credentials ORDER BY user_id').all().map(r => [r.user_id, r.first_login_at]),
            [['u_s_1', null], ['u_s_2', T + 5], ['u_s_3', T + 9]]);
        assert.deepEqual(v4.prepare('SELECT id_hash, kind, revoked_at FROM sessions ORDER BY id_hash').all().map(r => [r.id_hash, r.kind, r.revoked_at]), [['ssess', 'student', null], ['tsess', 'teacher', null]], 'sessions are copied, not logged out');
        for (const t of ['class_invitations', 'join_requests', 'claim_codes', 'platform_admins', 'password_reset_requests']) assert.ok(v4.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
        assert.equal(v4.prepare('SELECT signup FROM teachers').get().signup, 'allowlist');
        assert.deepEqual(v4.pragma('foreign_key_check'), []);
        v4.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } }
});

// ------------------------------------------------------------------ 教師自助註冊（D5、T29）
test('signup: allowlist mode refuses unknown teachers; open mode lets any verified Google account in as a new, empty teacher; switching back takes it away', async () => {
    const closed = await makeHarness();
    const ex = async (H, account, mutate) => { const t = await H.idToken({ account, mutate }); return H.app.inject({ method: 'POST', url: '/api/teacher/session', headers: { origin: TEACHER_ORIGIN }, payload: t }); };
    assert.equal((await ex(closed, STRANGER)).statusCode, 403);

    const H = await makeHarness({ config: { teacherSignup: 'open' } });
    const A = await seedClass(H);
    assert.equal((await ex(H, STRANGER, p => ({ ...p, email_verified: false }))).statusCode, 403, 'email must still be verified');
    const r = await ex(H, STRANGER);
    assert.equal(r.statusCode, 200);
    const tok = r.json().token;
    assert.deepEqual(H.db.prepare('SELECT signup FROM teachers ORDER BY created_at, signup').all().map(x => x.signup).sort(), ['allowlist', 'self']);
    // 自助老師沒有任何班級權限：甲班的所有路由一律 404
    for (const [m, u] of [['GET', 'accounts'], ['GET', 'invitations'], ['GET', 'join-requests'], ['GET', 'care-summary'], ['POST', 'invitations'], ['POST', 'claim-codes']])
        assert.equal((await H.t(tok, m, `/api/teacher/classes/${A.classKey}/${u}`, m === 'POST' ? (u === 'claim-codes' ? { students: [{ localStudentId: 'cls-a-s1' }] } : {}) : undefined)).statusCode, 404, u);
    // 同一個本機班級 ID 開自己的班：完全獨立的新班級
    const mine = (await H.t(tok, 'POST', '/api/teacher/classes', { localClassId: 'cls-a', name: '我的班' })).json().classKey;
    assert.notEqual(mine, A.classKey);
    assert.deepEqual((await H.t(tok, 'GET', `/api/teacher/classes/${mine}/accounts`)).json().accounts, []);
    assert.ok(H.db.prepare("SELECT 1 FROM audit_events WHERE action = 'teacher.signup'").get());

    // 收回成 allowlist：同一個資料庫，名單外的自助老師不能再登入
    const back = await makeHarness();
    assert.equal((await ex(back, STRANGER)).statusCode, 403);
});

// ------------------------------------------------------------------ 邀請碼與加入申請（T25、T31）
test('invitation: the code is shown once and stored only as a hash; joining only creates a request; the teacher picks the local student', async () => {
    const { H, A, B, X } = await world();
    const inv = await invite(H, B);
    assert.match(inv.code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.ok(!JSON.stringify(H.db.prepare('SELECT * FROM class_invitations').all()).includes(normalizeCode(inv.code)), 'code is not stored in plain text');
    const list = (await H.t(B.token, 'GET', `/api/teacher/classes/${B.classKey}/invitations`)).json();
    assert.ok(!JSON.stringify(list).includes(normalizeCode(inv.code)) && !JSON.stringify(list).includes(inv.code), 'listing never repeats the code');
    // 學生不能自己指定本機學生
    assert.equal((await join_(H, X, inv.code, '小明', { localStudentId: 'cls-a-s4' })).statusCode, 400);
    const j = await join_(H, X, ` ${inv.code.toUpperCase()} `, '  小明\u202e  ');
    assert.equal(j.statusCode, 200);
    assert.deepEqual(Object.keys(j.json()).sort(), ['className', 'kind', 'message', 'status']);
    for (const s of B.projection.students) assert.ok(!j.body.includes(s.name), 'no roster in the answer');
    assert.equal((await join_(H, X, inv.code, '小明')).statusCode, 200, 'sending twice is idempotent');
    assert.equal(H.db.prepare('SELECT used_count FROM class_invitations').get().used_count, 1);
    // 還沒核准：拿不到乙班任何東西
    assert.deepEqual((await myClasses(H, X)).map(c => c.className), [A.projection.className]);
    const reqs = await requests(H, B);
    assert.deepEqual(reqs.map(r => [r.displayName, r.seatHint]), [['小明', null]], 'name is cleaned (no direction override), teacher sees only what the student typed');
    // 綁到一位已經有帳號的學生 → 409；先移出舊帳號再核准
    assert.equal((await approve(H, B, reqs[0].id, 'cls-a-s4')).json().error, 'already_bound');
    assert.equal((await removeLocal(H, B, 'cls-a-s4')).statusCode, 200);
    const ok = await approve(H, B, reqs[0].id, 'cls-a-s4');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().username, null, 'teacher B never sees the username teacher A issued');
    assert.equal(ok.json().joinedVia, 'invite');
    const classes = await myClasses(H, X);
    assert.equal(classes.length, 2);
    const mB = classes.find(c => c.id === ok.json().accountId).id;
    const d = (await H.s(X, 'GET', `/api/student/classes/${mB}/dashboard`)).json();
    assert.equal(d.me.name, B.projection.students.find(s => s.studentId === 'cls-a-s4').name);
    assert.equal((await join_(H, X, inv.code, '小明')).json().error, 'already_member');
    assert.equal((await approve(H, B, reqs[0].id, 'cls-a-s5')).json().error, 'not_pending', 'a request is approved only once');
});

test('cross-teacher: teacher A cannot see, approve or reject requests for teacher B’s class, and cannot revoke B’s invitations', async () => {
    const { H, A, B, X } = await world();
    const inv = await invite(H, B);
    await join_(H, X, inv.code);
    const [r] = await requests(H, B);
    for (const [m, u, body] of [
        ['GET', `/api/teacher/classes/${B.classKey}/join-requests`],
        ['POST', `/api/teacher/classes/${B.classKey}/join-requests/${r.id}/approve`, { localStudentId: 'cls-a-s4' }],
        ['POST', `/api/teacher/classes/${B.classKey}/join-requests/${r.id}/reject`, {}],
        ['POST', `/api/teacher/classes/${B.classKey}/invitations/${inv.id}/revoke`, {}],
        ['GET', `/api/teacher/classes/${B.classKey}/invitations`],
    ]) assert.equal((await H.t(A.token, m, u, body)).statusCode, 404, `${m} ${u}`);
    // 用自己的 classKey 加上別班的申請 id
    assert.equal((await approve(H, A, r.id, 'cls-a-s2')).statusCode, 404);
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/invitations/${inv.id}/revoke`, {})).statusCode, 404);
    assert.equal(H.db.prepare("SELECT status FROM join_requests").get().status, 'pending');
    assert.equal(H.db.prepare('SELECT revoked_at FROM class_invitations').get().revoked_at, null);
});

test('concurrent approvals: the same request twice, or two requests for the same student, produce exactly one membership', async () => {
    const { H, A, B, X } = await world();
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    const inv = await invite(H, B);
    await join_(H, X, inv.code, 'X'); await join_(H, Y, inv.code, 'Y');
    await removeLocal(H, B, 'cls-a-s5'); await removeLocal(H, B, 'cls-a-s6');
    const [rx, ry] = await requests(H, B);
    const same = await Promise.all([approve(H, B, rx.id, 'cls-a-s5'), approve(H, B, rx.id, 'cls-a-s6')]);
    assert.deepEqual(same.map(r => r.statusCode).sort(), [200, 409]);
    const free = same[0].statusCode === 200 ? 'cls-a-s6' : 'cls-a-s5';
    const taken = free === 'cls-a-s6' ? 'cls-a-s5' : 'cls-a-s6';
    const race = await approve(H, B, ry.id, taken);
    assert.equal(race.json().error, 'already_bound');
    assert.equal((await approve(H, B, ry.id, free)).statusCode, 200);
    const live = H.db.prepare("SELECT local_student_id, COUNT(*) n FROM student_accounts WHERE class_id = ? AND status = 'active' GROUP BY local_student_id HAVING n > 1").all(B.classKey);
    assert.deepEqual(live, [], 'never two live members for one local student');
});

test('invitations: at most 3 live per class; revoked, expired and used-up codes stop working immediately', async () => {
    const { H, A, B } = await world();
    const students = await Promise.all(['cls-a-s2', 'cls-a-s3', 'cls-a-s4'].map(id => H.activate(A.accounts.get(id))));
    const i1 = await invite(H, B, { maxUses: 1 }); const i2 = await invite(H, B, { expiresInDays: 1 }); const i3 = await invite(H, B);
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/invitations`, {})).statusCode, 409);
    assert.equal((await join_(H, students[0], i1.code)).statusCode, 200);
    assert.equal((await join_(H, students[1], i1.code)).json().error, 'invalid_code', 'max uses reached');
    H.advance(DAY + 1);
    B.token = await H.teacherSession(TEACHER_B);
    const relog = await Promise.all(students.map(s => H.login(s.username, s.password)));
    students.splice(0, 3, ...relog);
    assert.equal((await join_(H, students[1], i2.code)).json().error, 'invalid_code', 'expired');
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/invitations/${i3.id}/revoke`, {})).json().revoked, true);
    assert.equal((await join_(H, students[2], i3.code)).json().error, 'invalid_code', 'revoked');
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/invitations`, {})).statusCode, 200, 'dead invitations no longer count toward the limit');
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/invitations`, { maxUses: 500 })).statusCode, 400);
});

test('brute force: 10 wrong codes lock that student out for 15 minutes (even with a right code); 50 per IP; other students are unaffected', async () => {
    const { H, A, B, X } = await world();
    const inv = await invite(H, B);
    for (let i = 0; i < 10; i++) assert.equal((await join_(H, X, `zzzzz-zzzz${'abcdefghjk'[i]}`)).statusCode, 404);
    const locked = await join_(H, X, inv.code);
    assert.equal(locked.statusCode, 429); assert.ok(Number(locked.headers['retry-after']) > 0);
    assert.equal((await H.s(X, 'POST', '/api/student/claim', { code: inv.code })).statusCode, 429, 'claim shares the same limit');
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    assert.equal((await join_(H, Y, inv.code)).statusCode, 200, 'another student is not locked');
    H.advance(15 * 60_000 + 1);
    assert.equal((await join_(H, X, inv.code)).statusCode, 200);
    // IP：不同學生、同一個 IP，合計 50 次錯誤（每個人都還沒到自己的 10 次）
    const others = await Promise.all(['cls-a-s3', 'cls-a-s4', 'cls-a-s5', 'cls-a-s6', 'cls-a-s7'].map(id => H.activate(A.accounts.get(id))));
    const from = (s, code, ip = '10.9.9.9') => H.app.inject({ method: 'POST', url: '/api/student/join', remoteAddress: ip, headers: { cookie: s.cookie, origin: STUDENT_ORIGIN, 'x-fhes-csrf': s.csrf }, payload: { code, displayName: 'n' } });
    for (let i = 0; i < 45; i++) assert.equal((await from(others[i % 5], 'yyyyy-yyyyy')).statusCode, 404);
    for (let i = 0; i < 5; i++) assert.equal((await from(X, 'yyyyy-yyyyy')).statusCode, 404);
    assert.equal((await from(Y, inv.code)).statusCode, 429, 'Y never typed a wrong code, but this IP is locked');
    assert.equal((await from(Y, inv.code, '10.1.1.1')).statusCode, 200, 'from another IP Y is fine');
    assert.equal(H.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'join.fail'").get().n, 60);
});

// ------------------------------------------------------------------ 個別綁定碼
test('claim codes: one-time, bound to the student the teacher chose, replaced when regenerated, refused for already-bound students', async () => {
    const { H, A, B, X } = await world();
    await removeLocal(H, B, 'cls-a-s3');
    const first = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s3' }, { localStudentId: 'cls-a-s2' }] })).json();
    assert.deepEqual([first.codes.map(c => c.localStudentId), first.existing], [['cls-a-s3'], ['cls-a-s2']]);
    const second = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s3' }] })).json();
    assert.equal((await H.s(X, 'POST', '/api/student/claim', { code: first.codes[0].code })).json().error, 'invalid_code', 'the older code was replaced');
    const ok = await H.s(X, 'POST', '/api/student/claim', { code: second.codes[0].code });
    assert.equal(ok.statusCode, 200);
    const d = (await H.s(X, 'GET', `/api/student/classes/${ok.json().id}/dashboard`)).json();
    assert.equal(d.me.name, B.projection.students.find(s => s.studentId === 'cls-a-s3').name);
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    assert.equal((await H.s(Y, 'POST', '/api/student/claim', { code: second.codes[0].code })).json().error, 'invalid_code', 'used once');
    // 過期
    await removeLocal(H, B, 'cls-a-s5');
    const late = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s5' }] })).json();
    H.advance(31 * DAY);
    const Y2 = await H.login(Y.username, Y.password);
    assert.equal((await H.s(Y2, 'POST', '/api/student/claim', { code: late.codes[0].code })).json().error, 'invalid_code');
    assert.ok(!JSON.stringify(H.db.prepare('SELECT * FROM claim_codes').all()).includes(normalizeCode(second.codes[0].code)));
});

// ------------------------------------------------------------------ 移出、退出（T31）
test('remove and leave take effect on the very next request, without touching the student’s other class; a removed student can be bound again', async () => {
    const { H, A, B, X } = await world();
    const mA = A.accounts.get('cls-a-s1').accountId;
    await removeLocal(H, B, 'cls-a-s4');
    const [cc] = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s4' }] })).json().codes;
    const mB = (await H.s(X, 'POST', '/api/student/claim', { code: cc.code })).json().id;
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/${mB}/remove`, {})).statusCode, 200);
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mB}/dashboard`)).statusCode, 404);
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mA}/dashboard`)).statusCode, 200);
    assert.ok(!(await H.t(B.token, 'GET', `/api/teacher/classes/${B.classKey}/accounts`)).json().accounts.some(a => a.accountId === mB));
    // 再綁一次（另一位本機學生）：同一筆成員資料重新啟用
    const [cc2] = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s4' }] })).json().codes;
    assert.equal((await H.s(X, 'POST', '/api/student/claim', { code: cc2.code })).json().id, mB);
    // 自己退出
    assert.equal((await H.s(X, 'POST', `/api/student/classes/${mB}/leave`, {})).statusCode, 200);
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mB}/zoo`)).statusCode, 404);
    assert.deepEqual((await myClasses(H, X)).map(c => c.id), [mA]);
    assert.equal((await H.s(X, 'POST', `/api/student/classes/${A.accounts.get('cls-a-s2').accountId}/leave`, {})).statusCode, 404, 'cannot make someone else leave');
    // 退出唯一的班級後仍可登入（之後可以再加入別班），但看不到任何班級資料
    assert.equal((await H.s(X, 'POST', `/api/student/classes/${mA}/leave`, {})).statusCode, 200);
    const again = await H.login(X.username, X.password);
    assert.equal(again.res.statusCode, 200);
    assert.deepEqual(await myClasses(H, again), []);
    assert.equal((await H.s(again, 'GET', '/api/student/dashboard')).json().error, 'no_class');
});

// ------------------------------------------------------------------ D3：重設密碼與管理員（T27、T34）
test('D3: a teacher can reissue a password only before its first sign-in; afterwards only an admin-approved request resets it', async () => {
    const { H, A } = await world();
    const fresh = A.accounts.get('cls-a-s2');
    const r1 = await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${fresh.accountId}/reset`, {});
    assert.equal(r1.statusCode, 200, 'lost slip before first sign-in → teacher can reissue');
    const s = await H.activate({ ...fresh, initialPassword: r1.json().initialPassword });
    const view = (await H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/accounts`)).json().accounts.find(a => a.accountId === fresh.accountId);
    assert.equal(view.signedInBefore, true);
    const r2 = await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${fresh.accountId}/reset`, {});
    assert.equal(r2.json().error, 'already_used');
    const req1 = (await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${fresh.accountId}/reset-request`, {})).json();
    assert.equal(req1.status, 'pending');
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${fresh.accountId}/reset-request`, {})).json().requestId, req1.requestId, 'one pending request per student');
    assert.equal((await H.s(s, 'GET', '/api/student/me')).statusCode, 200, 'a pending request changes nothing');
    // 老師（或另一位老師）不能自己核准
    assert.equal((await H.t(A.token, 'POST', `/api/admin/reset-requests/${req1.requestId}/approve`, {})).statusCode, 401);
    const adm = await H.adminSession();
    const list = (await H.app.inject({ method: 'GET', url: '/api/admin/reset-requests', headers: { authorization: `Bearer ${adm}` } })).json();
    assert.deepEqual(list.pending.map(p => [p.className, p.username, p.teacherCount]), [[A.projection.className, fresh.username, 1]]);
    for (const p of A.projection.students) assert.ok(!JSON.stringify(list).includes(p.name), 'admin view has no student names or scores');
    const ok = (await H.t(adm, 'POST', `/api/admin/reset-requests/${req1.requestId}/approve`, {})).json();
    assert.equal((await H.s(s, 'GET', '/api/student/me')).statusCode, 401, 'all sessions are revoked');
    const after = await H.login(fresh.username, ok.initialPassword);
    assert.equal(after.res.json().mustChangePassword, true);
    assert.equal((await H.t(adm, 'POST', `/api/admin/reset-requests/${req1.requestId}/approve`, {})).json().error, 'not_pending');
    assert.ok(H.db.prepare("SELECT 1 FROM audit_events WHERE action = 'reset.approve' AND actor_kind = 'admin'").get());
});

test('admin: only the configured owner, only by Google, tokens cannot be replayed, sessions end after 4 hours, and the API is off when no admin is configured', async () => {
    const H = await makeHarness();
    const ex = (t) => H.app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin: TEACHER_ORIGIN }, payload: t });
    assert.equal((await ex(await H.idToken({ account: TEACHER_A }))).json().error, 'not_admin', 'an allow-listed teacher is not an admin');
    assert.equal((await ex(await H.idToken({ account: ADMIN, mutate: p => ({ ...p, email_verified: false }) }))).statusCode, 403);
    const t = await H.idToken({ account: ADMIN });
    const first = await ex(t);
    assert.equal(first.statusCode, 200);
    assert.equal((await ex(t)).json().error, 'replayed');
    // 之後只認身分：同一個 email、不同的 Google 帳號（sub）不是管理員
    assert.equal((await ex(await H.idToken({ account: { ...ADMIN, sub: '100000000000000000098' } }))).json().error, 'not_admin');
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM platform_admins').get().n, 1);
    assert.equal((await ex(await H.idToken({ account: ADMIN, header: { alg: 'RS256', kid: 'fhes-test-kid-1', typ: 'JWT' }, key: H.keys.rogue.privateKey }))).statusCode, 401, 'forged signature');
    const tok = first.json().token;
    const get = (path, token = tok, origin) => H.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
    assert.equal((await get('/api/admin/teachers')).statusCode, 200);
    assert.equal((await get('/api/admin/teachers', tok, 'https://evil.example.test')).statusCode, 403, 'other origins are refused');
    const ac = (await get('/api/admin/audit')).json();
    assert.ok(ac.events.length > 0 && ac.events.every(e => !('ip_hash' in e) && !('ipHash' in e)));
    H.advance(4 * 3600_000 + 1);
    assert.equal((await get('/api/admin/teachers')).statusCode, 401);
    // 沒有設定管理員：整組 API 不存在
    const off = await makeHarness({ config: { adminEmails: [] } });
    assert.equal((await off.app.inject({ method: 'POST', url: '/api/admin/session', headers: { origin: TEACHER_ORIGIN }, payload: await off.idToken({ account: ADMIN }) })).statusCode, 404);
});

test('suspension (admin web or host CLI): the teacher is signed out at once, their invitations and claim codes stop working; unsuspend restores sign-in', async () => {
    const { H, A, B, X } = await world();
    const inv = await invite(H, B);
    await removeLocal(H, B, 'cls-a-s4');
    const [cc] = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s4' }] })).json().codes;
    const adm = await H.adminSession();
    const tB = H.db.prepare('SELECT teacher_id FROM classes WHERE id = ?').get(B.classKey).teacher_id;
    assert.equal((await H.t(adm, 'POST', `/api/admin/teachers/${tB}/suspend`, {})).json().status, 'suspended');
    assert.equal((await H.t(B.token, 'GET', `/api/teacher/classes/${B.classKey}/accounts`)).statusCode, 401);
    assert.equal((await join_(H, X, inv.code)).json().error, 'invalid_code');
    assert.equal((await H.s(X, 'POST', '/api/student/claim', { code: cc.code })).json().error, 'invalid_code');
    assert.equal((await H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/accounts`)).statusCode, 200, 'other teachers are not affected');
    await H.t(adm, 'POST', `/api/admin/teachers/${tB}/unsuspend`, {});
    assert.ok(await H.teacherSession(TEACHER_B));
    // 主機 CLI（網頁管理壞掉時的備援）
    const tok = await H.teacherSession(TEACHER_B);
    assert.equal(runAdminCli(H.db, ['suspend', tB]).code, 0);
    assert.equal((await H.t(tok, 'GET', `/api/teacher/classes/${B.classKey}/accounts`)).statusCode, 401);
    assert.match(runAdminCli(H.db, ['list-teachers']).out, new RegExp(`${tB}\tsuspended`));
    assert.equal(runAdminCli(H.db, ['suspend', 'not-an-id']).code, 2);
    assert.equal(runAdminCli(H.db, ['unsuspend', tB]).code, 0);
    assert.ok(H.db.prepare("SELECT 1 FROM audit_events WHERE actor_kind = 'cli' AND action = 'teacher.suspend'").get());
});

test('privacy: names typed into join requests are cleared after 30 days; the database never stores a code in plain text', async () => {
    const { H, A, B, X } = await world();
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    const inv = await invite(H, B, { expiresInDays: 30 });
    await join_(H, X, inv.code, '<img src=x>', { seatHint: 4 });
    H.advance(1000);
    await join_(H, Y, inv.code, '王小美');
    const dump = JSON.stringify(['class_invitations', 'join_requests', 'claim_codes', 'audit_events'].map(t => H.db.prepare(`SELECT * FROM ${t}`).all()));
    assert.ok(!dump.includes(normalizeCode(inv.code)) && !dump.includes(inv.code), 'no plain-text code anywhere');
    const reqs = await requests(H, B);
    assert.equal(reqs[0].displayName, '<img src=x>', 'stored and returned as plain text (the UI renders it with textContent)');
    await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/join-requests/${reqs[1].id}/reject`, {});
    H.advance(31 * DAY);
    B.token = await H.teacherSession(TEACHER_B);
    assert.deepEqual(await requests(H, B), []);
    assert.deepEqual(H.db.prepare('SELECT status, display_name, seat_hint FROM join_requests ORDER BY status').all().map(r => [r.status, r.display_name, r.seat_hint]), [['expired', '', null], ['rejected', '', null]]);
    const X2 = await H.login(X.username, X.password);
    assert.equal((await H.s(X2, 'POST', '/api/student/join', { code: inv.code, displayName: '   ' })).json().error, 'bad_name');
});
