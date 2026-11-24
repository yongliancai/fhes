// 守門規則的負例（必須被攔）與正例（必須通過）
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { checkFile, projectRoot, runGuardrails, LEGACY_FIREBASE_ALLOWED } from '../scripts/guardrails.mjs';

test('negative: new Firebase SDK import is rejected', () => {
    assert.ok(checkFile('src/cloud.js', "import 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';").length > 0);
    assert.ok(checkFile('src/x.js', 'const app = initializeApp(cfg);').length > 0);
});
test('positive: Google Sheets module and plain mention of the word Firebase are accepted', () => {
    assert.deepEqual(checkFile('src/sync/sheets.js', 'export const API = "https://sheets.googleapis.com/v4/spreadsheets";'), []);
    assert.deepEqual(checkFile('src/ui/notice.js', "const t = '舊版 Firebase 雲端資料不會被刪除';"), []);
});
test('legacy Firebase exemption list is explicit', () => {
    assert.ok(Array.isArray(LEGACY_FIREBASE_ALLOWED));
    for (const p of LEGACY_FIREBASE_ALLOWED) assert.deepEqual(checkFile(p, '<script>initializeApp(x)</script>'), []);
});
test('negative: hard-coded OAuth secrets and tokens are rejected anywhere', () => {
    assert.ok(checkFile('src/sync/auth.js', "const secret = 'GOCSPX-abcdefghijklmnopqrstuvwx';").length > 0);
    assert.ok(checkFile('docs/SETUP.md', 'token: ya29.a0AfH6SMBabcdefghijklmnopqrstuv').length > 0);
    assert.ok(checkFile('index.html', "const k='AIzaSyA1234567890abcdefghijklmnopqrstu';").length > 0);
});
test('positive: a public OAuth client ID placeholder is fine', () => {
    assert.deepEqual(checkFile('docs/SETUP.md', 'Client ID 例如 1234-abc.apps.googleusercontent.com'), []);
});
test('negative: innerHTML sinks in src are rejected; textContent is accepted', () => {
    assert.ok(checkFile('src/ui/hw.js', 'cell.innerHTML = name;').length > 0);
    assert.ok(checkFile('src/ui/hw.js', "el.insertAdjacentHTML('beforeend', x)").length > 0);
    assert.deepEqual(checkFile('src/ui/hw.js', 'cell.textContent = name; if (a.innerHTML === b) {}'), []);
});
test('negative: core modules must stay pure and must not import ui/sync', () => {
    assert.ok(checkFile('src/core/homework.js', 'document.querySelector("x")').length > 0);
    assert.ok(checkFile('src/core/xp.js', "import { x } from '../ui/collection.js';").length > 0);
    assert.ok(checkFile('src/sync/engine.js', "import { y } from '../ui/sync-ui.js';").length > 0);
    assert.deepEqual(checkFile('src/core/xp.js', "import { isCounted } from './score.js';"), []);
    assert.deepEqual(checkFile('src/ui/collection.js', "import { x } from '../core/xp.js'; document.body;"), []);
});
test('negative: fixtures must be marked synthetic', () => {
    assert.ok(checkFile('tests/fixtures/real.json', '{"classes":[]}').length > 0);
    assert.deepEqual(checkFile('tests/fixtures/ok.json', '{"_synthetic":true,"classes":[]}'), []);
});

// BUG-001：Windows 上 `resolve(new URL('..', import.meta.url).pathname)` 變成 C:\C:\…，guardrails 直接崩潰
test('BUG-001 regression: project root resolves to the real checkout on every OS', () => {
    const root = projectRoot(new URL('../scripts/guardrails.mjs', import.meta.url).href);
    assert.ok(existsSync(join(root, 'index.html')), root);
    if (process.platform === 'win32') {
        const oldWay = resolve(new URL('..', new URL('../scripts/guardrails.mjs', import.meta.url)).pathname);
        assert.equal(existsSync(join(oldWay, 'index.html')), false, 'the old path computation is broken on Windows (red case)');
    }
});
test('the real repository passes all guardrails', () => {
    const { errs, scanned } = runGuardrails();
    assert.deepEqual(errs, []);
    assert.ok(scanned > 10);
});
