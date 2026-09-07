# CLAUDE.md — 專案脈絡

Pokémon Sleep 每週最佳隊伍推演工具。零依賴、無 build step、純靜態。

## 這份檔案的用途

給在這個 repo 裡工作的 Claude Code 用。上游沒有文件、原始設計討論不在 repo 裡，所以架構決策和已知陷阱都記在這裡。**動手前先讀完。**

## 架構

五個檔案，都是**真實來源**，不是產出物 —— 直接編輯：

| 檔案 | 內容 |
|---|---|
| `index.html` | 骨架：`<head>`（字型、`app.css`）＋ markup（三個 `.view`：`view-plan` / `view-box` / `view-recipes`，加「資料版本」footer）＋ 尾端的載入器 |
| `src/app.css` | CSS 變數（三種主題狀態）與版面 |
| `src/engine.js` | **純引擎**，約 490 行。window 與 Worker 兩邊都載入同一份 |
| `src/engine.worker.js` | 薄薄一層 Worker 外殼，約 50 行 |
| `src/app.js` | UI 與持久層，約 700 行 |
| `data/game.json` | 遊戲資料快照。246 隻寶可夢、78 道食譜、性格／副技能／主技能數值、`zh` 繁中對照表、`meta` 版本戳。**indent-2 pretty-print，一個欄位一行** |

### 載入順序（重要）

`index.html` 尾端的 `<script type="module">`：

1. `await fetch('./data/game.json', {cache:'no-cache'})`，檢查必要的頂層鍵都在 → 放到 `window.GAMEDATA`
2. 依序動態插入 `./src/engine.js`、`./src/app.js`（**classic script，不是 `import()`**）

`engine.js` 宣告 `D` 和所有引擎函式；`app.js` 直接用那些全域名字，**自己不要再宣告 `D`**（同名 `const` 會撞成 SyntaxError）。

**為什麼是動態插入 classic script 而不是 `import()`**：頂層宣告必須留在全域。`tests/smoke.mjs` 靠 `page.evaluate` 直接驅動內部狀態（`roster = [...]`、`run()`、`scoreTeam()`、`buildPool(wk)`），改成 module 會把這些關進模組作用域，46 項測試會全滅。**不要「順手」改成 module。**

因為用了 `fetch`，**`file://` 直接開會失效**（CORS）。本機要跑 `npm run serve`。載入器有 catch，會顯示提示而不是白畫面 —— 改動載入器時要保留這個 fallback。

### Worker

推演跑在 `src/engine.worker.js`。主執行緒和 worker **載入同一份 `engine.js`**，所以不會有兩份引擎走鐘的問題。

```
app.js  run()  ──postMessage{init:D}──▶  engine.worker.js
                                            └─ importScripts('./engine.js')
        ──postMessage{run,roster,wk}──▶  searchTeams(roster, wk, {onProgress})
        ◀──{progress,done,total}────────  （每 80ms 節流一次）
        ◀──{done,result}───────────────
```

三條規則：

1. **`engine.js` 絕對不能碰 DOM，也不能讀 `app.js` 的狀態**（`roster` / `wk` / `lastResults`）。需要什麼就當參數收 —— worker 裡沒有那些全域。`rlvl(r, wk)`、`buildPool(wk)`、`rankRecipesForTeam(r, wk)` 的 `wk` 參數就是為此而加的，**不要改回讀全域**。
2. **取消是靠主執行緒 `terminate()`，不是傳訊息。** 搜尋是同步迴圈，跑的時候 worker 不會處理訊息佇列，送 `cancel` 進去要等搜尋結束才被讀到。`SharedArrayBuffer` + `Atomics` 可以真正中斷，但需要 COOP/COEP 標頭，GitHub Pages 給不了。
3. **主執行緒也需要 `POOL` 和 `_bs`**。`renderResults` 會呼叫 `rankRecipesForTeam`（吃 `POOL`）、`memberCard` 會讀 `m._bs`。worker 算的那份在它自己的記憶體裡，所以 `run()` 在送出之前會自己再算一遍（很便宜）。

`Worker` 不可用或載入失敗時會**退回主執行緒**同步跑（UI 會凍住，但至少有答案），`comboCount` 會標上「· 主執行緒」。

### 程式碼分區

`src/engine.js`（依出現順序）：

1. `const D`（= `self.GAMEDATA`，加完整性檢查）＋ 資料衍生常數：`ING_NAME` `ING_VAL` `NING` `BERRY_VAL` `NAT` `SS` `SS_SLOT_LV` `RIBBON_CARRY` `AVG_CRIT` `HB_TABLE` `MAGNET_POOL` `MEALS_WEEK`
2. **引擎**：`energyF` `berryPower` `baseStats` `skillPayload` `simulate` `memberOutput` `teamContext`
3. **食譜求解**：`buildPool` `rankSingle` `bestSingleRecipe` `proxyDish` `mealPlan` `bestPlan` `scoreTeam` `rankRecipesForTeam`
4. **搜尋**：`combinations` `searchTeams`（＋ `FINALISTS` / `SHOWN` / `PRESCAN_LIMIT`）

`src/app.js`（依出現順序）：

1. `const $` — DOM 輔助（**必須在最前面**，見下方陷阱）
2. `PATHS` / `P` / `C` — 文案裡提到的檔名與指令一律從這裡取（見下方陷阱）
3. `SCHEMA` ＋ `fatal()` ＋ schema 斷言
4. 中文查表：`bz` `iz` `pz` `isl` `msz` `ssz` `sss` `natZ` `recipeZh`
5. **狀態**：`roster` `wk` `lastResults`
6. **持久層**：雙後端配接器（見下）
7. **Worker 管線**：`spawnWorker` `killWorker` `searchViaWorker` `setRunning`
8. **UI**：`buildWeekly` `renderBox` `run` `renderResults` `renderRecipeLevels` `showView` `renderVersion`

## 雙後端持久層

一份程式碼，執行時自己判斷：

```
window.claude 存在  → claude.use('db') → artifact 資料庫（doc: box/main）
否則 + 已設定同步    → 使用者的 Google Sheet（Apps Script Web App）
否則                → 只有 localStorage
```

`localStorage['psleep-box']` **任何情況下都會寫**，當離線副本。

`!window.claude` 就是「自架版本」的判斷依據 —— 用來顯示同步面板、停用「請求更新資料」按鈕、以及版本面板的標示。**新增環境相依的文案時記得兩邊都要對。**

Google Sheet 後端在 `apps-script/Code.gs`，設定步驟見 `SETUP-google-sheet.md`。

## 已經踩過的陷阱 — 不要再踩

### 1. `$` 的 TDZ

`const $ = id => document.getElementById(id)` **必須留在 `app.js` 的最前面**。持久層在頂層就會呼叫 `$('syncPull')`，`const` 不會提升，宣告放後面 → 整支腳本在載入時 TDZ 錯誤、**整頁死掉**。

搬動任何頂層區塊時，先確認相依順序。

### 2. Apps Script 的 CORS preflight

上傳一定要用 `Content-Type: text/plain`。用 `application/json` 會觸發 preflight `OPTIONS`，Apps Script 不回應 OPTIONS，直接失敗。後端自己 `JSON.parse(e.postData.contents)`。

### 3. 貪婪排程不單調

`mealPlan` 單純依 `rv` 由高到低貪婪**不是單調的** —— 調高某道食譜的等級可能讓它選錯開場、總分反而變低。`bestPlan` 用多重起點（`null` ＋ `rankSingle` 前 8 名）繞過。

**任何改動 `mealPlan` / `bestPlan` 的人，必須跑單調性測試**（`tests/smoke.mjs`）。

### 4. 搜尋目標與評分目標必須一致

搜尋階段用 `proxyDish`（便宜的樂觀上界），決賽用 `bestPlan`（真實的 21 餐排程）。兩者若脫鉤，最佳隊伍會被擠出決賽名單。

`FINALISTS = 50`（進決賽）、`SHOWN = 8`（顯示）。**改動評分方式時要重新確認 `FINALISTS` 夠不夠大。**

### 5. 記憶化的 context key

`ctxKey()` 決定 `memberOutput` 的快取粒度。加新的 team-level 效果時**一定要加進 `ctxKey`**，否則會拿到別的隊伍組成算出來的結果。`supportEnergy` / `extraHelps` 有量化（`qE` / `qH`）來控制快取爆炸。

### 6. 副技能的欄位解鎖

`SS_SLOT_LV = [10,25,50,70,80]`。`activeSubskills()` 只採計 `m.level >= SS_SLOT_LV[i]` 的欄位 —— **順序有意義**，`m.ss` 的陣列位置就是遊戲裡的欄位位置。

### 7. 文案不能寫死檔名

拆檔時踩過：UI 還在教使用者「替換 `index.html` 裡的 `<script id="gamedata">`」，但那個區塊早就不存在了。README 和這份檔案也各有一處。**讀程式碼看不出來，只有截圖才會發現。**

所以使用者可見文案裡的檔名與指令，一律從 `app.js` 的 `PATHS` 取（`P.data`、`C.rebuild` …），不要寫死字串。`tests/smoke.mjs` 第 10 節會斷言 `PATHS.files` 的每個路徑真的存在、`PATHS.cmds` 的每個指令真的定義在 `package.json`，並反向掃文案裡有沒有 `PATHS` 以外的硬寫路徑。

### 8. 資料與程式的版本偏移

`app.js` 的 `SCHEMA` 必須等於 `data/game.json` 的 `meta.schema`。**動到資料的欄位結構時兩邊一起 +1**（純數值更新不用動），`tools/extract-data.mjs` 裡也有一份要同步。

理由：拆檔後 `app.js` 與 `game.json` 是兩個獨立快取的資源，GitHub Pages 送 `max-age=600`，所以更新後有最多 10 分鐘的窗口會拿到「新程式 ＋ 舊資料」。不擋的話使用者只會看到壞頁面或錯的數字，不知道重新整理就好。

## 資料重建

遊戲資料是靜態快照（見頁面「資料版本」的 commit 與日期）。重建：

```bash
node tools/extract-data.mjs        # 會印出用法
```

流程：clone 上游 → 用 esbuild bundle 萃取腳本 → 合併 `tools/zh.txt` → **直接覆寫 `data/game.json`**（indent-2）。

覆寫之後一定要 `git diff data/game.json` 看一眼再 commit —— 那份 diff 現在是一個欄位一行，上游動了什麼會直接顯示出來。

**`zh` 區塊上游沒有** —— 它來自 `tools/zh.txt`（遊戲自己的 i18n 字串）。重建時絕對不能弄丟。

## 不要做的事

- **不要把真實的 Apps Script token commit 進 `Code.gs`** —— 永遠保持 `CHANGE_ME_TO_A_LONG_RANDOM_STRING`。真實金鑰只在 Google 的編輯器裡改
- **不要移除 `LICENSE` / `NOTICE`** —— 遊戲資料是 Apache-2.0，要求保留歸屬
- **不要在 `zh` 對照表裡自創中文名** —— 沒有來源就留英文，並在 `已知簡化` 註明
- **不要移除 `已知簡化` 那一段** —— 那是這個工具可信度的基礎；改了行為就同步改它

## 驗收方式

```bash
npm i playwright-core
npm test                         # 46 項：引擎、單調性、雙後端、Sheet 往返、Worker、文案一致性、schema 偏移
```

`run()` 是**非同步**的（推演跑在 Worker 裡）。測試等結果時**不要用 `waitForTimeout`** —— 在慢一點的機器上會 flaky。用 `smoke.mjs` 裡的 `doRun()` 輔助函式，它會先清掉 `lastResults` 再等它被填回來。

`tests/smoke.mjs` 會**自己起一台靜態 server**（因為資料改用 fetch 之後不能再用 `file://` 載入），所以 CI 不需要額外的 server step。

Chromium 路徑：預設 `/opt/pw-browsers/chromium`（容器內），用 `CHROMIUM` 環境變數覆蓋。Windows 上例如：

```bash
CHROMIUM="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" node tests/smoke.mjs
```

CI 在 `.github/workflows/ci.yml`，push / PR 都會跑。

**注意：目前的測試全是結構性／相對性斷言，抓不到公式係數的改動。** 實測把 `energyF` 的 `0.45` 改成 `0.50`，全部依然通過。要擋住這類迴歸還缺**引擎輸出的快照測試（golden file）**，見 `TODO.md` 的「引擎輸出的快照測試」。

動引擎時的臨時替代做法：改之前先跑一次固定 seed、記下 `lastResults[0].total`，改完再比。Worker 重構就是這樣驗證數值等價的（`804479.78`，前後完全一致）。
