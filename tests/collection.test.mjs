// 圖鑑、XP、收藏授予、特殊收藏與標籤（src/data/catalog.js、src/core/xp.js、src/core/collection.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, WORLDS, RARITIES, catalogById } from '../src/data/catalog.js';
import { xpLedger, sumXp, xpOf, groupKey, milestoneState } from '../src/core/xp.js';
import {
    validateCatalog, makeGrant, revokeGrant, grantId, owns, energyOf, canUnlock, growthStage, worldProgress, fillCollectionDefaults,
    validateSpecialItem, makeSpecialItem, addTag, renameTag, setTagActive, tagImpact, deleteTag, DEFAULT_TAGS, STAGE_XP,
} from '../src/core/collection.js';
import { ensureClassDefaults, registerClassDefaults } from '../src/core/classes.js';

registerClassDefaults(fillCollectionDefaults);
const newClass = () => { const c = { id: 'c' }; ensureClassDefaults(c); return c; };
let t = 0; let n = 0;
const ev = (o) => ({ id: `e${++n}`, classId: 'c', ts: (t += 10), date: '2026-11-24', targetType: 'student', kind: 'score', delta: 1, status: 'confirmed', xpv: 1, ...o });
const byName = (name) => CATALOG.find(x => x.name === name);

// ------------------------------------------------------------------ catalogue
test('catalogue: 6 worlds × 12 base items, rarity 5/4/2/1 each, unique stable ids', () => {
    assert.deepEqual(validateCatalog(), []);
    assert.equal(CATALOG.length, 72);
    assert.deepEqual(WORLDS.map(w => w.name), ['陸地', '海洋', '天空', '科技', '史前', '奇幻']);
    assert.equal(new Set(CATALOG.map(c => c.id)).size, 72);
    assert.match(CATALOG[0].id, /^land-01$/);
});
test('catalogue validation catches a broken rarity ratio (negative case)', () => {
    const broken = CATALOG.map(c => c.id === 'ocean-12' ? { ...c, rarity: 'epic' } : c);
    assert.ok(validateCatalog(broken).some(e => /海洋/.test(e)));
    assert.ok(validateCatalog(CATALOG.filter(c => c.id !== 'sky-01')).some(e => /天空 應有 12/.test(e)));
});
test('land world matches the user-confirmed roster and rarities', () => {
    const want = { 水豚: ['common', 'U'], 狐獴: ['common', 'U'], 樹懶: ['common', 'U'], 臺灣黑熊: ['epic', 'U'], 雲豹: ['epic', 'U'], 雪豹: ['legendary', 'U'],
        貓咪: ['common', 'UE'], 狗狗: ['common', 'UE'], 長頸鹿: ['rare', 'UE'], 小貓熊: ['rare', 'E'], 穿山甲: ['rare', 'E'], 耳廓狐: ['rare', 'E'] };
    for (const [name, [rarity, confirm]] of Object.entries(want)) {
        const it = byName(name);
        assert.ok(it, name); assert.equal(it.world, 'land', name); assert.equal(it.rarity, rarity, name); assert.equal(it.confirm, confirm, name);
    }
    assert.equal(byName('霍加狓'), undefined, 'okapi was replaced by giraffe');
    assert.equal(byName('大象'), undefined, 'elephant must not replace the clouded leopard');
    assert.ok(CATALOG.filter(c => c.world !== 'land').every(c => c.confirm === 'E'), 'other worlds are marked as expert proposals, not user-approved');
});
test('every item has a fact card and an art spec; prehistoric cards clarify non-dinosaurs', () => {
    for (const it of CATALOG) { assert.ok(it.fact.length >= 8, it.id); assert.ok(it.art?.p, it.id); assert.equal(it.artStatus, 'placeholder'); }
    assert.match(byName('翼龍').fact, /不是恐龍/);
    assert.match(byName('滄龍').fact, /不是恐龍/);
    assert.match(byName('猛獁象').fact, /不是恐龍/);
});
test('rarity is conveyed by colour + icon + text (not colour alone)', () => {
    for (const r of RARITIES) { assert.ok(r.icon && r.name && r.color); }
    assert.equal(new Set(RARITIES.map(r => r.icon)).size, 4);
});

// ------------------------------------------------------------------ XP
test('student +N gives own group +N and class +N; group +N gives the group +N once (never × members)', () => {
    const ledger = xpLedger([ev({ targetId: 's1', xpGroup: 1, delta: 2 }), ev({ targetType: 'group', targetId: '2', delta: 3 })]);
    const { group, cls } = sumXp(ledger);
    assert.equal(group.get(groupKey('c', 1)), 2);
    assert.equal(group.get(groupKey('c', 2)), 3);
    assert.equal(cls.get('c'), 5);
});
test('group size does not change group XP (fairness between a 2-person and a 7-person group)', () => {
    const big = xpLedger([ev({ targetType: 'group', targetId: '1', delta: 1 })]);
    const small = xpLedger([ev({ targetType: 'group', targetId: '2', delta: 1 })]);
    assert.equal(xpOf(big, 'group', 'c|1'), xpOf(small, 'group', 'c|2'));
});
test('no XP from penalties, negative scores, redemptions, pending/rejected, undone/revoked, or legacy events', () => {
    const ledger = xpLedger([
        ev({ kind: 'heart', delta: 1, xpGroup: 1 }), ev({ delta: -2, xpGroup: 1 }), ev({ delta: -5, redeem: true, xpGroup: 1 }),
        ev({ status: 'pending', xpGroup: 1 }), ev({ status: 'rejected', xpGroup: 1 }), ev({ undone: true, xpGroup: 1 }), ev({ revoked: true, xpGroup: 1 }),
        ev({ delta: -1, undoOf: 'x', xpGroup: 1 }), ev({ xpv: undefined, xpGroup: 1 }),
    ]);
    assert.equal(ledger.length, 0);
});
test('a student moving groups keeps old XP with the old group; new XP goes to the new group', () => {
    const ledger = xpLedger([ev({ targetId: 's1', xpGroup: 1 }), ev({ targetId: 's1', xpGroup: 3 })]);
    assert.equal(xpOf(ledger, 'group', 'c|1'), 1);
    assert.equal(xpOf(ledger, 'group', 'c|3'), 1);
});
test('manual XP events (class bonus / homework all-in) count; voided ones do not', () => {
    const ledger = xpLedger([], [{ id: 'hwbonus|A', classId: 'c', scope: 'class', scopeId: 'c', delta: 5, ts: 1 }, { id: 'x2', classId: 'c', scope: 'group', scopeId: '2', delta: 4, ts: 2, voided: true }]);
    assert.equal(xpOf(ledger, 'class', 'c'), 5);
    assert.equal(xpOf(ledger, 'group', 'c|2'), 0);
});
test('class milestones unlock by class XP', () => {
    const m = milestoneState(60);
    assert.deepEqual(m.reached.map(x => x.name), ['星光小徑', '彩虹橋']);
    assert.equal(m.next.name, '大樹屋');
    assert.equal(m.toNext, 40);
});

// ------------------------------------------------------------------ grants & unlocks
test('grant ids are deterministic: re-sending the same unlock never creates a duplicate', () => {
    const c = newClass();
    const grants = [];
    for (let i = 0; i < 10; i++) { const g = makeGrant({ c, ownerType: 'group', ownerId: 1, itemId: 'land-01', source: 'xp', cost: 10, now: i }, grants); if (g) grants.push(g); }
    assert.equal(grants.length, 1);
    assert.equal(grants[0].id, grantId('c', 'group', '1', 'land-01'));
});
test('sequential mode requires the lower rarities of that world first; free mode does not', () => {
    const c = newClass();
    const ledger = xpLedger(Array.from({ length: 200 }, () => ev({ targetType: 'group', targetId: '1' })));
    const args = { ledger, grants: [], c, ownerType: 'group', ownerId: '1' };
    assert.equal(canUnlock({ ...args, itemId: 'land-01' }).ok, true);
    const rare = canUnlock({ ...args, itemId: 'land-06' });
    assert.equal(rare.ok, false); assert.equal(rare.locked, true);
    c.collection.mode = 'free';
    assert.equal(canUnlock({ ...args, itemId: 'land-12' }).ok, true);
});
test('energy = period XP − XP spent on unlocks; insufficient energy blocks; theme world gives no multiplier', () => {
    const c = newClass(); c.groupWorlds = { 1: 'ocean' };
    const ledger = xpLedger(Array.from({ length: 12 }, () => ev({ targetType: 'group', targetId: '1' })));
    const grants = [];
    const args = () => ({ ledger, grants, c, ownerType: 'group', ownerId: '1' });
    assert.deepEqual(energyOf(args()), { earned: 12, spent: 0, available: 12 });
    const u = canUnlock({ ...args(), itemId: 'land-01' });
    assert.equal(u.ok, true); assert.equal(u.cost, 10);
    grants.push(makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: 'land-01', source: 'xp', cost: u.cost, now: 1e12 }, grants));
    assert.equal(energyOf(args()).available, 2);
    assert.equal(canUnlock({ ...args(), itemId: 'land-02' }).ok, false);
    assert.equal(canUnlock({ ...args(), itemId: 'ocean-01' }).cost, 10, 'home world costs the same');
});
test('collected items survive penalties, redemptions, XP corrections and group changes', () => {
    const c = newClass();
    const events = Array.from({ length: 10 }, () => ev({ targetId: 's1', xpGroup: 1 }));
    assert.equal(energyOf({ ledger: xpLedger(events), grants: [], c, ownerType: 'group', ownerId: '1' }).available, 10);
    const grants = [makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: 'land-01', source: 'xp', cost: 10, now: 1 }, [])];
    events.push(ev({ kind: 'heart', delta: 1, xpGroup: 1 }), ev({ delta: -8, redeem: true, xpGroup: 1 }));
    events.slice(0, 5).forEach(e => { e.undone = true; });          // 老師更正誤加分 → XP 下降
    const ledger = xpLedger(events);
    assert.equal(owns(grants, 'c', 'group', '1', 'land-01'), true, 'item is still owned');
    assert.equal(energyOf({ ledger, grants, c, ownerType: 'group', ownerId: '1' }).available, -5, 'energy can go negative; nothing is taken back');
    assert.deepEqual(worldProgress(grants, c, 'group', '1').land, 1);
});
test('teacher revoke of a mistaken grant keeps the record and refunds energy; re-grant is allowed', () => {
    const c = newClass();
    const g = makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: 'land-01', source: 'xp', cost: 10, now: 1 }, []);
    assert.throws(() => revokeGrant(g, '  ', 2), /原因/);
    const r = revokeGrant(g, '按錯組別', 2);
    assert.equal(r.revoked, true); assert.equal(r.revokeNote, '按錯組別');
    assert.equal(owns([r], 'c', 'group', '1', 'land-01'), false);
    assert.ok(makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: 'land-01', source: 'teacher', now: 3 }, [r]));
});
test('XP period reset: energy restarts, collections and growth stay', () => {
    const c = newClass();
    const events = Array.from({ length: 30 }, () => ev({ targetType: 'group', targetId: '1' }));
    const ledger = xpLedger(events);
    const g = makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: 'land-01', source: 'xp', cost: 10, now: 0 }, []);
    c.collection.periodStart = t + 1;
    assert.equal(energyOf({ ledger, grants: [g], c, ownerType: 'group', ownerId: '1' }).available, 0);
    assert.equal(owns([g], 'c', 'group', '1', 'land-01'), true);
    const gs = growthStage({ ledger, grant: g });
    assert.equal(gs.xpSince, 30, 'growth uses all XP since acquisition, ignoring the period reset');
    assert.equal(gs.stage, 2);
});
test('growth stage thresholds', () => {
    const mk = (k) => xpLedger(Array.from({ length: k }, () => ev({ targetType: 'group', targetId: '1' })));
    const g = { classId: 'c', ownerType: 'group', ownerId: '1', acquiredAt: 0 };
    assert.equal(growthStage({ ledger: mk(0), grant: g }).stage, 0);
    assert.equal(growthStage({ ledger: mk(STAGE_XP[1]), grant: g }).stage, 1);
    assert.equal(growthStage({ ledger: mk(STAGE_XP[3]), grant: g }).stage, 3);
});

// ------------------------------------------------------------------ special items & tags
test('special items: own ids, max 2 tags, no duplicates, never counted in the base 12', () => {
    const c = newClass();
    const sp = makeSpecialItem({ classId: 'c', name: '聖誕貓咪', rarity: 'rare', tagIds: ['tag-festival', 'tag-skin'], baseItemId: 'land-01' }, { uid: () => 'x1', now: 1 });
    assert.match(sp.id, /^sp-/);
    assert.ok(!catalogById.has(sp.id));
    assert.deepEqual(validateSpecialItem(sp, c.collectionTags), []);
    assert.ok(validateSpecialItem({ ...sp, tagIds: ['tag-festival', 'tag-skin', 'tag-coop'] }, c.collectionTags).some(e => /最多 2/.test(e)));
    assert.ok(validateSpecialItem({ ...sp, tagIds: ['tag-skin', 'tag-skin'] }, c.collectionTags).some(e => /重複/.test(e)));
    const g = makeGrant({ c, ownerType: 'group', ownerId: '1', itemId: sp.id, special: true, source: 'special', now: 1 }, []);
    assert.equal(worldProgress([g], c, 'group', '1').land, 0, 'special item does not occupy a base slot');
});
test('builtin tags: cannot be deleted or renamed; disabled → kept on old items, not selectable for new ones; re-enable works', () => {
    const c = newClass();
    assert.deepEqual(c.collectionTags.map(t => t.name), DEFAULT_TAGS.map(t => t.name));
    assert.throws(() => deleteTag(c, [], 'tag-festival', 1), /不能刪除/);
    assert.throws(() => renameTag(c, 'tag-festival', '新年'), /不能改名/);
    setTagActive(c, 'tag-festival', false);
    const old = { name: '舊收藏', rarity: 'common', tagIds: ['tag-festival'] };
    assert.deepEqual(validateSpecialItem(old, c.collectionTags, { isNew: false, previousTagIds: ['tag-festival'] }), [], 'existing item keeps the disabled tag');
    assert.ok(validateSpecialItem({ ...old }, c.collectionTags, { isNew: true }).some(e => /已停用/.test(e)), 'new item cannot pick it');
    setTagActive(c, 'tag-festival', true);
    assert.deepEqual(validateSpecialItem({ ...old }, c.collectionTags), []);
});
test('custom tags: rename keeps the stable id; delete previews impact and removes only the association', () => {
    const c = newClass();
    const tag = addTag(c, '運動會', 'tag-c1');
    assert.throws(() => addTag(c, '運動會', 'tag-c2'), /已經存在/);
    const items = [{ id: 'sp-1', name: 'A', rarity: 'common', tagIds: ['tag-c1', 'tag-coop'] }, { id: 'sp-2', name: 'B', rarity: 'rare', tagIds: ['tag-skin'] }];
    renameTag(c, tag.id, '運動會紀念');
    assert.equal(c.collectionTags.find(x => x.id === 'tag-c1').name, '運動會紀念');
    assert.deepEqual(tagImpact(items, 'tag-c1').map(s => s.id), ['sp-1']);
    const { updatedItems } = deleteTag(c, items, 'tag-c1', 5);
    assert.deepEqual(updatedItems.map(s => [s.id, s.tagIds]), [['sp-1', ['tag-coop']]]);
    assert.ok(!c.collectionTags.some(x => x.id === 'tag-c1'));
    assert.equal(items.length, 2, 'no collectible is deleted');
});
test('tags are classification only: unlock rules never read tag ids', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/core/collection.js', import.meta.url), 'utf8');
    const unlockFn = src.slice(src.indexOf('export const canUnlock'), src.indexOf('export const makeGrant'));
    assert.ok(!/tag/i.test(unlockFn), 'canUnlock must not depend on tags');
});
