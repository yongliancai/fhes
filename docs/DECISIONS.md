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

## ADR-014 — Google button uses the popup, not FedCM; authorized origins are checked in the app (2026-11-25, real-Google acceptance)
- **Popup instead of FedCM** (`use_fedcm_for_button: false`, `button_auto_select: false`): in real Chrome 158 the FedCM button signed a returning account straight back in after sign-out, with no chooser, so "切換帳號" could not switch (BUG-015). The popup shows Google's account chooser each time; cancel keeps the app locked.
  - Trade-off: popups can be blocked; Google may migrate the button to FedCM in future. Re-test before each release.
  - Popup sign-in once failed to reach the app in 2 of 4 tries; the callback now accepts any issued, unused nonce and never drops a response silently (BUG-017, OPEN).
- **`GOOGLE_AUTHORIZED_ORIGINS` in `src/config.js`** mirrors the Cloud console. Google's button gives the app no signal on `origin_mismatch`, so the login screen warns first when the current origin is not listed (e.g. `127.0.0.1` vs `localhost`).
- **The Client ID is committed in `src/config.js`** (user approval 2026-11-25, together with the merge/publish approval). It is a public identifier; no client secret exists in the app or the repo. E2E keeps testing the "no Client ID configured" screen by serving a blank `config.js` to that one context.
- **Revoke on sign-out stays**, although Google revokes the whole grant, so other devices must press "重新連線" afterwards (observed, S16). Security over convenience on shared computers.

## ADR-013 — Sheets authorization bound to the signed-in account (2026-11-25)
- The token client is created with `hint`/`login_hint` = the signed-in account and scope `openid drive.file`.
- After the token arrives:
  - `drive.file` must be granted.
  - `GET https://openidconnect.googleapis.com/v1/userinfo` is called with the token in the `Authorization` header, never in the URL, and its `sub` must equal the signed-in `sub`.
  - Otherwise the token is revoked and refused.
- On sign-out or account switch, `SYNC.stop()` cancels timers, drops queued conflict choices, revokes the in-memory token and refuses further runs, before the page reloads. A's queue therefore can never be sent with B's token.
- "使用這份" first probes the spreadsheet with a read-only metadata GET. A 403 or 404 refuses it, nothing is saved, and no other spreadsheet is substituted.

## ADR-015 — v6.2 adds a minimal backend for students only (2026-11-25)
**Context.** v6.2 lets students sign in and see their own data. ADR-011 rejected a backend because data lived only on the teacher's device; that reasoning does not hold for students, who must not get the teacher's data or tokens, and whose access must be checked by a server.
**Decision.** A small Node.js API (`server/`) holds per-student projections, student accounts and group care events. The teacher app stays the source of truth for score, homework, XP and grants (IndexedDB + Google Sheets, unchanged).
**Options compared** (no remote access to the VPS was made; based on project files and the user's statement that a VPS exists):
| | Existing VPS + Node (chosen) | Serverless (e.g. Cloud Run / Functions + managed DB) |
|---|---|---|
| Security | Full control; same-origin cookie for students; must patch OS/Node ourselves | Managed patching; cross-site cookies or token storage harder; more IAM surface |
| Cost | Already paid | New billing account and resources (needs approval) |
| Maintenance | One process, one SQLite file, nginx reverse proxy | Cold starts, vendor config, separate DB service |
| Domain / cookies | Student page and API on one sub-domain → `__Host-` cookie, `SameSite=Strict` | Needs custom domain mapping to get the same |
| Backup | File copy of SQLite (daily, encrypted) | Provider snapshots |
| Isolation | Separate system user, port bound to 127.0.0.1, own data directory; must not share the existing site's process | Strong by default |
**Consequence.** Deployment, domain, TLS, nginx/PM2 changes are listed as approval items; nothing is done on the real VPS.
**Rollback.** The teacher app works without the API (feature hidden when `STUDENT_API_BASE` is empty). Stopping the process removes the student system; teacher data is unaffected.

## ADR-016 — Stack: Fastify 5, better-sqlite3, Argon2id (2026-11-25)
- Fastify: maintained, schema validation, body limits, no extra plugins except `@fastify/cookie`.
- better-sqlite3 instead of `node:sqlite` (still experimental in Node 22): mature, synchronous, real transactions; one file, easy backup. Suitable for one school (hundreds of students).
- Argon2id (`argon2` package, OWASP parameters m=19 MiB, t=2, p=1). Node 22 has no built-in Argon2.
- The server imports the browser's pure modules (`src/auth/id-token.js`, `src/core/student-projection.js`, `src/core/care.js`) so rules are written once.

## ADR-017 — Teacher authentication on the server (2026-11-25)
- The teacher app already receives a Google ID token at sign-in. When the student system is configured, that token (and its nonce) is sent once to `POST /api/teacher/session`, then dropped from memory.
- The server verifies it with Google's JWKS using the same `verifyGoogleIdToken()` (signature, iss, aud/azp, exp, sub) plus `iat` no older than 10 minutes. The nonce is supplied by the client and is inside the token, so on the server it is only a consistency check; replay protection is the one-time use of the signed content (SHA-256 of `header.payload`, kept until expiry), not of the raw string (BUG-023).
- Only teachers on `FHES_TEACHER_ALLOW` (full email or `@domain`, `email_verified` required) get a session; quotas: 30 classes per teacher, 80 accounts per class (BUG-022).
- The server returns an opaque Bearer token (8 h, stored hashed) kept only in the teacher page's memory. CORS allows only configured teacher origins. No cookies for teachers → no CSRF.
- A class belongs to the teacher who created its link: `(teacherId, localClassId)`. Other teachers get 404.
- Tests use a test JWKS injected into the app factory; the production entry (`server/main.mjs`) always fetches Google's JWKS and refuses to start without a Client ID. No test flag exists in production code paths that skips verification.

## ADR-018 — Student accounts and sessions (2026-11-25)
- Teachers create accounts; usernames are random (`abc1234` style, ambiguous letters removed); initial passwords are 10 random characters from a 32-letter alphabet, shown once.
- First sign-in must change the password (policy: ≥ 8 chars, not the username, not common, not one repeated character or a simple sequence).
- Sessions: random 256-bit id in a `__Host-fhes_sid` cookie (HttpOnly, Secure, SameSite=Strict); server stores SHA-256 only; idle 2 h, absolute 12 h; rotated on sign-in and password change; all revoked on teacher reset/disable.
- Every state-changing student request needs `X-FHES-CSRF` (per-session token) and an allowed `Origin`.
- Every attempt is counted before the asynchronous Argon2 check (BUG-021). Lockout per account (5 failures → 1, 2, 4 … 15 min) and per IP (200 failures / 15 min → 429, high enough that one NAT'd classroom is not locked out by typos). Unknown usernames still run one Argon2 verification. Behind nginx, `FHES_TRUST_PROXY` must be set explicitly.
- All ACL comes from the session: `accountId → classId, localStudentId`; the group comes from the latest projection. Student endpoints take no identity parameters.

## ADR-019 — Group care is cosmetic and capped (2026-11-25)
- Care events live only on the server. Each student has at most 3 counted care actions per Asia/Taipei day across all groups, enforced by `UNIQUE(account, localDate, slot)` with `slot ∈ 1..3`, inside a transaction; `UNIQUE(account, idempotencyKey)` makes retries safe. Extra actions return `counted:false` and only play an animation.
- Care changes mood (calm → happy → very happy; never negative), unlocks group decorations at 10/30/60/100/160 counted actions, and gives a "team day" star when at least half of the group's members cared that day.
- Care never creates XP, score or grants, and does not change growth stages. Projections are built from v6.1 data only.
- No death, sickness, decay below neutral, streaks or daily-login pressure.

## ADR-020 — Teacher projection publishing (2026-11-25)
- `src/core/student-projection.js` (pure) builds per-student DTOs from v6.1 data with the existing rules (`computeTotals`, `projectRecords`, `xpLedger`, `growthStage`). Hearts are not published.
- Publishing is manual ("發布到學生系統"), optionally automatic after changes (debounced). Each publish carries `version` (monotonic, ms) and a SHA-256 `hash` of the canonical content. Older version → 409; same version + same hash → idempotent 200; same version + different hash → 409.
- A newer version replaces the whole class in one transaction: students or groups missing from it lose their projection (no ghost data).
- The teacher can choose to publish seat numbers instead of names.
- The student page shows the publish time and warns when it is older than 3 days.
