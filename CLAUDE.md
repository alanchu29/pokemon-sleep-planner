# CLAUDE.md — 專案脈絡

Pokémon Sleep 每週最佳隊伍推演工具。單一 HTML 檔、零依賴、無 build step。

## 這份檔案的用途

給在這個 repo 裡工作的 Claude Code 用。上游沒有文件、原始設計討論不在 repo 裡，所以架構決策和已知陷阱都記在這裡。**動手前先讀完。**

## 架構

目前**所有東西都在 `index.html` 一個檔案裡**（約 152 KB），依序是：

| 區塊 | 內容 |
|---|---|
| `<title>` / `<link>` / `<style>` | Google Fonts、CSS 變數（三種主題狀態）、版面 |
| `<div class="wrap">` | 三個 `.view`（`view-plan` / `view-box` / `view-recipes`）＋ 全域的「資料版本」footer |
| `<script id="gamedata">` | **全部遊戲資料的 JSON，單行**。246 隻寶可夢、78 道食譜、性格／副技能／主技能數值、`zh` 繁中對照表、`meta` 版本戳 |
| `<script>` | 引擎與 UI，約 1,200 行 |

`index.html` 是**唯一的真實來源**，不是產出物 —— 直接編輯它。

### 程式碼分區（`<script>` 內，依出現順序）

1. `const D` / `const $` — 資料與 DOM 輔助（**`$` 必須在最前面**，見下方陷阱）
2. 中文查表：`bz` `iz` `pz` `isl` `msz` `ssz` `sss` `natZ` `recipeZh`
3. **引擎**：`energyF` `berryPower` `baseStats` `skillPayload` `simulate` `memberOutput` `teamContext`
4. **食譜求解**：`buildPool` `rankSingle` `bestSingleRecipe` `proxyDish` `mealPlan` `bestPlan` `scoreTeam` `rankRecipesForTeam`
5. **狀態**：`roster` `wk` `lastResults`
6. **持久層**：雙後端配接器（見下）
7. **UI**：`buildWeekly` `renderBox` `run` `renderResults` `renderRecipeLevels` `showView` `renderVersion`

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

`const $ = id => document.getElementById(id)` **必須緊接在 `const D` 後面**。持久層在頂層就會呼叫 `$('syncPull')`，`const` 不會提升，宣告放後面 → 整支腳本在載入時 TDZ 錯誤、**整頁死掉**。

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

## 資料重建

遊戲資料是靜態快照（見頁面「資料版本」的 commit 與日期）。重建：

```bash
node tools/extract-data.mjs        # 會印出用法
```

流程：clone 上游 → 用 esbuild bundle 萃取腳本 → 合併 `tools/zh.txt` → 產出 `tools/data.json` → 替換 `index.html` 裡 `<script id="gamedata">` 的內容。

**`zh` 區塊上游沒有** —— 它來自 `tools/zh.txt`（遊戲自己的 i18n 字串）。重建時絕對不能弄丟。

## 不要做的事

- **不要把真實的 Apps Script token commit 進 `Code.gs`** —— 永遠保持 `CHANGE_ME_TO_A_LONG_RANDOM_STRING`。真實金鑰只在 Google 的編輯器裡改
- **不要移除 `LICENSE` / `NOTICE`** —— 遊戲資料是 Apache-2.0，要求保留歸屬
- **不要在 `zh` 對照表裡自創中文名** —— 沒有來源就留英文，並在 `已知簡化` 註明
- **不要移除 `已知簡化` 那一段** —— 那是這個工具可信度的基礎；改了行為就同步改它

## 驗收方式

```bash
npm i playwright-core            # 容器內已有 chromium
node tests/smoke.mjs             # 引擎 + 單調性 + 雙後端
```

沒有 CI。`TODO.md` 第 3 項就是要補。
