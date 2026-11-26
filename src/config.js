// 部署設定（公開資訊，不是密鑰）。
// GOOGLE_CLIENT_ID：OAuth「網頁應用程式」用戶端 ID（….apps.googleusercontent.com）。
//   - 留空：登入畫面會讓老師在這台電腦輸入（存在 localStorage，僅此識別碼）。
//   - 正式部署前由管理者填入（需使用者另外核准；見 docs/GOOGLE-SHEETS-SETUP.md）。
//   - 2026-11-25 使用者核准寫入並發布（OAuth 用戶端「網頁應用程式」，已授權來源見下方清單）。
// 絕對不要在這裡放 client secret、token 或任何密碼。
export const GOOGLE_CLIENT_ID = '614456020578-m6363jtnho42k9n7u2c4b8djjs7hpagc.apps.googleusercontent.com';

// GOOGLE_AUTHORIZED_ORIGINS：與 Google Cloud「已授權的 JavaScript 來源」保持一致（公開資訊）。
//   Google 比對的是完整來源字串：http://localhost:8765 與 http://127.0.0.1:8765 是不同的來源。
//   目前網址不在清單內時，登入畫面會先提醒（否則老師按下登入只會看到 Google 的 origin_mismatch 或沒有反應）。
//   修改 Google Cloud 設定時要同步更新這裡；清單為空 = 不檢查。
export const GOOGLE_AUTHORIZED_ORIGINS = ['http://localhost:8765', 'https://yongliancai.github.io'];

// STUDENT_API_BASE（v6.2）：學生系統 API 的網址（例如 https://fhes.example.edu.tw）。公開資訊，不是密鑰。
//   - 留空：教師端不顯示「學生系統」，一切照 v6.1 運作。
//   - 正式網址需要使用者另外核准部署後才填入（docs/STUDENT-DEPLOY-TODO.md）。
export const STUDENT_API_BASE = '';
