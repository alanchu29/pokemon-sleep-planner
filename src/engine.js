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
  return {p, nat, act, h, carry, ingChance, berriesPerDrop, slots, ingVec, avgIngAmt,
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
  if (s.bonusIngredient)  o.ingSpread = (o.ingSpread||0) + at(s.bonusIngredient)/2;
  if (s.energy)           o.energySelf = at(s.energy);
  if (s.potSize)          o.pot = at(s.potSize);
  if (s.selfBerry)        o.selfBerry = at(s.selfBerry);
  if (s.teamBerry)        o.teamBerry = at(s.teamBerry);
  if (s.help)             o.helpsOne = at(s.help);
  if (s.base)             o.helpsAll = at(s.base);
  if (s.latiasBerries)    o.selfBerry = at(s.latiasBerries);
  if (/Energy For Everyone/.test(msName)) { o.energyTeam = o.energySelf||0; delete o.energySelf; }
  if (/Energizing Cheer/.test(msName))   { o.energyTeam = (o.energySelf||0)/5; delete o.energySelf; }
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
  const supportPerStep = nSteps>0 ? ctx.supportEnergy/nSteps : 0;
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
  const bankedProcs = bs.p.sp==='skill' ? 2 : 1;
  const procs = productive*bs.effSkill + Math.min(bankedProcs, nightNormal*bs.effSkill);
  return {freqBase, helpsDay, helpsNight, productive, snack, procs,
          fastHours: fastSteps/6, fastShare: totalSteps ? fastSteps/totalSteps : 0, wakeEnergy: start,
          berries: productive*(1-bs.ingChance)*bs.berriesPerDrop + snack*bs.berriesPerDrop};
}
/** Full per-member per-day output in a given team context. */
function memberOutput(m, wk, ctx){
  const bs = m._bs;
  const sim = simulate(bs, m, wk, ctx);
  const pay = {...skillPayload(bs.p.ms, bs.skillLv)};
  // Helper Boost's real payout depends on how many team-mates share its berry
  if (/^Helper Boost/.test(bs.p.ms))
    pay.helpsAll = HB_TABLE[(ctx.hbU||1)-1][Math.min(bs.skillLv, 6)-1];
  // Minus only hands out energy when a Plus partner is on the team
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
          helpsGiven: sim.procs*((pay.helpsAll||0)*5 + (pay.helpsOne||0)),
          critAdd: Math.min(0.7, sim.procs*(pay.critChance||0)/100)};
}

/* -------- team context resolution + memoised member outputs -------- */
const qE = v => Math.min(120, Math.round(v/15)*15);
const qH = v => Math.round(v*2)/2;
function ctxKey(c){ return c.nHB+'|'+c.nERB+'|'+c.supportEnergy+'|'+c.extraHelps+'|'+c.hbU+'|'+(c.hasPlus?1:0); }
function teamContext(idxs, roster, wk, memo){
  let nHB=0, nERB=0, hasPlus=false, hbU=1;
  for (const i of idxs){
    const bs = roster[i]._bs;
    if (bs.hasHB) nHB++;
    if (bs.hasERB) nERB++;
    if (/^Plus \(/.test(bs.p.ms)) hasPlus = true;
  }
  const hbHolder = idxs.find(i => /^Helper Boost/.test(roster[i]._bs.p.ms));
  if (hbHolder !== undefined){
    const berry = roster[hbHolder]._bs.p.b;
    const uniq = new Set();
    for (const i of idxs) if (roster[i]._bs.p.b === berry) uniq.add(roster[i]._bs.p.n);
    hbU = Math.max(1, Math.min(5, uniq.size));
  }
  // two-pass: neutral context to size team-wide skill support, then re-evaluate
  let ctx = {nHB, nERB, supportEnergy:0, extraHelps:0, hbU, hasPlus};
  for (let pass=0; pass<2; pass++){
    let energy=0, helps=0;
    for (const i of idxs){ const o = getOut(i, roster, wk, ctx, memo); energy += o.energyGiven; helps += o.helpsGiven; }
    const next = {nHB, nERB, hbU, hasPlus, supportEnergy: qE(energy/5), extraHelps: qH(helps/5)};
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

