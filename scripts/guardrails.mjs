// 專案守門規則（決定性檢查）。每條規則都有對應的負例/正例測試：tests/guardrails.test.mjs
// 執行：node scripts/guardrails.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 專案根目錄。BUG-001：原本用 URL.pathname，Windows 會變成 C:\C:\…，改用 fileURLToPath */
export const projectRoot = (metaUrl = import.meta.url) => resolve(dirname(fileURLToPath(metaUrl)), '..');

const CODE_EXT = ['.js', '.mjs', '.ts', '.html'];
/** Firebase SDK 載入／初始化的痕跡（一般文字中的「Firebase」字樣不算） */
export const FIREBASE_SDK = /gstatic\.com\/firebasejs|firebase-(?:app|firestore|auth)(?:\.js|-compat)?['"`]|\binitializeApp\s*\(|\bgetFirestore\s*\(|from\s+['"]firebase\//i;
const CREDENTIAL = /AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|GOCSPX-[0-9A-Za-z_-]{20,}|\bya29\.[0-9A-Za-z_-]{20,}|-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const HTML_SINK = /\.(?:innerHTML|outerHTML)\s*=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/;
const BROWSER_GLOBAL = /\b(?:document|window|indexedDB|localStorage|navigator)\s*\./;
/** 登入憑證不可寫入瀏覽器永久儲存空間或印到主控台（ADR-011） */
const TOKEN_PERSIST = /\b(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\([^)]*(?:token|credential|jwt|id_?token|access_?token)/i;
const TOKEN_IDB = /\b(?:put|add|setMeta|dbWrite)\s*\([^)]*\b(?:credential|idToken|id_token|accessToken|access_token)\b/;
const TOKEN_LOG = /\bconsole\s*\.\s*\w+\s*\([^)]*\b(?:credential|idToken|id_token|accessToken|access_token|token)\b/i;
const JWT_DECODE_ONLY = /\batob\s*\([^)]*\.split\(\s*['"]\.['"]\s*\)\s*\[\s*1\s*\]/;
const IMPORT_FROM = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** P5 起：任何出貨程式（index.html、src/）都不可再載入 Firebase SDK；此清單必須維持空白（tests/guardrails.test.mjs 檢查） */
export const LEGACY_FIREBASE_ALLOWED = [];

/**
 * 檢查單一檔案；回傳錯誤訊息陣列。
 * path：相對專案根目錄、以 / 分隔。
 */
export const checkFile = (path, text) => {
    const errors = [];
    const ext = extname(path);
    const isCode = CODE_EXT.includes(ext);
    if (isCode && FIREBASE_SDK.test(text) && !LEGACY_FIREBASE_ALLOWED.includes(path)) {
        errors.push(`Firebase SDK reference is not allowed (${path}). The app syncs through Google Sheets.`);
    }
    if ((isCode || ext === '.json' || ext === '.md' || ext === '.yml') && !path.endsWith('package-lock.json') && CREDENTIAL.test(text)) {
        errors.push(`Possible hard-coded credential or OAuth token in ${path}`);
    }
    if (path.startsWith('src/') && HTML_SINK.test(text)) {
        errors.push(`HTML string sink (innerHTML/outerHTML/insertAdjacentHTML/document.write) in ${path}; build DOM nodes with textContent instead.`);
    }
    if (path.startsWith('src/ui/') && path !== 'src/ui/dom.js' && /\.replaceChildren\(/.test(text)) {
        errors.push(`${path} calls replaceChildren directly; use fill() from dom.js (null children would render as the text "null", BUG-007).`);
    }
    if (path.startsWith('src/core/') || path.startsWith('src/data/')) {
        if (BROWSER_GLOBAL.test(text)) errors.push(`${path} must stay pure (no document/window/indexedDB/localStorage/navigator).`);
        for (const m of text.matchAll(IMPORT_FROM)) {
            if (/\/(?:ui|sync|art)\//.test(m[1]) || /^\.\.\/(?:ui|sync|art)\b/.test(m[1])) errors.push(`${path} imports ${m[1]}: core/data may not depend on ui/sync/art.`);
        }
    }
    const shipped = path.startsWith('src/') || path === 'index.html';
    if (shipped && (TOKEN_PERSIST.test(text) || TOKEN_IDB.test(text))) errors.push(`${path} writes a login/OAuth credential to persistent browser storage; tokens must stay in memory only (ADR-011).`);
    if (shipped && TOKEN_LOG.test(text)) errors.push(`${path} logs something that looks like a credential to the console.`);
    if (shipped && path !== 'src/auth/id-token.js' && JWT_DECODE_ONLY.test(text)) errors.push(`${path} decodes a JWT payload directly; use verifyGoogleIdToken() from src/auth/id-token.js (decoding is not verification).`);
    if (path.startsWith('src/auth/')) {
        for (const m of text.matchAll(IMPORT_FROM)) if (/\/(?:ui|sync)\//.test(m[1]) || /^\.\.\/(?:ui|sync)\b/.test(m[1])) errors.push(`${path} imports ${m[1]}: auth may not depend on ui/sync.`);
    }
    if (path === 'src/auth/id-token.js' && BROWSER_GLOBAL.test(text)) errors.push(`${path} must stay pure (no document/window/indexedDB/localStorage/navigator).`);
    if (path.startsWith('src/sync/')) {
        for (const m of text.matchAll(IMPORT_FROM)) if (/\/ui\//.test(m[1]) || /^\.\.\/ui\b/.test(m[1])) errors.push(`${path} imports ${m[1]}: sync may not depend on ui.`);
    }
    if (/^tests\/fixtures\/.+\.json$/.test(path)) {
        let data = null; try { data = JSON.parse(text); } catch { errors.push(`${path} is not valid JSON`); }
        if (data && data._synthetic !== true) errors.push(`${path} must declare "_synthetic": true (no real student data in fixtures).`);
    }
    return errors;
};

/** 舊名稱相容（P0–P2 測試使用） */
export const checkAddedFile = checkFile;
export const isFirebaseReference = (text) => FIREBASE_SDK.test(text);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'test-results', '.playwright']);
/** 守門程式自己與故意違規的測試樣本不掃描 */
const SELF = new Set(['scripts/guardrails.mjs', 'tests/guardrails.test.mjs']);
export const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const full = resolve(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
});

export const runGuardrails = (root = projectRoot()) => {
    const errs = [];
    let scanned = 0;
    for (const p of walk(root)) {
        const rel = relative(root, p).replaceAll('\\', '/');
        if (SELF.has(rel)) continue;
        if (![...CODE_EXT, '.json', '.md', '.yml'].includes(extname(p))) continue;
        scanned++;
        errs.push(...checkFile(rel, readFileSync(p, 'utf8')));
    }
    return { errs, scanned };
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { errs, scanned } = runGuardrails();
    if (errs.length) { errs.forEach(e => console.error('FAIL: ' + e)); process.exitCode = 1; }
    else console.log(`PASS: guardrails clean across ${scanned} files (no Firebase SDK, credentials, HTML sinks, impure core, or unmarked fixtures).`);
}
