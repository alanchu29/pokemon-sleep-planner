# TODO

按優先順序。每項附**動機**、**做法**、**驗收**。

---

## 1. 拆檔：`data.json` + `app.js` + 精簡 `index.html`

**優先度：最高。這件事不做，後面每次改動都是黑箱。**

**動機**：`index.html` 現在 152 KB，65 KB 的資料 JSON 和 1,200 行程式碼擠在同一個檔案的同一行區塊裡。`git diff` 完全看不出改了什麼 —— 改一行邏輯，diff 顯示整檔變動。

**做法**：
- `data/game.json` — 現在 `<script id="gamedata">` 的內容，**pretty-print**（要能 diff）
- `src/app.js` — 現在 `<script>` 的內容
- `src/app.css` — 現在 `<style>` 的內容
- `index.html` — 只留骨架 ＋ `<link>` ＋ `<script src>`
- 資料改用 `fetch('./data/game.json')` 載入，`await` 之後才 boot

**注意**：這會讓 `file://` 直接開失效（fetch 受 CORS 限制）。要嘛保留一個 `npm run build` 產生單檔版本，要嘛在 README 註明本機要跑 `python3 -m http.server`。**GitHub Pages 上沒問題。**

**驗收**：
- `node tests/smoke.mjs` 全過
- 改一行邏輯，`git diff` 只顯示那一行
- `data/game.json` 的 diff 能看出哪隻寶可夢的數值變了

---

## 2. 推演搬進 Web Worker

**動機**：`run()` 是同步迴圈。26 隻 → 65,780 組合 → 569 ms（可接受）。40 隻 → 658,008 組合 → **約 5 秒，UI 完全凍住**，連「推演中…」都畫不出來。

**做法**：
- 引擎（`baseStats` → `scoreTeam` → `bestPlan`）搬進 `src/engine.worker.js`
- 主執行緒送 `{roster, wk}`，worker 回傳 `lastResults`
- 加進度回報（每 N 組合 `postMessage` 一次），UI 顯示百分比
- 加「取消」按鈕

**陷阱**：worker 裡沒有 DOM。引擎目前只在 `renderResults` 用 DOM，應該乾淨，但 `wk.recipe` 是物件參照 —— 序列化時要處理（`serialize()` 已經有 `recipe:undefined`，沿用同樣的做法）。

**驗收**：40 隻的箱子推演期間，主題切換按鈕仍然有反應；進度條會動。

---

## 3. 把測試固化成 CI

**動機**：這個專案至今抓到的 bug 全是手動跑 Playwright 發現的：

| Bug | 怎麼發現的 |
|---|---|
| `$` 的 TDZ → 整頁死掉 | 同步往返測試 |
| 貪婪排程不單調（調高等級反而變差） | 對照實驗 |
| 搜尋／評分目標脫鉤 → 料理能量低估 27% | 對照實驗 |
| 自架版本文案說謊 | 看螢幕截圖 |

**沒有一個是靠讀程式碼找到的。** 這些檢查必須自動化。

**做法**：
- `tests/smoke.mjs` 已有基礎，擴充成：引擎數值快照、單調性（隨機 20 組等級）、雙後端偵測、Sheet 往返（mock endpoint）、每個 view 都渲染且無 console error
- `.github/workflows/ci.yml`：push / PR 時跑
- 引擎關鍵輸出加**快照測試**（golden file）—— 動到公式時 diff 會直接顯示影響

**驗收**：PR 上看得到綠勾；故意把 `energyF` 的 0.45 改成 0.5，CI 必須失敗。

---

## 4. 食材精選（Ingredient Draw S）的專屬食材池

**動機**：真實技能從該物種的專屬清單抽，目前當成平均撒在全部 18 種食材上 —— **數量對、種類不對**。影響穿山鼠、石居蟹、萌虻、摔角鷹人等。

**做法**：從上游 `common/src/types/mainskill/mainskills/ingredient-draw-s*.ts` 找出各變體的食材池，加進 `tools/extract-data.mjs` 的萃取範圍，`skillPayload` 改成回傳具體食材向量而非 `ingSpread`。

**驗收**：帶穿山鼠的隊伍，食材產出只出現在牠的池子裡，不再是 19 種各一點。

---

## 5. 補上上游落後的資料

上游（Neroli's Lab）本身落後遊戲。踩到才有影響：

| 缺的東西 | 狀態 |
|---|---|
| 脂紅火山（Carmine Volcano）研究區域 | 遊戲有 8 區，資料只有 7 —— 需要三個加成樹果 |
| 活力回復提升 S／M 副技能 | 遊戲有 19 個，資料只有 17 |
| 超夢（2026-09-01 加入） | 種族數值尚未有可靠公開來源 |
| 3 道食譜 | 遊戲約 81 道，資料 78 道 |

**做法**：每次重建資料時先確認上游是否已補上；還沒補就評估手動加（區域和副技能可行，寶可夢種族數值不要猜）。

**驗收**：頁面「收錄範圍」那行的數字對得上遊戲。

---

## 6. 其他

- **記住上次所在的 view** —— 重新載入會跳回「推演」，設定 Sheet 時很煩
- **`已知簡化` 抽成資料** —— 目前寫死在 HTML，應該和引擎能力宣告綁在一起
- **補能量改成離散事件** —— 目前把每日總量平均攤到白天，對補師略微樂觀（不會撞 150 上限浪費）。要更準就得逐次事件模擬
- **匯出推演結果** —— 存成圖片或文字，方便貼到社群討論
- **專家模式** —— 主／副喜好樹果的頻率修正（`GGEX` ×0.90／×1.15、`CBEX` ×0.80／×1.35 ＋ 攜帶 +5）
