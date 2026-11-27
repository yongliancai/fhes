# v6.2 學生系統：部署操作手冊（VPS）

這份手冊給「批准部署後」照著做。批准前什麼都不要在 VPS 上執行（`docs/STUDENT-DEPLOY-TODO.md`）。範例檔在 `deploy/`。
範例網域一律寫 `fhes.school.example.edu.tw`，請換成實際的子網域。

## 1. 準備

| 項目 | 需求 |
|---|---|
| Node.js | 22.x（`node -v`）；`--env-file` 需要 20.6 以上 |
| 編譯工具 | 通常不需要（argon2、better-sqlite3 有 Linux x64 預編譯檔）；失敗時安裝 `build-essential python3` |
| 磁碟 | 程式約 60 MB；資料庫一所學校通常 < 50 MB；備份 30 份 |
| 記憶體 | 程序約 100 MB，尖峰（大量登入）約 300 MB |
| 子網域與 TLS | DNS 指到 VPS；用 Let's Encrypt（CloudPanel 可直接申請） |

## 2. 目錄與帳號（和現有網站隔離）

```sh
sudo useradd --system --create-home --home-dir /srv/fhes-student --shell /usr/sbin/nologin fhes
sudo -u fhes mkdir -p /srv/fhes-student/{app,data,backups,secrets,logs}
sudo chmod 700 /srv/fhes-student/{data,backups,secrets}
sudo -u fhes git clone --branch <要部署的分支或標籤> https://github.com/yongliancai/fhes /srv/fhes-student/app
cd /srv/fhes-student/app && sudo -u fhes npm ci --omit=dev
```

## 3. 環境變數怎麼設定

1. 複製範本：`sudo -u fhes cp deploy/fhes-student.env.example /srv/fhes-student/fhes-student.env && sudo chmod 600 /srv/fhes-student/fhes-student.env`
2. 逐項填寫：

| 變數 | 填什麼 | 例子 |
|---|---|---|
| `FHES_TEACHER_SIGNUP` | `allowlist`（預設：只有下一列名單裡的老師）或 `open`（任何 email 已驗證的 Google 帳號都能自助註冊成老師；只拿得到自己開的班）。改成 `open` 前，Google Cloud 的 OAuth 同意畫面要是「正式版、外部」。要收回就改回 `allowlist` 再重新啟動 | `allowlist` |
| `FHES_TEACHER_ALLOW` | 可以使用學生系統的老師。寫完整 email，或 `@學校網域`（該網域所有已驗證帳號）。多個用逗號隔開。allowlist 模式下**不在名單上的 Google 帳號一律被拒絕**；open 模式可以留空 | `wang@school.edu.tw,@school.edu.tw` |
| `FHES_ADMIN_EMAIL` | 平台管理員（處理忘記密碼的重設申請、老師停權、看稽核）。只寫你自己的 Google 帳號；第一次登入 `admin.html` 後只認這個帳號的身分。留空＝管理功能關閉 | `owner@school.edu.tw` |
| `FHES_ADMIN_ORIGINS` | 選填：管理頁的來源；預設和 `FHES_TEACHER_ORIGINS` 相同（`admin.html` 和教師端在同一個網站） | |
| `FHES_CODE_PEPPER` | 選填：邀請碼與綁定碼 HMAC 的金鑰；不設就由 `FHES_IP_SALT` 分開推導 | |
| `FHES_TEACHER_ORIGINS` | 教師端網頁的來源（現在是 GitHub Pages） | `https://yongliancai.github.io` |
| `FHES_STUDENT_ORIGINS` | 學生頁面的子網域 | `https://fhes.school.edu.tw` |
| `FHES_TRUST_PROXY` | 在 nginx 後面設 `1`；沒有 nginx、直接對外設 `0`。用正式網域時**必須明確設定**，不設就拒絕啟動 | `1` |
| `FHES_IP_SALT` | 32 bytes 亂數：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | （64 個十六進位字元） |
| `FHES_DB_PATH` | 資料庫檔案位置 | `/srv/fhes-student/data/fhes-student.db` |
| `FHES_BACKUP_*` | 見第 6 節 | |

3. 檢查設定是否完整（不會啟動伺服器，只檢查）：
   `cd /srv/fhes-student/app && node --env-file=/srv/fhes-student/fhes-student.env -e "import('./server/main.mjs').then(m => console.log(m.configFromEnv()))"`
   缺任何一項會列出「缺少設定：…」。

## 4. PM2

```sh
sudo -u fhes cp deploy/ecosystem.config.cjs.example /srv/fhes-student/ecosystem.config.cjs
sudo -u fhes pm2 start /srv/fhes-student/ecosystem.config.cjs
sudo -u fhes pm2 save
sudo env PATH=$PATH pm2 startup systemd -u fhes --hp /srv/fhes-student   # 開機自動啟動（依畫面指示執行它印出的指令）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/student.html   # 應該是 200
```

只跑一個程序（SQLite）；不要用 cluster 模式。

## 5. nginx（或 CloudPanel）

1. 參考 `deploy/nginx-fhes-student.conf.example`：只建立這個子網域的 `server` 區塊，**不改其他網站**。
2. 另存 `/etc/nginx/fhes-student-proxy.conf`（範本最下面的註解內容）。`X-Forwarded-For` 必須是 `$remote_addr`（覆寫），學生才不能偽造 IP 繞過限流。
3. `sudo nginx -t` 通過才 `sudo systemctl reload nginx`。修改前先備份原本的設定檔。
4. CloudPanel：新增「Reverse Proxy」網站，目標 `http://127.0.0.1:8790`，到 Vhost 編輯器加上 `limit_req` 與 `proxy_set_header X-Forwarded-For $remote_addr;`。
5. 檢查標頭：`curl -sI https://fhes.school.edu.tw/student.html` 要看到 `strict-transport-security`、`content-security-policy`、`x-frame-options: DENY`。

## 6. 加密備份

| 步驟 | 指令 |
|---|---|
| 產生金鑰（只做一次） | `sudo -u fhes node server/backup.mjs keygen /srv/fhes-student/secrets/backup.key` |
| 金鑰另存一份 | 存到學校的密碼保管系統或離線隨身碟。**金鑰遺失 = 備份無法還原**；金鑰不可和備份放在同一台機器的同一個備份目的地 |
| 每天凌晨 3:15 自動備份 | `sudo -u fhes crontab -e` 加一行：`15 3 * * * cd /srv/fhes-student/app && node --env-file=/srv/fhes-student/fhes-student.env server/backup.mjs backup >> /srv/fhes-student/logs/backup.log 2>&1` |
| 驗證最新備份 | `node --env-file=… server/backup.mjs verify /srv/fhes-student/backups/<檔名>` |
| 異地備份（建議） | 把 `/srv/fhes-student/backups/*.db.enc` 同步到學校雲端硬碟（檔案已加密）；金鑰**不要**一起同步 |

備份內容：SQLite 線上一致性快照（服務不用停）→ AES-256-GCM 加密 → 明文暫存檔與 `-wal`／`-shm` 旁檔立即刪除 → 超過 30 天的備份刪除（至少保留最新 3 份）。

**每學期做一次還原演練**（不碰正式資料庫）：
`node --env-file=… server/backup.mjs restore <備份檔> /tmp/fhes-drill.db`，看到「還原完成」後刪除 `/tmp/fhes-drill.db`。

## 7. 回滾（出問題時）

依嚴重程度由輕到重；每一步都不影響老師的班級資料（正本在老師的電腦與 Google 試算表）。

| 情況 | 做法 | 影響 |
|---|---|---|
| A. 學生系統有問題，先關掉 | 教師端：`src/config.js` 的 `STUDENT_API_BASE` 改回 `''`，發布 GitHub Pages（需批准） | 「學生系統」按鈕消失，教師端回到 v6.1 行為；學生頁面仍在但老師無法發布 |
| B. 停止學生系統 | `sudo -u fhes pm2 stop fhes-student` | 學生無法登入；資料保留 |
| C. 程式版本回退 | `cd /srv/fhes-student/app && sudo -u fhes git checkout <上一個版本標籤> && sudo -u fhes npm ci --omit=dev && sudo -u fhes pm2 restart fhes-student` | 資料庫 schema 只會往前升級。v6.2 多班級版 = 3：升級時把帳號拆成「登入身分」與「班級成員」，不動照顧紀錄、登記與投影，所有學生會被登出一次。**升級前一定先做加密備份**。舊版程式遇到較新的資料庫會拒絕啟動，所以回退程式時要同時還原升級前的備份 |
| D. 資料庫損壞或誤操作 | `pm2 stop` → 把現有資料庫改名保留 → `node --env-file=… server/backup.mjs restore <最近的備份> $FHES_DB_PATH` → `pm2 start` | 回到備份時間點；之後老師重新按「發布」即可補上最新分數與作業。照顧紀錄與改過的密碼會回到備份時間點 |
| E. 完全移除 | `pm2 delete fhes-student && pm2 save`；移除 nginx 子網域設定（還原備份的設定檔）並 reload；依學校規定保留或刪除 `/srv/fhes-student` | 學生系統消失；教師端先做 A |

教師端備份格式沒有改（仍是 v6，`dataVersion` 6）；v6.2 只在班級物件多了 `studentSystem.nameMode`，v6.1 匯入時會忽略，所以教師端可以直接回到 v6.1。

## 管理備援（主機 CLI）

只在網頁管理頁（`admin.html`）不能用時使用。資料庫版本 4（v6.2 多班級 P2）之後才有。

```
sudo -u fhes FHES_DB_PATH=/srv/fhes-student/data/fhes-student.db node server/admin.mjs list-teachers
sudo -u fhes FHES_DB_PATH=/srv/fhes-student/data/fhes-student.db node server/admin.mjs suspend t_xxxxxxxx
sudo -u fhes FHES_DB_PATH=/srv/fhes-student/data/fhes-student.db node server/admin.mjs unsuspend t_xxxxxxxx
```

- 停權會立即登出該老師，他的邀請碼和綁定碼也同時失效；學生資料不會被刪除。
- 每個動作都記入稽核（`actor_kind = cli`）。
- CLI 不提供重設學生密碼：那一定要經過老師送出申請、管理員在網頁上核准。
