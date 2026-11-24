import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAddedFile } from '../scripts/guardrails.mjs';
test('negative example: new Firebase SDK import is rejected', () => {
  const errors = checkAddedFile('src/cloud.mjs', "import 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';");
  assert.ok(errors.length > 0);
});
test('positive example: Google Sheets module is accepted', () => {
  assert.deepEqual(checkAddedFile('src/sheets.mjs', 'export const API = "https://sheets.googleapis.com/v4/spreadsheets";'), []);
});
test('legacy file exempt only during migration', () => {
  assert.deepEqual(checkAddedFile('index.html', '<script>firebase</script>'), []);
});
