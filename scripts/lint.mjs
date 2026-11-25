// 執行 ESLint：src/ scripts/ tests/ e2e/，另把 index.html 的內嵌模組抽出來一起檢查
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
const results = await eslint.lintFiles(['src/**/*.js', 'server/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'e2e/**/*.mjs', 'eslint.config.js'].filter(Boolean));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => /type\s*=\s*["']module["']/.test(m[1]));
for (const [i, m] of inline.entries()) {
    // 保留行號：在前面補上 <script> 之前的換行數，讓錯誤行號對得上 index.html
    const before = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    results.push(...await eslint.lintText('\n'.repeat(before) + m[2], { filePath: join(root, `index-${i + 1}.inline.mjs`) }));
}
const formatter = await eslint.loadFormatter('stylish');
const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
const out = await formatter.format(results);
if (out) console.log(out.replaceAll(/index-\d+\.inline\.mjs/g, 'index.html (inline module)'));
if (errorCount) process.exitCode = 1;
else console.log(`PASS: ESLint clean (${results.length} files incl. index.html inline module).`);
