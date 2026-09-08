# CLAUDE.md — 專案脈絡

Pokémon Sleep 每週最佳隊伍推演工具。零依賴、無 build step、純靜態。

## 這份檔案的用途

給在這個 repo 裡工作的 Claude Code 用。上游沒有文件、原始設計討論不在 repo 裡，所以架構決策和已知陷阱都記在這裡。**動手前先讀完。**

## 架構

六個檔案，都是**真實來源**，不是產出物 —— 直接編輯：

| 檔案 | 內容 |
|---|---|
| `index.html` | 骨架：`<head>`（字型、`app.css`）＋ markup（三個 `.view`：`view-plan` / `view-box` / `view-recipes`，加「資料版本」footer）＋ 尾端的載入器 |
| `src/app.css` | CSS 變數（三種主題狀態）與版面 |
| `src/engine.js` | **純引擎**，約 500 行。window 與 Worker 兩邊都載入同一份 |
| `src/engine.worker.js` | 薄薄一層 Worker 外殼，約 50 行 |
| `src/import.js` | **截圖匯入的反解層**，約 210 行。純函式，只在主執行緒載入（Worker 不需要） |
| `src/app.js` | UI 與持久層，約 950 行 |
| `data/game.json` | 遊戲資料快照。246 隻寶可夢、78 道食譜、性格／副技能／主技能數值、`zh` 繁中對照表、`meta` 版本戳。**indent-2 pretty-print，一個欄位一行** |

### 載入順序（重要）

`index.html` 尾端的 `<script type="module">`：

1. `await fetch('./data/game.json', {cache:'no-cache'})`，檢查必要的頂層鍵都在 → 放到 `window.GAMEDATA`
2. 依序動態插入 `./src/engine.js`、`./src/import.js`、`./src/app.js`（**classic script，不是 `import()`**）

`engine.js` 宣告 `D` 和所有引擎函式；`import.js` 用 `engine.js` 的 `baseStats` / `helpInterval` 做截圖反解；`app.js` 直接用前兩者的全域名字，**自己不要再宣告 `D`**（同名 `const` 會撞成 SyntaxError）。

**為什麼是動態插入 classic script 而不是 `import()`**：頂層宣告必須留在全域。`tests/smoke.mjs` 靠 `page.evaluate` 直接驅動內部狀態（`roster = [...]`、`run()`、`scoreTeam()`、`buildPool(wk)`），改成 module 會把這些關進模組作用域，整套測試會全滅。**不要「順手」改成 module。**

因為用了 `fetch`，**`file://` 直接開會失效**（CORS）。本機要跑 `npm run serve`。載入器有 catch，會顯示提示而不是白畫面 —— 改動載入器時要保留這個 fallback。

### Worker 池

推演分片跑在 `MAX_WORKERS`（預設 6）個 `src/engine.worker.js` 上。主執行緒和每個 worker **載入同一份 `engine.js`**，所以不會有多份引擎走鐘的問題。

```
app.js  run()   ──{init, data:D}──▶  engine.worker.js × N
                                        └─ importScripts('./engine.js')
        ──{shard:{index,total}, roster, wk}──▶  searchShard(...)  ← 只列舉與評分
        ◀──{progress, done, total}──────────    （每 80ms 節流，主執行緒加總）
        ◀──{shard, cands:[{idxs,score}], ms}──  精簡候選

        合併 → 取全域前 FINALISTS → rehydrate() → finalizeTeams()   ← 都在主執行緒
```

**分片的正確性**：全域前 N 名必然也在各自分片的前 N 名內，所以合併集合一定包含它們 —— 分片結果與單執行緒窮舉**完全相同，不是近似**。`tests/smoke.mjs` 第 10 節斷言兩條路徑逐欄位相同。

五條規則：

1. **`engine.js` 絕對不能碰 DOM，也不能讀 `app.js` 的狀態**（`roster` / `wk` / `lastResults`）。需要什麼就當參數收 —— worker 裡沒有那些全域。`rlvl(r, wk)`、`buildPool(wk)`、`rankRecipesForTeam(r, wk)` 的 `wk` 參數就是為此而加的，**不要改回讀全域**。
2. **決賽（`bestPlan`）只能在合併之後跑一次。** 每個 worker 各跑一遍是白費工，而且各自只看到自己的候選集合。
3. **worker 回傳精簡候選（`{idxs, score}`），主執行緒用 `rehydrate()` 還原。** 完整的 `scoreTeam` 結果一個分片 241 KB，8 個分片 1.9 MB，實測那就是平行化的主要瓶頸。`scoreTeam` 是決定性的，所以還原出來的與 worker 端算的相同。
4. **取消是靠主執行緒 `terminate()` 砍掉整池，不是傳訊息。** 搜尋是同步迴圈，跑的時候 worker 不會處理訊息佇列，送 `cancel` 進去要等搜尋結束才被讀到。`SharedArrayBuffer` + `Atomics` 可以真正中斷，但需要 COOP/COEP 標頭，GitHub Pages 給不了。`killPool()` 也會主動 reject 還在等的 promise，否則每次取消都留下永不 settle 的 async 呼叫。
5. **主執行緒也需要 `POOL` 和 `_bs`**。`renderResults` 會呼叫 `rankRecipesForTeam`（吃 `POOL`）、`memberCard` 會讀 `m._bs`，`rehydrate` 兩者都要。worker 算的那份在它自己的記憶體裡，所以 `run()` 在送出之前會自己再算一遍（很便宜）。

`Worker` 不可用或載入失敗時會**退回主執行緒**跑 `searchTeams()`（UI 會凍住，但至少有答案），`comboCount` 會標上「· 主執行緒」。

**加速只有約 2x，而且瓶頸不在程式碼**：分片是平衡的（各分片耗時差 1.06~1.11x），編排開銷 27~46ms，飽和點在 6 個 worker。量測與「為什麼不做動態工作竊取」見 `DECISIONS.md`。

### 截圖匯入（`src/import.js` ＋ 寶可夢箱的「從截圖建立」）

遊戲的寶可夢詳細頁上**沒有物種名**（只有使用者取的暱稱和糖果名），也**沒有睡眠緞帶**。但畫面上有兩個衍生數字：

```
幫忙間隔 每31分51秒        持有上限 35個
```

兩個都是 `(物種, 等級, 性格, 副技能, 緞帶, 露營券)` 的封閉式函數，而引擎已經有那兩條公式。所以不辨識物種名，反過來**掃 246 隻 × 5 種緞帶求解**：哪一組能同時算出畫面上那兩個數字。

實測**七隻**真實寶可夢（清單見下方「驗收方式」）全部都是**唯一解**，而且任何單一欄位讀錯（等級 ±1、性格、漏看一個幫忙速度副技能、持有上限 ±1、幫忙間隔 ±1 秒、食材數量 ±1）都會變成**無解**，不會變成錯的答案。

三個附帶好處：

1. **它驗證整筆讀取。** 校驗通過幾乎等於整筆正確。
2. **它反解出畫面上看不到的緞帶。** 只靠 `RIBBON_CARRY = [0,1,3,6,8]` 的差異。
3. **它自動決定進化階段。** 喇叭芽／口呆花／大食花的食材組合、主技能、樹果、糖果名全都相同，但基礎頻率是 5200／3800／2800 —— 只有 2800 能算出 1911 秒。

四條規則：

1. **絕對不要在 `import.js` 複製引擎的公式。** `impInterval` 呼叫 `helpInterval`、`impCarry` 呼叫 `baseStats().carry`。`helpInterval` 就是為此從 `simulate` 抽出來的具名函式 —— 兩份公式一定會走鐘，而走鐘的那份會靜靜地算錯。
2. **自動判斷只產生草稿，不寫 `roster`。** 校對表的每一欄都是可編輯的控制項（種類／等級／性格／五格副技能／三格食材／技能Lv／緞帶），改動會即時重跑 `impVerify`，按「存入箱子」才 `roster.push`。`tests/smoke.mjs` 第 11b 節會斷言「確認之前 `roster.length` 不變」。
3. **反解不出唯一值的欄位一定要標出來**（`.amb` 橘框 ＋ 備註）。靜靜地填一個猜的值就是「文案說謊」那類 bug。
4. **缺欄位要老實變成多解。** 沒填兩個校驗碼就會列出幾十組候選並警告，不准挑一個看起來確定的。

### 程式碼分區

`src/engine.js`（依出現順序）：

1. `const D`（= `self.GAMEDATA`，加完整性檢查）＋ 資料衍生常數：`ING_NAME` `ING_VAL` `NING` `BERRY_VAL` `NAT` `SS` `SS_SLOT_LV` `RIBBON_CARRY` `AVG_CRIT` `HB_TABLE` `MAGNET_POOL` `MEALS_WEEK`
2. **引擎**：`energyF` `berryPower` `baseStats` `skillPayload` `simulate` `memberOutput` `teamContext`
3. **食譜求解**：`buildPool` `rankSingle` `bestSingleRecipe` `proxyDish` `mealPlan` `bestPlan` `scoreTeam` `rankRecipesForTeam`
4. **搜尋**：`combinations` `searchTeams`（＋ `FINALISTS` / `SHOWN`）。一律窮舉 —— 曾經有的 `PRESCAN_LIMIT` 預篩已移除，理由見下方陷阱 4

`src/import.js`（依出現順序）：

1. `impNorm`（全形→半形正規化）＋ `impRev` 反向索引，及 `impNature` / `impSubskill` / `impMainSkill` / `impIngIndex`
2. **校驗碼**：`impInterval` `impCarry` `impSecs` —— 都是**呼叫引擎那一份公式**，不自己算
3. **主技能等級**：`impSkillBonus` `impPayloadHits` `impEffFromPayload` `impSkillLv`
4. **食材欄位**：`impIngSets`（**三格都解，包含還沒解鎖的那格**）
5. **求解**：`impSolve`（掃 246 隻 × 5 種緞帶）、`impVerify`（UI 改欄位後即時重驗）

`src/app.js`（依出現順序）：

1. `const $` — DOM 輔助（**必須在最前面**，見下方陷阱）
2. `PATHS` / `P` / `C` — 文案裡提到的檔名與指令一律從這裡取（見下方陷阱）
3. `SCHEMA` ＋ `fatal()` ＋ schema 斷言
4. 中文查表：`bz` `iz` `pz` `isl` `msz` `ssz` `sss` `natZ` `recipeZh`
5. **狀態**：`roster` `wk` `lastResults`
6. **持久層**：雙後端配接器（見下）
7. **Worker 管線**：`spawnWorker` `killWorker` `searchViaWorker` `setRunning`
8. **UI**：`buildWeekly`、`ingPick` / `monCard` / `setMonValues`（**寶可夢箱與截圖校對區共用同一個卡片渲染器**）、`boxFlt` / `monMatch` / `applyBoxFilter` / `renderBox`、`buildImport` 那一組、`run` `renderResults` `renderRecipeLevels` `showView` `renderVersion`

### 寶可夢箱的卡片版面：摺疊列 ＋ 展開編輯

**預設摺疊成一行唯讀摘要，點一下才展開編輯區。** 這是兩次修正之後的結論：

1. 原本是一列八欄的 grid，實際寬度下每個選單都被裁掉（`大食花　#71 Vi…`、`技能…`、`頑皮 +速度` 都看不完）。而這個工具的可信度就建立在「畫面上寫的就是實際採用的值」—— 看不完等於沒有。
2. 改成三列全展開之後可以看完了，但**一隻就吃掉半個螢幕** —— 60 隻的箱子根本沒辦法掃。

所以：摺疊列放兩列 —— 第 1 列 `#圖鑑號 名稱 [專長] [主技能] Lv 性格 副技能… 技Lv [📌 🚫 ✕]`，第 2 列**只有食材**。全部唯讀、有顏色；展開後才有選單。

**食材為什麼要獨立一列：** 原本副技能和食材同在一個 `.mon-sum` 裡靠 flex-wrap 自然換行，結果兩種標籤混在同一列、而斷行位置隨視窗寬度浮動 —— 掃 60 隻時分不出哪個是哪個。食材給 `flex:1 1 100%` 之後位置固定，掃過去只要看第 2 列。編輯用的下拉每個都要 ~150px，全部攤開必然佔版面，摺疊是唯一同時滿足「看得完」和「掃得快」的做法。

摺疊列的**副技能底色就是稀有度**（`game.json` 的 `subskills[].r`：gold／silver／white），不是自己配的色。未解鎖的欄位變淡但仍然顯示 —— 遊戲畫面上看得到（🔒Lv.70），先記下來是對的。

**食材是「[食材名 選單] ×N（靜態文字）」，不是兩個選單。** 同一格裡食材種類不會重複（`[null,0]` 空欄位除外），所以**數量由食材決定** —— 選好食材後數量只有一個可能值。做成兩個選單會假裝有不存在的彈性。

**`monCard` 同時給寶可夢箱和截圖校對區用**（校對區傳 `idx == null`：沒有摺疊列、永遠展開）。兩邊各寫一份的話，校對區看到的就不是進箱子之後的東西。

篩選列還有：**排序**（加入順序／等級高→低／專長／主技能）、**展開／收起全部**（只作用在目前篩選看得到的那些 —— 一次攤開 60 隻要建一萬多個 `<option>`）、**重複偵測**。

**重複的定義是「每一個欄位都相同」**（`dupKey`：物種／等級／性格／五格副技能／三格食材／技能Lv／緞帶）。同物種同等級但副技能不同是完全合法且常見的，所以只有全部一致才算 —— 那幾乎一定是同一隻的截圖看了兩遍。

**任何欄位改動都會 `renderBox()` 重畫整個列表。** 展開時摺疊列還在上面，而它顯示的正是副技能／食材／等級／性格／⚠重複 —— 只改值不重畫，摘要就會和下面的選單不一致。代價是 `select` 的焦點會掉，但 `change` 是「選完才觸發」，可以接受。

### 陷阱：`.mon-edit` 裡的 `flex-basis`

`label.f` 是 flex item，裡面的 `select`／`input` 是 `width:100%`。**如果 label 沒有 `flex-basis`**，那個百分比會回頭對到 `.mon-row`，結果每個欄位都撐成整行寬、一行一個 —— 實際踩過，畫面變成一隻寶可夢佔六行。所以 `.mon-edit .w-sp/.w-nat/.w-num/.w-rib` 都必須給 `flex` 基準值。

### 陷阱：刪除之後的展開狀態

`monOpen` 存的是 roster 索引。`roster.splice(i,1)` 會讓後面的索引整批往前位移，所以 **del 之後一律 `monOpen.clear()`** —— 留著會展開到「原本是下一隻」的那一隻身上。`tests/smoke.mjs` 第 11d 節有斷言。

**食材是「[食材名 選單] ×N（靜態文字）」，不是兩個選單。** 同一格裡食材種類不會重複（`[null,0]` 空欄位除外），所以**數量由食材決定** —— 選好食材後數量只有一個可能值。做成兩個選單會假裝有不存在的彈性。

### 陷阱：`sp` 在序列化格式裡是**內部名**，不是索引

`serialize()` 寫 `sp: D.dex[m.sp].n`（`"VENUSAUR"`），`deserialize` 也照名字找。但**執行時的 `roster` 存的是 dex 索引**，`impSolve` 產出的也是索引 —— 兩種形式長得完全不一樣卻都合法，所以很容易搞混。

**實際踩過（2026-09-08）：** 我把 `impSolve` 的結果直接寫成 JSON 給使用者匯入，`sp` 是索引。舊版 `deserialize` 只做 `findIndex(p => p.n === r.sp)`，數字永遠找不到 → 一律退回 `0`，於是**五隻不同的寶可夢一起變成妙蛙種子**，而畫面上沒有任何提示 —— 等級、性格、副技能都還是對的，所以看起來只是「後面算出來的東西怪怪的」。

修法兩件事都做：`reviveSp` **整數當索引接受**（`impSolve` 的輸出可以直接貼），而真的認不出來就記進 `badSp`，由匯入按鈕**講出來**。索引只在同一份 `game.json` 快照裡穩定，但沒有任何地方會**寫出**索引，所以風險只在貼上那一瞬間。

### 陷阱：`'neutral'` 是 truthy

無修正的性格在 `game.json` 裡是 `p: "neutral"`，**不是空值**。所以 `n.p ? NAT_AB[n.p] : '無修正'` 會走進 true 分支，`NAT_AB['neutral']` 是 `undefined` —— 畫面變成「害羞 **+undefined −undefined**」。25 種性格裡有 5 種中（害羞／勤奮／坦率／浮躁／認真），而且性格選單（`natLabel`）和摺疊列（`natBrief`）**兩處都中**。

所以統一走 `natMod(n)`：只有 `n.p && n.p !== 'neutral'` 才回 `{up, dn}`。`natAb` 對照表查不到的鍵回傳原始鍵，也不會變 undefined。

### 陷阱：刪除沒有 undo

✕ 就在 📌 和 🚫 旁邊，而那兩個是隨手切換用的 —— 手滑一格就少一隻，而 `save()` 是即時的、雲端馬上跟著覆蓋。所以 `del` 一定要 `confirm`，而且**訊息裡要寫出是哪一隻**（`#圖鑑號 名稱 Lv 性格`）—— 排序或篩選過的列表上根本分不出按到誰。📌／🚫 反過來**不該**問（可逆）。

測試裡不要用原生對話框驅動這條路徑：`confirm()` 會擋住 renderer，在 `page.evaluate` 裡容易卡死。第 11d 節是在頁面內把 `window.confirm` 換掉，取消與確定兩條都測。

### 陷阱：篩選後的 `data-i`

`applyBoxFilter` 用 `hidden` 切換而不是重建列表（一張卡有 246 個種類選項，60 隻就是一萬多個 `<option>`，每次打字重建會卡）。所以 **`data-i` 一律是真實的 roster 索引**。

用「篩選後的序號」當索引的話，改一格會改到別隻身上，**而且不會有任何錯誤訊息** —— 只是資料悄悄錯掉。`tests/smoke.mjs` 第 11d 節會刻意讓「篩選後的位置」和「真實索引」不一致，然後斷言改動落在正確的那一隻。

## 雙後端持久層

一份程式碼，執行時自己判斷：

```
window.claude 存在  → claude.use('db') → artifact 資料庫（doc: box/main）
否則 + 已設定同步    → 使用者的 Google Sheet（Apps Script Web App）
否則                → 只有 localStorage
```

`localStorage['psleep-box']` **任何情況下都會寫**，當離線副本。

**存進去的不只是寶可夢箱。** `serialize()` 的 payload 是 `{roster, wk}`，而 `wk` 裡有 `recipeLevels`（78 道食譜的個別等級）—— 所以三個後端都會一起同步。唯一每台裝置各自存的是 Apps Script 的**網址與金鑰**（`psleep-sync-url` / `psleep-sync-token`），以及純檢視狀態（`monOpen` 展開、`boxFlt` 篩選排序），那些刻意不進 `serialize()`。

原本同步面板標題、面板說明、版本面板三處都只寫「寶可夢箱」，而食譜等級那一頁根本沒講 —— 使用者因此以為食譜等級是本機的、換裝置要重填 78 道（實際踩過，直接來問）。所以那句話集中在 `SYNCED_WHAT` ＋ `storageWhere()` ＋ `renderStorageNote()`，四個地方都取同一份，跟 `PATHS` 一樣的道理。

`storageWhere()` **看的是 `backend`（`'artifact'|'sheet'|'local'`），不是 `window.claude` 或 `sync.on`**。後兩者只代表「有設定」；連不上的時候推斷出來的答案是假的，而這句話正是使用者用來決定「要不要設定同步」的依據。`backend` 只在真的往返成功之後才改。

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

### 4. 候選篩選只能是「產品規則」，不能是「效能手段」

`wk.strictBerry`（預設開）：樹果型必須產本週加成樹果才進候選。**這是使用者要的需求**，不是最佳化 —— 實測會讓總能量低 3.9%~6.6%，那是刻意的取捨。細節與量測見 `DECISIONS.md`。

三件事不要動：
- **`wk.fav` 為空時規則不生效** —— 否則會把所有樹果型都排除
- **📌 固定的成員不受此限** —— 使用者的個別指定優先於通則
- **排除名單要顯示出來**（`comboCount` 的文字與 `title`）—— 靜靜地少算候選就是「文案說謊」那類 bug

**絕對不要為了加速而加新的候選篩選。** 這個 repo 已經因此踩過兩次：一次是按 roster 順序的預篩（結果隨箱子順序改變，差 16.34%，已移除），一次是「用 `specialty` 猜價值」（`specialty` 是分類標籤，不是價值來源 —— 樹果型可能因為主技能而有價值）。要壓縮搜尋空間就做**可證明的 branch-and-bound**（樂觀上界剪枝），見 `TODO.md`。

### 5. 搜尋目標與評分目標必須一致

搜尋階段用 `proxyDish`（便宜的樂觀上界），決賽用 `bestPlan`（真實的 21 餐排程）。兩者若脫鉤，最佳隊伍會被擠出決賽名單。

`FINALISTS = 50`（進決賽）、`SHOWN = 8`（顯示）。**改動評分方式時要重新確認 `FINALISTS` 夠不夠大。**

### 6. 記憶化的 context key

`ctxKey()` 決定 `memberOutput` 的快取粒度。加新的 team-level 效果時**一定要加進 `ctxKey`**，否則會拿到別的隊伍組成算出來的結果。`supportEnergy` / `extraHelps` 有量化（`qE` / `qH`）來控制快取爆炸。

### 7. 副技能的欄位解鎖

`SS_SLOT_LV = [10,25,50,70,80]`。`activeSubskills()` 只採計 `m.level >= SS_SLOT_LV[i]` 的欄位 —— **順序有意義**，`m.ss` 的陣列位置就是遊戲裡的欄位位置。

### 8. 文案不能寫死檔名

拆檔時踩過：UI 還在教使用者「替換 `index.html` 裡的 `<script id="gamedata">`」，但那個區塊早就不存在了。README 和這份檔案也各有一處。**讀程式碼看不出來，只有截圖才會發現。**

所以使用者可見文案裡的檔名與指令，一律從 `app.js` 的 `PATHS` 取（`P.data`、`C.rebuild` …），不要寫死字串。`tests/smoke.mjs` 的「文案一致性」那一節會斷言 `PATHS.files` 的每個路徑真的存在、`PATHS.cmds` 的每個指令真的定義在 `package.json`，並反向掃文案裡有沒有 `PATHS` 以外的硬寫路徑。

### 9. 資料與程式的版本偏移

`app.js` 的 `SCHEMA` 必須等於 `data/game.json` 的 `meta.schema`。**動到資料的欄位結構時兩邊一起 +1**（純數值更新不用動），`tools/extract-data.mjs` 裡也有一份要同步。

理由：拆檔後 `app.js` 與 `game.json` 是兩個獨立快取的資源，GitHub Pages 送 `max-age=600`，所以更新後有最多 10 分鐘的窗口會拿到「新程式 ＋ 舊資料」。不擋的話使用者只會看到壞頁面或錯的數字，不知道重新整理就好。

**`app.css` 與 `src/*.js` 之間也有同樣的偏移，但它們沒有 schema 可以斷言。** 實際踩過一次：改完箱子版面之後，瀏覽器拿到新的 `index.html`（篩選列出現了），但 `app.js` 和 `app.css` 都還是舊快取 —— 畫面看起來像「你根本沒改」。而且從截圖才看得出來：種類選單顯示 `大食花　#71 Vi…`（新版沒有英文名）、副技能顯示 `技能…`（新版用全名）。

所以資源都帶 `?v=` 版本號，而且**三處必須一致**：

| 位置 | 用途 |
|---|---|
| `index.html` `<head>` 的 `app.css?v=…` | CSS 的快取破除 |
| `index.html` 載入器裡的 `ASSET_V` | 加到三個 `src/*.js` 的 query，並放到 `window.ASSET_V` |
| `src/app.js` 的 `APP_V` | app.js 自己的版本；和 `window.ASSET_V` 不符就 `fatal()` |

第三個是關鍵：光靠 `?v=` 只是**降低**拿到舊檔的機率，`APP_V` 的斷言才能保證「過期的 app.js 不會靜靜地畫出舊版 UI」。第二次踩到就是因為只有前兩個 —— CSS 更新了、JS 沒更新，畫面看起來像沒改。

**動到 `app.css` 或 `src/*.js` 就把版本號往前推（三個地方一起改）。** 純資料更新不用動。`tests/smoke.mjs` 第 11 節會斷言三處一致，並且斷言跑起來的那一份真的相符。

### 10. 遊戲顯示的主技能等級是「加成後」，`m.skillLv` 是「基礎值」

`baseStats` 算的是 `skillLv = clamp(m.skillLv + (Skill Level Up M?2:0) + (Skill Level Up S?1:0))`，所以 `m.skillLv` 存的是**基礎值**。但遊戲的技能卡顯示的是**加成後**的等級 —— 大食花畫面上是 `Lv.6` 且帶「技能等級提升M」，基礎值其實是 **4**。直接把畫面數字存進 `m.skillLv` 會讓技能產出高估兩級。

而且**不能靠「假設遊戲顯示的是加成後」來反推** —— 那是猜的。真憑據是技能說明裡的數字：

| 畫面 | 資料 | 結論 |
|---|---|---|
| 活力填充S Lv.6「回復活力43」 | `ms['Charge Energy S'].energy[5] = 43.4` | 有效等級 = 6 |
| 食材獲取S Lv.3「隨機獲得11個食材」 | `ms['Ingredient Magnet S'].ingredient[2] = 11` | 有效等級 = 3 |

所以 `impEffFromPayload` 用說明數字**反查**有效等級，再減掉副技能加成得到基礎值。有效等級已達上限時基礎值只能推到下界，但那時候再高也一樣（`clamp` 會壓回上限），不影響計算 —— UI 會把這件事寫出來。

妙蛙花是第二個獨立憑據，而且方向相反：畫面 `食材獲取S Lv.5`、說明「隨機獲得17個食材」（`ingredient[4] = 17` → 有效 5）、而「技能等級提升M」在第 3 格（Lv50 解鎖）且牠 Lv61 **加成生效**。畫面顯示的 5 正好等於有效等級 → 基礎值 3。

### 範圍型技能：區間就是 `[v/2, 2v]`

遊戲對某些能量填充類技能顯示的是一個**區間**，而快照只存一個固定值：

| 畫面 | 快照 | 關係 |
|---|---|---|
| 能量填充S Lv.3「卡比獸的能量增加393〜1,570」 | `ms['Charge Strength S'].strength[2] = 785` | `393 = round(785/2)`、`1570 = 785×2` |
| 能量填充S Lv.2「卡比獸的能量增加285〜1,138」 | `strength[1] = 569` | `285 = round(569/2)`、`1138 = 569×2` |

所以 `impEffFromPayload` 是**兩段式**：第一段拿 payload 精確比對；只有第一段一個都對不到時才啟用第二段（拿 `v/2` 與 `2v` 比）。這樣原本就有唯一解的情形完全不受影響，而區間的兩端都反解得出來。

**這個放寬一定要有全域掃描擋著。** 錯的技能等級**不會讓任何校驗碼破掉**（幫忙間隔與持有上限都不吃 `skillLv`），所以沒有測試就沒人擋得住。第 11b 節會掃過 `D.ms` 全部技能 × 全部等級的兩端並斷言「唯一但錯 = 0 筆」（目前是唯一且正確 298、多解退回 126、精確比對就有解 146）。

**改動 `import.js` 的主技能等級推導時，七隻 golden case 都要重跑。**

### 陷阱：還沒解鎖的食材格也一定要解

`baseStats` 只讀 `slots = min(floor(level/30)+1, 3)` 格。所以 `impIngSets` 原本會跳過超出的格子，讓它留在預設的「選項 0」。

**實際踩過：** 耿鬼 Lv50 的第 3 格畫面預告的是「品鮮蘑菇×6」，跳過的話會存成「火辣香草×7」。而因為那格還沒生效，**兩個校驗碼、樹果顆數、任何產出數字都不會變** —— 一路等到升上 Lv.60 才會發現，而那時候已經沒有截圖了。

遊戲畫面本來就把它預告出來（🔒Lv.60 加食材圖與 ×N），所以 `ingCounts[2]` 本來就有那個數字：三格一律用 ×N 收斂，回傳的 `slots` 只給 UI 標「這格還不生效」。同理，箱子卡片的未解鎖食材格是**變淡但照樣顯示、照樣可改**（和副技能同一個處理方式）—— 以前是 `disabled` ＋ 顯示「未解鎖」，結果截圖校對時那一格根本改不動。

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
npm test                         # smoke：引擎、單調性、窮舉不變量、雙後端、Sheet 往返（含離線沖出與失敗重試）、Worker、截圖匯入、箱子篩選／排序／重複偵測、JSON 追加／取代、文案與資源版本一致、schema 偏移
npm run verify                   # 慢速（數分鐘）：大箱子的順序不變性、FINALISTS 夠不夠
```

`run()` 是**非同步**的（推演跑在 Worker 裡）。測試等結果時**不要用 `waitForTimeout`** —— 在慢一點的機器上會 flaky。用 `smoke.mjs` 裡的 `doRun()` 輔助函式，它會先清掉 `lastResults` 再等它被填回來。

`tests/smoke.mjs` 會**自己起一台靜態 server**（因為資料改用 fetch 之後不能再用 `file://` 載入），所以 CI 不需要額外的 server step。

Chromium 由 `tests/chromium.mjs` **自動尋找** —— playwright-core 下載的那份、系統裝的 Chrome/Edge、容器路徑都會試。要指定才設 `CHROMIUM` 環境變數。

（別把 `CHROMIUM=...` 前綴當成常規用法：那會讓 `.claude/settings.json` 的 `Bash(npm test)` 允許規則匹配不到，每次都得手動確認。）

CI 在 `.github/workflows/ci.yml`，push / PR 都會跑。

**測試對公式係數的覆蓋是「一半」，要知道缺哪一半。**

截圖匯入那一節（第 11b）是目前唯一有**絕對數值**的斷言 —— **七隻**真實寶可夢的幫忙間隔與持有上限是逐欄手算對照過的期望值，不是程式算完存回去的：

| 隻 | 等級／性格 | 幫忙間隔 | 持有上限 | 緞帶 | 這隻壓的邊界 |
|---|---|---|---|---|---|
| 大食花 | 60 頑皮 | 1911s | 35 | 4 | 進化階段（喇叭芽／口呆花的基礎頻率不同） |
| 水箭龜 | 62 馬虎 | 2458s | 65 | 4 | `Inventory Up M`＋`L`；食材第 3 格歧義 |
| 嘎啦嘎啦 | 55 害羞 | 2943s | 26 | 3 | **無修正性格**（`nat.f = 1`）；食材第 2 格歧義 |
| 耿鬼 | 50 怕寂寞 | 1410s | 40 | 3 | **範圍型主技能**；**未解鎖的第 3 格** |
| 嘟嘟利 | 53 害羞 | 1772s | 50 | 3 | 主技能 Lv.1（下界）；`Inventory Up L` |
| 隆隆岩 | 60 怕寂寞 | 1944s | 27 | **1** | `RIBBON_CARRY` 的 `+1`（其他六隻都不是 1） |
| 妙蛙花 | 61 樂天 | 2464s | 35 | 4 | 技能等級加成**生效**時的基礎值推導 |

還有**第三個獨立校驗碼**：畫面上的「樹果 ×N」（樹果專長 2 顆 ＋ `Berry Finding S` 1 顆）。它不吃幫忙間隔也不吃持有上限，所以壓的是 `berriesPerDrop` 那條路徑。

所以動到這些會紅：

- `helpInterval` 的 `1 - 0.002*(level-1)`、`2 - nat.f`、幫忙速度副技能的 `0.14 / 0.07`、`ribbonFreqMul`
- `baseStats` 的 `carry` 算式、`RIBBON_CARRY`、`Inventory Up S/M/L` 的 `6/12/18`
- `berriesPerDrop` 的 `(berry||all ? 2 : 1) + (Berry Finding S ? 1 : 0)`
- 性格與副技能的數值表

**但能量／模擬／料理那一側還是沒有絕對基準。** 把 `energyF` 的 `0.45` 改成 `0.50` 依然全過 —— 那條路徑不影響幫忙間隔也不影響持有上限。要擋住那一半還是得做**引擎輸出的快照測試（golden file）**，見 `TODO.md` 第 2 項。

動引擎時的臨時替代做法：改之前先跑一次固定 seed、記下 `lastResults[0].total`，改完再比。Worker 重構就是這樣驗證數值等價的（`804479.78`，前後完全一致）。
