# 登入與資料隔離：架構與安全邊界（v6.1）

> Decisions: ADR-011, ADR-012 and ADR-013 in `docs/DECISIONS.md`. Every claim below is tested in a browser with **simulated** Google services (`e2e/auth.e2e.mjs`, `e2e/sync.e2e.mjs`) and in unit tests (`tests/auth.test.mjs`). It has **not** been run against real Google accounts; that is BLOCKED (see `docs/VERIFICATION.md`).

## 1. Two separate steps
| | Authentication (who is the teacher) | Authorization (may the app use Sheets) |
|---|---|---|
| Google component | GIS `google.accounts.id` (Sign in with Google) | GIS `google.accounts.oauth2.initTokenClient` |
| What we receive | ID token (JWT, about 1 h) | Access token (about 1 h) |
| Checked by | `src/auth/id-token.js`: signature (JWKS/kid, RS256), iss, aud/azp, exp/iat/nbf, nonce, sub | `src/sync/google-auth.js`: `drive.file` granted; userinfo `sub` equals the signed-in `sub` |
| Used for | choosing the account's local database; unlocking the UI | Google Sheets API calls only |
| Stored | nowhere. Only `{sub, email, name}` stay in memory | memory only; revoked on sign-out/switch |
| Lifetime | app session ≤ 12 h, ended by sign-out, switch, other-tab sign-out, expiry or reload | about 1 h; on expiry the teacher clicks "重新連線" and pending edits are kept |

The access token is never treated as an identity token, and the ID token is never sent to the Sheets API.

## 2. Flow
1. The page loads with the body class `locked`, so only the login screen shows. No account database is opened and no class data is rendered.
2. The teacher clicks "使用 Google 帳號登入", and GIS returns an ID token.
3. `verifyGoogleIdToken()` runs every check. Any failure keeps the app locked and shows the reason. Cancelling also keeps it locked.
4. `accountKey(sub)` gives the database `fhes-acct-<hash>`, which is then opened and rendered.
5. Optional cloud step: "連接 Google 試算表授權" starts the token client with `login_hint` set to the signed-in account. The app then checks the scope and that the userinfo `sub` matches, and enables sync.
6. Sign-out or switching account runs these steps in order:
   - stop sync and revoke the token
   - clear memory and remove every data screen and dialog from the DOM
   - `disableAutoSelect`
   - reload to a clean login page (if offline, the page stays locked and reloads when the network returns).

## 3. What is protected
- **Another teacher on the same browser** cannot see your classes through the app. Each account has its own database; the app opens only the signed-in account's database.
- **Forged, expired, replayed or other-app tokens** do not unlock the app. There is a negative test for each case.
- **Your cloud data:**
  - Sheets access is enforced by Google (`drive.file` and the sheet's sharing settings).
  - The app refuses a token granted for a different account.
  - The app refuses a spreadsheet the account cannot open, and does not fall back to another one.
- **Pending changes stay with their account.** Edits made by account A while offline stay in A's database and are only uploaded with A's token to A's sheet.
- **Tokens are not persisted:**
  - E2E scans localStorage, sessionStorage, every IndexedDB store, cookies, the URL, the console, backup files and the sheet.
  - Guardrails reject code that persists or logs credentials, or decodes JWTs without verifying them.

## 4. What is NOT protected (honest limits)
- **The local data is not encrypted.** The login screen is a gate in the browser, not a server. Someone who can use this computer, this browser profile and the developer tools can read the IndexedDB data without signing in.
- **No server-side session or audit log.** The app has no backend (see ADR-011 for why), so the sign-in check runs in the browser. It stops misuse of the normal UI, not someone who changes the page's code on their own machine.
- **Shared computers.** Sign out after use. Use "登出並移除這台電腦上此帳號的資料" if the computer is shared with people who should not have access, or give each teacher a separate OS account or browser profile.
- **Network required to sign in.** Reopening the app offline shows the login screen with "目前沒有網路". The data stays on the device, but nothing unlocks until Google is reachable. Without a service worker, a fully offline reload may not load the page at all.
- **Real Google behaviour is unverified:** consent screens, FedCM, popup blockers, `origin_mismatch`, Workspace admin policies, real JWKS rotation and real token lifetimes.

## 5. Data that exists before sign-in ("舊資料")
- **Where it lives:** the v5.1 or early v6 database `classroomPowerhouseV5`, or the v4 localStorage cache. It belongs to no account.
- **Never automatic.** It is not opened by the normal app path, not upgraded, and not assigned to whoever signs in.
- **What the teacher does:**
  1. Preview the class names and counts.
  2. Tick the classes that are theirs.
  3. The app downloads a full legacy backup first.
  4. The selected classes are **copied** into the account. Classes the account already has are skipped.
  5. "復原這次匯入" can undo the import.
- **Removing it** is a separate action: backup first, then two confirmations.
