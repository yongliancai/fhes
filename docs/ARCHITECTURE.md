# FHES code map

## Entry
- `index.html` — page markup, CSS, and the main inline `<script type="module">` (UI controllers for the v5.1 screens). Imports `src/**`.
- Must be served over http(s) (ADR-005). Local: `npm run serve` → http://127.0.0.1:8765/

## Modules (`src/`)
| Path | Layer | Purpose |
|---|---|---|
| `src/core/dates.js` | core | Asia/Taipei local date/time helpers |
| `src/core/ids.js` | core | `uid`, `stableStringify`, content hash |
| `src/core/score.js` | core | v5.1 scoring rules: `isCounted`, `applyTo`, totals, `normalizeEvent` |
| `src/core/classes.js` | core | class defaults/back-fill (`ensureClassDefaults`, extensible fillers), sessions |
| `src/core/backup.js` | core | backup parse/build for v4/v5/v5.1/v6, v4 conversion |
| `src/core/homework.js` | core | homework types, assignments, event projection (DAG heads → conflicts), batch/undo, statistics, follow-up lists |
| `src/core/xp.js` | core | XP ledger derived from score events (`xpv`, `xpGroup`) + `xpEvents`; class milestones |
| `src/core/collection.js` | core | unlock rules (sequential/free, energy), deterministic grants, revoke, growth stages, special items, tags |
| `src/data/catalog.js` | data | 6 worlds × 12 base items (stable ids `land-01`…), rarities, confirmation status, fact cards, art specs |
| `src/art/creatures.js` | art | original parametric SVG characters (placeholder art), silhouettes, growth-size |
| `src/art/scenes.js` | art | six habitat scenes, class-milestone decorations, actor slots |
| `src/ui/collection-ui.js` | ui | 圖鑑 tab: owners (groups/class), world tabs, habitat, cards, detail, unlock/grant/revoke, special items, tags, settings |
| `src/sync/schema.js` | sync | 11 sheets (Classes, Students, ScoreEvents, DailySnapshots, HomeworkAssignments, HomeworkEvents, XPEvents, Catalog, CollectionGrants, Settings, SyncMeta); fixed columns A–G + readable columns |
| `src/sync/engine.js` | sync | three-way hash sync, row-level push, re-check before update, tombstones, auto-merge of bookkeeping-only diffs, error classification, backoff |
| `src/sync/sheets-adapter.js` | sync | Google Sheets REST (batchGet/append/batchUpdate/create/addSheet), RAW writes |
| `src/sync/google-auth.js` | sync | Sheets authorization (GIS token model, `openid drive.file`), bound to the signed-in `sub` via userinfo; in-memory token |
| `src/auth/id-token.js` | auth (pure) | Google ID token verification (RS256/JWKS, iss, aud/azp, exp/iat/nbf, nonce, sub); `accountKey(sub)`; nonce |
| `src/auth/google-signin.js` | auth | loads GIS, renders the Sign in with Google button, fetches JWKS (memory only), verifies; 12 h session |
| `src/config.js` | config | deploy-time public `GOOGLE_CLIENT_ID` (empty in the repo) |
| `src/core/legacy.js` | core | rules for claiming pre-login data: summary, plan import (selected classes, skip existing), plan undo |
| `src/ui/auth-ui.js` | ui | login gate, account chip/menu, sign-out/switch/wipe, cross-tab sign-out, session watchdog |
| `src/ui/legacy-ui.js` | ui | reads the legacy DB without creating it, banner, preview/choose/backup/copy/undo/remove |
| `src/ui/sync-ui.js` | ui | local store adapter (IndexedDB + `syncState`), status badges, settings dialog, conflicts, scheduler |
| `src/ui/dom.js` | ui | `h()`/`s()` DOM builders (textContent only), dynamic modals |
| `src/ui/homework-ui.js` | ui | homework tab: projection-safe stats, teacher matrix, batch, follow-up, history, settings, reward rule |
| `src/ui/features.css` | ui | styles for v6 features |

| `src/core/student-projection.js` | core | v6.2: per-student DTO from v6.1 rules (no hearts), validation, SHA-256 hash (shared with the server) |
| `src/core/care.js` | core | v6.2: group care rules (3/day, mood, badges, team days); cosmetic only |
| `src/sync/student-api.js` | sync | v6.2: teacher client for the student API (in-memory bearer, accounts, versioned publish) |
| `src/ui/student-admin-ui.js` | ui | v6.2: 「學生系統」 dialog (accounts, one-time slips, publish, care summary); hidden when `STUDENT_API_BASE` is empty |
| `src/art/student-art.js` | art | v6.2: approved-art lookup by catalog ID with SVG fallback |
| `src/data/art-manifest.js` | data | approved art list (empty on this branch; generated on the art branch) |
| `student.html`, `src/student/*` | student page | v6.2: student learning centre, served same-origin by the API under a strict CSP. P3: my classes / class switcher / one code box, `#join=` links; `student-google.js` loads Google sign-in only when the server's switch is on (ADR-029) |
| `server/` | backend | v6.2: Fastify + better-sqlite3 + Argon2id API (`docs/STUDENT-SYSTEM.md`, `docs/api/openapi.yaml`) |

Dependency direction: `ui → sync → auth/core/data`; `auth` depends on nothing else. `core`/`data` are pure (no browser globals). Enforced by `scripts/guardrails.mjs`.

## Browser storage
Since v6.1 every Google account has its own IndexedDB `fhes-acct-<SHA-256(iss|sub)[0..32]>` with the schema below. The old database `classroomPowerhouseV5` belongs to no account: it is only read (never created/upgraded) by `src/ui/legacy-ui.js` for the explicit claim flow (ADR-012). localStorage holds only device preferences and the public OAuth Client ID; sessionStorage holds only a one-shot notice code. No credential is stored anywhere (ADR-011).

Schema (per account DB; same as the old `classroomPowerhouseV5`):
- v1 stores (v5/v5.1): `classes`, `students`, `events`, `dailySnapshots`, `meta`.
- v2 stores (v6): `hwAssignments`, `hwEvents`, `xpEvents`, `specialItems`, `grants` (all indexed by `classId`), `syncState` (key → last synced hash/row).
- Upgrade is additive (`onupgradeneeded` checks `oldVersion`); verified by `e2e/legacy-v51.e2e.mjs › IndexedDB v1 … upgrades in place`.

## Homework data
- `class.hwTypes` (11 defaults `hwt-01…hwt-11`, custom `hwt-<uid>`), `class.hwReward` (`{ enabled:false, xp:5 }` by default).
- `hwAssignments`: `{ id, classId, typeId, title, note, assignedDate, dueDate, archived, createdAt, updatedAt }`.
- `hwEvents` (immutable): `{ id, classId, assignmentId, studentId, field: submission|correction, value, prev, prevIds[], ts, date, batchId, deviceId, reason, undoOfBatch? }`.
- Current state = `projectRecords(hwEvents)`; never stored. Projection view shows aggregates only; teacher view must be toggled explicitly and resets when leaving the tab.

In-memory `S` mirrors the stores; totals are recomputed from events.

## Collection / XP data
- Score events created from v6 carry `xpv: 1` and `xpGroup` (the student's group at event time). XP is derived, never stored: student +N → `xpGroup` +N and class +N; group +N → that group +N once and class +N; penalties, negative scores, redemptions, pending/rejected and undone/revoked events give 0.
- `xpEvents`: `{ id, classId, scope: class|group, scopeId, delta, reason, source: manual|hw-bonus, sourceId, ts, voided }`.
- `grants`: `{ id: g|classId|ownerType|ownerId|itemId, ownerType: group|class, itemId, special, source: xp|teacher|special, cost, note, acquiredAt, revoked, revokeNote }`.
- `specialItems`: `{ id: sp-…, classId, name, rarity, tagIds[≤2], baseItemId, note }`.
- Class settings: `collection { mode, costs, periodStart }`, `groupWorlds { [group]: worldId }`, `collectionTags [{ id, name, builtin, active }]`.

## Cloud sync (replaces Firebase)
- HomeworkTypes and Groups are embedded in the Classes row (`data` JSON + readable `hwTypes` column); HomeworkRecords are represented by the immutable HomeworkEvents log (current state is recomputed). This keeps one source of truth per fact.
- `syncState` store: `{ key: "<table>|<id>", hash, rev, row }` = last state confirmed by the sheet. Pending count = entities whose hash differs.
- Sync runs 4 s after any change, on `online`, on tab focus, or manually; retryable errors back off 5 s → 5 min; auth errors wait for the teacher to click 重新連線.
- Teacher-facing setup: `docs/GOOGLE-SHEETS-SETUP.md`.

## Student system (v6.2)
See `docs/STUDENT-SYSTEM.md` (architecture, permission matrix, data flow), `docs/STUDENT-THREAT-MODEL.md`, ADR-015…020. The teacher app stays the source of truth; the server stores only projections, student accounts (Argon2id), sessions (hashed) and care events. Local demo: `npm run student:dev`.

## Tests
- `tests/*.test.mjs` — Node built-in runner, imports production modules directly; synthetic fixtures in `tests/fixtures/` (v4/v5/v5.1 backups with hand-checked expected totals).
- `e2e/*.e2e.mjs` — playwright-core + system browser against `scripts/serve.mjs`. Every test signs in through `tests/helpers/fake-google.mjs` (fake GIS that really RS256-signs ID tokens with a per-run key, JWKS and userinfo routes); `e2e/auth.e2e.mjs` covers the gate, invalid tokens, isolation, sessions and token leaks.
- `tests/helpers/sheets-emulator.mjs` — Google Sheets REST emulator with fault injection; used by unit tests (fake fetch) and E2E (network routes for `sheets.googleapis.com` and a fake GIS script). Not shipped.
- `tests/server-*.test.mjs` — v6.2 backend through `app.inject()` with an in-memory DB and test-signed Google tokens (`tests/helpers/server-harness.mjs`); `e2e/student.e2e.mjs` runs the real API in-process with the teacher app and the student page.
- `scripts/guardrails.mjs`, `scripts/lint.mjs`, `scripts/check-inline-js.mjs` — deterministic checks.
