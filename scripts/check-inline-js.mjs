import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\bsrc\s*=/.test(m[1]));
if (scripts.length === 0) {
  console.error('FAIL: No inline JavaScript found in index.html');
  process.exitCode = 1;
} else {
  for (const [i, script] of scripts.entries()) {
    try { new vm.Script(script[2], { filename: 'index.html:inline-script-' + (i + 1) }); }
    catch (error) { console.error('FAIL: ' + error.message); process.exitCode = 1; }
  }
  if (!process.exitCode) console.log('PASS: parsed ' + scripts.length + ' inline JavaScript block(s).');
}
