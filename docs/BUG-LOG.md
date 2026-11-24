# Bug log (DETECT → REPRODUCE → ROOT_CAUSE → FIX → PREVENT → PROVE → RECORD)

Each entry names the regression test that fails on the buggy version and passes on the fix.

## BUG-001 — `npm run verify` crashes on Windows (guardrails)
- **DETECT**: 2026-11-24, first `npm run verify` on the Windows checkout: `ENOENT: scandir 'C:\C:\Users\…\fhes'`. CI (Linux) was green, so the bug was invisible there.
- **REPRODUCE**: `node scripts/guardrails.mjs` on Windows.
- **ROOT_CAUSE**: the project root was computed with `resolve(new URL('..', import.meta.url).pathname)`. On Windows `pathname` is `/C:/…`; `resolve` turns it into `C:\C:\…`.
- **FIX**: `projectRoot()` uses `fileURLToPath` (scripts/guardrails.mjs). The same pattern was avoided in every new script (`serve.mjs`, `lint.mjs`, `check-inline-js.mjs`, e2e helpers).
- **PREVENT/PROVE**: `tests/guardrails.test.mjs › BUG-001 regression` asserts the root contains `index.html`, and on Windows also asserts that the old computation points to a non-existent path (red case). Guardrails now run inside the unit suite as well (`the real repository passes all guardrails`).

## BUG-002 — dead code in index.html (`kindLabel`)
- **DETECT**: first ESLint run over the inline module (`no-unused-vars`).
- **ROOT_CAUSE**: v5.1 replaced `kindLabel` with `actionLabel`; the old helper stayed.
- **FIX**: removed. **PREVENT**: `npm run lint` now lints the extracted inline module on every verify/CI run.

## TEST-HARNESS notes (not product bugs, recorded so they are not repeated)
- `page.waitForSelector('#import-modal:not(.visible)')` waits for *visible* by default → use `{ state: 'hidden' }`.
- Reading a card number immediately after a click races the async IndexedDB write → `waitVal()` polls until the expected value or timeout and then lets the assertion show the real value.
- `node --test tests/` treats the directory as a file on Node 22 → use plain `node --test` (auto-discovery) or a quoted glob.
