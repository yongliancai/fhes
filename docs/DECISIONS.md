# Architecture Decisions — FHES

## ADR-001 — Branch-based safety (2026-11-24)
All work happens on `chore/code-factory-p0-p2` with Draft PR #1. No merge, deployment or production-data operation without a separate user decision.

## ADR-002 — v5.1 behaviour is the baseline
GitHub `main` @ `44879bb` (v5.1) is the behavioural baseline. The older v2.2 design document is reference only; where it conflicts with v5.1, v5.1 wins (e.g. hearts are penalty reminders, `earned` excludes redemptions, order-recording/pending flow).

## ADR-003 — Firebase replaced by Google account + Google Sheets
The front-end Firebase/Firestore sync is removed from the app (P5). Remote Firestore data is **not** touched: teachers who need it open the v5.1 build, export JSON, and import it into v6. See `docs/GOOGLE-SHEETS-SETUP.md`.

## ADR-004 — No framework rewrite
Static HTML + native ES modules + Node built-in test runner. No React/TypeScript/bundler: there is no evidence they reduce risk for this app, and a build step would complicate GitHub Pages and teacher self-hosting.

## ADR-005 — Native ES modules, no build step (2026-11-24)
Logic moves out of the inline script into `src/**.js` ES modules imported by `index.html`. Consequence: the page must be served over http(s) (GitHub Pages, or `npm run serve` locally); opening the HTML file directly from disk (`file://`) no longer works. This is acceptable because Google Identity Services also requires an http(s) origin. Benefit: Node tests import the exact production modules instead of extracting source text.

## ADR-006 — Browser E2E with playwright-core and the system browser
`playwright-core` (no bundled browsers) drives the installed Edge (Windows) or Chrome (CI). Each test gets a fresh browser context, hence an empty IndexedDB. External network is blocked in tests so fonts/CDNs cannot cause flakiness.

## ADR-007 — Homework state = projection of immutable events
Each change to a student × assignment cell is an immutable `hwEvent` with `prevIds` (the DAG parents). The current state is recomputed from events. Undo writes compensating events; sync only appends rows; concurrent edits from two devices appear as two DAG heads and are shown to the teacher as a conflict instead of a silent overwrite.

## ADR-008 — XP derived from score events, grants stored
XP is not stored as a running number. It is derived from confirmed score events that carry `xpv` (XP version marker) and the student's group at event time (`xpGroup`), plus explicit `xpEvents` (class bonuses, homework all-in bonus). Old events without `xpv` never back-fill XP. Collected items are stored as `grants` with deterministic IDs (`g|class|ownerType|ownerId|itemId`) so re-sending the same unlock can never create a duplicate.

## ADR-009 — Sync by three-way content hash, single-teacher model
Each synced row stores a content hash. Per entity: compare local hash, remote hash and last-synced hash → push, pull, nothing, or conflict. Only changed rows are written (row-level `values.batchUpdate` or `values.append`), never whole sheets. Google Sheets has no transactions: a small race window remains between the re-check and the write; it is detected on the next sync and surfaced as a conflict. Designed for one teacher using several devices, not many concurrent editors.

## ADR-010 — OAuth scope `drive.file`
The app requests only `https://www.googleapis.com/auth/drive.file` (files the app creates or the user opens with it). Access tokens are kept in memory only, never in localStorage/IndexedDB. The OAuth Client ID is a public identifier the teacher enters in settings; it is not committed.

> ADR-010 amended by ADR-013 (2026-11-25): the token request now also includes `openid`, only so the granted account's `sub` can be compared with the signed-in account. No new data access.

## ADR-011 — Required Google sign-in (方案 A), verified in the browser, no backend (2026-11-25)
**Decision.** The teacher must sign in with Google before anything opens. Sign-in uses Google Identity Services "Sign in with Google" (ID token). The ID token is verified in the browser by `src/auth/id-token.js`: RS256 signature against Google's JWKS (`kid`), `iss`, `aud`/`azp` = our Client ID, `exp`/`iat`/`nbf` with 60 s skew, a one-time `nonce`, and a non-empty `sub`. Decoding without these checks is banned by a guardrail. The account key is `sub`, never email. The session lives only in memory, lasts at most 12 hours, and ends on sign-out, account switch, expiry, sign-out in another tab of the same account, or reload. Nothing about the token is stored.

**Backend evaluated and not added.** A minimal backend (verify the ID token server-side, issue an httpOnly session cookie) was considered:
- The data does not live on a server. Class data is in the browser's IndexedDB on the teacher's device, and the cloud copy is in the teacher's own Google Sheet. A backend session would not protect either: IndexedDB is readable by anyone who can open DevTools in that browser profile, and Sheets access is authorised by Google with the user's own OAuth token.
- A backend would add hosting, secrets, uptime and a privacy surface (student data or tokens passing through a server) that the school would need to approve. Creating hosting needs separate user approval anyway.
- Google already enforces the cloud authorisation boundary server-side (Sheets ACL plus the `drive.file` scope).

**What this design does NOT guarantee (stated in the UI and in `docs/AUTH-SECURITY.md`):**
- The login gate is a client-side gate. Someone with the device, the same browser profile and DevTools can read IndexedDB without signing in. Local data is **not encrypted**.
- Browser-side token verification blocks forged, expired, replayed and wrong-audience tokens from unlocking the UI. It does not stop someone who modifies the page's code on their own machine.
- No server-side audit log of sign-ins exists.

**Encryption evaluated and not added.** No stable secret is available to the page after a Google sign-in (the ID token changes every time, and `sub` is not secret), so the data cannot be encrypted with a key tied to the Google login without a backend or a separate passphrase. A passphrase would add a second credential that teachers can lose, which would lock them out of student records. Instead, shared computers get an explicit "sign out and remove this account's data from this computer" action (backup first). Separate OS accounts or browser profiles per teacher are also recommended.

**Rollback.** Revert the commit. The legacy database is never modified, so v6.0 or v5.1 still open it.

## ADR-012 — Local data partitioned per Google account; legacy data claimed explicitly (2026-11-25)
- Each account gets its own IndexedDB: `fhes-acct-<first 32 hex of SHA-256("https://accounts.google.com|" + sub)>`. The name contains neither the sub nor the email. Spreadsheet ID, sync state, outbox (pending hashes), conflicts and device ID all live inside that database, so they are partitioned automatically.
- The pre-login database `classroomPowerhouseV5` (v5.1 or early v6) and the v4 localStorage cache belong to no account:
  - They are **never** opened by the app's normal path, upgraded or assigned automatically.
  - After sign-in, a banner offers a preview showing class names and counts.
  - The teacher ticks classes. The app first downloads a full legacy backup (and a backup of the account if it already has classes), then **copies** the selection into the account. Classes the account already has are skipped, never overwritten. The record is kept in `meta.legacyImport` so the teacher can "復原這次匯入".
  - "這不是我的資料" hides the banner for that account only.
  - Removing the legacy data is a separate action with two confirmations, done after a backup.
- This replaces the old automatic `migrateFromV4IfNeeded()`.

## ADR-013 — Sheets authorization bound to the signed-in account (2026-11-25)
- The token client is created with `hint`/`login_hint` = the signed-in account and scope `openid drive.file`.
- After the token arrives:
  - `drive.file` must be granted.
  - `GET https://openidconnect.googleapis.com/v1/userinfo` is called with the token in the `Authorization` header, never in the URL, and its `sub` must equal the signed-in `sub`.
  - Otherwise the token is revoked and refused.
- On sign-out or account switch, `SYNC.stop()` cancels timers, drops queued conflict choices, revokes the in-memory token and refuses further runs, before the page reloads. A's queue therefore can never be sent with B's token.
- "使用這份" first probes the spreadsheet with a read-only metadata GET. A 403 or 404 refuses it, nothing is saved, and no other spreadsheet is substituted.
