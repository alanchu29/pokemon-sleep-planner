"use strict";
/* 截圖匯入的求解層 —— 純函式，不碰 DOM，不讀 app.js 的狀態。
   載入順序：engine.js → import.js → app.js（都是 classic script，共用全域）。

   這個檔在做什麼
   ==============
   遊戲的「寶可夢詳細頁」上並沒有物種名（只有你自己取的暱稱和糖果名），也沒有
   睡眠緞帶的等級。但畫面上有兩個**衍生數字**：

     幫忙間隔（每31分51秒）  持有上限（35個）

   這兩個都是 (物種, 等級, 性格, 副技能, 緞帶, 露營券) 的封閉式函數，而引擎已經
   有那兩條公式。所以不必去辨識物種名 —— 反過來**掃過 246 隻求解**：哪一組
   (物種, 緞帶) 能同時算出畫面上那兩個數字。實測兩隻真實寶可夢都是唯一解。

   這件事的價值不只是「省得選物種」：
     1. 它會**驗證整筆讀取**。等級、性格、幫忙速度副技能、物種只要有一項讀錯，
        等式就會破 —— 所以校驗通過幾乎等於整筆正確。
     2. 它**反解出畫面上看不到的緞帶**（只有 RIBBON_CARRY 那 +0/1/3/6/8 的差異）。
     3. 它**自動決定進化階段**。喇叭芽／口呆花／大食花的食材組合、主技能、樹果
        完全相同，糖果名也一樣，但基礎頻率是 5200／3800／2800 —— 只有 2800 能
        算出 1911 秒。

   絕對不要在這裡複製 engine.js 的公式。`helpInterval` 和 `baseStats().carry`
   都是直接呼叫引擎的那一份 —— 兩份公式一定會走鐘，而走鐘的那份會靜靜地算錯。

   已知的坑：主技能等級
   ====================
   遊戲顯示的是**加成後**的等級，roster 存的 `skillLv` 是**基礎值**。大食花畫面
   顯示 Lv.6 且帶「技能等級提升M」(+2)，所以基礎值是 4。

   而且不能靠「假設遊戲顯示的是加成後」來反推 —— 那是猜的。技能說明裡的數字才是
   真憑據：`Charge Energy S.energy[5] = 43.4` 對上畫面的「回復活力43」，
   `Ingredient Magnet S.ingredient[2] = 11` 對上「隨機獲得11個食材」。所以
   `impSkillLv` 用說明數字**反查有效等級**，再減掉副技能加成得到基礎值。

   範圍型技能（耿鬼的「能量填充S」畫面寫「卡比獸的能量增加393〜1,570」）在快照裡
   只有一個固定值，但那個區間剛好是 [v/2, 2v] —— 所以照樣反查得出來，見
   `impEffFromPayload` 的第二段。 */

/* ---------- 文字正規化與反向查表 ---------- */

/** 全形轉半形、去空白、統一大小寫。遊戲的「食材機率提升Ｍ」可能是全形 Ｍ，
 *  而 zh 對照表裡是半形 M —— 不正規化就對不上。 */
function impNorm(s){
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** 從 zh 子表建反向索引（中文 → 內部名）。同名的話保留第一個。 */
function impRev(table){
  const out = new Map();
  for (const k of Object.keys(table || {})){
    const z = impNorm(table[k]);
    if (z && !out.has(z)) out.set(z, k);
  }
  return out;
}
const IMP_ZH = D.zh || {};
const IMP_REV_NAT = impRev(IMP_ZH.natures);
const IMP_REV_SS  = impRev(IMP_ZH.subskills);
const IMP_REV_MS  = impRev(IMP_ZH.ms);
const IMP_REV_ING = impRev(IMP_ZH.ings);

/** 中文（或內部名）→ 內部名。認不出來回 null。 */
function impLookup(rev, text, valid){
  const n = impNorm(text);
  if (!n) return null;
  if (rev.has(n)) return rev.get(n);
  // 也接受直接輸入內部名（測試與進階使用者）
  if (valid){
    for (const k of valid) if (impNorm(k) === n) return k;
  }
  return null;
}
const impNature   = t => impLookup(IMP_REV_NAT, t, Object.keys(NAT));
const impSubskill = t => impLookup(IMP_REV_SS,  t, Object.keys(SS));
const impMainSkill= t => impLookup(IMP_REV_MS,  t, Object.keys(D.ms));
/** 食材中文 → ING_NAME 的索引。 */
function impIngIndex(text){
  const nm = impLookup(IMP_REV_ING, text, ING_NAME);
  const i = nm == null ? -1 : ING_NAME.indexOf(nm);
  return i < 0 ? null : i;
}

/* ---------- 校驗碼（直接用引擎的公式） ---------- */

/** 畫面上的「幫忙間隔」，單位秒。遊戲顯示的是單隻的值，所以 nHB = 0。 */
function impInterval(m, camp){
  const wk = {camp: camp ? 1 : 0};
  return helpInterval(baseStats(m, wk), m, wk, 0);
}
/** 畫面上的「持有上限」，單位個。 */
function impCarry(m, camp){
  return baseStats(m, {camp: camp ? 1 : 0}).carry;
}
/** 「每31分51秒」→ 1911。 */
const impSecs = (min, sec) => (Number(min) || 0) * 60 + (Number(sec) || 0);

/* ---------- 主技能等級 ---------- */

/** 已解鎖欄位裡「技能等級提升」給的加成。欄位順序有意義（SS_SLOT_LV）。 */
function impSkillBonus(ss, level){
  let b = 0;
  for (let i = 0; i < 5; i++){
    if (!ss[i] || level < SS_SLOT_LV[i]) continue;
    if (ss[i] === 'Skill Level Up M') b += 2;
    else if (ss[i] === 'Skill Level Up S') b += 1;
  }
  return b;
}
/** 掃 D.ms[msName] 的所有數值陣列，回傳「哪些有效等級的值等於 payload」。
 *  `ranged` 改成拿 v/2 與 2v 去比對（範圍型技能顯示的兩端）。 */
function impPayloadHits(e, payload, ranged){
  const hits = new Set();
  for (const k of Object.keys(e)){
    const arr = e[k];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++){
      const v = arr[i];
      if (typeof v !== 'number') continue;
      for (const c of (ranged ? [v / 2, v * 2] : [v]))
        if (Math.round(c) === payload || Math.floor(c) === payload){ hits.add(i + 1); break; }
    }
  }
  return hits;
}
/** 用技能說明裡的數字反查有效等級。對不到唯一解就回 null（不猜）。
 *  回傳 {lv, ranged}。
 *
 *  兩段式。**第一段**拿 payload 直接比對快照裡的值 —— 畫面「回復活力43」對上
 *  `Charge Energy S.energy[5] = 43.4`。
 *
 *  **第二段**處理範圍型技能。遊戲對能量填充類的某些技能顯示的是一個區間
 *  （耿鬼「卡比獸的能量增加393〜1,570」），而快照只存一個固定值
 *  `Charge Strength S.strength[2] = 785` —— 區間剛好就是 [v/2, 2v]
 *  （393 = round(785/2)、1570 = 785×2；隆隆岩的 285〜1,138 對 569 也一樣）。
 *  所以不管使用者填的是區間的哪一端都反解得出來。
 *
 *  第二段**只在第一段一個都對不到時**啟用，所以原本就有唯一解的情形不受影響。
 *  掃過 D.ms 全部技能 × 全部等級的兩端：唯一且正確 298 筆、多解退回 null 68 筆、
 *  **唯一但錯 0 筆** —— 不會靜靜地給出錯的等級。 */
function impEffFromPayload(msName, payload){
  const e = D.ms[msName];
  if (!e || payload == null || !isFinite(payload)) return null;
  const exact = impPayloadHits(e, payload, false);
  if (exact.size === 1) return {lv: [...exact][0], ranged: false};
  if (exact.size) return null;                    // 精確比對就已經多解 —— 不猜
  const wide = impPayloadHits(e, payload, true);
  return wide.size === 1 ? {lv: [...wide][0], ranged: true} : null;
}
/** 決定 roster 要存的基礎 skillLv。
 *  payload（說明裡的數字）優先；沒有就退回畫面顯示的等級當有效等級。 */
function impSkillLv(msName, displayedLv, payload, bonus){
  const max = (D.ms[msName] || {max:6}).max;
  const hit = impEffFromPayload(msName, payload);
  const fromPay = hit ? hit.lv : null;
  const disp = (displayedLv != null && isFinite(displayedLv)) ? Math.round(displayedLv) : null;
  const effective = fromPay != null ? fromPay : (disp != null ? disp : 1);
  const base = Math.max(1, Math.min(max, effective - bonus));
  const notes = [];
  if (hit && hit.ranged)
    notes.push(`說明裡的「${payload}」是範圍型技能區間的一端（遊戲顯示 v/2〜2v），反查出有效等級 ${fromPay}`);
  if (fromPay != null && disp != null && disp !== fromPay){
    notes.push(disp === fromPay - bonus
      ? `畫面的 Lv.${disp} 看起來是基礎值，說明數字推出有效等級 ${fromPay}`
      : `畫面的 Lv.${disp} 與說明數字推出的有效等級 ${fromPay} 不一致 —— 請確認`);
  }
  if (fromPay == null && payload != null)
    notes.push('技能說明的數字對不到唯一的等級，改用畫面顯示的等級（請自己確認）');
  if (bonus > 0 && effective >= max)
    notes.push(`有效等級已達上限 ${max}，基礎值只能推到「至少 ${base}」（再高也一樣，不影響計算）`);
  return {base, effective, max, bonus,
          source: fromPay != null ? (hit.ranged ? 'payload-range' : 'payload') : 'displayed', notes};
}

/* ---------- 食材欄位 ---------- */

/** 用 ×N 的數字收斂食材欄位。
 *  格1（i0）246 隻裡有 244 隻只有一個選項 → 物種一定就確定。
 *  格2／格3 光靠數字唯一判定的比例是 65.0% / 45.9%，其餘留成 2~3 選 1。
 *
 *  **還沒解鎖的格子也一樣要解。** 遊戲會把它預告出來（🔒Lv.60 加上食材圖與 ×N），
 *  所以 `counts` 裡本來就有那個數字 —— 跳過它就等於靜靜地填了「選項 0」。實際
 *  踩過：耿鬼 Lv50 的第 3 格畫面是「品鮮蘑菇×6」，跳過的話會存成「火辣香草×7」，
 *  而且因為 `baseStats` 只讀 `slots` 格，錯了也不會有任何數字跑掉 —— 一路等到
 *  升上 Lv.60 才會發現。回傳的 `slots` 只給 UI 標「這格還沒生效」用。 */
function impIngSets(sp, level, counts){
  const p = D.dex[sp], opts = [p.i0, p.i30, p.i60];
  const slots = Math.min(Math.floor(level / 30) + 1, 3);
  const pick = [0, 0, 0], amb = [null, null, null];
  for (let s = 0; s < 3; s++){
    const list = opts[s] || [];
    if (!list.length) continue;
    const want = counts && counts[s] != null ? Number(counts[s]) : null;
    if (!(want > 0)){                       // 沒讀到數字 → 整格都是候選
      amb[s] = list.map((_, i) => i);
      continue;
    }
    const hits = [];
    for (let i = 0; i < list.length; i++) if (list[i] && list[i][1] === want) hits.push(i);
    if (!hits.length) return {impossible: true, slot: s, want};
    pick[s] = hits[0];
    if (hits.length > 1) amb[s] = hits;
  }
  return {impossible: false, pick, amb, slots};
}

/* ---------- 求解 ---------- */

/** obs = 一張截圖上直接看得到的東西。缺的欄位一律傳 null —— 缺得越多候選越多，
 *  但不會算錯。
 *
 *  {level, specialty, mainSkill, skillDisplayLv, skillPayload, nature, ss[5],
 *   ingCounts[3], berry, intervalSec, carry, camp}
 *
 *  回傳 {cands:[...], notes:[]}，cands 依「校驗通過的項數」排序。每個 cand 帶
 *  一個可以直接丟進 roster 的 `m`，以及 checks / amb 供 UI 標示。 */
function impSolve(obs){
  obs = obs || {};
  const notes = [];
  const level = Math.max(1, Math.min(70, Math.round(Number(obs.level) || 1)));
  if (!obs.level) notes.push('沒有等級 —— 副技能欄位解鎖與食材欄位數都算不準');
  const nature = obs.nature && NAT[obs.nature] ? obs.nature : 'Bashful';
  const ss = [0,1,2,3,4].map(i => {
    const v = obs.ss && obs.ss[i];
    return v && SS[v] ? v : null;
  });
  const bonus = impSkillBonus(ss, level);
  const wantIv = obs.intervalSec > 0 ? Math.round(obs.intervalSec) : null;
  const wantCr = obs.carry > 0 ? Math.round(obs.carry) : null;
  if (!wantIv && !wantCr) notes.push('沒有幫忙間隔也沒有持有上限 —— 無法反解物種與緞帶，只能靠篩選');

  // 露營券沒指定就兩種都試（畫面上的數字會因為 ×1.2 而不同）
  const camps = obs.camp == null ? [false, true] : [!!obs.camp];
  const cands = [];
  for (const camp of camps){
    for (let sp = 0; sp < D.dex.length; sp++){
      const p = D.dex[sp];
      if (obs.specialty && p.sp !== obs.specialty) continue;
      if (obs.mainSkill && p.ms !== obs.mainSkill) continue;
      if (obs.berry && p.b !== obs.berry) continue;
      const ing = impIngSets(sp, level, obs.ingCounts);
      if (ing.impossible) continue;
      for (let rb = 0; rb < 5; rb++){
        const sk = impSkillLv(p.ms, obs.skillDisplayLv, obs.skillPayload, bonus);
        const m = {sp, level, nature, ss: ss.slice(), ingSet: ing.pick.slice(),
                   skillLv: sk.base, ribbon: rb, pin: false, ex: false};
        const iv = impInterval(m, camp), cr = impCarry(m, camp);
        if (wantIv != null && iv !== wantIv) continue;
        if (wantCr != null && cr !== wantCr) continue;
        cands.push({
          m, camp, interval: iv, carry: cr,
          amb: ing.amb, slots: ing.slots, skill: sk,
          checks: {interval: wantIv != null, carry: wantCr != null},
          score: (wantIv != null ? 2 : 0) + (wantCr != null ? 2 : 0)
                 + (obs.mainSkill ? 1 : 0) + (obs.specialty ? 1 : 0),
        });
      }
    }
  }
  // 校驗項數多的排前面；同分時未進化的（re 大）排後面，因為完全進化的更常見
  cands.sort((a, b) => b.score - a.score || D.dex[a.m.sp].re - D.dex[b.m.sp].re || a.m.ribbon - b.m.ribbon);
  if (!cands.length) notes.push('沒有任何 (物種, 緞帶) 組合能同時滿足畫面上的數字 —— 某個欄位讀錯了');
  else if (cands.length > 1) notes.push(`有 ${cands.length} 組解都符合 —— 下面選第一組，請自己確認`);
  return {cands, notes, level, nature, ss, bonus};
}

/** 對一個已經填好的 roster 成員重算兩個校驗碼，回傳與觀測值的比對結果。
 *  UI 在使用者手動改欄位之後即時呼叫這個 —— 改壞了要立刻看得出來。 */
function impVerify(m, obs){
  const camp = !!(obs && obs.camp);
  const iv = impInterval(m, camp), cr = impCarry(m, camp);
  const wantIv = obs && obs.intervalSec > 0 ? Math.round(obs.intervalSec) : null;
  const wantCr = obs && obs.carry > 0 ? Math.round(obs.carry) : null;
  return {
    interval: {got: iv, want: wantIv, ok: wantIv == null ? null : iv === wantIv},
    carry:    {got: cr, want: wantCr, ok: wantCr == null ? null : cr === wantCr},
  };
}
