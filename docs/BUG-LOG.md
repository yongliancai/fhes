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

## BUG-003 — homework "undo last batch" disappeared after switching tabs
- **DETECT**: `e2e/homework.e2e.mjs` (first run): after leaving and re-entering the homework tab, `#hw-undo-batch` stayed disabled.
- **ROOT_CAUSE**: the undoable batch was kept only in a UI variable that `reset()` cleared on tab change (and a reload would lose it too).
- **FIX**: `lastUndoableBatch(hwEvents, today)` derives it from stored events (today's latest batch with no `undoOfBatch` compensation).
- **PREVENT/PROVE**: unit test `last undoable batch is derived from stored events (survives reloads), today only, once`; the E2E flow switches tabs and reloads before undoing.

## BUG-004 — sync status invisible inside a class
- **DETECT**: `e2e/sync.e2e.mjs` could not open the sync dialog while in a class: the only status badge lived on the dashboard. A teacher working in class would never see 「需要重新連線」.
- **FIX**: second badge in the class-view header, kept in sync by `setStatus()`. **PROVE**: the E2E opens the dialog from the class view during the token-expiry step.

## BUG-005 — conflict choice lost when a background sync was running
- **DETECT**: E2E conflict step; clicking 「用雲端的」 while a scheduled sync was in flight did nothing (`runSync` returned early).
- **ROOT_CAUSE**: resolutions were only passed as an argument to the run that started.
- **FIX**: resolutions are queued and consumed by the next run; re-queued if that run fails.

## BUG-006 — spurious conflicts on Classes when two devices edit students
- **DETECT**: E2E debug log showed two conflicts (`classes|…`, `students|…`) for a single student rename.
- **ROOT_CAUSE**: `saveClass()` bumps `class.updatedAt` on every roster edit, so both devices changed the class row.
- **FIX**: `autoMergeChoice()` merges versions that differ only in bookkeeping fields (`updatedAt`, `lastSyncAt`) by taking the newer one; any real field difference still becomes a conflict.
- **PROVE**: unit test `BUG-006: versions that differ only in updatedAt merge automatically…` (also asserts a real edit still conflicts); E2E asserts exactly one conflict is shown.

## BUG-007 — the word "null" rendered inside new dialogs
- **DETECT**: E2E debug dump of the sync dialog showed a stray `null` line.
- **ROOT_CAUSE**: `Element.replaceChildren(a, cond ? b : null)` converts `null` into a text node.
- **FIX**: `fill()` in `src/ui/dom.js` filters null/false; all new UI modules use it.
- **PREVENT**: guardrail bans `.replaceChildren(` in `src/ui/` outside `dom.js` (negative + positive test). **PROVE**: `strayNullTexts()` E2E check fails with the bug re-injected (`hw-cell-modal` reported) and passes after the fix.

## TEST-HARNESS notes (not product bugs, recorded so they are not repeated)
- `page.waitForSelector('#import-modal:not(.visible)')` waits for *visible* by default → use `{ state: 'hidden' }`.
- Reading a card number immediately after a click races the async IndexedDB write → `waitVal()` polls until the expected value or timeout and then lets the assertion show the real value.
- An element with an infinite idle animation is never "stable" for Playwright → `click({ force: true })` for scene actors.
- Async UI actions that re-render (tag delete: two confirms + save + re-render) must be awaited with `waitFor({ state: 'detached' })`, not an immediate `count()` (caught as a 1-in-2 flake; fixed and re-run 3×).
- `openApp()` used to wait for `#class-dashboard.active`, which is present in static HTML, so a broken module script was only noticed 30 s later by an unrelated selector. It now waits for `#add-class-card` (rendered by the script) and fails immediately with the captured page error.
- Re-render races after async saves (homework archive → restore → toggle): wait for the post-render state (`waitFor`) before the next click.
- Never edit source files while a background E2E run is in progress; a mid-edit syntax error made one Chrome run report a false failure (recorded in VERIFICATION, re-run afterwards).

## Design issue found while writing the rollback guide — no v5.1-readable export
- **DETECT**: drafting `docs/DEPLOY-CHECKLIST.md`: after upgrading, IndexedDB is at version 2 (v5.1 cannot open it) and v6 backups are version 6 (v5.1 refuses them), so rolling back would lose everything recorded after the upgrade.
- **FIX**: 「⬇ v5.1 相容備份」 exports classes/students/events/dailySnapshots as version 5.1 (homework/XP/collection are listed as excluded).
- **PROVE**: unit test (`rollback: v5.1-compatible export is accepted by a v5.1 parser…`, also asserts a normal v6 file is refused) and E2E download check.

- `node --test tests/` treats the directory as a file on Node 22 → use plain `node --test` (auto-discovery) or a quoted glob.
