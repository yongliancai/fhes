// index.html 必須使用 src/core 的單一實作，不可再複製一份計分／備份邏輯（避免兩份規則漂移）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html imports the core modules', () => {
    for (const m of ['./src/core/score.js', './src/core/backup.js', './src/core/classes.js', './src/core/dates.js']) {
        assert.match(html, new RegExp(`from '${m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`), m);
    }
});
test('index.html does not redefine core scoring/backup rules inline', () => {
    for (const name of ['isCounted', 'applyTo', 'normalizeEvent', 'isV4Data', 'ensureClassDefaults']) {
        assert.doesNotMatch(html, new RegExp(`(?:const|function)\\s+${name}\\b`), name);
    }
});
