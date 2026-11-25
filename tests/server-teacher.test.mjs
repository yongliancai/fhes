// v6.2 後端：教師身分（後端驗證 Google ID token）、班級擁有權、帳號發放、投影發布
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedClass, publish, TEACHER_ORIGIN, TEACHER_A, TEACHER_B } from './helpers/server-harness.mjs';
import { OTHER_CLIENT_ID } from './helpers/fake-google.mjs';
import { buildClassProjection, projectionHash } from '../src/core/student-projection.js';
import { buildFixture, classData } from './helpers/v62-fixture.mjs';

const exchange = (H, body, origin = TEACHER_ORIGIN) => H.app.inject({ method: 'POST', url: '/api/teacher/session', headers: origin ? { origin } : {}, payload: body });

test('teacher session: a valid Google ID token is exchanged once for an opaque bearer token', async () => {
    const H = await makeHarness();
    const tok = await H.idToken();
    const r = await exchange(H, tok);
    assert.equal(r.statusCode, 200);
    const { token, expiresAt } = r.json();
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/); assert.equal(expiresAt, H.clock.t + 8 * 3600_000);
    assert.equal(r.headers['access-control-allow-origin'], TEACHER_ORIGIN);
    assert.equal((await exchange(H, tok)).statusCode, 401, 'the same ID token cannot be replayed');
    // 資料庫只存雜湊，不存 token、sub 或 email
    const dump = JSON.stringify([H.db.prepare('SELECT * FROM sessions').all(), H.db.prepare('SELECT * FROM teachers').all(), H.db.prepare('SELECT * FROM used_id_tokens').all()]);
    for (const secret of [token, tok.credential, TEACHER_A.sub, TEACHER_A.email]) assert.ok(!dump.includes(secret), 'no plaintext secret or identity in the database');
});

test('teacher session: forged, wrong audience, wrong issuer, expired, stale, alg none, no sub and nonce mismatch are all refused', async () => {
    const H = await makeHarness();
    const cases = {
        forged: await H.idToken({ key: H.keys.rogue.privateKey }),
        wrongAud: await H.idToken({ mutate: p => ({ ...p, aud: OTHER_CLIENT_ID, azp: OTHER_CLIENT_ID }) }),
        wrongIss: await H.idToken({ mutate: p => ({ ...p, iss: 'https://evil.example.test' }) }),
        expired: await H.idToken({ mutate: p => ({ ...p, iat: p.iat - 7300, exp: p.iat - 3700 }) }),
        stale: await H.idToken({ mutate: p => ({ ...p, iat: p.iat - 900 }) }),            // 15 分鐘前簽發（上限 10 分鐘）
        noSub: await H.idToken({ mutate: p => ({ ...p, sub: '' }) }),
    };
    for (const [name, tok] of Object.entries(cases)) assert.equal((await exchange(H, tok)).statusCode, 401, name);
    const good = await H.idToken();
    assert.equal((await exchange(H, { credential: good.credential, nonce: 'another-nonce-123' })).statusCode, 401, 'nonce mismatch');
    const [h, p] = good.credential.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    assert.equal((await exchange(H, { credential: none, nonce: good.nonce })).statusCode, 401, 'alg none');
    assert.ok(h);
    assert.equal((await exchange(H, { credential: 'x', nonce: good.nonce, sub: TEACHER_A.sub })).statusCode, 400, 'client-supplied identity fields are rejected');
});

test('teacher CORS: only configured teacher origins; preflight allowed; other origins 403', async () => {
    const H = await makeHarness();
    const pre = await H.app.inject({ method: 'OPTIONS', url: '/api/teacher/classes', headers: { origin: TEACHER_ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204); assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    assert.equal((await H.app.inject({ method: 'OPTIONS', url: '/api/teacher/classes', headers: { origin: 'https://evil.example.test' } })).statusCode, 403);
    assert.equal((await exchange(H, await H.idToken(), 'https://evil.example.test')).statusCode, 403);
    assert.equal(pre.headers['access-control-allow-credentials'], undefined, 'no credentialed CORS');
});

test('teacher endpoints need a bearer token; a revoked or expired one is refused', async () => {
    const H = await makeHarness();
    assert.equal((await H.app.inject({ method: 'POST', url: '/api/teacher/classes', payload: { localClassId: 'x', name: 'x' } })).statusCode, 401);
    const token = await H.teacherSession();
    assert.equal((await H.t(token, 'POST', '/api/teacher/classes', { localClassId: 'c1', name: 'n' })).statusCode, 200);
    H.advance(8 * 3600_000 + 1);
    assert.equal((await H.t(token, 'POST', '/api/teacher/classes', { localClassId: 'c1', name: 'n' })).statusCode, 401, 'expired after 8 h');
    const t2 = await H.teacherSession();
    assert.equal((await H.t(t2, 'POST', '/api/teacher/logout')).statusCode, 200);
    assert.equal((await H.t(t2, 'POST', '/api/teacher/classes', { localClassId: 'c1', name: 'n' })).statusCode, 401, 'logout revokes');
});

test('class ownership: another teacher gets 404 for every class endpoint; same local class id stays separate', async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    const tB = await H.teacherSession(TEACHER_B);
    const accId = [...A.accounts.values()][0].accountId;
    const k = A.classKey;
    const hits = [
        ['GET', `/api/teacher/classes/${k}/accounts`], ['POST', `/api/teacher/classes/${k}/accounts`, { students: [{ localStudentId: 'zz' }] }],
        ['POST', `/api/teacher/classes/${k}/accounts/${accId}/reset`, {}], ['POST', `/api/teacher/classes/${k}/accounts/${accId}/disable`, {}],
        ['GET', `/api/teacher/classes/${k}/care-summary`],
    ];
    for (const [m, u, b] of hits) assert.equal((await H.t(tB, m, u, b)).statusCode, 404, `${m} ${u}`);
    assert.equal((await publish(H, tB, k, A.projection, 99)).statusCode, 404);
    const own = (await H.t(tB, 'POST', '/api/teacher/classes', { localClassId: 'cls-a', name: '乙老師同名班' })).json().classKey;
    assert.notEqual(own, k, 'B linking the same local class id gets a different class');
    assert.equal((await H.t(tB, 'GET', `/api/teacher/classes/${own}/accounts`)).json().accounts.length, 0);
    // 甲的帳號也不能從乙的班級路徑操作
    assert.equal((await H.t(tB, 'POST', `/api/teacher/classes/${own}/accounts/${accId}/reset`, {})).statusCode, 404);
});

test('accounts: random usernames, initial password shown once, never stored in plaintext, no duplicates', async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    const list = [...A.accounts.values()];
    assert.equal(list.length, 7);
    for (const a of list) { assert.match(a.username, /^[a-z]{3}[3-9]{4}$/); assert.match(a.initialPassword, /^[a-z2-9]{5}-[a-z2-9]{5}$/); }
    assert.equal(new Set(list.map(a => a.username)).size, 7);
    const again = (await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts`, { students: [{ localStudentId: 'cls-a-s1' }] })).json();
    assert.deepEqual([again.created.length, again.existing], [0, ['cls-a-s1']]);
    const view = (await H.t(A.token, 'GET', `/api/teacher/classes/${A.classKey}/accounts`)).json();
    assert.ok(!JSON.stringify(view).includes('password'), 'list never contains passwords or hashes');
    const dump = JSON.stringify(H.db.prepare('SELECT * FROM student_accounts').all());
    for (const a of list) assert.ok(!dump.includes(a.initialPassword));
    assert.ok(H.db.prepare('SELECT password_hash FROM student_accounts').all().every(r => r.password_hash.startsWith('$argon2id$')));
});

test('projection: stale version 409, same version same content idempotent, same version different content 409, bad hash 400', async () => {
    const H = await makeHarness();
    const A = await seedClass(H, { version: 10 });
    assert.equal((await publish(H, A.token, A.classKey, A.projection, 9)).statusCode, 409);
    const same = await publish(H, A.token, A.classKey, A.projection, 10);
    assert.deepEqual([same.statusCode, same.json().unchanged], [200, true]);
    const changed = structuredClone(A.projection); changed.students[0].score.score += 1;
    assert.equal((await publish(H, A.token, A.classKey, changed, 10)).statusCode, 409);
    const badHash = await H.t(A.token, 'PUT', `/api/teacher/classes/${A.classKey}/projection`, { version: 11, hash: 'a'.repeat(64), projection: changed });
    assert.equal(badHash.statusCode, 400);
    const bad = structuredClone(changed); bad.students[0].hearts = 2;
    assert.equal((await publish(H, A.token, A.classKey, bad, 11)).statusCode, 400, 'unknown fields are rejected');
    assert.equal((await publish(H, A.token, A.classKey, changed, 11)).statusCode, 200);
});

test('projection: a newer version replaces the class (removed students and groups leave no ghost data)', async () => {
    const H = await makeHarness();
    const A = await seedClass(H);
    const fx = buildFixture();
    fx.students.find(s => s.id === 'cls-a-s6').removed = true;   // 第 3 組唯一的成員轉出
    fx.classes[0].groupCount = 2;
    const p2 = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    assert.equal((await publish(H, A.token, A.classKey, p2, 2)).statusCode, 200);
    const rows = H.db.prepare('SELECT local_student_id FROM student_projections').all().map(r => r.local_student_id);
    assert.ok(!rows.includes('cls-a-s6'));
    assert.deepEqual(H.db.prepare('SELECT group_id FROM group_projections ORDER BY group_id').all().map(r => r.group_id), [1, 2]);
    const r = await H.t(A.token, 'PUT', `/api/teacher/classes/${A.classKey}/projection`, { version: 3, hash: await projectionHash(p2), projection: { ...p2, students: 'all' } });
    assert.equal(r.statusCode, 400);
});

test('request size and shape limits', async () => {
    const H = await makeHarness();
    const token = await H.teacherSession();
    const big = await H.app.inject({ method: 'POST', url: '/api/teacher/classes', headers: { authorization: `Bearer ${token}`, origin: TEACHER_ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ localClassId: 'x'.repeat(40_000), name: '' }) });
    assert.equal(big.statusCode, 413);
    assert.equal((await H.t(token, 'GET', '/api/teacher/classes/nope/accounts?all=1')).statusCode, 400);
});
