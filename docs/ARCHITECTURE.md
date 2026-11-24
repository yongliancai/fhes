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
| `src/ui/dom.js` | ui | `h()`/`s()` DOM builders (textContent only), dynamic modals |
| `src/ui/homework-ui.js` | ui | homework tab: projection-safe stats, teacher matrix, batch, follow-up, history, settings, reward rule |
| `src/ui/features.css` | ui | styles for v6 features |

Dependency direction: `ui → sync → core/data`. `core`/`data` are pure (no browser globals). Enforced by `scripts/guardrails.mjs`.

## Browser storage
IndexedDB `classroomPowerhouseV5`:
- v1 stores (v5/v5.1): `classes`, `students`, `events`, `dailySnapshots`, `meta`.
- v2 stores (v6): `hwAssignments`, `hwEvents`, `xpEvents`, `specialItems`, `grants` (all indexed by `classId`), `syncState` (key → last synced hash/row).
- Upgrade is additive (`onupgradeneeded` checks `oldVersion`); verified by `e2e/legacy-v51.e2e.mjs › IndexedDB v1 … upgrades in place`.

## Homework data
- `class.hwTypes` (11 defaults `hwt-01…hwt-11`, custom `hwt-<uid>`), `class.hwReward` (`{ enabled:false, xp:5 }` by default).
- `hwAssignments`: `{ id, classId, typeId, title, note, assignedDate, dueDate, archived, createdAt, updatedAt }`.
- `hwEvents` (immutable): `{ id, classId, assignmentId, studentId, field: submission|correction, value, prev, prevIds[], ts, date, batchId, deviceId, reason, undoOfBatch? }`.
- Current state = `projectRecords(hwEvents)`; never stored. Projection view shows aggregates only; teacher view must be toggled explicitly and resets when leaving the tab.

In-memory `S` mirrors the stores; totals are recomputed from events.

## Tests
- `tests/*.test.mjs` — Node built-in runner, imports production modules directly; synthetic fixtures in `tests/fixtures/` (v4/v5/v5.1 backups with hand-checked expected totals).
- `e2e/*.e2e.mjs` — playwright-core + system browser against `scripts/serve.mjs`.
- `scripts/guardrails.mjs`, `scripts/lint.mjs`, `scripts/check-inline-js.mjs` — deterministic checks.
