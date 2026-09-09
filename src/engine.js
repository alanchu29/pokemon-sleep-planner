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

const ING_NAME = D.ings.map(x=>x[0]);
const ING_VAL  = D.ings.map(x=>x[1]);
const NING = ING_NAME.length;
const BERRY_VAL = Object.fromEntries(D.berries);
const BERRY_NAMES = D.berries.map(b=>b[0]);
const NAT = Object.fromEntries(D.natures.map(n=>[n.n,n]));
const SS = Object.fromEntries(D.subskills.map(s=>[s.n,s]));
const SS_SLOT_LV = [10,25,50,70,80];
const RIBBON_CARRY = [0,1,3,6,8];
const AVG_CRIT = 1.171428571;
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
const MAGNET_POOL = ING_NAME.map((n,i)=>i).filter(i=>ING_NAME[i]!=='Tail');
const MEALS_WEEK = 21;

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
  const invAdd = (h('Inventory Up S')?6:0)+(h('Inventory Up M')?12:0)+(h('Inventory Up L')?18:0);
  const carry = Math.ceil((p.cs + 5*p.pe + invAdd + RIBBON_CARRY[m.ribbon||0]) * (wk.camp?1.2:1));
  const ingChance = Math.min(1, (p.ip/100) * nat.i * (1 + (h('Ingredient Finder S')?0.18:0) + (h('Ingredient Finder M')?0.36:0)));
  const berriesPerDrop = ((p.sp==='berry'||p.sp==='all')?2:1) + (h('Berry Finding S')?1:0);
  const slots = Math.min(Math.floor(m.level/30)+1, 3);
  // average ingredient vector per ingredient-help (already /slots)
  const opts = [p.i0, p.i30, p.i60];
  const ingVec = new Float64Array(NING);
  let avgIngAmt = 0;
  for (let s=0;s<slots;s++){
    const list = opts[s] || [];
    const pick = list[Math.min(m.ingSet[s]||0, list.length-1)];
    if (!pick) continue;
    ingVec[pick[0]] += pick[1]/slots;
    avgIngAmt += pick[1]/slots;
  }
  const skillLvMax = (D.ms[p.ms]||{max:6}).max;
  const skillLv = Math.max(1, Math.min(skillLvMax, (m.skillLv||1) + (h('Skill Level Up M')?2:0) + (h('Skill Level Up S')?1:0)));
  const skillChance = (p.sk/100) * (1 + (h('Skill Trigger S')?0.18:0) + (h('Skill Trigger M')?0.36:0)) * nat.s;
  const pity = p.sp==='skill' ? Math.floor(144000/p.f) : 78;
  const effSkill = skillChance<=0 ? 0 : skillChance/(1 - Math.pow(1-skillChance, pity+1));
  const natureFreqMul = 2 - nat.f;
  return {p, nat, act, h, carry, ingChance, berriesPerDrop, slots, ingVec, avgIngAmt, dark: DARK.has(p.n), dragon: DRAGON.has(p.n),
          skillLv, effSkill, natureFreqMul, hasHB:h('Helping Bonus'), hasERB:h('Energy Recovery Bonus'),
          ribbonMul:ribbonFreqMul(m.ribbon||0, p.re)};
}
const WILDCARD = /^(Metronome|Versatile|Skill Copy|Mimic \(|Transform \()/;
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
  return Math.floor(round4(bs.natureFreqMul * helpSS * levelFactor * bs.ribbonMul) * bs.p.f / (wk.camp?1.2:1));
}
/** Simulate one member's day. ctx = {nHB,nERB,supportEnergy (per day, to each member), extraHelps} */
function simulate(bs, m, wk, ctx){
  const freqBase = helpInterval(bs, m, wk, ctx.nHB);
  const sleepMin = Math.round(wk.sleepH*60), wakeMin = 1440 - sleepMin;
  const cap = bs.hasERB ? 105 : 100;
  const nSteps = Math.floor(wakeMin/10);
  /* 夢魘的扣活力**只打在惡屬性以外的隊友身上**，所以不能併進共用的 supportEnergy
     （那是「每個人都拿到一樣多」的量）。惡屬性隊友（含達克萊伊自己）免疫。 */
  const drain = bs.dark ? 0 : (ctx.darkDrain || 0);
  const supportPerStep = nSteps>0 ? (ctx.supportEnergy + drain)/nSteps : 0;
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
  // carry-size truncation applies at night only
  const dropPerHelp = (1-bs.ingChance)*bs.berriesPerDrop + bs.ingChance*bs.avgIngAmt;
  const helpsTillFull = dropPerHelp>0 ? bs.carry/dropPerHelp : Infinity;
  const nightNormal = Math.min(helpsNight, helpsTillFull);
  const snack = Math.max(0, helpsNight - nightNormal);
  const productive = helpsDay + nightNormal;
  /* 主技能發動次數：**只有醒著的幫忙會即時觸發**，睡眠期間累積的最多結算
     `bankedProcs` 次（技能專長 2 次，其他 1 次）。

     `productive` 含 `nightNormal` 對**樹果與食材**是對的 —— 睡覺時撿的東西醒來會收到，
     所以下面的 `berries` 和 memberOutput 的 `ing` 照樣用 `productive`。但技能發動不是
     同一回事：夜間那批幫忙不會每一次都即時發動技能，那正是 `bankedProcs` 這個上限的
     用意。以前這裡寫的是 `productive*effSkill + min(banked, ...)`，等於夜間幫忙先被
     完整乘過一次 effSkill（而且沒有上限）、再加一次 banked —— 同一批算了兩次。

     實測（Lv55、睡 8.5h）：技能型的 `skillStrength` 高估 **20.8%**（AMPHAROS 週能量
     190,026 → 150,468、DARKRAI 254,114 → 201,779），而樹果型的樹果收入與食材型的
     食材收入**完全不受影響** —— 也就是說偏差只打在其中一種專長上，會系統性地把
     技能型推進推薦名單。詳見 DECISIONS.md。 */
  const bankedProcs = bs.p.sp==='skill' ? 2 : 1;
  const procs = helpsDay*bs.effSkill + Math.min(bankedProcs, nightNormal*bs.effSkill);
  return {freqBase, helpsDay, helpsNight, productive, snack, procs,
          fastHours: fastSteps/6, fastShare: totalSteps ? fastSteps/totalSteps : 0, wakeEnergy: start,
          berries: productive*(1-bs.ingChance)*bs.berriesPerDrop + snack*bs.berriesPerDrop};
}
/** Full per-member per-day output in a given team context. */
function memberOutput(m, wk, ctx){
  const bs = m._bs;
  const sim = simulate(bs, m, wk, ctx);
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
  if (/^Minus \(/.test(bs.p.ms) && !ctx.hasPlus) delete pay.energySelf;
  const ing = new Float64Array(NING);
  for (let i=0;i<NING;i++) ing[i] = sim.productive * bs.ingChance * bs.ingVec[i];
  if (pay.ingSpread) { const per = sim.procs*pay.ingSpread/MAGNET_POOL.length; for (const i of MAGNET_POOL) ing[i] += per; }
  const favMul = wk.fav.has(bs.p.b) ? 2 : 1;
  const bp = berryPower(bs.p.b, m.level);
  let berryStrength = sim.berries * bp * favMul;
  if (pay.selfBerry) berryStrength += sim.procs*pay.selfBerry*bp*favMul;
  if (pay.teamBerry) berryStrength += sim.procs*pay.teamBerry*4*bp*favMul;
  const skillStrength = sim.procs * (pay.strength||0);
  return {sim, pay, ing, berryStrength, skillStrength,
          potBonus: sim.procs*(pay.pot||0),
          energyGiven: sim.procs*((pay.energyTeam||0)*5 + (pay.energySelf||0)),
          /* 每天扣掉的活力（負值），之後在 teamContext 裡加總成 ctx.darkDrain。 */
          energyDrain: /^Bad Dreams/.test(bs.p.ms) ? -sim.procs*BAD_DREAMS_DRAIN : 0,
          helpsGiven: sim.procs*((pay.helpsAll||0)*5 + (pay.helpsOne||0)),
          critAdd: Math.min(0.7, sim.procs*(pay.critChance||0)/100)};
}

/* -------- team context resolution + memoised member outputs -------- */
const qE = v => Math.min(120, Math.round(v/15)*15);
const qH = v => Math.round(v*2)/2;
/** Helper Boost 的列數是 `{樹果: 同樹果的不同物種數}` —— 一隊可能有**好幾個**持有者
 *  （三神獸的樹果各不相同），所以它是 map 不是純量。序列化要排序過才穩定。 */
const hbKey = r => r ? Object.keys(r).sort().map(b => b+':'+r[b]).join(',') : '';
function ctxKey(c){ return c.nHB+'|'+c.nERB+'|'+c.supportEnergy+'|'+c.extraHelps+'|'+hbKey(c.hbRows)+'|'+(c.hasPlus?1:0)+(c.hasMinus?1:0)+(c.hasLatias?1:0)+(c.hasLatios?1:0)+'|'+c.darkDrain+'|'+c.nDragon; }
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
  let ctx = {nHB, nERB, supportEnergy:0, extraHelps:0, darkDrain:0, hbRows, hasPlus, hasMinus, hasLatias, hasLatios, nDragon};
  for (let pass=0; pass<2; pass++){
    let energy=0, helps=0, drain=0;
    for (const i of idxs){ const o = getOut(i, roster, wk, ctx, memo);
      energy += o.energyGiven; helps += o.helpsGiven; drain += o.energyDrain; }
    /* darkDrain 是**每個非惡屬性成員各自**被扣的量（夢魘同時打所有人，所以不除以 5）。
       量化成 3 的倍數控制快取爆炸，和 qE/qH 同一個道理。 */
    const next = {nHB, nERB, hbRows, hasPlus, hasMinus, hasLatias, hasLatios, nDragon, supportEnergy: qE(energy/5),
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
/* wk 是參數，不是全域 —— 引擎要能在 Worker 裡跑，那裡沒有 app.js 的狀態。 */
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
    const o = getOut(i, roster, wk, ctx, memo);
    outs.push(o);
    for (let k=0;k<NING;k++) ing[k] += o.ing[k];
    berryS += o.berryStrength; skillS += o.skillStrength; pot += o.potBonus; critAdd += o.critAdd;
  }
  const wIng = new Float64Array(NING);
  for (let k=0;k<NING;k++) wIng[k] = ing[k]*7;
  const potEff = Math.round((wk.pot + pot) * (wk.camp?1.5:1));
  const critMul = AVG_CRIT + critAdd*0.8;
  const areaMul = 1 + wk.areaBonus/100;
  const mul = critMul * areaMul;
  let r, cooksCapped, fits, rv, dishS;
  if (wk.recipePick === 'auto'){
    const b = bestSingleRecipe(wIng, potEff, mul);
    if (b){ r = b.c.r; cooksCapped = b.n; rv = b.c.rv; fits = true;
            dishS = Math.max(b.s, proxyDish(wIng, potEff, mul)) / areaMul; }
    else { r = wk.recipe; cooksCapped = 0; rv = recipeValue(r, rlvl(r, wk)); fits = r.cnt <= potEff; dishS = 0; }
  } else {
    r = wk.recipe;
    rv = recipeValue(r, rlvl(r, wk));
    fits = r.cnt <= potEff;
    let cooks = Infinity;
    for (const [i,a] of r.ings) cooks = Math.min(cooks, wIng[i]/a);
    cooksCapped = Math.min(MEALS_WEEK, Math.floor(cooks));
    dishS = fits ? cooksCapped * rv * critMul : 0;
  }
  let bottleneck = null, worstRatio = Infinity;
  for (const [i,a] of r.ings){ const c = wIng[i]/a; if (c < worstRatio){ worstRatio = c; bottleneck = i; } }
  const total = (berryS*7 + skillS*7 + dishS) * areaMul;
  const score = wk.mode==='dish' ? dishS*areaMul : wk.mode==='berry' ? berryS*7*areaMul : total;
  return {idxs, ctx, outs, ing, wIng, berryS:berryS*7*areaMul, skillS:skillS*7*areaMul,
          dishS:dishS*areaMul, total, score, cooksCapped, bottleneck, fits, potEff, rv, critMul, recipe:r, mul};
}

let POOL = [];
function buildPool(wk){
  const all = wk.recipeScope === 'all';
  POOL = D.recipes.filter(r => all || r.t === wk.dishType)
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
/** Search-stage proxy for the 21-meal plan: walk recipes by value, fill meals,
 *  ignore that ingredients are shared. Over-counts, but ranks teams the same way
 *  the real plan does — which is all the search needs. */
function proxyDish(wIng, potEff, mul){
  let meals = MEALS_WEEK, total = 0;
  for (const c of POOL){
    if (meals <= 0) break;
    if (c.cnt > potEff) continue;
    let cooks = Infinity;
    for (const [i,a] of c.r.ings){ const k = Math.floor(wIng[i]/a); if (k < cooks) cooks = k; }
    if (cooks < 1) continue;
    const n = Math.min(cooks, meals);
    total += n * c.rv * mul; meals -= n;
  }
  return total;
}
/** Plain greedy is not monotone — raising one recipe's level could make it pick a
 *  worse opening move and lose value. So try several openings and keep the best. */
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
/** Greedy fill of all 21 meals from one shared ingredient pool. */
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
  return {plan, total, idleMeals: meals, leftover: pool};
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
              strength: fits ? capped*rv*r.critMul*(1+wk.areaBonus/100) : 0});
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
const SCORE_WK = {fav: new Set(), camp: false, sleepH: 8.5};
const SCORE_CTX = {nHB: 0, nERB: 0, supportEnergy: 0, extraHelps: 0, darkDrain: 0, hbRows: null, hasPlus: false, hasMinus: false, hasLatias: false, hasLatios: false, nDragon: 1};

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
    /* 「單獨一隻量不到」的東西要標出來，不能假裝算進去了。三類都要：
       ① 幫忙加成（副技能）—— 價值主要在加速四個隊友，這裡只看得到自己那 5%
       ② 幫手加速（Helper Boost）—— 列數看隊上同樹果的物種數，單獨一隻只有第 1 列
       ③ 正電／負電 —— 加成要隊上有另一半才給，這裡兩邊都沒有
       回傳的是**原因字串**（沒有就是空字串），UI 直接寫進徽章的說明。 */
    teamOnly: [me._bs.hasHB && '幫忙加成',
               /^Helper Boost/.test(me._bs.p.ms) && '幫手加速',
               /^Plus \(/.test(me._bs.p.ms) && '正電',
               /^Minus \(/.test(me._bs.p.ms) && '負電'].filter(Boolean).join('、'),
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
 *  代價：分子也必須是「牠在同一個等級」的產能（`self`），不是畫面上那個當前產能。 */
const IDEAL_LEVEL = 60;
function monIdeal(m){
  const p = D.dex[m.sp];
  const maxSkillLv = (D.ms[p.ms] || {max: 6}).max;
  const ssNames = D.subskills.map(s => s.n);
  /* 評價等級：至少 60，已經更高就用牠自己的 —— 分子分母都在這個等級上。 */
  const lvl = Math.max(IDEAL_LEVEL, m.level);
  const at = {...m, level: lvl};
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

  /* ⑤ 保底：**牠自己（在同一個評價等級上）**也是候選，從結構上保證「理想 ≥ 實際」。
        這裡一定要用 `at` 不是 `m` —— 分母若是 Lv60、分子是 Lv30，比值就沒有意義，
        而且貪婪漏掉組合時會冒出超過 100% 的數字。 */
  let best = null, bestScore = -Infinity;
  for (const c of [cur, {...at, ribbon: 4, skillLv: maxSkillLv, ingSet: cur.ingSet.slice()}, {...at}]){
    const v = val(c); if (v > bestScore){ bestScore = v; best = c; }
  }
  /* `self` ＝ 牠**在評價等級上**的產能，也就是百分比的分子。放在這裡回傳，
     UI 才不用自己再算一次（兩份一定會走鐘）。 */
  return {...monPower(best), member: best, lvl, self: monPower(at)};
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

