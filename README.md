# 卡比獸週隊推演台

Pokémon Sleep 每週最佳隊伍推演工具。輸入本週的加成樹果與目標料理，從你的寶可夢箱**窮舉**出週能量最高的 5 隻組合。

單一 HTML 檔、零依賴、沒有 build step。

## 功能

- **隊伍 × 食譜聯合最佳化** — 對每一組隊伍試遍所有候選食譜，取最佳搭配再排名，而不是先選食譜再挑隊伍
- **完整模擬引擎** — 幫手頻率、活力分段（10 分鐘一格模擬 24 小時並疊代至穩態）、食材機率與欄位輪替、攜帶上限與偷吃、主技能發動（含 pity）
- **隊伍互動** — 幫手獎勵按人數疊加、活力回復獎勵、補能量回饋收斂、幫手加速依同樹果種類數放大（5→11 次幫手）、負電需正電夥伴
- **21 餐排程** — 同一個食材池貪婪填滿一週 21 餐，多重起點避免貪婪陷阱
- **個別食譜等級** — 每道分別設定（Lv1 ×1.00 → Lv70 ×3.58）
- **完整繁體中文** — 246 隻寶可夢、78 道食譜、性格／副技能／主技能／樹果／食材／研究區域
- 深色／淺色主題、手機版面

## 資料儲存

一份程式碼，兩種後端，自動判斷：

| 環境 | 後端 |
|---|---|
| 自架（GitHub Pages 等） | **你的 Google Sheet**，透過 Apps Script — 見 [SETUP-google-sheet.md](SETUP-google-sheet.md) |
| claude.ai artifact | 該 artifact 內建的資料庫 |
| 都沒設定 | 只存 `localStorage`（單一裝置） |

`localStorage` 在任何情況下都會寫一份離線副本。另外「寶可夢箱」頁有「複製 JSON／貼上 JSON」可以手動備份搬移。

## 發布到 GitHub Pages

```bash
git clone <你的 repo>
# 把 index.html / README.md / SETUP-google-sheet.md / LICENSE / NOTICE / apps-script 放進去
git add -A && git commit -m "init" && git push
```

Settings → Pages → Source 選 `main` 分支根目錄。幾分鐘後 `https://<帳號>.github.io/<repo>/` 上線。

## 資料版本

遊戲數值是**靜態快照**（頁面底部「資料版本」有 commit 與日期）。遊戲改版後不會自己更新。

更新方式：`npm run data` 會從 [Neroli's Lab](https://github.com/nerolis-lab/nerolis-lab) 重新萃取並覆寫 `data/game.json`（`meta` 欄位一併換成新的 commit／日期）。先 `git diff data/game.json` 確認改動合理、跑過 `npm test`，再 commit。

`data/game.json` 裡的 `zh` 區塊是繁中對照表，來自 `tools/zh.txt`，**上游沒有這份，重建時不能弄丟**。

## 已知簡化

頁面底部「計算方式與已知簡化」分成 **有算 / 近似處理 / 還沒做** 三類。摘要：

- 補能量以每日總量平均攤到白天，不是隨機時點的逐次事件（對補師略微樂觀）
- 揮指／技能複製／十項全能以全部基礎主技能的平均值近似
- 食材精選（Ingredient Draw）的專屬食材池未實作 — 數量對、種類不對
- 專家模式喜好樹果頻率修正、期間限定活動加成、週日單獨最佳化、薰香：均未納入
- 上游資料落後遊戲：脂紅火山、活力回復提升 S／M、超夢尚未收錄

絕對數值會有誤差，但**隊伍之間的排序可靠** —— 那才是這個工具要回答的問題。

## 開發

```bash
npm i playwright-core
npm run serve     # 起 http server → 開 http://localhost:8080
npm test          # tests/smoke.mjs — 27 項檢查（測試會自己起 server）
npm run data      # 從上游重建 data/game.json
```

**不能用 `file://` 雙擊開 `index.html`** —— 遊戲資料是 `fetch('./data/game.json')` 載進來的，`file://` 會被 CORS 擋掉。直接開會看到一段說明要你改跑 `npm run serve`。GitHub Pages 上沒這個問題。

檔案佈局：

| 檔案 | 內容 |
|---|---|
| `index.html` | 骨架 —— markup ＋ 載入器 |
| `src/app.css` | 樣式 |
| `src/app.js` | 引擎與 UI |
| `data/game.json` | 遊戲資料快照（indent-2，一個欄位一行，方便 diff） |

動手前先讀 [CLAUDE.md](CLAUDE.md)（架構與已知陷阱）與 [DECISIONS.md](DECISIONS.md)（為什麼做成這樣）。待辦見 [TODO.md](TODO.md)。

## 授權

程式碼與繁中對照表：自由使用。

遊戲數值取自 [Neroli's Lab / SleepAPI](https://github.com/nerolis-lab/nerolis-lab)，Apache-2.0 — 詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。**公開發布請保留這兩個檔案。**

Pokémon 為 Nintendo / Creatures Inc. / GAME FREAK Inc. 商標。非官方同人工具。
