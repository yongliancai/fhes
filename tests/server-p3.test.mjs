// v6.2 多班級 P3：學生 Google 登入（D6，預設關閉）、連結與解除、用 Google 自己重設密碼、單一「輸入代碼」、我的班級／待確認。
// Gate：從別班的畫面讀不到任何個資；Google 身分不會被合併，也不會在學生和老師之間互換。全部合成資料、記憶體資料庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../server/src/db.mjs';
import { TEST_CLIENT_ID } from './helpers/fake-google.mjs';
import { makeHarness, seedClass, TEACHER_A, TEACHER_B, ADMIN, STUDENT_ORIGIN, TEACHER_ORIGIN } from './helpers/server-harness.mjs';

const KID1 = Object.freeze({ sub: '200000000000000000001', email: 'kid.one@example.test', name: '合成學生一' });
const KID2 = Object.freeze({ sub: '200000000000000000002', email: 'kid.two@example.test', name: '合成學生二' });
const COOKIE = '__Host-fhes_sid';

const on = (opts = {}) => makeHarness({ ...opts, config: { studentGoogle: true, ...(opts.config || {}) } });
/** 用 Google 登入學生頁（create：沒連結過時要不要建立新帳號） */
const gLogin = async (H, account, { create, token } = {}) => {
    const t = token || await H.idToken({ account });
    const r = await H.app.inject({ method: 'POST', url: '/api/student/google', headers: { origin: STUDENT_ORIGIN }, payload: { ...t, ...(create !== undefined ? { create } : {}) } });
    const c = r.cookies.find(x => x.name === COOKIE);
    return { res: r, cookie: c ? `${c.name}=${c.value}` : null, csrf: r.statusCode === 200 ? r.json().csrf : null, token: t };
};
const me = async (H, sess) => (await H.s(sess, 'GET', '/api/student/me')).json();
const invite = async (H, C) => (await H.t(C.token, 'POST', `/api/teacher/classes/${C.classKey}/invitations`, {})).json();
const requests = async (H, C) => (await H.t(C.token, 'GET', `/api/teacher/classes/${C.classKey}/join-requests`)).json().requests;
const link = async (H, sess, account, currentPassword) => H.s(sess, 'POST', '/api/student/identities/google', { ...await H.idToken({ account }), currentPassword });

// ------------------------------------------------------------------ 開關
test('switch: off by default (no button, 404, strict CSP); on: the student page allows only the Google sign-in component, API answers stay strict', async () => {
    const off = await makeHarness();
    assert.deepEqual((await off.app.inject({ method: 'GET', url: '/api/student/config' })).json(), { google: null });
    assert.equal((await gLogin(off, KID1, { create: true })).res.statusCode, 404);
    const page = await off.app.inject({ method: 'GET', url: '/student.html' });
    assert.doesNotMatch(page.headers['content-security-policy'], /google/);
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');

    const H = await on();
    assert.deepEqual((await H.app.inject({ method: 'GET', url: '/api/student/config' })).json(), { google: { clientId: TEST_CLIENT_ID } });
    const p = (await H.app.inject({ method: 'GET', url: '/student.html' })).headers;
    const csp = p['content-security-policy'];
    assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client;/);
    assert.match(csp, /frame-src https:\/\/accounts\.google\.com\/gsi\/;/);
    assert.match(csp, /connect-src 'self' https:\/\/accounts\.google\.com\/gsi\/;/);
    assert.match(csp, /style-src 'self' https:\/\/accounts\.google\.com\/gsi\/style;/);
    assert.doesNotMatch(csp, /unsafe|\*/, 'no wildcards, no unsafe-inline');
    assert.equal(p['cross-origin-opener-policy'], 'same-origin-allow-popups');
    const a = (await H.app.inject({ method: 'GET', url: '/api/student/config' })).headers;
    assert.doesNotMatch(a['content-security-policy'], /google/); assert.equal(a['cross-origin-opener-policy'], 'same-origin');
    // 別的網站不能幫學生登入
    const t = await H.idToken({ account: KID1 });
    assert.equal((await H.app.inject({ method: 'POST', url: '/api/student/google', headers: { origin: 'https://evil.example.test' }, payload: { ...t, create: true } })).statusCode, 403);
});

// ------------------------------------------------------------------ Google 登入與建立帳號
test('Google sign-in: unknown accounts are not created unless asked; a new account has no class and no password; tokens work once; forged tokens fail', async () => {
    const H = await on();
    const first = await gLogin(H, KID1);
    assert.deepEqual([first.res.statusCode, first.res.json().error, first.cookie], [404, 'not_linked', null]);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0, 'nothing is created without asking');
    const replay = await gLogin(H, KID1, { create: true, token: first.token });
    assert.equal(replay.res.json().error, 'replayed', 'the token from the first try cannot be used again');

    const s = await gLogin(H, KID1, { create: true });
    assert.equal(s.res.statusCode, 200); assert.equal(s.res.json().created, true);
    const m = await me(H, s);
    assert.deepEqual([m.username, m.hasPassword, m.google, m.classes, m.pending, m.mustChangePassword], [null, false, true, [], [], false]);
    assert.equal(H.db.prepare('SELECT kind FROM users').get().kind, 'student');
    // 第二次：直接登入同一個人（不再建立）
    const again = await gLogin(H, KID1);
    assert.deepEqual([again.res.statusCode, again.res.json().created], [200, false]);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    // 同一張 token 不能再用（防重放）
    assert.equal((await gLogin(H, KID1, { token: again.token })).res.statusCode, 401);
    // 偽造、過期、別的 App 的 token
    for (const bad of [{ key: H.keys.rogue.privateKey }, { mutate: p => ({ ...p, aud: 'other.apps.googleusercontent.com' }) }, { mutate: p => ({ ...p, iat: p.iat - 7200, exp: p.exp - 7200 }) }]) {
        const t = await H.idToken({ account: KID2, ...bad });
        assert.equal((await gLogin(H, KID2, { create: true, token: t })).res.statusCode, 401);
    }
    // 只存身分雜湊：Email、姓名、sub 原文都不在資料庫裡
    const dump = JSON.stringify(H.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => H.db.prepare(`SELECT * FROM "${t.name}"`).all()));
    for (const x of [KID1.email, KID1.name, KID1.sub]) assert.ok(!dump.includes(x), x);
    // 登出後同一個 Cookie 不能再用
    assert.equal((await H.s(s, 'POST', '/api/student/logout', {})).statusCode, 200);
    assert.equal((await H.s(s, 'GET', '/api/student/me')).statusCode, 401);
});

test('roles: a teacher or admin Google account cannot enter the student page, and a student Google account cannot become a teacher or the admin', async () => {
    const H = await on();
    await H.teacherSession(TEACHER_A);
    for (const create of [false, true]) {
        const r = await gLogin(H, TEACHER_A, { create });
        assert.deepEqual([r.res.statusCode, r.res.json().error, r.cookie], [403, 'staff_account', null]);
    }
    // 學生先用 Google 建立帳號，之後同一個 Google 帳號想當老師（email 在白名單網域內）→ 拒絕
    await gLogin(H, KID1, { create: true });
    const t = await H.idToken({ account: KID1 });
    const r = await H.app.inject({ method: 'POST', url: '/api/teacher/session', headers: { origin: TEACHER_ORIGIN }, payload: t });
    assert.deepEqual([r.statusCode, r.json().error], [403, 'student_account']);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM teachers').get().n, 1);
    // 管理員第一次登入：如果那個 Google 帳號已經是學生，不會變成管理員
    const H2 = await on();
    await gLogin(H2, ADMIN, { create: true });
    await assert.rejects(H2.adminSession(ADMIN), /admin session 403/);
    assert.equal(H2.db.prepare('SELECT COUNT(*) n FROM platform_admins').get().n, 0);
});

test('limits: new Google accounts per network are capped (60 per 15 minutes); bad tokens from one network are capped (20)', async () => {
    const H = await on();
    for (let i = 0; i < 60; i++) {
        const r = await gLogin(H, { sub: `3000000000000000${String(i).padStart(5, '0')}`, email: `k${i}@example.test`, name: 'k' }, { create: true });
        assert.equal(r.res.statusCode, 200, `account ${i}`);
    }
    const over = await gLogin(H, { sub: '300000000000000099999', email: 'k@example.test', name: 'k' }, { create: true });
    assert.equal(over.res.statusCode, 429);
    assert.equal((await gLogin(H, { sub: '300000000000000000001', email: 'k1@example.test', name: 'k' })).res.statusCode, 200, 'existing accounts still sign in');
    H.advance(15 * 60_000 + 1);
    assert.equal((await gLogin(H, { sub: '300000000000000099999', email: 'k@example.test', name: 'k' }, { create: true })).res.statusCode, 200);

    const B = await on();
    for (let i = 0; i < 20; i++) assert.equal((await gLogin(B, KID1, { create: true, token: await B.idToken({ account: KID1, key: B.keys.rogue.privateKey }) })).res.statusCode, 401);
    assert.equal((await gLogin(B, KID1, { create: true })).res.statusCode, 429);
});

// ------------------------------------------------------------------ 代碼：一個欄位
test('redeem: one code box — claim codes bind at once; invitation codes ask for a name (not counted as a wrong code) and become a pending request; wrong codes are counted', async () => {
    const H = await on();
    const A = await seedClass(H);
    const B = await seedClass(H, { account: TEACHER_B });
    const G = await gLogin(H, KID1, { create: true });
    const inv = await invite(H, B);
    for (let i = 0; i < 12; i++) {
        const r = await H.s(G, 'POST', '/api/student/redeem', { code: inv.code });
        assert.deepEqual([r.statusCode, r.json().error], [400, 'need_name']);
    }
    const j = await H.s(G, 'POST', '/api/student/redeem', { code: inv.code, displayName: '小一', seatHint: 3 });
    assert.equal(j.statusCode, 200, 'twelve "need a name" answers did not lock the student out');
    assert.deepEqual(Object.keys(j.json()).sort(), ['className', 'kind', 'message', 'status']);
    assert.equal(j.json().kind, 'invite');
    let m = await me(H, G);
    assert.deepEqual([m.classes, m.pending.map(p => p.className)], [[], [B.fixture.classes.find(c => c.id === 'cls-a').name]]);
    assert.ok(!JSON.stringify(m).includes(B.classKey), 'no class key');
    // 待確認時讀不到任何班級資料
    assert.equal((await H.s(G, 'GET', '/api/student/dashboard')).statusCode, 404);
    // 老師核准 → 出現在我的班級，待確認清空
    const req = (await requests(H, B))[0];
    await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/${B.accounts.get('cls-a-s7').accountId}/remove`, {});
    assert.equal((await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/join-requests/${req.id}/approve`, { localStudentId: 'cls-a-s7' })).statusCode, 200);
    m = await me(H, G);
    assert.equal(m.classes.length, 1); assert.deepEqual(m.pending, []);
    const d = (await H.s(G, 'GET', `/api/student/classes/${m.classes[0].id}/dashboard`)).json();
    assert.equal(d.me.name, B.projection.students.find(s => s.studentId === 'cls-a-s7').name);
    // 個別綁定碼：同一個欄位，直接綁定（不需要名字）
    await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${A.accounts.get('cls-a-s4').accountId}/remove`, {});
    const cc = (await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s4' }] })).json().codes[0];
    const c = await H.s(G, 'POST', '/api/student/redeem', { code: cc.code.toUpperCase() });
    assert.deepEqual([c.statusCode, c.json().kind], [200, 'claim']);
    assert.equal((await me(H, G)).classes.length, 2);
    // 錯的代碼：計數，10 次後 429
    for (let i = 0; i < 10; i++) assert.equal((await H.s(G, 'POST', '/api/student/redeem', { code: 'aaaaa-aaaaa', displayName: '小一' })).statusCode, 404);
    assert.equal((await H.s(G, 'POST', '/api/student/redeem', { code: inv.code, displayName: '小一' })).statusCode, 429);
});

// ------------------------------------------------------------------ 連結、解除、用 Google 重設密碼
test('link / unlink: needs the current password and a fresh Google sign-in; a Google account already used by someone else is refused, never merged', async () => {
    const H = await on();
    const A = await seedClass(H);
    const X = await H.activate(A.accounts.get('cls-a-s1'));
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    assert.equal((await link(H, X, KID1, 'wrong-password')).json().error, 'wrong_password');
    assert.equal((await me(H, X)).google, false);
    assert.equal((await link(H, X, KID1, X.password)).statusCode, 200);
    assert.equal((await me(H, X)).google, true);
    assert.equal((await link(H, X, KID1, X.password)).statusCode, 200, 'linking the same account again is fine');
    assert.equal((await link(H, X, KID2, X.password)).json().error, 'already_linked');
    assert.equal((await link(H, Y, KID1, Y.password)).json().error, 'identity_taken', 'never merged into a second student');
    // 老師的 Google 帳號不能連到學生
    await H.teacherSession(TEACHER_B);
    assert.equal((await link(H, Y, TEACHER_B, Y.password)).json().error, 'staff_account');
    // Google 登入 → 是 X 本人（同一個帳號、同一個班）
    const G = await gLogin(H, KID1);
    assert.equal(G.res.statusCode, 200);
    const gm = await me(H, G);
    assert.equal(gm.username, X.username); assert.deepEqual(gm.classes.map(c => c.id), (await me(H, X)).classes.map(c => c.id));
    // 解除：要密碼；解除後 Google 登入就不是 X 了
    assert.equal((await H.s(X, 'POST', '/api/student/identities/google/unlink', { currentPassword: 'nope-nope' })).json().error, 'wrong_password');
    assert.equal((await H.s(X, 'POST', '/api/student/identities/google/unlink', { currentPassword: X.password })).statusCode, 200);
    assert.equal((await gLogin(H, KID1)).res.json().error, 'not_linked');
    // 只用 Google 建立的帳號不能解除（會沒有任何登入方式）
    const K = await gLogin(H, KID2, { create: true });
    assert.equal((await H.s(K, 'POST', '/api/student/identities/google/unlink', { currentPassword: 'whatever-1' })).json().error, 'last_method');
    // CSRF、Origin 照樣檢查
    assert.equal((await H.s({ ...X, csrf: 'x' }, 'POST', '/api/student/identities/google/unlink', { currentPassword: X.password })).statusCode, 403);
    for (const a of ['student.google.link', 'student.google.unlink', 'student.signup.google', 'student.login.google']) assert.ok(H.db.prepare('SELECT 1 FROM audit_events WHERE action = ?').get(a), a);
});

test('forgot password (D3): a student who linked Google sets a new password after a fresh Google sign-in; other devices are signed out; classes are unchanged', async () => {
    const H = await on();
    const A = await seedClass(H);
    const B = await seedClass(H, { account: TEACHER_B });
    const X = await H.activate(A.accounts.get('cls-a-s1'));
    // X 也在乙班（綁定碼）
    await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/${B.accounts.get('cls-a-s6').accountId}/remove`, {});
    const cc = (await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/claim-codes`, { students: [{ localStudentId: 'cls-a-s6' }] })).json().codes[0];
    assert.equal((await H.s(X, 'POST', '/api/student/redeem', { code: cc.code })).statusCode, 200);
    const before = (await me(H, X)).classes.map(c => c.id).sort();
    assert.equal(before.length, 2);
    await link(H, X, KID1, X.password);
    const Y = await H.activate(A.accounts.get('cls-a-s2'));
    await link(H, Y, KID2, Y.password);
    // 忘記密碼：在另一台裝置用 Google 登入
    const G = await gLogin(H, KID1);
    const reset = async (account, newPassword) => H.s(G, 'POST', '/api/student/password/google-reset', { ...await H.idToken({ account }), newPassword });
    assert.equal((await reset(KID1, '12345678')).json().error, 'weak_password');
    assert.equal((await reset(KID2, 'Comet-River-31')).json().error, 'not_linked', 'someone else\'s Google account cannot reset X');
    const ok = await reset(KID1, 'Comet-River-31');
    assert.equal(ok.statusCode, 200);
    // 舊密碼不行、新密碼可以；其他裝置（X 原本的 Cookie）和這次 Google 的舊 Cookie 都登出
    assert.equal((await H.login(X.username, X.password)).res.statusCode, 401);
    const fresh = await H.login(X.username, 'Comet-River-31');
    assert.equal(fresh.res.statusCode, 200); assert.equal(fresh.res.json().mustChangePassword, false);
    assert.equal((await H.s(X, 'GET', '/api/student/me')).statusCode, 401);
    assert.equal((await H.s(G, 'GET', '/api/student/me')).statusCode, 401);
    assert.deepEqual((await me(H, fresh)).classes.map(c => c.id).sort(), before, 'memberships in both classes are unchanged');
    assert.ok(H.db.prepare("SELECT 1 FROM audit_events WHERE action = 'student.password.google'").get());
    // 老師仍然不能重設這個帳號（D3 不變）
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${A.accounts.get('cls-a-s1').accountId}/reset`, {})).statusCode, 403);
});

// ------------------------------------------------------------------ 資料庫 v4 → v5
test('v4 → v5 migration: teachers and the admin become staff, students become students; nothing else changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fhes-p3-'));
    try {
        const file = join(dir, 'v4.db');
        const db = openDb(file, { upTo: 4 });
        const T = 1_790_000_000_000;
        db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('u_t', ?, ?), ('u_a', ?, ?), ('u_s', ?, ?), ('u_j', ?, ?)").run(T, T, T, T, T, T, T, T);
        db.prepare("INSERT INTO teachers (id, account_hash, created_at, user_id) VALUES ('t_1', 'h1', ?, 'u_t')").run(T);
        db.prepare("INSERT INTO platform_admins (user_id, created_at) VALUES ('u_a', ?)").run(T);
        db.prepare("INSERT INTO classes (id, teacher_id, local_class_id, name, created_at) VALUES ('c_1', 't_1', 'cls', '甲', ?)").run(T);
        db.prepare("INSERT INTO password_credentials (user_id, username, password_hash, created_at, updated_at) VALUES ('u_s', 'abc1234', 'x', ?, ?)").run(T, T);
        db.prepare("INSERT INTO join_requests (id, class_id, user_id, display_name, status, created_at) VALUES ('jr', 'c_1', 'u_j', 'x', 'pending', ?)").run(T);
        db.close();
        const v5 = openDb(file);
        assert.equal(v5.pragma('user_version', { simple: true }), SCHEMA_VERSION);
        assert.deepEqual(v5.prepare('SELECT id, kind FROM users ORDER BY id').all().map(r => [r.id, r.kind]), [['u_a', 'staff'], ['u_j', 'student'], ['u_s', 'student'], ['u_t', 'staff']]);
        assert.throws(() => v5.prepare("UPDATE users SET kind = 'teacher' WHERE id = 'u_t'").run(), /CHECK/);
        assert.deepEqual(v5.pragma('foreign_key_check'), []);
        v5.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } }
});
