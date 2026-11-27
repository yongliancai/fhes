# FHES v6.2 多班級平台：P0 審查與開發方案

**狀態**：P0 只讀審查成果，等待使用者核准。本文件尚未 commit。
**日期**：2026-11-27
**依據**：《FHES v6.2 多班級平台完整更新計劃書》v1.0（以下簡稱「計劃書」），以及實際檢查程式、GitHub Actions 日誌與工作樹後得到的結果。
**注意**：《Claude Code 完整提示詞：多班級平台》沒有出現在這次上傳的檔案中，所以本方案只依計劃書與使用者訊息中的 10 點需求撰寫。

---

## 0. 結論摘要

1. **多班級最小改法：把現有的 `student_accounts` 改成「班級成員」**。
   - 現在 `student_accounts` 的每一列本來就等於「某人在某班的身分」。它已經有 `class_id`、`local_student_id`、`is_helper` 和 `status`。
   - 照顧紀錄 `group_care_events.account_id` 和小老師登記 `hw_registrations.helper_account_id` 都已經指到這一列，所以本來就是**每班獨立**：
     - 每日 3 次照顧
     - 小老師權限
     - 冪等鍵
   - 只要把「登入身分」（帳密、Google）拆到新的 `users` 表，讓一個 user 可以有多列成員資料，就能做到多班級。
   - **照顧、作業、XP、收藏、投影的表與純函式都不用改**。
   - 計劃書建議另建 `class_memberships`，再把舊的 `account_id` 對應過去。本方案改成「原表就地重建，保留原來的 id」。這樣舊資料不必搬家，外鍵也不用改寫。
2. **教師「自助開正式班」大部分已經存在**：`POST /api/teacher/classes` 本來就是老師自己連結本機班級。真正缺的是以下幾項：
   - 拿掉教師白名單的門檻，改成明確的設定開關
   - 開班與邀請的限流
   - 教師停權
   - 邀請碼
   - 加入申請與核准
3. **CI 失敗都已找到原因**。主要是測試環境的問題，但 Chrome 那一項可能是真正的手機版面錯誤（見 §3）。所以不能說「CI 全綠」。WebKit 在 v6.1 時就沒有全部通過。
4. 依現有程式審查，**計劃書有 4 處需要修正或補充**：
   - 教師重設密碼可能接管其他班
   - 舊版程式會直接打開新版資料庫
   - 未滿 18 歲的學校 Google 帳號預設登入不了第三方 App
   - OAuth 同意畫面的發布狀態

   細節見 §4。

---

## 1. 基準

| 項目 | 實際狀態（2026-11-27 檢查） |
|---|---|
| `main` | `173b73e`（合併 PR #1，v6.1）。GitHub Pages 已發布 |
| `feat/v6.2-student` | 本機與 origin 都是 `796b6fa`，和計劃書記載一致。Draft PR #2 |
| `feat/v6.2-art` | `997b65d`，和計劃書一致。工作樹 `fhes-v6.2-art` 沒有未提交改動。**本方案不碰這個工作樹** |
| 主工作樹 `fhes` | 分支 `feat/collection-art`，有未提交的 `docs/COLLECTION-ART-STATUS.md`（保留不動） |
| 本工作樹未提交改動 | `src/config.js` 是真實 Google 驗收用的暫時設定（`STUDENT_API_BASE='http://localhost:8790'`），**不會提交**。驗收結束或使用者要求時還原 |
| 驗收環境 | 本機教師頁 :8765、學生 API :8790（合成資料庫在 scratchpad）。原本的 Python 伺服器已暫停，上層 `.claude/launch.json` 有暫時新增的項目，原檔備份在 scratchpad |

---

## 2. 現有功能完成狀態

| 功能 | 狀態 | 證據與備註 |
|---|---|---|
| v6.1 教師 Google 登入、每個帳號一個 IndexedDB（`fhes-acct-<SHA256(sub)>`）、Google 試算表同步 | 已上線（main） | PR #1 合併；CI 當時 Chrome、Firefox 通過，WebKit 有 1 項失敗（test 30） |
| 後端：Fastify＋SQLite＋Argon2id、HttpOnly Cookie、CSRF、Origin、限流、帳號鎖定、稽核 | 完成（v6.2 分支） | `server/src/app.mjs`、`tests/server-*.test.mjs` |
| 教師 ID token 後端驗簽、防重放、白名單（email 或 @網域） | 完成 | BUG-022、BUG-023 |
| 學生投影（每生只看自己；不含愛心）、版本單調、hash 冪等 | 完成 | `src/core/student-projection.js`、BUG-020 |
| 帳號發放（初始密碼只顯示一次）、首次登入改密碼、重設、停用 | 完成 | E2E test 38 |
| 小組園區、照顧（每生每日 3 次，不影響 XP） | 完成 | `src/core/care.js`、`tests/server-care.test.mjs` |
| 4 個作業按鈕、逾期自動愛心、小老師登記與收件匣 | 完成 | 796b6fa；BUG-027～030 |
| 圖鑑與美術回退（SVG） | 完成；美術素材在 PR #3 另外進行 | `src/student/*`、`tests/student-art.test.mjs` |
| `npm run verify`（本機） | 196/196 PASS | 2026-11-26 |
| 本機 E2E（Edge） | 45/45 PASS | 2026-11-26 |
| **GitHub Actions** | **FAIL** | 見 §3 |
| 真實 Google 交換 token | **NOT_VERIFIED**：環境已架好，等使用者登入 | 本機 :8765／:8790 |
| 實體 Safari、iPad、正式 VPS | NOT_VERIFIED | — |
| 多班級、Google 學生登入、邀請碼、加入申請 | **沒有實作** | 本方案 |

---

## 3. GitHub Actions 失敗根因（796b6fa，run 45784258802）

| Job | 結果 | 失敗項目 | 根因 | 分類 |
|---|---|---|---|---|
| verify | PASS | — | — | — |
| e2e（Chrome） | 44/45 | test 39「student zoo…mobile layout fits」 | 點「作業」分頁時，`.stu-card` 擋住了點擊（`subtree intercepts pointer events`）。分頁列在手機寬度是 `position: fixed` 貼在底部。在 Linux Chrome 的手機模擬下，內容卡片蓋在分頁列上面。test 38 的同一個點擊有通過，差別是 test 39 有很長的惡意字串姓名。 | **可能是真的手機版面錯誤**。要用 CI 的 trace 和截圖確認。E2E_DIAG 的 artifact 需要登入 GitHub 才能下載 |
| e2e-compat（Firefox） | 42/45 | test 38、39、40 | `browser.newContext: options.isMobile is not supported in Firefox`。測試程式在 Firefox 也傳了 `isMobile`。 | 測試程式錯誤。修法：只在 Chromium 和 WebKit 傳 `isMobile`。Firefox 照樣用 390×844 視窗檢查版面，不刪任何斷言 |
| e2e-compat（WebKit） | 39/45 | test 38、39、41：登入改密碼後 `.stu-stats` 沒有出現。test 40：等不到小老師分頁。test 4、10（v6.1 認證）：頁面被關閉或逾時 | 學生測試：測試伺服器用 `http://127.0.0.1`，Cookie 是 `__Host-` 加 `Secure`。Linux 上的 Playwright WebKit 不會在 http 的 localhost 保存 Secure Cookie，所以登入後下一個請求沒有工作階段（**推測，要用 trace 驗證**）。test 4、10：WebKit 在 Linux 上不穩定，v6.1 時 WebKit 就有 test 30 失敗 | 測試環境。修法：**WebKit 的學生 API 測試改用自簽 HTTPS**，保留 `__Host-`／Secure 斷言，**不可以為了通過而關掉 Secure**。test 4、10 用 trace 判斷。如果是 WebKit 本身崩潰、和程式無關，就標成 BLOCKED 並附證據，不刪測試 |

另外：
- `feat/v6.2-art` 的 CI 也失敗（run 45783797745）。它不在本次範圍，請在 PR #3 另外處理。
- 上一次 v6.2 的 CI（0c3778c）三個 E2E job 也全部失敗，所以 **v6.2 分支從第一次 CI 就沒有通過**。

---

## 4. 計劃書交叉審查（五個角度）

### 4.1 系統架構師
- **採用**：
  - 平台身分和班級成員分開
  - 學生 API 的路徑帶 classKey，由後端驗證成員資格
  - 舊 API 短期相容
- **修正**：不另建 `class_memberships`。改成就地重建 `student_accounts` 為成員表，保留表名和 id，讓照顧與小老師的外鍵不用改（§6）。計劃書 ADR-028 要求「改成 per membership」，在這個做法下**已經成立**。
- **修正**：計劃書寫的 `join_requests` 採用，但「待審」不放進成員表。這樣成員表永遠有 `local_student_id`，可以保留 `UNIQUE(class_id, local_student_id)` 這類限制。
- **補充**：`openDb()` 遇到比程式還新的 `user_version` 時不會拒絕。部署 v3 後如果回滾到 v2 程式，舊程式會直接用 v3 資料庫，造成資料錯亂。P1 要先加上「資料庫版本比程式新就拒絕啟動」。

### 4.2 資安專家
- **教師重設密碼可能接管帳號（計劃書沒有寫到的高風險）**：
  - 情境：甲老師發的帳號，學生之後加入乙老師的班。
  - 甲老師按「重設密碼」就拿到新的初始密碼，可以登入看乙班的資料。
  - 規則：**只有當這個帳號的所有有效成員資格都在同一位老師的班上時，才可以重設**。否則改成「移出本班，再發一個新帳號」，或請學生用 Google 登入（待決定 D3）。
- **邀請碼只能產生「申請」**，不給任何資料，也不顯示名冊。
- **綁定本機學生紀錄的權限只在老師手上**：老師在核准畫面自己選學生。學生填的姓名、座號只是參考，不能用來自動配對。
- **教師開放註冊**：
  - 不能只刪掉白名單，要用新的設定 `FHES_TEACHER_SIGNUP=open` 明確開啟，預設仍是 allowlist。
  - 開放後要有：開班、邀請、申請的限流、教師停權（管理用 CLI）和稽核。
- **Google 學生登入**：
  - 學生頁的 CSP 要允許 `accounts.google.com/gsi`（script、frame、connect、style），用設定開關控制，預設關閉。
  - 綁定和解除綁定都要「最近 10 分鐘內重新驗證過」。同一個 Google `sub` 已經屬於別的 user 時拒絕，不合併。
- **外部條件（需要使用者或學校處理）**：
  - Google Workspace for Education 預設**不讓未滿 18 歲的帳號登入沒有設定過的第三方 App**。要學校管理員把本 App 設成信任，否則學生 Google 登入一定失敗。
  - 一般 Family Link 兒童帳號也有限制。
  - 所以帳密登入必須永遠可用。
- **OAuth 同意畫面**：如果目前是「測試中」（只有列出的測試使用者能登入），或是「內部」（只限網域），「任何 Google 帳號都能註冊教師」在 Google 那一端就會失敗。要由使用者在 Google Cloud 檢查或變更（待決定 D5）。

### 4.3 資料庫工程師
- **SQLite 重建資料表的限制**：
  - 要先在交易**外面** `PRAGMA foreign_keys=OFF`，交易內重建、改名，`PRAGMA foreign_key_check` 沒有問題才 COMMIT，最後再打開外鍵。
  - 現在的 migration runner 把每一步都包在 transaction 裡，要加一種「需要關外鍵」的特殊步驟。
- **user id 用固定規則推導**（`s_xxx` → `u_xxx`、`t_xxx` → `u_t_xxx`）：重跑結果一樣，也方便對帳。
- **教師身分不用 sub 原文**：`teachers.account_hash` 已經是 `SHA256(iss|sub)`，直接成為 `auth_identities.subject_hash`。
- **對帳項目**：遷移前後以下各項的筆數與雜湊要相同：
  - 帳號數
  - 每班成員數
  - 照顧事件
  - 小老師登記
  - 投影
  - 稽核數
- **回滾**：保留遷移前的加密備份（`server/backup.mjs` 已有）。v2 程式不能開 v3 資料庫（4.1 的保護）。

### 4.4 前端設計師
- **學生端**：
  - 登入後先看「我的班級」：
    - 0 班顯示「加入班級」
    - 1 班直接進入
    - 2 班以上在頂部切換
  - 切換班級時：
    - 清空畫面
    - 用 request generation 丟掉晚到的舊回應
    - 不寫 localStorage 或 sessionStorage（維持現在 E2E 的「瀏覽器沒有任何資料」斷言）
- **QR Code**：
  - 內容是 `https://<學生站>/student.html#join=<代碼>`。用 fragment，所以代碼不會出現在伺服器紀錄和 Referer 裡。
  - 手機相機直接打開網址就好，**學生頁不需要相機掃描功能**。
  - 讀到代碼後用 `history.replaceState` 從網址列清掉。
- **教師端**：學生系統視窗新增三塊：
  - 「邀請」：代碼、QR、到期日、撤銷
  - 「加入申請」：每筆申請用下拉選單選本機學生，選單只列出還沒綁定的學生
  - 「個別綁定碼」：和現在的帳號單一樣可以列印
- **QR 產生**：CSP 是 `script-src 'self'`，不能用 CDN。要把一個 MIT 授權的小型 QR 編碼器放進 `src/vendor/`，授權記在 `ASSET-LICENSES.md`。
- **手機分頁列**：§3 Chrome 失敗如果是真的版面錯誤，P1 要先修好，因為多班級切換列也會放在同一區。

### 4.5 測試工程師
- 本機 PASS 不代表 CI PASS。每個階段的 Gate 都包含 **CI 三個瀏覽器的實際結果**；失敗就是 NO-GO 或 BLOCKED。
- 新增：
  - 遷移測試：用真實結構的合成 v2 資料庫，跑「重跑」「中途失敗」「對帳」「v2 程式拒開 v3」
  - 越權測試：100 次跨班、跨老師竄改
  - 邀請碼爆破與限流
  - 兩位老師使用同一個 localClassId
  - 同一個學生在 3 個班：照顧 3+3+3、小老師只在 A 班
  - 退出或移除後立即失效
  - 舊路徑相容
- 沿用現有：
  - 外洩掃描（回應不含 score、heart、他班姓名）
  - XSS 字串
  - CSP 違規偵測
  - axe 無障礙檢查

---

## 5. 差異表（現況 → 目標）

| 面向 | 現況（v6.2 SCHEMA 2） | 目標（v3） | 改動量 |
|---|---|---|---|
| 登入身分 | `student_accounts`（一個帳號＝一班） | `users`、`password_credentials`、`auth_identities` | 新表 |
| 班級成員 | `student_accounts` 一列 | 同一表就地重建：加 `user_id`，帳密欄位移走，`UNIQUE(class_id,user_id)` | 重建 1 表，id 不變 |
| 照顧每日 3 次 | 以 `account_id` 計（＝每班） | 不變（`account_id` 就是成員 id） | 0 |
| 小老師 | `is_helper` 在帳號列（＝每班） | 不變 | 0 |
| 小老師登記 | `helper_account_id` | 不變 | 0 |
| 學生投影、小組投影 | 以 `(class_id, local_student_id)` 為鍵 | 不變 | 0 |
| 學生 Session | `subject_id`＝帳號 id | `subject_id`＝user id，升級時撤銷所有學生 Session | 小 |
| 學生 API | `/api/student/dashboard` 等（隱含單一班） | `/api/student/classes/:classKey/...`；舊路徑在「只有 1 班」時相容 | 中 |
| 教師資格 | `FHES_TEACHER_ALLOW` 必填 | `FHES_TEACHER_SIGNUP=allowlist`（預設）或 `open`；`teachers.status` 可停權 | 小到中 |
| 開班 | `POST /api/teacher/classes`（已是自助） | 加上每日開班上限、停權檢查 | 小 |
| 邀請、申請、綁定碼 | 無 | 3 張新表、8 支 API | 中 |
| 學生 Google 登入 | 無 | 設定開關、CSP、綁定與解除 | 中 |
| 教師端 IndexedDB 與試算表 | 每帳號隔離 | **不變** | 0 |
| 作業、XP、收藏、照顧純函式 | — | **不變** | 0 |

---

## 6. 資料庫 v2 → v3 設計（SQL 草案）

```sql
-- migration v3（需要關閉外鍵的特殊步驟：runner 在交易外 PRAGMA foreign_keys=OFF，
--   交易內執行下列，PRAGMA foreign_key_check 為空才 COMMIT，之後 foreign_keys=ON）
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  subject_hash TEXT NOT NULL,                 -- SHA-256(iss|sub)，不存 sub/email 原文
  created_at INTEGER NOT NULL, last_used_at INTEGER,
  UNIQUE (provider, subject_hash)
);
CREATE TABLE password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1 CHECK (must_change IN (0,1)),
  issued_by_class_id TEXT REFERENCES classes(id),   -- 哪一班的老師發的（重設權限判斷用）
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE teachers ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'));
ALTER TABLE teachers ADD COLUMN signup TEXT NOT NULL DEFAULT 'allowlist' CHECK (signup IN ('allowlist','self'));
ALTER TABLE classes  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'));

-- student_accounts 就地重建為「班級成員」（表名與 id 保留 → group_care_events / hw_registrations 外鍵與資料不動）
CREATE TABLE student_accounts_v3 (
  id TEXT PRIMARY KEY,                         -- 舊 s_xxx 原樣保留
  class_id TEXT NOT NULL REFERENCES classes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  local_student_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','left','removed')),
  is_helper INTEGER NOT NULL DEFAULT 0 CHECK (is_helper IN (0,1)),
  joined_via TEXT NOT NULL DEFAULT 'teacher' CHECK (joined_via IN ('teacher','claim','invite')),
  last_login_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (class_id, user_id)
);
-- 同一班同一位本機學生只能綁一個有效成員（移除／退出後可由老師再綁）
CREATE UNIQUE INDEX member_local ON student_accounts_v3 (class_id, local_student_id) WHERE status IN ('active','disabled');

INSERT INTO users (id, status, created_at, updated_at)
  SELECT 'u_' || substr(id, 3), 'active', created_at, updated_at FROM student_accounts;
INSERT INTO password_credentials (user_id, username, password_hash, must_change, issued_by_class_id, created_at, updated_at)
  SELECT 'u_' || substr(id, 3), username, password_hash, must_change, class_id, created_at, updated_at FROM student_accounts;
INSERT INTO student_accounts_v3 (id, class_id, user_id, local_student_id, status, is_helper, joined_via, last_login_at, created_at, updated_at)
  SELECT id, class_id, 'u_' || substr(id, 3), local_student_id, status, is_helper, 'teacher', last_login_at, created_at, updated_at FROM student_accounts;
INSERT INTO users (id, status, created_at, updated_at) SELECT 'u_t_' || substr(id, 3), 'active', created_at, created_at FROM teachers;
INSERT INTO auth_identities (id, user_id, provider, subject_hash, created_at)
  SELECT 'ai_t_' || substr(id, 3), 'u_t_' || substr(id, 3), 'google', account_hash, created_at FROM teachers;
UPDATE teachers SET user_id = 'u_t_' || substr(id, 3);
DROP TABLE student_accounts;
ALTER TABLE student_accounts_v3 RENAME TO student_accounts;
UPDATE sessions SET revoked_at = strftime('%s','now') * 1000 WHERE kind = 'student' AND revoked_at IS NULL;

CREATE TABLE class_invitations (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  code_hash TEXT NOT NULL UNIQUE,              -- HMAC(server pepper, code)；代碼原文只在建立時回傳一次
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER
);
CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  invitation_id TEXT REFERENCES class_invitations(id),
  display_name TEXT NOT NULL,                  -- 學生自己填（≤20 字，只供老師參考，不可信）
  seat_hint INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  member_id TEXT REFERENCES student_accounts(id),
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE UNIQUE INDEX join_pending ON join_requests (class_id, user_id) WHERE status = 'pending';
CREATE TABLE claim_codes (                       -- 個別綁定碼：老師印給特定學生，一次性
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  local_student_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, used_by_user_id TEXT REFERENCES users(id), revoked_at INTEGER
);
CREATE TABLE platform_admins (                   -- D3a：本版只有使用者本人一位
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),   -- 之後加 'school_admin' 與 scope
  scope TEXT,                                    -- 預留：學校範圍（本版一律 NULL）
  created_at INTEGER NOT NULL
);
CREATE TABLE password_reset_requests (           -- 老師替忘記密碼的學生送出，管理員核准
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES student_accounts(id),
  requested_by TEXT NOT NULL REFERENCES teachers(id),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX reset_pending ON password_reset_requests (member_id) WHERE status = 'pending';
-- sessions.kind 的 CHECK 加入 'admin'（sessions 表同樣在這個步驟重建）
-- 索引：sessions_subject、hwreg_*、care_group 原樣保留；新增 student_accounts(user_id)、join_requests(class_id,status)
```

**P0 乾跑（2026-11-27）**：在記憶體中，用 v2 程式建立的合成資料庫（2 位老師、2 個班，兩班使用相同的 localClassId；帶照顧紀錄、小老師登記與學生 Session）執行上面的 SQL，結果：

- `foreign_key_check` 沒有問題，成員 id 保留不變。
- 帳密、`issued_by_class_id` 和老師的身分雜湊都正確搬過去。
- 照顧與登記的筆數不變，舊 Session 已撤銷。
- `group_care_events` 的外鍵仍指向重建後的 `student_accounts`，新成員可以寫入照顧紀錄；指向不存在成員的寫入會被外鍵擋下。
- 同一班重複綁定同一位本機學生會被唯一索引擋下。

這只證明 SQL 能執行，不是正式的遷移測試；正式測試在 P1 補齊。

**遷移步驟**

1. 遷移前自動建立加密備份（`server/backup.mjs`）。
2. `foreign_keys=OFF`，在一個交易內完成上面的 SQL。
3. `foreign_key_check` 必須沒有問題。
4. 對帳：
   - 帳號數 = users（學生）= credentials = 成員數
   - 照顧與登記的筆數、雜湊都不變
5. COMMIT，然後 `foreign_keys=ON`。

**失敗處理**：任何一步失敗就整個回滾，資料庫保持 v2。

**測試要求**：同一個 v2 檔案遷移兩次的結果相同；在第 2～4 步中途中斷後再跑也能成功。

**不做**：不用姓名、Email、座號合併任何兩個帳號。

**另外加一項保護**：資料庫版本大於程式版本時，`openDb` 拒絕啟動。

---

## 7. API 變更

**P1 實作時的調整（2026-11-27）**：學生端路徑改用 `/api/student/classes/{memberId}/…`，不用 classKey。memberId 是「我在這一班的代號」，也就是自己的成員 id。原因是學生端的回應一向不含 classKey，既有的安全測試也要求這一點。以下表格中學生端的 `:classKey` 都改成 `:memberId`。

**P1 的分批**：v3 migration 只包含身分與成員資格。邀請、申請、綁定碼、管理員、重設申請等資料表放在 P2 的 v4 migration，這樣每個階段可以分開驗收。

**原則**：

- 存取哪一位學生、哪一個小組，一律由 Session 的 user 加上資料庫中的成員資格推出來。**body 和 query 永遠不接受 studentId、localStudentId、groupId 作為權限依據**。
- 不屬於自己的班一律回 404，不透露班級是否存在。

| 路由 | 誰 | 說明 |
|---|---|---|
| `POST /api/student/login` | 匿名 | 不變；改查 `password_credentials` |
| `POST /api/student/google` | 匿名（開關打開時） | Google ID token 登入；身分不存在時建立新 user（沒有任何班級）；限流 |
| `POST /api/student/identities/google` | 已登入，10 分鐘內重新驗證過 | 綁定 Google；`sub` 已屬於別人就回 409，不合併 |
| `DELETE /api/student/identities/google` | 同上 | 解除；至少要留一種登入方式 |
| `GET /api/student/me` | 已登入 | 加上 `classes:[{classKey,name,helper}]`，只列有效成員資格，不含名冊 |
| `GET /api/student/classes/:classKey/{dashboard,homework,zoo,helper}` | 該班有效成員 | 沿用現有的處理函式（成員列的欄位和舊帳號列相同） |
| `POST /api/student/classes/:classKey/{care,helper/register}` | 該班有效成員或小老師 | 同上，加上 CSRF 和 Origin |
| `POST /api/student/join` | 已登入 | `{code, displayName, seatHint?}` 送出申請；只回「已送出，等老師確認」和班級名稱；限流加冪等 |
| `POST /api/student/claim` | 已登入 | `{code}` 個別綁定碼，一次性，綁成該班該生 |
| `POST /api/student/classes/:classKey/leave` | 該班成員 | 退出，立即失效 |
| 舊 `/api/student/{dashboard,…}` | 已登入 | 只有 1 個有效班時照舊；多班回 409 `choose_class` |
| `POST /api/teacher/session` | 匿名 | allowlist 模式照舊；open 模式下所有 `email_verified` 的帳號都可以，但 `teachers.status='suspended'` 回 403 |
| `POST /api/teacher/classes` | 老師 | 加上每日開班上限 |
| `POST/GET /api/teacher/classes/:k/invitations`、`POST …/:id/revoke` | 該班老師 | 代碼只在建立時回傳 |
| `GET /api/teacher/classes/:k/join-requests` | 該班老師 | 只回 display_name、seat_hint、時間 |
| `POST …/join-requests/:id/approve {localStudentId}`、`…/reject` | 該班老師 | 交易內建立成員資格；該本機學生已綁定就回 409 |
| `POST /api/teacher/classes/:k/claim-codes {students:[…]}` | 該班老師 | 產生可列印的綁定碼，只顯示一次 |
| `POST /api/teacher/classes/:k/accounts/:id/remove` | 該班老師 | 移出本班；不刪除 user，不影響別班 |
| `…/accounts/:id/reset` | 該班老師 | **只在「等待首次登入」時可用**：帳密是本班發的，而且還沒有人用它登入過（D3）。其他情況回 403，並引導老師送出「重設申請」 |
| `POST /api/teacher/classes/:k/accounts/:id/reset-request` | 該班老師 | 學生忘記密碼又沒有綁 Google 時，替本班學生向管理員送出申請（只帶班級和成員 id，沒有其他個資） |
| `POST /api/student/password/google-reset` | 已用 Google 登入的學生 | 綁過 Google 的學生，用 Google 登入後直接設定新密碼。撤銷這個帳號其他所有 Session |
| `POST /api/admin/session` | 管理員 | Google ID token 驗簽；身分必須在 `platform_admins` 裡 |
| `GET /api/admin/reset-requests`、`POST …/:id/approve`、`…/reject` | 管理員 | 核准後產生一次性初始密碼，只顯示一次，學生登入後必須改密碼；撤銷該帳號所有 Session；記入稽核 |
| `GET /api/admin/teachers`、`POST …/:id/suspend`、`…/unsuspend` | 管理員 | 教師停權，並撤銷 Session |
| `server/admin.mjs` | 主機（CLI） | 只在網頁管理壞掉時作為備援 |

**限流預設值**（可調整）：

| 項目 | 預設 |
|---|---|
| 每位老師每天開班 | 10 |
| 每班同時有效的邀請 | 3 |
| 邀請到期 | 7 天 |
| 每班待審申請 | 100 |
| 加入或綁定碼輸入錯誤 | 每個 user 10 次／15 分鐘，每個 IP 50 次／15 分鐘 |
| Google 學生註冊 | 每個 IP 每小時 30 次 |

**代碼格式**：10 碼，從 31 個不易混淆的字元中選，約 2^49 種組合。

---

## 8. 前端變更

| 檔案 | 改動 |
|---|---|
| `src/student/student-app.js`、`student.css` | 新增「我的班級」與切換列、加入班級（代碼或 `#join=`）、綁定碼輸入、Google 登入按鈕（開關控制）、待審提示；所有 API 改用 `classes/:classKey/` 路徑；request generation；修好手機分頁列被擋住的問題 |
| `src/ui/student-admin-ui.js` | 新增「邀請」（QR）、「加入申請」（選本機學生後核准）、「綁定碼」（列印）、「移出本班」；重設密碼依後端回應顯示原因 |
| `src/sync/student-api.js` | 新增對應的方法 |
| `src/vendor/qr.js`（新增） | MIT 授權的 QR 編碼器，授權記在 `ASSET-LICENSES.md` |
| `server/src/db.mjs`、`app.mjs`、`server/main.mjs`、`server/admin.mjs`（新增）、`server/backup.mjs` | §6、§7 |
| **不改** | `src/core/{homework,hw-helper,hw-hearts,xp,collection,care,score,student-projection}.js`、`src/data/catalog.js`、v6.1 同步、`index.html` 的教師資料邏輯、美術 pipeline |

---

## 9. 新增威脅（接在 T23 後面）

| # | 威脅 | 對策 | 測試 |
|---|---|---|---|
| T24 | 跨班 IDOR：用自己的 Session 加上別班的 classKey | 成員資格查詢；不符合就回 404 | 100 次隨機竄改（classKey、body 多帶欄位） |
| T25 | 用邀請碼冒認同學的紀錄 | 邀請碼只產生申請；綁定由老師選，或用一次性個別綁定碼 | 申請回應不含名冊；未核准不能讀任何資料 |
| T26 | 爆破邀請碼或綁定碼 | 2^49 種組合、HMAC 存放、user 與 IP 雙重限流、可撤銷、會到期 | 爆破測試觸發 429；撤銷或到期後回 404 |
| T27 | 老師重設密碼接管別班 | D3：老師只能重發「還沒登入過」的帳號；其他情況要由管理員核准，留下稽核，並撤銷所有 Session | 已登入過的帳號由老師重設 → 403；老師的申請未經核准不會改變任何東西 |
| T34 | 管理員帳號被盜或越權 | 只有 `platform_admins` 裡的身分能用（本版只有使用者本人一位）；管理 API 只用 Bearer，不用 Cookie；每個動作都留稽核；管理員 Session 4 小時後失效 | 非管理員回 403；管理員名單外的 Google 帳號回 403 |
| T28 | Google 身分接管或合併 | `sub` 唯一；綁定要重新驗證；不用 Email 合併 | 同一個 sub 綁第二個 user → 409 |
| T29 | 惡意自助教師（大量開班或邀請、釣魚） | 限流、停權 CLI、稽核；班級名稱只當文字顯示 | 配額測試、停權後 Session 失效 |
| T30 | 切換班級後舊回應晚到，顯示錯班資料 | request generation；切換時清空畫面 | E2E 模擬延遲回應 |
| T31 | 退出或移除後仍可存取 | 每次請求都查成員資格 | 移除後下一個請求回 404 |
| T32 | 遷移失敗留下半套資料，或舊程式打開新資料庫 | 單一交易＋FK 檢查＋對帳；版本保護 | 中斷、重跑、v2 程式開 v3 資料庫被拒 |
| T33 | 兒童個資過度蒐集 | 不存 Email 或 sub 原文；display_name ≤20 字；申請 30 天後清除 | 資料表掃描 |

---

## 10. P1～P5 工作包

每個階段結束都要輸出：改動檔案清單、測試證據（PASS/FAIL/NOT_VERIFIED/BLOCKED）、風險，以及是否通過 Gate。

### P1：CI 修復＋身分與成員資料層（先做 CI）
1. **CI**：
   - Firefox：`isMobile` 只在 Chromium 和 WebKit 傳。
   - WebKit：學生 API 測試伺服器改用自簽 HTTPS。
   - Chrome test 39：用 trace 重現，修版面（如果是真的錯誤），記成 BUG-031。
   - WebKit test 4、10：用 trace 判斷原因。
   - 推上去看實際 CI 結果。
2. `openDb` 加上版本保護；migration runner 支援「需要關外鍵」的步驟。
3. v3 遷移（§6）；`password_credentials` 登入；Session 改為 user。
4. 成員驗證 middleware；學生 API 改成 `classes/:classKey/` 路徑，加上舊路徑相容層。
5. **測試**：
   - 遷移：重跑、中斷、對帳、v2 拒開 v3
   - 跨老師使用同一個 localClassId
   - 不會自動合併
   - 既有的 server、E2E 測試全部通過
- **Gate**：資料契約測試 PASS；舊帳號登入、改密碼、照顧、小老師功能沒有倒退；**CI 三個瀏覽器的結果寫清楚**（或附 BLOCKED 證據）。

### P2：教師自助開班與邀請
1. `FHES_TEACHER_SIGNUP` 開關、`teachers.status`、停權 CLI、開班限流。
2. 邀請（建立、列出、撤銷）、加入申請（列出、核准、拒絕）、個別綁定碼、移出本班。
3. 重設密碼新規則（D3）：
   - 老師只能重發「還沒登入過」的帳號。
   - 其他情況由老師送出重設申請。
   - 管理網頁（`admin.html`，只有 `platform_admins` 能用）：處理重設申請、教師停權、查看稽核。
   - 綁過 Google 的學生可以自己重設密碼（放在 P3）。
4. 教師端 UI：邀請與 QR、申請審核、綁定碼列印。
5. **測試**：
   - token 重放
   - 邀請碼爆破
   - 跨老師核准（乙老師核准甲班 → 404）
   - 冒用 localStudentId
   - 停權後 Session 失效
   - 撤銷與到期
   - 同時核准的競爭
- **Gate**：靠 Email、網域或邀請碼都拿不到別人班級的權限。

### P3：學生多班介面與 Google 登入
1. 我的班級、切換、加入、綁定碼、退出；request generation；空狀態與待審狀態。
2. Google 登入與綁定、解除（開關預設關閉）；學生頁 CSP 依開關放寬。
3. **測試**：
   - 多班切換加上延遲回應
   - 兩個裝置、兩個帳號
   - Google 不可用時用帳密
   - 改密碼不影響其他班的成員資格
   - 共用裝置登出後看不到任何資料
- **Gate**：從別班的畫面讀不到任何個資或快取。

### P4：作業、小老師、養成的班級範圍整合
1. 驗證照顧、小老師、收件匣在多班下的行為（預期幾乎不用改程式，以測試為主）。
2. 投影發布時，成員移除不影響投影；被移出的學生看不到。
3. **測試**：
   - A、B、C 三班的分數、作業、XP、收藏完全不同
   - 照顧 3+3+3
   - 小老師只在 A 班有效，在 B 班回 404
   - 重送冪等
   - 退出後失效
   - 換組
   - 老師的修改優先
- **Gate**：同一位學生在 3 個班，資料與權限完全獨立。

### P5：獨立安全審查與交付
1. 獨立子代理只讀審查（與 v6.2 相同的流程）；修正並補上回歸測試。
2. 壓力與安全測試：
   - 100 次 IDOR
   - 100 次並發照顧
   - 邀請限流
   - 兩位老師的班名相同
   - 備份還原
   - XSS、CSRF、SQL injection
   - CSP
   - 手機無障礙檢查
3. **真實 Google 驗收**（使用者同意的測試帳號、合成資料）：教師交換 token、自助開班、邀請到核准、學生 Google 登入（如果學校已設定信任）。
4. 交付：
   - 測試報告
   - 剩餘風險
   - 遷移驗證
   - 部署前檢查表
   - 回滾演練（在本機合成資料上）
- **Gate**：CI 三個瀏覽器 PASS，或附原因的 BLOCKED；實體 Safari、VPS 標記 NOT_VERIFIED。

### P6：部署（不在授權範圍，只列出）
VPS、TLS、反向代理、DNS、真實資料匯入、合併 main，每一項都要另外取得核准。

---

## 11. 需要使用者決定或核准的事項

| # | 事項 | 建議 |
|---|---|---|
| D1 | 核准本方案，授權 P1～P5：改程式、測試、commit、push 到功能分支、Draft PR | — |
| D2 | 開發分支 | 從 `feat/v6.2-student` 開新分支 `feat/v6.2-multiclass`，放在新的工作樹，另開 Draft PR。這樣 PR #2 保持可以單獨審查 |
| D3 | 重設密碼 | **已決定（2026-11-27）**：<br>・學生自己改密碼。<br>・老師**不能**重設，只能重發「還沒登入過」的帳號。<br>・忘記密碼時，綁過 Google 的學生用 Google 登入後自己重設；沒綁的由老師送出申請，管理員核准後重設。 |
| D3a | 管理員 | **已決定**：<br>・本版只有使用者本人的 Google 帳號（部署時用設定指定，第一次登入後只存身分雜湊）。<br>・管理網頁：重設申請、教師停權、稽核。<br>・`platform_admins` 表預留 `role`、`scope` 欄位；「新增各校管理員」等學校層級設計好再開放，本版**不做**。原因：沒有學校範圍的管理員可以重設全平台的學生，風險太大。 |
| D4 | 綁定方式 | **已決定**：兩種都做——班級邀請碼＋老師核准，以及個別綁定碼 |
| D5 | 開放教師註冊 | **已決定：一開始就全面開放**。<br>・部署設定為 `FHES_TEACHER_SIGNUP=open`；程式仍保留 allowlist 模式，必要時可以馬上收回。<br>・限流、停權、稽核維持必做。<br>・前提：使用者在 Google Cloud 把 OAuth 同意畫面設為「正式版、外部」（使用者自己操作）。<br>・正式部署仍要另外核准。 |
| D6 | 學生 Google 登入 | **已決定：做好並直接開啟**（`FHES_STUDENT_GOOGLE=1`）。<br>・前提：使用者在 OAuth Client 加上學生網站的來源。<br>・未滿 18 歲的學校帳號，要學校管理員把 App 設為信任；還沒設定的學校，學生會看到「請用帳號密碼登入」的說明。<br>・帳密登入永遠保留。 |
| D7 | 逾期愛心預設啟用（24 個上課小時） | 計劃書要求正式開放前再確認一次；2026-11-26 已決定「啟用、可調整」 |
| D8 | 隱私：使用條款、資料保存與刪除、聯絡方式、學校與家長告知 | 正式開放給真實學生之前，由學校或法務確認（非技術事項） |
| D9 | 目前的真實 Google 驗收環境 | 繼續（使用者登入一次即可完成 v6.2 的驗收），或先還原（`config.js`、`launch.json`、重新啟動原本的 Python 伺服器） |

**這次沒有做的事**：

- 沒有改任何程式（只新增本文件，未 commit）。
- 沒有 commit、push、合併或部署。
- 沒有連線 VPS。
- 沒有變更 Google Cloud。
- 沒有碰美術工作樹。
