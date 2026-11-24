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

## BUG-008 — signing out while offline left the teacher on the browser's "no internet" page (v6.1 sign-in work)
- **DETECT**: `e2e/auth.e2e.mjs › A offline queue…`. After "登出" with the network off, the next step timed out waiting for the login screen.
- **ROOT_CAUSE**: sign-out cleared state only by reloading the page (`location.replace`). Offline, the reload fails, so the browser shows its own error page instead of the login screen. Clearing memory depended entirely on that reload succeeding.
- **FIX**: `lock()` in `src/ui/auth-ui.js` first clears in place:
  - stops sync and revokes the token
  - clears in-memory class data (`wipeMemory`) and closes the database
  - removes every `.app-screen`, `.modal` and record overlay from the DOM, then sets `locked`.
  It then reloads only when online. Offline, it shows "目前離線，恢復網路後即可重新登入" and reloads on the `online` event.
- **PROVE**: the same E2E now asserts, while offline:
  - the page is locked
  - the class name is gone from the page
  - the notice is shown
  After reconnecting, B signs in cleanly.

## BUG-009 — data belonging to no account would be given to the first account that signs in (design issue, v6.1)
- **DETECT**: code reading before adding sign-in. `migrateFromV4IfNeeded()` ran whenever a database had no `dataVersion`. With per-account databases, every new account's database is empty, so the v4 localStorage cache would have been copied into whichever teacher signed in first. The old `classroomPowerhouseV5` database would likewise have been opened and upgraded under the new code path.
- **FIX**: automatic migration removed. Legacy data (the old database or the v4 cache) is only read, without being created or upgraded, by `src/ui/legacy-ui.js`, and offered through preview → choose → backup → copy → undo (ADR-012).
- **PROVE**:
  - E2E `legacy v5.1 IndexedDB (no account) is never auto-assigned…`: asserts the class is absent after sign-in, and that the legacy database is still at version 1 after import.
  - E2E `legacy v4 localStorage cache is no longer auto-migrated…`.
  - Unit tests for `planLegacyImport` / `planUndoImport`.

## BUG-010 — "使用這份" saved a spreadsheet ID before checking the account could open it (pre-existing since P5)
- **DETECT**: writing the account-binding tests. Pasting another teacher's sheet ID saved it immediately, so the badge reported a confusing permission error on every sync, and the wrong sheet ID stayed configured.
- **FIX**: `useSheet()` first calls `adapter.probe()`, a read-only metadata GET. A 403 or 404 refuses the sheet, saves nothing and writes nothing, and no other spreadsheet is substituted.
- **PROVE**: E2E `a spreadsheet the signed-in account cannot access is refused (no fallback to another sheet)`. With the old code, `#sync-sheet-link` would exist and the assertion fails.

## TEST-GAP-001 — no test proved the Sheets token is revoked on sign-out (found by mutation testing, v6.1)
- **DETECT**: mutant M7 (`SYNC.stop()` made a no-op, so sync is not stopped and the token is not revoked) survived every E2E. The page reload hid the missing revocation.
- **FIX (tests)**: the fake GIS now calls Google's revoke endpoint over the network, as the real library does (token in the POST body). `wireFakeGoogle()` records the calls. `e2e/auth › no credential ever lands…` asserts that signing out revokes exactly the Sheets access token.
- **PROVE**: M7 re-run → KILLED.
- **Remaining survivor**: M6 removes only the `stopped` flag. It survives because `stop()` also nulls the engine and token, so the flag is a redundant second guard. It is recorded rather than tested.

## TEST-HARNESS notes (not product bugs, recorded so they are not repeated)
- `page.waitForSelector('#import-modal:not(.visible)')` waits for *visible* by default → use `{ state: 'hidden' }`.
- Reading a card number immediately after a click races the async IndexedDB write → `waitVal()` polls until the expected value or timeout and then lets the assertion show the real value.
- An element with an infinite idle animation is never "stable" for Playwright → `click({ force: true })` for scene actors.
- Async UI actions that re-render (tag delete: two confirms + save + re-render) must be awaited with `waitFor({ state: 'detached' })`, not an immediate `count()` (caught as a 1-in-2 flake; fixed and re-run 3×).
- `openApp()` used to wait for `#class-dashboard.active`, which is present in static HTML, so a broken module script was only noticed 30 s later by an unrelated selector. It now waits for `#add-class-card` (rendered by the script) and fails immediately with the captured page error.
- Re-render races after async saves (homework archive → restore → toggle): wait for the post-render state (`waitFor`) before the next click.
- (v6.1) The login screen is static HTML (`body.locked`), so it is visible before the module script writes the status text. Tests wait for the text (`waitStatus`) instead of reading it as soon as the screen appears.
- (v6.1) `page.clock.fastForward()` sometimes did not advance `Date` at all (3 of 4 isolated runs failed). The test now uses `clock.setSystemTime()` plus `clock.runFor(31 s)`, which was stable in 6 of 6 runs and in the full suites.
- (v6.1) After `context.setOffline(false)` the browser fires its own `online` event, and the app reloads. A test `page.evaluate()` racing that reload must tolerate "execution context destroyed".
- (v6.1) A Python heredoc turned `` in a JavaScript regex into a literal backspace character, so new guardrail rules silently never matched. The negative unit test caught it. The rules are now written with real ``, and the repo was scanned for U+0008.
- Never edit source files while a background E2E run is in progress; a mid-edit syntax error made one Chrome run report a false failure (recorded in VERIFICATION, re-run afterwards).

## Design issue found while writing the rollback guide — no v5.1-readable export
- **DETECT**: drafting `docs/DEPLOY-CHECKLIST.md`: after upgrading, IndexedDB is at version 2 (v5.1 cannot open it) and v6 backups are version 6 (v5.1 refuses them), so rolling back would lose everything recorded after the upgrade.
- **FIX**: 「⬇ v5.1 相容備份」 exports classes/students/events/dailySnapshots as version 5.1 (homework/XP/collection are listed as excluded).
- **PROVE**: unit test (`rollback: v5.1-compatible export is accepted by a v5.1 parser…`, also asserts a normal v6 file is refused) and E2E download check.

- `node --test tests/` treats the directory as a file on Node 22 → use plain `node --test` (auto-discovery) or a quoted glob.
