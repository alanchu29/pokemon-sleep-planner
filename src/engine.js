"use strict";
/* 純引擎 —— window 與 Worker 兩種環境都會載入這個檔。

   規則：
   1. 絕對不要碰 DOM。這裡的每一行都要能在 Worker 裡跑。
   2. 不要讀 app.js 的狀態（roster / wk / lastResults）。需要什麼就當參數收。
      Worker 裡沒有那些全域，讀了會 ReferenceError。
   3. `self` 在 window 和 Worker 裡都是全域物件，所以 self.GAMEDATA 兩邊都通。

   載入順序：主執行緒由 index.html 的 loader 在 app.js 之前注入；
   Worker 由 engine.worker.js 用 importScripts 載入（資料先塞進 self.GAMEDATA）。

   這是 classic script，不是 module —— 頂層宣告要留在全域，app.js 和
   tests/smoke.mjs 都直接用這些名字。詳見 CLAUDE.md。 */
const D = self.GAMEDATA;
if (!D || !D.ings || !D.dex || !D.recipes || !D.ms) {
  throw new Error('engine.js: self.GAMEDATA 不完整 —— 載入順序錯了，或 data/game.json 壞了');
}
/* 這一份 engine.js 的資源版本。必須等於 index.html 的 ASSET_V 與 app.js 的 APP_V。
   為什麼引擎也要有一份：`?v=` 只降低拿到舊檔的機率，而 **Worker 是唯一沒被
   ASSET_V 擋到的路徑** —— 主執行緒載新引擎、worker 載到快取的舊引擎時，
   搜尋（worker）與 rehydrate／決賽（主執行緒）會用兩套不同的公式，
   不會報錯，只會靜靜地算出對不起來的分數。app.js 會比對這個值。 */
const ENGINE_V = '20260911b';

const ING_NAME = D.ings.map(x=>x[0]);
const ING_VAL  = D.ings.map(x=>x[1]);
const NING = ING_NAME.length;
const BERRY_VAL = Object.fromEntries(D.berries);
const BERRY_NAMES = D.berries.map(b=>b[0]);
const NAT = Object.fromEntries(D.natures.map(n=>[n.n,n]));
const SS = Object.fromEntries(D.subskills.map(s=>[s.n,s]));
const SS_SLOT_LV = [10,25,50,70,80];
const RIBBON_CARRY = [0,1,3,6,8];
/* 料理大成功。上游把它拆得很清楚（common/src/types/constants.ts）：
     平日 10% 機率、能量 x2；週日 30% 機率、能量 x3
   一週 21 餐 = 18 平日 + 3 週日，加權起來
     (18*(1+0.1*1) + 3*(1+0.3*2)) / 21 = 24.6/21 = 1.171428571
   —— 正好等於底下這個常數，所以 AVG_CRIT 不是烘死的魔術數字，它是這組機率的期望值。
   **拆出來的理由**：有了機率本身，「大成功機率 +N 個百分點」（料理機率提升S、以及
   本週活動加成）才算得出來；只有平均倍率的話那種加成無從下手。 */
const CRIT_MEALS   = [18, 3];        // 平日 / 週日的餐數，合計 MEALS_WEEK
const CRIT_CHANCE  = [0.10, 0.30];   // 各自的基礎大成功機率
const CRIT_GAIN    = [1, 2];         // 各自大成功時「多出來」的倍率（x2 -> +1、x3 -> +2）
const AVG_CRIT = 1.171428571;
/** 一週平均的大成功倍率；`add` 是額外的大成功**機率**（0~1，加在基礎機率上）。
 *
 *  ⚠ `add === 0` 時直接回傳 AVG_CRIT 那個既有常數，**不是重算** —— 重算會得到
 *  1.1714285714285714，和寫死的 9 位小數差 4e-10，足以讓「沒有活動、沒有料理機率
 *  技能時逐位不變」那條回歸斷言變紅。差的是常數的精度，不是模型。 */
function critMultiplier(add){
  if (!add) return AVG_CRIT;
  let base = 0, now = 0;
  for (let i=0;i<2;i++){
    base += CRIT_MEALS[i] * CRIT_CHANCE[i] * CRIT_GAIN[i];
    now  += CRIT_MEALS[i] * Math.min(1, CRIT_CHANCE[i] + add) * CRIT_GAIN[i];
  }
  return AVG_CRIT + (now - base) / MEALS_WEEK;
}
/* 一天煮幾餐。`critAdd` 要除以它 —— 見 memberOutput 裡那一段。 */
const MEALS_DAY = 3;
// Helper Boost extra helps: rows = unique species on the team sharing its berry (1-5)
const HB_TABLE = [[2,3,3,4,4,5],[2,3,3,4,5,6],[3,4,5,6,7,8],[4,5,6,7,8,9],[6,7,8,9,10,11]];
/* 屬性清單（內部名）。上游的 dex **沒有屬性欄位**，這份來自 tools/types.txt ——
   和 zh 對照表同一個性質：repo 自己維護、重建時不能弄丟。
   兩個主技能吃屬性：夢魘看惡屬性（BAD_DREAMS_DRAIN）、流星群看隊上的龍屬性種類數。 */
const DARK   = new Set((D.types && D.types.dark)   || []);
const DRAGON = new Set((D.types && D.types.dragon) || []);
/* 上游快照沒有、但遊戲技能頁有的主技能數值表（來自 tools/skills-extra.json）。
   目前只有流星群的基礎樹果表：外層 = 主技能等級 1..6，內層 = 隊上不同種類的龍屬性數 1..5。 */
const MS_EXTRA = D.msExtra || {};
/* 夢魘（能量填充M）：「卡比獸的能量增加 (#1)，且讓幫手隊伍中**惡屬性以外**的
   寶可夢活力下降 12。」—— 遊戲技能說明上的數字，**固定值，不隨技能等級變**
   （加成那一欄才隨等級，就是快照裡的 strength）。上游快照沒有這一欄。 */
const BAD_DREAMS_DRAIN = 12;
/* 治癒波動（活力療癒S）一次打 2 隻 —— 見 rawPayload。一般的活力療癒S 是 1 隻。 */
const HEAL_PULSE_TARGETS = 2;
/* ---- 專家模式（EX 營地）-------------------------------------------------
   上游把 EX 寫成 EventBuilder **函式**（common/src/events/events/*-expert-mode.ts）
   而不是資料，所以 tools/extract-data.mjs 抽不出 JSON —— 和 BAD_DREAMS_DRAIN 同一個
   處理方式：數值寫在這裡，出處寫在註解。

   萌綠之島EX 的數字有遊戲內說明截圖當憑據（使用者 2026-09-11 提供）：
     「撿來卡比獸喜歡的樹果（**主要**）的寶可夢，幫忙能力會提升
        ・幫手寶可夢的幫忙間隔縮短 10%
        ・幫手寶可夢發動的主技能等級提升 1
      不撿來卡比獸喜歡的樹果的寶可夢，幫忙能力會降低
        ・幫手寶可夢的幫忙間隔延長 15%」
   天青沙灘EX（×0.8／×1.35／攜帶 +5）**只有上游程式碼**，沒有截圖確認。

   ⚠ 三檔的分界是「主要 / 其他喜好 / 非喜好」—— **副喜好樹果既不加速也不被罰**。
   做成「一組 EX 樹果」的話，那 10% 會攤給三種樹果，等於憑空多算兩種樹果型的速度。 */
const EX_ISLANDS = {
  GGEX: {base:'greengrass', mainFreq:0.90, offFreq:1.15, mainSkillLv:1, mainCarry:0},
  CBEX: {base:'cyan',       mainFreq:0.80, offFreq:1.35, mainSkillLv:1, mainCarry:5},
};
/* 隨機的 EX 營地效果。遊戲內說明：「**每次移動到EX營地時**，都會有 1 種隨機的營地
   效果生效」—— 所以它不是「本週」的，標籤上不要那樣寫。三種擇一：
     berry      —「卡比獸喜歡的樹果」帶來的能量增加量會變成 2.4 倍
     ingredient — 喜好樹果者平常幫忙撿來的食材 +1 個；**專長為食材**的有時候再額外 +1
     skill      — 喜好樹果者的主技能發動機率變成 1.25 倍
   ⚠「有時候」遊戲沒有給機率，上游取 50%（rollExpertIngredientBonus），所以這裡用
     期望值 +0.5。**那是上游的假設，不是查到的數字** —— 已知簡化要寫出來。 */
const EX_BONUSES = ['berry', 'ingredient', 'skill'];
const EX_FAV_BERRY_MUL = 2.4;
const EX_ING_ADD = 1;
const EX_ING_SPECIALIST_EV = 0.5;
const EX_SKILL_MUL = 1.25;
const FAV_BERRY_MUL = 2;

/** 這一份週設定是不是 EX 營地；不是就回 null。**單一真實來源是 `wk.island`** ——
 *  不另外開一個 `wk.ex` 布林，同一件事有兩個來源就一定會有一個在說謊。 */
const exOf = wk => (wk && EX_ISLANDS[wk.island]) || null;
/** EX 營地下這一隻屬於哪一檔：`'main'`（主要樹果）／`'fav'`（其他喜好樹果）／
 *  `'off'`（非喜好樹果）。非 EX 島一律 null —— 所以 `SCORE_WK`（連 `island` 欄位都
 *  沒有）與截圖匯入（`wk` 只有 `camp`）**自動**不受影響，不必另外加判斷。 */
function exTier(wk, berry){
  const ex = exOf(wk); if (!ex) return null;
  if (wk.favMain && berry === wk.favMain) return 'main';
  return (wk.fav && wk.fav.has(berry)) ? 'fav' : 'off';
}
/** 加成樹果倍率（EX 的「樹果」營地效果會把它從 2 抬到 2.4）。
 *  **兩個地方都要走這一份**：`memberOutput` 的 `favMul`，以及 `teamContext` 的
 *  `mateBerryPow`（發給隊友的樹果算的是隊友自己的樹果與**隊友自己的**加成倍率）。
 *  漏掉後者就是 CLAUDE.md 6h 那個 bug 的翻版 —— 而且一樣不會報錯。 */
function favBerryMul(wk, berry){
  if (!wk.fav || !wk.fav.has(berry)) return 1;
  return (exOf(wk) && wk.exBonus === 'berry') ? EX_FAV_BERRY_MUL : FAV_BERRY_MUL;
}
/* ================= 本週活動加成（自訂） =================
   遊戲會辦期間限定的活動：主技能發動機率上升、樹果能量上升、食材獲得量上升、
   料理能量上升、大成功機率上升。數值每次活動都不一樣，所以這一組**沒有內建表**，
   由使用者自己勾選並輸入。

   ⚠ 和 `wk.areaBonus`（地區加成）的分別：`areaBonus` 是乘在樹果＋技能＋料理
   **全部**上面的總乘數，表示不出「只有料理 +25%」這種活動。所以這五項是分項的。

   ⚠ 和 EX 營地效果（`wk.exBonus`）的分別：EX 那三種是固定數值、而且**只打喜好
   樹果**；活動加成打全員、任何島都生效。兩者**獨立相乘**（使用者 2026-09-11 指定），
   所以畫面上一定要把合成後的倍率寫出來，例如樹果能量 x2.4 x1.2 = x2.88。

   `evt` 這個欄位不存在時（`SCORE_WK` 個體產能、截圖匯入的 `wk` 只有 `camp`）
   `evtPct` 一律回 0 —— 和 `exOf` 同一個手法，那兩條路徑不必加任何判斷。
   個體產能刻意不吃（使用者 2026-09-11：「箱子裡呈現的都是個體的預設，與該週的任何
   條件無關」）。 */
const EVT_KEYS = ['skill', 'berry', 'ing', 'dish', 'crit'];
/** 勾起來時的數值，沒勾或沒有這個欄位一律 0。
 *  前四項的單位是**百分比**（+N% -> 乘 1+N/100），`crit` 是**百分點**（加在機率上）。 */
function evtPct(wk, key){
  const e = wk && wk.evt && wk.evt[key];
  if (!e || !e.on) return 0;
  const v = +e.v;
  return v > 0 ? v : 0;
}
/** 前四項用的乘數。 */
const evtMul = (wk, key) => 1 + evtPct(wk, key)/100;

const MAGNET_POOL = ING_NAME.map((n,i)=>i).filter(i=>ING_NAME[i]!=='Tail');
const MEALS_WEEK = 21;
/* 白天平均多久上線收取一次（小時）。**這個遊戲不會自動收取**，所以產出是按
   「兩次收取之間」結算的，每一段都有背包上限與主技能累積上限 —— 見 `simulate`。 */
const DEFAULT_COLLECT_H = 4;

/* ================= ENGINE ================= */
const energyF = e => e>=80?0.45 : e>=60?0.52 : e>=40?0.58 : e>=1?0.66 : 1.00;
const mealRecovery = e => e>=81?1 : e>=71?2 : e>=61?3 : e>=51?4 : e>=41?5 : e>=31?6 : e>=21?7 : e>=11?8 : 9;
const round4 = x => Math.round(x*1e4)/1e4;
function berryPower(name, level){
  const v = BERRY_VAL[name];
  return Math.round(Math.max(v + (level-1), v*Math.pow(1.025, level-1)));
}
function ribbonFreqMul(r, remainingEvo){
  if (!remainingEvo || r<2) return 1;
  if (r>=4) return remainingEvo>=2 ? 0.75 : 0.88;
  return remainingEvo>=2 ? 0.89 : 0.95;
}
function activeSubskills(m){
  const out = [];
  for (let i=0;i<5;i++){
    const nm = m.ss[i];
    if (nm && m.level >= SS_SLOT_LV[i]) out.push(nm);
  }
  return out;
}
/** Static (context-free) per-member stats. */
function baseStats(m, wk){
  const p = D.dex[m.sp], nat = NAT[m.nature] || NAT.Bashful;
  const act = activeSubskills(m);
  const h = nm => act.includes(nm);
  /* EX 營地（專家模式）。非 EX 島時 `exT` 是 null，底下每一項都退回原本的值 ——
     所以個體產能（`SCORE_WK` 沒有 `island`）與截圖匯入（`wk` 只有 `camp`）**逐位不變**。 */
  const ex = exOf(wk), exT = ex ? exTier(wk, p.b) : null;
  const exFav = exT === 'main' || exT === 'fav';
  /* 上游把修正打在**種族頻率**上（`pokemon.frequency` ×0.9／×1.15），所以這裡也先乘
     進 `freq`，再交給 `helpInterval` 的 floor 與底下的 `pity` —— 順序跟上游一致。 */
  const freq = p.f * (exT === 'main' ? ex.mainFreq : exT === 'off' ? ex.offFreq : 1);
  const invAdd = (h('Inventory Up S')?6:0)+(h('Inventory Up M')?12:0)+(h('Inventory Up L')?18:0);
  /* 天青沙灘EX 的主要樹果持有上限 +5。和 `invAdd`／`RIBBON_CARRY` 同一層（種族值那一
     層），所以會一起吃到好露營券的 ×1.2 —— 上游也是加在 `pokemon.carrySize` 上。 */
  const carry = Math.ceil((p.cs + 5*p.pe + invAdd + RIBBON_CARRY[m.ribbon||0]
                           + (exT === 'main' ? ex.mainCarry : 0)) * (wk.camp?1.2:1));
  const ingChance = Math.min(1, (p.ip/100) * nat.i * (1 + (h('Ingredient Finder S')?0.18:0) + (h('Ingredient Finder M')?0.36:0)));
  const berriesPerDrop = ((p.sp==='berry'||p.sp==='all')?2:1) + (h('Berry Finding S')?1:0);
  const slots = Math.min(Math.floor(m.level/30)+1, 3);
  // average ingredient vector per ingredient-help (already /slots)
  const opts = [p.i0, p.i30, p.i60];
  const ingVec = new Float64Array(NING);
  let avgIngAmt = 0;
  /* EX 的「食材」營地效果：喜好樹果者平常幫忙撿來的食材 +1 個，專長為食材的再加上
     「有時候額外 +1」的期望值（上游把「有時候」當 50%，見 EX_ING_SPECIALIST_EV）。
     ⚠ 它同時會讓 `avgIngAmt` 變大 → `dropPerHelp` 變大 → **背包更快滿**
     （`helpsTillFull`），所以成員卡上的「背包裝滿 N」與整隊的「建議收取間隔」會跟著
     縮短。那是對的，不是 bug —— 一次幫忙帶回來的東西真的變多了。 */
  const exIngAdd = (ex && wk.exBonus === 'ingredient' && exFav)
    ? EX_ING_ADD + (p.sp === 'ingredient' ? EX_ING_SPECIALIST_EV : 0) : 0;
  /* 本週活動「食材獲得量 +N%」。**乘在含 EX 那 +1 之後的總量上**（使用者 2026-09-11
     指定）—— 活動的語意是「你這次幫忙撿到的東西變多」，而 EX 那一顆已經是你撿到的
     一部分。火辣香草 x7 + EX 的 1 + 活動 20% = 9.6 個，不是 9.4 個。
     ⚠ **只打幫忙撿來的這一條路徑**（使用者指定：「技能跟撿的是不同的」）——
     主技能灑出來的食材（`pay.ingSpread`，食材獲取S／怪力鉗那類）不吃這個加成。 */
  const evtIngMul = evtMul(wk, 'ing');
  for (let s=0;s<slots;s++){
    const list = opts[s] || [];
    const pick = list[Math.min(m.ingSet[s]||0, list.length-1)];
    if (!pick) continue;
    ingVec[pick[0]] += (pick[1]+exIngAdd)*evtIngMul/slots;
    avgIngAmt += (pick[1]+exIngAdd)*evtIngMul/slots;
  }
  const skillLvMax = (D.ms[p.ms]||{max:6}).max;
  /* 主要樹果的「發動的主技能等級提升 1」。放在 clamp 之內 —— 已經滿級的不會超出。 */
  const skillLv = Math.max(1, Math.min(skillLvMax, (m.skillLv||1) + (h('Skill Level Up M')?2:0) + (h('Skill Level Up S')?1:0)
                                                   + (exT === 'main' ? ex.mainSkillLv : 0)));
  /* 本週活動「主技能發動機率 +N%」。和 EX 的 x1.25 同一處、獨立相乘。
     **一定要 clamp 到 1**：底下 `effSkill` 的保底公式含 `(1-skillChance)^(pity+1)`，
     機率超過 1 會讓底數變負數，偶次方又變正，算出來的是垃圾而且不會報錯。
     原本沒有 clamp 是因為 `p.sk/100` 最大約 0.2、副技能與性格頂多再翻一倍多；
     活動加成可以輸到 +300%，所以這道門現在是必要的。 */
  const skillChance = Math.min(1, (p.sk/100) * (1 + (h('Skill Trigger S')?0.18:0) + (h('Skill Trigger M')?0.36:0)) * nat.s
                      * (ex && wk.exBonus === 'skill' && exFav ? EX_SKILL_MUL : 1)
                      * evtMul(wk, 'skill'));
  const pity = p.sp==='skill' ? Math.floor(144000/freq) : 78;
  const effSkill = skillChance<=0 ? 0 : skillChance/(1 - Math.pow(1-skillChance, pity+1));
  const natureFreqMul = 2 - nat.f;
  return {p, nat, act, h, freq, exTier: exT, carry, ingChance, berriesPerDrop, slots, ingVec, avgIngAmt, dark: DARK.has(p.n), dragon: DRAGON.has(p.n),
          skillLv, effSkill, natureFreqMul, hasHB:h('Helping Bonus'), hasERB:h('Energy Recovery Bonus'),
          ribbonMul:ribbonFreqMul(m.ribbon||0, p.re)};
}
const WILDCARD = /^(Metronome|Versatile|Skill Copy|Mimic \(|Transform \()/;
/** 這個主技能會不會「發樹果給隊友」（樹果遽增 Berry Burst／流星群 Draco Meteor，
 *  以及萬用技能平均進去的那一份）。
 *
 *  存在的理由是效能：隊友那一份要用**每個隊友自己的樹果**來算（見 memberOutput），
 *  所以 `teamContext` 要多算一個 `mateBerryPow`。但那個值幾乎每一隊都不同，
 *  無條件放進 `ctxKey` 會讓 `memberOutput` 的記憶化整個失效（33k 組的搜尋靠它）。
 *  所以只有隊上真的有這種技能時才算，其餘維持 0 —— 絕大多數隊伍的快取粒度不變。 */
const givesTeamBerry = ms => !!(D.ms[ms] && D.ms[ms].teamBerry) || /^Draco Meteor/.test(ms) || WILDCARD.test(ms);
const BASE_SKILLS = Object.keys(D.ms).filter(n =>
  !WILDCARD.test(n) && !/Range$/.test(n) && !/\(/.test(n) && Object.keys(D.ms[n]).length > 1);
const wildcardCache = {};
/** Metronome, Skill Copy and Versatile resolve to some other skill each proc —
 *  approximate them as the mean payload of the base skills at the same level. */
function wildcardPayload(lv){
  if (wildcardCache[lv]) return wildcardCache[lv];
  const acc = {}; let n = 0;
  for (const nm of BASE_SKILLS){
    const pay = rawPayload(nm, lv);
    for (const k of Object.keys(pay)) acc[k] = (acc[k]||0) + pay[k];
    n++;
  }
  for (const k of Object.keys(acc)) acc[k] /= n;
  return (wildcardCache[lv] = acc);
}
/** Classify a main skill into what it contributes per proc. */
function skillPayload(msName, lv){
  if (WILDCARD.test(msName)) return {...wildcardPayload(lv), wild:1};
  return rawPayload(msName, lv);
}
function rawPayload(msName, lv){
  const s = D.ms[msName]; if (!s) return {};
  const at = a => a && a[Math.min(lv,a.length)-1] || 0;
  const o = {};
  if (s.strength)         o.strength = at(s.strength);
  if (s.averageStrength)  o.strength = at(s.averageStrength);
  if (s.ingredient)       o.ingSpread = at(s.ingredient);
  if (s.bonusIngredient)  o.ingBonus = at(s.bonusIngredient);   // 有夥伴才給，見 memberOutput
  if (s.energy)           o.energySelf = at(s.energy);
  if (s.potSize)          o.pot = at(s.potSize);
  if (s.selfBerry)        o.selfBerry = at(s.selfBerry);
  if (s.teamBerry)        o.teamBerry = at(s.teamBerry);
  if (s.help)             o.helpsOne = at(s.help);
  /* 治癒波動的「額外幫忙(樹果或食材)」。和幫手支援S 的 `help` 同一個概念（給一隻隊友），
     所以走同一個 `helpsOne`。`latiosHelps` 是**加碼**，不是取代 —— 遊戲的技能頁
     直接寫「基礎 + 額外 = 總計」，而且 helps+latiosHelps 逐級等於那個總計欄
     （1+1=2、2+1=3、2+2=4、3+2=5、4+2=6、4+3=7）。 */
  if (s.helps)            o.helpsOne = at(s.helps);
  if (s.latiosHelps)      o.helpsWithLatios = at(s.latiosHelps);
  if (s.base)             o.helpsAll = at(s.base);
  /* 欄位名稱本身就說明它是條件式的（`latiasBerries` ＝「有拉帝亞斯時的樹果」）。
     以前這裡無條件當成 selfBerry，等於拉帝歐斯單獨上場也照領。見 memberOutput。 */
  if (s.latiasBerries)    o.berryWithLatias = at(s.latiasBerries);
  if (/Energy For Everyone/.test(msName)) { o.energyTeam = o.energySelf||0; delete o.energySelf; }
  /* 活力療癒S 系列打**隨機幾隻**，`energy` / `helps` / `latiosHelps` 都是「每一隻」的量。
     一般的活力療癒S 是 1 隻；**治癒波動是 2 隻** —— 遊戲內說明（拉帝亞斯，主技能Lv.1）：
     「隨機讓隊伍的 2 隻寶可夢回復活力 6，並讓牠們立刻完成 1 次幫忙。
       隊伍中有拉帝歐斯時，還會讓牠們再立刻完成 1 次幫忙。」
     所以那三欄都要乘上目標數。以前一律當 1 隻，治癒波動因此被低估一半。
     ⚠ 目標數只在 Lv.1 的說明裡看到（技能頁的資料表沒有這一欄，所以推測不隨等級變）。 */
  if (/Energizing Cheer/.test(msName)){
    const tg = /^Heal Pulse/.test(msName) ? HEAL_PULSE_TARGETS : 1;
    o.energyTeam = (o.energySelf||0)*tg/5; delete o.energySelf;
    if (o.helpsOne)        o.helpsOne *= tg;
    if (o.helpsWithLatios) o.helpsWithLatios *= tg;
  }
  if (s.chance)           o.critChance = at(s.chance);
  return o;
}
/** Helper interval in seconds.
 *
 *  Split out of `simulate` so the screenshot importer (`src/import.js`) can reuse
 *  the *same* expression instead of keeping a second copy — the in-game Pokémon
 *  detail screen shows exactly this number, which makes it a checksum on an
 *  imported member. Two copies of this formula would drift; one would then be
 *  silently wrong. `nHB` is the number of teammates carrying Helping Bonus, so
 *  the solo value the game displays is `nHB = 0`. */
function helpInterval(bs, m, wk, nHB){
  const helpSS = Math.max(0.65, 1 - (bs.h('Helping Speed M')?0.14:0) - (bs.h('Helping Speed S')?0.07:0) - 0.05*Math.min(5, nHB));
  const levelFactor = 1 - 0.002*(m.level-1);
  /* `bs.freq` 而不是 `bs.p.f` —— EX 營地的頻率修正已經乘在種族頻率上（見 baseStats）。
     非 EX 島時 `bs.freq === bs.p.f`，所以舊行為逐位不變。 */
  return Math.floor(round4(bs.natureFreqMul * helpSS * levelFactor * bs.ribbonMul) * bs.freq / (wk.camp?1.2:1));
}
/** Simulate one member's day. ctx = {nHB,nERB,supportEnergy (per day, to each member), extraHelps}
 *
 *  `selfEnergy` ＝ **只回給這一隻自己**的活力（活力填充S／月光／萬用技能平均進去的
 *  那一份），每日總量。
 *
 *  **不能併進 `ctx.supportEnergy`** —— 那是「隊上每個人都拿到一樣多」的量，而
 *  `energyF` 是階梯函數（80以上 ×0.45 … 0 ×1.00），所以「集中給一個人」和
 *  「攤平給五個人」差非常多。這和夢魘的扣活力是完全同一條規則（見 CLAUDE.md 陷阱 6c）：
 *  **只有某些人拿到的量，不可以走那條共用管道。** */
function simulate(bs, m, wk, ctx, selfEnergy){
  const freqBase = helpInterval(bs, m, wk, ctx.nHB);
  const sleepMin = Math.round(wk.sleepH*60), wakeMin = 1440 - sleepMin;
  const cap = bs.hasERB ? 105 : 100;
  const nSteps = Math.floor(wakeMin/10);
  /* 夢魘的扣活力**只打在惡屬性以外的隊友身上**，所以不能併進共用的 supportEnergy
     （那是「每個人都拿到一樣多」的量）。惡屬性隊友（含達克萊伊自己）免疫。 */
  const drain = bs.dark ? 0 : (ctx.darkDrain || 0);
  const supportPerStep = nSteps>0 ? (ctx.supportEnergy + drain + (selfEnergy||0))/nSteps : 0;
  let start = 0, helpsDay = 0, helpsNight = 0, fastSteps = 0, totalSteps = 0;
  for (let iter=0; iter<4; iter++){
    const rec = Math.min(cap, sleepMin*(100/510)*bs.nat.e*(1 + 0.14*Math.min(5, ctx.nERB)));
    let e = Math.min(150, start + rec);
    helpsDay = 0; helpsNight = 0; fastSteps = 0; totalSteps = 0;
    const mealAt = [Math.floor(wakeMin*0.12/10)*10, Math.floor(wakeMin*0.45/10)*10, Math.floor(wakeMin*0.8/10)*10];
    for (let t=0; t<wakeMin; t+=10){
      if (e >= 80) fastSteps++;
      totalSteps++;
      helpsDay += 600 / (freqBase * energyF(e));
      e = Math.max(0, e - 1);
      for (const mt of mealAt) if (mt === t) e = Math.min(150, e + mealRecovery(e));
      if (supportPerStep) e = Math.min(150, e + supportPerStep);
    }
    for (let t=0; t<sleepMin; t+=10){
      if (e >= 80) fastSteps++;
      totalSteps++;
      helpsNight += 600 / (freqBase * energyF(e));
      e = Math.max(0, e - 1);
    }
    start = e;
  }
  // extra helps injected by team main skills, spread across the day
  helpsDay += ctx.extraHelps || 0;

  /* ================= 收取區間（2026-09-09）=================
     **這個遊戲不會自動收取，要上線點才收**（使用者確認）。所以產出是按「兩次收取
     之間」結算的，而每一段都有兩個上限：

       · 樹果／食材：背包裝滿就停（`helpsTillFull`）。滿了之後進入「偷吃」——
         只產樹果、食材歸零，而且**連技能抽選都不做**（見下面的出處）。
       · 主技能：**最多累積 `bankedProcs` 次**（技能專長 2 次，其他 1 次）。

     以前只有**夜間**那一段套這兩個上限，白天完全不套 —— 等於假設你整個白天隨時在
     收取。實測那個假設對高頻技能型影響極大：哥達鴨的技能觸發率 20.4%（全 dex 第 2），
     白天 81 次幫忙本來算出 18.5 次發動，但每 4 小時才收一次的話，每段只拿得到 2 次，
     一天實際只有 **9.75 次（53%）**。而低頻的達克萊伊（3.8%）**完全不受影響** ——
     偏差只打在「技能率高」的那些身上，於是牠們被系統性地推進推薦名單。

     `wk.collectH` = 白天平均多久收取一次（小時）。夜間永遠是一整段（`sleepH`）。 */
  const dropPerHelp = (1-bs.ingChance)*bs.berriesPerDrop + bs.ingChance*bs.avgIngAmt;
  const helpsTillFull = dropPerHelp>0 ? bs.carry/dropPerHelp : Infinity;
  const bankedProcs = bs.p.sp==='skill' ? 2 : 1;
  /* 一段區間內：`h` 次幫忙 → 產物受背包上限、技能發動受 banked 上限。
   *
   * **滿包之後到底發生什麼**（2026-09-10 查證，使用者問「食材掉落發動確定不會有能量嗎」）。
   * 來源：日文驗證 wiki [おてつだい](https://wikiwiki.jp/poke_sleep/おてつだい) ——
   * 所持數到上限後進入「いつのまに育成」：
   *
   *   「この状態になったポケモンのおてつだいでは食材を拾ってくる確率が **0％** となり、
   *     きのみを拾ってくる確率が **100%** になる」
   *   「最大所持数を超えた分のきのみを**自動的にカビゴンに与えてエナジーに変換する**」
   *   「…また**メインスキルの発動判定も行われなくなる**」
   *
   * 所以滿包的幫忙**不是白幫**：
   *
   *   ① 食材機率歸 0、樹果機率 100% → 底下 `berries` 的 `snack*berriesPerDrop`
   *      **刻意不乘 `(1-ingChance)`**。那不是漏寫，改掉就錯了。
   *   ② 那些樹果照樣變成卡比獸能量。
   *   ③ **技能抽選不做** → `procs` 用的是 `normal` 而不是 `h`。同樣不要「順手」改成 `h`。
   */
  const segment = (h) => {
    const normal = Math.min(h, helpsTillFull);
    return {normal, snack: Math.max(0, h - normal),
            procs: Math.min(normal * bs.effSkill, bankedProcs)};
  };
  const wakeH = wakeMin / 60;
  /* 沒設定就當「隨時在收」（＝白天一段很短，等於不設上限）—— 舊資料相容。 */
  const collectH = (wk.collectH > 0) ? Math.min(wk.collectH, wakeH) : 0;
  let dayNormal, daySnack, dayProcs;
  if (collectH > 0){
    const nSeg = wakeH / collectH;                  // 白天分成幾段（可以是小數）
    const seg = segment(helpsDay / nSeg);
    dayNormal = seg.normal * nSeg; daySnack = seg.snack * nSeg; dayProcs = seg.procs * nSeg;
  } else {
    dayNormal = helpsDay; daySnack = 0; dayProcs = helpsDay * bs.effSkill;
  }
  const night = segment(helpsNight);                // 夜間就是一整段
  const productive = dayNormal + night.normal;
  const snack = daySnack + night.snack;
  const procs = dayProcs + night.procs;

  /* ============ 「多久該上去收一次」（2026-09-10）============
     `snack`（背包滿了之後的白幫忙）是**事後結果** —— 它說「你漏了」，但沒說
     「那你該多久收一次」。使用者要的是後者，所以直接把時間算出來。

     每一隻有**兩個**天花板，兩個都要算，只講一個會誤導：

       · `fillH`  背包裝滿（`helpsTillFull` 次幫忙）→ 之後只剩樹果，食材歸零
       · `skillH` 主技能存滿（`bankedProcs` 次：技能專長 2、其他 1）→ 之後發動也拿不到

     **對技能型來說先到的常常是後者。** 哥達鴨的技能觸發率 20.4%，2 次很快就存滿，
     遠早於背包 —— 只顯示背包時間的話，使用者會以為那段時間什麼都沒漏（見陷阱 6e）。

     換算用**白天的平均幫忙速度**（`helpsDay / wakeH`）。起床時活力最高、實際比平均
     快一點，所以這是偏保守的估計 —— UI 的 tooltip 要寫出來。夜間不算：那一段沒辦法
     中途收，它的損失本來就在 `nightSnack` 裡。 */
  const perH = wakeH > 0 ? helpsDay / wakeH : 0;
  const fillH = (perH > 0 && isFinite(helpsTillFull)) ? helpsTillFull / perH : Infinity;
  const skillH = (perH > 0 && bs.effSkill > 0) ? (bankedProcs / bs.effSkill) / perH : Infinity;

  return {freqBase, helpsDay, helpsNight, productive, snack, procs, fillH, skillH,
          dayProcs, nightProcs: night.procs, daySnack, nightSnack: night.snack,
          fastHours: fastSteps/6, fastShare: totalSteps ? fastSteps/totalSteps : 0, wakeEnergy: start,
          berries: productive*(1-bs.ingChance)*bs.berriesPerDrop + snack*bs.berriesPerDrop};
}
/** Full per-member per-day output in a given team context. */
function memberOutput(m, wk, ctx){
  const bs = m._bs;
  /* `pay` 要**先**算完再跑 `simulate` —— 自回活力的量取決於技能發動次數，
     而技能發動次數又反過來取決於活力（見下面的定點迭代）。底下這些 `pay` 的調整
     全部只看 `ctx`、不看 `sim`，所以搬到前面是等價的。 */
  const pay = {...skillPayload(bs.p.ms, bs.skillLv)};
  /* Helper Boost 吃的是**牠自己那個樹果**的列 —— 一隊可能有好幾個持有者，
     所以 ctx.hbRows 是 map 而不是純量（見 teamContext）。 */
  if (/^Helper Boost/.test(bs.p.ms))
    pay.helpsAll = HB_TABLE[((ctx.hbRows && ctx.hbRows[bs.p.b]) || 1)-1][Math.min(bs.skillLv, 6)-1];
  /* 正電／負電**互為條件**：兩邊都要隊上有另一半才給加成。
     正電的加成是額外食材（`bonusIngredient`），負電的是給隊友的能量（`energy`）；
     基礎效果（正電的 `ingredient`、負電的 `potSize`）沒有條件，照給。

     以前正電那一側是「無條件加一半」—— 單獨帶會被高估、正負配對會被低估，
     於是搜尋會系統性地錯過那個配對。負電那一側本來就是條件式的。 */
  if (/^Plus \(/.test(bs.p.ms) && ctx.hasMinus) pay.ingSpread = (pay.ingSpread||0) + (pay.ingBonus||0);
  /* 流星群（樹果遽增）：`latiasBerries` 只有隊上有拉帝亞斯時才給。
     ⚠ 快照裡這個技能**只有這一欄**（沒有 selfBerry／teamBerry），所以沒有夥伴時
     牠的主技能就完全沒有產出 —— 上游有沒有漏掉基礎效果還沒確認，UI 有標。 */
  /* 流星群（樹果遽增）。兩份分開：
       ① 基礎表 —— 隊上**不同種類的龍屬性**數決定自己與隊友各拿幾顆（MS_EXTRA，repo 維護）
       ② `latiasBerries` —— 隊上有拉帝亞斯時，**自己**再 +N（上游有這一欄）
     遊戲內說明：「獲得自己以及隊伍中的寶可夢會撿來的樹果。隊伍中有越多不同種類的
     龍屬性幫手寶可夢，樹果數量就會增加得越多。不僅如此，隊伍中有拉帝亞斯時，
     自己獲得的樹果還會增加 2 個。」 */
  if (/^Draco Meteor/.test(bs.p.ms)){
    const x = MS_EXTRA[bs.p.ms] || {};
    const li = Math.min(bs.skillLv, 6) - 1;
    const di = Math.min(Math.max(ctx.nDragon || 1, 1), 5) - 1;
    if (x.selfBerryByDragon) pay.selfBerry = (pay.selfBerry||0) + x.selfBerryByDragon[li][di];
    if (x.teamBerryByDragon) pay.teamBerry = (pay.teamBerry||0) + x.teamBerryByDragon[li][di];
    if (ctx.hasLatias)       pay.selfBerry = (pay.selfBerry||0) + (pay.berryWithLatias||0);
  }
  /* 治癒波動：隊上有拉帝歐斯時額外幫忙加碼（基礎 + 額外 = 總計）。 */
  if (/^Heal Pulse/.test(bs.p.ms) && ctx.hasLatios)
    pay.helpsOne = (pay.helpsOne||0) + (pay.helpsWithLatios||0);
  /* 負電：快照裡是 `energy`，但欄位語意（正電給食材、負電**給隊友**能量）說它是
     發出去的，不是回自己的。遊戲內說明沒有再確認過對象，所以**刻意維持原行為** ——
     這裡把它轉成 `energyTeam`，數值和改動前逐位相同（`energyTeam*5 === energySelf`）。
     轉換的目的只是讓 `energySelf` 這個名字從此只代表「真的只回自己」。 */
  if (/^Minus \(/.test(bs.p.ms)){
    const e = pay.energySelf || 0; delete pay.energySelf;
    if (ctx.hasPlus && e) pay.energyTeam = (pay.energyTeam || 0) + e/5;
  }
  /* 「回自己活力」要**自己收下**，不能丟進 `ctx.supportEnergy` 分給全隊（見 simulate）。
     這是定點迭代：活力↑ → 幫忙間隔↓ → 幫忙次數↑ → 技能發動↑ → 活力↑。
     單調遞增而且有上限（活力上限 150、`energyF` 最快 0.45），所以會收斂。
     只有帶 `energySelf` 的那 **45 隻**要多跑（活力填充S 34 ＋ 月光 1 ＋ 萬用技能 10 ——
     `WILDCARD` 那些的平均值裡本來就含一份自回活力），其餘一次就結束、成本完全沒變。 */
  let sim = simulate(bs, m, wk, ctx, 0);
  if (pay.energySelf){
    for (let it = 0; it < 4; it++){
      const next = simulate(bs, m, wk, ctx, sim.procs * pay.energySelf);
      const done = Math.abs(next.procs - sim.procs) < 1e-4;
      sim = next;
      if (done) break;
    }
  }
  const ing = new Float64Array(NING);
  for (let i=0;i<NING;i++) ing[i] = sim.productive * bs.ingChance * bs.ingVec[i];
  if (pay.ingSpread) { const per = sim.procs*pay.ingSpread/MAGNET_POOL.length; for (const i of MAGNET_POOL) ing[i] += per; }
  const favMul = favBerryMul(wk, bs.p.b);
  const bp = berryPower(bs.p.b, m.level);
  /* 本週活動「樹果能量 +N%」**只打幫忙撿來的那一份**（使用者 2026-09-11 指定：
     Q16「只有撿的」）。所以主技能發出的樹果 —— `selfBerry`（樹果遽增／流星群發給
     自己的）與發給隊友的那一份（`mateBerryCoef` / `ownBerryPow`）—— 刻意不吃。
     ⚠ 下一個讀到這裡的人幾乎一定會覺得「樹果能量加成竟然不打樹果技能」是 bug。
     **那是使用者指定的範圍，不是漏掉** —— 要改之前先去問他。 */
  let berryStrength = sim.berries * bp * favMul * evtMul(wk, 'berry');
  if (pay.selfBerry) berryStrength += sim.procs*pay.selfBerry*bp*favMul;
  /* 「發給隊友的樹果」拿的是**隊友自己的樹果**，不是持有者的。
     遊戲內說明（樹果遽增／流星群都一樣）：「獲得自己**以及隊伍中的寶可夢**會撿來的
     樹果」—— 隊友撿的當然是牠們自己那一種。

     以前這裡是 `4*bp*favMul`：四個隊友全部套持有者的樹果**與持有者的加成倍率**。
     實測（Treecko 帶 DURIN，隊友 GREPA／DURIN／LEPPA／ORAN）：本週加成只有 DURIN 時
     berryStrength 14,163.7 → 28,327.3，**整整 ×2** —— 三隻根本不產加成樹果的隊友
     那一份也跟著翻倍。Lv6 的 teamBerry 是 5 顆 ×4 人 = 20 顆，對照 selfBerry 30 顆，
     所以那是這個技能約四成的產出。

     ⚠ **這一份不在這裡加進 `berryStrength`，而是回傳係數讓 `scoreTeam` 事後補**
     （`mateBerryAdd`）。理由是記憶化：隊友樹果總和（`ctx.mateBerryPow`）幾乎每一隊
     都不同，把它放進 `ctxKey` 會讓快取從「收斂在幾千筆」變成**跟組合數線性成長**。
     實測 42 隻的箱子（850,668 組）memo 從 6,415 筆爆到 487,899 筆（76 倍），
     89 隻（41,507,642 組）跑到 25% 就把 renderer 的記憶體吃光 —— 分頁直接
     Out of Memory 崩掉（使用者 2026-09-10 回報）。dedicated worker 和主執行緒
     **共用同一個 renderer 行程**，所以六個 worker 的快取是加總的。

     移出去之後 `ctxKey` 回到有界，而數值**完全等價**（不是近似、不是量化）——
     這一項對每個成員是 `係數 × (隊伍總和 − 自己那一份)`，係數只跟牠自己有關。
     只有真的帶這個技能的那一隻係數非 0，所以每隊最多複製一個 out 物件。 */
  const mateBerryCoef = pay.teamBerry ? sim.procs*pay.teamBerry : 0;
  const skillStrength = sim.procs * (pay.strength||0);
  return {sim, pay, ing, berryStrength, skillStrength,
          mateBerryCoef, ownBerryPow: bp*favMul,
          potBonus: sim.procs*(pay.pot||0),
          /* **只算發給隊友的那一份。** 「回自己」的已經在上面的定點迭代裡由牠自己收下，
             再算進來就是重複計分 —— 而且 `teamContext` 會把它 ÷5 攤給另外四隻，
             等於持有者少拿 4/5、隊友白拿。實測持有者的幫忙次數因此低估 31%。 */
          energyGiven: sim.procs*(pay.energyTeam||0)*5,
          energySelfGiven: sim.procs*(pay.energySelf||0),
          /* 每天扣掉的活力（負值），之後在 teamContext 裡加總成 ctx.darkDrain。 */
          energyDrain: /^Bad Dreams/.test(bs.p.ms) ? -sim.procs*BAD_DREAMS_DRAIN : 0,
          helpsGiven: sim.procs*((pay.helpsAll||0)*5 + (pay.helpsOne||0)),
          /* 料理機率提升系（美味機會S `[4,5,6,7,8,10]`、怪力鉗 `[1,2,2,3,3,4,5]`）
             每次發動讓**下一餐**的大成功機率 +N 個百分點。所以要把「每日發動次數」
             換算成「每餐期望值」—— 除以 MEALS_DAY。

             ⚠ 這裡以前是 `Math.min(0.7, sim.procs*pay.critChance/100)`，**沒有除以
             餐數**，於是每日 3 次發動 x 10 點被當成「每一餐都 +30 點」。配上當時
             `critMul` 那個 `critAdd*0.8`（正確加權是 1.1428，見 critMultiplier），
             淨效果是把這一系的貢獻**高估約 2.1 倍** —— 也就是把料理機率型往推薦
             名單裡推。2026-09-11 兩個因子一起修正（使用者指定一批做完）。

             0.7 那個上限拿掉了：單餐機率的上限現在由 `critMultiplier` 的
             `Math.min(1, 基礎+add)` 按平日／週日各自處理，那才是機率真正的天花板。

             ⚠ 這是**期望值近似**：遊戲沒有公布「一餐之前發動兩次能不能疊」以及
             發動時機與煮飯時機的關係。已知簡化要寫出來。 */
          critAdd: sim.procs*(pay.critChance||0)/100/MEALS_DAY};
}

/* -------- team context resolution + memoised member outputs -------- */
const qE = v => Math.min(120, Math.round(v/15)*15);
const qH = v => Math.round(v*2)/2;
/** Helper Boost 的列數是 `{樹果: 同樹果的不同物種數}` —— 一隊可能有**好幾個**持有者
 *  （三神獸的樹果各不相同），所以它是 map 不是純量。序列化要排序過才穩定。 */
const hbKey = r => r ? Object.keys(r).sort().map(b => b+':'+r[b]).join(',') : '';
/** ⚠ 這裡的每一項都必須是**有界**的（量化過或本來就只有幾種值）——
 *  `memberOutput` 的記憶化靠它，而搜尋是幾千萬組。放一個連續值進來（例如
 *  `ctx.mateBerryPow` 那種「整隊樹果能量總和」）會讓快取跟組合數線性成長，
 *  89 隻的箱子直接把 renderer 的記憶體吃光。那一項因此**不在這裡**，改由
 *  `scoreTeam` 事後補（見 `mateBerryAdd`）。 */
function ctxKey(c){ return c.nHB+'|'+c.nERB+'|'+c.supportEnergy+'|'+c.extraHelps+'|'+hbKey(c.hbRows)+'|'+(c.hasPlus?1:0)+(c.hasMinus?1:0)+(c.hasLatias?1:0)+(c.hasLatios?1:0)+'|'+c.darkDrain+'|'+c.nDragon; }
/** 「發給隊友的樹果」那一份：`係數 × (整隊樹果能量總和 − 自己那一份)`。
 *  刻意留在記憶化之外 —— 理由見 `ctxKey` 與 `memberOutput` 的註解。 */
const mateBerryAdd = (o, ctx) =>
  o.mateBerryCoef ? o.mateBerryCoef * Math.max(0, (ctx.mateBerryPow||0) - o.ownBerryPow) : 0;
function teamContext(idxs, roster, wk, memo){
  let nHB=0, nERB=0, hasPlus=false, hasMinus=false, hasLatias=false, hasLatios=false;
  /* 流星群：「隊伍中有越多**不同種類的龍屬性**幫手寶可夢，樹果數量就會增加得越多」
     （遊戲內說明）。和 Helper Boost 一樣算**物種數**，含牠自己。 */
  const dragonKinds = new Set();
  for (const i of idxs){
    const bs = roster[i]._bs;
    if (bs.hasHB) nHB++;
    if (bs.hasERB) nERB++;
    if (/^Plus \(/.test(bs.p.ms)) hasPlus = true;
    if (/^Minus \(/.test(bs.p.ms)) hasMinus = true;
    if (bs.p.n === 'LATIAS') hasLatias = true;
    if (bs.dragon) dragonKinds.add(bs.p.n);
    if (bs.p.n === 'LATIOS') hasLatios = true;
  }
  /* Helper Boost：**每一個持有者各自算自己那一列**（列 = 隊上與「牠的」樹果相同的
     不同物種數，含牠自己）。
     以前這裡是 `idxs.find(...)` 取「第一個」持有者，整隊共用一個純量 —— 但三神獸的
     樹果各不相同（雷公 GREPA／炎帝 LEPPA／水君 ORAN），所以兩隻同隊時另一隻會被套上
     別人的列。而 `find` 取的是 roster 索引最小的那個，於是**同一支隊伍只要換 roster
     順序，答案就會變**（實測 helpsGiven 差 2.3 倍）—— 違反第 4 節的順序不變量。 */
  let hbRows = null;
  for (const i of idxs){
    const bs = roster[i]._bs;
    if (!/^Helper Boost/.test(bs.p.ms)) continue;
    hbRows = hbRows || {};
    if (hbRows[bs.p.b] != null) continue;           // 同樹果的第二隻算出來會一樣
    const uniq = new Set();
    for (const j of idxs) if (roster[j]._bs.p.b === bs.p.b) uniq.add(roster[j]._bs.p.n);
    hbRows[bs.p.b] = Math.max(1, Math.min(5, uniq.size));
  }
  // two-pass: neutral context to size team-wide skill support, then re-evaluate
  const nDragon = Math.max(1, Math.min(5, dragonKinds.size));
  /* 「發樹果給隊友」那類技能要用**隊友自己的樹果**算（見 memberOutput）。
     這個總和幾乎每一隊都不同，所以它**不進 `ctxKey`** —— 由 `scoreTeam` 在
     記憶化之外事後補。這裡的 `some(...)` 只是省掉 5 次 `berryPower`，
     和快取粒度無關（那條線在 `ctxKey` 上）。 */
  let mateBerryPow = 0;
  if (idxs.some(i => givesTeamBerry(roster[i]._bs.p.ms))){
    for (const i of idxs){
      const bs = roster[i]._bs;
      mateBerryPow += berryPower(bs.p.b, roster[i].level) * favBerryMul(wk, bs.p.b);
    }
  }
  let ctx = {nHB, nERB, supportEnergy:0, extraHelps:0, darkDrain:0, hbRows, hasPlus, hasMinus, hasLatias, hasLatios, nDragon, mateBerryPow};
  for (let pass=0; pass<2; pass++){
    let energy=0, helps=0, drain=0;
    for (const i of idxs){ const o = getOut(i, roster, wk, ctx, memo);
      energy += o.energyGiven; helps += o.helpsGiven; drain += o.energyDrain; }
    /* darkDrain 是**每個非惡屬性成員各自**被扣的量（夢魘同時打所有人，所以不除以 5）。
       量化成 3 的倍數控制快取爆炸，和 qE/qH 同一個道理。 */
    const next = {nHB, nERB, hbRows, hasPlus, hasMinus, hasLatias, hasLatios, nDragon, mateBerryPow,
                  supportEnergy: qE(energy/5),
                  extraHelps: qH(helps/5), darkDrain: Math.round(drain/3)*3};
    if (ctxKey(next)===ctxKey(ctx)) { ctx = next; break; }
    ctx = next;
  }
  return ctx;
}
function getOut(i, roster, wk, ctx, memo){
  const k = i+'#'+ctxKey(ctx);
  let v = memo.get(k);
  if (!v){ v = memberOutput(roster[i], wk, ctx); memo.set(k, v); }
  return v;
}

/* -------- recipe scoring -------- */
/** 這道食譜**現在煮得出來嗎**。
 *
 *  **有設等級 ＝ 已解鎖；沒設 ＝ 還沒解鎖，整個排除。**（使用者 2026-09-10 指定）
 *
 *  以前沒設的會退回 `wk.recipeLv` 那個預設等級，等於假設「你 78 道全都會煮」——
 *  於是推演會圍著使用者**根本煮不出來**的食譜去配隊，而且畫面上完全看不出來。
 *  遊戲裡食譜要煮過才解鎖，沒解鎖的等級欄本來就是空的。
 *
 *  **單一真實來源：`wk.recipeLevels[r.n]` 的有無。** 不另外開一份「停用清單」——
 *  同一件事有兩個來源就一定會有一個在說謊（和「文案不能寫死檔名」同一類）。
 *
 *  這是**產品規則，不是效能手段**（陷阱 4），所以那三條配套一樣要守：
 *    · **排除的道數要顯示出來**（結果頁的 `comboCount`、食譜頁的 `rlvCount`）
 *    · **一道都沒解鎖時要講清楚**，不可以靜靜地把料理算成 0
 *    · **「指定食譜」的選單只能列出已解鎖的** —— 選得到卻煮不出來就是自相矛盾 */
const recipeOn = (r, wk) => {
  const v = wk.recipeLevels && wk.recipeLevels[r.n];
  return typeof v === 'number' && v >= 1;
};
/** 已解鎖的道數（給 UI 顯示排除了多少用）。 */
const recipesOn = wk => D.recipes.reduce((n, r) => n + (recipeOn(r, wk) ? 1 : 0), 0);
/* wk 是參數，不是全域 —— 引擎要能在 Worker 裡跑，那裡沒有 app.js 的狀態。
   **注意 `rlvl` 不管解鎖與否**：它只回答「等級是多少」，要不要納入由 `recipeOn` 決定。
   食譜頁會拿它顯示「解鎖之後會是幾級」，所以那個 `wk.recipeLv` 的退路要留著。 */
const rlvl = (r, wk) => {
  const v = wk.recipeLevels && wk.recipeLevels[r.n];
  return (typeof v === 'number' && v >= 1) ? Math.min(70, v) : wk.recipeLv;
};
function recipeValue(r, lv){
  let sum = 0; for (const [i,a] of r.ings) sum += a*ING_VAL[i];
  return Math.round(sum * (D.rlb[lv]||1) * (1 + r.bonus/100));
}
function scoreTeam(idxs, roster, wk, memo){
  const ctx = teamContext(idxs, roster, wk, memo);
  const ing = new Float64Array(NING);
  let berryS=0, skillS=0, pot=0, critAdd=0;
  const outs = [];
  for (const i of idxs){
    let o = getOut(i, roster, wk, ctx, memo);
    /* 「發給隊友的樹果」是記憶化之外的那一項（見 ctxKey）。memo 裡的物件是**跨隊
       共用**的，所以不能就地改 —— 但只有真的帶那個技能的那一隻係數非 0，
       所以一支隊伍最多複製一個。 */
    const add = mateBerryAdd(o, ctx);
    if (add) o = {...o, berryStrength: o.berryStrength + add};
    outs.push(o);
    for (let k=0;k<NING;k++) ing[k] += o.ing[k];
    berryS += o.berryStrength; skillS += o.skillStrength; pot += o.potBonus; critAdd += o.critAdd;
  }
  const wIng = new Float64Array(NING);
  for (let k=0;k<NING;k++) wIng[k] = ing[k]*7;
  const potEff = Math.round((wk.pot + pot) * (wk.camp?1.5:1));
  /* 大成功倍率。`critAdd` 是隊上料理機率提升系累積的**每餐**額外機率，本週活動的
     「大成功機率 +N 個百分點」加在同一個地方（單位相同，所以不會兩套算法打架）。
     ⚠ 這裡以前是 `AVG_CRIT + critAdd*0.8`，那個 0.8 對不上平日／週日的加權
     （正確是 1.1428），見 critMultiplier 與 memberOutput 的 critAdd 註解。 */
  const critMul = critMultiplier(critAdd + evtPct(wk, 'crit')/100);
  const areaMul = 1 + wk.areaBonus/100;
  /* 本週活動「料理能量 +N%」。和地區加成同一層 —— 作用在**整鍋**上，所以塞進鍋子
     空位的額外食材也跟著放大（那些食材已經是這鍋料理的一部分）。
     它折進 `mul` 之後就留在 `dishS` 裡（`dishS` 只把 `areaMul` 除出去再乘回來），
     所以樹果與主技能那兩項完全不受影響 —— 這正是它和 `areaBonus` 的分別。 */
  const dishMul = evtMul(wk, 'dish');
  const mul = critMul * areaMul * dishMul;
  let r, cooksCapped, fits, rv, dishS;
  if (wk.recipePick === 'auto'){
    const b = bestSingleRecipe(wIng, potEff, mul);
    /* 搜尋階段的料理分數＝**可達的下界**：`bestSingleRecipe`（一直煮同一道）與
       `mealPlan` 單起點貪婪（換著煮，會扣除食材）取大的那個。

       以前這裡是 `proxyDish` —— 它遍歷食譜時**不扣除食材**，同一批蘋果被每一道用到
       蘋果的食譜重複計算。註解寫著「Over-counts, but ranks teams the same way the real
       plan does」，**那個假設是錯的**（實測見 DECISIONS.md）：高估中位數 1.389 倍、
       最高 2.85 倍，而且高估的幅度隨隊伍的食材種類分布而變 —— 所以它連排序都不保。
       後果是搜尋選出的隊伍真實分數比最佳低 9.2%，而真實前 8 名**全部**擠不進決賽。

       `mealPlan` 單起點恆 ≤ `bestPlan`（後者的多起點包含 `null`，就是單起點），
       所以這是下界；`finalizeTeams` 的 `if (mp.total > b.dishS)` 因此會**真的生效**，
       把決賽名單的分數修正到真值 —— 那正是那行程式碼原本的意圖。用上界的話它幾乎
       永遠不成立，UI 的「料理」數字就會和 21 餐排程表的小計對不上（實測差 58%）。 */
    if (b){ r = b.c.r; cooksCapped = b.n; rv = b.c.rv; fits = true;
            dishS = Math.max(b.s, mealPlan(wIng, potEff, mul, null, wk).total) / areaMul; }
    else { r = wk.recipe; cooksCapped = 0; rv = recipeValue(r, rlvl(r, wk)); fits = r.cnt <= potEff; dishS = 0; }
  } else {
    r = wk.recipe;
    rv = recipeValue(r, rlvl(r, wk));
    fits = r.cnt <= potEff;
    let cooks = Infinity;
    for (const [i,a] of r.ings) cooks = Math.min(cooks, wIng[i]/a);
    cooksCapped = Math.min(MEALS_WEEK, Math.floor(cooks));
    /* 指定食譜模式也要跑排程，理由和 auto 分支一樣（第 5 條：搜尋目標與評分目標必須一致）。
       決賽跑的是 `bestPlan(forced = wk.recipe)` —— 先把指定食譜煮到食材見底，**剩下的
       餐次再用別的食譜填滿**。以前這裡只算指定食譜那一段，等於把填充的部分當成 0，
       實測低估中位數 **26%**（比值 0.743），而且低估幅度隨隊伍的食材組成而變，
       於是真實前 8 名有 5 組擠不進決賽。

       `fits` 為 false（指定食譜放不進鍋）時也照跑：`mealPlan` 會自己跳過那道，用別的
       食譜填 —— 那正是決賽的行為。UI 另外用 `fits` 顯示「鍋子容量不足」的警告。 */
    dishS = mealPlan(wIng, potEff, mul, r, wk).total / areaMul;
  }
  let bottleneck = null, worstRatio = Infinity;
  for (const [i,a] of r.ings){ const c = wIng[i]/a; if (c < worstRatio){ worstRatio = c; bottleneck = i; } }
  const total = (berryS*7 + skillS*7 + dishS) * areaMul;
  const score = wk.mode==='dish' ? dishS*areaMul : wk.mode==='berry' ? berryS*7*areaMul : total;
  return {idxs, ctx, outs, ing, wIng, berryS:berryS*7*areaMul, skillS:skillS*7*areaMul,
          dishS:dishS*areaMul, total, score, cooksCapped, bottleneck, fits, potEff, rv, critMul, dishMul, recipe:r, mul};
}

let POOL = [];
function buildPool(wk){
  const all = wk.recipeScope === 'all';
  /* **沒解鎖的完全不進池子。** 這是候選過濾裡唯一合法的那一種：產品規則
     （遊戲裡真的煮不出來），不是為了加速。見 recipeOn 的說明與陷阱 4。 */
  POOL = D.recipes.filter(r => recipeOn(r, wk) && (all || r.t === wk.dishType))
    .map(r => ({r, rv: recipeValue(r, rlvl(r, wk)), lv: rlvl(r, wk), cnt: r.cnt}))
    .sort((a,b) => b.rv - a.rv);
}
/** Every recipe this team can sustain, ranked by what spamming it alone would yield. */
function rankSingle(wIng, potEff, mul){
  const out = [];
  for (const c of POOL){
    if (c.cnt > potEff) continue;
    let cooks = Infinity;
    for (const [i,a] of c.r.ings){ const k = wIng[i]/a; if (k < cooks) cooks = k; }
    const n = Math.min(MEALS_WEEK, Math.floor(cooks));
    if (n <= 0) continue;
    out.push({c, n, s: n * c.rv * mul});
  }
  out.sort((a,b)=>b.s-a.s);
  return out;
}
function bestSingleRecipe(wIng, potEff, mul){ return rankSingle(wIng, potEff, mul)[0] || null; }
/* 這裡曾經有個 `proxyDish`：走訪 POOL 填滿 21 餐，但**不扣除食材** —— 同一批蘋果被
   每一道用到蘋果的食譜重複計算。它的註解寫著「Over-counts, but ranks teams the same
   way the real plan does — which is all the search needs」。

   **那個假設是錯的，而且錯得很貴。** 實測（33,649 組窮舉，見 DECISIONS.md）：

     proxyDish / 真實排程：中位數 1.389、最高 2.85 —— 高估的幅度隨隊伍的食材種類分布
     而變，所以它連「排序」都不保。搜尋因此選出真實分數比最佳**低 9.2%** 的隊伍，
     而真實前 8 名**全部 8 組**擠不進 FINALISTS = 50 的決賽（放到 1000 還有 5 組進不去）。

   另一個看得見的症狀：`finalizeTeams` 的 `if (mp.total > b.dishS)` 因為上界永遠比較大
   而幾乎不成立 —— 決賽算了真實排程卻沒用它，於是 UI 的「料理」數字和 21 餐排程表的
   小計對不上（實測差 58%）。

   已經整段移除，改用 `mealPlan` 單起點（真實排程的**下界**）。**不要為了省時間再加回
   任何「不扣除食材」的近似**：料理分數的本質就是 `cooks = min(floor(pool[i]/a))` 這個
   木桶效應，忽略它等於忽略整個問題。實測成本只有 466ms / 33,649 組。 */
/** 貪婪不是單調的 —— 調高某道食譜的等級可能讓它選錯開場、總分反而變低（陷阱 3）。
 *  所以試多個開場，取最好的那個。
 *
 *  ## 開場只試 9 個（`null` ＋ `rankSingle` 前 8）——**試過全窮舉，會破壞單調性**
 *
 *  `rankSingle` 排的是「一直煮這道」的總分，那和「拿它開場、剩下再貪婪」是兩件事 ——
 *  大菜常常只煮得出 1~2 次，在 `rankSingle` 裡排很後面，卻可能是更好的開場。實測
 *  （120 組抽樣）改成「每一道煮得出來的都當開場」確實更好：
 *
 *  | 設定 | 全窮舉開場比只試 8 個好 | 平均多 | 最多多 |
 *  |---|---|---|---|
 *  | 鍋54+券 / Lv30 / 全食譜 | 41.7% | 0.90% | 4.26% |
 *  | 鍋57 / Lv20 / 只咖哩 | 10.0% | 0.15% | 0.56% |
 *
 *  **但改下去之後單調性掛了**（40 組隨機食譜等級裡有 5 組總分下降，最多 −1.4%）。
 *  `wk.collectH >= 3` 時剛好測不到（主技能被 cap 讓分數差距拉開），但 `<= 0.5`
 *  照樣破 —— 那是巧合，不是修好。
 *
 *  **試過兩個修法，都失敗**（實驗數據見 DECISIONS.md）：
 *
 *  1. **加大 `FINALISTS`**（50 → 1000）：完全無效，下降組數一模一樣。而且對照
 *     「全 33,649 組都跑決賽排程」的真值，`FINALISTS = 50` 早就選中真值 ——
 *     所以問題從來不是「最佳解擠不進決賽」。
 *  2. **貪婪比較函式加上空位價值**（`rv + 空位 × 剩餘食材均價`）：只從 5 組降到
 *     4 組，而且基準分數還略降 0.3% —— 那個均價近似不夠準。
 *
 *  根因還沒找到。**單調性是使用者看得見的保證**（調高食譜等級不該讓總分變低），
 *  比 0.9% 重要，所以維持 9 個開場。見 TODO.md 第 10c 項。 */
function bestPlan(wIng, potEff, mul, forced, wk){
  const seeds = forced ? [forced]
    : [null, ...rankSingle(wIng, potEff, mul).slice(0, 8).map(x => x.c.r)];
  let best = null;
  for (const sd of seeds){
    const mp = mealPlan(wIng, potEff, mul, sd, wk);
    if (!best || mp.total > best.total) best = mp;
  }
  return best;
}
/** 21 餐的貪婪排程，共用同一個食材池。
 *
 *  ## 鍋子的剩餘空間會被別的食材填滿（2026-09-09 補上）
 *
 *  遊戲實際機制（使用者確認）：**湊齊食譜需要的食材之後，還可以繼續把別的食材塞進鍋子，
 *  直到鍋子容量上限，那些食材的能量會直接加進這道料理。**
 *
 *  以前完全沒有這一段 —— 一道只要 23 個食材的食譜，在容量 81 的鍋子裡就只用 23 個，
 *  剩下的 58 格空著。實測使用者那一週：食材產出 1393 個只用掉 519 個，而多出來的
 *  874 個「沒有分數」。那個結論是錯的，它們是有分數的。
 *
 *  ## 兩種食材的計分方式不同（使用者 2026-09-09 說明，這是遊戲機制）
 *
 *  | | 食譜等級倍率 `rlb` | 食譜加成 `bonus` | 大成功（暴擊） | 島嶼加成 |
 *  |---|---|---|---|---|
 *  | **食譜規定的基礎食材** | ✓ | ✓ | ✓ | ✓ |
 *  | **額外塞進去填鍋的** | ✗ | ✗ | ✓ | ✓ |
 *
 *  額外食材**只算它的原始基礎單價**：130 分的火辣香草丟進 Lv1 的蘋果汁或 Lv60 的
 *  馬卡龍，都一樣是 130。但大成功與島嶼加成作用在**整鍋的總和**上，所以那兩個照吃 ——
 *  程式上就是 `fillE * mul`（`mul = critMul × areaMul`），不乘 `rlb` 也不乘 `bonus`。
 *
 *  推論：**填鍋的食材基礎單價越高越好**（呆呆獸尾巴 342、南瓜 250、大蔥 185…），
 *  所以填充是按食材能量由高到低塞。
 *
 *  **填充放在所有食譜都排完之後**，理由是那樣填充不會搶走食譜需要的食材，排程仍然
 *  由「單道能量最高」決定。結果是可達的，所以 `mealPlan` 仍然是真值的下界（陷阱 5
 *  的不變量靠這件事）。
 *
 *  ⚠ **已知的近似（量測過了）**：貪婪是按 `rv`（單道能量）挑食譜的，**沒有把「這道
 *  留下多少空位」算進去**。食材數少的食譜留的空位多，而空位現在是有價值的，所以
 *  「rv 稍低但 cnt 小」的食譜理論上可能反超。實測（591 組抽樣 × 3 種設定）：
 *
 *  | 設定 | 考慮空位會更好的隊伍 | 平均多 | 最多多 |
 *  |---|---|---|---|
 *  | 鍋54+券 / Lv30 / 全食譜 | 4.6% | 1.07% | 4.92% |
 *  | 鍋57 / Lv20 / 只咖哩 | 2.4% | 0.26% | 0.75% |
 *  | 鍋120 / Lv55 / 全食譜 | 4.1% | 1.71% | 5.74% |
 *
 *  影響存在但不大，而且要正確估「空位單價」得對剩餘食材池排序（每輪都做的話很貴）。
 *  暫時不做，見 TODO.md。**不要把這一段誤讀成「貪婪是最佳的」** —— 它不是。
 */
function mealPlan(wIng, potEff, mul, forceFirst, wk){
  const pool = Array.from(wIng);
  const plan = []; let meals = MEALS_WEEK, total = 0, guard = 0;
  if (forceFirst && forceFirst.cnt <= potEff){
    const rv = recipeValue(forceFirst, rlvl(forceFirst, wk));
    let cooks = Infinity;
    for (const [i,a] of forceFirst.ings){ const k = Math.floor(pool[i]/a); if (k < cooks) cooks = k; }
    cooks = Math.min(cooks, meals);
    if (cooks >= 1){
      for (const [i,a] of forceFirst.ings) pool[i] -= a * cooks;
      plan.push({r: forceFirst, n: cooks, each: rv, primary: true});
      total += cooks * rv * mul; meals -= cooks;
    }
  }
  while (meals > 0 && guard++ < 40){
    let best = null;
    for (const c of POOL){
      if (c.cnt > potEff) continue;
      let cooks = Infinity;
      for (const [i,a] of c.r.ings){ const k = Math.floor(pool[i]/a); if (k < cooks) cooks = k; }
      if (cooks < 1) continue;
      if (!best || c.rv > best.c.rv) best = {c, cooks: Math.min(cooks, meals)};
    }
    if (!best) break;
    for (const [i,a] of best.c.r.ings) pool[i] -= a * best.cooks;
    plan.push({r: best.c.r, n: best.cooks, each: best.c.rv});
    total += best.cooks * best.c.rv * mul;
    meals -= best.cooks;
  }
  /* 把剩下的食材塞進每一鍋的空位（見函式開頭的說明）。
   *
   * **空位一律只計食材的基礎能量**，所以每一格的價值都一樣，可以當成一個扁平的
   * `room` 一起填 —— 不需要按食譜分配。`total += fillE * mul` 的 `mul` 是
   * `critMul × areaMul`，也就是大成功與島嶼加成照吃（那兩個作用在整鍋的總和上）。
   *
   * 能量高的食材先塞：空位有限，同一格當然放值錢的（呆呆獸尾巴 342、南瓜 250、
   * 大蔥 185…）。使用者的話：「用大量的高分食材當肥料填滿大鍋子，即使只煮最基礎的
   * 食譜，最後的總能量依然會非常可觀。」 */
  let room = 0;
  for (const x of plan) room += Math.max(0, potEff - x.r.cnt) * x.n;
  let fillE = 0, fillN = 0;
  if (room > 0){
    const order = [];
    for (let i = 0; i < NING; i++) if (pool[i] >= 1) order.push(i);
    order.sort((a, b) => ING_VAL[b] - ING_VAL[a]);
    for (const i of order){
      if (fillN >= room) break;
      const take = Math.min(Math.floor(pool[i]), room - fillN);
      if (take <= 0) continue;
      pool[i] -= take; fillN += take; fillE += take * ING_VAL[i];
    }
    total += fillE * mul;
  }
  /* `fillE` 回傳的是**已經乘過 mul 的分數**，和 `total` 同一個單位，UI 才能直接顯示
     「其中多少來自填充」。`room` / `fillN` 給食材利用率那段用。 */
  return {plan, total, idleMeals: meals, leftover: pool, fillE: fillE * mul, fillN, room};
}

function rankRecipesForTeam(r, wk){
  const potEff = r.potEff;
  const out = [];
  for (const cand of POOL){
    const rec = cand.r;
    let cooks = Infinity, bn = null, worst = Infinity;
    for (const [i,a] of rec.ings){
      const c = r.wIng[i]/a;
      if (c < worst){ worst = c; bn = i; }
      cooks = Math.min(cooks, c);
    }
    const capped = Math.min(MEALS_WEEK, Math.floor(cooks));
    const fits = rec.cnt <= potEff;
    const rv = cand.rv;
    out.push({rec, capped, fits, rv, bn,
              /* `r.dishMul`（本週活動的料理能量加成）漏掉的話，這張「這隊最能煮的
                 食譜」表就會和上面的料理分數對不上 —— 和填充那一列漏掉會導致
                 「逐列加起來少一截」同一類的 bug。 */
              strength: fits ? capped*rv*r.critMul*(r.dishMul||1)*(1+wk.areaBonus/100) : 0});
  }
  out.sort((a,b)=>b.strength-a.strength);
  return out;
}

/* ================= 個體產能（只給寶可夢箱的 UI 用） =================
   **這一區完全不參與推演。** `searchTeams` / `scoreTeam` 一行都沒改 —— 每週的
   推薦還是原本那條路徑。

   ## 為什麼不是一個跨專長的總分

   三種專長的職責本來就不同，**分數不該互相比較**：

   | 專長 | 牠負責什麼 | 主指標 |
   |---|---|---|
   | 樹果 | 穩定產能 | 總產能能量／日（樹果＋食材＋技能） |
   | 食材 | 供料給食譜 | 食材原始能量／日（配不配得上本週食譜是推演的事） |
   | 技能 | 觸發主技能 | 主技能發動次數／日 |
   | 全能 | 兩邊都做一點 | 總產能能量／日 |

   **食材型刻意不看「配不配本週食譜」** —— 那正是每週推演在做的事，而且會週週跳動。
   箱子要回答的是「這隻的產能好不好」，該配哪一隻交給推演。

   **技能型刻意只看發動頻率**，不把技能效果換算成能量。不同主技能給的是能量／食材／
   幫忙次數／夢之碎片，換算率是憑空的判斷 —— 而發動頻率是所有技能共同的軸，
   也是使用者真正在養的東西。技能實際做什麼由 UI 用文字寫出來。

   ## 為什麼不用「加進參考隊的邊際貢獻」（前一版，已移除）

   實測換三種參考隊組成，同一隻**食材型 Lv60 的分數是 9.75萬／14.20萬／18.31萬**——
   差 1.9 倍。原因是 21 餐是硬上限：參考隊食材越多，再加食材越沒價值。所以那個分數
   有很大一部分在量「參考隊缺不缺食材」，不是「這隻有多好」。樹果型幾乎不受影響
   （樹果能量線性可加），所以偏差還**只打在其中一種專長上**。詳見 DECISIONS.md。

   ## 基準

   `SCORE_CTX` 是**單獨一隻、沒有任何隊友加成**（`nHB = 0`）—— 這正是遊戲的寶可夢
   詳細頁顯示幫忙間隔時用的情境，所以畫面上的數字對得起來。
   `SCORE_WK` 固定（無露營券、睡 8.5 小時、**不含本週加成樹果**），所以跨週可比。

   代價要講出來：**團隊型副技能量不到**。「幫忙加成」的價值主要在加速四個隊友，
   單獨一隻只看得到自己那 5%。所以 `monPower` 會回傳 `teamOnly`，UI 標一個徽章 ——
   量不到就說量不到，不要假裝那個數字包含了它。 */
/* `collectH` 固定 `DEFAULT_COLLECT_H` —— 個體產能要跨週可比，所以不跟著使用者的
   週設定跑；但**一定要有值**，否則技能率高的那幾隻會像推演以前那樣被高估
   （沒有「每段最多 2 次」的上限）。 */
const SCORE_WK = {fav: new Set(), camp: false, sleepH: 8.5, collectH: DEFAULT_COLLECT_H};
/* `mateBerryPow: 0` ＝ 沒有隊友，所以「發給隊友的樹果」那一份在這裡是 0。
   那是對的（單獨一隻本來就沒有隊友可發），但**量不到就要標出來** ——
   `monPower` 的 `teamOnly` 會把它列進「隊伍型」徽章。 */
const SCORE_CTX = {nHB: 0, nERB: 0, supportEnergy: 0, extraHelps: 0, darkDrain: 0, hbRows: null, hasPlus: false, hasMinus: false, hasLatias: false, hasLatios: false, nDragon: 1, mateBerryPow: 0};

/** 一隻的個體產能。純函式，不碰 POOL、不需要參考隊。 */
function monPower(m){
  const me = {...m, pin: false, ex: false};
  me._bs = baseStats(me, SCORE_WK);
  const o = memberOutput(me, SCORE_WK, SCORE_CTX);
  let ingCount = 0, ingE = 0;
  const types = [];
  for (let i = 0; i < NING; i++){
    if (o.ing[i] <= 1e-9) continue;
    ingCount += o.ing[i];
    ingE += o.ing[i] * ING_VAL[i];
    types.push([i, o.ing[i]]);
  }
  types.sort((a, b) => b[1] - a[1]);
  const p = D.dex[me.sp];
  return {
    spec: p.sp,
    berryE: o.berryStrength,          // 樹果能量／日（含主技能給的樹果）
    ingE, ingCount,                   // 食材：原始能量與顆數／日（**未經料理加成**）
    skillE: o.skillStrength,          // 主技能直接給的能量／日
    procs: o.sim.procs,               // 主技能發動次數／日
    helps: o.sim.helpsDay + o.sim.helpsNight,
    interval: o.sim.freqBase,         // 幫忙間隔（秒）—— 和遊戲畫面同一個數字
    snack: o.sim.snack,               // 背包滿了之後的「零食」幫忙，越多代表越該補持有上限
    total: o.berryStrength + ingE + o.skillStrength,
    ingTypes: types.slice(0, 3).map(([i, v]) => [ING_NAME[i], v]),
    /* 每一種食材的每日產量（索引 = D.ings 的索引）。給「找出產這個食材的寶可夢」
       那個篩選排名用。注意它**包含食材磁鐵灑出來的那一份** —— 那是真的產出，
       但灑得很平均且不可指定，所以篩選是看食材欄位，排名才看這個數字。 */
    ingAll: o.ing,
    /* 「單獨一隻量不到」的東西要標出來，不能假裝算進去了。四類都要：
       ① 幫忙加成（副技能）—— 價值主要在加速四個隊友，這裡只看得到自己那 5%
       ② 幫手加速（Helper Boost）—— 列數看隊上同樹果的物種數，單獨一隻只有第 1 列
       ③ 正電／負電 —— 加成要隊上有另一半才給，這裡兩邊都沒有
       ④ 發給隊友的樹果（樹果遽增／流星群）—— 拿的是**隊友自己的**樹果，
          沒有隊友就是 0。以前這一份被算成「四份持有者自己的樹果」，
          所以單獨一隻反而看起來比較強（見 memberOutput）。
       回傳的是**原因字串**（沒有就是空字串），UI 直接寫進徽章的說明。 */
    teamOnly: [me._bs.hasHB && '幫忙加成',
               /^Helper Boost/.test(me._bs.p.ms) && '幫手加速',
               /^Plus \(/.test(me._bs.p.ms) && '正電',
               /^Minus \(/.test(me._bs.p.ms) && '負電',
               givesTeamBerry(me._bs.p.ms) && '發給隊友的樹果'].filter(Boolean).join('、'),
    pay: o.pay,
  };
}
/** 各專長的主指標。**這四個數字彼此不可比**，UI 一定要把專長標在旁邊。 */
const POWER_MAIN = {
  berry:      p => p.total,
  ingredient: p => p.ingE,
  skill:      p => p.procs,
  all:        p => p.total,
};
const powerMain = p => POWER_MAIN[p.spec](p);

/* 快取：只看會影響計算的欄位（暱稱、📌、🚫 都不影響）。 */
const _powerCache = new Map();
const monPowerKey = m => [m.sp, m.level, m.nature, m.ss.join(','), m.ingSet.join(','),
                          m.skillLv, m.ribbon||0].join('|');
function monPowerCached(m){
  const k = monPowerKey(m);
  let v = _powerCache.get(k);
  if (!v){ v = monPower(m); _powerCache.set(k, v); }
  return v;
}

/** 同物種、**同等級**的理想個體：最佳性格＋最佳副技能＋緞帶4＋主技能滿級＋最佳食材組合。
 *
 *  目標函式就是那個專長的主指標（`powerMain`），所以「理想」的定義和顯示的分數一致 ——
 *  用總產能去挑技能型的理想個體會挑出完全不同的一組副技能。
 *
 *  **這是搜尋，不是證明。** 副技能之間有交互作用（持有上限對掉落快的更重要），
 *  所以用貪婪：已解鎖的欄位逐格試過全部副技能取當下最好的，再用最佳性格重跑一次。
 *  最後會把**牠自己**也放進候選 —— 否則貪婪漏掉某個組合時「理想值」會比實際低，
 *  百分比超過 100%，看起來像壞掉。
 *
 *  **評價等級固定在 `IDEAL_LEVEL`（60），不是牠現在的等級。**
 *
 *  以前是跟著牠現在的等級走，理由是「拿 Lv30 去比 Lv60 的理想值，量到的是還沒練滿」。
 *  但那讓「潛力」變成會自己跳動的數字：升到 50 解鎖第 3 格副技能、升到 60 解鎖第 3 格
 *  食材 —— 那一格是好是壞，會在跨過門檻的**那一刻**才被算進去，百分比因此往下掉。
 *  而使用者問的是「我該把糖果餵給哪一隻」，那是關於**練滿之後**的問題。
 *
 *  60 而不是 50：第 3 格食材在 Lv60 解鎖（副技能第 3 格是 Lv50）。用 50 當基準會讓
 *  食材型少算整整一格 —— 那正是食材型主指標的來源。第 4／5 格副技能要 Lv70／80，
 *  多數箱子到不了，所以不納入；**已經超過 60 的就用牠的實際等級**，不丟掉已知資訊。
 *
 *  **分子也要把「練得起來的東西」一起規範化掉**（緞帶 4、主技能滿級），不能只規範等級。
 *
 *  以前分子是 `{...m, level: 60}` —— 緞帶與主技能等級沿用牠現在的值，分母卻是滿的。
 *  於是同一份資質會**因為「還沒練」而顯示低分**：實測妙蛙花 51% vs 78%、雷丘 54% vs 76%
 *  （性格／副技能／食材組合完全相同，只差緞帶 0→4、技能 Lv1→滿）。使用者照這個數字
 *  排序、略過低分的，剛好略過了最該投資的那幾隻 —— 一個會自我實現的惡性循環
 *  （使用者 2026-09-10 直接反映）。規範化之後這個比值只剩**改不掉的部分**：
 *  性格、副技能、食材組合。
 *
 *  所以這個函式一次回三個數字，各自對應一種資源：
 *
 *  | 回傳 | 是什麼 | 回答 | 可比範圍 |
 *  |---|---|---|---|
 *  | `self` | 練滿（Lv60・緞帶4・技能滿級）的產能 | **等級糖果先餵誰** | 同專長內 |
 *  | `self ÷ 理想個體` | 資質（只剩性格＋副技能＋食材組合） | **這一隻是不是好貨** | 同物種內 |
 *  | `self − skillNow` | 主技能等級練滿多產多少 | **技能糖果先給誰** | 全體（同一種資源） |
 *
 *  `skillNow` 只把主技能等級退回牠現在的值，其餘（等級、緞帶）維持規範化 ——
 *  這樣那個差額才是**單獨**技能等級的貢獻，不混進等級或緞帶。 */
const IDEAL_LEVEL = 60;
function monIdeal(m){
  const p = D.dex[m.sp];
  const maxSkillLv = (D.ms[p.ms] || {max: 6}).max;
  const ssNames = D.subskills.map(s => s.n);
  /* 評價等級：至少 60，已經更高就用牠自己的 —— 分子分母都在這個等級上。 */
  const lvl = Math.max(IDEAL_LEVEL, m.level);
  const at = {...m, level: lvl};
  /* 分子的基準：等級、緞帶、主技能等級**全部**規範化，只留下改不掉的資質。 */
  const atFull = {...at, ribbon: 4, skillLv: maxSkillLv};
  const slots = [0,1,2,3,4].filter(s => lvl >= SS_SLOT_LV[s]);
  const ingOpts = [p.i0, p.i30, p.i60].map(l => (l || []).length);
  const nIngSlots = Math.min(Math.floor(lvl/30) + 1, 3);
  const val = x => powerMain(monPower(x));

  let cur = {...at, ribbon: 4, skillLv: maxSkillLv,
             ss: [null,null,null,null,null], ingSet: m.ingSet.slice()};
  // ① 食材組合（只有已解鎖的格子會進 baseStats）
  for (let s = 0; s < nIngSlots; s++){
    let bestI = cur.ingSet[s], bestV = -Infinity;
    for (let o = 0; o < ingOpts[s]; o++){
      const t = {...cur, ingSet: cur.ingSet.slice()}; t.ingSet[s] = o;
      const v = val(t); if (v > bestV){ bestV = v; bestI = o; }
    }
    cur.ingSet[s] = bestI;
  }
  const fillSs = () => {
    const ss = [null,null,null,null,null];
    for (const s of slots){
      let bestN = null, bestV = -Infinity;
      for (const n of ssNames){
        if (ss.includes(n)) continue;                 // 同一隻不會有重複的副技能
        const t = {...cur, ss: ss.slice()}; t.ss[s] = n;
        const v = val(t); if (v > bestV){ bestV = v; bestN = n; }
      }
      ss[s] = bestN;
    }
    return ss;
  };
  cur.ss = fillSs();                                   // ② 副技能（先用牠現在的性格）
  let bestNat = cur.nature, bestV = -Infinity;         // ③ 性格 25 種全試
  for (const n of Object.keys(NAT)){
    const v = val({...cur, nature: n});
    if (v > bestV){ bestV = v; bestNat = n; }
  }
  cur.nature = bestNat;
  cur.ss = fillSs();                                   // ④ 最佳性格會改變哪個副技能最值錢

  /* ⑤ 保底：**分子本人**（`atFull`）也要是候選，從結構上保證「理想 ≥ 分子」。
        一定要用 `atFull` 而不是 `m` 或 `at` —— 分子分母若不在同一個基準
        （等級、緞帶、主技能等級三樣都要一致），比值就沒有意義；而且貪婪逐格挑的時候
        可能漏掉有交互作用的組合，漏掉時就會冒出超過 100% 的數字，看起來像壞掉。 */
  let best = null, bestScore = -Infinity;
  for (const c of [cur, {...atFull, ingSet: cur.ingSet.slice()}, atFull]){
    const v = val(c); if (v > bestScore){ bestScore = v; best = c; }
  }
  /* 三個數字一起回，UI 不用自己再算一次（兩份一定會走鐘）。
     `skillNow` 只退主技能等級，所以 `self − skillNow` 就是技能等級**單獨**的貢獻。 */
  return {...monPower(best), member: best, lvl, maxSkillLv,
          self: monPower(atFull),
          skillNow: monPower({...atFull, skillLv: m.skillLv})};
}

/* ================= SEARCH ================= */
/**
 * 把第一層的每個 i0 指派給某個分片，讓各分片的**組合數盡量相等**。
 *
 * 為什麼不用 `i % total`：i0 越小子樹越大（i0 的子樹有 C(n−1−i0, need−1) 組），
 * 所以 modulo 交錯會讓 shard 0 拿到最大的幾塊。實測 40 隻 8 分片時，
 * shard 0 拿 123,971 組、shard 7 只有 48,476 組 —— 差 2.6 倍。
 * **最慢的分片決定總時間**，所以那樣的加速只有 2.4x。
 *
 * 這裡用「最大者優先」的貪婪裝箱：子樹由大到小，每個都丟給目前最輕的分片。
 * 只吃 (poolLen, need, total) 三個數字，所以每個 worker 都會算出同一份指派。
 */
function shardAssign(poolLen, need, total){
  const last = poolLen - need;
  const w = [];
  for (let i = 0; i <= last; i++) w.push({ i, n: nCk(poolLen - 1 - i, need - 1) });
  w.sort((a, b) => b.n - a.n || a.i - b.i);
  const load = new Array(total).fill(0);
  const owner = new Array(last + 1).fill(0);
  for (const { i, n } of w){
    let m = 0;
    for (let s = 1; s < total; s++) if (load[s] < load[m]) m = s;
    owner[i] = m; load[m] += n;
  }
  return owner;
}

/**
 * 列舉 pool 裡所有 k 取 (k − pinned) 的組合。
 *
 * `shard = {index, total}` 時只列舉自己那一份 —— 指派由 `shardAssign` 決定。
 *
 * 分片是「同一份窮舉分給多核」，不是取樣：各分片的聯集等於完整列舉，
 * 每組恰好被列舉一次。
 */
function combinations(pool, k, pinned, cb, shard){
  const idx = new Array(k);
  const need = k - pinned.length;
  if (need < 0) return;
  if (need === 0){
    // 5 隻都被 📌 固定：只有一組。沒有第一層迴圈可分片，交給 shard 0。
    if (!shard || shard.index === 0) cb(pinned.slice());
    return;
  }
  const owner = shard ? shardAssign(pool.length, need, shard.total) : null;
  (function rec(start, depth){
    if (depth === need){ cb(pinned.concat(idx.slice(0, need))); return; }
    for (let i=start; i<=pool.length-(need-depth); i++){
      if (depth === 0 && owner && owner[i] !== shard.index) continue;
      idx[depth] = pool[i]; rec(i+1, depth+1);
    }
  })(0, 0);
}

/* 決賽名單的排序。**必須有決定性的 tie-break** —— 不然多 worker 合併時，
   分數完全相同的兩組隊伍會因為合併順序不同而排出不同結果。
   單執行緒時靠「插入 + 重排」的順序碰巧穩定，分片之後那個巧合就沒了。 */
const byScore = (a, b) => b.score - a.score || cmpIdxs(a.idxs, b.idxs);
function cmpIdxs(a, b){
  for (let i=0; i<a.length && i<b.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

const FINALISTS = 50;   // 進決賽（跑真實 21 餐排程）的隊伍數。改評分方式時要重新確認夠不夠大
const SHOWN = 8;        // 實際顯示幾組
const nCk = (n,k)=>{ let r=1; for(let i=0;i<k;i++) r = r*(n-i)/(i+1); return r; };

/* 這裡曾經有個 PRESCAN_LIMIT：超過 120 萬組合就按「單隻分數」把箱子砍到前 42 隻。
   那個「單隻分數」其實是 scoreTeam([i] + pool.slice(0,4)) —— companions 按 roster
   順序取，也就是使用者把寶可夢加進箱子的順序，一個跟答案無關的輸入。

   實測（60 隻箱子，只改順序）：三種順序拿到正解 1,522,202.82，第四種拿到
   1,273,490.43 —— 差 −16.34%，前 8 名與正解零重疊。細節見 DECISIONS.md。

   已經整段移除。最佳組合是「箱子內容」的函數，不該和順序有關；任何預篩啟發式
   都有丟掉最佳解的風險，跑得動窮舉就不必賭。**不要再加回來** ——
   要壓縮搜尋空間就做可證明的 branch-and-bound（上界剪枝），不是啟發式取樣。 */

/**
 * 搜尋前的準備：驗證、解析食譜、建 POOL、算每隻的 baseStats、套用候選規則。
 *
 * **每個 worker 都會各自跑一次**（很便宜），所以分片時不需要把 pool 傳過去 ——
 * 只要 roster 與 wk 相同，各 worker 算出來的 pool 必然相同。
 *
 * 會就地修改：`wk.recipe`、`roster[i]._bs`、模組層的 `POOL`。
 */
function prepareSearch(roster, wk){
  const active = roster.map((m,i)=>({m,i})).filter(x=>!x.m.ex);
  if (active.length < 5) return { error:'few', n: active.length };

  wk.recipe = D.recipes.find(r=>r.n===wk.recipeName) || D.recipes[0];
  buildPool(wk);
  if (!POOL.length) return { error:'nopool' };

  const pinned = active.filter(x=>x.m.pin).map(x=>x.i);
  if (pinned.length > 5) return { error:'pins', n: pinned.length };

  roster.forEach(m=>{ m._bs = baseStats(m, wk); });

  /* 樹果型必須產本週加成樹果，否則不進候選名單（`wk.strictBerry`，預設開）。

     **這是產品需求，不是最佳化。** 使用者的立場：樹果型寶可夢的職責就是產樹果，
     不符合本週加成就不該入選；會入選代表輸出不符需求。

     已知代價（實測，見 DECISIONS.md）：會排除掉「專長是樹果、但價值來自主技能」
     的寶可夢 —— 例如 Xatu 專長 berry、樹果 MAGO，主技能是 Ingredient Magnet S，
     牠是去生產食材的。開這個規則之後前 8 名的總能量會低 3.9%~6.6%。
     這是刻意的取捨，不是 bug。

     兩個例外：
     1. `wk.fav` 是空的（還沒設本週樹果）→ 規則不生效，否則會把所有樹果型都排除
     2. 明確 📌 固定的成員不受此限 —— 使用者的個別指定優先於通則
     食材型／技能型／全能型完全不受影響（牠們的價值本來就不只看樹果）。 */
  let pool = active.map(x=>x.i).filter(i=>!pinned.includes(i));
  const strictBerry = wk.strictBerry !== false && wk.fav && wk.fav.size > 0;
  const excluded = [];
  if (strictBerry){
    const keep = [];
    for (const i of pool){
      const dx = D.dex[roster[i].sp];
      if (dx.sp === 'berry' && !wk.fav.has(dx.b)) excluded.push(i);
      else keep.push(i);
    }
    pool = keep;
    if (pool.length + pinned.length < 5)
      return { error:'fewBerry', n: pool.length + pinned.length, cut: excluded.length };
  }
  return { pool, pinned, excluded, total: Math.round(nCk(pool.length, 5-pinned.length)) };
}

/**
 * 列舉並評分一個分片，回傳這個分片的前 `finalists` 名（**尚未跑決賽**）。
 *
 * 分片正確性：每個分片各自保留自己的前 N 名，合併後取全域前 N 名 —— 全域前 N
 * 名必然也在各自分片的前 N 名內，所以合併集合一定包含它們。因此「分片 + 合併」
 * 與單執行緒的決賽名單**完全相同**，不是近似。
 *
 * `opts.lean` 時只回傳 `{idxs, score}` —— 給 Worker 用。完整的 scoreTeam 結果
 * 帶著 `outs`（5 個成員輸出，各含 Float64Array）和 `ing`，一個分片 241 KB，
 * 8 個分片就是 1.9 MB 的 structured clone，實測那就是平行化的主要瓶頸
 * （理論上限 7.3x，實際只拿到 3.2x）。精簡後 32 KB，少 87%。
 * 主執行緒收到後用 `rehydrate()` 對合併的前 FINALISTS 名重算 —— `scoreTeam`
 * 是決定性的，所以結果與完整回傳一模一樣。
 *
 * @param opts { shard:{index,total}, onProgress(done,total), shouldStop(), finalists, lean }
 */
function searchShard(roster, wk, opts){
  const o = opts || {};
  const finalists = o.finalists || FINALISTS;
  const shard = o.shard || null;
  const prep = prepareSearch(roster, wk);
  if (prep.error) return prep;

  const memo = new Map();
  const best = [];
  let count = 0, stopped = false;
  // 每 4096 組回報一次進度並檢查取消。combinations 沒有中斷機制，
  // 所以用旗標讓 callback 變成 no-op —— 列舉本身很便宜，貴的是 scoreTeam。
  combinations(prep.pool, 5, prep.pinned, idxs=>{
    if (stopped) return;
    count++;
    if ((count & 0xFFF) === 0){
      if (o.shouldStop && o.shouldStop()){ stopped = true; return; }
      if (o.onProgress) o.onProgress(count, prep.total);
    }
    const r = scoreTeam(idxs, roster, wk, memo);
    if (best.length < finalists){ best.push(r); best.sort(byScore); }
    else if (byScore(r, best[finalists-1]) < 0){ best[finalists-1] = r; best.sort(byScore); }
  }, shard);
  if (stopped) return { error:'stopped', count };
  const cands = o.lean ? best.map(b => ({ idxs: b.idxs, score: b.score })) : best;
  return { cands, count, excluded: prep.excluded, total: prep.total };
}

/**
 * 把精簡候選（只有 `idxs` / `score`）還原成完整的 `scoreTeam` 結果。
 * 因為 `scoreTeam` 對同一組 (idxs, roster, wk) 是決定性的，還原出來的東西
 * 與 worker 端算的完全相同 —— 這是「精簡傳輸不影響結果」的依據。
 * 需要先跑過 `prepareSearch`（要 `POOL` 與 `_bs`）。
 */
function rehydrate(cands, roster, wk){
  const memo = new Map();
  return cands.map(c => scoreTeam(c.idxs, roster, wk, memo));
}

/**
 * 決賽：對候選名單跑真實的 21 餐排程，重算總分後排序，取前 `SHOWN` 名。
 * **只能在合併之後跑一次** —— 每個 worker 各跑一遍是白費工，而且 bestPlan 很貴。
 * 需要 `POOL`（`prepareSearch` 建的）。
 */
function finalizeTeams(cands, roster, wk, finalists){
  const n = finalists || FINALISTS;
  const best = cands.slice().sort(byScore).slice(0, n);

  // 決賽組跑真實排程：從同一個食材池填滿 21 餐
  for (const b of best){
    const mp = bestPlan(b.wIng, b.potEff, b.mul, wk.recipePick==='manual' ? wk.recipe : null, wk);
    b.mp = mp;
    if (mp && mp.total > b.dishS){
      b.dishS = mp.total;
      if (wk.recipePick === 'auto' && mp.plan.length){
        const top = mp.plan.reduce((x,y)=> (y.n*y.each > x.n*x.each ? y : x));
        b.recipe = top.r;
        b.cooksCapped = top.n;
        b.rv = top.each;
        b.fits = true;
        /* **瓶頸食材一定要跟著重算。** 它是在 `scoreTeam` 裡對「搜尋階段選中的那道」
           算的，而這裡剛把主食譜換成排程裡實際最值錢的那一道 —— 不重算的話，
           結果卡的「瓶頸食材」與 `pickReason` 的「供應瓶頸食材 X」會指到一味
           **新食譜根本不用**的食材，而上面那張「主食譜食材缺口」長條圖裡也找不到它。 */
        let worst = Infinity; b.bottleneck = null;
        for (const [i,a] of b.recipe.ings){
          const c = b.wIng[i]/a;
          if (c < worst){ worst = c; b.bottleneck = i; }
        }
      }
    }
    b.total = b.berryS + b.skillS + b.dishS;
    b.score = wk.mode==='dish' ? b.dishS : wk.mode==='berry' ? b.berryS : b.total;
  }
  best.sort(byScore);
  return best.slice(0, SHOWN);
}

/**
 * 單執行緒的完整搜尋 = 準備 → 一個分片（就是全部）→ 決賽。
 *
 * 保證：結果只取決於 roster 的**內容**，與陣列順序無關（`tests/smoke.mjs` 第 4 節、
 * `tests/verify.mjs` 第 1 節有斷言）。
 *
 * app.js 平常走多 worker 的路徑（`searchShard` × N ＋ `finalizeTeams`）；
 * 這個函式留給「沒有 Worker 的退路」和測試用 —— 兩條路徑的結果必須逐欄位相同。
 *
 * @param opts { onProgress(done,total), shouldStop(), finalists }
 * @returns { best, count, ms, excluded } 或 { error: 'few'|'nopool'|'pins'|'fewBerry'|'stopped', ... }
 */
function searchTeams(roster, wk, opts){
  const t0 = Date.now();
  const r = searchShard(roster, wk, opts);
  if (r.error) return r;
  const best = finalizeTeams(r.cands, roster, wk, (opts && opts.finalists) || FINALISTS);
  if (opts && opts.onProgress) opts.onProgress(r.count, r.total);
  return { best, count: r.count, ms: Date.now()-t0,
           excluded: r.excluded.map(i => D.dex[roster[i].sp].n) };
}

