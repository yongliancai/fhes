# 給 Google Antigravity 的任務：生成 FHES 圖鑑全部美術

> 把這整份文件交給 Antigravity 的 agent 執行。提示詞資料在 `art/prompts/prompts.json`（共 185 條：角色 144、園區背景板 6、道具與里程碑 35）。
> 人看的版本是 `art/prompts/PROMPTS.md`。不要手改這兩個檔案；要改請改 `scripts/art-prompts.mjs` 後執行 `node scripts/art-prompts.mjs`。

## 你（agent）的工作範圍

- 只能新增或覆寫 `art/raw/` 資料夾裡的檔案。
- 不要修改專案的其他任何檔案，不要 `git commit`、不要 `git push`、不要部署。
- 所有提示詞都要**一字不改**地使用 `prompts.json` 裡的 `prompt` 欄位（只可以在前面加上本文件規定的參考圖說明句）。

## 執行方式：一路做到完成，不用等確認

使用者已批准全部量產（2026-11-25）。請依 `priority` 由小到大處理所有項目，同一個 priority 內依檔案順序：

| priority | 內容 | 數量 |
|---|---|---|
| 1 | 重測：`fantasy-12_adult`（新設計）與 4 張幼年樣本 | 5 |
| 2 | 園區背景板 `bg-<世界>` | 6 |
| 3 | 其餘角色成年版 | 68（已有 3 張） |
| 4 | 園區道具與全班里程碑 | 35 |
| 5 | 其餘角色幼年版 | 68 |

1. **開始前**：把 priority 1 的 5 個舊檔改名為 `*_old.png` 保留（例如 `fantasy-12_adult_old.png`）。
2. **跳過已完成**：`generation-log.csv` 裡 `status` 是 `ok` 且檔案存在的項目不要重做。
3. **配額用完**（HTTP 429 `RESOURCE_EXHAUSTED`）：立刻停止，把目前進度寫進 log，回報「已完成幾張、剩幾張、配額何時重置」。下次執行同一份文件時，從沒做完的地方接著做。
4. **每完成一個 priority**，在對話中簡短回報：完成數、`needs_review` 清單。

## 參考圖（風格基準）

風格基準圖：`art/raw/land-01_adult.png`、`art/raw/ocean-07_adult.png`、`art/raw/tech-10_adult.png`。

- **角色成年版與道具**：附上 3 張風格基準圖，提示詞前面加：
  `Match the exact rendering style, material and lighting of the attached style reference images, but draw a different subject as described below.`
- **角色幼年版**：只附上同一隻的成年圖（`referenceImage`），提示詞前面加：
  `Use the attached image only as a character reference for species, colors, markings and face design; do NOT copy its pose or body proportions.`
  同一隻的幼年版一定要在它的成年版通過檢查之後才做。
- **背景板**：附上 3 張風格基準圖，提示詞前面加：
  `The attached collectible figures will later be placed standing in this environment. Match their rendering style, material and lighting, but do NOT draw them or any other creature.`
- `fantasy-12_adult`：附上 3 張風格基準圖，但**不要**附上舊的紫色龍圖。

## 輸出格式

- PNG，存成 `file` 欄位指定的路徑。
- 角色與道具：正方形，至少 1024×1024。
- 背景板：工具支援的最寬比例（21:9 最好，至少 16:9）與最高解析度。工具若只能輸出正方形，照樣輸出並在 log 註記 `square only`。
- 工具輸出 JPG 時，原尺寸轉存為 PNG。
- 每張最多重試 3 次。3 次都不合格，保留最好的一張，log 的 `status` 寫 `needs_review` 並寫明原因。

## 品質檢查

### 角色
- [ ] 只有**一隻**角色，全身完整，沒有被裁切；四肢、翅膀等數量正確（例如貓只能有 4 條腿）。
- [ ] 角色**面向畫面左側**（三分之四側面）。
- [ ] 背景是 `background` 欄位指定的**單一純色**，沒有漸層、地板、陰影、倒影或棋盤格（假透明）圖案。
- [ ] 沒有文字、數字、字母、標誌、浮水印或邊框。
- [ ] 外觀符合描述（物種特徵、顏色、花紋），像霧面軟膠公仔的 3D 渲染，和風格基準圖是同一套作品。
- [ ] 稀有度：普通無配件；稀有有一件天藍色小配件；史詩有動態姿勢；傳說有金色鑲邊。**角色周圍不能有光暈、光點或粒子**（這些由程式繪製）。
- [ ] 不像任何現有卡通、遊戲、玩具或品牌角色。
- [ ] 幼年版：和成年版明顯是同一隻，**而且**明顯更小、更圓、頭更大（並排看要一眼分得出來）。

### 背景板
- [ ] 完全沒有角色、動物、生物、機器人或人。
- [ ] 沒有文字、標誌或寫字的招牌。
- [ ] 提示詞指定的**空地區域是空的**（例如陸地下方 35% 是空草地），高大的景物只在兩側與遠方。
- [ ] 風格和風格基準圖一致（3D 公仔／微縮場景質感），顏色比角色柔和。

### 道具
- [ ] 只有一個物件，完整、置中、直立，正面視角。
- [ ] 背景是指定的單一純色，沒有地板、陰影。
- [ ] 沒有生物、沒有文字（招牌與紀念碑的牌面必須是空白的）。

## 生成紀錄 `art/raw/generation-log.csv`

每張圖一行（重試時更新同一行）。沿用既有的檔案與欄位，第一行是標題：

```
id,stage,file,model,generated_at,attempts,status,notes
```

- 背景板與道具的 `stage` 欄填 `backdrop` 或 `prop`。
- `model`：實際使用的圖像工具或模型名稱（看不到版本就照實寫）。
- `generated_at`：ISO 8601 日期時間。
- `status`：`ok` 或 `needs_review`。
- `notes`：不合格原因、`square only` 等說明；沒有就留空。

這份紀錄會寫進專案的素材授權文件（`docs/ASSET-LICENSES.md`），請如實填寫。
