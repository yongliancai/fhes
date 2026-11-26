# FHES AI Agent Entry

Short entry point for any AI agent (Claude Code, Codex, ChatGPT, …). This file is NOT guaranteed to auto-load on every platform — read it explicitly.

1. Read [docs/PROJECT-ENGINEERING.md](docs/PROJECT-ENGINEERING.md) (rules, invariants, authorization) before changing anything.
2. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module map, data stores, sync model) and [docs/DECISIONS.md](docs/DECISIONS.md).
3. Run `npm ci` then `npm run verify` (syntax, guardrails, ESLint, unit tests). Run `npm run test:e2e` for browser tests (uses the system Edge/Chrome).
4. Record results as PASS / FAIL / BLOCKED / NOT_CONFIGURED / NOT_APPLICABLE in [docs/VERIFICATION.md](docs/VERIFICATION.md); log bugs in [docs/BUG-LOG.md](docs/BUG-LOG.md).

## Hard limits (need separate, explicit user approval every time)
- Merge to `main`, publish to GitHub Pages or any production host, enable auto-merge / auto-deploy.
- Read, upload, change or delete real student data or the existing remote Firebase/Firestore data; disable the Firebase project.
- Create or change real Google Cloud / OAuth / Sheets resources, or the user's production spreadsheet.
- Commit secrets, OAuth client secrets, access tokens or real student names.

## Current authorization (2026-11-24, extended 2026-11-25)
The user authorized P2–P6 on the isolated branch `chore/code-factory-p0-p2` (Draft PR #1): engineering guardrails, homework, six-world collection/XP, replacing the front-end Firebase sync with Google Sheets, art/responsive work, and full testing — with synthetic data only. Stop at the Draft PR.
On 2026-11-25 the user also authorized required Google sign-in with per-account data isolation on the same branch/PR (simulated Google only; no real Google Cloud resources, hosting, merge or deployment). Security boundaries: `docs/AUTH-SECURITY.md`.
Later on 2026-11-25 the user provided a real OAuth Client ID and authorized a real Google acceptance run on `http://localhost:8765` with one test account, dedicated test spreadsheets and synthetic data (`docs/REAL-GOOGLE-ACCEPTANCE.md`). The user changes Google Cloud settings themself; agents only propose. On 2026-11-25 the user approved writing the Client ID into `src/config.js` and merging PR #1 into `main` (GitHub Pages publishes `main`). Any later merge or deployment needs a new approval.
On 2026-11-25 the user authorized v6.2 (student sign-in, minimal backend, student learning centre, group care) on the isolated worktree branch `feat/v6.2-student` with a Draft PR — synthetic data and local/test environments only. No VPS access, production resources, merge or deployment without a new approval (`docs/STUDENT-DEPLOY-TODO.md`).
