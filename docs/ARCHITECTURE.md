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

Dependency direction: `ui → sync → core/data`. `core`/`data` are pure (no browser globals). Enforced by `scripts/guardrails.mjs`.

## Browser storage
IndexedDB `classroomPowerhouseV5`:
- v1 stores: `classes`, `students`, `events`, `dailySnapshots`, `meta`.

In-memory `S` mirrors the stores; totals are recomputed from events.

## Tests
- `tests/*.test.mjs` — Node built-in runner, imports production modules directly; synthetic fixtures in `tests/fixtures/` (v4/v5/v5.1 backups with hand-checked expected totals).
- `e2e/*.e2e.mjs` — playwright-core + system browser against `scripts/serve.mjs`.
- `scripts/guardrails.mjs`, `scripts/lint.mjs`, `scripts/check-inline-js.mjs` — deterministic checks.
