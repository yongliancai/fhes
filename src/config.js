// 部署設定（公開資訊，不是密鑰）。
// GOOGLE_CLIENT_ID：OAuth「網頁應用程式」用戶端 ID（….apps.googleusercontent.com）。
//   - 留空：登入畫面會讓老師在這台電腦輸入（存在 localStorage，僅此識別碼）。
//   - 正式部署前由管理者填入（需使用者另外核准；見 docs/GOOGLE-SHEETS-SETUP.md）。
// 絕對不要在這裡放 client secret、token 或任何密碼。
export const GOOGLE_CLIENT_ID = '';
