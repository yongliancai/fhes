import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual, currently shipped event-calculation functions, not copied implementations.
// Extraction is intentionally strict: if the legacy functions move, tests must be updated with the refactor.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function functionBlock(name) {
  const marker = 'const ' + name + ' = ';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'Production function missing: ' + name);
  const end = html.indexOf('\n        };', start);
  assert.notEqual(end, -1, 'Production function ending missing: ' + name);
  return html.slice(start, end + '\n        };'.length);
}
const isCountedLine = html.split('\n').find(line => line.includes('const isCounted = '));
assert.ok(isCountedLine, 'Production isCounted function missing');
const totals = new Map();
const groupTotals = new Map();
const context = { totals, groupTotals };
vm.runInNewContext(
  [isCountedLine, functionBlock('applyTo'), functionBlock('applyToTotals'),
   'globalThis.api = { isCounted, applyTo, applyToTotals };'].join('\n'),
  context
);
const { isCounted, applyTo, applyToTotals } = context.api;

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
  groupTotals.clear();
  applyToTotals({ classId: 'c', targetType: 'group', targetId: '1', delta: 4, status: 'pending' });
  assert.equal(groupTotals.get('c|1') ?? 0, 0);
  applyToTotals({ classId: 'c', targetType: 'group', targetId: '1', delta: 4, status: 'confirmed' });
  assert.equal(groupTotals.get('c|1'), 4);
});
test('confirmed student event updates individual totals without group double counting', () => {
  totals.clear(); groupTotals.clear();
  applyToTotals({ classId: 'c', targetType: 'student', targetId: 's', kind: 'score', delta: 3, status: 'confirmed' });
  assert.equal(totals.get('s').score, 3);
  assert.equal(totals.get('s').earned, 3);
  assert.equal(groupTotals.size, 0);
});
