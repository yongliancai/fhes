# v6.2 學生系統：正式部署前的待辦與批准事項

狀態（2026-11-25）：只在本機與測試環境開發、測試。**沒有**連線 VPS、沒有建立任何雲端資源、沒有合併 main、沒有部署。下列每一項都需要使用者**另外明確批准**，由使用者或在使用者監督下執行。

## A. 需要批准的動作（BLOCKED：等待批准）

| # | 動作 | 目的 | 影響 | 風險 | 需要誰 |
|---|---|---|---|---|---|
| A1 | 提供 VPS 的非機密資訊：OS、Node 版本、可用記憶體與磁碟、nginx／CloudPanel／PM2 使用方式、現有站台清單 | 確認能跑 Node 22、argon2 與 better-sqlite3 的原生模組 | 無（只是資訊） | 無 | 使用者 |
| A2 | 申請子網域（例如 `fhes.<學校網域>`）＋ DNS ＋ TLS 憑證 | 學生頁面與 API 同源，Cookie 才能用 `__Host-`、`SameSite=Strict` | 新增一個網址 | DNS 設錯會影響其他網站 | 使用者／學校網管 |
| A3 | 在 VPS 建立獨立系統帳號與資料目錄（例如 `/srv/fhes-student`，權限 700） | 與現有站台隔離 | 新增帳號與目錄 | 權限設錯可能讀到其他站台 | 使用者 |
| A4 | 設定 nginx 反向代理（子網域 → `127.0.0.1:8790`），只代理這個子網域 | 對外提供 HTTPS | 修改 nginx 設定 | 設錯會讓現有網站中斷；先 `nginx -t` 並保留舊設定 | 使用者 |
| A5 | 設定 PM2（或 systemd）啟動 `node server/main.mjs` | 常駐、自動重啟 | 新增一個程序 | 記憶體用量（Argon2 每次 19 MiB） | 使用者 |
| A6 | 設定環境變數：`FHES_TEACHER_ALLOW`（允許的老師 email 或 `@學校網域`）、`FHES_DB_PATH`、`FHES_IP_SALT`（32 字元以上亂數，不進 Git）、`FHES_TEACHER_ORIGINS=https://yongliancai.github.io`、`FHES_STUDENT_ORIGINS=https://<子網域>`、`FHES_TRUST_PROXY=1` | 正式設定 | 無 | 亂數外洩只影響 IP 雜湊 | 使用者 |
| A7 | 每日備份 SQLite（`sqlite3 db .backup` 或停機複製）、加密、保留 30 天，並做一次還原演練 | 資料遺失可復原 | 新增排程 | 備份含學生姓名與分數：需加密、限制存取 | 使用者 |
| A8 | 把 `src/config.js` 的 `STUDENT_API_BASE` 設成正式網址並發布 GitHub Pages | 教師端出現「學生系統」 | 所有老師都會看到功能 | 需搭配 A9 | 使用者批准 commit＋合併＋發布 |
| A9 | 學校同意：學生姓名、分數、作業狀態存放在 VPS；家長告知 | 個資合規 | 流程 | 未同意前可用「只顯示座號」 | 使用者／學校 |
| A10 | 合併 `feat/v6.2-student` 到 `main` | 上線 | GitHub Pages 會更新教師端 | 見 C 回滾 | 使用者 |
| A11 | 真實 Google 帳號驗收（教師登入 → 換學生系統工作階段），在 `http://localhost:8765` 或測試網域 | 確認真實 Google ID token 在後端驗證成功 | 需要 OAuth 用戶端加入測試來源（如需要） | 變更 Google Cloud 設定需使用者自己操作 | 使用者 |

## B. 上線前檢查清單（批准後執行）

- [ ] `npm ci && npm run verify && npm run test:e2e` 在要部署的 commit 上全部通過（記錄到 `docs/VERIFICATION.md`）。
- [ ] VPS 上 `node -v` ≥ 22，`npm ci --omit=dev` 成功（argon2、better-sqlite3 有預編譯檔或可編譯）。
- [ ] `node server/main.mjs` 缺少任何設定時會拒絕啟動（已有單元測試；在 VPS 再確認一次）。
- [ ] 服務只監聽 `127.0.0.1`；防火牆不開放 8790。
- [ ] 回應標頭：HSTS、CSP、`X-Frame-Options: DENY`、`Cache-Control: no-store`（用 `curl -I` 確認）。
- [ ] `FHES_TRUST_PROXY=1` 時，nginx 必須覆寫 `X-Forwarded-For`（`proxy_set_header X-Forwarded-For $remote_addr;`），否則學生可以偽造 IP 繞過 IP 限流。
- [ ] 用兩個合成學生帳號在正式網域做一次：登入、改密碼、看資料、照顧 3 次、第 4 次不計入、登出。
- [ ] 跨班測試：兩位測試老師各一個合成班級，互相存取回 404。
- [ ] 確認稽核紀錄（`audit_events`）有寫入，且沒有密碼、token。
- [ ] 準備「忘記密碼」流程：老師在「學生系統」按「重設密碼」。

## C. 回滾

1. 教師端：把 `STUDENT_API_BASE` 改回空字串並發布 → 「學生系統」按鈕消失，v6.1 功能完全不受影響（教師資料從來不在後端）。
2. 後端：停止 PM2 程序、移除 nginx 子網域設定（還原備份的設定檔）。
3. 資料：SQLite 檔案保留（或依學校規定刪除）；裡面只有投影、帳號雜湊與照顧紀錄，不是教師資料的正本。
4. 備份相容：v6.2 的教師端備份格式沒有改（`dataVersion` 6）；班級多了 `studentSystem.nameMode` 欄位，v6.1 匯入時會忽略。

## D. 已知限制（上線前要讓使用者知道）

- SQLite 單機：適合一所學校（數百名學生）。
- 教師的學生系統工作階段 8 小時，比教師端登入（12 小時）短；到期後要登出再登入才能發布。
- 自動發布只在「這台電腦」勾選、而且這次登入已經手動發布過的班級才會執行。
- Safari／iPad、Firefox 上的學生頁面：自動測試只在 Chromium（Edge）執行過，真實裝置未驗證。
- 美術：學生園區目前使用原創 SVG；核准的 AI 圖合併後會自動使用（`src/data/art-manifest.js`）。
