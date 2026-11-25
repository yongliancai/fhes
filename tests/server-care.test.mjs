// v6.2 後端：小組照顧（每日上限、冪等、同時送出、換組、撤銷物種、停用）且不影響 XP／分數／收藏
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, seedClass, publish } from './helpers/server-harness.mjs';
import { buildClassProjection, projectionHash } from '../src/core/student-projection.js';
import { buildFixture, classData } from './helpers/v62-fixture.mjs';

const care = (H, s, itemId, key, action = 'feed') => H.s(s, 'POST', '/api/student/care', { itemId, action, idempotencyKey: key });

test('3 counted actions per day, then animation only; a new Taipei day resets', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(A.accounts.get('cls-a-s1'));
    const res = [];
    for (let i = 0; i < 5; i++) res.push((await care(H, s, i % 2 ? 'land-02' : 'land-01', `day1-key-${i}`, i % 2 ? 'pet' : 'feed')).json());
    assert.deepEqual(res.map(r => r.counted), [true, true, true, false, false]);
    assert.deepEqual(res[4].myToday, { used: 3, limit: 3 });
    const zoo = (await H.s(s, 'GET', '/api/student/zoo')).json();
    assert.equal(zoo.care.total, 3); assert.equal(zoo.care.animals['land-01'].care, 2);
    assert.equal(zoo.care.animals['land-01'].mood, 'happy');
    H.advance(24 * 3600_000);
    const s2 = await H.login(s.username, s.password);
    assert.equal((await care(H, s2, 'land-01', 'day2-key-0')).json().counted, true);
});

test('the same idempotency key counts once; reusing it for another action is a conflict', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(A.accounts.get('cls-a-s1'));
    const a = (await care(H, s, 'land-01', 'retry-key-01')).json();
    const b = (await care(H, s, 'land-01', 'retry-key-01')).json();
    assert.deepEqual([a.counted, a.replay, b.counted, b.replay], [true, false, true, true]);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events').get().n, 1);
    assert.equal((await care(H, s, 'land-02', 'retry-key-01')).statusCode, 409);
});

test('100 simultaneous submissions (different keys, two tabs) count exactly 3', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(A.accounts.get('cls-a-s2'));
    const tab2 = await H.login(s.username, s.password);
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => care(H, i % 2 ? tab2 : s, i % 3 ? 'land-01' : 'land-02', `burst-${String(i).padStart(4, '0')}`)));
    assert.ok(rs.every(r => r.statusCode === 200), 'no server errors under load');
    assert.equal(rs.filter(r => r.json().counted).length, 3);
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events WHERE slot IS NOT NULL').get().n, 3);
    assert.deepEqual(H.db.prepare('SELECT slot FROM group_care_events WHERE slot IS NOT NULL ORDER BY slot').all().map(r => r.slot), [1, 2, 3]);
    // 同一把 key 同時送 100 次 → 只有 1 筆
    const same = await Promise.all(Array.from({ length: 100 }, () => care(H, s, 'land-01', 'same-key-burst')));
    assert.ok(same.every(r => r.statusCode === 200));
    assert.equal(H.db.prepare("SELECT COUNT(*) n FROM group_care_events WHERE idempotency_key = 'same-key-burst'").get().n, 1);
});

test('database constraints back up the rules even if application code were bypassed', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const s = await H.activate(A.accounts.get('cls-a-s1'));
    await care(H, s, 'land-01', 'constraint-1');
    const row = H.db.prepare('SELECT * FROM group_care_events').get();
    const ins = (slot, key) => H.db.prepare('INSERT INTO group_care_events (id, class_id, group_id, account_id, item_id, action, local_date, slot, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(`x-${key}`, row.class_id, row.group_id, row.account_id, 'land-01', 'feed', row.local_date, slot, key, 1);
    assert.throws(() => ins(1, 'constraint-2'), /UNIQUE/, 'same slot twice');
    assert.throws(() => ins(4, 'constraint-3'), /CHECK/, 'slot 4 does not exist');
    assert.throws(() => ins(null, 'constraint-1'), /UNIQUE/, 'same idempotency key');
    assert.throws(() => H.db.prepare("UPDATE group_care_events SET action = 'xp'").run(), /CHECK/);
});

test('cannot care for another group\'s or class\'s animal, a revoked species, or without a group', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    await seedClass(H, { classId: 'cls-b' });
    const s = await H.activate(A.accounts.get('cls-a-s1'));
    assert.equal((await care(H, s, 'ocean-01', 'other-group-1')).statusCode, 404, 'group 2 animal');
    assert.equal((await care(H, s, 'sky-01', 'other-class-1')).statusCode, 404, 'class B animal');
    assert.equal((await care(H, s, 'land-03', 'revoked-sp-1')).statusCode, 404, 'revoked grant is not in the projection');
    assert.equal((await care(H, s, 'land-12', 'class-grant-1')).statusCode, 404, 'class-level grant is not a group animal');
    assert.equal((await H.s(s, 'POST', '/api/student/care', { itemId: 'land-01', action: 'xp', idempotencyKey: 'bad-action-1' })).statusCode, 400);
    assert.equal((await H.s(s, 'POST', '/api/student/care', { itemId: 'land-01', action: 'feed', idempotencyKey: 'short' })).statusCode, 400);
    const nog = await H.activate(A.accounts.get('cls-a-s7'));     // 沒有小組
    assert.equal((await care(H, nog, 'land-01', 'no-group-01')).statusCode, 409);
    // 老師撤銷 land-01 並重新發布 → 不能再照顧
    const fx = buildFixture(); fx.grants.find(g => g.itemId === 'land-01').revoked = true;
    await publish(H, A.token, A.classKey, buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' }), 2);
    assert.equal((await care(H, s, 'land-01', 'after-revoke-1')).statusCode, 404);
});

test('changing group does not reset the daily limit; old group keeps its history; disabled or must-change accounts cannot care', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const acc = A.accounts.get('cls-a-s1');
    const s = await H.activate(acc);
    await care(H, s, 'land-01', 'move-key-1'); await care(H, s, 'land-02', 'move-key-2');
    const fx = buildFixture(); fx.students.find(x => x.id === 'cls-a-s1').group = 2;
    await publish(H, A.token, A.classKey, buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' }), 2);
    const r = [(await care(H, s, 'ocean-01', 'move-key-3')).json(), (await care(H, s, 'ocean-01', 'move-key-4')).json()];
    assert.deepEqual(r.map(x => x.counted), [true, false], 'only one left today across groups');
    assert.equal(H.db.prepare('SELECT COUNT(*) n FROM group_care_events WHERE group_id = 1 AND slot IS NOT NULL').get().n, 2, 'old group keeps the 2 actions');
    assert.equal((await care(H, s, 'land-01', 'move-key-5')).statusCode, 404, 'old group animal no longer reachable');
    await H.t(A.token, 'POST', `/api/teacher/classes/${A.classKey}/accounts/${acc.accountId}/disable`, {});
    assert.equal((await care(H, s, 'ocean-01', 'move-key-6')).statusCode, 401);
    const fresh = A.accounts.get('cls-a-s4');
    const first = await H.login(fresh.username, fresh.initialPassword);
    assert.equal((await care(H, first, 'ocean-01', 'pwchange-1')).statusCode, 403, 'must change password first');
});

test('care never changes XP, score, grants or growth: the projection built afterwards is identical', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const before = await projectionHash(A.projection);
    const s = await H.activate(A.accounts.get('cls-a-s1'));
    for (let i = 0; i < 3; i++) await care(H, s, 'land-01', `noxp-${i}-key`);
    const fx = buildFixture();
    const after = buildClassProjection(classData(fx, 'cls-a'), { today: '2026-11-25' });
    assert.equal(await projectionHash(after), before, 'teacher data unchanged');
    const re = await publish(H, A.token, A.classKey, after, 1);
    assert.equal(re.json().unchanged, true);
    const zoo = (await H.s(s, 'GET', '/api/student/zoo')).json();
    assert.equal(zoo.group.xp, A.projection.groups[0].xp);
    assert.deepEqual(zoo.group.animals.map(a => a.stage), A.projection.groups[0].animals.map(a => a.stage));
});

test('badges and team stars: half of the group caring on a day gives a star; teacher sees the summary', async () => {
    const H = await makeHarness(); const A = await seedClass(H);
    const ss = [];
    for (const id of ['cls-a-s1', 'cls-a-s2', 'cls-a-s3']) ss.push(await H.activate(A.accounts.get(id)));
    await care(H, ss[0], 'land-01', 'team-a-0001');
    let z = (await H.s(ss[0], 'GET', '/api/student/zoo')).json();
    assert.deepEqual([z.care.teamStars, z.care.today.participants, z.care.today.needed], [0, 1, 2], 'group 1 has 3 active members → 2 needed');
    await care(H, ss[1], 'land-02', 'team-b-0001', 'pet');
    z = (await H.s(ss[0], 'GET', '/api/student/zoo')).json();
    assert.equal(z.care.teamStars, 1);
    assert.ok(!JSON.stringify(z).includes('測試'), 'no member names in the group view');
    for (let d = 0; d < 3; d++) { H.advance(24 * 3600_000); for (const s of ss) { const fresh = await H.login(s.username, s.password); for (let i = 0; i < 3; i++) await care(H, fresh, 'land-01', `badge-${d}-${s.username}-${i}`); } }
    z = (await H.s(await H.login(ss[0].username, ss[0].password), 'GET', '/api/student/zoo')).json();
    assert.equal(z.care.total, 2 + 27); assert.deepEqual(z.care.badges, ['flowerbed']); assert.equal(z.care.teamStars, 4);
    const tk = await H.teacherSession();
    const sum = (await H.t(tk, 'GET', `/api/teacher/classes/${A.classKey}/care-summary`)).json();
    assert.equal(sum.groups.find(g => g.groupId === 1).care.total, 29);
});
