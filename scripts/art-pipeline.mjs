// FHES v6.2 圖鑑美術可中斷／可續跑排程引擎（純 Node ESM，零外部依賴）。
// 規則：
// - 首批固定 24 個素材位置：6 背景板（bg-<world>）＋ 6 世界 catalog 前 3 成年版（round-robin，共 18 位）。
// - 已核准且屬首批的素材（land-01_adult）直接沿用；ocean-07_adult / tech-10_adult 屬風格基準但不計入首批 24 位。
// - 機器 QC 通過只進 art/candidates.json 與 assets/candidates/，絕不自動寫入 art/approved.json 或 src/data/art-manifest.js。
// - 單輪上限 6 張；遇 HTTP 429 / RESOURCE_EXHAUSTED 立刻中止並保存 checkpoint；CLI 嚴格限制於專案工作目錄內。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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
const KEY_RE = /^[a-z0-9-]+(?:_(?:adult|young))?$/;
const CSV_HEADER = 'id,stage,file,model,generated_at,attempts,status,notes';

export const keyOf = (item) => (item.type === 'character' ? `${item.id}_${item.stage}` : item.id);
export const variantOf = (item) => (item.type === 'character' ? item.stage : item.type);

export const sha256File = (absPath) => createHash('sha256').update(readFileSync(absPath)).digest('hex');

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** 確保路徑嚴格位於允許基底目錄內（防止 .. 與符號連結越界） */
export const assertWithinDir = (targetPath, baseDir) => {
    const base = existsSync(baseDir) ? realpathSync(baseDir) : resolve(baseDir);
    const candidate = resolve(base, targetPath);
    const actual = existsSync(candidate) ? realpathSync(candidate) : candidate;
    const rel = relative(base, actual);
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(rel) && !rel.startsWith('/'))) {
        return actual;
    }
    throw new Error(`路徑超出允許工作目錄：${targetPath}`);
};

/** 依 src/data/catalog.js 真實順序與 prompts.json 建立首批 24 位與完整 185 項排程 */
export const buildBatchPlan = (catalog, promptItems, approvedKeys = [], candidateKeys = []) => {
    const approved = new Set(approvedKeys);
    const candidates = new Set(candidateKeys);
    const byKey = new Map(promptItems.map((p) => [keyOf(p), p]));
    const batch1Keys = [];

    for (const w of WORLDS) batch1Keys.push(`bg-${w.id}`);

    const byWorld = new Map(WORLDS.map((w) => [w.id, catalog.filter((c) => c.world === w.id).sort((a, b) => a.no - b.no)]));
    for (let idx = 0; idx < 3; idx++) {
        for (const w of WORLDS) {
            const item = byWorld.get(w.id)?.[idx];
            if (item) batch1Keys.push(`${item.id}_adult`);
        }
    }

    const batch1Set = new Set(batch1Keys);
    const remainingKeys = [];
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

/** 原子寫入文字／JSON（tmp → rename），避免中斷寫壞狀態檔 */
export const writeTextAtomic = (absPath, text) => {
    mkdirSync(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(tmp, text, 'utf8');
        renameSync(tmp, absPath);
    } catch (err) {
        if (existsSync(tmp)) unlinkSync(tmp);
        throw err;
    }
};

export const writeJsonAtomic = (absPath, data) => writeTextAtomic(absPath, JSON.stringify(data, null, 2) + '\n');

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
        const prev = items[slot.key]
            ? { ...items[slot.key] }
            : {
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

/** 記錄單張結果（含 429 立即中止；禁止透過本函式直接寫成 approved） */
export const recordOutcome = (state, key, patch, nowIso = new Date().toISOString()) => {
    const cur = state.items[key];
    if (!cur) throw new Error(`未知項目：${key}`);
    const nextStatus = patch.status || cur.status;
    if (!VALID_STATES.includes(nextStatus)) throw new Error(`無效狀態：${nextStatus}`);
    if (nextStatus === 'approved' && cur.status !== 'approved') {
        throw new Error('禁止透過自動化指令直接標記 approved（須由人工更新 art/approved.json）');
    }
    const isQuota = patch.failureKind === 'RESOURCE_EXHAUSTED' || patch.failureKind === 'HTTP_429';
    return {
        ...state,
        updatedAt: nowIso,
        quota: isQuota
            ? { blocked: true, retryAfter: patch.retryAfter || null, lastError: patch.error || 'HTTP 429 RESOURCE_EXHAUSTED', updatedAt: nowIso }
            : (['generated', 'qc_pass', 'processed', 'review_pending', 'pushed'].includes(nextStatus)
                ? { blocked: false, retryAfter: null, lastError: null, updatedAt: nowIso }
                : state.quota),
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
};

// ---------------------------------------------------------------- CSV 安全讀寫（防重複行）
const parseCsvLine = (line) => {
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else cur += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            cols.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    cols.push(cur);
    return cols;
};

const formatCsvCell = (value) => {
    const s = String(value ?? '').replaceAll(/\r?\n/g, ' ');
    return /[",]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const sanitizeNote = (text) => String(text ?? '')
    .replaceAll(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<local-user>')
    .replaceAll(/\/Users\/[^/\s]+/g, '<local-user>');

/** 原子更新 art/raw/generation-log.csv，依 (id, stage) 原地覆寫避免重複紀錄 */
export const upsertGenerationLogCsv = (csvPath, row) => {
    const lines = existsSync(csvPath)
        ? readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
        : [CSV_HEADER];
    const header = lines[0] === CSV_HEADER ? lines[0] : CSV_HEADER;
    const body = lines.slice(lines[0] === CSV_HEADER ? 1 : 0).map(parseCsvLine);
    const nextCols = [
        row.id,
        row.stage,
        row.file,
        row.model || 'gemini-3.1-flash-image',
        row.generatedAt,
        String(row.attempts ?? 0),
        row.csvStatus,
        sanitizeNote(row.notes || ''),
    ];
    let updated = false;
    const deduped = [];
    const seen = new Set();
    for (const cols of body) {
        const k = `${cols[0]}|${cols[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (cols[0] === row.id && cols[1] === row.stage) {
            deduped.push(nextCols);
            updated = true;
        } else {
            deduped.push(cols);
        }
    }
    if (!updated) deduped.push(nextCols);
    const out = [header, ...deduped.map((cols) => cols.map(formatCsvCell).join(','))].join('\n') + '\n';
    writeTextAtomic(csvPath, out);
    return deduped.length;
};

/** 原子更新 art/candidates.json（去重 upsert；絕不碰 art/approved.json） */
export const upsertCandidateJson = (candidatesPath, entry, nowIso = new Date().toISOString()) => {
    const doc = readJson(candidatesPath, {
        _note: '機器品質檢查（scripts/art-qc.py）通過但等待人工審核的候選素材；禁止自動寫入 art/approved.json 或 src/data/art-manifest.js。',
        updatedAt: nowIso,
        candidates: [],
    });
    const list = [];
    let replaced = false;
    const seen = new Set();
    for (const item of doc.candidates || []) {
        const k = typeof item === 'string' ? item : item.key;
        if (seen.has(k)) continue;
        seen.add(k);
        if (k === entry.key) {
            list.push(entry);
            replaced = true;
        } else {
            list.push(item);
        }
    }
    if (!replaced) list.push(entry);
    const next = { ...doc, updatedAt: nowIso, candidates: list };
    writeJsonAtomic(candidatesPath, next);
    return next;
};

/** 完整安全執行一次 record（供 CLI 與整合測試共用，所有路徑嚴格限定於 rootDir 內） */
export const executeRecord = (rootDir, opts, nowIso = new Date().toISOString()) => {
    const { key, status, attempt, model, failureKind, retryAfter, error, notes, qcJsonPath, promoteCandidate } = opts;
    if (!key || !KEY_RE.test(key)) throw new Error(`不合法的素材 key：${key}`);
    if (!status || !VALID_STATES.includes(status)) throw new Error(`不合法的狀態：${status}`);
    if (status === 'approved') throw new Error('禁止透過 record 指令寫入 approved（僅限人工核准）');
    if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 0 || attempt > 99)) {
        throw new Error(`不合法的 attempt 次數：${attempt}`);
    }
    if (retryAfter && Number.isNaN(Date.parse(retryAfter))) {
        throw new Error(`不合法的 retry-after 時間格式：${retryAfter}`);
    }

    const promptsDoc = readJson(resolve(rootDir, 'art/prompts/prompts.json'), null);
    if (!promptsDoc) throw new Error('找不到 art/prompts/prompts.json');
    const approvedKeys = readJson(resolve(rootDir, 'art/approved.json'), { approved: [] }).approved || [];
    const candidatesPath = resolve(rootDir, 'art/candidates.json');
    const candidateKeys = (readJson(candidatesPath, { candidates: [] }).candidates || []).map((c) => (typeof c === 'string' ? c : c.key));
    const plan = buildBatchPlan(CATALOG, promptsDoc.items, approvedKeys, candidateKeys);
    const slot = plan.all.find((s) => s.key === key);
    if (!slot) throw new Error(`prompts.json 查無素材：${key}`);

    let qcReport = null;
    if (qcJsonPath) {
        const safeQc = assertWithinDir(qcJsonPath, rootDir);
        if (!existsSync(safeQc)) throw new Error(`找不到 QC 報告檔：${qcJsonPath}`);
        qcReport = JSON.parse(readFileSync(safeQc, 'utf8'));
        if (qcReport.key && qcReport.key !== key) throw new Error(`QC 報告 key (${qcReport.key}) 與 --key (${key}) 不符`);
    }

    const rawDir = resolve(rootDir, 'art/raw');
    const lockPath = resolve(rawDir, 'pipeline.lock');
    const statePath = resolve(rawDir, 'pipeline-state.json');
    const csvPath = resolve(rawDir, 'generation-log.csv');

    acquireLock(lockPath);
    try {
        const prevState = readJson(statePath, {});
        const { state } = reconcileState(prevState, plan, rawDir, approvedKeys, candidateKeys, nowIso);
        const cur = state.items[key];
        if (approvedKeys.includes(key)) {
            throw new Error(`素材 ${key} 已在 art/approved.json 人工核准，禁止透過 record 覆寫狀態`);
        }

        const absRaw = assertWithinDir(slot.file, rootDir);
        const rawSha = existsSync(absRaw) ? sha256File(absRaw) : (qcReport?.raw_sha256 || cur.sha256 || null);
        const refHashes = {};
        const refsToHash = slot.variant === 'young' && slot.referenceImage
            ? [slot.referenceImage]
            : STYLE_REFS.map((r) => `art/raw/${r}.png`);
        for (const rRel of refsToHash) {
            const absRef = resolve(rootDir, rRel);
            if (existsSync(absRef)) refHashes[rRel] = sha256File(absRef).slice(0, 16);
        }

        const nextAttempt = attempt !== undefined ? attempt : cur.attempt;
        const patch = {
            status,
            attempt: nextAttempt,
            model: model || cur.model || 'gemini-3.1-flash-image',
            referenceHashes: Object.keys(refHashes).length ? refHashes : cur.referenceHashes,
            sha256: rawSha,
            failureKind: failureKind ?? (['qc_pass', 'processed', 'review_pending', 'pushed'].includes(status) ? null : cur.failureKind),
            retryAfter: retryAfter ?? (failureKind === 'RESOURCE_EXHAUSTED' || failureKind === 'HTTP_429' ? null : cur.retryAfter),
        };
        if (error !== undefined) patch.error = sanitizeNote(error);
        if (qcReport) {
            patch.qcReport = {
                technicalStatus: qcReport.technical_status,
                webpPath: qcReport.webp_path || null,
                webpBytes: qcReport.webp_bytes || 0,
                issues: qcReport.issues || [],
                warnings: qcReport.warnings || [],
            };
        }

        let candidatePromoted = false;
        if (promoteCandidate) {
            if (!['review_pending', 'qc_pass', 'processed', 'pushed'].includes(status)) {
                throw new Error(`狀態 ${status} 不可加入候選清單 art/candidates.json`);
            }
            const relWebp = qcReport?.webp_path || `assets/candidates/${key}.webp`;
            const absWebp = assertWithinDir(relWebp, rootDir);
            if (!relWebp.startsWith('assets/candidates/') || !existsSync(absWebp)) {
                throw new Error(`找不到候選 WebP（${relWebp}），不可登錄候選清單`);
            }
            upsertCandidateJson(candidatesPath, {
                key,
                itemId: slot.itemId,
                variant: slot.variant,
                status: 'review_pending',
                webp: relWebp,
                rawSha256: rawSha,
                webpBytes: statSync(absWebp).size,
                manualReviewRequired: true,
                updatedAt: nowIso,
            }, nowIso);
            candidatePromoted = true;
            if (status === 'qc_pass' || status === 'processed') patch.status = 'review_pending';
        }

        const updatedState = recordOutcome(state, key, patch, nowIso);
        writeJsonAtomic(statePath, updatedState);

        const csvStatus = ['qc_pass', 'processed', 'review_pending', 'pushed'].includes(patch.status) ? 'ok' : 'needs_review';
        const csvRows = upsertGenerationLogCsv(csvPath, {
            id: slot.itemId,
            stage: slot.variant,
            file: slot.file,
            model: patch.model,
            generatedAt: nowIso,
            attempts: nextAttempt,
            csvStatus,
            notes: notes || error || (failureKind ? `failureKind=${failureKind}` : ''),
        });

        return {
            ok: true,
            key,
            status: updatedState.items[key].status,
            attempt: nextAttempt,
            sha256: rawSha,
            candidatePromoted,
            quota: updatedState.quota,
            csvRows,
        };
    } finally {
        releaseLock(lockPath);
    }
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

const runCheckDiff = (rootDir) => {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: rootDir, encoding: 'utf8' });
    const files = out
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'))
        .map((f) => (f.includes(' -> ') ? f.split(' -> ').pop() : f));
    const texts = {};
    for (const f of files) {
        const abs = resolve(rootDir, f);
        if (existsSync(abs) && /\.(?:json|md|mjs|js|py|csv|txt)$/i.test(f)) {
            texts[f] = readFileSync(abs, 'utf8');
        }
    }
    const res = checkDiffWhitelist(files, texts);
    console.log(JSON.stringify({ ...res, checkedFiles: files }, null, 2));
    if (!res.ok) process.exitCode = 1;
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
        quota: state.quota,
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
            items: nextRound.selected.map((s) => ({
                key: s.key,
                name: s.name,
                world: s.world,
                type: s.type,
                variant: s.variant,
                file: s.file,
                background: s.background,
                priorFailureKind: state.items[s.key]?.failureKind || null,
            })),
        },
        batch1Slots: plan.batch1.map((s) => ({ key: s.key, name: s.name, world: s.world, type: s.type, status: s.slotStatus })),
    }, null, 2));
};

const getFlag = (args, name) => {
    const idx = args.indexOf(name);
    if (idx < 0) return undefined;
    if (idx + 1 >= args.length) throw new Error(`缺少參數值：${name}`);
    return args[idx + 1];
};

const main = () => {
    const cmd = process.argv[2] || 'dry-run';
    const args = process.argv.slice(3);
    if (cmd === 'dry-run') {
        runDryRun(ROOT);
        return;
    }
    if (cmd === 'check-diff') {
        runCheckDiff(ROOT);
        return;
    }
    if (cmd === 'unlock') {
        releaseLock(resolve(ROOT, 'art/raw/pipeline.lock'));
        console.log('Lock released.');
        return;
    }
    if (cmd === 'next') {
        const budgetRaw = getFlag(args, '--budget');
        const budget = budgetRaw !== undefined ? Number(budgetRaw) : MAX_PER_ROUND;
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
    if (cmd === 'record') {
        const attemptStr = getFlag(args, '--attempt');
        const result = executeRecord(ROOT, {
            key: getFlag(args, '--key'),
            status: getFlag(args, '--status'),
            attempt: attemptStr !== undefined ? Number(attemptStr) : undefined,
            model: getFlag(args, '--model'),
            failureKind: getFlag(args, '--failure-kind'),
            retryAfter: getFlag(args, '--retry-after'),
            error: getFlag(args, '--error'),
            notes: getFlag(args, '--notes'),
            qcJsonPath: getFlag(args, '--qc-json'),
            promoteCandidate: args.includes('--promote-candidate'),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    throw new Error(`不支援的子指令：${cmd}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        main();
    } catch (err) {
        console.error(JSON.stringify({ ok: false, error: err.message }));
        process.exitCode = 1;
    }
}
