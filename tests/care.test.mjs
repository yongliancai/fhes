// v6.2 照顧規則（src/core/care.js）：只有正向效果、每日上限、團隊日看參與人數
import test from 'node:test';
import assert from 'node:assert/strict';
import { moodOf, nextSlot, DAILY_CARE_LIMIT, summarizeCare, teamDayThreshold, isCareAction, CARE_BADGES } from '../src/core/care.js';

test('daily limit: slots 1..3 then nothing', () => {
    assert.equal(DAILY_CARE_LIMIT, 3);
    assert.deepEqual([0, 1, 2, 3, 9].map(nextSlot), [1, 2, 3, null, null]);
});

test('mood never goes below calm', () => {
    assert.equal(moodOf(0), 'calm'); assert.equal(moodOf(2), 'happy'); assert.equal(moodOf(6), 'thrilled'); assert.equal(moodOf(-5), 'calm');
});

test('only feed and pet are actions (no prototype tricks)', () => {
    assert.ok(isCareAction('feed') && isCareAction('pet'));
    for (const a of ['toString', '__proto__', 'constructor', 'xp', '']) assert.equal(isCareAction(a), false);
});

test('team day needs at least half of the members (rounded up)', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 0].map(teamDayThreshold), [1, 1, 2, 2, 3, 1]);
});

test('summary: per-animal care and mood, badges, team stars counted by people not clicks', () => {
    const ev = (itemId, accountId, localDate) => ({ itemId, accountId, localDate });
    const events = [
        ...Array.from({ length: 3 }, () => ev('land-01', 'a', '2026-11-25')),   // one student, 3 clicks
        ev('land-01', 'b', '2026-11-24'), ev('land-02', 'c', '2026-11-24'),     // two students on the 24th
        ...Array.from({ length: 5 }, () => ev('land-02', 'a', '2026-11-01')),
    ];
    const s = summarizeCare({ events, animalIds: ['land-01', 'land-02', 'land-03'], members: 4, today: '2026-11-25' });
    assert.equal(s.total, 10);
    assert.deepEqual(s.animals['land-01'], { care: 4, recent: 4, mood: 'happy' });
    assert.deepEqual(s.animals['land-02'], { care: 6, recent: 1, mood: 'calm' });
    assert.deepEqual(s.animals['land-03'], { care: 0, recent: 0, mood: 'calm' });
    assert.deepEqual(s.badges, ['flowerbed']); assert.equal(s.nextBadge.id, CARE_BADGES[1].id);
    assert.equal(s.teamStars, 1, 'only the 24th had 2 of 4 members; 3 clicks by one student is not a team day');
    assert.deepEqual(s.today, { participants: 1, needed: 2, members: 4 });
});
