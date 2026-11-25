// 檢查 index.html 內嵌的 JavaScript：
//  1. 語法（模組腳本用 node --check 以 ESM 解析；一般腳本用 vm.Script）
//  2. 每個相對 import 的檔案存在，且具名匯入確實有被匯出（避免頁面白屏）
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** 取出所有內嵌 <script>（排除 src=） */
export const extractInlineScripts = (source) => [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]))
    .map((m) => ({ isModule: /type\s*=\s*["']module["']/.test(m[1]), code: m[2] }));

/** 解析 `import { a, b as c } from './x.js'` → [{ from, names }] */
export const parseImports = (code) => [...code.matchAll(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => ({ from: m[2], names: m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) }));

const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1; };
const scripts = extractInlineScripts(html);
if (!scripts.length) fail('No inline JavaScript found in index.html');
const tmp = mkdtempSync(join(tmpdir(), 'fhes-check-'));
try {
    for (const [i, s] of scripts.entries()) {
        if (s.isModule) {
            const file = join(tmp, `inline-${i + 1}.mjs`);
            writeFileSync(file, s.code);
            const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
            if (r.status !== 0) fail(`index.html inline module ${i + 1}: ${r.stderr.trim()}`);
            for (const imp of parseImports(s.code)) {
                if (!imp.from.startsWith('.')) { fail(`index.html imports non-relative module ${imp.from}`); continue; }
                const target = resolve(root, imp.from);
                if (!existsSync(target)) { fail(`index.html imports missing file ${imp.from}`); continue; }
                const mod = await import(pathToFileURL(target).href);
                for (const n of imp.names) if (!(n in mod)) fail(`${imp.from} does not export "${n}" (imported by index.html)`);
            }
        } else {
            try { new vm.Script(s.code, { filename: `index.html:inline-script-${i + 1}` }); } catch (err) { fail(err.message); }
        }
    }
} finally { rmSync(tmp, { recursive: true, force: true }); }
if (!process.exitCode) console.log(`PASS: parsed ${scripts.length} inline script block(s); all relative imports resolve to real exports.`);
