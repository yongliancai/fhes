// FHES v6.2 圖鑑美術可中斷／可續跑排程引擎（純 Node ESM，零外部依賴）。
// 規則：
// - 首批固定 24 個素材位置：6 背景板（bg-<world>）＋ 6 世界 catalog 前 3 成年版（round-robin，共 18 位）。
// - 已核准且屬首批的素材（land-01_adult）直接沿用；ocean-07_adult / tech-10_adult 屬風格基準但不計入首批 24 位。
// - 機器 QC 通過只進 art/candidates.json 與 assets/candidates/，絕不自動寫入 art/approved.json 或 src/data/art-manifest.js。
// - 單輪上限 6 張；遇 HTTP 429 / RESOURCE_EXHAUSTED 立刻中止並保存 checkpoint。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATALOG, WORLDS } from '../src/data/catalog.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_PER_ROUND = 6;
export const MAX_ATTEMPTS = 3;
export const STYLE_REFS = Object.freeze(['land-01_adult', 'ocean-07_adult', 'tech-10_adult']);
export const VALID_STATES = Object.freeze([
    'pending', 'generating', 'generated', 'qc_fail', 'qc_pass',
    'processed', 'review_pending', 'approved', 'rejected', 'pushed',
]);

export const keyOf = (item) => (item.type === 'character' ? `${item.id}_${item.stage}` : item.id);
export const variantOf = (item) => (item.type === 'character' ? item.stage : item.type);

export const sha256File = (absPath) => createHash('sha256').update(readFileSync(absPath)).digest('hex');

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** 依 src/data/catalog.js 真實順序與 prompts.json 建立首批 24 位與完整 185 項排程 */
export const buildBatchPlan = (catalog, promptItems, approvedKeys = [], candidateKeys = []) => {
    const approved = new Set(approvedKeys);
    const candidates = new Set(candidateKeys);
    const byKey = new Map(promptItems.map((p) => [keyOf(p), p]));
    const batch1Keys = [];

    // 1. 六大世界背景板（優先）
    for (const w of WORLDS) batch1Keys.push(`bg-${w.id}`);

    // 2. 每世界 catalog 前 3 種物種成年版（round-robin，避免單一世界獨快造成視覺落差）
    const byWorld = new Map(WORLDS.map((w) => [w.id, catalog.filter((c) => c.world === w.id).sort((a, b) => a.no - b.no)]));
    for (let idx = 0; idx < 3; idx++) {
        for (const w of WORLDS) {
            const item = byWorld.get(w.id)?.[idx];
            if (item) batch1Keys.push(`${item.id}_adult`);
        }
    }

    const batch1Set = new Set(batch1Keys);
    const remainingKeys = [];
    // 後續批次：其餘成年版（round-robin 4..12）→ 道具與里程碑 → 幼年版（須等成年版核准）
    for (let idx = 3; idx < 12; idx++) {
        for (const w of WORLDS) {
            const item = byWorld.get(w.id)?.[idx];
            if (item) remainingKeys.push(`${item.id}_adult`);
        }
    }
    for (const p of promptItems) {
        if (p.type === 'prop') remainingKeys.push(keyOf(p));
    }
    for (let idx = 0; idx < 12; idx++) {
        for (const w of WORLDS) {
            const item = byWorld.get(w.id)?.[idx];
            if (item) remainingKeys.push(`${item.id}_young`);
        }
    }

    const toSlot = (k, batch) => {
        const p = byKey.get(k);
        if (!p) throw new Error(`prompts.json 缺少項目：${k}`);
        const slotStatus = approved.has(k) ? 'approved' : candidates.has(k) ? 'review_pending' : 'fallback';
        return {
            key: k,
            promptId: k,
            itemId: p.id,
            name: p.name || p.id,
            world: p.world,
            type: p.type,
            variant: variantOf(p),
            batch,
            file: p.file,
            background: p.background,
            referenceImage: p.referenceImage,
            slotStatus,
        };
    };

    const batch1 = batch1Keys.map((k) => toSlot(k, 1));
    const rest = remainingKeys.filter((k) => !batch1Set.has(k)).map((k) => toSlot(k, 2));
    const approvedOutsideBatch1 = [...approved].filter((k) => !batch1Set.has(k));

    return {
        batch1,
        rest,
        all: [...batch1, ...rest],
        approvedOutsideBatch1,
        summary: {
            totalPrompts: promptItems.length,
            batch1Slots: batch1.length,
            batch1Approved: batch1.filter((s) => s.slotStatus === 'approved').length,
            batch1ReviewPending: batch1.filter((s) => s.slotStatus === 'review_pending').length,
            batch1Fallback: batch1.filter((s) => s.slotStatus === 'fallback').length,
            totalApproved: approved.size,
            approvedOutsideBatch1: approvedOutsideBatch1.length,
        },
    };
};

/** 原子寫入 checkpoint（tmp → rename），避免中斷寫壞狀態檔 */
export const writeJsonAtomic = (absPath, data) => {
    mkdirSync(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, absPath);
};

/** 排他鎖：避免併發排程同時消耗同一配額；逾 90 分鐘視為過期鎖 */
export const acquireLock = (lockPath, ttlMs = 90 * 60 * 1000) => {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (existsSync(lockPath)) {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age < ttlMs) {
            const info = readJson(lockPath, {});
            throw new Error(`排他鎖使用中（pid=${info.pid ?? 'unknown'}, startedAt=${info.startedAt ?? 'unknown'}），中止本輪以避免併發消耗配額。`);
        }
        unlinkSync(lockPath);
    }
    const fd = openSync(lockPath, 'wx');
    try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n');
    } finally {
        closeSync(fd);
    }
};

export const releaseLock = (lockPath) => {
    if (existsSync(lockPath)) unlinkSync(lockPath);
};

/** 啟動對帳：把 art/raw/ 裡「有檔但未記錄」的 PNG 補進 state 並算 sha256，防止重複生圖 */
export const reconcileState = (state, plan, rawDir, approvedKeys = [], candidateKeys = [], nowIso = new Date().toISOString()) => {
    const approved = new Set(approvedKeys);
    const candidates = new Set(candidateKeys);
    const items = { ...(state.items || {}) };
    const reconciledFiles = [];

    for (const slot of plan.all) {
        const prev = items[slot.key] || {
            promptId: slot.promptId,
            itemId: slot.itemId,
            variant: slot.variant,
            batch: slot.batch,
            attempt: 0,
            model: null,
            referenceHashes: {},
            sha256: null,
            filePath: slot.file,
            startedAt: null,
            updatedAt: nowIso,
            failureKind: null,
            retryAfter: null,
            status: 'pending',
        };
        if (approved.has(slot.key)) {
            prev.status = 'approved';
            prev.failureKind = null;
        } else if (candidates.has(slot.key) && prev.status !== 'pushed') {
            prev.status = 'review_pending';
        }
        // 中斷恢復：前一次卡在 generating 時降回 pending 並檢查是否已落檔
        const absRaw = resolve(rawDir, `${slot.key}.png`);
        if (existsSync(absRaw)) {
            const digest = sha256File(absRaw);
            if (!prev.sha256 || prev.status === 'pending' || prev.status === 'generating') {
                prev.sha256 = digest;
                if (!approved.has(slot.key) && !candidates.has(slot.key)) {
                    prev.status = 'generated';
                    reconciledFiles.push(slot.key);
                }
                prev.updatedAt = nowIso;
            }
        } else if (prev.status === 'generating') {
            prev.status = 'pending';
            prev.failureKind = 'interrupted_before_write';
            prev.updatedAt = nowIso;
        }
        items[slot.key] = prev;
    }

    return {
        state: {
            version: 1,
            updatedAt: nowIso,
            quota: state.quota || { blocked: false, retryAfter: null, lastError: null, updatedAt: null },
            items,
        },
        reconciledFiles,
    };
};

/** 計算本輪可生成的候選項目（最多 6 張；遇 429 冷卻立即停止；幼年版需等成年版核准） */
export const selectNextRound = (state, plan, { budget = MAX_PER_ROUND, nowMs = Date.now(), batchOnly = 1 } = {}) => {
    const cap = Math.min(MAX_PER_ROUND, Math.max(1, Number(budget) || MAX_PER_ROUND));
    if (state.quota?.blocked && state.quota.retryAfter) {
        const until = Date.parse(state.quota.retryAfter);
        if (!Number.isNaN(until) && nowMs < until) {
            return {
                stopped: true,
                reason: 'RESOURCE_EXHAUSTED_COOLDOWN',
                retryAfter: state.quota.retryAfter,
                selected: [],
            };
        }
    }

    const selected = [];
    for (const slot of plan.all) {
        if (batchOnly && slot.batch > batchOnly) continue;
        const entry = state.items[slot.key];
        if (!entry) continue;
        if (['approved', 'review_pending', 'pushed', 'processed', 'qc_pass', 'generated', 'rejected'].includes(entry.status)) continue;
        if (entry.attempt >= MAX_ATTEMPTS) continue;
        if (slot.variant === 'young') {
            const adultEntry = state.items[`${slot.itemId}_adult`];
            if (!adultEntry || adultEntry.status !== 'approved') continue;
        }
        selected.push(slot);
        if (selected.length >= cap) break;
    }

    return { stopped: false, reason: selected.length ? 'ready' : 'nothing_pending', retryAfter: null, selected };
};

/** 記錄單張結果（含 429 立即中止） */
export const recordOutcome = (state, key, patch, nowIso = new Date().toISOString()) => {
    const cur = state.items[key];
    if (!cur) throw new Error(`未知項目：${key}`);
    const nextStatus = patch.status || cur.status;
    if (!VALID_STATES.includes(nextStatus)) throw new Error(`無效狀態：${nextStatus}`);
    const isQuota = patch.failureKind === 'RESOURCE_EXHAUSTED' || patch.failureKind === 'HTTP_429';
    const next = {
        ...state,
        updatedAt: nowIso,
        quota: isQuota
            ? { blocked: true, retryAfter: patch.retryAfter || null, lastError: patch.error || 'HTTP 429 RESOURCE_EXHAUSTED', updatedAt: nowIso }
            : (nextStatus === 'generated' || nextStatus === 'qc_pass' ? { blocked: false, retryAfter: null, lastError: null, updatedAt: nowIso } : state.quota),
        items: {
            ...state.items,
            [key]: {
                ...cur,
                ...patch,
                status: nextStatus,
                updatedAt: nowIso,
            },
        },
    };
    return next;
};

const ALLOWED_DIFF_EXACT = new Set([
    'art/candidates.json',
    'docs/ART-QA-REPORT.md',
    'docs/V6.2-ART-AUTOMATION.md',
    'scripts/art-pipeline.mjs',
    'scripts/art-qc.py',
    'tests/art-pipeline.test.mjs',
]);
const ALLOWED_DIFF_PREFIXES = ['assets/candidates/'];
const FORBIDDEN_DIFF_EXACT = new Set([
    'art/approved.json',
    'src/data/art-manifest.js',
    'index.html',
    '_zoo-preview.html',
]);
const SECRET_OR_LOCAL_PATH = /AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|GOCSPX-[0-9A-Za-z_-]{20,}|\bya29\.[0-9A-Za-z_-]{20,}|-----BEGIN (?:RSA )?PRIVATE KEY-----|[A-Za-z]:\\Users\\[^\\\s]+|\/Users\/[^/\s]+/;

/** 檢查自動提交前的 Git diff 白名單與秘密／本機路徑外洩 */
export const checkDiffWhitelist = (changedFiles, textByFile = {}) => {
    const errors = [];
    for (const raw of changedFiles) {
        const f = raw.replaceAll('\\', '/');
        if (FORBIDDEN_DIFF_EXACT.has(f) || f.startsWith('art/raw/') || f.startsWith('assets/creatures/') || f.startsWith('src/')) {
            errors.push(`禁止自動推送受保護檔案：${f}`);
            continue;
        }
        const ok = ALLOWED_DIFF_EXACT.has(f) || ALLOWED_DIFF_PREFIXES.some((pre) => f.startsWith(pre));
        if (!ok) {
            errors.push(`不在自動推送白名單內：${f}`);
            continue;
        }
        const content = textByFile[f];
        if (typeof content === 'string' && SECRET_OR_LOCAL_PATH.test(content)) {
            errors.push(`偵測到疑似憑證或敏感本機路徑：${f}`);
        }
    }
    return { ok: errors.length === 0, errors };
};

const runDryRun = (rootDir) => {
    const promptsDoc = readJson(resolve(rootDir, 'art/prompts/prompts.json'), null);
    if (!promptsDoc) throw new Error('找不到 art/prompts/prompts.json');
    const approvedDoc = readJson(resolve(rootDir, 'art/approved.json'), { approved: [] });
    const candidatesDoc = readJson(resolve(rootDir, 'art/candidates.json'), { candidates: [] });
    const approvedKeys = approvedDoc.approved || [];
    const candidateKeys = (candidatesDoc.candidates || []).map((c) => (typeof c === 'string' ? c : c.key));
    const plan = buildBatchPlan(CATALOG, promptsDoc.items, approvedKeys, candidateKeys);
    const rawDir = resolve(rootDir, 'art/raw');
    const statePath = resolve(rawDir, 'pipeline-state.json');
    const prevState = readJson(statePath, {});
    const { state, reconciledFiles } = reconcileState(prevState, plan, rawDir, approvedKeys, candidateKeys);
    const nextRound = selectNextRound(state, plan, { budget: MAX_PER_ROUND, batchOnly: 1 });

    const refHashes = {};
    for (const refKey of STYLE_REFS) {
        const p = resolve(rawDir, `${refKey}.png`);
        refHashes[refKey] = existsSync(p) ? sha256File(p).slice(0, 16) : 'MISSING';
    }
    const rawFiles = existsSync(rawDir) ? readdirSync(rawDir).sort() : [];

    console.log(JSON.stringify({
        mode: 'dry-run',
        generatedImages: 0,
        summary: plan.summary,
        approvedKeys,
        approvedOutsideBatch1: plan.approvedOutsideBatch1,
        styleRefHashesPrefix16: refHashes,
        rawFilesCount: rawFiles.length,
        reconciledFiles,
        nextRoundBudgetCap: MAX_PER_ROUND,
        nextRound: {
            stopped: nextRound.stopped,
            reason: nextRound.reason,
            retryAfter: nextRound.retryAfter,
            items: nextRound.selected.map((s) => ({ key: s.key, name: s.name, world: s.world, type: s.type, variant: s.variant, file: s.file, background: s.background })),
        },
        batch1Slots: plan.batch1.map((s) => ({ key: s.key, name: s.name, world: s.world, type: s.type, status: s.slotStatus })),
    }, null, 2));
};

const main = () => {
    const cmd = process.argv[2] || 'dry-run';
    if (cmd === 'dry-run') {
        runDryRun(ROOT);
        return;
    }
    if (cmd === 'unlock') {
        releaseLock(resolve(ROOT, 'art/raw/pipeline.lock'));
        console.log('Lock released.');
        return;
    }
    if (cmd === 'next') {
        const budgetIdx = process.argv.indexOf('--budget');
        const budget = budgetIdx >= 0 ? Number(process.argv[budgetIdx + 1]) : MAX_PER_ROUND;
        const promptsDoc = readJson(resolve(ROOT, 'art/prompts/prompts.json'), null);
        const approvedKeys = readJson(resolve(ROOT, 'art/approved.json'), { approved: [] }).approved || [];
        const candidateKeys = (readJson(resolve(ROOT, 'art/candidates.json'), { candidates: [] }).candidates || []).map((c) => (typeof c === 'string' ? c : c.key));
        const plan = buildBatchPlan(CATALOG, promptsDoc.items, approvedKeys, candidateKeys);
        const rawDir = resolve(ROOT, 'art/raw');
        const statePath = resolve(rawDir, 'pipeline-state.json');
        const { state } = reconcileState(readJson(statePath, {}), plan, rawDir, approvedKeys, candidateKeys);
        const res = selectNextRound(state, plan, { budget, batchOnly: 1 });
        const promptByKey = new Map(promptsDoc.items.map((p) => [keyOf(p), p]));
        console.log(JSON.stringify({
            ...res,
            selected: res.selected.map((s) => ({ ...s, prompt: promptByKey.get(s.key)?.prompt })),
        }, null, 2));
        return;
    }
    throw new Error(`不支援的子指令：${cmd}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
