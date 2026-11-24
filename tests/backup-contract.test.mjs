import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function extractNamedArrow(name) {
  const start = source.indexOf('const ' + name + ' = ');
  assert.notEqual(start, -1, name + ' must exist in production');
  const end = source.indexOf('\n        };', start);
  assert.notEqual(end, -1, name + ' must have expected body boundary');
  return source.slice(start, end + '\n        };'.length);
}
const context = { DATA_VERSION: 5.1, isV4Data: () => false };
vm.runInNewContext(extractNamedArrow('parseBackup') + '\nglobalThis.parseBackupAPI = parseBackup;', context);
const parseBackup = context.parseBackupAPI;
const valid = {
  format: 'classroom-powerhouse', version: 5.1, classes: [{ id: 'fake-class' }],
  students: [{ id: 'fake-student', classId: 'fake-class' }],
  events: [{ id: 'fake-event', classId: 'fake-class', status: 'confirmed' }],
  dailySnapshots: [{ id: 'fake-class|2026-11-24' }],
  meta: { lastSettledDate: {} }
};

test('production backup parser accepts synthetic v5.1 shape and preserves all tables', () => {
  const out = parseBackup(valid);
  for (const field of ['classes', 'students', 'events', 'dailySnapshots']) {
    assert.equal(out[field].length, 1, field);
  }
  assert.equal(out.kind, 'v5.1');
});
test('production parser refuses a future data version instead of silently downgrading', () => {
  assert.throws(() => parseBackup({ ...valid, version: 999 }), /較新版本/);
});
test('production parser refuses unrelated objects', () => {
  assert.throws(() => parseBackup({ classes: [] }), /檔案格式錯誤/);
});
test('backward version v5 with optional missing event list can be parsed', () => {
  const out = parseBackup({ format: valid.format, version: 5, classes: [] });
  assert.equal(out.kind, 'v5');
  assert.equal(out.events.length, 0);
});
