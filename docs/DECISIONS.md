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
