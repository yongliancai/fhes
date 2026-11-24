# P0–P2 verification and remaining gates

## How to run on an isolated checkout
Node.js 20+ (CI: Node 22); no runtime npm dependencies.
```sh
npm run verify
```
This runs inline JavaScript parsing, regression guardrails, and Node built-in tests executing selected source-extracted production functions.

## Required positive/negative evidence
- Syntax check must parse the real `index.html` inline script.
- `tests/guardrails.test.mjs` intentionally includes forbidden new cloud SDK import and asserts it is rejected.
- The positive fixture uses Google Sheets URL and asserts it is accepted.
- `tests/score-events.test.mjs` exercises current confirmed/pending, spendable vs earned, heart lower bound and distinct group events.
- `tests/backup-contract.test.mjs` runs current production backup parser against synthetic records and rejects future versions.

## Remaining BLOCKED / NOT_CONFIGURED
- Browser E2E: no Playwright or screenshot baseline in this first batch.
- Google OAuth and Google Sheets: not implemented, not approved under P0–P2.
- Firestore-to-Sheets migration / live data cross-check: not approved; no production dataset accessed.
- Runtime IndexedDB import rollback and multi-tab conflict tests: not yet implemented.
- Fresh AI session rule reload: not verified.
- Full score module extraction: not yet implemented; production index remains unchanged.
- The CI workflow has no deploy job. A PASS cannot be interpreted as permission to merge/release.

## Release gate
P0–P2 work belongs in a separate branch. Do not merge to main or publish without a separate user decision. All real student records remain out of test fixtures and code.
