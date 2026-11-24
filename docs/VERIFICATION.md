# Verification

## How to run
Node.js 20+ (CI: 22). Microsoft Edge (Windows) or Google Chrome installed for E2E.
```sh
npm ci
npm run verify      # syntax + import resolution, guardrails, ESLint, unit tests
npm run test:e2e    # real-browser tests; screenshots → test-results/
```
`E2E_CHANNEL=chrome|msedge|chromium` overrides the browser; `E2E_HEADED=1` shows it.

Status words follow the Code Factory guide strictly: **PASS** = actually executed and passed; **FAIL** = executed and failed; **BLOCKED** = cannot run without something only the user can provide; **NOT_CONFIGURED** = no check exists; **NOT_VERIFIED** = not run in this work; **NOT_APPLICABLE** = deliberately out of scope.

## Evidence log
| Date | Phase | Command | Environment | Result |
|---|---|---|---|---|
| 2026-11-24 | baseline | `npm run verify` (branch @ bc37eb9) | Windows 11, Node 22.23.1 | **FAIL** — guardrails `ENOENT C:\C:\…` (BUG-001) |
| 2026-11-24 | P2 | `npm run verify` | Windows 11, Node 22.23.1 | PASS — syntax, guardrails, ESLint, 30/30 unit |
| 2026-11-24 | P2 | `node --test e2e/legacy-v51.e2e.mjs` | Edge (playwright-core 1.56.1) | PASS 7/7 |
| 2026-11-24 | P2 | mutation: `isCounted = () => true` | same | unit 3 FAIL + E2E order-recording FAIL (guards effective); restored → PASS |
| 2026-11-24 | P3 | `npm run verify` / `npm run test:e2e` | Windows 11 / Edge | PASS — 51/51 unit, 10/10 E2E |
| 2026-11-24 | P4 | `npm run verify` / `npm run test:e2e` | Windows 11 / Edge | PASS — 73/73 unit, 13/13 E2E |
| 2026-11-24 | P5 | `npm run verify` / `npm run test:e2e` | Windows 11 / Edge | PASS — 93/93 unit, 15/15 E2E |
| 2026-11-24 | P5 | mutations: no re-check before update / no conflict detection / no protection for hand-deleted rows | Node | each mutant killed (race test; 3 conflict tests; manual-row test); restored → PASS |
| 2026-11-24 | P6 | BUG-007 red/green: `fill()` reverted in the homework cell editor | Edge | E2E FAIL (`hw-cell-modal` stray "null") → restored → PASS |
| 2026-11-24 | P6 | `E2E_CHANNEL=chrome npm run test:e2e` (run during an edit) | Chrome | 20/21 — the one failure was the app failing to start while `index.html` briefly had a syntax error mid-edit; harness now fails fast with the page error (see BUG-LOG harness notes). Re-run below. |
| 2026-11-24 | P6 final | `npm run verify` | Windows 11, Node 22.23.1 | PASS — syntax + imports, guardrails (55 files), ESLint (40 files), 94/94 unit, exit 0 |
| 2026-11-24 | P6 final | `npm run test:e2e` | Edge | PASS 23/23, exit 0 |
| 2026-11-24 | P6 final | `E2E_CHANNEL=chrome npm run test:e2e` | Chrome | PASS 23/23, exit 0 (independent second run, different browser) |
| 2026-11-25 | v6.1 baseline | `npm ci` / `npm run verify` / `npm run test:e2e` (before sign-in work, @ f9693d3) | Windows 11 / Edge | PASS — 94/94 unit, 23/23 E2E |
| 2026-11-25 | v6.1 | first full E2E after adding the login gate | Edge | 37/39 — collection & homework persistence steps reloaded and expected the dashboard without signing in (expected under 方案 A); tests now `reloadAndSignIn()` → PASS |
| 2026-11-25 | v6.1 | `e2e/auth` during development | Edge | found BUG-008 (offline sign-out → browser error page); session-expiry flake traced to `clock.fastForward` (harness note) |
| 2026-11-25 | v6.1 | mutation testing (7 mutants on the security checks, script restores each file) | Node + Edge | M1 signature check removed → KILLED (unit 3 + E2E); M2 audience check removed → KILLED; M3 Sheets `sub` match removed → KILLED; M4 one shared DB for all accounts → KILLED; M5 no in-place wipe on sign-out → KILLED; M7 `SYNC.stop()` no-op → first SURVIVED (TEST-GAP-001), revoke assertion added → KILLED; M6 only the redundant `stopped` flag removed → SURVIVED (documented redundancy) |
| 2026-11-25 | v6.1 final | `npm run verify` | Windows 11, Node 22.23.1 | PASS — syntax + imports, guardrails, ESLint, 113/113 unit (94 + 19 auth), exit 0 |
| 2026-11-25 | v6.1 final | `npm run test:e2e` | Edge | PASS 39/39, exit 0 |
| 2026-11-25 | v6.1 final | `E2E_CHANNEL=chrome npm run test:e2e` | Chrome | PASS 39/39, exit 0 (independent second run) |
| 2026-11-25 | v6.1 final (after BUG-011) | `npm run verify` / `npm run test:e2e` / `E2E_CHANNEL=chrome npm run test:e2e` | Windows 11 / Edge / Chrome | PASS — 113/113, 39/39, 39/39 |
| 2026-11-25 | v6.1 | CI `e2e` (ubuntu, Chrome) on 0cb99a8, fa73339, 4ba484a, 21f1027, 861b151, 756d314 | GitHub Actions | PASS 39/39 every run |
| 2026-11-25 | v6.1 | CI `e2e-compat (firefox)` — 5 runs | playwright Firefox build, ubuntu-24.04 | **FAIL 38/39** on the last 3 runs. Earlier failures were fixed: font-CORS wording, axe during fade-in, BUG-011. One remains: test `A offline queue…` asserts no console errors, but Firefox logs `InvalidStateError: Navigated away from page` (no source location) at the step where the offline-locked page reloads after the network returns. Every functional assertion in that test passes. Root cause not found (no local Firefox to debug). Not filtered out: left visible on purpose. |
| 2026-11-25 | v6.1 | CI `e2e-compat (webkit)` — 5 runs | playwright WebKit build, ubuntu-24.04 | **FAIL 36–38/39**: in every run 1–3 different tests end with "Target page … closed" / "Page crashed" (renderer crash). Two test races that WebKit exposed were fixed. No assertion failure attributable to the app was seen. Real Safari/iPad: NOT_VERIFIED. |
| CI | every push | GitHub Actions `Quality (no deployment)`: `verify` + `e2e` (ubuntu, Chrome) | ubuntu-latest, Node 22 | green for P2 (feff057), P3 (4b6bb42), P4 (853a880); later runs are listed in Draft PR #1 |

## Acceptance matrix
| ID | Requirement | Evidence | Status |
|---|---|---|---|
| A-01 | Project rules discoverable by a fresh agent | `AGENTS.md` → `docs/PROJECT-ENGINEERING.md`; not re-tested in a brand-new AI session | **NOT_VERIFIED** |
| A-02 | Static guardrails block violations, allow valid code | `tests/guardrails.test.mjs` (Firebase SDK, secrets/tokens, innerHTML, impure core, layer imports, fixtures, replaceChildren), `tests/lint.test.mjs` | PASS |
| A-03 | v4 / v5 / v5.1 backups import with identical numbers | `tests/backup-contract.test.mjs`, `tests/score-events.test.mjs` (hand-checked totals), E2E imports, IndexedDB v1→v2 in-place upgrade | PASS |
| A-04 | Only confirmed events count; pending/rejected never | unit + E2E order-recording; mutation test | PASS |
| A-05 | Group/class XP not double counted; penalties/redemptions never remove items | `tests/collection.test.mjs`, `e2e/collection` | PASS |
| A-06 | Group size gives no multiplier; regrouping keeps history | unit (2 vs 7 members; move groups), E2E (6 students / 2 groups) | PASS |
| A-07 | Unchecked ≠ missing; submitted ≠ corrected | `tests/homework.test.mjs`, `e2e/homework` | PASS |
| A-08 | Batch, late submission, correction time, undo, archive/restore | unit + E2E | PASS |
| A-09 | 6 × 12, rarity 5/4/2/1, special items outside the 12 | `validateCatalog()` + negative case | PASS |
| A-10 | ≤ 2 tags; disabled builtin kept on old items, not selectable for new; custom delete with impact + double confirm | unit + E2E | PASS |
| A-11 | Google auth: minimal scope, expiry, denial, offline | emulator unit + E2E (fake GIS script + emulated Sheets API at the network layer) | PASS (emulated) · real Google OAuth: **BLOCKED** (needs the user's OAuth Client ID and approval to use a test spreadsheet) |
| A-12 | Two-device conflicts, retry dedupe, offline queue | `tests/sync.test.mjs` (19 scenarios + BUG-006, 3 mutants killed), `e2e/sync` | PASS (emulated) · real Sheets: **BLOCKED** |
| A-13 | No Firebase SDK/UI left; remote Firestore untouched | guardrail `LEGACY_FIREBASE_ALLOWED = []` + test; app never connects to Firebase | PASS |
| A-14 | JSON round trip; cloud copy restores a new device; rollback path | backup round trip unit/E2E; device B pulls everything in `e2e/sync`; v5.1-compatible rollback export (unit + E2E) | PASS (emulated cloud) |
| A-15 | Phone / tablet / laptop / projector, keyboard, reduced motion | `e2e/responsive-a11y` (no overflow at 375/768/1280/1920; axe-core critical+serious = 0; keyboard), reduced-motion E2E | PASS |
| A-16 | CI actually runs | GitHub Actions runs above | PASS |
| A-17 | No production deploy / merge / real data without approval | no merge, no Pages change, synthetic data only | PASS |
| A-18 | Not signed in → no system access, no account DB, nothing rendered; reload/deep link never bypass | `e2e/auth › not signed in…`, `› account isolation…` (reload + `#class-view` deep link) | PASS (emulated Google) |
| A-19 | Successful sign-in opens the correct account's data area | `e2e/auth` (DB per account, name has no sub/email), unit `accountKey` | PASS (emulated) |
| A-20 | Cancelled sign-in does not unlock | `e2e/auth › cancelled sign-in…` | PASS (emulated) |
| A-21 | Invalid / expired / wrong-audience / wrong-issuer / forged / replayed / alg-none / no-sub ID tokens never unlock | unit `tests/auth.test.mjs` (12 negative cases, real RS256 signatures) + E2E (7 modes in the browser) | PASS |
| A-22 | Signature, issuer, audience, expiry verified (no backend: verified in the browser against JWKS; ADR-011) | unit + mutation (signature check removed → tests fail) | PASS · server-side verification: NOT_APPLICABLE (no backend by design, see ADR-011) |
| A-23 | Sheets consent denied / scope missing → local data intact | `e2e/sync › Sheets authorization…`, unit | PASS (emulated) |
| A-24 | Sheets authorization for a different account than the signed-in one is blocked (token revoked) | unit + E2E + mutation | PASS (emulated) |
| A-25 | After A signs out, B sees none of A's data; switching leaves no trace of A on the page | `e2e/auth › account isolation…` | PASS (emulated) |
| A-26 | A's offline queue never reaches B's spreadsheet; it reaches A's sheet when A returns | `e2e/auth › A offline queue…` (request log per account) | PASS (emulated) |
| A-27 | Shared browser (other tab), offline reopen, 12 h session expiry, wipe-on-sign-out | `e2e/auth` (4 tests) | PASS (emulated) |
| A-28 | Legacy v4 / v5.1 / early-v6 data not lost and never auto-assigned | `e2e/legacy-v51` (v5.1 IndexedDB claim + undo, v4 cache claim), unit `planLegacyImport/Undo` | PASS |
| A-29 | No credential in localStorage, sessionStorage, IndexedDB, cookies, URL, console, backup or sheet | `e2e/auth › no credential ever lands…` + guardrails (persist/log/decode-only) with negative tests | PASS (emulated tokens) |
| A-30 | Login screen + account dialog: 4 viewports, axe critical/serious = 0, keyboard sign-in | `e2e/auth` (4 viewport tests + keyboard) | PASS |
| A-31 | Firefox / WebKit (Safari engine) | CI job `e2e-compat` (playwright builds) — see evidence log | **FAIL** (Firefox 38/39: one unexplained console error; WebKit: random renderer crashes). Real Safari/Firefox on devices: NOT_VERIFIED |
| A-32 | Real Google sign-in + Sheets with a real account | needs a real OAuth Client ID and approval | **BLOCKED** |
| — | v5.1 daily settlement + CSV | `e2e/legacy-v51 › daily settlement snapshot and day CSV` | PASS |
| — | Visual regression (pixel baseline comparison) | screenshots are produced (CI artifact `e2e-screenshots`) for human review; no automatic pixel diff | NOT_CONFIGURED |
| — | Real devices (iPad, interactive whiteboard), Safari/WebKit, Firefox | emulated viewports on Chromium (Edge/Chrome) only | NOT_VERIFIED |
| — | Final illustrated artwork | original placeholder SVGs, labelled in the UI; ledger in `docs/ASSET-LICENSES.md` | NOT_APPLICABLE for this PR |

## What a green run does NOT prove
- Real Google OAuth / Google Sheets behaviour (quotas, consent screens, `origin_mismatch`, account policies).
- Real "Sign in with Google": FedCM / popup behaviour, real JWKS rotation, Workspace admin policies, third-party-cookie settings per browser. All sign-in tests use a fake GIS library that signs tokens with a per-run test key.
- That local data is protected from someone with DevTools on the same browser profile — it is not (ADR-011, `docs/AUTH-SECURITY.md`).
- Safari/WebKit and Firefox behaviour; physical touch devices.
- Classroom usability and teacher workload — needs a real trial with synthetic data first.
