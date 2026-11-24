// 備份格式契約（src/core/backup.js）：v4 / v5 / v5.1 / 目前版本皆可讀；較新版本拒絕
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBackup, buildBackup, convertV4, BACKUP_TABLES, backupSummary } from '../src/core/backup.js';
import { newClassObj } from '../src/core/classes.js';
import { computeTotals } from '../src/core/score.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
let n = 0;
const deps = { uid: () => `id${++n}`, now: Date.UTC(2026, 10, 24, 1), today: '2026-11-24', newClassObj };
const conv = (arr) => convertV4(arr, deps);
const DATA_VERSION = 6;
const parse = (d) => parseBackup(d, { dataVersion: DATA_VERSION, convertV4: conv });

const valid = {
    format: 'classroom-powerhouse', version: 5.1, classes: [{ id: 'fake-class' }],
    students: [{ id: 'fake-student', classId: 'fake-class' }],
    events: [{ id: 'fake-event', classId: 'fake-class', status: 'confirmed' }],
    dailySnapshots: [{ id: 'fake-class|2026-11-24' }],
    meta: { lastSettledDate: {} },
};

test('backup parser accepts synthetic v5.1 shape and preserves all tables', () => {
    const out = parse(valid);
    for (const field of ['classes', 'students', 'events', 'dailySnapshots']) assert.equal(out[field].length, 1, field);
    assert.equal(out.kind, 'v5.1');
    for (const k of BACKUP_TABLES) assert.ok(Array.isArray(out[k]), `${k} defaults to an array`);
});
test('parser refuses a future data version instead of silently downgrading', () => {
    assert.throws(() => parse({ ...valid, version: 999 }), /較新版本/);
});
test('parser refuses unrelated objects', () => {
    assert.throws(() => parse({ classes: [] }), /檔案格式錯誤/);
});
test('backward version v5 with optional missing event list can be parsed', () => {
    const out = parse({ format: valid.format, version: 5, classes: [] });
    assert.equal(out.kind, 'v5');
    assert.equal(out.events.length, 0);
});
test('v4 fixture converts scores into one opening-balance event per non-zero student', () => {
    const out = parse(fixture('backup-v4.json').data);
    assert.equal(out.kind, 'v4');
    assert.equal(out.classes.length, 1);
    assert.equal(out.students.length, 3);
    assert.deepEqual(out.events.map(e => [e.targetId, e.delta, e.reason]), [['s41', 5, '期初結轉'], ['s43', -2, '期初結轉']]);
    const { totals } = computeTotals(out.events);
    assert.equal(totals.get('s41').score, 5);
    assert.ok(out.classes[0].penaltyReasons.length > 0, 'converted class gets v5.1 defaults');
});
for (const name of ['backup-v5.json', 'backup-v5.1.json']) {
    test(`fixture ${name} parses with every record kept`, () => {
        const fx = fixture(name);
        const out = parse(fx);
        assert.equal(out.events.length, fx.events.length);
        assert.equal(out.students.length, fx.students.length);
        assert.equal(out.dailySnapshots.length, fx.dailySnapshots.length);
        assert.deepEqual(out.meta, fx.meta);
    });
}
test('build → parse round trip is lossless for every table', () => {
    const fx = fixture('backup-v5.1.json');
    const state = { classes: fx.classes, students: fx.students, events: fx.events, dailySnapshots: fx.dailySnapshots,
        hwAssignments: [{ id: 'h1' }], hwEvents: [{ id: 'he1' }], xpEvents: [{ id: 'x1' }], specialItems: [{ id: 'sp1' }], grants: [{ id: 'g1' }] };
    const json = JSON.parse(JSON.stringify(buildBackup(state, { dataVersion: DATA_VERSION, appVersion: 'test', now: 1, meta: fx.meta })));
    const back = parse(json);
    for (const k of BACKUP_TABLES) assert.deepEqual(back[k], state[k], k);
    assert.deepEqual(backupSummary(back), { classes: 1, students: 3, events: 10, dailySnapshots: 1, hwAssignments: 1, hwEvents: 1, xpEvents: 1, specialItems: 1, grants: 1 });
});

test('rollback: v5.1-compatible export is accepted by a v5.1 parser and keeps all score history', async () => {
    const { buildLegacyV51Backup } = await import('../src/core/backup.js');
    const fx = fixture('backup-v5.1.json');
    const state = { classes: fx.classes, students: fx.students, events: fx.events.map(e => ({ ...e, xpv: 1, xpGroup: 1 })), dailySnapshots: fx.dailySnapshots, hwEvents: [{ id: 'x' }], grants: [{ id: 'g' }] };
    const out = JSON.parse(JSON.stringify(buildLegacyV51Backup(state, { meta: fx.meta })));
    assert.equal(out.version, 5.1);
    assert.equal(out.hwEvents, undefined, 'v6-only tables are not included');
    const parsedBy51 = parseBackup(out, { dataVersion: 5.1, convertV4: conv });   // 等同 v5.1 程式的檢查
    assert.equal(parsedBy51.events.length, fx.events.length);
    assert.throws(() => parseBackup({ ...out, version: 6 }, { dataVersion: 5.1, convertV4: conv }), /較新版本/, 'a normal v6 backup is refused by v5.1 — hence this export');
});
