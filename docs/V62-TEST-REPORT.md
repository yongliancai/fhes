# v6.2 學生系統：合成資料測試報告

日期：2026-11-25。分支：`feat/v6.2-student`。環境：Windows 11、Node 22.23.1、Edge 與 Chrome（playwright-core 1.56.1）。全部使用合成資料（`tests/helpers/v62-fixture.mjs`，`_synthetic: true`）。沒有連線 VPS、正式試算表或 Firebase。

## 1. 結果總表

| 項目 | 命令 | 結果 |
|---|---|---|
| 語法＋匯入、guardrails、ESLint、單元／整合測試 | `npm run verify` | **PASS**：169/169（v6.1 原有 117；v6.2 新增 52） |
| 瀏覽器 E2E（Edge） | `npm run test:e2e` | **PASS**：42/42（v6.1 原有 39；v6.2 新增 3） |
| 瀏覽器 E2E（Chrome，第二次獨立執行） | `E2E_CHANNEL=chrome npm run test:e2e` | **PASS**：42/42（在安全審查修正之前執行；修正後只重跑了 Edge） |
| 安全突變測試（把每個防護拿掉，確認測試會失敗） | 暫存複本上執行 | **18/18 被抓到**（一開始 17/18：「帳號已停用」的第二道檢查沒有單獨的測試，補上後抓到） |
| 獨立審查（架構、資安、測試） | 另一個沒看過程式的 agent 只讀審查 | 找到 9 項問題，**9 項都已修正**；6 項確認把修正拿掉測試會失敗（BUG-020…025） |
| Firefox、WebKit、真實 iPad Safari | — | **NOT_VERIFIED**（本機沒有；CI 相容性工作會在 PR 上執行） |
| 真實 Google 帳號換學生系統工作階段 | — | **BLOCKED**：需要部署好的 API 與使用者批准（`docs/STUDENT-DEPLOY-TODO.md` A11） |
| 正式 VPS 上的 Session 隔離 | — | **BLOCKED**：未批准連線 VPS |

## 2. 指令要求的驗收項目

| 要求 | 證據 | 狀態 |
|---|---|---|
| 兩組帳號 Session 隔離（合成） | `server-student`「IDOR」「session fixation…」；E2E 兩個不同的瀏覽器 context | PASS（本機伺服器） |
| 跨學生 100 次 IDOR | `server-student`「IDOR: 100 tampered requests…」：竄改 query、body、header、他組／他班動物，沒有任何回應含他人姓名或 ID，也沒有寫入任何照顧 | PASS |
| 同時餵食 100 次冪等 | `server-care`「100 simultaneous submissions…」：100 個不同 key → 剛好 3 次計入；同一 key 100 次 → 1 筆 | PASS |
| 教師錯權限發布 | `server-teacher`「class ownership…」：他班老師的列帳號、建立、重設、停用、發布、照顧彙總全部 404 | PASS |
| 弱密碼與限流 | 弱密碼 6 種被拒；5 次鎖定（含不存在的帳號）；同時 60 次最多驗證 5 次；IP 200 次 → 429 | PASS |
| v6.1 教師端完整回歸 | 原有 117 個單元測試與 39 個 E2E 全部通過，沒有修改它們的斷言（只在 `e2e/helpers.mjs` 加了可選的 `studentApi` 設定） | PASS |
| 401/403/404/429、Cookie 固定、CSRF、Session 輪替、登出、重設密碼後舊 Session 失效 | `server-student`（多項） | PASS |
| `unchecked ≠ missing`、`submitted ≠ done`、不發布愛心 | `student-projection` 單元測試＋E2E（「繳交：已交」和「訂正：待訂正」分開顯示） | PASS |
| 照顧不影響 XP、分數、收藏 | `server-care`「care never changes XP…」：照顧後重建的投影雜湊完全相同 | PASS |
| 換組、停用、撤銷物種 | `server-care`（多項） | PASS |
| XSS、CSP | E2E：含 `<img onerror>` 的姓名與 `<script>` 作業標題都以文字顯示、沒有執行；嚴格 CSP 下沒有違規 | PASS |
| 無障礙 | axe：登入、我的成長、小組園區沒有 serious/critical | PASS（Edge） |
| 手機版面 | 390×844：沒有橫向溢出；截圖 `test-results/v62-student-*.png` | PASS |

## 3. 開發過程發現並修正的問題

詳見 `docs/BUG-LOG.md`：
- BUG-018：學生初始密碼在教師端關閉對話框後仍留在 DOM。
- BUG-019：園區場景 `role="img"` 包住可按的動物（螢幕閱讀器讀不到）。
- BUG-020～025：獨立審查發現：重疊發布會回滾到舊版本、同時大量登入繞過鎖定、任何 Google 帳號都能成為老師、改寫簽章編碼的 ID token 可以重放、非 ASCII CSRF 標頭造成 500、不計入的照顧紀錄可以無限增加。
- 另外兩項小問題：「只顯示座號」改由後端強制；登入憑證不在教師頁面保留參考。

## 4. 剩餘風險

見 `docs/STUDENT-THREAT-MODEL.md`「剩餘風險」與 `docs/STUDENT-DEPLOY-TODO.md`「已知限制」。重點：
- 沒有 Argon2 全域並行上限（建議正式環境用 nginx `limit_req`）。
- 教師 Bearer 在頁面重新整理後，伺服器端仍有效到 8 小時（前端已拿不到）。
- 學生頁面只在 Chromium 驗證；Safari、iPad、Firefox 未驗證。
- 正式部署相關（TLS、反向代理、真實 IP、備份）全部還沒做，需要批准。
