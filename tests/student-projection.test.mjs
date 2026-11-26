// v6.2 投影（src/core/student-projection.js）：每位學生只拿到自己的最小資料，規則與 v6.1 相同
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClassProjection, validateProjection, projectionHash, LIMITS } from '../src/core/student-projection.js';
import { buildFixture, classData } from './helpers/v62-fixture.mjs';

const TODAY = '2026-11-25';
const proj = (classId = 'cls-a', opts = {}) => buildClassProjection(classData(buildFixture(), classId), { today: TODAY, ...opts });
const st = (p, id) => p.students.find(s => s.studentId === id);

test('score: only confirmed events count, redemption lowers score but not earned, hearts are not published', () => {
    const s1 = st(proj(), 'cls-a-s1');
    assert.deepEqual(s1.score, { score: 3, earned: 5 });   // +5 confirmed, pending/rejected ignored, −2 redeem
    assert.ok(!('heart' in s1.score) && !JSON.stringify(s1).includes('heart'));
});

test('homework keeps submission and correction separate; unchecked is not missing; window and archive respected', () => {
    const p = proj();
    const s1 = st(p, 'cls-a-s1'); const s2 = st(p, 'cls-a-s2'); const s3 = st(p, 'cls-a-s3');
    const hw = (s, id) => s.homework.find(h => h.assignmentId === id);
    assert.deepEqual([hw(s1, 'hw-a1').submission, hw(s1, 'hw-a1').correction], ['submitted', 'needs']);   // 已交 ≠ 已訂正
    assert.equal(hw(s1, 'hw-a2').late, true);
    assert.deepEqual([hw(s2, 'hw-a1').submission, hw(s2, 'hw-a1').correction], ['missing', null]);
    assert.deepEqual([hw(s3, 'hw-a1').submission, hw(s3, 'hw-a1').correction], ['unchecked', null]);   // 未登記 ≠ 未交
    assert.ok(!s1.homework.some(h => h.assignmentId === 'hw-a-old' || h.assignmentId === 'hw-a-arch'), 'old and archived assignments are not published');
    assert.ok(!s1.homework.some(h => h.assignmentId === 'hw-b1'), 'other class assignments never leak');
});

test('only this class, no removed students, no other students\' records inside a student DTO', () => {
    const p = proj();
    assert.deepEqual(p.students.map(s => s.studentId), ['cls-a-s1', 'cls-a-s2', 'cls-a-s3', 'cls-a-s4', 'cls-a-s5', 'cls-a-s6', 'cls-a-s7']);
    const s1 = JSON.stringify(st(p, 'cls-a-s1'));
    for (const other of ['cls-a-s2', '測試李小華', 'cls-b']) assert.ok(!s1.includes(other), `student DTO must not contain ${other}`);
    assert.equal(st(p, 'cls-a-s7').groupId, null);
});

test('group XP and animals follow v6.1: group +N counted once, revoked grants hidden, class grants not in groups, specials resolved', () => {
    const p = proj();
    const g1 = p.groups.find(g => g.groupId === 1); const g2 = p.groups.find(g => g.groupId === 2);
    assert.equal(g1.xp, 5 + 10 + 20);                    // student +5, student +10, group +20 once (not × members); pending/redeem give 0
    assert.equal(g2.xp, 6 + 12);
    assert.deepEqual(g1.animals.map(a => a.itemId), ['land-01', 'land-02']);
    assert.ok(!p.groups.some(g => g.animals.some(a => a.itemId === 'land-12')), 'class grants are not group animals');
    const sp = g2.animals.find(a => a.special);
    assert.deepEqual([sp.itemId, sp.baseItemId, sp.name, sp.rarity], ['sp-1', 'ocean-04', '合成特殊海豚', 'rare']);
    assert.equal(g1.worldId, 'land'); assert.equal(p.groups.find(g => g.groupId === 3).worldId, null);
    assert.ok(g1.animals.every(a => a.stage >= 0 && a.stage <= 3));
    assert.ok(!JSON.stringify(g1).includes('測試'), 'group DTO has no member names');
});

test('seat mode publishes seat numbers instead of names', () => {
    const p = proj('cls-a', { nameMode: 'seat' });
    assert.equal(st(p, 'cls-a-s1').name, '1號');
    assert.ok(!JSON.stringify(p).includes('測試王小明'));
});

test('a built projection validates; tampered or oversized projections are rejected', () => {
    const p = proj();
    assert.deepEqual(validateProjection(p), []);
    const bad = (mut) => { const c = structuredClone(p); mut(c); return validateProjection(c); };
    assert.ok(bad(c => { c.extra = 1; }).length);
    assert.ok(bad(c => { c.students[0].hearts = 3; }).length, 'unknown student field');
    assert.ok(bad(c => { c.students[1].studentId = c.students[0].studentId; }).length, 'duplicate student');
    assert.ok(bad(c => { c.students[0].groupId = 9; }).length, 'group must exist');
    assert.ok(bad(c => { c.students[0].homework[0].submission = 'done'; }).length);
    assert.ok(bad(c => { c.students[1].homework[0].correction = 'done'; }).length, 'correction only when submitted');
    assert.ok(bad(c => { c.groups[0].animals[0].itemId = 'nope-99'; }).length, 'non-special animal must be a catalog id');
    assert.ok(bad(c => { c.groups[0].animals[0].stage = 4; }).length);
    assert.ok(bad(c => { c.students = Array.from({ length: LIMITS.students + 1 }, (_, i) => ({ ...c.students[0], studentId: `x${i}` })); }).length);
    assert.ok(bad(c => { c.students[0].score.score = 1.5; }).length);
});

test('hash is stable for the same content and changes when content changes', async () => {
    const a = await projectionHash(proj()); const b = await projectionHash(proj());
    assert.match(a, /^[0-9a-f]{64}$/); assert.equal(a, b);
    const p = proj(); p.students[0].score.score += 1;
    assert.notEqual(await projectionHash(p), a);
});
