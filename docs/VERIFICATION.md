# Verification

## How to run
Node.js 20+ (CI: 22). Microsoft Edge (Windows) or Google Chrome installed for E2E.
```sh
npm ci
npm run verify      # syntax + import resolution, guardrails, ESLint, unit tests
npm run test:e2e    # real-browser tests; screenshots → test-results/
```
`E2E_CHANNEL=chrome|msedge|chromium` overrides the browser; `E2E_HEADED=1` shows it.

## Evidence log
| Date | Phase | Command | Environment | Result |
|---|---|---|---|---|
| 2026-11-24 | baseline | `npm run verify` (branch @ bc37eb9) | Windows 11, Node 22.23.1 | **FAIL** — guardrails `ENOENT C:\C:\…` (BUG-001) |
| 2026-11-24 | P2 | `npm run verify` | Windows 11, Node 22.23.1 | PASS — syntax, guardrails, ESLint, 30/30 unit |
| 2026-11-24 | P2 | `node --test e2e/legacy-v51.e2e.mjs` | Edge (playwright-core 1.56.1) | PASS 7/7 |
| 2026-11-24 | P2 | mutation: `isCounted = () => true` | same | unit 3 FAIL + E2E order-recording FAIL (guards effective); restored → PASS |

## Negative/positive checks
- Guardrails: Firebase SDK import, OAuth secret/token, innerHTML sink, impure core, ui import from core/sync, unmarked fixture → rejected; Sheets URL, plain word "Firebase", textContent, public client-ID text → accepted (`tests/guardrails.test.mjs`).
- ESLint `no-undef`/`no-unused-vars` cover the inline module of `index.html`.
