// 同步引擎 + 真正的 Sheets adapter，對 REST 模擬器測試：雙裝置、離線佇列、冪等、重試、授權過期、衝突、競態、墓碑、手動改表
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsEmulator, createMemoryLocal } from './helpers/sheets-emulator.mjs';
import { createSheetsAdapter, createSpreadsheet, parseSpreadsheetId } from '../src/sync/sheets-adapter.js';
import { createSyncEngine, backoffMs, SyncError, diffKeys } from '../src/sync/engine.js';
import { SYNC_TABLES, headerOf } from '../src/sync/schema.js';
import { projectRecords, getRecord, buildChangeEvents } from '../src/core/homework.js';

const TOKEN = 'test-token';
const setup = async (initialA = {}, initialB = {}) => {
    const emu = createSheetsEmulator();
    const getToken = async () => TOKEN;
    const id = await createSpreadsheet({ title: 'FHES 測試', getToken, fetchFn: emu.fetch });
    const dev = (name, initial) => {
        const local = createMemoryLocal(initial);
        let token = TOKEN;
        const remote = createSheetsAdapter({ spreadsheetId: id, getToken: async () => token, fetchFn: emu.fetch });
        const engine = createSyncEngine({ local, remote, deviceId: name, now: () => Date.now() });
        return { local, remote, engine, setToken: (t) => { token = t; } };
    };
    return { emu, id, A: dev('devA', initialA), B: dev('devB', initialB) };
};
const student = (id, name, seat) => ({ id, classId: 'c1', seat, name, group: 1, removed: false });
const event = (id, delta = 1) => ({ id, classId: 'c1', ts: 1000 + Number(id.replace(/\D/g, '') || 0), date: '2026-11-24', targetType: 'student', targetId: 's1', kind: 'score', delta, status: 'confirmed', xpv: 1, xpGroup: 1 });
const noOverwrite = (emu) => assert.ok(!emu.writes.some(w => w.kind === 'CLEAR'), 'no clear / whole-sheet overwrite');

test('createSpreadsheet makes every sheet with its header row; URL parsing', async () => {
    const { emu, id } = await setup();
    for (const t of SYNC_TABLES) assert.deepEqual(emu.books.get(id).sheets.get(t.sheet)[0], headerOf(t), t.sheet);
    assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${'a'.repeat(30)}/edit#gid=0`), 'a'.repeat(30));
    assert.equal(parseSpreadsheetId('not a sheet'), null);
});

test('device A uploads, device B (empty) downloads everything; repeated sync is a no-op', async () => {
    const { emu, id, A, B } = await setup({ classes: [{ id: 'c1', name: '三年一班', groupCount: 4 }], students: [student('s1', '測試甲', 1), student('s2', '測試乙', 2)], events: [event('e1'), event('e2')] });
    const a1 = await A.engine.sync();
    assert.equal(a1.appended, 5);
    assert.equal(await A.engine.pending(), 0);
    const b1 = await B.engine.sync();
    assert.equal(b1.pulled, 5);
    assert.deepEqual(B.local.all('students').map(s => s.name).sort(), ['測試乙', '測試甲']);
    const a2 = await A.engine.sync(); const b2 = await B.engine.sync();
    assert.equal(a2.pushed + a2.pulled + b2.pushed + b2.pulled, 0, 'idempotent');
    assert.equal(emu.rows(id, 'ScoreEvents').length, 2);
    noOverwrite(emu);
});

test('an edit updates exactly one row (row-level write, never the whole sheet)', async () => {
    const { emu, id, A, B } = await setup({ students: [student('s1', '測試甲', 1), student('s2', '測試乙', 2)] });
    await A.engine.sync(); await B.engine.sync();
    const before = emu.writes.length;
    A.local.put('students', { ...A.local.get('students', 's2'), name: '測試乙乙' });
    const r = await A.engine.sync();
    assert.equal(r.updated, 1);
    const w = emu.writes.slice(before).filter(x => x.kind !== 'header');
    assert.deepEqual(w.map(x => [x.kind, x.sheet, x.rows]), [['update', 'Students', 1]]);
    await B.engine.sync();
    assert.equal(B.local.get('students', 's2').name, '測試乙乙');
    assert.equal(emu.rows(id, 'Students').length, 2);
});

test('offline queue: changes made while the network is down are kept and pushed later', async () => {
    const { emu, A, B } = await setup({ classes: [{ id: 'c1', name: 'X' }] });
    await A.engine.sync();
    ['e1', 'e2', 'e3'].forEach(e => A.local.put('events', event(e)));
    emu.fault({ network: true, times: 1 });
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'network' && e.retryable);
    assert.equal(await A.engine.pending(), 3, 'queued locally');
    const r = await A.engine.sync();
    assert.equal(r.appended, 3);
    await B.engine.sync();
    assert.equal(B.local.all('events').length, 3);
});

test('append whose response is lost (write actually succeeded) never creates duplicates on retry', async () => {
    const { emu, id, A } = await setup({ events: [event('e1'), event('e2')] });
    emu.fault({ match: /:append/, afterApply: true, network: true, times: 1 });
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'network');
    assert.equal(emu.rows(id, 'ScoreEvents').length, 2, 'rows were written');
    const r = await A.engine.sync();
    assert.equal(r.appended, 0, 'recognised as already uploaded');
    assert.equal(emu.rows(id, 'ScoreEvents').length, 2, 'no duplicate rows');
    assert.equal(await A.engine.pending(), 0);
});

test('429 / 5xx are retryable with growing backoff and do not lose data', async () => {
    const { emu, A } = await setup({ events: [event('e1')] });
    emu.fault({ status: 429, times: 1 }); emu.fault({ status: 503, times: 1 });
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'rate' && e.retryable);
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'server' && e.retryable);
    const r = await A.engine.sync();
    assert.equal(r.appended, 1);
    assert.ok(backoffMs(0) < backoffMs(1) && backoffMs(1) < backoffMs(2));
    assert.equal(backoffMs(20), 5 * 60_000, 'capped at 5 minutes');
});

test('expired / revoked OAuth token: auth error, not retried automatically, outbox kept; works after re-auth', async () => {
    const { emu, A } = await setup({ events: [event('e1')] });
    A.setToken('expired-token');
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'auth' && !e.retryable);
    assert.equal(await A.engine.pending(), 1);
    emu.addToken('fresh-token'); A.setToken('fresh-token');
    assert.equal((await A.engine.sync()).appended, 1);
});

test('permission denied (403) and missing spreadsheet (404) are reported clearly', async () => {
    const { emu, A } = await setup({ events: [event('e1')] });
    emu.fault({ status: 403, times: 1 });
    await assert.rejects(A.engine.sync(), (e) => e.kind === 'permission');
    const lost = createSyncEngine({ local: createMemoryLocal(), remote: createSheetsAdapter({ spreadsheetId: 'x'.repeat(30), getToken: async () => TOKEN, fetchFn: emu.fetch }), deviceId: 'z' });
    await assert.rejects(lost.sync(), (e) => e.kind === 'notfound');
});

test('two devices change the same record offline → conflict; nothing is silently overwritten; teacher resolves', async () => {
    const { emu, id, A, B } = await setup({ students: [student('s1', '原名', 1)] });
    await A.engine.sync(); await B.engine.sync();
    A.local.put('students', { ...A.local.get('students', 's1'), name: 'A改的' });
    B.local.put('students', { ...B.local.get('students', 's1'), name: 'B改的' });
    await A.engine.sync();
    const rb = await B.engine.sync();
    assert.equal(rb.conflicts, 1);
    assert.equal(B.local.get('students', 's1').name, 'B改的', 'local kept');
    assert.match(JSON.stringify(emu.rows(id, 'Students')[0]), /A改的/, 'remote kept');
    const [c] = await B.local.getConflicts();
    assert.deepEqual(diffKeys(c.local, c.remote), ['name']);
    // 老師選「用本機」
    const r = await B.engine.sync({ resolutions: [{ key: c.key, use: 'local' }] });
    assert.equal(r.conflicts, 0); assert.equal(r.updated, 1);
    await A.engine.sync();
    assert.equal(A.local.get('students', 's1').name, 'B改的');
});

test('conflict resolved with the cloud version', async () => {
    const { A, B } = await setup({ students: [student('s1', '原名', 1)] });
    await A.engine.sync(); await B.engine.sync();
    A.local.put('students', { ...A.local.get('students', 's1'), name: 'A版' });
    B.local.put('students', { ...B.local.get('students', 's1'), name: 'B版' });
    await A.engine.sync(); await B.engine.sync();
    const [c] = await B.local.getConflicts();
    await B.engine.sync({ resolutions: [{ key: c.key, use: 'remote' }] });
    assert.equal(B.local.get('students', 's1').name, 'A版');
    assert.equal((await B.local.getConflicts()).length, 0);
});

test('identical change on both devices is not a conflict', async () => {
    const { A, B } = await setup({ students: [student('s1', '原名', 1)] });
    await A.engine.sync(); await B.engine.sync();
    A.local.put('students', { ...A.local.get('students', 's1'), name: '一樣' });
    B.local.put('students', { ...B.local.get('students', 's1'), name: '一樣' });
    await A.engine.sync();
    assert.equal((await B.engine.sync()).conflicts, 0);
});

test('race: another device writes the row between our read and our update → we skip, next sync shows a conflict', async () => {
    const { emu, id, A, B } = await setup({ students: [student('s1', '原名', 1)] });
    await A.engine.sync(); await B.engine.sync();
    A.local.put('students', { ...A.local.get('students', 's1'), name: 'A的' });
    const origRead = A.remote.readRows;
    A.remote.readRows = async (t, rows) => {   // 在 A 確認之前，B 搶先寫入
        B.local.put('students', { ...B.local.get('students', 's1'), name: 'B搶先' });
        await B.engine.sync();
        return origRead(t, rows);
    };
    const r = await A.engine.sync();
    assert.equal(r.raced, 1); assert.equal(r.updated, 0);
    assert.match(JSON.stringify(emu.rows(id, 'Students')[0]), /B搶先/, "B's write is not clobbered");
    A.remote.readRows = origRead;
    assert.equal((await A.engine.sync()).conflicts, 1);
});

test('deletion becomes a tombstone (data kept in the sheet) and propagates', async () => {
    const { emu, id, A, B } = await setup({ events: [event('e1'), event('e2')] });
    await A.engine.sync(); await B.engine.sync();
    A.local.del('events', 'e2');
    assert.equal((await A.engine.sync()).updated, 1);
    const row = emu.rows(id, 'ScoreEvents').find(r => r[0] === 'e2');
    assert.equal(row[4], 1, 'deleted flag');
    assert.match(row[6], /"id":"e2"/, 'data kept');
    await B.engine.sync();
    assert.equal(B.local.get('events', 'e2'), undefined);
});

test('a row deleted by hand in Google Sheets does not delete local data; it is re-uploaded', async () => {
    const { emu, id, A } = await setup({ students: [student('s1', '甲', 1), student('s2', '乙', 2)] });
    await A.engine.sync();
    emu.deleteRow(id, 'Students', 2);
    const r = await A.engine.sync();
    assert.equal(r.appended, 1);
    assert.equal(A.local.all('students').length, 2);
    assert.equal(emu.rows(id, 'Students').length, 2);
});

test('corrupted cells and duplicate rows in the sheet are reported and never crash or overwrite', async () => {
    const { emu, id, A, B } = await setup({ students: [student('s1', '甲', 1), student('s2', '乙', 2)] });
    await A.engine.sync();
    emu.setCell(id, 'Students', 2, 6, '{broken json');
    const sheet = emu.books.get(id).sheets.get('Students');
    sheet.push([...sheet[2]]);                                     // s2 的重複列
    const r = await B.engine.sync();
    assert.equal(r.badRows, 1); assert.equal(r.duplicates, 1);
    assert.equal(B.local.get('students', 's1'), undefined, 'broken row is not imported');
    assert.equal(B.local.get('students', 's2').name, '乙');
});

test('student names starting with "=" are stored as plain text (no formula injection)', async () => {
    const { emu, id, A, B } = await setup({ students: [student('s1', '=HYPERLINK("http://x","點我")', 1)] });
    await A.engine.sync(); await B.engine.sync();
    assert.equal(B.local.get('students', 's1').name, '=HYPERLINK("http://x","點我")');
    assert.equal(emu.rows(id, 'Students')[0][9], '=HYPERLINK("http://x","點我")');
});

test('homework edits from two devices on the same cell sync as separate events and surface as a homework conflict', async () => {
    const asg = { id: 'A1', classId: 'c1', typeId: 'hwt-02', assignedDate: '2026-11-24', dueDate: null };
    const { A, B } = await setup({ hwAssignments: [asg] });
    await A.engine.sync(); await B.engine.sync();
    let n = 0;
    const mk = (dev, value) => buildChangeEvents({ records: projectRecords(dev.local.all('hwEvents'), [asg]), classId: 'c1', assignmentId: 'A1', studentIds: ['s1'], field: 'submission', value },
        { uid: () => `h${dev === A ? 'a' : 'b'}${++n}`, now: 5000 + n, date: '2026-11-24', deviceId: dev === A ? 'A' : 'B' }).events;
    mk(A, 'submitted').forEach(e => A.local.put('hwEvents', e));
    mk(B, 'missing').forEach(e => B.local.put('hwEvents', e));
    await A.engine.sync(); await B.engine.sync(); await A.engine.sync();
    for (const dev of [A, B]) {
        const evs = dev.local.all('hwEvents');
        assert.equal(evs.length, 2, 'both events kept (append-only, no row conflict)');
        assert.ok(getRecord(projectRecords(evs, [asg]), 'A1', 's1').conflict, 'teacher sees a homework conflict');
    }
});

test('SyncError carries kind and retryable flag', () => {
    const e = new SyncError('rate', 'x', { retryable: true });
    assert.equal(e.kind, 'rate'); assert.equal(e.retryable, true);
});

test('BUG-006: versions that differ only in updatedAt merge automatically (newest wins); real edits still conflict', async () => {
    const { A, B } = await setup({ classes: [{ id: 'c1', name: '班', updatedAt: 1 }] });
    await A.engine.sync(); await B.engine.sync();
    A.local.put('classes', { ...A.local.get('classes', 'c1'), updatedAt: 50 });
    B.local.put('classes', { ...B.local.get('classes', 'c1'), updatedAt: 60 });
    await A.engine.sync();
    const r = await B.engine.sync();
    assert.equal(r.conflicts, 0);
    await A.engine.sync();
    assert.equal(A.local.get('classes', 'c1').updatedAt, 60, 'newest bookkeeping value wins on both devices');
    A.local.put('classes', { ...A.local.get('classes', 'c1'), name: 'A', updatedAt: 70 });
    B.local.put('classes', { ...B.local.get('classes', 'c1'), name: 'B', updatedAt: 80 });
    await A.engine.sync();
    assert.equal((await B.engine.sync()).conflicts, 1, 'a real content difference is still a conflict');
});
