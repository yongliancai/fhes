import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CATALOG } from '../src/data/catalog.js';
import {
    acquireLock,
    buildBatchPlan,
    checkDiffWhitelist,
    executeRecord,
    reconcileState,
    recordOutcome,
    releaseLock,
    selectNextRound,
    upsertGenerationLogCsv,
    MAX_PER_ROUND,
    ROOT,
} from '../scripts/art-pipeline.mjs';

const prompts = JSON.parse(readFileSync(resolve(ROOT, 'art/prompts/prompts.json'), 'utf8')).items;

const runPython = (args, cwd = ROOT) => {
    try {
        const stdout = execFileSync('python', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
    } catch (err) {
        return { code: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
};

const makeSandbox = (name) => {
    const dir = resolve(ROOT, 'art/raw', `_test-${name}-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(dir, 'art/prompts'), { recursive: true });
    mkdirSync(resolve(dir, 'art/raw'), { recursive: true });
    mkdirSync(resolve(dir, 'assets/candidates'), { recursive: true });
    mkdirSync(resolve(dir, 'src/data'), { recursive: true });
    copyFileSync(resolve(ROOT, 'art/prompts/prompts.json'), resolve(dir, 'art/prompts/prompts.json'));
    copyFileSync(resolve(ROOT, 'art/approved.json'), resolve(dir, 'art/approved.json'));
    copyFileSync(resolve(ROOT, 'src/data/art-manifest.js'), resolve(dir, 'src/data/art-manifest.js'));
    writeFileSync(resolve(dir, 'art/candidates.json'), JSON.stringify({ _note: 'test', updatedAt: '', candidates: [] }, null, 2) + '\n');
    return dir;
};

test('batch 1 has exactly 24 slots (6 backdrops + 18 round-robin adults) and does not miscount ocean-07/tech-10', () => {
    const plan = buildBatchPlan(CATALOG, prompts, ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    assert.equal(plan.batch1.length, 24);
    assert.deepEqual(plan.batch1.slice(0, 6).map((s) => s.key), [
        'bg-land', 'bg-ocean', 'bg-sky', 'bg-tech', 'bg-prehistoric', 'bg-fantasy',
    ]);
    assert.deepEqual(plan.batch1.slice(6, 12).map((s) => s.key), [
        'land-01_adult', 'ocean-01_adult', 'sky-01_adult', 'tech-01_adult', 'prehistoric-01_adult', 'fantasy-01_adult',
    ]);
    assert.equal(plan.summary.batch1Approved, 1);
    assert.equal(plan.summary.batch1Fallback, 23);
    assert.deepEqual(plan.approvedOutsideBatch1.sort(), ['ocean-07_adult', 'tech-10_adult']);
});

test('art-qc.py converts synthetic JPG to PNG and passes QC for valid 1024x1024 character and 16:9 backdrop', () => {
    const work = resolve(ROOT, 'art/raw', `_qc-pass-${process.pid}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    try {
        const charJpg = resolve(work, 'ocean-01_adult.jpg');
        const charPng = resolve(work, 'ocean-01_adult.png');
        const bgJpg = resolve(work, 'bg-land.jpg');
        const bgPng = resolve(work, 'bg-land.png');
        const pyGen = `
from PIL import Image, ImageDraw
im = Image.new('RGB', (1024, 1024), (0, 255, 0))
d = ImageDraw.Draw(im)
d.ellipse([260, 220, 764, 820], fill=(255, 130, 40))
im.save(r'''${charJpg}''', format='JPEG', quality=95)
bg = Image.new('RGB', (1600, 900), (120, 190, 235))
bd = ImageDraw.Draw(bg)
bd.rectangle([0, 585, 1600, 900], fill=(115, 185, 95))
bg.save(r'''${bgJpg}''', format='JPEG', quality=95)
`;
        assert.equal(runPython(['-c', pyGen]).code, 0);

        const r1 = runPython(['scripts/art-qc.py', 'ocean-01_adult', '--from-jpg', charJpg, '--raw', charPng, '--out-dir', work]);
        assert.equal(r1.code, 0, r1.stdout + r1.stderr);
        const j1 = JSON.parse(r1.stdout);
        assert.equal(j1.technical_status, 'qc_pass');
        assert.equal(j1.meta.converted_from_jpg, true);
        assert.equal(j1.manual_review_required, true);
        assert.equal(existsSync(charPng), true);
        assert.equal(existsSync(resolve(work, 'ocean-01_adult.webp')), true);

        const r2 = runPython(['scripts/art-qc.py', 'bg-land', '--from-jpg', bgJpg, '--raw', bgPng, '--out-dir', work]);
        assert.equal(r2.code, 0, r2.stdout + r2.stderr);
        const j2 = JSON.parse(r2.stdout);
        assert.equal(j2.technical_status, 'qc_pass');
        assert.equal(j2.meta.square_only, false);
        assert.deepEqual(j2.meta.webp_size, [1920, 864]);
        assert.equal(existsSync(bgPng), true);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});

test('art-qc.py fails safely on low-res, uneven background, corrupted file, invalid key, or out-of-workspace path', () => {
    const work = resolve(ROOT, 'art/raw', `_qc-fail-${process.pid}-${Date.now()}`);
    const extFile = join(tmpdir(), `fhes-outside-${process.pid}.jpg`);
    mkdirSync(work, { recursive: true });
    try {
        const lowJpg = resolve(work, 'low.jpg');
        const corruptJpg = resolve(work, 'corrupt.jpg');
        const gradPng = resolve(work, 'grad.png');
        writeFileSync(corruptJpg, 'not-a-valid-image');
        writeFileSync(extFile, 'external-file');
        const pyGen = `
from PIL import Image
Image.new('RGB', (256, 256), (0, 255, 0)).save(r'''${lowJpg}''', format='JPEG')
g = Image.new('RGB', (1024, 1024), (0, 255, 0))
for x in range(1024):
    for y in range(1024):
        g.putpixel((x, y), (int(x / 4), 255 - int(y / 6), 0))
g.save(r'''${gradPng}''', format='PNG')
`;
        assert.equal(runPython(['-c', pyGen]).code, 0);

        // Low-res JPG fails QC and leaves no WebP behind
        const rLow = runPython(['scripts/art-qc.py', 'ocean-02_adult', '--from-jpg', lowJpg, '--raw', resolve(work, 'ocean-02_adult.png'), '--out-dir', work]);
        assert.notEqual(rLow.code, 0);
        assert.equal(JSON.parse(rLow.stdout).technical_status, 'qc_fail');
        assert.equal(existsSync(resolve(work, 'ocean-02_adult.webp')), false);

        // Gradient background fails QC
        const rGrad = runPython(['scripts/art-qc.py', 'ocean-03_adult', '--raw', gradPng, '--out-dir', work]);
        assert.notEqual(rGrad.code, 0);
        assert.match(JSON.parse(rGrad.stdout).issues.join(','), /uneven_background/);

        // Corrupted JPG rejected safely
        const rCorrupt = runPython(['scripts/art-qc.py', 'sky-01_adult', '--from-jpg', corruptJpg, '--raw', resolve(work, 'sky-01_adult.png'), '--out-dir', work]);
        assert.notEqual(rCorrupt.code, 0);
        assert.match(JSON.parse(rCorrupt.stdout).issues.join(','), /jpg_conversion_failed/);

        // Missing file rejected safely
        const rMiss = runPython(['scripts/art-qc.py', 'sky-02_adult', '--raw', resolve(work, 'missing.png'), '--out-dir', work]);
        assert.notEqual(rMiss.code, 0);
        assert.match(JSON.parse(rMiss.stdout).issues.join(','), /missing_raw_file/);

        // Invalid traversal key rejected
        const rKey = runPython(['scripts/art-qc.py', '../escape']);
        assert.notEqual(rKey.code, 0);
        assert.match(JSON.parse(rKey.stdout).issues.join(','), /invalid_key/);

        // Reading arbitrary file outside project worktree rejected
        const rExtRead = runPython(['scripts/art-qc.py', 'sky-03_adult', '--from-jpg', extFile, '--raw', resolve(work, 'sky-03_adult.png'), '--out-dir', work]);
        assert.notEqual(rExtRead.code, 0);
        assert.match(JSON.parse(rExtRead.stdout).issues.join(','), /source_path_outside_allowed_roots/);

        // Writing to assets/creatures or outside workspace rejected
        const rBadOut = runPython(['scripts/art-qc.py', 'sky-03_adult', '--out-dir', 'assets/creatures']);
        assert.notEqual(rBadOut.code, 0);
        assert.match(JSON.parse(rBadOut.stdout).issues.join(','), /out_dir_outside_allowed_dirs/);

        // Refuses overwriting approved asset's raw PNG
        const rApproved = runPython(['scripts/art-qc.py', 'land-01_adult', '--from-jpg', lowJpg]);
        assert.notEqual(rApproved.code, 0);
        assert.match(JSON.parse(rApproved.stdout).issues.join(','), /refuse_overwrite_approved_raw/);
    } finally {
        rmSync(work, { recursive: true, force: true });
        rmSync(extFile, { force: true });
    }
});

test('record handles 503/429 state, deduplicates CSV/candidates, recovers interrupted checkpoints, and protects approved/manifest', () => {
    const sb = makeSandbox('record');
    try {
        const approvedBefore = readFileSync(resolve(sb, 'art/approved.json'), 'utf8');
        const manifestBefore = readFileSync(resolve(sb, 'src/data/art-manifest.js'), 'utf8');

        // 1. Record HTTP 503 on bg-land (resumable, attempt stays 0)
        const r503 = executeRecord(sb, {
            key: 'bg-land',
            status: 'pending',
            attempt: 0,
            model: 'gemini-3.1-flash-image',
            failureKind: 'HTTP_503_UNAVAILABLE',
            error: 'No capacity available (2 attempts)',
        }, '2026-11-26T10:00:00+08:00');
        assert.equal(r503.ok, true);
        assert.equal(r503.status, 'pending');
        assert.equal(r503.quota.blocked, false);

        // 2. Record HTTP 429 with retryAfter -> halts selectNextRound
        const future = new Date(Date.now() + 3600_000).toISOString();
        const r429 = executeRecord(sb, {
            key: 'bg-land',
            status: 'pending',
            attempt: 0,
            model: 'gemini-3.1-flash-image',
            failureKind: 'RESOURCE_EXHAUSTED',
            retryAfter: future,
            error: 'HTTP 429 RESOURCE_EXHAUSTED',
        }, '2026-11-26T10:05:00+08:00');
        assert.equal(r429.quota.blocked, true);
        assert.equal(r429.quota.retryAfter, future);
        const stateAfter429 = JSON.parse(readFileSync(resolve(sb, 'art/raw/pipeline-state.json'), 'utf8'));
        const plan = buildBatchPlan(CATALOG, prompts, ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
        const nextBlocked = selectNextRound(stateAfter429, plan, { budget: MAX_PER_ROUND, batchOnly: 1 });
        assert.equal(nextBlocked.stopped, true);
        assert.equal(nextBlocked.reason, 'RESOURCE_EXHAUSTED_COOLDOWN');

        // 3. Simulate interrupted checkpoint: bg-ocean stuck in 'generating' with PNG on disk, bg-sky stuck in 'generating' without file
        writeFileSync(resolve(sb, 'art/raw/bg-ocean.png'), 'synthetic-png-bytes');
        stateAfter429.items['bg-ocean'].status = 'generating';
        stateAfter429.items['bg-sky'].status = 'generating';
        const { state: recovered, reconciledFiles } = reconcileState(
            stateAfter429,
            plan,
            resolve(sb, 'art/raw'),
            ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'],
            [],
            '2026-11-26T11:00:00+08:00',
        );
        assert.equal(recovered.items['bg-ocean'].status, 'generated');
        assert.ok(recovered.items['bg-ocean'].sha256);
        assert.equal(reconciledFiles.includes('bg-ocean'), true);
        assert.equal(recovered.items['bg-sky'].status, 'pending');
        assert.equal(recovered.items['bg-sky'].failureKind, 'interrupted_before_write');

        // 4. Promote candidate twice -> zero duplicate CSV rows and zero duplicate candidates.json entries
        writeFileSync(resolve(sb, 'assets/candidates/bg-ocean.webp'), 'synthetic-webp');
        executeRecord(sb, {
            key: 'bg-ocean',
            status: 'review_pending',
            attempt: 1,
            model: 'gemini-3.1-flash-image',
            notes: 'run 1',
            promoteCandidate: true,
        }, '2026-11-26T12:00:00+08:00');
        executeRecord(sb, {
            key: 'bg-ocean',
            status: 'review_pending',
            attempt: 1,
            model: 'gemini-3.1-flash-image',
            notes: 'run 2 idempotent',
            promoteCandidate: true,
        }, '2026-11-26T12:01:00+08:00');

        const candDoc = JSON.parse(readFileSync(resolve(sb, 'art/candidates.json'), 'utf8'));
        assert.equal(candDoc.candidates.filter((c) => c.key === 'bg-ocean').length, 1);
        const csvLines = readFileSync(resolve(sb, 'art/raw/generation-log.csv'), 'utf8').trim().split(/\r?\n/);
        assert.equal(csvLines.filter((l) => l.startsWith('bg-ocean,backdrop,')).length, 1);

        // 5. Attempting to write status=approved or overwrite approved asset or escape workspace is refused
        assert.throws(() => executeRecord(sb, { key: 'bg-sky', status: 'approved' }), /approved/);
        assert.throws(() => executeRecord(sb, { key: 'land-01_adult', status: 'pending' }), /approved\.json/);
        assert.throws(() => executeRecord(sb, { key: '../evil', status: 'pending' }), /不合法/);
        assert.throws(() => executeRecord(sb, { key: 'bg-sky', status: 'pending', qcJsonPath: '../../../outside.json' }), /超出允許工作目錄/);

        // 6. Lock prevents concurrent execution and releases cleanly
        const lockPath = resolve(sb, 'art/raw/pipeline.lock');
        acquireLock(lockPath);
        assert.throws(() => acquireLock(lockPath), /排他鎖使用中/);
        releaseLock(lockPath);

        // 7. art/approved.json and src/data/art-manifest.js remain byte-identical
        assert.equal(readFileSync(resolve(sb, 'art/approved.json'), 'utf8'), approvedBefore);
        assert.equal(readFileSync(resolve(sb, 'src/data/art-manifest.js'), 'utf8'), manifestBefore);
    } finally {
        rmSync(sb, { recursive: true, force: true });
    }
});

test('upsertGenerationLogCsv preserves existing rows and sanitizes local user paths', () => {
    const work = resolve(ROOT, 'art/raw', `_csv-${process.pid}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    try {
        const p = resolve(work, 'generation-log.csv');
        upsertGenerationLogCsv(p, {
            id: 'land-01', stage: 'adult', file: 'art/raw/land-01_adult.png',
            model: 'm1', generatedAt: '2026-11-25T18:00:00+08:00', attempts: 1, csvStatus: 'ok', notes: 'keep me',
        });
        upsertGenerationLogCsv(p, {
            id: 'bg-land', stage: 'backdrop', file: 'art/raw/bg-land.png',
            model: 'm1', generatedAt: '2026-11-26T10:00:00+08:00', attempts: 1, csvStatus: 'needs_review', notes: 'err C:\\Users\\alice\\tmp.jpg',
        });
        upsertGenerationLogCsv(p, {
            id: 'bg-land', stage: 'backdrop', file: 'art/raw/bg-land.png',
            model: 'm1', generatedAt: '2026-11-26T10:05:00+08:00', attempts: 2, csvStatus: 'ok', notes: 'ok',
        });
        const content = readFileSync(p, 'utf8');
        const lines = content.trim().split(/\r?\n/);
        assert.equal(lines.length, 3); // header + land-01 + bg-land (no duplicate)
        assert.doesNotMatch(content, /C:\\Users\\alice/);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});

test('recordOutcome blocks direct promotion to approved and checkDiffWhitelist enforces strict boundaries', () => {
    const plan = buildBatchPlan(CATALOG, prompts, ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    const { state } = reconcileState({}, plan, resolve(ROOT, 'art/raw-nonexistent'), ['land-01_adult', 'ocean-07_adult', 'tech-10_adult'], []);
    assert.throws(() => recordOutcome(state, 'bg-land', { status: 'approved' }), /approved/);

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
