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

## BUG-011 — the dying page kept a working-looking sign-in button during sign-out (found on Firefox/WebKit CI)
- **DETECT**: CI `e2e-compat` (Firefox and WebKit), `e2e/auth › A offline queue…`. Clicking the sign-in button right after "登出" ran on the page that was about to be replaced, and the click was lost ("execution context was destroyed"). Chromium reloads fast enough to hide this.
- **ROOT_CAUSE**: `lock()` showed the locked login screen in place but left the previous page's GIS button in it until the reload finished. A teacher who clicked quickly would see their click ignored.
- **FIX**: `lock()` empties the button container before reloading and shows "正在登出…". The only usable button is the fresh page's.
- **PROVE**: the same E2E, which waits for the button, now always gets the fresh page's button. Re-run on Firefox and WebKit in CI (see VERIFICATION).

## TEST-GAP-001 — no test proved the Sheets token is revoked on sign-out (found by mutation testing, v6.1)
- **DETECT**: mutant M7 (`SYNC.stop()` made a no-op, so sync is not stopped and the token is not revoked) survived every E2E. The page reload hid the missing revocation.
- **FIX (tests)**: the fake GIS now calls Google's revoke endpoint over the network, as the real library does (token in the POST body). `wireFakeGoogle()` records the calls. `e2e/auth › no credential ever lands…` asserts that signing out revokes exactly the Sheets access token.
- **PROVE**: M7 re-run → KILLED.
- **Remaining survivor**: M6 removes only the `stopped` flag. It survives because `stop()` also nulls the engine and token, so the flag is a redundant second guard. It is recorded rather than tested.

## BUG-012 — account menu said "N 筆尚未同步到雲端…下次會繼續同步" for an account with no spreadsheet (real-Google acceptance, 2026-11-25)
- **DETECT**: real Chrome, first sign-in of a new account: the menu said 2 records were waiting for the cloud, although no spreadsheet was set (they were the Settings and SyncMeta rows).
- **ROOT_CAUSE**: `pendingCount()` counted unsynced rows even when sync was never configured.
- **FIX**: `pendingCount()` returns `null` without a spreadsheet; the menu says "尚未設定雲端同步：資料只存在這台電腦", and the wipe confirmation warns accordingly.
- **PROVE**: `e2e/auth › account isolation…` asserts `#acct-local-only` and no `#acct-pending` (fails on the old code: the element does not exist).

## BUG-013 — Google's "已封鎖存取權 / 403 access_denied" page reached the app only as "授權視窗已關閉"
- **DETECT**: real Chrome: Sheets authorization for an account that is not an OAuth *test user*. Google shows its own error page in the popup; GIS reports only `popup_closed`.
- **ROOT_CAUSE**: the app cannot see Google's error page; the old message gave no hint.
- **FIX**: `POPUP_CLOSED_TEXT` explains the access_denied / test-user case; setup doc troubleshooting row added. (The Cloud setting itself was fixed by the user.)
- **PROVE**: unit `BUG-013: … popup_closed → message explains it`.

## BUG-014 — "Sheets API not enabled" was reported as "沒有這份試算表的存取權限"
- **DETECT**: real Chrome: "＋ 建立新的試算表" failed. Captured response: `403 PERMISSION_DENIED`, reason `SERVICE_DISABLED` ("Google Sheets API has not been used in project … or it is disabled").
- **ROOT_CAUSE**: `classifyHttp()` mapped every non-rate 403 to `permission`.
- **FIX**: 403 with `SERVICE_DISABLED` / `has not been used in project` / `accessNotConfigured` → kind `config` with the exact fix (enable the API). Real permission 403 and rate 403 unchanged.
- **PROVE**: unit `BUG-014: …` with the real response shape (project number replaced). After the user enabled the API the same click created the sheet.

## BUG-015 — FedCM button mode signed in again without any account chooser after sign-out; "切換帳號" could not switch
- **DETECT**: real Chrome 158: after "登出", pressing the button signed straight back into the same account (user saw no window). `button_auto_select` was never enabled.
- **ROOT_CAUSE**: Chrome's FedCM button flow behaviour for a returning account (Google/Chrome side; not documented for this case). The app had opted into it with `use_fedcm_for_button: true`.
- **FIX**: `use_fedcm_for_button: false`, `button_auto_select: false` → Google's popup with its account chooser (ADR-014).
- **ADDENDUM (second-account test)**: Chrome also holds an empty third account area (`fhes-acct-88e93b…`) that belongs to neither test account and predates account B. Most likely the 11:07 FedCM auto sign-in used another Google account in that browser without any chooser, which is worse than "cannot switch". Not proven; it supports the popup decision.
- **PROVE**: real Chrome: popup mode showed the chooser; closing it kept the app locked; "切換帳號" showed the chooser. No automated test can reproduce Chrome's FedCM UI (fake GIS) → recorded as manual evidence in `docs/REAL-GOOGLE-ACCEPTANCE.md`.

## BUG-016 — Firefox: "InvalidStateError: Navigated away from page" (the OPEN Firefox CI failure)
- **DETECT**: CI `e2e-compat (firefox)`, `e2e/auth › A offline queue…`, every run.
- **INVESTIGATION**: E2E_DIAG timeline: the error is logged 3 ms before the reload navigation, with no `error`/`unhandledrejection` seen by the page. Experiment: waiting for the app's own reload instead of the test dispatching `online` → still failed (so not the harness). Searchfox: the string exists only in `dom/media/webaudio/AudioContext.cpp` (`OnWindowDestroy` rejects pending AudioContext promises).
- **ROOT_CAUSE**: the sound module called `this.ctx.resume()` without handling its promise. In headless Firefox the resume stays pending (no audio output / autoplay policy) and is rejected when the page unloads; Firefox logs it as an error.
- **FIX**: `resume().catch(() => {})` (sound is optional).
- **PROVE**: unit `BUG-016: every AudioContext resume() promise is handled` (static scan of index.html + src). CI Firefox re-run: see VERIFICATION.

## BUG-017 — popup sign-in: account chosen in Google's popup, app stayed on the login screen (2 of 4 attempts)
- **DETECT**: real Chrome, popup mode, both times the first sign-in on a freshly reloaded page (after sign-out, after switch). Confirmed by reading the page state, not only the user's impression.
- **SUSPECTED ROOT CAUSE (not proven)**: the callback silently returned when the response belonged to any nonce other than the latest one (`if (myNonce !== nonce) return;`).
- **FIX**: keep up to 5 issued, unused nonces; verify against each (each usable once, deleted on success); if none matches, show "登入憑證無效" instead of dropping it silently. Replay protection unchanged (E2E `nonce` mode still refused).
- **PROVE**: real Chrome after the fix: 1/1 first-attempt sign-in on a reloaded page succeeded. Sample too small → **OPEN (monitoring)**.

## BUG-018 (v6.2) — student initial passwords stayed in the teacher page's DOM after closing the dialog
- **DETECT**: `e2e/student.e2e.mjs` asserted that the one-time initial password is gone after "關閉"; it was still in the hidden dialog (and in the print-only slip block). Pressing Esc (global handler in `index.html`) closed the dialog without running any clean-up at all.
- **ROOT CAUSE**: closing only removed the `visible` class; the slips lived on in `modal.card` and `#student-slips`.
- **FIX**: a `MutationObserver` on the dialog's class wipes the slips from memory and the DOM whenever the dialog stops being visible, whichever way it was closed (button, backdrop, Esc).
- **PROVE**: the E2E assertion failed before the fix and passes after it.

## BUG-019 (v6.2) — student zoo scene was `role="img"` while containing focusable animals
- **DETECT**: axe `nested-interactive` (serious) on the student zoo in `e2e/student.e2e.mjs`.
- **ROOT CAUSE**: `sceneSVG()` labels the scene as an image; assistive technology hides an image's children, so the animal buttons were unreachable for screen readers.
- **FIX**: the student zoo sets the scene's role to `group`. Animals are also selectable with Enter/Space (the E2E selects one by keyboard).
- **PROVE**: axe clean on login, growth and zoo screens.

## BUG-020…025 (v6.2) — found by the independent security review (subagent, 2026-11-25), all fixed with regression tests
| ID | Defect (reproduced by the reviewer) | Root cause | Fix | Proof |
|---|---|---|---|---|
| BUG-020 | Overlapping publishes (v10 and v5 at the same time) both returned 200; the class ended on v5 | version check used the class row read **before** `await projectionHash()`, outside the transaction | re-read the class and check versions inside one `IMMEDIATE` transaction | `BUG-020` test (green after the fix; the failing run was the reviewer's script) |
| BUG-021 | 60 parallel wrong logins: all evaluated, no 429 → lockout and IP limit bypassed | counters were incremented after the async Argon2 verify | count the attempt synchronously before verifying; reset on success | `BUG-021` test; reverting the fix → red |
| BUG-022 | Any Google account became a teacher; created 240 accounts in 4.5 s | no teacher allow-list or quotas | `FHES_TEACHER_ALLOW` (verified email or @domain), 30 classes/teacher, 80 accounts/class; start-up refuses without the list | `BUG-022` test; reverting → red |
| BUG-023 | An ID token with the last base64 character re-encoded was accepted again | replay key was the raw string; unused base64 bits decode identically | replay key = SHA-256 of `header.payload` | `BUG-023` test; reverting → red |
| BUG-024 | Non-ASCII CSRF header → 500 | `timingSafeEqual` on buffers of different byte length | compare byte lengths | `BUG-024` test; reverting → red |
| BUG-025 | 50 care posts stored 50 rows (47 uncounted) | uncounted actions were always stored | store at most 30 uncounted rows per student per day | `BUG-025` test; reverting → red |
| (low) | `nameMode: 'seat'` was not enforced by the server | validation did not check names | names must be `N號` in seat mode | test "seat-only mode is enforced" |
| (low) | the used ID token stayed referenced in `index.html`'s boot scope | destructured into a long-lived `const` | pass it once, then `delete` the reference | code review |

Inaccurate documentation the review found (server-side nonce, "only once", 30/IP, T12 under concurrency, an Argon2 concurrency limit that did not exist, bearer "ends on reload") was corrected in the threat model, `STUDENT-SYSTEM.md` and ADR-017/018.

## v6.2 test-writing mistakes caught by the suite (not product bugs)
- Test helper's default new password contained the username → the server correctly refused it as weak.
- Idempotency keys shorter than 8 characters in a test → the server correctly answered 400.
- A test advanced the clock 14 h and then reused the teacher's 8-hour token → the server correctly answered 401; the test now opens a fresh teacher session.
- Animals bob continuously, so Playwright's "stable" check never passes for a mouse click; the E2E selects them by keyboard instead (no `force`).

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
- (v6.1) Firefox reports the deliberately blocked Google Fonts request as "Cross-Origin Request Blocked … fonts.googleapis.com", not Chromium's "net::ERR_FAILED". The console filter now accepts both, and console errors include their source location.
- (v6.1) Firefox axe measured `color-contrast` on collection cards during the screen fade-in (12 nodes). Like the overflow test, the axe test now waits 650 ms for the fade to finish; the real colours are about 9:1.
- (v6.1) The first WebKit CI run had 3 tests whose page closed mid-test ("Target page … has been closed"). It did not recur on the next run, so it is recorded as an unexplained WebKit-on-Linux instability. Pages now record `crash` events to catch it if it returns.
- (v6.1) `ubuntu-latest` became Ubuntu 26.04, which playwright 1.56 has no Firefox/WebKit builds for. The compat job is pinned to `ubuntu-24.04`.
- (v6.1, RESOLVED as BUG-016) Firefox CI `InvalidStateError: Navigated away from page`: it was an app bug (unhandled `AudioContext.resume()` promise), not the harness.
- (v6.1) WebKit CI: `assertLocked()` once ran its `evaluate` exactly while sign-out/switch reloaded the page ("Execution context was destroyed"). Both states are locked by design, so the helper now waits for the new page and re-reads; the assertion is unchanged.
- (v6.1) `E2E_DIAG=1` (CI compat jobs): per-context trace, console/navigation/crash timeline and an in-page `error`/`unhandledrejection` probe; `DEBUG=pw:browser` prints browser stderr. Evidence only, no assertion changes.
- (v6.1) Running two Edge E2E suites at the same time (and an extra Edge window with a debugging port) closed the headless Edge mid-run: 8 tests failed with "browser has been closed". Not a product failure; never run suites in parallel.
- (v6.1, OPEN) WebKit CI: renderer crashes in 0–2 random tests per run ("Page crashed" / "Target crashed"), different tests each time (two-device sync, shared-computer wipe, rollback export, group XP, laptop overflow); 1 of 6 runs fully green. E2E_DIAG timeline: no console error or page error precedes the crash; in the two-device test both pages were idle ~40 s before it. Browser stderr was not captured yet (playwright `logger` produced nothing) → `DEBUG=pw:browser` added. Root cause unknown; still FAIL.
- Never edit source files while a background E2E run is in progress; a mid-edit syntax error made one Chrome run report a false failure (recorded in VERIFICATION, re-run afterwards).

## Design issue found while writing the rollback guide — no v5.1-readable export
- **DETECT**: drafting `docs/DEPLOY-CHECKLIST.md`: after upgrading, IndexedDB is at version 2 (v5.1 cannot open it) and v6 backups are version 6 (v5.1 refuses them), so rolling back would lose everything recorded after the upgrade.
- **FIX**: 「⬇ v5.1 相容備份」 exports classes/students/events/dailySnapshots as version 5.1 (homework/XP/collection are listed as excluded).
- **PROVE**: unit test (`rollback: v5.1-compatible export is accepted by a v5.1 parser…`, also asserts a normal v6 file is refused) and E2E download check.

- `node --test tests/` treats the directory as a file on Node 22 → use plain `node --test` (auto-discovery) or a quoted glob.
