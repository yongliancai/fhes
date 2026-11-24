# Architecture Decisions — FHES
## ADR-001 — P0/P2 branch-based safety
2026-11-24; approved P0–P2. Only isolated branch engineering/test setup. No merge, deployment, or production data operations.
## ADR-002 — Retain v5.1 behavior as baseline
Previous development used Claude Code. Agent tooling does not change source of truth: GitHub `main` commit `44879bb` is observed baseline.
Keep old application unchanged until isolated tests can protect its semantics.
## ADR-003 — Future storage direction, not yet implemented
User wants Firebase/Firestore replaced by Google personal-account authorization + Sheets, while supporting offline work. Do not delete live Firestore data or erase migration path until approved and verified against backups.
## ADR-004 — Defer full framework rewrite
Existing app is single static HTML; no proof that introducing React/TypeScript or a backend improves initial safety. Use built-in Node test runner and GitHub Actions first.
