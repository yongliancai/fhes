# FHES Engineering Rules (v0.1, P0–P2)
Single source of truth for AI-assisted development (Claude Code, Codex, ChatGPT or others).
## Authorization
Approved: isolated branch `chore/code-factory-p0-p2`; engineering documentation, deterministic checks, non-production tests, and staged core-data refactor where proved safe.
Forbidden until separately approved: merge to `main`, publishing/deploying, touching live/student data, deleting Firestore data, external sharing of credentials, expanding access.
## Default process
READ_RULES → UNDERSTAND_TASK → PLAN_SCOPE → CHANGE → RUN_CHECKS → FIX → EVIDENCE → PR/REPORT.
Keep patches small and changes tied to observed evidence; avoid speculative rewrites.
## System invariants
- Existing confirmed score, redemption, heart, and history semantics must remain intact unless user approves changing them.
- Pending/rejected order records must never count as confirmed score.
- Redemption must not reduce lifetime earned tally.
- Never calculate collection XP from group/member scores by naive multiplication.
- Imported records need stable IDs, version checks and reversible backups.
- Use pseudonymous identifiers in test fixtures; no real student data in repository/tests/logs.
- Treat browser IndexedDB as offline cache; it is NOT cross-device sync.
- Firestore is legacy in `index.html`; no new Firebase dependencies may be added.
- Target future storage: personal Google account OAuth and Google Sheets, with offline queue and explicit conflict handling; migration is NOT yet implemented.
- Custom collectible ID and tag ID must be immutable stable identifiers; rarity and special versions independent of tag names.
## Verification
`npm run verify` => HTML inline JavaScript syntax, legacy source-based score event tests, guardrails.
A green result does NOT prove UI, data migration, Google OAuth, or end-to-end workflows.
Whenever modifying scoring/backup, add negative and positive regression tests.
Record actual PASS / FAIL / BLOCKED / NOT_CONFIGURED / NOT_APPLICABLE without guessing.
Never silence a failing guardrail to fabricate green CI.
## Persistence and upkeep
`AGENTS.md` is the short AI entry; this document owns rules; `docs/ARCHITECTURE.md` maps modules.
Change rules by documenting rationale, date, affected tests and rollback.
A fresh AI session must be asked to read these files; persistence across AI platforms is not assumed.
