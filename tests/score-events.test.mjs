// v5.1 計分語意（src/core/score.js）＋ 合成備份 fixtures 的總數對帳
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCounted, applyTo, applyEventToTotals, computeTotals, normalizeEvent, effDate } from '../src/core/score.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('only confirmed events enter the tally', () => {
    assert.equal(isCounted({ status: 'pending' }), false);
    assert.equal(isCounted({ status: 'rejected' }), false);
    assert.equal(isCounted({ status: 'confirmed' }), true);
    assert.equal(isCounted({}), true); // legacy events
});
test('heart penalty count never drops below zero', () => {
    const t = { score: 0, earned: 0, heart: 0 };
    applyTo(t, { kind: 'heart', delta: -3 });
    assert.equal(t.heart, 0);
});
test('redeeming reduces spendable score but does not reduce lifetime earned', () => {
    const t = { score: 20, earned: 20, heart: 0 };
    applyTo(t, { kind: 'score', delta: -5, redeem: true });
    assert.equal(t.score, 15);
    assert.equal(t.earned, 20);
});
test('pending group event does not change group total', () => {
    const totals = new Map(), groupTotals = new Map();
    applyEventToTotals(totals, groupTotals, { classId: 'c', targetType: 'group', targetId: '1', delta: 4, status: 'pending' });
    assert.equal(groupTotals.get('c|1') ?? 0, 0);
    applyEventToTotals(totals, groupTotals, { classId: 'c', targetType: 'group', targetId: '1', delta: 4, status: 'confirmed' });
    assert.equal(groupTotals.get('c|1'), 4);
});
test('confirmed student event updates individual totals without group double counting', () => {
    const totals = new Map(), groupTotals = new Map();
    applyEventToTotals(totals, groupTotals, { classId: 'c', targetType: 'student', targetId: 's', kind: 'score', delta: 3, status: 'confirmed' });
    assert.equal(totals.get('s').score, 3);
    assert.equal(totals.get('s').earned, 3);
    assert.equal(groupTotals.size, 0);
});
test('heart floor is applied in effective-time order (late confirmation counts on confirm time)', () => {
    // 先消除（地板 0）再確認一筆前一天記的愛心 → 最後 1；若依記錄時間排序會變 0
    const evs = [
        { id: 'x', targetType: 'student', targetId: 's', kind: 'heart', delta: 1, ts: 100, status: 'confirmed', confirmedAt: 300 },
        { id: 'y', targetType: 'student', targetId: 's', kind: 'heart', delta: -1, ts: 200, status: 'confirmed' },
    ];
    assert.equal(computeTotals(evs).totals.get('s').heart, 1);
});

for (const name of ['backup-v5.json', 'backup-v5.1.json']) {
    test(`fixture ${name}: recomputed totals match hand-checked expectations`, () => {
        const fx = fixture(name);
        const events = fx.events.map(e => ({ ...e }));
        events.forEach(normalizeEvent);
        const { totals, groupTotals } = computeTotals(events);
        for (const [sid, want] of Object.entries(fx._expected.totals)) {
            assert.deepEqual(totals.get(sid) ?? { score: 0, heart: 0, earned: 0 }, { score: want.score, heart: want.heart, earned: want.earned }, sid);
        }
        assert.deepEqual(Object.fromEntries(groupTotals), fx._expected.groups);
    });
}
test('v5.1 fixture: late-confirmed record counts on the confirmation day', () => {
    const a5 = fixture('backup-v5.1.json').events.find(e => e.id === 'a5');
    assert.equal(a5.date, '2026-11-22');
    assert.equal(effDate(a5), '2026-11-23');
});
test('normalizeEvent fills only missing v5.1 fields', () => {
    const e = { id: 'z', status: 'pending', session: '午休' };
    assert.equal(normalizeEvent(e), true);
    assert.equal(e.status, 'pending');
    assert.equal(e.session, '午休');
    assert.equal(e.recordedBy, 'teacher');
    assert.equal(normalizeEvent(e), false);
});
