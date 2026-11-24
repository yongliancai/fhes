import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, extname } from 'node:path';

export const isFirebaseReference = (text) => /(?:firebase(?:js)?|firestore|gstatic\.com\/firebasejs)/i.test(text);
export const checkAddedFile = (path, text) => {
  const errors = [];
  if (path !== 'index.html' && /\.(?:js|mjs|ts|html)$/.test(path) && isFirebaseReference(text)) {
    errors.push('New Firebase dependency outside legacy index.html: ' + path);
  }
  if (/\.(?:js|mjs|ts)$/.test(path) && /(?:AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,})/.test(text)) {
    errors.push('Possible hard-coded credential in ' + path);
  }
  return errors;
};
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (['.git', 'node_modules', 'coverage'].includes(e.name)) return [];
  const full = resolve(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});
if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const errs = [];
  for (const p of walk(root)) {
    const rel = relative(root, p).replaceAll('\\', '/');
    if (['.js', '.mjs', '.ts', '.html'].includes(extname(p)) && !['scripts/guardrails.mjs', 'tests/guardrails.test.mjs'].includes(rel)) {
      // Exempt only this checker and its deliberate violation fixtures, never application modules.
      // The existing Firebase integration is grandfathered in index.html until the separately approved cloud migration.
      errs.push(...checkAddedFile(rel, readFileSync(p, 'utf8')));
    }
  }
  if (errs.length) { errs.forEach(e => console.error('FAIL: ' + e)); process.exitCode = 1; }
  else console.log('PASS: no additional Firebase SDK dependencies or known credential signatures in new JavaScript files.');
}
