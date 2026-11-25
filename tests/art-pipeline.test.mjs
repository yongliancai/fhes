import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOG } from '../src/data/catalog.js';
import { buildBatchPlan, checkDiffWhitelist, reconcileState, recordOutcome, selectNextRound, MAX_PER_ROUND, ROOT } from '../scripts/art-pipeline.mjs';

const prompts = JSON.parse(readFileSync(resolve(ROOT, 'art/prompts/prompts.json'), 'utf8')).items;

test('batch 1 has exactly 24 slots (6 backdrops + 18 round-robin adults) and does not miscount ocean-07/tech-10', () => {
    const plan = buildBatchPlan(CATALOG, prompts, ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    assert.equal(plan.batch1.length, 24);
    assert.deepEqual(plan.batch1.slice(0, 6).map((s) => s.key), [
        'bg-land', 'bg-ocean', 'bg-sky', 'bg-tech', 'bg-prehistoric', 'bg-fantasy',
    ]);
    // Round-robin: first 6 adults must be no.01 of all 6 worlds
    assert.deepEqual(plan.batch1.slice(6, 12).map((s) => s.key), [
        'land-01_adult', 'ocean-01_adult', 'sky-01_adult', 'tech-01_adult', 'prehistoric-01_adult', 'fantasy-01_adult',
    ]);
    assert.equal(plan.summary.batch1Approved, 1);
    assert.equal(plan.summary.batch1Fallback, 23);
    assert.deepEqual(plan.approvedOutsideBatch1.sort(), ['ocean-07_adult', 'tech-10_adult']);
});

test('selectNextRound enforces max 6 budget, skips approved land-01_adult, and stops immediately on 429 cooldown', () => {
    const plan = buildBatchPlan(CATALOG, prompts, ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    const { state } = reconcileState({}, plan, resolve(ROOT, 'art/raw-nonexistent'), ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    const r1 = selectNextRound(state, plan, { budget: 12, batchOnly: 1 });
    assert.equal(r1.stopped, false);
    assert.equal(r1.selected.length, MAX_PER_ROUND);
    assert.deepEqual(r1.selected.map((s) => s.key), ['bg-land', 'bg-ocean', 'bg-sky', 'bg-tech', 'bg-prehistoric', 'bg-fantasy']);

    // Simulate 429 RESOURCE_EXHAUSTED with retryAfter in the future
    const future = new Date(Date.now() + 3600_000).toISOString();
    const blocked = recordOutcome(state, 'bg-land', { status: 'pending', failureKind: 'RESOURCE_EXHAUSTED', retryAfter: future });
    const r2 = selectNextRound(blocked, plan, { budget: 6, batchOnly: 1 });
    assert.equal(r2.stopped, true);
    assert.equal(r2.reason, 'RESOURCE_EXHAUSTED_COOLDOWN');
    assert.equal(r2.selected.length, 0);
});

test('checkDiffWhitelist allows candidate artifacts and blocks approved.json, art-manifest.js, secrets, and local user paths', () => {
    const ok = checkDiffWhitelist(
        ['art/candidates.json', 'assets/candidates/bg-land.webp', 'docs/ART-QA-REPORT.md'],
        { 'art/candidates.json': '{"candidates":[]}', 'docs/ART-QA-REPORT.md': 'ok relative path assets/candidates/bg-land.webp' },
    );
    assert.equal(ok.ok, true);

    const bad = checkDiffWhitelist(
        ['art/approved.json', 'src/data/art-manifest.js', 'docs/ART-QA-REPORT.md'],
        { 'docs/ART-QA-REPORT.md': 'leaked C:\\Users\\someone\\secret.png' },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 3);
});
