# FHES Engineering Rules (v1.0, 2026-11-24)
Single source of truth for AI-assisted development (Claude Code, Codex, ChatGPT or others). `AGENTS.md` is only the entry pointer.

## Authorization
- Approved (2026-11-24, user): P2–P6 on the isolated branch `chore/code-factory-p0-p2` / Draft PR #1, using synthetic data and isolated test environments only.
- Forbidden until separately approved: merge to `main`; publishing/deploying (GitHub Pages included); auto-merge/auto-deploy; touching real student data; reading, changing or deleting remote Firebase/Firestore data; creating real Google Cloud/OAuth/Sheets resources; sharing credentials; expanding access.

## Default process
READ_RULES → UNDERSTAND_TASK → PLAN_SCOPE → CHANGE → RUN_CHECKS → FIX → EVIDENCE → PR/REPORT.
Bugs: DETECT → REPRODUCE → ROOT_CAUSE → FIX → PREVENT → PROVE → RECORD (log in `docs/BUG-LOG.md`, with a regression test that fails on the buggy version).

## Code layout rules (enforced by `scripts/guardrails.mjs` + ESLint)
- `index.html` stays the single entry page; there is **no build step**. Logic lives in native ES modules under `src/` (served over http/https; see ADR-005).
- `src/core/` and `src/data/` are pure: no `document`, `window`, `indexedDB`, `localStorage`, `navigator`; they must not import `ui/`, `sync/` or `art/`.
- `src/sync/` must not import `ui/`.
- No HTML string sinks in `src/` (`innerHTML=`, `outerHTML=`, `insertAdjacentHTML`, `document.write`). Build DOM nodes and set `textContent` — names arriving from Google Sheets are untrusted input.
- No Firebase SDK anywhere in shipped code once P5 lands (`LEGACY_FIREBASE_ALLOWED` must be empty).
- No credentials/tokens in any tracked file. Fixtures must carry `"_synthetic": true`.

## System invariants (do not change without explicit user approval)
- Score: only `confirmed` events count; pending/rejected never count; hearts never drop below 0 at any step (effective-time order); redemption lowers spendable score but never lifetime `earned`; group totals are independent of student totals.
- History is append-only in spirit: undo/revoke write reverse events; originals are kept and marked.
- Homework: submission (`unchecked/missing/submitted/exempt`) and correction (`ungraded/needs/done/none`) are separate dimensions. `unchecked ≠ missing`; `submitted ≠ corrected`. State is projected from immutable `hwEvents`. Homework never changes score/XP automatically.
- Projection/class display must never show individual negative records (missing homework, hearts when hidden).
- XP: group XP and class XP are separate ledgers derived from events that carry `xpv`; a group +N gives the group +N once (never × members); negative scores and redemptions never reduce XP; undo/revoke of a mistaken positive removes its XP. Grants (collected items) are permanent records: score loss, redemption, XP correction or group changes never delete them.
- Catalogue: 6 worlds × 12 base items with rarity 5/4/2/1 (`npm test` enforces it); special items have their own IDs, ≤2 tags, never occupy base slots; tags never act as unlock conditions; builtin tags can be disabled but not deleted.
- Sync: IndexedDB is the offline store; Google Sheets is the cloud copy. Never overwrite whole sheets; push only changed rows; append-only for immutable tables; three-way hash compare to detect conflicts; never claim success before the remote write is confirmed; OAuth tokens live only in memory.
- Backups: v4, v5, v5.1 and v6 files must keep importing; newer versions are refused; import always downloads a pre-import backup first.

## Verification
- `npm run verify` = inline-script syntax + import resolution, guardrails, ESLint (incl. index.html inline module), unit tests.
- `npm run test:e2e` = real-browser tests (playwright-core with system Edge/Chrome; fresh IndexedDB per test; screenshots in `test-results/`).
- A green run does NOT prove real Google OAuth/Sheets integration — that stays BLOCKED until the user supplies a Client ID and approves a test spreadsheet.
- Whenever scoring, backup, homework, XP, catalogue or sync logic changes: add a negative and a positive test.
- Never silence a failing check to get green CI.

## Persistence and upkeep
Change rules by editing this file with date + rationale, updating affected tests, and noting rollback. A fresh AI session must be asked to read `AGENTS.md`; cross-platform auto-loading is not assumed.
