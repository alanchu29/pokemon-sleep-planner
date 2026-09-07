"use strict";
/* 遊戲資料由 index.html 的 loader 先 fetch 好放在 window.GAMEDATA。
   app.js 刻意是 classic script（不是 module）—— 頂層宣告必須留在全域，
   tests/smoke.mjs 靠 page.evaluate 直接驅動 roster / run() / scoreTeam()。 */
const D = window.GAMEDATA;
const $ = id => document.getElementById(id);
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

const Z = D.zh || {};
const bz  = k => (Z.berries   && Z.berries[k])   || k;
const iz  = k => (Z.ings      && Z.ings[k])      || k;
const pz  = p => (Z.pk        && Z.pk[p.n])      || p.d;
const isl = n => (Z.islands   && Z.islands[n])   || n;
const msz = n => (Z.ms        && Z.ms[n])        || n;
const ssz = n => (Z.subskills && Z.subskills[n]) || n;
const sss = n => (Z.ssShort   && Z.ssShort[n])   || (SS[n] ? SS[n].s : n);
const SPEC_ZH = {berry:"樹果",ingredient:"食材",skill:"技能",all:"全能"};
const NAT_AB = {speed:"速度",ingredient:"食材",skill:"技能",energy:"活力",exp:"EXP"};
const natZ = n => (Z.natures && Z.natures[n.n]) || n.n;
const natLabel = n => natZ(n) + (n.p ? " +"+NAT_AB[n.p]+" −"+NAT_AB[n.m] : " 無修正");
const recipeZh = n => (Z.recipes && Z.recipes[n]) || n.split('_').map(w=>w[0]+w.slice(1).toLowerCase()).join(' ');
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e4 ? Math.round(n/1e3)+'k' : Math.round(n).toLocaleString();
const f1 = n => (Math.round(n*10)/10).toFixed(1);

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
/** Simulate one member's day. ctx = {nHB,nERB,supportEnergy (per day, to each member), extraHelps} */
function simulate(bs, m, wk, ctx){
  const helpSS = Math.max(0.65, 1 - (bs.h('Helping Speed M')?0.14:0) - (bs.h('Helping Speed S')?0.07:0) - 0.05*Math.min(5, ctx.nHB));
  const levelFactor = 1 - 0.002*(m.level-1);
  const freqBase = Math.floor(round4(bs.natureFreqMul * helpSS * levelFactor * bs.ribbonMul) * bs.p.f / (wk.camp?1.2:1));
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
const rlvl = r => {
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
    else { r = wk.recipe; cooksCapped = 0; rv = recipeValue(r, rlvl(r)); fits = r.cnt <= potEff; dishS = 0; }
  } else {
    r = wk.recipe;
    rv = recipeValue(r, rlvl(r));
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
function buildPool(){
  const all = wk.recipeScope === 'all';
  POOL = D.recipes.filter(r => all || r.t === wk.dishType)
    .map(r => ({r, rv: recipeValue(r, rlvl(r)), lv: rlvl(r), cnt: r.cnt}))
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
function bestPlan(wIng, potEff, mul, forced){
  const seeds = forced ? [forced]
    : [null, ...rankSingle(wIng, potEff, mul).slice(0, 8).map(x => x.c.r)];
  let best = null;
  for (const sd of seeds){
    const mp = mealPlan(wIng, potEff, mul, sd);
    if (!best || mp.total > best.total) best = mp;
  }
  return best;
}
/** Greedy fill of all 21 meals from one shared ingredient pool. */
function mealPlan(wIng, potEff, mul, forceFirst){
  const pool = Array.from(wIng);
  const plan = []; let meals = MEALS_WEEK, total = 0, guard = 0;
  if (forceFirst && forceFirst.cnt <= potEff){
    const rv = recipeValue(forceFirst, rlvl(forceFirst));
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

function rankRecipesForTeam(r){
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

/* ================= STATE ================= */
const BLANK = () => ({sp: D.dex.findIndex(p=>p.n==='PIKACHU'), level:30, nature:'Bashful', ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false});
let roster = [];
let wk = {island:'greengrass', fav:new Set(), areaBonus:15, pot:57, sleepH:8.5, camp:0, mode:'total', dishType:'curry', recipeName:null, recipeLv:20, recipePick:'auto', recipeScope:'type', recipeLevels:{}};
let lastResults = null, shownAlt = 0;

/* ================= PERSISTENCE ================= */
/* One codebase, two backends:
   - inside a claude.ai artifact -> the artifact's own database
   - self-hosted (GitHub Pages etc.) -> the user's Google Sheet via Apps Script
   localStorage is always written as an offline copy in both cases. */
let dbRef = null, dbObj = null;
let sync = {url:'', token:'', on:false};
const statusEl = document.getElementById('saveStatus');
function setStatus(t){ statusEl.textContent = t; }
function setSyncStatus(t){ const e = $('syncStatus'); if (e) e.textContent = t; }

function serialize(){
  return {roster: roster.map(m=>({sp:D.dex[m.sp].n, level:m.level, nature:m.nature, ss:m.ss, ingSet:m.ingSet, skillLv:m.skillLv, ribbon:m.ribbon, pin:!!m.pin, ex:!!m.ex})),
          wk: {...wk, fav:[...wk.fav], recipe:undefined}, updatedAt: new Date().toISOString(), v:1};
}
function deserialize(o){
  if (!o) return;
  if (Array.isArray(o.roster)) roster = o.roster.map(r=>{
    const sp = D.dex.findIndex(p=>p.n===r.sp);
    return {...BLANK(), ...r, sp: sp<0?0:sp, ss:(r.ss||[null,null,null,null,null]).slice(0,5), ingSet:(r.ingSet||[0,0,0]).slice(0,3)};
  });
  if (o.wk){ const f = o.wk.fav||[]; wk = {...wk, ...o.wk, fav:new Set(f), recipeLevels:o.wk.recipeLevels||{}}; }
}
/** A human-readable mirror of the roster, so the Sheet is worth opening. */
function rosterTable(){
  const head = ['種類','圖鑑','等級','性格','副技能1','副技能2','副技能3','副技能4','副技能5','食材1','食材2','食材3','技能Lv','主技能','緞帶','固定','排除'];
  const RIB = ['無','200h','500h','1000h','2000h'];
  const rows = roster.map(m=>{
    const p = D.dex[m.sp], opts = [p.i0, p.i30, p.i60];
    const ings = [0,1,2].map(k=>{
      const list = opts[k] || [];
      const pick = list[Math.min(m.ingSet[k]||0, list.length-1)];
      return pick ? iz(ING_NAME[pick[0]]) + '×' + pick[1] : '';
    });
    return [pz(p), p.no, m.level, natZ(NAT[m.nature]||NAT.Bashful),
            ...[0,1,2,3,4].map(i=>m.ss[i] ? ssz(m.ss[i]) : ''),
            ...ings, m.skillLv, msz(p.ms), RIB[m.ribbon||0], m.pin?'是':'', m.ex?'是':''];
  });
  return [head, ...rows];
}

/* ---- Google Sheet backend ---- */
function loadSyncConfig(){
  try {
    sync.url = localStorage.getItem('psleep-sync-url') || '';
    sync.token = localStorage.getItem('psleep-sync-token') || '';
    sync.on = !!(sync.url && sync.token);
  } catch(e){}
}
function saveSyncConfig(){
  try {
    localStorage.setItem('psleep-sync-url', sync.url);
    localStorage.setItem('psleep-sync-token', sync.token);
  } catch(e){}
}
async function sheetGet(){
  const u = sync.url + (sync.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(sync.token);
  const res = await fetch(u, {method:'GET', redirect:'follow'});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.data || null;
}
async function sheetPut(payload){
  // text/plain keeps this a "simple request" — Apps Script does not answer CORS preflight
  const res = await fetch(sync.url, {method:'POST', redirect:'follow',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify({token: sync.token, data: payload, table: rosterTable()})});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j;
}

let saveTimer = null;
function save(){
  const payload = serialize();
  try { localStorage.setItem('psleep-box', JSON.stringify(payload)); } catch(e){}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    if (dbRef){
      try { await dbRef.set(payload); setStatus('已同步'); }
      catch(e){ setStatus('同步失敗（本機已存）'); }
    } else if (sync.on){
      setStatus('上傳中…');
      try { await sheetPut(payload); setStatus('已同步 Sheet'); setSyncStatus('已上傳 ' + new Date().toLocaleTimeString('zh-TW')); }
      catch(e){ setStatus('Sheet 同步失敗（本機已存）'); setSyncStatus('上傳失敗：' + e.message); }
    }
  }, 900);
}

async function boot(){
  loadSyncConfig();
  try { const raw = localStorage.getItem('psleep-box'); if (raw) deserialize(JSON.parse(raw)); } catch(e){}
  const selfHosted = !window.claude;
  if (selfHosted && $('syncSection')) $('syncSection').hidden = false;
  if ($('syncUrl')){ $('syncUrl').value = sync.url; $('syncToken').value = sync.token; }
  renderAll();

  const db = await (window.claude && window.claude.use ? window.claude.use('db') : Promise.resolve(null));
  if (db){
    dbObj = db;
    dbRef = db.doc('box/main');
    try {
      const snap = await dbRef.get();
      if (snap.exists) { deserialize(snap.data()); renderAll(); setStatus('已同步'); }
      else { await dbRef.set(serialize()); setStatus('已同步'); }
    } catch(e){ setStatus('只存在這台裝置'); }
    Promise.all([db.doc('meta/status').get(), db.doc('meta/refresh').get()]).then(([st,rq])=>{
      if (st.exists) metaStatus = st.data();
      if (rq.exists) metaReq = rq.data();
      renderVersion();
    }).catch(()=>{});
    return;
  }

  if (sync.on){
    setStatus('連線 Sheet…'); setSyncStatus('連線中…');
    try {
      const remote = await sheetGet();
      const localRaw = localStorage.getItem('psleep-box');
      const local = localRaw ? JSON.parse(localRaw) : null;
      // last write wins
      if (remote && (!local || !local.updatedAt || (remote.updatedAt || '') >= local.updatedAt)){
        deserialize(remote); renderAll();
        setStatus('已同步 Sheet'); setSyncStatus('已下載雲端版本（' + (remote.updatedAt||'').slice(0,16).replace('T',' ') + '）');
      } else if (local){
        await sheetPut(local);
        setStatus('已同步 Sheet'); setSyncStatus('本機較新，已上傳');
      } else {
        setStatus('已同步 Sheet'); setSyncStatus('雲端為空');
      }
    } catch(e){
      setStatus('Sheet 連線失敗（用本機資料）'); setSyncStatus('連線失敗：' + e.message);
    }
  } else {
    setStatus('只存在這台裝置');
    setSyncStatus(selfHosted ? '尚未設定' : '');
  }
}

/* ---- sync panel wiring ---- */
if ($('syncPull')){
  const readFields = ()=>{
    sync.url = $('syncUrl').value.trim();
    sync.token = $('syncToken').value.trim();
    sync.on = !!(sync.url && sync.token);
    saveSyncConfig();
  };
  $('syncPull').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('連線中…');
    try {
      const remote = await sheetGet();
      if (remote){ deserialize(remote); renderAll(); setSyncStatus('已下載（' + (remote.roster||[]).length + ' 隻）'); setStatus('已同步 Sheet'); }
      else { setSyncStatus('連線成功，但雲端還是空的 —— 按「立即上傳」把本機資料推上去'); }
    } catch(e){ setSyncStatus('連線失敗：' + e.message); }
  });
  $('syncPush').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('上傳中…');
    try { await sheetPut(serialize()); setSyncStatus('已上傳 ' + roster.length + ' 隻'); setStatus('已同步 Sheet'); }
    catch(e){ setSyncStatus('上傳失敗：' + e.message); }
  });
  $('syncOff').addEventListener('click', ()=>{
    sync = {url:'', token:'', on:false};
    $('syncUrl').value = ''; $('syncToken').value = '';
    saveSyncConfig(); setSyncStatus('已停用，資料只留在這台瀏覽器'); setStatus('只存在這台裝置');
  });
}

/* ================= UI: weekly ================= */
function buildWeekly(){
  $('island').innerHTML = D.islands.map(i=>`<option value="${i.s}">${isl(i.n)}</option>`).join('');
  $('favBerries').innerHTML = BERRY_NAMES.map(b=>`<button type="button" class="chip" data-berry="${b}" aria-pressed="false" title="${b.toLowerCase()}">${bz(b)}</button>`).join('');
  $('favBerries').addEventListener('click', e=>{
    const b = e.target.closest('[data-berry]'); if (!b) return;
    const k = b.dataset.berry;
    if (wk.fav.has(k)) wk.fav.delete(k); else wk.fav.add(k);
    syncWeeklyUI(); save();
  });
  $('island').addEventListener('change', e=>{
    wk.island = e.target.value;
    const isl = D.islands.find(i=>i.s===wk.island);
    if (isl && isl.b.length){ wk.fav = new Set(isl.b); }
    syncWeeklyUI(); save();
  });
  $('dishType').addEventListener('change', e=>{ wk.dishType = e.target.value; wk.recipeName = null; fillRecipes(); save(); });
  $('recipe').addEventListener('change', e=>{ wk.recipeName = e.target.value; save(); });
  for (const [id, key, num] of [['areaBonus','areaBonus',1],['pot','pot',1],['sleepH','sleepH',1],['recipeLv','recipeLv',1],['camp','camp',1]]){
    $(id).addEventListener('change', e=>{ wk[key] = num ? Number(e.target.value) : e.target.value; save(); });
  }
  $('mode').addEventListener('change', e=>{ wk.mode = e.target.value; save(); });
  $('recipePick').addEventListener('change', e=>{ wk.recipePick = e.target.value; syncWeeklyUI(); save(); });
  $('recipeScope').addEventListener('change', e=>{ wk.recipeScope = e.target.value; syncWeeklyUI(); save(); });
  $('runBtn').addEventListener('click', run);
}
function fillRecipes(){
  const list = D.recipes.filter(r=>r.t===wk.dishType).sort((a,b)=>a.cnt-b.cnt);
  $('recipe').innerHTML = list.map(r=>{
    const ings = r.ings.map(([i,a])=>iz(ING_NAME[i])+'×'+a).join('・');
    return `<option value="${r.n}">${recipeZh(r.n)} — ${ings}（共 ${r.cnt}）</option>`;
  }).join('');
  if (!wk.recipeName || !list.some(r=>r.n===wk.recipeName)){
    const pick = list.find(r=>r.cnt>=21) || list[list.length-1];
    wk.recipeName = pick && pick.n;
  }
  $('recipe').value = wk.recipeName;
}
function syncWeeklyUI(){
  $('island').value = wk.island; $('areaBonus').value = wk.areaBonus; $('pot').value = wk.pot;
  $('sleepH').value = wk.sleepH; $('camp').value = wk.camp; $('mode').value = wk.mode;
  $('dishType').value = wk.dishType; $('recipeLv').value = wk.recipeLv;
  $('recipePick').value = wk.recipePick; $('recipeScope').value = wk.recipeScope;
  const nSet = Object.keys(wk.recipeLevels||{}).length;
  $('rlvCount').textContent = nSet ? `（${nSet} 道已個別設定）` : '';
  const auto = wk.recipePick === 'auto';
  $('recipe').disabled = auto;
  $('recipe').style.opacity = auto ? .5 : 1;
  $('recipeAutoNote').textContent = auto ? '（自動模式下由推演決定，這裡只是備援）' : '';
  $('dishType').disabled = auto && wk.recipeScope === 'all';
  for (const el of $('favBerries').querySelectorAll('[data-berry]'))
    el.setAttribute('aria-pressed', wk.fav.has(el.dataset.berry) ? 'true' : 'false');
  fillRecipes();
}

/* ================= UI: box ================= */
const SPECIES_OPTS = D.dex.map((p,i)=>`<option value="${i}">${pz(p)}　#${p.no} ${p.d} · ${SPEC_ZH[p.sp]} · ${bz(p.b)}</option>`).join('');
const NATURE_OPTS = D.natures.map(n=>`<option value="${n.n}">${natLabel(n)}</option>`).join('');
const SS_OPTS = `<option value="">—</option>` + D.subskills.map(s=>`<option value="${s.n}" title="${ssz(s.n)}">${sss(s.n)}</option>`).join('');
function ingSetOpts(m, slot){
  const p = D.dex[m.sp], list = [p.i0, p.i30, p.i60][slot] || [];
  if (!list.length) return `<option value="0">—</option>`;
  return list.map((x,i)=>`<option value="${i}">${iz(ING_NAME[x[0]])}×${x[1]}</option>`).join('');
}
function renderBox(){
  const host = $('boxList');
  $('boxEmpty').style.display = roster.length ? 'none' : 'block';
  host.innerHTML = roster.map((m,idx)=>{
    const p = D.dex[m.sp];
    const slots = Math.min(Math.floor(m.level/30)+1, 3);
    return `<div class="boxrow" data-i="${idx}">
      <div data-lbl="種類"><select data-k="sp">${SPECIES_OPTS}</select></div>
      <div data-lbl="等級"><input type="number" data-k="level" min="1" max="70" value="${m.level}"></div>
      <div data-lbl="性格"><select data-k="nature">${NATURE_OPTS}</select></div>
      <div data-lbl="副技能"><div class="ss-mini">${[0,1,2,3,4].map(s=>
        `<select data-k="ss" data-s="${s}" title="第 ${s+1} 格 — Lv${SS_SLOT_LV[s]} 解鎖${m.ss[s]?'：'+ssz(m.ss[s]):''}"${m.level<SS_SLOT_LV[s]?' style="opacity:.45"':''}>${SS_OPTS}</select>`).join('')}</div></div>
      <div data-lbl="食材組合"><div class="ss-mini" style="grid-template-columns:repeat(3,1fr)">${[0,1,2].map(s=>
        `<select data-k="ingSet" data-s="${s}"${s>=slots?' disabled style="opacity:.35"':''}>${ingSetOpts(m,s)}</select>`).join('')}</div></div>
      <div data-lbl="技能Lv"><input type="number" data-k="skillLv" min="1" max="8" value="${m.skillLv}"></div>
      <div data-lbl="緞帶"><select data-k="ribbon" title="睡眠緞帶：縮短未進化寶可夢的幫手間隔並提升攜帶上限">${
        ['無','200h','500h','1000h','2000h'].map((t,i)=>`<option value="${i}">${t}</option>`).join('')}</select></div>
      <div data-lbl="" style="display:flex;gap:5px;justify-content:flex-end">
        <button class="btn sm ghost" data-act="pin" title="固定在隊上">${m.pin?'📌':'📍'}</button>
        <button class="btn sm ghost" data-act="ex" title="排除">${m.ex?'🚫':'○'}</button>
        <button class="btn sm ghost" data-act="del" title="刪除">✕</button>
      </div>
    </div>`;
  }).join('');
  roster.forEach((m,idx)=>{
    const row = host.querySelector(`[data-i="${idx}"]`);
    row.querySelector('[data-k="sp"]').value = m.sp;
    row.querySelector('[data-k="nature"]').value = m.nature;
    row.querySelectorAll('[data-k="ss"]').forEach(s=>{ s.value = m.ss[+s.dataset.s] || ''; });
    row.querySelectorAll('[data-k="ingSet"]').forEach(s=>{ s.value = String(m.ingSet[+s.dataset.s]||0); });
    row.querySelector('[data-k="ribbon"]').value = String(m.ribbon||0);
    row.style.opacity = m.ex ? .5 : 1;
  });
}
$('boxList').addEventListener('change', e=>{
  const row = e.target.closest('[data-i]'); if (!row) return;
  const m = roster[+row.dataset.i], k = e.target.dataset.k;
  if (!k) return;
  if (k==='sp'){ m.sp = +e.target.value; m.ingSet = [0,0,0]; m.skillLv = 1; renderBox(); }
  else if (k==='ss') m.ss[+e.target.dataset.s] = e.target.value || null;
  else if (k==='ingSet') m.ingSet[+e.target.dataset.s] = +e.target.value;
  else if (k==='level'){ m.level = Math.max(1, Math.min(70, +e.target.value||1)); renderBox(); }
  else if (k==='skillLv') m.skillLv = Math.max(1, Math.min(8, +e.target.value||1));
  else if (k==='nature') m.nature = e.target.value;
  else if (k==='ribbon') m.ribbon = +e.target.value;
  save();
});
$('boxList').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const i = +btn.closest('[data-i]').dataset.i, a = btn.dataset.act;
  if (a==='del') roster.splice(i,1);
  else if (a==='pin'){ roster[i].pin = !roster[i].pin; if (roster[i].pin) roster[i].ex = false; }
  else if (a==='ex'){ roster[i].ex = !roster[i].ex; if (roster[i].ex) roster[i].pin = false; }
  renderBox(); save();
});
$('addBtn').addEventListener('click', ()=>{ roster.push(BLANK()); renderBox(); save();
  const rows = $('boxList').querySelectorAll('[data-i]'); rows[rows.length-1].scrollIntoView({block:'nearest'}); });
$('exportBtn').addEventListener('click', async ()=>{
  const t = JSON.stringify(serialize());
  try { await navigator.clipboard.writeText(t); setStatus('JSON 已複製'); }
  catch(e){ window.prompt('複製下面的 JSON：', t); }
});
$('importBtn').addEventListener('click', ()=>{
  const t = window.prompt('把先前複製的 JSON 貼在這裡：');
  if (!t) return;
  try { deserialize(JSON.parse(t)); renderAll(); save(); setStatus('已匯入'); }
  catch(e){ setStatus('JSON 格式不正確'); }
});

/* ================= RUN ================= */
function combinations(pool, k, pinned, cb){
  const idx = new Array(k);
  const need = k - pinned.length;
  if (need < 0) return;
  (function rec(start, depth){
    if (depth === need){ cb(pinned.concat(idx.slice(0, need))); return; }
    for (let i=start; i<=pool.length-(need-depth); i++){ idx[depth] = pool[i]; rec(i+1, depth+1); }
  })(0, 0);
}
function run(){
  const active = roster.map((m,i)=>({m,i})).filter(x=>!x.m.ex);
  if (active.length < 5){ $('results').innerHTML = `<div class="notice warn">箱子裡至少要有 5 隻可用的寶可夢（目前 ${active.length} 隻）。</div>`; return; }
  wk.recipe = D.recipes.find(r=>r.n===wk.recipeName) || D.recipes[0];
  buildPool();
  if (!POOL.length){ $('results').innerHTML = `<div class="notice warn">目前的料理類型／範圍下沒有任何食譜可比較。</div>`; return; }
  $('runStatus').textContent = '推演中…';
  roster.forEach(m=>{ m._bs = baseStats(m, wk); });
  setTimeout(()=>{
    const t0 = performance.now();
    const pinned = active.filter(x=>x.m.pin).map(x=>x.i);
    if (pinned.length > 5){ $('results').innerHTML = `<div class="notice warn">固定（📌）的寶可夢超過 5 隻，請減少到 5 隻以內。</div>`; $('runStatus').textContent=''; return; }
    let pool = active.map(x=>x.i).filter(i=>!pinned.includes(i));
    const memo = new Map();
    // pre-filter very large boxes by solo score
    const nC = (n,k)=>{ let r=1; for(let i=0;i<k;i++) r = r*(n-i)/(i+1); return r; };
    let trimmed = false;
    if (nC(pool.length, 5-pinned.length) > 1.2e6){
      const solo = pool.map(i=>({i, s: scoreTeam([i,i,i,i,i].slice(0,1).concat(pool.filter(j=>j!==i).slice(0,4)), roster, wk, memo).score}));
      solo.sort((a,b)=>b.s-a.s);
      pool = solo.slice(0, 42-pinned.length).map(x=>x.i);
      trimmed = true;
    }
    const FINALISTS = 50, SHOWN = 8;
    const best = [];
    let count = 0;
    combinations(pool, 5, pinned, idxs=>{
      count++;
      const r = scoreTeam(idxs, roster, wk, memo);
      if (best.length < FINALISTS){ best.push(r); best.sort((a,b)=>b.score-a.score); }
      else if (r.score > best[FINALISTS-1].score){ best[FINALISTS-1] = r; best.sort((a,b)=>b.score-a.score); }
    });
    // finalists get the expensive treatment: fill all 21 meals from one shared pool
    for (const b of best){
      const mp = bestPlan(b.wIng, b.potEff, b.mul, wk.recipePick==='manual' ? wk.recipe : null);
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
    best.sort((a,b)=>b.score-a.score);
    const ms = Math.round(performance.now()-t0);
    lastResults = best.slice(0, SHOWN); shownAlt = 0;
    $('comboCount').textContent = `${count.toLocaleString()} 種組合 · ${ms}ms${trimmed?' · 已預篩至前 42 隻':''}`;
    $('runStatus').textContent = '';
    renderResults();
  }, 20);
}

/* ================= RESULTS RENDER ================= */
function memberCard(rank, i, r, o){
  const m = roster[i], p = D.dex[m.sp], bs = m._bs;
  const act = bs.act.map(a=>sss(a));
  const ingList = [];
  for (let k=0;k<NING;k++) if (o.ing[k]*7 > 12) ingList.push(iz(ING_NAME[k])+' '+f1(o.ing[k]*7));
  return `<div class="mem">
    <div class="rank">${rank}</div>
    <div>
      <div class="nm">${pz(p)}<span class="tag ${p.sp}">${SPEC_ZH[p.sp]}</span>${wk.fav.has(p.b)?`<span class="tag fav">加成樹果</span>`:''}${m.pin?`<span class="tag pin">固定</span>`:''}</div>
      <div class="meta">Lv${m.level} · ${natZ(NAT[m.nature]||NAT.Bashful)} · ${act.length?act.join('／'):'無副技能'} · 頻率 ${Math.round(o.sim.freqBase/60*10)/10}分</div>\n      <div class="meta">${msz(p.ms)} Lv${bs.skillLv} · 每日發動 ${f1(o.sim.procs)} 次</div>
      <div class="meta" style="color:var(--ing)">${ingList.length?ingList.join('　'):'（無食材產出）'}</div>
    </div>
    <div class="out">
      <div><span class="muted">週能量</span> ${fmt((o.berryStrength+o.skillStrength)*7*(1+wk.areaBonus/100))}</div>
      <div class="muted">幫手 ${f1(o.sim.productive)}／日${o.sim.snack>0.5?` · 偷吃 ${f1(o.sim.snack)}`:''}</div>
      <div class="muted" style="color:${o.sim.fastShare>=0.6?'var(--pos)':o.sim.fastShare>=0.3?'var(--ing)':'var(--neg)'}">最快檔位 ${f1(o.sim.fastHours)}h／日（${Math.round(o.sim.fastShare*100)}%）</div>
    </div>
  </div>`;
}
function renderResults(){
  if (!lastResults || !lastResults.length){
    $('results').innerHTML = roster.filter(m=>!m.ex).length < 5
      ? `<div class="notice">先到右上角「寶可夢箱」分頁建立至少 5 隻，才能開始推演。</div>`
      : `<div class="notice">設定好本週條件後，按「推演最佳隊伍」。</div>`;
    return;
  }
  const r = lastResults[shownAlt];
  const TR = r.recipe;
  const recipeIngs = new Map(TR.ings);
  const bars = TR.ings.map(([i,a])=>{
    const have = r.wIng[i], canCook = Math.floor(have/a);
    const ratio = Math.min(1, canCook/MEALS_WEEK), short = canCook < MEALS_WEEK;
    return `<div class="barrow${canCook<1?' lack':''}" title="一週產 ${f1(have)}，每次需 ${a}">
      <div>${iz(ING_NAME[i])}</div>
      <div class="bar"><i style="width:${Math.max(ratio*100,1.5).toFixed(1)}%;background:${canCook<1?'var(--neg)':short?'var(--ing)':'var(--pos)'}"></i></div>
      <div class="v">${canCook} 次</div>
    </div>`;
  }).join('');
  const extra = [];
  for (let k=0;k<NING;k++) if (!recipeIngs.has(k) && r.wIng[k] > 15) extra.push([k, r.wIng[k]]);
  extra.sort((a,b)=>b[1]-a[1]);

  const warn = !r.fits ? `<div class="notice warn">鍋子容量不足：這道食譜需要 ${TR.cnt} 個食材，你目前平日有效容量 ${r.potEff}。換小一點的食譜，或把「食譜選擇」切到自動配對讓它自己挑。</div>` : '';
  const bn = r.bottleneck!=null ? iz(ING_NAME[r.bottleneck]) : '—';

  $('results').innerHTML = `
  ${warn}
  <div class="panel hero" style="margin-top:${warn?'12px':'0'}">
    <div class="roster">
      <div class="eyebrow">建議先發 5 隻</div>
      ${r.idxs.map((i,n)=>memberCard(n+1, i, r, r.outs[n])).join('')}
      <div class="pillrow" style="margin-top:4px">
        <span class="pill">HB ×${r.ctx.nHB}</span>
        <span class="pill">ERB ×${r.ctx.nERB}</span>
        <span class="pill">技能補能量 ${Math.round(r.ctx.supportEnergy)}/日</span>
        ${r.ctx.extraHelps>0.2?`<span class="pill">額外幫手 ${f1(r.ctx.extraHelps)}/日</span>`:''}
      </div>
    </div>
    <div class="totals">
      <div>
        <div class="eyebrow">本週卡比獸總能量</div>
        <div class="bigfig">${fmt(r.total)}</div>
      </div>
      <div>
        <div class="subfig"><span>樹果</span><b>${fmt(r.berryS)}</b></div>
        <div class="subfig"><span>料理</span><b>${fmt(r.dishS)}</b></div>
        <div class="subfig"><span>主技能</span><b>${fmt(r.skillS)}</b></div>
      </div>
      <div>
        <div class="eyebrow">${wk.recipePick==='auto'?'自動選中的主食譜':'指定食譜'}</div>
        <div style="font-size:13.5px;font-weight:700;margin:3px 0 2px">${recipeZh(TR.n)}</div>
        <div class="subfig"><span>主食譜可煮</span><b>${r.cooksCapped} / 21 餐</b></div>
        <div class="subfig"><span>單道能量 (Lv${rlvl(TR)})</span><b>${fmt(r.rv)}</b></div>
        <div class="subfig"><span>瓶頸食材</span><b>${bn}</b></div>
      </div>
    </div>
  </div>

  <div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);margin-top:16px;gap:16px">
    <div class="panel">
      <div class="phead"><h3>主食譜食材缺口</h3><span class="muted" style="font-size:12px">每樣食材夠煮幾次 · 滿格＝21 餐</span></div>
      <div class="pbody">${bars}
        ${extra.length?`<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
          <div class="eyebrow" style="margin-bottom:6px">其他食材（可換別的食譜）</div>
          <div class="chips">${extra.slice(0,10).map(([k,v])=>`<span class="pill">${iz(ING_NAME[k])} ${f1(v)}</span>`).join('')}</div></div>`:''}
      </div>
    </div>
    <div class="panel">
      <div class="phead"><h3>這隊最能煮的食譜</h3><span class="muted" style="font-size:12px">以目前產量排序</span></div>
      <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
      <table><thead><tr><th>食譜</th><th style="text-align:right">煮/週</th><th style="text-align:right">週能量</th><th></th></tr></thead>
      <tbody>${rankRecipesForTeam(r).slice(0,7).map(x=>`<tr${x.rec.n===wk.recipe.n?' style="background:color-mix(in srgb,var(--accent) 12%,transparent)"':''}>
        <td>${recipeZh(x.rec.n)} <span class="muted num">共${x.rec.cnt}</span>${x.fits?'':' <span class="tag pin">鍋子不足</span>'}</td>
        <td class="n" style="text-align:right">${x.capped}</td>
        <td class="n" style="text-align:right">${fmt(x.strength)}</td>
        <td><button class="btn sm ghost" data-setrecipe="${x.rec.n}">設為目標</button></td></tr>`).join('')}
      </tbody></table></div></div>
    </div>
  </div>

  ${r.mp ? `<div class="panel" style="margin-top:16px">
    <div class="phead"><h3>本週 21 餐排程</h3><span class="muted" style="font-size:12px">同一個食材池貪婪填滿 · 依單道能量由高到低</span></div>
    <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
    <table><thead><tr><th>餐次</th><th>食譜</th><th style="text-align:right">次數</th><th style="text-align:right">單道</th><th style="text-align:right">小計</th></tr></thead>
    <tbody>${r.mp.plan.map((x,n)=>`<tr>
      <td class="n">${n+1}</td>
      <td>${recipeZh(x.r.n)} <span class="muted num">共${x.r.cnt}</span>${(x.primary || x.r.n===TR.n)?' <span class="tag pin">主食譜</span>':''}</td>
      <td class="n" style="text-align:right">${x.n}</td>
      <td class="n" style="text-align:right">${fmt(x.each)}</td>
      <td class="n" style="text-align:right">${fmt(x.n*x.each*r.mul)}</td></tr>`).join('')}
      ${r.mp.idleMeals>0?`<tr><td></td><td class="muted">食材不足，${r.mp.idleMeals} 餐無法排入（實際遊戲會退成拌拌料理）</td><td class="n" style="text-align:right">${r.mp.idleMeals}</td><td></td><td class="n" style="text-align:right">—</td></tr>`:''}
    </tbody></table></div></div>
  </div>` : ''}

  <div class="grid" style="grid-template-columns:1fr;margin-top:16px;gap:16px">
    <div class="panel">
      <div class="phead"><h3>替代隊伍</h3><span class="muted" style="font-size:12px">點一列切換</span></div>
      <div class="pbody" style="padding:0">
        <div class="scroll" style="border:0;border-radius:0 0 12px 12px">
        <table><thead><tr><th>#</th><th>組合</th><th style="text-align:right">週能量</th><th style="text-align:right">煮</th></tr></thead>
        <tbody>${lastResults.map((x,n)=>`<tr class="alt${n===shownAlt?' on':''}" data-alt="${n}">
          <td class="n">${n+1}</td>
          <td>${x.idxs.map(i=>pz(D.dex[roster[i].sp])).join('・')}</td>
          <td class="n" style="text-align:right">${fmt(x.total)}</td>
          <td class="n" style="text-align:right">${x.cooksCapped}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>
  </div>`;
  $('results').querySelectorAll('.alt').forEach(tr=>tr.addEventListener('click', ()=>{ shownAlt = +tr.dataset.alt; renderResults(); }));
  $('results').querySelectorAll('[data-setrecipe]').forEach(b=>b.addEventListener('click', ()=>{
    wk.recipeName = b.dataset.setrecipe; $('recipe').value = wk.recipeName; save(); run();
  }));
}

/* ================= VIEWS ================= */
function showView(name){
  for (const v of ['plan','box','recipes']) $('view-'+v).hidden = (v !== name);
  for (const b of $('viewNav').querySelectorAll('[data-view]'))
    b.setAttribute('aria-pressed', b.dataset.view === name ? 'true' : 'false');
  if (name === 'recipes') renderRecipeLevels();
  window.scrollTo({top:0, behavior:'instant'});
}
$('viewNav').addEventListener('click', e=>{
  const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view);
});

/* ================= RECIPE LEVELS ================= */
const RLB_MAX = D.rlb[70] || 3.58;
function renderRecipeLevels(){
  const type = $('rlvType').value, q = $('rlvSearch').value.trim().toLowerCase();
  const sort = $('rlvSort').value;
  let list = D.recipes.filter(r=>{
    if (type !== 'all' && r.t !== type) return false;
    if (!q) return true;
    const hay = (recipeZh(r.n) + ' ' + r.n + ' ' + r.ings.map(([i])=>iz(ING_NAME[i])).join(' ')).toLowerCase();
    return hay.includes(q);
  }).map(r=>({r, lv: rlvl(r), set: typeof (wk.recipeLevels||{})[r.n] === 'number',
              val: recipeValue(r, rlvl(r))}));
  const cmp = {value:(a,b)=>b.val-a.val, lv:(a,b)=>b.lv-a.lv, cnt:(a,b)=>a.r.cnt-b.r.cnt,
               name:(a,b)=>recipeZh(a.r.n).localeCompare(recipeZh(b.r.n),'zh-Hant')}[sort];
  list.sort(cmp);
  const TYPE_ZH = {curry:'咖哩／濃湯', salad:'沙拉', dessert:'甜點／飲品'};
  $('rlvBody').innerHTML = list.map(x=>{
    const mul = D.rlb[x.lv] || 1;
    return `<tr data-r="${x.r.n}">
      <td><b>${recipeZh(x.r.n)}</b><div class="muted" style="font-size:11.5px">${x.r.ings.map(([i,a])=>iz(ING_NAME[i])+'×'+a).join('・')}</div></td>
      <td class="muted" style="font-size:12px">${TYPE_ZH[x.r.t]}</td>
      <td class="n" style="text-align:right">${x.r.cnt}</td>
      <td style="text-align:center"><input type="number" min="1" max="70" step="1" data-rlv="${x.r.n}" value="${x.set ? x.lv : ''}" placeholder="${wk.recipeLv}"></td>
      <td class="n" style="text-align:right;color:${mul>=2?'var(--pos)':mul>=1.4?'var(--ing)':'var(--muted)'}">×${mul.toFixed(2)}</td>
      <td class="n" style="text-align:right">${fmt(x.val)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="muted" style="padding:22px;text-align:center">沒有符合的食譜</td></tr>`;
  const n = Object.keys(wk.recipeLevels||{}).length;
  $('rlvCount').textContent = n ? `（${n} 道已個別設定）` : '';
}
$('rlvBody').addEventListener('change', e=>{
  const k = e.target.dataset.rlv; if (!k) return;
  wk.recipeLevels = wk.recipeLevels || {};
  const v = e.target.value.trim();
  if (v === '') delete wk.recipeLevels[k];
  else wk.recipeLevels[k] = Math.max(1, Math.min(70, Math.round(Number(v)) || 1));
  save(); renderRecipeLevels();
});
for (const id of ['rlvType','rlvSearch','rlvSort']) $(id).addEventListener('input', renderRecipeLevels);
$('rlvClear').addEventListener('click', ()=>{
  if (!Object.keys(wk.recipeLevels||{}).length) return;
  if (!window.confirm('清除所有個別設定的食譜等級？全部會改回套用預設等級。')) return;
  wk.recipeLevels = {}; save(); renderRecipeLevels();
});

/* ================= DATA VERSION ================= */
let metaStatus = null, metaReq = null;
function renderVersion(){
  const m = D.meta || {};
  const selfHosted = !window.claude;
  $('verSrc').innerHTML = `${m.src||'—'}<br>commit ${m.commit||'—'} · ${m.commitDate||'—'}<br>打包於 ${m.builtAt||'—'}`;
  $('verZh').textContent = m.zhSrc || '—';
  $('verBuild').textContent = selfHosted
    ? '自架版本（GitHub Pages 等）· 寶可夢箱存在你的 Google Sheet 或本機瀏覽器'
    : 'claude.ai artifact 版本 · 寶可夢箱存在 artifact 資料庫';
  $('verCounts').textContent = `${D.dex.length} 隻寶可夢 · ${D.recipes.length} 道食譜 · ${D.subskills.length} 個副技能 · ${D.islands.length} 個研究區域`;
  if (selfHosted){
    $('refreshBtn').disabled = true;
    $('refreshBtn').textContent = '自架版本不適用';
    $('refreshNote').innerHTML = '這是<b>自架版本</b>，遊戲資料是靜態快照，不會自己更新。更新方式：在 repo 根目錄跑 <code>npm run data</code> 從上游重新萃取，確認 <code>git diff data/game.json</code> 合理後 commit。詳見 repo 的 README。';
  }
  const parts = [];
  if (metaStatus && metaStatus.lastCheckedAt) parts.push('檢查：' + metaStatus.lastCheckedAt.slice(0,16).replace('T',' '));
  if (metaStatus && metaStatus.message) parts.push(metaStatus.message);
  if (metaReq && metaReq.requestedAt) parts.push('已排入更新請求：' + metaReq.requestedAt.slice(0,16).replace('T',' '));
  $('verStatus').innerHTML = parts.length ? parts.join('<br>') : '尚無記錄';
}
$('refreshBtn').addEventListener('click', async ()=>{
  const btn = $('refreshBtn');
  if (!dbObj){
    $('refreshNote').innerHTML = window.claude
      ? '<b style="color:var(--neg)">這個檢視連不上雲端資料庫，請求無法排隊。</b> 請直接在對話裡跟 Claude 說「更新資料」。'
      : '<b>自架版本沒有收單機制。</b> 更新方式是在 repo 根目錄跑 <code>npm run data</code> 重新萃取，然後 commit <code>data/game.json</code>。';
    return;
  }
  btn.disabled = true; btn.textContent = '送出中…';
  try {
    metaReq = {requestedAt: new Date().toISOString(), source: 'page'};
    await dbObj.doc('meta/refresh').set(metaReq);
    btn.textContent = '已排入佇列 ✓';
    $('refreshNote').innerHTML = '請求已送出。Claude 下次收單（每週一早上）會比對上游與官網公告，有變動就更新並把結果寫回這裡。<b>等不了的話在對話裡說一句「更新資料」，我當場處理。</b>';
  } catch(e){
    btn.disabled = false; btn.textContent = '請求更新資料';
    $('refreshNote').innerHTML = '<b style="color:var(--neg)">送出失敗。</b> 請直接在對話裡跟 Claude 說「更新資料」。';
  }
  renderVersion();
});

/* ================= THEME ================= */
try { const t = localStorage.getItem('psleep-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch(e){}
$('themeBtn').addEventListener('click', ()=>{
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const now = cur ? cur : (sysDark ? 'dark' : 'light');
  const next = now==='dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('psleep-theme', next); } catch(e){}
});

/* ================= INIT ================= */
function renderAll(){ syncWeeklyUI(); renderBox(); renderResults(); renderVersion(); if (!$('view-recipes').hidden) renderRecipeLevels(); }
buildWeekly();
if (!wk.fav.size) wk.fav = new Set(['ORAN','PAMTRE','PECHA']);
boot().then(()=>{ if (roster.length>=5) run(); });
