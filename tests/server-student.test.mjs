// v6.2 後端：學生登入、密碼、Session、CSRF、限流與跨學生存取（IDOR）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedClass, publish, STUDENT_ORIGIN } from './helpers/server-harness.mjs';
import { buildClassProjection } from '../src/core/student-projection.js';
import { buildFixture, classData } from './helpers/v62-fixture.mjs';
import { passwordProblem } from '../server/src/passwords.mjs';

const acc = (A, id) => A.accounts.get(id);

test('first sign-in only allows a password change; weak passwords are refused; afterwards data opens', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const a = acc(A, 'cls-a-s1');
    const first = await H.login(a.username, a.initialPassword);
    assert.equal(first.res.statusCode, 200); assert.equal(first.res.json().mustChangePassword, true);
    const ck = first.res.cookies.find(c => c.name === '__Host-fhes_sid');
    assert.ok(ck.httpOnly && ck.secure && ck.sameSite === 'Strict' && ck.path === '/' && !ck.domain, 'cookie flags');
    assert.equal((await H.s(first, 'GET', '/api/student/dashboard')).statusCode, 403);
    assert.equal((await H.s(first, 'GET', '/api/student/me')).json().mustChangePassword, true);
    for (const weak of ['short', '12345678', 'aaaaaaaa', a.username + 'xyz1', 'abcdefgh', a.initialPassword])
        assert.equal((await H.s(first, 'POST', '/api/student/password', { currentPassword: a.initialPassword, newPassword: weak })).statusCode, 400, weak);
    assert.equal((await H.s(first, 'POST', '/api/student/password', { currentPassword: 'wrong-one', newPassword: 'Sunny-Garden-42' })).statusCode, 400);
    const ok = await H.s(first, 'POST', '/api/student/password', { currentPassword: a.initialPassword, newPassword: 'Sunny-Garden-42' });
    assert.equal(ok.statusCode, 200);
    assert.equal((await H.s(first, 'GET', '/api/student/me')).statusCode, 401, 'the pre-change session is revoked (rotation)');
    const c = ok.cookies.find(x => x.name === '__Host-fhes_sid');
    const sess = { cookie: `${c.name}=${c.value}`, csrf: ok.json().csrf };
    const d = await H.s(sess, 'GET', '/api/student/dashboard');
    assert.equal(d.statusCode, 200); assert.equal(d.json().me.name, '測試王小明'); assert.deepEqual(d.json().me.score, { score: 3, earned: 5 });
    assert.equal((await H.login(a.username, a.initialPassword)).res.statusCode, 401, 'the initial password no longer works');
    assert.equal((await H.login(a.username.toUpperCase(), 'Sunny-Garden-42')).res.statusCode, 200, 'usernames are case-insensitive');
});

test('password policy unit checks', () => {
    assert.ok(passwordProblem('abc'));
    assert.ok(passwordProblem('98765432'), 'descending sequence');
    assert.ok(passwordProblem('ababab12'.slice(0, 2).repeat(4)), 'two characters only');
    assert.equal(passwordProblem('Sunny-Garden-42', { username: 'kpm4738' }), null);
    assert.ok(passwordProblem('xxkpm4738', { username: 'KPM4738' }), 'contains username in any case');
});

test('wrong password and unknown user get the same answer; 5 failures lock the name (even an unknown one) with backoff', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const a = acc(A, 'cls-a-s2');
    const w = await H.login(a.username, 'wrong-pass-1'); const u = await H.login('zzz9999', 'wrong-pass-1');
    assert.deepEqual([w.res.statusCode, w.res.json()], [u.res.statusCode, u.res.json()], 'no account enumeration');
    for (let i = 0; i < 4; i++) { await H.login(a.username, 'wrong-pass-1'); await H.login('zzz9999', 'x'); }
    assert.equal((await H.login(a.username, a.initialPassword)).res.statusCode, 429, 'locked even with the right password');
    assert.equal((await H.login('zzz9999', 'x')).res.statusCode, 429, 'unknown names lock the same way');
    H.advance(61_000);
    assert.equal((await H.login(a.username, a.initialPassword)).res.statusCode, 200, 'unlocks after 1 minute');
});

test('per-IP limit: 200 failures in 15 minutes → 429 for every name from that IP (a class behind one NAT is not locked out by a few typos)', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    for (let i = 0; i < 30; i++) await H.login(`abc${3000 + i}`, 'nope-nope');
    assert.equal((await H.login(A.accounts.get('cls-a-s2').username, A.accounts.get('cls-a-s2').initialPassword)).res.statusCode, 200, '30 typos from the classroom IP do not block others');
    await Promise.all(Array.from({ length: 170 }, (_, i) => H.login(`abd${3000 + i}`, 'nope-nope')));
    const a = acc(A, 'cls-a-s3');
    const r = await H.login(a.username, a.initialPassword);
    assert.equal(r.res.statusCode, 429); assert.ok(Number(r.res.headers['retry-after']) > 0);
    const other = await H.app.inject({ method: 'POST', url: '/api/student/login', remoteAddress: '10.0.0.9', headers: { origin: STUDENT_ORIGIN }, payload: { username: a.username, password: a.initialPassword } });
    assert.equal(other.statusCode, 200, 'another IP is not affected');
});

test('CSRF and Origin: state changes need the session CSRF header and an allowed Origin; login needs an allowed Origin', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(acc(A, 'cls-a-s1'));
    const care = { itemId: 'land-01', action: 'feed', idempotencyKey: 'csrf-test-0001' };
    assert.equal((await H.app.inject({ method: 'POST', url: '/api/student/care', headers: { cookie: s.cookie, origin: STUDENT_ORIGIN }, payload: care })).statusCode, 403, 'no CSRF header');
    assert.equal((await H.s(s, 'POST', '/api/student/care', care, { 'x-fhes-csrf': 'forged-token-value' })).statusCode, 403, 'wrong CSRF');
    assert.equal((await H.s(s, 'POST', '/api/student/care', care, { origin: 'https://evil.example.test' })).statusCode, 403, 'wrong Origin');
    assert.equal((await H.app.inject({ method: 'POST', url: '/api/student/care', headers: { cookie: s.cookie, 'x-fhes-csrf': s.csrf }, payload: care })).statusCode, 403, 'missing Origin');
    assert.equal((await H.login(s.username, s.password, { origin: 'https://evil.example.test' })).res.statusCode, 403, 'login CSRF');
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, 0, 'nothing was written');
    assert.equal((await H.s(s, 'POST', '/api/student/care', care)).statusCode, 200);
    const pre = await H.app.inject({ method: 'OPTIONS', url: '/api/student/care', headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' } });
    assert.equal(pre.headers['access-control-allow-origin'], undefined, 'student API never enables CORS');
});

test('session fixation, logout, idle and absolute timeout, teacher reset and disable all end sessions', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const a = acc(A, 'cls-a-s4');
    const s = await H.activate(a);
    // 固定：攻擊者先塞一個 cookie，登入後那個值不能用
    const planted = s.cookie;
    const again = await H.login(s.username, s.password, { cookie: planted });
    assert.notEqual(again.cookie, planted);
    assert.equal((await H.s({ cookie: planted }, 'GET', '/api/student/me')).statusCode, 401, 'the cookie presented at login is revoked');
    // 登出
    assert.equal((await H.s(again, 'POST', '/api/student/logout', {})).statusCode, 200);
    assert.equal((await H.s(again, 'GET', '/api/student/me')).statusCode, 401);
    // 閒置 2 小時
    const s2 = await H.login(s.username, s.password);
    H.advance(2 * 3600_000 + 1000);
    assert.equal((await H.s(s2, 'GET', '/api/student/me')).statusCode, 401, 'idle timeout');
    // 絕對 12 小時（期間一直有活動）
    const s3 = await H.login(s.username, s.password);
    for (let i = 0; i < 12; i++) { H.advance(3600_000); await H.s(s3, 'GET', '/api/student/me'); }
    assert.equal((await H.s(s3, 'GET', '/api/student/me')).statusCode, 401, 'absolute timeout');
    // 教師重設
    const s4 = await H.login(s.username, s.password);
    const tk = await H.teacherSession();                      // 教師的 8 小時工作階段在上面已經過期
    const reset = (await H.t(tk, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${a.accountId}/reset`, {})).json();
    assert.equal((await H.s(s4, 'GET', '/api/student/me')).statusCode, 401, 'reset revokes sessions');
    assert.equal((await H.login(s.username, s.password)).res.statusCode, 401, 'old password gone');
    const s5 = await H.login(s.username, reset.initialPassword);
    assert.equal(s5.res.json().mustChangePassword, true);
    // 停用 → 立即失效、不能登入；啟用後恢復
    await H.t(tk, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${a.accountId}/disable`, {});
    assert.equal((await H.s(s5, 'GET', '/api/student/me')).statusCode, 401);
    assert.equal((await H.login(s.username, reset.initialPassword)).res.statusCode, 401);
    await H.t(tk, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${a.accountId}/enable`, {});
    assert.equal((await H.login(s.username, reset.initialPassword)).res.statusCode, 200);
});

test('IDOR: 100 tampered requests never return another student\'s data', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const fx = buildFixture();
    const B = await seedClass(H, { classId: 'cls-b', fixture: fx });
    const me = await H.activate(acc(A, 'cls-a-s1'));
    const others = [...A.projection.students, ...B.projection.students].filter(s => s.studentId !== 'cls-a-s1');
    const otherNames = others.map(s => s.name);
    const otherIds = others.map(s => s.studentId);
    const routes = ['/api/student/dashboard', '/api/student/homework', '/api/student/zoo', '/api/student/me'];
    let refused = 0, ownOnly = 0;
    for (let i = 0; i < 100; i++) {
        const victim = others[i % others.length];
        const route = routes[i % routes.length];
        const variant = i % 5;
        let r;
        if (variant === 0) r = await H.s(me, 'GET', `${route}?studentId=${victim.studentId}`);
        else if (variant === 1) r = await H.s(me, 'GET', `${route}?classId=${B.classKey}&groupId=2`);
        else if (variant === 2) r = await H.s(me, 'GET', route, undefined, { 'x-student-id': victim.studentId, 'x-class-id': B.classKey });
        else if (variant === 3) r = await H.s(me, 'POST', '/api/student/care', { itemId: 'sky-01', action: 'feed', idempotencyKey: `idor-${i}-xxxxxx`, studentId: victim.studentId });
        else r = await H.s(me, 'POST', '/api/student/care', { itemId: i % 2 ? 'ocean-01' : 'sky-02', action: 'pet', idempotencyKey: `idor-${i}-yyyyyy` });
        const body = r.body;
        for (const x of [...otherNames, ...otherIds, B.classKey]) assert.ok(!body.includes(x), `request ${i} leaked ${x}`);
        if (r.statusCode >= 400) refused++; else ownOnly++;
    }
    assert.ok(refused >= 60, `tampered requests refused (${refused})`);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, 0, 'no care was recorded on another group');
    assert.ok(ownOnly > 0);
});

test('student responses and the database contain no secrets; security headers are set', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(acc(A, 'cls-a-s2'));
    const bodies = [];
    for (const u of ['/api/student/me', '/api/student/dashboard', '/api/student/homework', '/api/student/zoo']) {
        const r = await H.s(s, 'GET', u); bodies.push(r.body);
        assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.match(r.headers['content-security-policy'], /default-src 'self'/); assert.equal(r.headers['x-frame-options'], 'DENY');
    }
    const all = bodies.join('\n');
    for (const bad of ['password', 'hash', s.token, A.token, A.classKey, '測試王小明', 'cls-a-s1']) assert.ok(!all.includes(bad), `response must not contain ${bad}`);
    const dbDump = JSON.stringify(H.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!dbDump.includes(s.token) && !dbDump.includes(A.token), 'session tokens stored hashed only');
});

test('homework view keeps unchecked ≠ missing and submitted ≠ done; group change and removal are reflected after publish', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s2 = await H.activate(acc(A, 'cls-a-s2'));
    const hw = (await H.s(s2, 'GET', '/api/student/homework')).json().homework;
    assert.deepEqual(hw.find(h => h.assignmentId === 'hw-a1').submission, 'missing');
    assert.deepEqual(hw.find(h => h.assignmentId === 'hw-a2').submission, 'unchecked');
    assert.equal((await H.s(s2, 'GET', '/api/student/zoo')).json().group.groupId, 1);
    const fx = buildFixture(); fx.students.find(s => s.id === 'cls-a-s2').group = 2;
    await publish(H, A.token, A.classKey, buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' }), 2);
    assert.equal((await H.s(s2, 'GET', '/api/student/zoo')).json().group.groupId, 2, 'group comes from the latest projection');
    fx.students.find(s => s.id === 'cls-a-s2').removed = true;
    await publish(H, A.token, A.classKey, buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' }), 3);
    assert.equal((await H.s(s2, 'GET', '/api/student/dashboard')).json().published, false, 'removed student sees no stale data');
});

test('static student page: allow-list only, no path traversal', async () => {
    const H = await makeHarness();
    const { buildApp } = await import('../server/src/app.mjs');
    const app = buildApp({ db: H.db, jwks: async () => H.keys.jwks, config: { clientId: 'x-test', teacherOrigins: [], studentOrigins: [], ipSalt: 'test-salt-0123456789', staticRoot: process.cwd() } });
    await app.ready();
    for (const p of ['/index.html', '/package.json', '/server/src/app.mjs', '/src/..%2Fpackage.json', '/src/core/../../package.json', '/tests/helpers/fake-google.mjs'])
        assert.equal((await app.inject({ method: 'GET', url: p })).statusCode, 404, p);
    assert.equal((await app.inject({ method: 'GET', url: '/src/core/care.js' })).statusCode, 200);
});

test('defense in depth: a live session stops working as soon as the account is disabled, even if its sessions were not revoked', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(acc(A, 'cls-a-s5'));
    assert.equal((await H.s(s, 'GET', '/api/student/me')).statusCode, 200);
    const userId = H.db.prepare('SELECT user_id FROM password_credentials WHERE username = ?').get(s.username).user_id;
    H.db.prepare("UPDATE student_accounts SET status = 'disabled' WHERE user_id = ?").run(userId);   // 例如管理者直接在資料庫停用（他唯一的班級）
    assert.equal((await H.s(s, 'GET', '/api/student/me')).statusCode, 401);
    assert.ok(H.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'student' AND revoked_at IS NULL AND subject_id = ?").get(userId).n === 0, 'and its sessions get revoked');
    // 整個 user 被停用也一樣
    const s2 = await H.activate(acc(A, 'cls-a-s6'));
    const user2 = H.db.prepare('SELECT user_id FROM password_credentials WHERE username = ?').get(s2.username).user_id;
    H.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user2);
    assert.equal((await H.s(s2, 'GET', '/api/student/dashboard')).statusCode, 401);
});

test('BUG-021: a parallel burst cannot get past the account lockout (attempts are counted before the async hash check)', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const a = acc(A, 'cls-a-s6');
    const rs = await Promise.all(Array.from({ length: 60 }, () => H.login(a.username, 'wrong-guess-1')));
    const codes = rs.map(r => r.res.statusCode);
    assert.ok(codes.filter(c => c === 401).length <= 5, `at most 5 guesses evaluated, got ${codes.filter(c => c === 401).length}`);
    assert.ok(codes.filter(c => c === 429).length >= 55);
    assert.equal((await H.login(a.username, a.initialPassword)).res.statusCode, 429, 'still locked');
});

test('BUG-024: a non-ASCII CSRF header is refused with 403, not a server error', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(acc(A, 'cls-a-s1'));
    const r = await H.s(s, 'POST', '/api/student/care', { itemId: 'land-01', action: 'feed', idempotencyKey: 'csrf-utf8-0001' }, { 'x-fhes-csrf': encodeURIComponent('é').length ? 'é'.repeat(s.csrf.length) : '' });
    assert.equal(r.statusCode, 403);
});
