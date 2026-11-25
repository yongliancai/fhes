# 班級經營動力站 FHES（v6.1）

國小班級經營網頁工具（v6.1 起需以老師的 Google 帳號登入，各帳號資料分開）：個人與小隊加分、愛心提醒與消除、兌換、秩序記錄與待確認、每日結算、**作業繳交與訂正**、**六大收藏世界圖鑑（小隊／全班 XP）**、**Google 試算表雲端同步**。單一頁面、無建置步驟、離線可用（IndexedDB）。

- 教師使用說明：[docs/USER-GUIDE.md](docs/USER-GUIDE.md)
- 雲端同步設定（Google 帳號＋試算表）：[docs/GOOGLE-SHEETS-SETUP.md](docs/GOOGLE-SHEETS-SETUP.md)
- 登入與資料隔離的安全邊界：[docs/AUTH-SECURITY.md](docs/AUTH-SECURITY.md)
- 部署前檢查與還原：[docs/DEPLOY-CHECKLIST.md](docs/DEPLOY-CHECKLIST.md)

## 開發
AI Agent 請先讀 [AGENTS.md](AGENTS.md)。

```sh
npm ci
npm run serve        # http://127.0.0.1:8765/
npm run verify       # 語法＋import 檢查、守門規則、ESLint、單元測試
npm run test:e2e     # 真實瀏覽器（系統的 Edge / Chrome）
```

- 程式架構：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜決策：[docs/DECISIONS.md](docs/DECISIONS.md)｜工程規範：[docs/PROJECT-ENGINEERING.md](docs/PROJECT-ENGINEERING.md)
- 驗證紀錄：[docs/VERIFICATION.md](docs/VERIFICATION.md)｜Bug 紀錄：[docs/BUG-LOG.md](docs/BUG-LOG.md)｜美術授權：[docs/ASSET-LICENSES.md](docs/ASSET-LICENSES.md)

需要以 http(s) 開啟（GitHub Pages 或 `npm run serve`）；直接雙擊 `index.html` 無法載入模組。
