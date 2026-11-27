// v6.2 多班級 P1（ADR-024、ADR-027）：資料庫 v2→v3 無損遷移、版本保護、一個 user 多個班級的隔離與越權防護。
// 全部合成資料、記憶體或暫存檔資料庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, migrationsUpTo, SCHEMA_VERSION, SchemaTooNewError } from '../server/src/db.mjs';
import { buildApp } from '../server/src/app.mjs';
import { hashPassword } from '../server/src/passwords.mjs';
import { makeHarness, seedClass, TEACHER_B, STUDENT_ORIGIN, testKeys } from './helpers/server-harness.mjs';
import { TEST_CLIENT_ID } from './helpers/fake-google.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fhes-mc-'));
const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } };

// ------------------------------------------------------------------ v2 資料庫（用 v1+v2 的 migration 建立，等同正式環境上的舊檔案）
const T0 = Date.parse('2026-11-20T09:00:00+08:00');
const seedV2 = async (file) => {
    const db = openDb(file, { upTo: 2 });
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    const hash = await hashPassword('Old-Password-77');
    db.prepare("INSERT INTO teachers VALUES ('t_aaaa', 'acct-hash-a', ?), ('t_bbbb', 'acct-hash-b', ?)").run(T0, T0);
    // 兩位老師用同一個本機班級 ID（cls-1）：不同的 classKey、不能互相碰撞
    db.prepare("INSERT INTO classes (id, teacher_id, local_class_id, name, created_at) VALUES ('c_aaaaaaaaaa', 't_aaaa', 'cls-1', '甲', ?), ('c_bbbbbbbbbb', 't_bbbb', 'cls-1', '乙', ?)").run(T0, T0);
    const acc = db.prepare('INSERT INTO student_accounts (id, class_id, local_student_id, username, password_hash, must_change, status, created_at, updated_at, is_helper) VALUES (?,?,?,?,?,?,?,?,?,?)');
    // 同名同座號的學生在兩個班：遷移後仍是兩個不同的 user（不自動合併）
    acc.run('s_a1xxxxxxxx', 'c_aaaaaaaaaa', 'st-1', 'aaa1111', hash, 0, 'active', T0, T0, 1);
    acc.run('s_a2xxxxxxxx', 'c_aaaaaaaaaa', 'st-2', 'aaa2222', hash, 1, 'disabled', T0, T0, 0);
    acc.run('s_b1xxxxxxxx', 'c_bbbbbbbbbb', 'st-1', 'bbb1111', hash, 0, 'active', T0, T0, 0);
    db.prepare("INSERT INTO student_projections VALUES ('c_aaaaaaaaaa', 'st-1', 1, '{\"name\":\"合成一號\",\"seat\":1}', 1)").run();
    db.prepare("INSERT INTO group_care_events (id, class_id, group_id, account_id, item_id, action, local_date, slot, idempotency_key, created_at) VALUES ('ce_1', 'c_aaaaaaaaaa', 1, 's_a1xxxxxxxx', 'sky-01', 'feed', '2026-11-20', 1, 'k-care-1', ?)").run(T0);
    db.prepare("INSERT INTO hw_registrations (id, class_id, helper_account_id, helper_local_id, assignment_id, local_student_id, state, local_date, idempotency_key, created_at) VALUES ('hr_1', 'c_aaaaaaaaaa', 's_a1xxxxxxxx', 'st-1', 'hw-1', 'st-2', 'submitted', '2026-11-20', 'k-reg-1', ?)").run(T0);
    db.prepare("INSERT INTO sessions (id_hash, kind, subject_id, created_at, last_seen, expires_at) VALUES ('sess-hash-1', 'student', 's_a1xxxxxxxx', ?, ?, ?), ('sess-hash-2', 'teacher', 't_aaaa', ?, ?, ?)").run(T0, T0, T0 + 9e9, T0, T0, T0 + 9e9);
    return db;
};
const snapshot = (db) => ({
    care: db.prepare('SELECT * FROM group_care_events ORDER BY id').all(),
    regs: db.prepare('SELECT * FROM hw_registrations ORDER BY seq').all(),
    projections: db.prepare('SELECT * FROM student_projections ORDER BY class_id, local_student_id').all(),
    classes: db.prepare('SELECT id, teacher_id, local_class_id, name FROM classes ORDER BY id').all(),
});

test('v2 → v3 migration keeps every account, password, helper flag, care event and registration; ids are unchanged; nothing is merged', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'v2.db');
        const v2 = await seedV2(file); const before = snapshot(v2); v2.close();
        const db = openDb(file);
        assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are on again after the migration');
        assert.deepEqual(snapshot(db), before, 'care events, registrations, projections and classes are byte-for-byte the same');
        const members = db.prepare('SELECT m.id, m.class_id, m.user_id, m.local_student_id, m.status, m.is_helper, p.username, p.must_change, p.issued_by_class_id FROM student_accounts m JOIN password_credentials p ON p.user_id = m.user_id ORDER BY m.id').all();
        assert.deepEqual(members.map(m => [m.id, m.class_id, m.local_student_id, m.status, m.is_helper, m.username, m.must_change, m.issued_by_class_id]), [
            ['s_a1xxxxxxxx', 'c_aaaaaaaaaa', 'st-1', 'active', 1, 'aaa1111', 0, 'c_aaaaaaaaaa'],
            ['s_a2xxxxxxxx', 'c_aaaaaaaaaa', 'st-2', 'disabled', 0, 'aaa2222', 1, 'c_aaaaaaaaaa'],
            ['s_b1xxxxxxxx', 'c_bbbbbbbbbb', 'st-1', 'active', 0, 'bbb1111', 0, 'c_bbbbbbbbbb'],
        ]);
        assert.equal(new Set(members.map(m => m.user_id)).size, 3, 'one user per old account: same name/seat in two classes are NOT merged');
        // 老師：身分雜湊原樣成為 Google 身分；不存 sub／email
        assert.deepEqual(db.prepare('SELECT t.id, i.subject_hash FROM teachers t JOIN auth_identities i ON i.user_id = t.user_id ORDER BY t.id').all().map(r => [r.id, r.subject_hash]), [['t_aaaa', 'acct-hash-a'], ['t_bbbb', 'acct-hash-b']]);
        // 學生的舊 Session 全部登出；老師的不受影響
        assert.ok(db.prepare("SELECT revoked_at FROM sessions WHERE id_hash = 'sess-hash-1'").get().revoked_at > 0);
        assert.equal(db.prepare("SELECT revoked_at FROM sessions WHERE id_hash = 'sess-hash-2'").get().revoked_at, null);
        // 外鍵仍然有效：照顧紀錄指向重建後的成員表
        assert.throws(() => db.prepare("INSERT INTO group_care_events (id, class_id, group_id, account_id, item_id, action, local_date, slot, idempotency_key, created_at) VALUES ('ce_x', 'c_aaaaaaaaaa', 1, 's_nobody', 'sky-01', 'feed', '2026-11-21', 1, 'k', 1)").run(), /FOREIGN KEY/);
        // 同一班同一位本機學生不能綁兩個有效成員
        db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES ('u_extra', 1, 1)").run();
        assert.throws(() => db.prepare("INSERT INTO student_accounts (id, class_id, user_id, local_student_id, created_at, updated_at) VALUES ('s_dup', 'c_aaaaaaaaaa', 'u_extra', 'st-1', 1, 1)").run(), /UNIQUE/);
        db.close();
        // 重開（已經是 v3）：什麼都不變
        const again = openDb(file);
        assert.equal(again.prepare('SELECT COUNT(*) n FROM users').get().n, 3 + 2 + 1);
        assert.deepEqual(snapshot(again), before);
        again.close();
    } finally { cleanup(dir); }
});

test('after the migration the old username and password still sign in, the helper still works, and the old session is gone', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'v2.db');
        (await seedV2(file)).close();
        const db = openDb(file);
        const keys = await testKeys();
        const app = buildApp({ db, now: () => Date.parse('2026-11-27T09:00:00+08:00'), jwks: async () => keys.jwks,
            config: { clientId: TEST_CLIENT_ID, teacherOrigins: ['http://localhost:8765'], teacherAllow: ['@example.test'], studentOrigins: [STUDENT_ORIGIN], ipSalt: 'test-salt-0123456789', cookieSecure: true } });
        await app.ready();
        const login = async (username, password) => app.inject({ method: 'POST', url: '/api/student/login', headers: { origin: STUDENT_ORIGIN }, payload: { username, password } });
        const ok = await login('aaa1111', 'Old-Password-77');
        assert.equal(ok.statusCode, 200); assert.equal(ok.json().mustChangePassword, false);
        const c = ok.cookies.find(x => x.name === '__Host-fhes_sid');
        const me = (await app.inject({ method: 'GET', url: '/api/student/me', headers: { cookie: `${c.name}=${c.value}` } })).json();
        assert.equal(me.helper, true);
        assert.deepEqual(me.classes, [{ id: 's_a1xxxxxxxx', className: '甲', helper: true }]);
        assert.equal((await login('aaa2222', 'Old-Password-77')).statusCode, 401, 'a disabled account (its only class) still cannot sign in');
        assert.equal((await login('aaa1111', 'wrong-password-1')).statusCode, 401);
        await app.close(); db.close();
    } finally { cleanup(dir); }
});

test('a failing migration rolls back completely: the file stays v2, the old table is intact and foreign keys are back on', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'v2.db');
        const db = await seedV2(file); const before = snapshot(db);
        const v3 = migrationsUpTo(SCHEMA_VERSION)[2];
        assert.throws(() => migrate(db, [...migrationsUpTo(2), { ...v3, check: () => { throw new Error('對帳失敗（模擬）'); } }]), /模擬/);
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
        assert.ok(db.prepare('SELECT username FROM student_accounts WHERE id = ?').get('s_a1xxxxxxxx'), 'v2 table still has its username column');
        assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('users', 'password_credentials', 'auth_identities')").get().n, 0);
        assert.deepEqual(snapshot(db), before);
        // 中斷之後再正常跑一次就成功
        migrate(db);
        assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
        db.close();
    } finally { cleanup(dir); }
});

test('an older program refuses a newer database (no silent writes after a rollback of the code)', async () => {
    const dir = tmp();
    try {
        const file = join(dir, 'v3.db');
        openDb(file).close();
        const db = openDb(file);
        assert.throws(() => migrate(db, migrationsUpTo(2)), SchemaTooNewError, 'a v2 program sees a v3 file and stops');
        db.pragma('user_version = 99'); db.close();
        assert.throws(() => openDb(file), SchemaTooNewError);
    } finally { cleanup(dir); }
});

// ------------------------------------------------------------------ 一個 user、兩位老師的兩個班級
/** 甲老師的甲班＋乙老師的班（同一個本機班級 ID 'cls-a'）。學生 X＝甲班 cls-a-s1；再加入乙班，綁到乙班的 cls-a-s4（另一個小組） */
const twoTeachers = async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    const B = await seedClass(H, { account: TEACHER_B });
    assert.notEqual(A.classKey, B.classKey, 'same local class id, different teachers → different classes');
    const X = await H.activate(A.accounts.get('cls-a-s1'));
    const userX = H.db.prepare('SELECT user_id FROM password_credentials WHERE username = ?').get(X.username).user_id;
    // 乙班原本發給 cls-a-s4 的帳號移除（之後由加入流程綁定；P2 會有正式的 API，這裡直接寫資料庫模擬核准）
    H.db.prepare("UPDATE student_accounts SET status = 'removed' WHERE class_id = ? AND local_student_id = 'cls-a-s4'").run(B.classKey);
    H.db.prepare("INSERT INTO student_accounts (id, class_id, user_id, local_student_id, status, joined_via, created_at, updated_at) VALUES ('s_xinclassbbbb', ?, ?, 'cls-a-s4', 'active', 'invite', ?, ?)").run(B.classKey, userX, H.clock.t, H.clock.t);
    const mA = A.accounts.get('cls-a-s1').accountId; const mB = 's_xinclassbbbb';
    return { H, A, B, X, userX, mA, mB };
};

test('one student in two teachers’ classes: /me lists both, each class shows only that class’s own data, the old single-class paths ask to choose', async () => {
    const { H, A, B, X, mA, mB } = await twoTeachers();
    const me = (await H.s(X, 'GET', '/api/student/me')).json();
    assert.deepEqual(me.classes.map(c => c.id).sort(), [mA, mB].sort());
    assert.ok(!JSON.stringify(me).includes(A.classKey) && !JSON.stringify(me).includes(B.classKey), 'no classKey is ever sent to students');
    const legacy = await H.s(X, 'GET', '/api/student/dashboard');
    assert.equal(legacy.statusCode, 409); assert.equal(legacy.json().error, 'choose_class');
    const dA = (await H.s(X, 'GET', `/api/student/classes/${mA}/dashboard`)).json();
    const dB = (await H.s(X, 'GET', `/api/student/classes/${mB}/dashboard`)).json();
    const sA = A.projection.students.find(s => s.studentId === 'cls-a-s1'); const sB = B.projection.students.find(s => s.studentId === 'cls-a-s4');
    assert.deepEqual([dA.me.name, dA.me.score], [sA.name, sA.score]);
    assert.deepEqual([dB.me.name, dB.me.score], [sB.name, sB.score]);
    assert.notDeepEqual(dA.me, dB.me);
    const hB = (await H.s(X, 'GET', `/api/student/classes/${mB}/homework`)).json();
    assert.deepEqual(hB.homework, sB.homework, 'homework comes from the selected class only');
});

test('care limits are per class: 3 counted in class A and 3 more in class B; the 4th in A is not counted', async () => {
    const { H, X, mA, mB } = await twoTeachers();
    const animalOf = async (m) => (await H.s(X, 'GET', `/api/student/classes/${m}/zoo`)).json().group.animals[0].itemId;
    const [itA, itB] = [await animalOf(mA), await animalOf(mB)];
    const care = (m, itemId, i) => H.s(X, 'POST', `/api/student/classes/${m}/care`, { itemId, action: 'feed', idempotencyKey: `care-${m.slice(-6)}-${i}-abcdef` });
    const counted = [];
    for (let i = 0; i < 3; i++) counted.push((await care(mA, itA, i)).json().counted);
    for (let i = 0; i < 3; i++) counted.push((await care(mB, itB, i)).json().counted);
    counted.push((await care(mA, itA, 9)).json().counted);
    assert.deepEqual(counted, [true, true, true, true, true, true, false]);
    const rows = H.db.prepare('SELECT account_id, COUNT(*) n FROM group_care_events WHERE slot IS NOT NULL GROUP BY account_id ORDER BY account_id').all();
    assert.deepEqual(rows.map(r => [r.account_id, r.n]).sort(), [[mA, 3], [mB, 3]].sort());
    // 用乙班的成員代號照顧「只在甲班小組」的動物 → 404，而且不會記錄
    const zooB = (await H.s(X, 'GET', `/api/student/classes/${mB}/zoo`)).json();
    const onlyInA = (await H.s(X, 'GET', `/api/student/classes/${mA}/zoo`)).json().group.animals.map(a => a.itemId).find(id => !zooB.group.animals.some(b => b.itemId === id));
    assert.ok(onlyInA, 'fixture has an animal that is only in class A’s group');
    const before = H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n;
    assert.equal((await care(mB, onlyInA, 20)).statusCode, 404);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, before);
});

test('helper rights stay in the class that granted them', async () => {
    const { H, A, X, mA, mB } = await twoTeachers();
    await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${mA}/helper`, { helper: true });
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mA}/helper`)).statusCode, 200);
    const inB = await H.s(X, 'GET', `/api/student/classes/${mB}/helper`);
    assert.equal(inB.statusCode, 403); assert.equal(inB.json().error, 'not_helper');
    const reg = await H.s(X, 'POST', `/api/student/classes/${mB}/helper/register`, { assignmentId: 'hw-a2', studentIds: ['cls-a-s2'], state: 'missing', idempotencyKey: 'reg-in-b-abcdef' });
    assert.equal(reg.statusCode, 403);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM hw_registrations').get().n, 0);
});

test('D3: the issuing teacher cannot reset the password of a student who is also in another teacher’s class', async () => {
    const { H, A, B, mA } = await twoTeachers();
    const r = await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${mA}/reset`, {});
    assert.equal(r.statusCode, 403); assert.equal(r.json().error, 'other_teacher');
    // 乙老師也不行（帳密不是乙班發的）
    const rb = await H.t(B.token, 'POST', `/api/teacher/classes/${B.classKey}/accounts/s_xinclassbbbb/reset`, {});
    assert.equal(rb.statusCode, 403); assert.equal(rb.json().error, 'not_issuer');
    // 一般情況（只在本班）照舊可以重設
    const other = A.accounts.get('cls-a-s2').accountId;
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${other}/reset`, {})).statusCode, 200);
});

test('disabling a student in one class does not log them out of their other class; the old paths then work for the class that is left', async () => {
    const { H, A, X, mA, mB } = await twoTeachers();
    assert.equal((await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${mA}/disable`, {})).statusCode, 200);
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mA}/dashboard`)).statusCode, 404);
    assert.equal((await H.s(X, 'GET', `/api/student/classes/${mB}/dashboard`)).statusCode, 200);
    assert.equal((await H.s(X, 'GET', '/api/student/dashboard')).statusCode, 200, 'only one class left → legacy path works again');
    assert.deepEqual((await H.s(X, 'GET', '/api/student/me')).json().classes.map(c => c.id), [mB]);
});

test('IDOR: 200 tampered requests with other people’s member ids, classKeys, extra ids and headers never reach another student’s data', async () => {
    const { H, A, B, X, mA, mB } = await twoTeachers();
    const victim = await H.activate(A.accounts.get('cls-a-s2'));
    const victimMember = A.accounts.get('cls-a-s2').accountId;
    const bMember = B.accounts.get('cls-a-s1').accountId;
    const otherNames = [...A.projection.students, ...B.projection.students].filter(s => !['cls-a-s1'].includes(s.studentId) || false).map(s => s.name);
    const mine = new Set([A.projection.students.find(s => s.studentId === 'cls-a-s1').name, B.projection.students.find(s => s.studentId === 'cls-a-s4').name]);
    const foreignNames = otherNames.filter(n => !mine.has(n));
    const subs = ['dashboard', 'homework', 'zoo'];
    let refused = 0;
    for (let i = 0; i < 200; i++) {
        const sub = subs[i % 3]; const v = i % 8;
        let r;
        if (v === 0) r = await H.s(X, 'GET', `/api/student/classes/${victimMember}/${sub}`);
        else if (v === 1) r = await H.s(X, 'GET', `/api/student/classes/${bMember}/${sub}`);
        else if (v === 2) r = await H.s(X, 'GET', `/api/student/classes/${A.classKey}/${sub}`);
        else if (v === 3) r = await H.s(X, 'GET', `/api/student/classes/s_${Math.random().toString(36).slice(2, 14)}/${sub}`);
        else if (v === 4) r = await H.s(X, 'GET', `/api/student/classes/${mA}/${sub}?studentId=cls-a-s2`);
        else if (v === 5) r = await H.s(X, 'POST', `/api/student/classes/${victimMember}/care`, { itemId: 'sky-01', action: 'feed', idempotencyKey: `idor-mc-${i}-abcdef` });
        else if (v === 6) r = await H.s(X, 'POST', `/api/student/classes/${mB}/care`, { itemId: 'sky-01', action: 'feed', idempotencyKey: `idor-mc-${i}-abcdef`, studentId: 'cls-a-s2' });
        else r = await H.s(victim, 'GET', `/api/student/classes/${mB}/${sub}`);
        for (const x of [...foreignNames, A.classKey, B.classKey]) assert.ok(!r.body.includes(x), `request ${i} (variant ${v}) leaked ${x}`);
        assert.ok(r.statusCode >= 400, `request ${i} (variant ${v}) must be refused, got ${r.statusCode}`);
        refused++;
    }
    assert.equal(refused, 200);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, 0, 'no care was recorded through someone else’s member id');
});

test('a suspended teacher cannot sign in to the student system and their live session stops working', async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    H.db.prepare("UPDATE teachers SET status = 'suspended'").run();
    assert.equal((await H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/accounts`)).statusCode, 401);
    const { credential, nonce } = await H.idToken();
    const r = await H.app.inject({ method: 'POST', url: '/api/teacher/session', headers: { origin: 'http://localhost:8765' }, payload: { credential, nonce } });
    assert.equal(r.statusCode, 403); assert.equal(r.json().error, 'suspended');
});

test('new teachers get a platform user and a Google identity keyed by the hashed subject (no email stored)', async () => {
    const H = await makeHarness();
    await seedClass(H);
    const rows = H.db.prepare('SELECT t.user_id, i.subject_hash, t.account_hash FROM teachers t JOIN auth_identities i ON i.user_id = t.user_id').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].subject_hash, rows[0].account_hash);
    const dump = JSON.stringify([H.db.prepare('SELECT * FROM users').all(), H.db.prepare('SELECT * FROM auth_identities').all()]);
    assert.ok(!/@|example\.test|100000000000000000001/.test(dump), 'no email or raw Google sub in the database');
});
