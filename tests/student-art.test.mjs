// v6.2 P5：學生園區用穩定圖鑑 ID 查核准圖片；沒有圖就退回 SVG
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickArtFile } from '../src/art/student-art.js';
import { ART_ASSETS } from '../src/data/art-manifest.js';
import { CATALOG } from '../src/data/catalog.js';

test('picks young for stages 0–1 and adult for 2–3, falls back between them, null without approved art', () => {
    const m = { 'land-01': ['adult', 'young'], 'ocean-07': ['adult'], 'tech-10': ['young'] };
    assert.equal(pickArtFile(m, 'land-01', 0), '/assets/creatures/land-01_young.webp');
    assert.equal(pickArtFile(m, 'land-01', 3), '/assets/creatures/land-01_adult.webp');
    assert.equal(pickArtFile(m, 'ocean-07', 0), '/assets/creatures/ocean-07_adult.webp');
    assert.equal(pickArtFile(m, 'tech-10', 3), '/assets/creatures/tech-10_young.webp');
    assert.equal(pickArtFile(m, 'sky-01', 2), null);
    assert.equal(pickArtFile(m, 'sp-unknown', 2), null);
});

test('the shipped manifest only lists catalog items (no candidate or unknown art)', () => {
    const ids = new Set(CATALOG.map(c => c.id));
    for (const [id, stages] of Object.entries(ART_ASSETS)) {
        assert.ok(ids.has(id), id);
        assert.ok(stages.every(s => ['adult', 'young'].includes(s)));
    }
});
