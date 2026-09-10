#!/usr/bin/env node
/**
 * 煙霧測試 — 這裡每一項都對應一個真實發生過的 bug。加功能時請一起擴充。
 *
 *   npm i playwright-core && node tests/smoke.mjs
 *
 * Chromium 會自動尋找（見 tests/chromium.mjs）；要指定就設 CHROMIUM 環境變數。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './chromium.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = resolveChromium();   // 見 tests/chromium.mjs —— 不用再加 CHROMIUM= 前綴
const TOKEN = 'smoke-token';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ---- mock Apps Script endpoint ---- */
let store = null, lastTable = null;
// 設成 true 時下一個 POST 回錯誤 —— 用來驗「上傳失敗會重試」（見第 8 節）
let failNextPost = false;
const server = http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    return send(u.searchParams.get('token') !== TOKEN ? { error: 'unauthorized' } : { ok: true, data: store });
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j; try { j = JSON.parse(body); } catch { return send({ error: 'malformed json body' }); }
    if (j.token !== TOKEN) return send({ error: 'unauthorized' });
    if (failNextPost) { failNextPost = false; return send({ error: 'simulated upstream failure' }); }
    store = j.data; lastTable = j.table;
    send({ ok: true, updatedAt: new Date().toISOString() });
  });
});
await new Promise((r) => server.listen(0, r));
const GAS = `http://127.0.0.1:${server.address().port}/`;

/* ---- 靜態檔伺服器 ----
   資料改成 fetch('./data/game.json') 之後不能再用 file:// 載入（CORS 會擋），
   所以測試自己起一台。CI 因此不需要額外的 server step。 */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
// 設成數字時，game.json 的 meta.schema 會被改寫成該值 —— 用來模擬快取偏移（見第 12 節）
let tamperSchema = null;
const statics = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(urlPath).replace(/^([/\\])+/, '');
  const file = resolve(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    let buf = await readFile(file);
    // 注意用 urlPath 比對，不是 rel —— normalize() 在 Windows 上會把分隔符換成 \
    if (tamperSchema !== null && urlPath.endsWith('/data/game.json')) {
      const j = JSON.parse(buf.toString('utf8'));
      j.meta.schema = tamperSchema;
      buf = Buffer.from(JSON.stringify(j));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(buf);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => statics.listen(0, r));
const PAGE = `http://127.0.0.1:${statics.address().port}/index.html`;

const browser = await chromium.launch({ executablePath: EXEC });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
/* Playwright 預設會自動「取消」所有原生對話框，所以按了刪除的 confirm 會被拒。
   這裡集中處理，讓測試能明確控制要按確定還是取消，並留下訊息內容供斷言。 */
let dialogAccept = true, lastDialog = '';
page.on('dialog', async (d) => { lastDialog = d.message(); await (dialogAccept ? d.accept() : d.dismiss()); });

const seed = `
  const mk = (n, lv, nat, ss, ing, sk, rib) => ({
    sp: D.dex.findIndex(x => x.n === n), level: lv, nature: nat,
    ss: [...ss, ...Array(5 - ss.length).fill(null)], ingSet: ing, skillLv: sk,
    ribbon: rib || 0, pin: false, ex: false });
  roster = [
    mk('RAICHU', 45, 'Adamant', ['Helping Speed M', 'Berry Finding S'], [0,0,0], 3, 2),
    mk('VENUSAUR', 42, 'Modest', ['Ingredient Finder M', 'Inventory Up M'], [0,1,0], 3),
    mk('SLOWKING', 40, 'Careful', ['Helping Bonus', 'Skill Trigger M'], [0,0,0], 3),
    mk('DELIBIRD', 35, 'Mild', ['Ingredient Finder M', 'Helping Bonus'], [0,0,0], 3),
    mk('WIGGLYTUFF', 36, 'Sassy', ['Energy Recovery Bonus', 'Skill Trigger S'], [0,0,0], 4),
    mk('ABSOL', 34, 'Rash', ['Ingredient Finder M', 'Inventory Up M'], [0,1,0], 3),
    mk('GENGAR', 38, 'Quiet', ['Ingredient Finder S', 'Inventory Up L'], [0,1,0], 3),
    mk('TOXTRICITY_AMPED', 38, 'Quiet', ['Ingredient Finder S', 'Inventory Up M'], [0,1,0], 3),
  ];
  renderBox();
`;

console.log('\n[1] 載入與資料完整性');
await page.goto(PAGE);
await page.waitForTimeout(2500);
{
  // regression: `$` TDZ 會讓整支腳本在載入時死掉
  const alive = await page.evaluate(() => typeof $ === 'function' && typeof D === 'object' && typeof run === 'function');
  ok('頂層腳本執行完成（$ 的 TDZ 迴歸測試）', alive);
  const d = await page.evaluate(() => ({ dex: D.dex.length, rec: D.recipes.length, zhPk: Object.keys(D.zh.pk).length, zhRec: Object.keys(D.zh.recipes).length }));
  ok(`資料完整（${d.dex} 隻 / ${d.rec} 道）`, d.dex > 200 && d.rec > 50, JSON.stringify(d));
  ok('繁中對照表 100% 覆蓋', d.zhPk === d.dex && d.zhRec === d.rec, JSON.stringify(d));
  ok('三個 view 都存在', await page.evaluate(() => ['plan','box','recipes'].every(v => !!$('view-'+v))));
}

/* run() 是非同步的（推演跑在 Worker 裡），所以絕對不要用 waitForTimeout 等結果 ——
   在慢一點的 CI 機器上會 flaky。統一先清掉 lastResults 再等它被填回來。 */
const doRun = async (setup = '') => {
  await page.evaluate(`(async () => { ${setup}; lastResults = null; await run(); })()`);
  await page.waitForFunction(() => lastResults && lastResults.length, null, { timeout: 60000 });
};

console.log('\n[2] 引擎');
await page.evaluate(seed);
await doRun(`wk.recipeScope = 'all'; wk.recipePick = 'auto'; syncWeeklyUI()`);
{
  const r = await page.evaluate(() => {
    const x = lastResults[0];
    return { n: x.idxs.length, total: x.total, berry: x.berryS, dish: x.dishS,
      plan: x.mp ? x.mp.plan.length : 0, meals: x.mp ? x.mp.plan.reduce((s,p)=>s+p.n,0) + x.mp.idleMeals : 0,
      fast: x.outs.map(o => o.sim.fastShare) };
  });
  ok('推出 5 隻', r.n === 5);
  ok('週能量為正', r.total > 0, String(r.total));
  ok('樹果與料理都有貢獻', r.berry > 0 && r.dish > 0, `berry=${Math.round(r.berry)} dish=${Math.round(r.dish)}`);
  ok('21 餐排程加總正確', r.meals === 21, String(r.meals));
  ok('最快檔位比例在 0..1', r.fast.every(f => f >= 0 && f <= 1));
}

console.log('\n[2d] 收取區間：白天也要分段（遊戲不會自動收取）');
{
  /* 遊戲機制（使用者確認）：不是自動收取，要上線點才收；主技能最多累積 2 次。
     以前只有夜間套這兩個上限，白天完全不套 —— 而那個偏差**只打在技能觸發率高的
     身上**（哥達鴨 20.4% 是全 dex 第 2），會系統性地把牠們推進推薦名單。 */
  const r = await page.evaluate(() => {
    const mk = (n, nat, ss, sk) => ({sp:n, level:60, nature:nat||'Bashful',
      ss:[...(ss||[]), ...Array(5-(ss||[]).length).fill(null)],
      ingSet:[0,0,0], skillLv:sk||6, ribbon:0, pin:false, ex:false, nick:''});
    // 哥達鴨：技能率 12.5%（全 dex 第 2）+ 技能率M + 溫順 → 20.4%
    const hi = mk('GOLDUCK', 'Gentle', ['Skill Trigger M'], 6);
    // 達克萊伊：技能率 2.3%（很低）
    const lo = mk('DARKRAI', 'Bashful', ['Skill Trigger M'], 6);
    const base = {fav:new Set(), camp:false, sleepH:8.5, areaBonus:0, pot:57, recipeLv:20,
                  recipePick:'auto', recipeScope:'all', recipeLevels:{}, dishType:'curry'};
    const CTX = {nHB:0,nERB:0,supportEnergy:0,extraHelps:0,darkDrain:0,hbRows:null,
      hasPlus:false,hasMinus:false,hasLatias:false,hasLatios:false,nDragon:1};
    const procsAt = (m, ch) => {
      const wk = {...base, collectH: ch};
      const bs = baseStats(m, wk);
      return simulate(bs, m, wk, CTX).procs;
    };
    return {
      hiInf: procsAt(hi, 0), hi3: procsAt(hi, 3), hi6: procsAt(hi, 6),
      loInf: procsAt(lo, 0), lo3: procsAt(lo, 3),
      scoreWk: typeof SCORE_WK === 'object' ? SCORE_WK.collectH : null,
      def: typeof DEFAULT_COLLECT_H === 'number' ? DEFAULT_COLLECT_H : null,
      wkHas: wk.collectH,
    };
  });
  ok('沒設 collectH 時走「隨時收」的舊行為（不設上限）', r.hiInf > r.hi3,
     `∞=${r.hiInf.toFixed(2)} 3h=${r.hi3.toFixed(2)}`);
  ok('收得越不勤，主技能拿得越少', r.hi3 > r.hi6, `3h=${r.hi3.toFixed(2)} 6h=${r.hi6.toFixed(2)}`);
  // 這是這一節的重點：偏差只打在高觸發率的身上
  const hiLoss = 1 - r.hi3 / r.hiInf, loLoss = 1 - r.lo3 / r.loInf;
  ok('技能觸發率高的折損明顯大於低的', hiLoss > loLoss + 0.1,
     `哥達鴨 -${(hiLoss*100).toFixed(0)}% vs 達克萊伊 -${(loLoss*100).toFixed(0)}%`);
  /* 個體產能的基準一定要有 collectH，否則寶可夢箱裡技能率高的會像推演以前那樣被高估 */
  ok('SCORE_WK 有固定的 collectH', r.scoreWk === r.def && r.def > 0, `${r.scoreWk} / ${r.def}`);
  ok('wk 預設有 collectH', r.wkHas > 0, String(r.wkHas));

  // UI 欄位存在，而且改了會重算
  const ui = await page.evaluate(async () => {
    const before = wk.collectH;
    $('collectH').value = '6';
    $('collectH').dispatchEvent(new Event('change', {bubbles:true}));
    const after = wk.collectH;
    $('collectH').value = String(before);
    $('collectH').dispatchEvent(new Event('change', {bubbles:true}));
    return {before, after, restored: wk.collectH, shown: $('collectH').value};
  });
  ok('「白天多久收一次」欄位改動會進 wk', ui.after === 6 && ui.restored === ui.before,
     JSON.stringify(ui));
}

console.log('\n[2b] 料理分數：搜尋目標與決賽目標不能脫鉤');
{
  /* 這一節擋的是一個實際發生過的 bug：搜尋階段用 `proxyDish`（走訪食譜填餐次但
     **不扣除食材**，同一批食材被多道食譜重複計算）。它高估中位數 1.389 倍、最高
     2.85 倍，而且高估幅度隨隊伍的食材分布而變 —— 所以連排序都不保。後果是搜尋選出
     的隊伍真實分數比最佳低 9.2%，真實前 8 名全部擠不進決賽；而且 `finalizeTeams` 的
     `if (mp.total > b.dishS)` 因為上界永遠比較大而幾乎不成立，UI 的「料理」數字和
     21 餐排程表的小計差了 58%。詳見 DECISIONS.md。 */
  const r = await page.evaluate(() => {
    const x = lastResults[0];
    let tableSum = 0;
    for (const p of x.mp.plan) tableSum += p.n * p.each * x.mul;
    return {dishS: x.dishS, mpTotal: x.mp.total, tableSum, idle: x.mp.idleMeals,
            fillE: x.mp.fillE || 0, fillN: x.mp.fillN || 0, room: x.mp.room || 0};
  });
  // 使用者在同一個畫面上同時看得到這兩個數字，對不上就是文案說謊
  ok('「料理」＝ 21 餐排程表的小計', Math.abs(r.dishS - r.mpTotal) < 1,
     `dishS=${Math.round(r.dishS)} 排程=${Math.round(r.mpTotal)}`);
  /* 排程表 = 各道食譜的小計 ＋「鍋子空位填入其他食材」那一列。
     填充那一列漏掉的話，表格加起來就會少一截而使用者看不出少在哪。 */
  ok('排程表逐列加總（含填充列）對得起來', Math.abs(r.tableSum + r.fillE - r.mpTotal) < 1,
     `食譜 ${Math.round(r.tableSum)} + 填充 ${Math.round(r.fillE)} vs ${Math.round(r.mpTotal)}`);
  ok('填充量不超過鍋子空位總數', r.fillN <= r.room, `${r.fillN} / ${r.room}`);

  /* 搜尋階段的 dishS 必須是**下界**（≤ 真實排程），決賽才有得修正。
     這一條擋的是「為了省時間加一個樂觀近似」的回歸 —— 不管用什麼函式，
     只要它會高估，這裡就會紅。 */
  const bound = await page.evaluate(() => {
    const memo = new Map();
    const idx = roster.map((_, i) => i).filter(i => !roster[i].ex);
    const out = {over: 0, n: 0, worst: 1};
    // 抽 120 組（每組不同的 5 隻），比搜尋分數與真實排程
    for (let t = 0; t < 120; t++){
      const pick = [];
      for (let k = 0; k < 5; k++) pick.push(idx[(t * 7 + k * 13 + k) % idx.length]);
      if (new Set(pick).size !== 5) continue;
      pick.sort((a, b) => a - b);
      const s = scoreTeam(pick, roster, wk, memo);
      const real = bestPlan(s.wIng, s.potEff, s.mul, wk.recipePick === 'manual' ? wk.recipe : null, wk).total;
      out.n++;
      if (real > 0){
        const ratio = s.dishS / real;
        if (ratio > 1.0001) out.over++;
        out.worst = Math.max(out.worst, ratio);
      }
    }
    return out;
  });
  ok('搜尋階段的料理分數是下界，不是上界',
     bound.over === 0, `${bound.n} 組裡有 ${bound.over} 組高估，最大比值 ${bound.worst.toFixed(4)}`);

  // 指定食譜模式也不能脫鉤（決賽會用別的食譜填滿剩下的餐，搜尋階段以前沒算那一段）
  const man = await page.evaluate(async () => {
    const keep = {pick: wk.recipePick, name: wk.recipeName};
    wk.recipePick = 'manual';
    wk.recipeName = D.recipes.find(r => r.cnt <= wk.pot).n;
    wk.recipe = D.recipes.find(r => r.n === wk.recipeName);
    buildPool(wk);
    roster.forEach(m => { m._bs = baseStats(m, wk); });
    const memo = new Map();
    const idx = roster.map((_, i) => i).filter(i => !roster[i].ex).slice(0, 5);
    const s = scoreTeam(idx, roster, wk, memo);
    const real = bestPlan(s.wIng, s.potEff, s.mul, wk.recipe, wk).total;
    const ratio = real > 0 ? s.dishS / real : 1;
    Object.assign(wk, {recipePick: keep.pick, recipeName: keep.name});
    wk.recipe = D.recipes.find(r => r.n === wk.recipeName) || D.recipes[0];
    buildPool(wk);
    return {ratio, dishS: s.dishS, real};
  });
  ok('指定食譜模式也是下界', man.ratio <= 1.0001,
     `dishS=${Math.round(man.dishS)} real=${Math.round(man.real)} ratio=${man.ratio.toFixed(4)}`);
}

console.log('\n[2c] 結果卡：為什麼選這一隻 · 術語要看得懂');
{
  /* 使用者實際反應：「幫手 xx/日 是什麼意思」「偷吃是什麼」「最快檔位又是什麼」
     「最下面 HB ERB 這些是什麼」—— HB/ERB 是原始碼裡的變數名，不是使用者看得懂的字。 */
  const r = await page.evaluate(() => {
    renderResults();
    const cards = [...$('results').querySelectorAll('.mem')];
    return {
      whys: cards.map(c => { const w = c.querySelector('.why'); return w ? w.innerText.trim() : ''; }),
      pills: [...$('results').querySelectorAll('.pillrow .pill')].map(p => p.innerText.trim()),
      titles: [...$('results').querySelectorAll('[title]')].map(e => e.title).join('\n'),
      labels: [...$('results').querySelectorAll('.mem .out div')].map(e => e.innerText.trim()),
    };
  });
  ok('每一隻都有「為什麼選牠」', r.whys.length === 5 && r.whys.every(w => w.length > 4),
     JSON.stringify(r.whys.map(w => w.slice(0, 40))));
  // 理由要能對回卡片上看得到的數字，不能是無法查證的形容詞
  ok('理由帶「佔這隊某分項的幾成」', r.whys.some(w => /佔這隊.{1,3}的 \d+%/.test(w)), r.whys[0]);
  ok('隊伍加成不再用 HB / ERB 縮寫',
     !r.pills.some(p => /^HB\b|^ERB\b/.test(p)), JSON.stringify(r.pills));
  ok('隊伍加成寫成中文', r.pills.some(p => /幫忙加成/.test(p)) && r.pills.some(p => /活力回復提升/.test(p)),
     JSON.stringify(r.pills));
  ok('「幫忙」有解釋', /每天實際完成的幫忙次數/.test(r.titles));
  /* `energyGiven` / `helpsGiven` 內部是「整隊合計」（每人的量 ×5），但**畫面一律顯示
     每隻**（使用者要的指標），這樣才和下方 pill 的 supportEnergy / extraHelps 同單位。
     兩處單位不同又不標，就會被讀成同一件事（實際被問過：「這是一整隊 5 隻總共，還是單隻？」）。 */
  const units = await page.evaluate(() => ({
    why: [...$('results').querySelectorAll('.why')].map(e => e.innerText).join('\n'),
    pills: [...$('results').querySelectorAll('.pillrow .pill')].map(e => e.innerText).join('\n'),
  }));
  ok('補活力／額外幫忙：成員卡顯示「每隻」',
     !/每日補活力|每日多幫忙/.test(units.why) || /每隻/.test(units.why), units.why.slice(0, 140));
  ok('補活力／額外幫忙：pill 也標「每隻」',
     !/技能補活力|額外幫忙/.test(units.pills) || /每隻/.test(units.pills), units.pills);
  /* 「最快檔位」這個標籤字面上看不出它在講活力（使用者看了 tooltip 還是不懂），
     所以標籤本身改成「活力80以上」，tooltip 補完整的檔位表與「該怎麼辦」。 */
  ok('活力那一欄的標籤要看得出在講活力',
     r.labels.some(t => /活力\s*80/.test(t)), JSON.stringify(r.labels.slice(0, 3)));
  ok('活力檔位有完整解釋（五檔 ＋ 該怎麼辦）',
     /活力 80 以上/.test(r.titles) && /×0\.45/.test(r.titles) && /×1\.00/.test(r.titles)
     && /補師/.test(r.titles), r.titles.slice(0, 100));
  ok('「背包滿」有解釋', /持有上限/.test(r.titles) || !/背包滿/.test(r.titles), r.titles.slice(0, 80));
}

console.log('\n[3] 單調性 — 調高食譜等級絕不能讓總分變低');
{
  await doRun('wk.recipeLevels = {}');
  const base = await page.evaluate(() => lastResults[0].total);
  let worst = 0, bad = 0;
  const names = await page.evaluate(() => D.recipes.map(r => r.n));
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 6; t++) {
    const lv = {};
    for (let j = 0; j < 6; j++) lv[names[Math.floor(rnd() * names.length)]] = 30 + Math.floor(rnd() * 40);
    await doRun(`wk.recipeLevels = ${JSON.stringify(lv)}`);
    const got = await page.evaluate(() => lastResults[0].total);
    if (got < base - 1) { bad++; worst = Math.max(worst, base - got); }
  }
  ok(`6 組隨機等級都不下降（基準 ${Math.round(base)}）`, bad === 0, bad ? `${bad} 組下降，最多 -${Math.round(worst)}` : '');
  await page.evaluate(() => { wk.recipeLevels = {}; });
}

console.log('\n[4] 窮舉不變量 — 結果只能取決於箱子內容，不能取決於順序');
{
  /* regression: 曾經有個預篩（>120 萬組合就按「單隻分數」砍到前 42 隻），而那個
     分數是 scoreTeam([i] + pool.slice(0,4)) —— companions 按 roster 順序取。
     實測 60 隻箱子只改順序就差 −16.34%、前 8 名零重疊。整段已移除。
     這一節同時守住兩件事：(a) 不再有任何裁切 (b) 洗牌不改變答案。 */
  const r = await page.evaluate(() => {
    const picks = D.dex.filter(x => x.ms && x.b).filter((_, i) => i % 9 === 0).slice(0, 22);
    const base = picks.map((x, i) => ({
      sp: D.dex.indexOf(x), level: 30 + (i % 25), nature: ['Adamant','Modest','Careful','Mild','Sassy'][i % 5],
      ss: ['Helping Bonus', null, null, null, null], ingSet: [0,0,0], skillLv: 3 + (i % 4),
      ribbon: 0, pin: false, ex: false,
    }));
    const FAV = ['ORAN','PAMTRE','PECHA'];
    const mkWk = (strictBerry) => ({ island:'greengrass', fav:new Set(FAV), areaBonus:15,
      pot:57, sleepH:8.5, camp:0, mode:'total', dishType:'curry', recipeName:null, recipeLv:20,
      recipePick:'auto', recipeScope:'all', recipeLevels:{}, strictBerry });
    const shuffle = (arr, seed) => {
      const a = arr.slice(); let s = seed;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    };
    // 用物種名稱的集合當 key —— 索引會隨順序改變，不能直接比
    const go = (roster, strictBerry) => {
      const res = searchTeams(roster.map(m => ({ ...m })), mkWk(strictBerry), {});
      return { count: res.count, trimmed: 'trimmed' in res, excluded: res.excluded || [],
        top: res.best.map(x => x.idxs.map(i => D.dex[roster[i].sp].n).sort().join('+')),
        // 入選成員裡有沒有「樹果型但樹果不符」的
        violators: [...new Set(res.best.flatMap(x => x.idxs
          .map(i => D.dex[roster[i].sp])
          .filter(dx => dx.sp === 'berry' && !FAV.includes(dx.b))
          .map(dx => dx.n)))],
        total: Math.round(res.best[0].total * 100) / 100 };
    };
    const nCk = (n, k) => { let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };
    const berryOff = base.filter(m => { const dx = D.dex[m.sp]; return dx.sp === 'berry' && !FAV.includes(dx.b); }).length;
    return {
      n: base.length, berryOff,
      expectFull: Math.round(nCk(base.length, 5)),
      expectStrict: Math.round(nCk(base.length - berryOff, 5)),
      // strictBerry: false → 純窮舉，用來守住順序不變性
      runs: [false, false, false, false].map((_, k) =>
        go(k === 0 ? base : shuffle(base, [0, 7, 4242, 31337][k]), false)),
      // strictBerry: true → 產品規則，同樣要與順序無關
      strict: [0, 7, 4242].map((s, k) => go(k === 0 ? base : shuffle(base, s), true)),
    };
  });

  ok(`關掉篩選時窮舉全部 C(${r.n},5)=${r.expectFull.toLocaleString()} 組（沒有任何裁切）`,
     r.runs.every(x => x.count === r.expectFull), r.runs.map(x => x.count).join(' / '));
  ok('回傳值不再有 trimmed 欄位', r.runs.every(x => !x.trimmed));

  const ref = r.runs[0];
  const sameTop = r.runs.every(x => x.top.join('|') === ref.top.join('|'));
  const sameTotal = r.runs.every(x => x.total === ref.total);
  ok('洗牌 3 次，前 8 名完全相同', sameTop,
     sameTop ? '' : r.runs.map(x => x.top[0]).join('  vs  '));
  ok(`洗牌 3 次，第 1 名 total 相同（${ref.total}）`, sameTotal, r.runs.map(x => x.total).join(' / '));

  /* ---- 產品規則：樹果型必須產本週加成樹果 ---- */
  const s0 = r.strict[0];
  ok(`篩選只排除樹果型（${r.berryOff} 隻），組合數 = C(${r.n}-${r.berryOff},5) = ${r.expectStrict.toLocaleString()}`,
     r.strict.every(x => x.count === r.expectStrict), r.strict.map(x => x.count).join(' / '));
  ok(`回報了被排除的名單（${s0.excluded.length} 隻）`, s0.excluded.length === r.berryOff,
     `excluded=${s0.excluded.length} 期望=${r.berryOff}`);
  ok('開篩選後，入選成員裡沒有「樹果型但樹果不符」的',
     r.strict.every(x => x.violators.length === 0), s0.violators.join('、'));
  ok('關篩選時本來會有違規者入選（證明這個檢查有意義）',
     r.runs.some(x => x.violators.length > 0), `關篩選時的違規者：${ref.violators.join('、') || '無'}`);
  ok('篩選開啟時同樣與順序無關',
     r.strict.every(x => x.top.join('|') === s0.top.join('|')),
     r.strict.map(x => x.top[0]).join('  vs  '));
}

console.log('\n[5] 幫手加速依同樹果種類數放大');
{
  const r = await page.evaluate(() => {
    const hb = D.dex.find(x => /^Helper Boost/.test(x.ms || ''));
    if (!hb) return null;
    const mk = (n) => ({ sp: D.dex.findIndex(x => x.n === n), level: 50, nature: 'Bashful',
      ss: [null,null,null,null,null], ingSet: [0,0,0], skillLv: 6, ribbon: 0, pin: false, ex: false });
    const same = D.dex.filter(x => x.b === hb.b && x.n !== hb.n).slice(0, 4).map(x => x.n);
    const diff = D.dex.filter(x => x.b !== hb.b).slice(0, 4).map(x => x.n);
    wk.recipe = D.recipes[0]; wk.recipeScope = 'all'; buildPool(wk);
    const go = (names) => { roster = names.map(mk); roster.forEach(m => (m._bs = baseStats(m, wk)));
      return scoreTeam([0,1,2,3,4], roster, wk, new Map()); };
    const mono = go([hb.n, ...same]), mixed = go([hb.n, ...diff]);
    const row = c => (c.hbRows && c.hbRows[hb.b]) || 1;

    /* regression（2026-09-08）：一隊有**兩個以上** Helper Boost 持有者時，以前
       `idxs.find(...)` 只取第一個，整隊共用那一個列 —— 而三神獸的樹果各不相同
       （雷公 GREPA／炎帝 LEPPA／水君 ORAN）。`find` 取的是 roster 索引最小的那隻，
       所以**同一支隊伍只要換 roster 順序，答案就會變**（實測 helpsGiven 差 2.3 倍）。
       這違反第 4 節的順序不變量，但第 4 節抽樣抽不到兩隻神獸（整個 dex 只有 3 隻，
       而且圖鑑號連號），所以一直沒被抓到。 */
    const hbs = D.dex.filter(x => /^Helper Boost/.test(x.ms || ''));
    let two = null;
    if (hbs.length >= 2){
      const [a, b2] = hbs;                        // 樹果不同的兩隻
      const fill = D.dex.filter(x => x.b === a.b && x.n !== a.n).slice(0, 3).map(x => x.n);
      const outs = names => { const r2 = go(names).ctx;
        return names.map((n, i) => /^Helper Boost/.test(D.dex.find(x=>x.n===n).ms)
          ? Math.round(memberOutput(roster[i], wk, r2).helpsGiven * 100) / 100 : null);
      };
      const fwd = outs([a.n, b2.n, ...fill]), rev = outs([b2.n, a.n, ...fill]);
      two = {fwd, rev, berries: [a.b, b2.b],
             // 換順序 → 每一隻拿到的東西必須一樣（比對時把順序對回去）
             sameSet: JSON.stringify(fwd.filter(v=>v!=null).sort()) ===
                      JSON.stringify(rev.filter(v=>v!=null).sort())};
    }
    return { monoU: row(mono.ctx), mixedU: row(mixed.ctx),
             monoHelps: mono.ctx.extraHelps, mixedHelps: mixed.ctx.extraHelps, two };
  });
  ok('同樹果隊的 unique 計數較高', r && r.monoU > r.mixedU, JSON.stringify(r).slice(0, 120));
  ok('同樹果隊拿到更多額外幫手', r && r.monoHelps > r.mixedHelps, JSON.stringify(r).slice(0, 120));
  /* 每個持有者要吃**自己那個樹果**的列，所以 ctx.hbRows 是 map 不是純量。 */
  ok('兩隻 Helper Boost 同隊時，換 roster 順序不改變任何一隻的產出',
     !r.two || r.two.sameSet, JSON.stringify(r.two));
}

/* 正電／負電**互為條件**：兩邊都要隊上有另一半才給加成。
   以前正電那一側是「無條件加一半」—— 單獨帶會被高估、正負配對會被低估，
   於是搜尋會系統性地錯過那個配對（實測配對後食材 137.8 vs 單獨 91.5，1.51 倍）。
   算錯的方向不會讓任何校驗碼破掉，所以沒有測試就沒人擋得住。 */
console.log('\n[5b] 正電／負電：互為條件的搭配加成');
{
  const r = await page.evaluate(() => {
    const plus  = D.dex.find(x => /^Plus \(/.test(x.ms || ''));
    const minus = D.dex.find(x => /^Minus \(/.test(x.ms || ''));
    if (!plus || !minus) return null;
    const mk = n => ({sp: D.dex.findIndex(x => x.n === n), level:60, nature:'Bashful',
      ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:6, ribbon:0, pin:false, ex:false});
    const other = D.dex.filter(x => !/^(Plus|Minus) \(/.test(x.ms || '')).slice(0, 4).map(x => x.n);
    wk.recipe = D.recipes[0]; wk.recipeScope = 'all'; buildPool(wk);
    const go = names => { roster = names.map(mk); roster.forEach(m => (m._bs = baseStats(m, wk)));
      const ctx = teamContext([0,1,2,3,4], roster, wk, new Map());
      return {ctx, out: i => memberOutput(roster[i], wk, ctx)}; };
    const ingSum = o => o.ing.reduce((a, b) => a + b, 0);
    const paired = go([plus.n, minus.n, ...other.slice(0, 3)]);
    const soloP  = go([plus.n,  ...other]);
    const soloM  = go([minus.n, ...other]);
    return {
      plusPaired: ingSum(paired.out(0)), plusSolo: ingSum(soloP.out(0)),
      minusPaired: paired.out(1).energyGiven, minusSolo: soloM.out(0).energyGiven,
      // 新的 team-level 效果一定要進 ctxKey，否則會拿到別種組成算出來的結果
      keyDiff: ctxKey(paired.ctx) !== ctxKey(soloP.ctx),
    };
  });
  ok('正電：隊上有負電時食材更多（以前是無條件加一半）',
     r && r.plusPaired > r.plusSolo * 1.05,
     r && ('配對 ' + r.plusPaired.toFixed(2) + ' vs 單獨 ' + r.plusSolo.toFixed(2)));
  ok('負電：沒有正電就完全不給能量',
     r && r.minusSolo === 0 && r.minusPaired > 0,
     r && ('配對 ' + r.minusPaired.toFixed(2) + ' vs 單獨 ' + r.minusSolo.toFixed(2)));
  /* CLAUDE.md 陷阱 6：加新的 team-level 效果沒進 ctxKey，記憶化就會串味。 */
  ok('hasMinus 有進 ctxKey（否則記憶化會拿到別隊的結果）', r && r.keyDiff, String(r && r.keyDiff));
}

/* 拉帝亞斯／拉帝歐斯：第三組**互為條件**的搭配。
   資料裡的欄位名稱本身就說明了 —— `latiasBerries`（拉帝歐斯的）與 `latiosHelps`（拉帝亞斯的）。
   以前 `latiasBerries` 被無條件當成 selfBerry，等於拉帝歐斯單獨上場也照領那 29.5%。 */
console.log('\n[5c] 拉帝亞斯／拉帝歐斯：條件式的搭配樹果');
{
  const r = await page.evaluate(() => {
    const has = n => D.dex.some(x => x.n === n);
    if (!has('LATIAS') || !has('LATIOS')) return null;
    const mk = n => ({sp: D.dex.findIndex(x => x.n === n), level:60, nature:'Bashful',
      ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:6, ribbon:0, pin:false, ex:false});
    wk.recipe = D.recipes[0]; wk.recipeScope = 'all'; buildPool(wk);
    const berryOf = names => { roster = names.map(mk);
      roster.forEach(m => (m._bs = baseStats(m, wk)));
      const c = teamContext([0,1,2,3,4], roster, wk, new Map());
      return {b: memberOutput(roster[0], wk, c).berryStrength, c};
    };
    const fill = D.dex.filter(x => !/^LATI/.test(x.n)).slice(0, 3).map(x => x.n);
    const paired = berryOf(['LATIOS', 'LATIAS', ...fill]);
    const solo   = berryOf(['LATIOS', D.dex.find(x => x.n === 'RAICHU') ? 'RAICHU' : fill[0], ...fill.slice(0, 2), fill[2]].slice(0, 5));
    return {pairedB: paired.b, soloB: solo.b,
            keyDiff: ctxKey(paired.c) !== ctxKey(solo.c),
            // latiasBerries 不該再直接變成無條件的 selfBerry
            latiasPaired: (() => { roster = ['LATIAS','LATIOS',...fill].map(mk);
              roster.forEach(m => (m._bs = baseStats(m, wk)));
              const c = teamContext([0,1,2,3,4], roster, wk, new Map());
              return memberOutput(roster[0], wk, c).helpsGiven; })(),
            latiasSolo: (() => { roster = ['LATIAS', ...fill, fill[0]].map(mk);
              roster.forEach(m => (m._bs = baseStats(m, wk)));
              const c = teamContext([0,1,2,3,4], roster, wk, new Map());
              return memberOutput(roster[0], wk, c).helpsGiven; })(),
            additive: (() => { const h = D.ms['Heal Pulse (Energizing Cheer S)'];
              return h.helps.every((v, i) => v + h.latiosHelps[i] === [2,3,4,5,6,7][i]); })(),
            sums: (() => { const h = D.ms['Heal Pulse (Energizing Cheer S)'];
              return h.helps.map((v, i) => v + h.latiosHelps[i]).join(','); })(),
            tableOk: (() => { const x = D.msExtra['Draco Meteor (Berry Burst)'];
              if (!x) return false;
              const want = [[12,14,18,18,20],[21,24,29,30,33],[29,29,35,37,41],
                            [38,39,42,45,49],[43,44,48,49,53],[48,50,55,55,58]];
              const wantT = [[1,1,1,2,2],[1,1,1,2,2],[1,2,2,3,3],
                             [1,2,3,4,4],[2,3,4,5,5],[3,4,4,5,5]];
              return JSON.stringify(x.selfBerryByDragon) === JSON.stringify(want)
                  && JSON.stringify(x.teamBerryByDragon) === JSON.stringify(wantT); })(),
            tableRows: (() => { const x = D.msExtra['Draco Meteor (Berry Burst)'];
              return x ? x.selfBerryByDragon.map(r2 => r2.join('/')).join('  ') : '(缺)'; })(),
            dragon1: (() => { roster = ['LATIOS', ...fill, fill[0]].map(mk);
              roster.forEach(m => (m._bs = baseStats(m, wk)));
              return teamContext([0,1,2,3,4], roster, wk, new Map()).nDragon; })(),
            dragon5: (() => { const dr = D.dex.filter(x => x.n !== 'LATIOS'
                && ['DRAGONITE','SALAMENCE','FLYGON','ALTARIA'].includes(x.n)).map(x => x.n);
              roster = ['LATIOS', ...dr].map(mk);
              roster.forEach(m => (m._bs = baseStats(m, wk)));
              return teamContext([0,1,2,3,4], roster, wk, new Map()).nDragon; })(),
            self1: D.msExtra['Draco Meteor (Berry Burst)'].selfBerryByDragon[5][0],
            self5: D.msExtra['Draco Meteor (Berry Burst)'].selfBerryByDragon[5][4],
            rawHasSelf: 'selfBerry' in skillPayload('Draco Meteor (Berry Burst)', 6)};
  });
  ok('拉帝歐斯：隊上有拉帝亞斯時樹果更多（以前無條件照領）',
     r && r.pairedB > r.soloB * 1.05,
     r && `配對 ${r.pairedB.toFixed(1)} vs 單獨 ${r.soloB.toFixed(1)}`);
  ok('latiasBerries 不再無條件當成 selfBerry', r && r.rawHasSelf === false, String(r && r.rawHasSelf));
  ok('hasLatias 有進 ctxKey', r && r.keyDiff, String(r && r.keyDiff));

  /* 拉帝亞斯的「額外幫忙」以前**完全沒讀**（helpsGiven 是 0）。
     `latiosHelps` 是加碼不是取代 —— 遊戲技能頁寫「基礎 + 額外 = 總計」，
     而 helps+latiosHelps 逐級等於那個總計欄（1+1=2 … 4+3=7）。 */
  ok('拉帝亞斯的額外幫忙有算，而且隊上有拉帝歐斯時加碼',
     r && r.latiasPaired > r.latiasSolo * 1.2 && r.latiasSolo > 0,
     r && `配對 ${r.latiasPaired.toFixed(2)} vs 單獨 ${r.latiasSolo.toFixed(2)}`);
  ok('latiosHelps 是加碼不是取代（helps+latiosHelps 等於技能頁的總計欄）',
     r && r.additive, r && r.sums);

  /* 流星群的基礎表（repo 維護在 tools/skills-extra.json，上游快照沒有）。
     逐格對照遊戲技能頁的截圖 —— 這是目前少數有**絕對數值**的斷言之一。 */
  ok('流星群的基礎樹果表和遊戲技能頁逐格相符（6 級 × 5 種）',
     r && r.tableOk, r && r.tableRows);
  ok('隊上龍屬性種類數會改變牠的樹果（含牠自己，1~5）',
     r && r.dragon1 === 1 && r.dragon5 === 5 && r.self5 > r.self1,
     r && `nDragon ${r.dragon1}→${r.dragon5}　自身樹果 ${r.self1}→${r.self5}`);
}

/* 達克萊伊「夢魘（能量填充M）」：每次發動讓幫手隊伍中**惡屬性以外**的成員活力 −12
   （固定值，不隨技能等級變 —— 加成那一欄才隨等級）。惡屬性成員與牠自己免疫。

   兩件事要守住：
   ① 扣活力真的有算，而且**全隊惡屬性時完全不扣**（這正是這隻的用法）。
   ② 「誰是惡屬性」不在上游資料裡 —— 那份清單是 repo 維護的 `tools/dark.txt`，
      清單錯了**不會有任何錯誤訊息**，只會讓分數靜靜地偏掉。所以要斷言它還在、
      而且每個名字都對得上 dex。 */
console.log('\n[6b] 夢魘：惡屬性以外的隊友會被扣活力');
{
  const r = await page.evaluate(() => {
    const DK = 'Bad Dreams (Charge Strength M)';
    const dk = D.dex.find(x => x.ms === DK);
    const mk = n => ({sp: D.dex.findIndex(x => x.n === n), level:60, nature:'Bashful',
      ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:7, ribbon:0, pin:false, ex:false});
    wk.recipe = D.recipes[0]; wk.recipeScope = 'all'; buildPool(wk);
    /* 同一支隊伍，只把扣活力關掉 —— 那就是改動之前的行為。 */
    const score = (names, withDrain) => {
      roster = names.map(mk); roster.forEach(m => (m._bs = baseStats(m, wk)));
      const c0 = teamContext([0,1,2,3,4], roster, wk, new Map());
      const c = withDrain ? c0 : {...c0, darkDrain: 0};
      let t = 0;
      for (let i = 0; i < 5; i++){ const o = memberOutput(roster[i], wk, c);
        t += o.berryStrength + o.skillStrength; }
      return {t, drain: c0.darkDrain};
    };
    const darkMates = [...DARK].filter(n => n !== 'DARKRAI').slice(0, 4);
    const plainMates = D.dex.filter(x => !DARK.has(x.n)).slice(0, 4).map(x => x.n);
    const mixed  = score(['DARKRAI', ...plainMates], true);
    const mixedOff = score(['DARKRAI', ...plainMates], false);
    const allDark = score(['DARKRAI', ...darkMates], true);
    const allDarkOff = score(['DARKRAI', ...darkMates], false);
    const noDk  = score(plainMates.concat(plainMates[0] === 'BULBASAUR' ? ['IVYSAUR'] : ['BULBASAUR']), true);
    const noDkOff = score(plainMates.concat(plainMates[0] === 'BULBASAUR' ? ['IVYSAUR'] : ['BULBASAUR']), false);
    // 惡屬性的免疫是逐一判斷的，不是整隊開關
    roster = ['DARKRAI', ...plainMates].map(mk);
    roster.forEach(m => (m._bs = baseStats(m, wk)));
    const c = teamContext([0,1,2,3,4], roster, wk, new Map());
    const wake = [0,1,2,3,4].map(i => ({dark: roster[i]._bs.dark,
      e: Math.round(memberOutput(roster[i], wk, c).sim.wakeEnergy)}));
    return {
      dk: !!dk, darkList: [...DARK], schema: D.meta.schema,
      allInDex: [...DARK].every(n => D.dex.some(x => x.n === n)),
      dragonInDex: [...DRAGON].every(n => D.dex.some(x => x.n === n)),
      nDragon: [...DRAGON].length,
      drain: mixed.drain,
      mixedDrop: mixed.t / mixedOff.t - 1,
      allDarkDrop: allDark.t / allDarkOff.t - 1,
      noDkSame: noDk.t === noDkOff.t,
      selfExempt: wake[0].dark && wake.slice(1).every(w => !w.dark && w.e < wake[0].e),
    };
  });
  ok('惡屬性清單在資料裡，而且每個名字都對得上 dex',
     r.darkList.length > 0 && r.allInDex, `${r.darkList.length} 隻 / allInDex=${r.allInDex}`);
  ok('屬性資料進了 types{} 且 schema 有跟著 +1（否則舊資料配新程式會靜靜少算）',
     r.schema >= 3, String(r.schema));
  /* 流星群吃「隊上不同種類的龍屬性」，所以龍屬性清單也要對得上 dex。 */
  ok('龍屬性清單也在資料裡，而且對得上 dex',
     r.nDragon > 0 && r.dragonInDex, String(r.nDragon) + ' 隻'),
  ok('隊上有達克萊伊時 darkDrain 是負的', r.drain < 0, String(r.drain));
  /* 這就是「全隊都是惡屬性才不虧」那句話的驗證。 */
  ok('隊友非惡屬性 → 週能量被扣（以前完全沒算）',
     r.mixedDrop < -0.02, (r.mixedDrop * 100).toFixed(1) + '%');
  ok('全隊惡屬性 → 完全不扣', Math.abs(r.allDarkDrop) < 1e-9,
     (r.allDarkDrop * 100).toFixed(4) + '%');
  ok('沒有達克萊伊的隊伍完全不受影響', r.noDkSame, String(r.noDkSame));
  ok('免疫是逐一判斷的：牠自己起床活力最高，非惡屬性隊友都被扣低',
     r.selfExempt, String(r.selfExempt));
}
console.log('\n[6] 揮指類技能不再算 0');
{
  const r = await page.evaluate(() => {
    const w = skillPayload('Metronome', 3);
    return { keys: Object.keys(w).length, strength: w.strength || 0 };
  });
  ok('揮指有非零產出', r.keys > 1 && r.strength > 0, JSON.stringify(r));
}

console.log('\n[7] 自架版本偵測與文案');
{
  const r = await page.evaluate(() => ({
    selfHosted: !window.claude,
    syncVisible: !$('syncSection').hidden,
    btnDisabled: $('refreshBtn').disabled,
    build: $('verBuild').textContent,
    note: $('refreshNote').textContent,
  }));
  ok('偵測為自架版本', r.selfHosted);
  ok('同步面板顯示', r.syncVisible);
  ok('「請求更新資料」已停用', r.btnDisabled);
  ok('版本面板標明自架', /自架/.test(r.build), r.build);
  ok('說明沒有謊稱 Claude 會收單', !/每週一.*收單/.test(r.note));
}

console.log('\n[8] Google Sheet 同步往返');
{
  await page.evaluate(seed);
  await page.evaluate(([gas, tok]) => {
    wk.recipeLevels = { MILD_HONEY_CURRY: 42 };
    showView('box');
    $('syncUrl').value = gas; $('syncToken').value = tok;
  }, [GAS, TOKEN]);
  await page.click('#syncPush');
  await page.waitForTimeout(1200);
  ok('上傳成功', /已上傳/.test(await page.evaluate(() => $('syncStatus').textContent)));
  ok('後端收到可讀表格', Array.isArray(lastTable) && lastTable.length === 9 && lastTable[0].includes('種類'),
     lastTable ? `rows=${lastTable.length}` : 'none');

  // 清掉本機資料後重新載入 —— 必須從「Sheet」抓回來
  await page.evaluate(() => localStorage.removeItem('psleep-box'));
  await page.reload();
  await page.waitForTimeout(3000);
  const back = await page.evaluate(() => ({ n: roster.length, rib: roster[0] && roster[0].ribbon,
    lv: wk.recipeLevels && wk.recipeLevels.MILD_HONEY_CURRY, status: $('saveStatus').textContent }));
  ok('清空本機後從雲端還原', back.n === 8, JSON.stringify(back));
  ok('緞帶與個別食譜等級都保住', back.rib === 2 && back.lv === 42, JSON.stringify(back));

  /* 「資料存在哪裡」的文案。使用者以為食譜等級是本機的、換裝置要重填 78 道 ——
     因為三處文案都只寫「寶可夢箱」，而食譜等級那一頁根本沒講。實際踩過。
     這裡要守住兩件事：講出食譜等級也會同步，而且**連上了才敢說存在雲端**。 */
  const note = await page.evaluate(() => ({
    rlv: $('rlvWhere').textContent, what: $('syncWhat').textContent,
    build: $('verBuild').textContent, backend,
  }));
  ok('食譜等級那一頁會講資料存在哪裡',
     /食譜等級/.test(note.rlv) && /Google Sheet/.test(note.rlv), `「${note.rlv}」`);
  ok('同步面板列出「食譜等級」也會一起同步', /食譜等級/.test(note.what), `「${note.what}」`);
  ok('版本面板寫出實際生效的後端',
     note.backend === 'sheet' && /Google Sheet/.test(note.build), `${note.backend} / 「${note.build}」`);
  /* regression：改完立刻關分頁／切到背景。以前那次上傳還在等 900ms 防抖，
     就永遠不會送出 —— localStorage 有、雲端停在上一版。 */
  store = null;
  await page.evaluate(() => {
    roster[0].level = 47;
    save();                                                  // 進入 900ms 防抖
    document.dispatchEvent(new Event('visibilitychange'));    // 立刻沖出去
  });
  await page.waitForTimeout(450);                             // 遠小於 900ms
  ok('切到背景會把還在防抖的上傳立刻沖出去',
     !!(store && store.roster && store.roster[0].level === 47),
     store ? 'level=' + (store.roster && store.roster[0] && store.roster[0].level) : 'store 還是空的');

  /* regression：上傳失敗以前會停在那不動，除非使用者又改了什麼。 */
  failNextPost = true;
  store = null;
  await page.evaluate(() => { roster[0].level = 48; save(); });
  await page.waitForTimeout(1400);                            // 等防抖觸發並失敗
  const failed = await page.evaluate(() => $('saveStatus').textContent);
  ok('上傳失敗有明確狀態', /失敗/.test(failed), failed);
  ok('失敗時雲端沒有被寫入', store === null, JSON.stringify(store && store.roster && store.roster[0]));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));  // 回到分頁
  await page.waitForTimeout(600);
  ok('回到分頁會重試失敗的那次上傳',
     !!(store && store.roster && store.roster[0].level === 48),
     store ? 'level=' + (store.roster && store.roster[0] && store.roster[0].level) : 'store 還是空的');

  await page.evaluate(() => { showView('box'); $('syncToken').value = 'wrong'; });
  await page.click('#syncPull');
  await page.waitForTimeout(900);
  ok('錯誤金鑰有明確錯誤', /unauthorized/.test(await page.evaluate(() => $('syncStatus').textContent)));

  /* 這一段放最後 —— 它會把同步設定清掉，前面那些防抖／重試的斷言都需要它還在。
     連不上時不能還宣稱資料在雲端：那句話正是使用者用來決定「要不要設同步」的依據。 */
  const offline = await page.evaluate(() => {
    $('syncOff').click();
    return {rlv: $('rlvWhere').textContent, build: $('verBuild').textContent, backend};
  });
  ok('停用同步之後文案改成「只存在這台瀏覽器」',
     offline.backend === 'local' && /只存在這台瀏覽器/.test(offline.rlv) &&
     /只有這台瀏覽器/.test(offline.build), JSON.stringify(offline));
}

console.log('\n[8b] 一次性設定連結（#sync=…&token=…）');
{
  /* 換裝置原本要手動貼 Apps Script 的 .../exec 網址 ＋ 金鑰。「複製同步連結」
     把兩者包成一條網址，開了就等於填好。

     每次都帶一個不相干的 ?t=N —— 只改 hash 的 goto 不會真的重新載入（同一份
     文件的片段跳轉），boot() 就不會再跑，整節會假通過。順便驗 stripSyncLink
     只清自己的鍵、不相干的 query 要留著。 */
  const openWith = async (n, frag) => {
    await page.goto(`${PAGE}?t=${n}${frag}`);
    await page.waitForTimeout(3000);
  };
  const state = () => page.evaluate(() => ({
    url: sync.url, token: sync.token, on: sync.on, backend, n: roster.length,
    hash: location.hash, search: location.search,
    stored: [localStorage.getItem('psleep-sync-url') || '', localStorage.getItem('psleep-sync-token') || ''],
    field: [$('syncUrl').value, $('syncToken').value],
    noteHidden: $('syncLinkNote').hidden,
    note: $('syncLinkNote').textContent,
    warn: $('syncLinkNote').classList.contains('warn'),
  }));

  // (a) 本機還沒設定 → 直接套用。這是換裝置的實際情境，沒有東西會被蓋掉。
  await openWith(1, '#sync=' + encodeURIComponent(GAS) + '&token=' + encodeURIComponent(TOKEN));
  let s = await state();
  ok('連結帶入的設定被套用', s.on && s.url === GAS && s.token === TOKEN, JSON.stringify(s.stored));
  ok('設定寫進 localStorage（下次不用連結）', s.stored[0] === GAS && s.stored[1] === TOKEN);
  ok('開連結就直接連上 Sheet 並下載', s.backend === 'sheet' && s.n === 8, `${s.backend} / ${s.n} 隻`);
  ok('有告知是從連結帶入的', !s.noteHidden && /連結/.test(s.note) && !s.warn, `「${s.note}」`);
  /* 金鑰不該留在網址列 —— 會被截圖、被複製、留在瀏覽器歷史裡。 */
  ok('金鑰不留在網址列', s.hash === '' && !/token/.test(s.search), `search=「${s.search}」hash=「${s.hash}」`);
  ok('不相干的 query 參數留著', /(^|[?&])t=1(&|$)/.test(s.search), `「${s.search}」`);

  /* (b) 已經有設定，而連結指向**別的地方** → 不自動套用。一條連結能改掉資料的
     目的地，套用之後本機的改動就往別人的 Sheet 上傳、自己那份停在舊版。 */
  await openWith(2, '#sync=' + encodeURIComponent('https://evil.example/exec') + '&token=zzz');
  s = await state();
  ok('和現有不同的連結不會自動套用', s.url === GAS && s.token === TOKEN, JSON.stringify([s.url, s.token]));
  ok('localStorage 沒有被改掉', s.stored[0] === GAS && s.stored[1] === TOKEN);
  ok('但有填進欄位等使用者確認', s.field[0] === 'https://evil.example/exec' && s.field[1] === 'zzz',
     JSON.stringify(s.field));
  ok('是警告樣式、寫出目的地、並說明還沒套用',
     s.warn && /還沒套用/.test(s.note) && /evil\.example/.test(s.note), `「${s.note}」`);
  ok('金鑰不留在網址列（警告路徑也一樣）', s.hash === '' && !/token/.test(s.search), `「${s.search}」`);

  // (c) query 形式也讀得進來（容錯），而且相同設定要說「不需要做什麼」
  await openWith(3, '&sync=' + encodeURIComponent(GAS) + '&token=' + encodeURIComponent(TOKEN));
  s = await state();
  ok('query 形式也讀得進來', s.on && s.url === GAS && s.backend === 'sheet', JSON.stringify([s.url, s.backend]));
  ok('相同設定不當成變更', !s.warn && /相同/.test(s.note), `「${s.note}」`);

  // (d) 產生的連結：hash 形式、正確編碼、解得回原值
  const built = await page.evaluate(() => {
    sync.url = 'https://script.google.com/macros/s/AAA/exec'; sync.token = 'tk 1&x';
    return buildSyncLink();
  });
  ok('產生的連結放在 hash 而不是 query（query 會進伺服器記錄）',
     built.includes('#sync=') && !built.includes('?sync='), built);
  ok('連結的參數有正確編碼', /&token=tk%201%26x$/.test(built), built);
  await page.goto(built.replace('#', '?t=4#'));
  await page.waitForTimeout(2500);
  s = await state();
  ok('那條連結解得回原本的網址與金鑰',
     s.field[0] === 'https://script.google.com/macros/s/AAA/exec' && s.field[1] === 'tk 1&x',
     JSON.stringify(s.field));

  // (e) 面板文案要提到這個功能 —— 不然使用者只會繼續手動貼兩個欄位
  ok('面板文案有教「複製同步連結」', await page.evaluate(() =>
     /複製同步連結/.test($('syncWhat').closest('.notice').textContent)));
  ok('文案有警告連結等於金鑰', await page.evaluate(() =>
     /等於金鑰/.test($('syncWhat').closest('.notice').textContent)));

  // 收尾：把同步關掉，後面幾節不需要 Sheet（也不要背景上傳干擾）
  await page.evaluate(() => { $('syncOff').click(); });
  ok('停用之後連結提示也收起來', await page.evaluate(() => $('syncLinkNote').hidden));
}

console.log('\n[9] 每個 view 都能渲染');
for (const v of ['plan', 'team', 'box', 'recipes']) {
  await page.evaluate((x) => showView(x), v);
  await page.waitForTimeout(400);
  ok(`view-${v} 有內容`, await page.evaluate((x) => $('view-' + x).innerText.trim().length > 50, v));
}

console.log('\n[10] 多 worker 分片 = 單執行緒窮舉（這是平行化的正確性保證）');
{
  /* 分片把列舉空間按 i % N 切給多個 worker，各自回傳前 FINALISTS 名，
     主執行緒合併後才跑決賽。這一節斷言「分片路徑」與「單執行緒 searchTeams」
     的輸出**逐欄位相同** —— 不是「差不多」，是相同。
     這是整個平行化改動唯一真正重要的檢查。 */
  const r = await page.evaluate(async () => {
    const picks = D.dex.filter(x => x.ms && x.b).filter((_, i) => i % 7 === 0).slice(0, 26);
    roster = picks.map((x, i) => ({
      sp: D.dex.indexOf(x), level: 30 + (i % 25),
      nature: ['Adamant','Modest','Careful','Mild','Sassy'][i % 5],
      ss: i % 2 ? ['Helping Bonus', null,null,null,null] : [null,null,null,null,null],
      ingSet: [0,0,0], skillLv: 3 + (i % 4), ribbon: 0, pin: false, ex: false,
    }));
    wk.fav = new Set(['ORAN','PAMTRE','PECHA']);
    wk.recipeScope = 'all'; wk.strictBerry = false;
    renderBox(); syncWeeklyUI();

    const shape = (best) => best.map(x => ({
      idxs: x.idxs.slice(),
      total: Math.round(x.total * 100) / 100,
      berryS: Math.round(x.berryS * 100) / 100,
      skillS: Math.round(x.skillS * 100) / 100,
      dishS: Math.round(x.dishS * 100) / 100,
      score: Math.round(x.score * 100) / 100,
      potEff: x.potEff, recipe: x.recipe ? x.recipe.n : null,
      mpTotal: x.mp ? Math.round(x.mp.total * 100) / 100 : null,
      fast: x.outs.map(o => Math.round(o.sim.fastShare * 1e4) / 1e4),
    }));

    // 走 worker 池
    lastResults = null;
    await run();
    const viaPool = shape(lastResults);
    const poolNote = $('comboCount').textContent;

    // 單執行緒，同一份輸入
    const single = searchTeams(roster.map(m => ({...m})), { ...wk, fav: new Set(wk.fav) }, {});

    return { viaPool, poolNote, viaSingle: shape(single.best),
             countPool: Number(poolNote.replace(/,/g,'').match(/(\d+) 種組合/)?.[1] || 0),
             countSingle: single.count, threads: poolNote.match(/(\d+) 執行緒/)?.[1] || null };
  });

  ok(`用了多執行緒（${r.threads || '?'}）`, !!r.threads && Number(r.threads) >= 1, r.poolNote);
  ok(`兩條路徑列舉的組合數相同（${r.countSingle.toLocaleString()}）`,
     r.countPool === r.countSingle, `pool=${r.countPool} single=${r.countSingle}`);
  const same = JSON.stringify(r.viaPool) === JSON.stringify(r.viaSingle);
  ok('多 worker 與單執行緒的前 8 名逐欄位相同', same,
     same ? '' : `pool[0]=${JSON.stringify(r.viaPool[0])}\n      single[0]=${JSON.stringify(r.viaSingle[0])}`);
}

console.log('\n[10b] Worker：40 隻的箱子推演期間 UI 不能凍住');
{
  /* 40 隻 → C(40,5) = 658,008 組合。同步版本會凍住約 5 秒。
     這一節刻意關掉 strictBerry —— 它要測的是「長時間推演期間 UI 不凍住」，
     開著篩選會把搜尋縮到 3 萬多組、300ms 就跑完，取消鈕與進度條都來不及觀察（會 flaky）。 */
  await page.evaluate(() => {
    const picks = D.dex.filter(p => p.ms).slice(0, 40);
    roster = picks.map((p) => ({
      sp: D.dex.indexOf(p), level: 40, nature: 'Bashful',
      ss: [null, null, null, null, null], ingSet: [0, 0, 0], skillLv: 3,
      ribbon: 0, pin: false, ex: false,
    }));
    wk.strictBerry = false;
    renderBox(); syncWeeklyUI();
  });
  ok('箱子有 40 隻', await page.evaluate(() => roster.length) === 40);

  // 不 await —— 我們要在推演「進行中」的時候戳 UI
  await page.evaluate(() => { window.__done = false; lastResults = null; run().then(()=>{ window.__done = true; }); });
  await page.waitForFunction(() => !$('cancelBtn').hidden, null, { timeout: 15000 });
  ok('推演中會出現取消按鈕', true);

  // 主執行緒還活著嗎？切主題必須立刻生效
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'system');
  await page.click('#themeBtn');
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'system');
  ok('推演期間主題切換仍有反應（UI 沒凍住）', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

  // 進度條要真的動
  const moved = await page.waitForFunction(() => Number($('runProg').value) > 0, null, { timeout: 30000 })
    .then(() => true).catch(() => false);
  ok('進度條會動', moved);

  await page.waitForFunction(() => window.__done === true, null, { timeout: 90000 });
  const r = await page.evaluate(() => ({
    n: lastResults ? lastResults.length : 0,
    combos: $('comboCount').textContent,
    cancelHidden: $('cancelBtn').hidden,
    btnEnabled: !$('runBtn').disabled,
  }));
  ok('40 隻推出結果', r.n === 8, JSON.stringify(r));
  ok('組合數是 C(40,5)=658,008', /658,008/.test(r.combos), r.combos);
  ok('沒有退回主執行緒', !/主執行緒/.test(r.combos), r.combos);
  ok('結束後取消按鈕收起、推演鈕解鎖', r.cancelHidden && r.btnEnabled, JSON.stringify(r));

  // 取消。開跑和按取消放在同一個同步任務裡 —— 不然 worker 可能比點擊還快就跑完了。
  // run() 在第一個 await 之前就已經 setRunning(true)，所以這時按下去一定有效。
  await page.evaluate(() => { lastResults = null; run(); $('cancelBtn').click(); });
  await page.waitForTimeout(300);
  const c = await page.evaluate(() => ({ txt: $('comboCount').textContent, hidden: $('cancelBtn').hidden, res: lastResults }));
  ok('取消後有明確狀態且沒有結果', /已取消/.test(c.txt) && c.hidden && !c.res, JSON.stringify(c));

  // 取消會 terminate worker —— 下一次推演必須還能跑（會重開一個）
  await doRun();
  ok('取消後仍能重新推演', await page.evaluate(() => lastResults.length) === 8);
}

console.log('\n[11] 文案一致性 — 不能提到不存在的檔案或指令');
{
  const paths = await page.evaluate(() => PATHS);
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));

  const missingFiles = [];
  for (const [k, rel] of Object.entries(paths.files))
    if (!existsSync(resolve(ROOT, rel))) missingFiles.push(`${k}=${rel}`);
  ok(`PATHS.files 指到的檔案都存在（${Object.keys(paths.files).length} 個）`,
     missingFiles.length === 0, missingFiles.join(', '));

  const missingCmds = [];
  for (const [k, cmd] of Object.entries(paths.cmds)) {
    const m = cmd.match(/^npm (?:run )?([\w:-]+)$/);
    if (!m || !pkg.scripts[m[1] === 'test' ? 'test' : m[1]]) missingCmds.push(`${k}=${cmd}`);
  }
  ok(`PATHS.cmds 的指令都定義在 package.json（${Object.keys(paths.cmds).length} 個）`,
     missingCmds.length === 0, missingCmds.join(', '));

  /* 反向檢查：文案裡不該再出現沒過 PATHS 的硬寫路徑。
     這是真正抓到過 bug 的那一條 —— 拆檔後 UI 還在說「替換 index.html 裡的 gamedata」。 */
  const copy = await page.evaluate(() => {
    const ids = ['refreshNote', 'verBuild', 'boxEmpty', 'saveStatus', 'syncStatus'];
    return ids.map(i => ($(i) ? $(i).innerHTML : '')).join(' \n ');
  });
  const known = new Set(Object.values(paths.files));
  const hardcoded = [...copy.matchAll(/[\w./-]+\.(?:json|js|html|css|mjs)\b/g)]
    .map(m => m[0].replace(/^\.\//, ''))
    .filter(p => !known.has(p));
  ok('文案裡沒有 PATHS 以外的硬寫路徑', hardcoded.length === 0, [...new Set(hardcoded)].join(', '));
  ok('文案沒有殘留已不存在的 gamedata 區塊', !/gamedata/.test(copy));

  /* 資源版本一致。app.css / src/*.js 沒有 game.json 那種 schema 斷言，所以瀏覽器
     可能拿到「新的 index.html ＋ 舊的 CSS/JS」—— 實際踩過：篩選列出現了，
     但卡片版面和選單內容都還是舊的。兩處版本號不同步就等於沒有防護。 */
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const appSrc = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const cssV = (html.match(/app\.css\?v=([\w-]+)/) || [])[1];
  const assetV = (html.match(/ASSET_V\s*=\s*'([\w-]+)'/) || [])[1];
  const appV = (appSrc.match(/^const APP_V = '([\w-]+)';/m) || [])[1];
  ok('app.css 帶 ?v= 快取破除', !!cssV, String(cssV));
  ok('loader 有 ASSET_V 常數', !!assetV, String(assetV));
  ok('app.js 有 APP_V 常數', !!appV, String(appV));
  ok('三處資源版本一致（app.css ?v= / ASSET_V / APP_V）',
     !!cssV && cssV === assetV && assetV === appV,
     `app.css=${cssV} ASSET_V=${assetV} APP_V=${appV}`);
  // 跑起來的那一份也必須是同一個版本（證明斷言真的有生效，不是只有常數對得上）
  ok('載入的 app.js 版本與 index.html 相符',
     await page.evaluate(() => window.ASSET_V === APP_V));
}

/* 截圖匯入。這一節的 golden case 是**七隻真實的寶可夢**（使用者 2026-09-07 與
   2026-09-08 提供的遊戲截圖），期望值是逐欄手算對照過的 —— 不是程式自己算出來再
   存回去，所以動到 baseStats / helpInterval / impSolve 的係數時這裡會紅。

   每一隻的 `intervalSec` / `carry` 都是截圖上的字面值，而且都解出**唯一**的
   (物種, 緞帶)。第三個獨立校驗碼是樹果顆數（樹果專長 2 顆 ＋ 樹果數量S 1 顆），
   在後面單獨驗。 */
console.log('\n[11b] 截圖匯入：反解物種／緞帶／食材欄位');
const IMP_CASES = [
  { label: '大食花 Lv60 頑皮',
    obs: { level:60, specialty:'ingredient', mainSkill:'Charge Energy S',
           skillDisplayLv:6, skillPayload:43, nature:'Naughty',
           ss:['Skill Level Up M','Ingredient Finder M','Helping Speed M','Ingredient Finder S','Helping Speed S'],
           ingCounts:[2,4,6], intervalSec:1911, carry:35, camp:false },
    want: { sp:'VICTREEBEL', ribbon:4, ingSet:'0,1,1', skillLv:4, amb:'', berry:1 } },
  { label: '水箭龜 Lv62 馬虎',
    obs: { level:62, specialty:'ingredient', mainSkill:'Ingredient Magnet S',
           skillDisplayLv:3, skillPayload:11, nature:'Rash',
           ss:['Inventory Up M','Helping Bonus','Inventory Up L','Ingredient Finder S','Skill Trigger S'],
           ingCounts:[2,3,7], intervalSec:2458, carry:65, camp:false },
    // i60 是 牛奶×7 / 可可×5 / 豆製肉×7 —— ×7 有兩個選項，所以第 3 格一定是歧義
    want: { sp:'BLASTOISE', ribbon:4, ingSet:'0,1,0', skillLv:3, amb:'3', berry:1 } },
  /* 以下五隻：2026-09-08 的截圖。挑這幾隻是因為每一隻都壓到一個不同的邊界。 */
  { label: '嘎啦嘎啦 Lv55 害羞',
    // 害羞是**無修正**性格（畫面「沒有性格帶來的特色」）—— nat.f = 1 這條路徑
    obs: { level:55, specialty:'berry', mainSkill:'Charge Energy S',
           skillDisplayLv:6, skillPayload:43, nature:'Bashful',
           ss:['Helping Bonus','Berry Finding S','Skill Trigger M','Helping Speed S','Inventory Up S'],
           ingCounts:[1,2,4], intervalSec:49*60+3, carry:26, camp:false },
    // 第 2 格：暖暖薑×2 與 放鬆可可×2 數量相同 → 一定是歧義，要標出來
    want: { sp:'MAROWAK', ribbon:3, ingSet:'0,0,0', skillLv:6, amb:'2', berry:3 } },
  { label: '耿鬼 Lv50 怕寂寞',
    // 能量填充S 畫面顯示的是**區間**「393〜1,570」→ 走 impEffFromPayload 第二段
    obs: { level:50, specialty:'ingredient', mainSkill:'Charge Strength S',
           skillDisplayLv:3, skillPayload:393, nature:'Lonely',
           ss:['Helping Speed M','Helping Speed S','Inventory Up S','Skill Level Up S','Ingredient Finder M'],
           ingCounts:[2,5,6], intervalSec:23*60+30, carry:40, camp:false },
    // Lv50 第 3 格還沒解鎖，但畫面預告了「品鮮蘑菇×6」→ 必須解成 1，不是預設的 0
    want: { sp:'GENGAR', ribbon:3, ingSet:'0,0,1', skillLv:3, amb:'', berry:1, src:'payload-range' } },
  { label: '嘟嘟利 Lv53 害羞',
    // 主技能等級 Lv.1（下界）＋ 持有上限提升L（+18）
    obs: { level:53, specialty:'berry', mainSkill:'Charge Energy S',
           skillDisplayLv:1, skillPayload:12, nature:'Bashful',
           ss:['Inventory Up L','Berry Finding S','Helping Speed M','Ingredient Finder S','Research EXP Bonus'],
           ingCounts:[1,2,4], intervalSec:29*60+32, carry:50, camp:false },
    want: { sp:'DODRIO', ribbon:3, ingSet:'0,0,0', skillLv:1, amb:'', berry:3 } },
  { label: '隆隆岩 Lv60 怕寂寞',
    // 緞帶 1（RIBBON_CARRY 的 +1）—— 其他六隻都不是 1，這格單獨壓一次
    obs: { level:60, specialty:'ingredient', mainSkill:'Charge Strength S',
           skillDisplayLv:2, skillPayload:285, nature:'Lonely',
           ss:['Helping Speed M','Ingredient Finder M','Helping Speed S','Sleep EXP Bonus','Skill Level Up M'],
           ingCounts:[2,4,6], intervalSec:32*60+24, carry:27, camp:false },
    want: { sp:'GOLEM', ribbon:1, ingSet:'0,1,1', skillLv:2, amb:'', berry:1, src:'payload-range' } },
  { label: '妙蛙花 Lv61 樂天',
    /* 這隻是「畫面顯示的是加成後等級」的第二個獨立憑據：技能等級提升M 在第 3 格
       （Lv50 解鎖）而牠 Lv61 → 加成 +2 生效；說明數字 17 反查出有效等級 5，
       正好等於畫面顯示的 Lv.5 → 基礎值 3。 */
    obs: { level:61, specialty:'ingredient', mainSkill:'Ingredient Magnet S',
           skillDisplayLv:5, skillPayload:17, nature:'Lax',
           ss:['Ingredient Finder M','Ingredient Finder S','Skill Level Up M','Skill Trigger M','Sleep EXP Bonus'],
           ingCounts:[2,4,6], intervalSec:41*60+4, carry:35, camp:false },
    want: { sp:'VENUSAUR', ribbon:4, ingSet:'0,1,2', skillLv:3, amb:'', berry:1 } },
];
{
  for (const c of IMP_CASES) {
    const r = await page.evaluate(obs => {
      const res = impSolve(obs);
      if (!res.cands.length) return { n: 0 };
      const t = res.cands[0], v = impVerify(t.m, obs);
      return { n: res.cands.length, sp: D.dex[t.m.sp].n, ribbon: t.m.ribbon,
        ingSet: t.m.ingSet.join(','), skillLv: t.m.skillLv, eff: t.skill.effective,
        src: t.skill.source, iv: t.interval, cr: t.carry,
        berry: baseStats(t.m, {camp:0}).berriesPerDrop,
        amb: [0,1,2].filter(s => t.amb[s] && t.amb[s].length > 1).map(s => s+1).join(','),
        vOk: v.interval.ok === true && v.carry.ok === true };
    }, c.obs);
    ok(`${c.label}：唯一解`, r.n === 1, `得到 ${r.n} 組`);
    ok(`${c.label}：反解出 ${c.want.sp}`, r.sp === c.want.sp, `得到 ${r.sp}`);
    ok(`${c.label}：反解出緞帶 ${c.want.ribbon}（截圖上看不到）`, r.ribbon === c.want.ribbon, `得到 ${r.ribbon}`);
    ok(`${c.label}：食材欄位 [${c.want.ingSet}]`, r.ingSet === c.want.ingSet, `得到 [${r.ingSet}]`);
    ok(`${c.label}：主技能基礎等級 ${c.want.skillLv}（畫面顯示的是加成後）`,
       r.skillLv === c.want.skillLv, `得到 ${r.skillLv}，有效 ${r.eff}，來源 ${r.src}`);
    ok(`${c.label}：有效等級是從技能說明的數字反查`, r.src === (c.want.src || 'payload'), r.src);
    ok(`${c.label}：兩個校驗碼都重算得回截圖上的值`,
       r.iv === c.obs.intervalSec && r.cr === c.obs.carry && r.vOk,
       `${r.iv}s / ${r.cr}個`);
    /* 第三個獨立校驗碼：畫面「樹果 ×N」。樹果專長 2 顆 ＋ 樹果數量S 1 顆。
       它不吃幫忙間隔也不吃持有上限，所以是一條真正獨立的驗算。 */
    ok(`${c.label}：樹果顆數 ×${c.want.berry}（第三個獨立校驗碼）`, r.berry === c.want.berry, `得到 ×${r.berry}`);
    ok(`${c.label}：歧義欄位標示正確（第 ${c.want.amb || '無'} 格）`, r.amb === c.want.amb, `得到「${r.amb}」`);
  }

  /* 範圍型主技能。遊戲對耿鬼的「能量填充S」顯示「卡比獸的能量增加393〜1,570」，
     而快照只存一個固定值 785 —— 區間剛好是 [v/2, 2v]。這一段保證：
       (1) 區間的**兩端**都反查得出同一個等級
       (2) 精確比對有唯一解時**不會**被第二段影響（大食花的 43 還是走第一段）
       (3) 掃過全部技能 × 全部等級的兩端，第二段不會給出「錯的唯一解」
     第 (3) 條是關鍵：這種放寬比對很容易靜靜地算錯，而算錯的技能等級不會讓任何
     校驗碼破掉（幫忙間隔與持有上限都不吃 skillLv）—— 沒有這條就沒人擋得住。 */
  const rng = await page.evaluate(() => {
    const pick = (nm, pay) => { const h = impEffFromPayload(nm, pay); return h ? [h.lv, h.ranged] : null; };
    let good = 0, ambig = 0, exact = 0, wrong = 0;
    for (const nm of Object.keys(D.ms)) {
      for (const k of Object.keys(D.ms[nm])) {
        const arr = D.ms[nm][k];
        if (!Array.isArray(arr)) continue;
        arr.forEach((v, i) => {
          if (typeof v !== 'number') return;
          for (const pay of [Math.round(v/2), v*2]) {
            const h = impEffFromPayload(nm, pay);
            if (!h) { ambig++; continue; }
            if (!h.ranged) { exact++; continue; }
            if (h.lv === i+1) good++; else wrong++;
          }
        });
      }
    }
    return { lo: pick('Charge Strength S', 393), hi: pick('Charge Strength S', 1570),
             lo2: pick('Charge Strength S', 285), hi2: pick('Charge Strength S', 1138),
             exact43: pick('Charge Energy S', 43), exact11: pick('Ingredient Magnet S', 11),
             sweep: { good, ambig, exact, wrong } };
  });
  ok('範圍型技能：區間低端 393 → 有效等級 3', rng.lo && rng.lo[0] === 3 && rng.lo[1] === true, JSON.stringify(rng.lo));
  ok('範圍型技能：區間高端 1570 → 同一個等級 3', rng.hi && rng.hi[0] === 3 && rng.hi[1] === true, JSON.stringify(rng.hi));
  ok('範圍型技能：285／1138 都 → 有效等級 2',
     rng.lo2 && rng.lo2[0] === 2 && rng.hi2 && rng.hi2[0] === 2, JSON.stringify([rng.lo2, rng.hi2]));
  ok('精確比對優先（43 與 11 不受第二段影響）',
     rng.exact43 && rng.exact43[0] === 6 && rng.exact43[1] === false &&
     rng.exact11 && rng.exact11[0] === 3 && rng.exact11[1] === false, JSON.stringify([rng.exact43, rng.exact11]));
  ok('全技能 × 全等級掃描：第二段不會給出錯的唯一解',
     rng.sweep.wrong === 0 && rng.sweep.good > 0, JSON.stringify(rng.sweep));

  /* 還沒解鎖的食材格也要解。`baseStats` 只讀 min(floor(level/30)+1,3) 格，所以
     這一格存錯**不會讓任何數字跑掉** —— 一路等到升級才發現。實際踩過：耿鬼 Lv50
     的第 3 格畫面預告「品鮮蘑菇×6」，跳過的話會存成預設的「火辣香草×7」。 */
  const lock = await page.evaluate(() => {
    const gp = D.dex.findIndex(x => x.n === 'GENGAR');
    const set = impIngSets(gp, 50, [2, 5, 6]);
    const i60 = D.dex[gp].i60;
    const mk = i2 => ({ sp: gp, level: 50, nature: 'Lonely',
      ss: ['Helping Speed M','Helping Speed S','Inventory Up S','Skill Level Up S','Ingredient Finder M'],
      ingSet: [0, 0, i2], skillLv: 3, ribbon: 3, pin: false, ex: false });
    // 換遍第 3 格，看兩個校驗碼與樹果顆數會不會變（不會 → 錯了也無聲）
    const sigs = new Set(i60.map((_, i) => {
      const bs = baseStats(mk(i), {camp:0});
      return [impInterval(mk(i), false), impCarry(mk(i), false), bs.berriesPerDrop].join('/');
    }));
    return { pick: set.pick.join(','), slots: set.slots,
             name: D.zh.ings[ING_NAME[i60[set.pick[2]][0]]], amt: i60[set.pick[2]][1],
             silent: sigs.size === 1 };
  });
  ok('未解鎖的第 3 格照樣用 ×N 解出來（耿鬼 Lv50 → 品鮮蘑菇×6）',
     lock.pick === '0,0,1' && lock.name === '品鮮蘑菇' && lock.amt === 6,
     `${lock.pick} / ${lock.name}×${lock.amt}`);
  ok('回傳的 slots 仍然是 2（UI 才知道那格還不生效）', lock.slots === 2, String(lock.slots));
  ok('而第 3 格存錯不會讓任何校驗碼破掉 —— 所以只能靠上面那條擋',
     lock.silent === true, String(lock.silent));

  // 中文反向查表（含全形 Ｍ —— 遊戲字型可能是全形，zh 表裡是半形）
  const rev = await page.evaluate(() => ({
    ssHalf: impSubskill('幫忙速度M'), ssFull: impSubskill('幫忙速度Ｍ'),
    hb: impSubskill('幫手獎勵'), nat: impNature('頑皮'),
    ms: impMainSkill('活力填充S'), ing: ING_NAME[impIngIndex('好眠番茄')],
    junk: impSubskill('不存在的副技能'),
  }));
  ok('副技能中文反查（半形／全形都要通）',
     rev.ssHalf === 'Helping Speed M' && rev.ssFull === 'Helping Speed M', JSON.stringify(rev));
  ok('性格／主技能／食材中文反查',
     rev.nat === 'Naughty' && rev.ms === 'Charge Energy S' && rev.ing === 'Tomato', JSON.stringify(rev));
  ok('認不出來的字串回 null（不亂猜）', rev.junk === null, String(rev.junk));

  /* 這是整個功能的價值所在：讀錯一欄，校驗碼就對不起來，寧可無解也不要給錯答案。 */
  const corrupt = await page.evaluate(base => {
    const muts = [
      ['等級 60→59', {level:59}],
      ['性格頑皮→認真', {nature:'Serious'}],
      ['漏看幫忙速度M', {ss:['Skill Level Up M','Ingredient Finder M',null,'Ingredient Finder S','Helping Speed S']}],
      ['持有上限 35→34', {carry:34}],
      ['幫忙間隔差 1 秒', {intervalSec:1912}],
    ];
    return muts.map(([name, patch]) => {
      const res = impSolve(Object.assign({}, base, patch));
      const same = res.cands.length && D.dex[res.cands[0].m.sp].n === 'VICTREEBEL' && res.cands[0].m.ribbon === 4;
      return {name, leaked: !!same, n: res.cands.length};
    });
  }, IMP_CASES[0].obs);
  for (const c of corrupt)
    ok(`讀錯「${c.name}」不會靜靜地解出原答案`, !c.leaked, `候選 ${c.n} 組`);

  /* 反過來：欄位缺得多就該老實變成多解並講出來，不能挑一個看起來確定的答案。 */
  const degrade = await page.evaluate(base => {
    const noCk = impSolve(Object.assign({}, base, {intervalSec:null, carry:null}));
    const ivOnly = impSolve(Object.assign({}, base, {carry:null}));
    return { noCkN: noCk.cands.length, warned: noCk.notes.some(n => /無法反解/.test(n)),
      ivOnlyN: ivOnly.cands.length,
      ivOnlySp: [...new Set(ivOnly.cands.map(c => D.dex[c.m.sp].n))].join('/') };
  }, IMP_CASES[0].obs);
  ok('兩個校驗碼都沒填 → 退化成多解並警告', degrade.noCkN > 1 && degrade.warned, `${degrade.noCkN} 組`);
  ok('只有幫忙間隔 → 物種鎖定但緞帶仍多解',
     degrade.ivOnlyN > 1 && degrade.ivOnlySp === 'VICTREEBEL',
     `${degrade.ivOnlyN} 組 / ${degrade.ivOnlySp}`);

  /* 使用者明確要求的行為：自動判斷完只是草稿，每欄都還能改，確認了才進箱子。 */
  const flow = await page.evaluate(obs => {
    const before = roster.length;
    $('impLevel').value = obs.level; $('impIvMin').value = 31; $('impIvSec').value = 51;
    $('impCarry').value = obs.carry; $('impSpec').value = obs.specialty;
    $('impCamp').value = '0'; $('impMs').value = obs.mainSkill;
    $('impSkillLv').value = obs.skillDisplayLv; $('impPayload').value = obs.skillPayload;
    $('impNature').value = obs.nature;
    [...$('impSs').querySelectorAll('[data-s]')].forEach((s, i) => { s.value = obs.ss[i] || ''; });
    $('impIng0').value = 2; $('impIng1').value = 4; $('impIng2').value = 6;
    $('impSolveBtn').click();

    const reviewShown = !$('impReview').hidden;
    const rowFields = [...$('impRow').querySelectorAll('[data-k]')].map(e => e.dataset.k);
    const notWritten = roster.length === before;      // 還沒按確認 → 箱子不能變
    const solvedSp = D.dex[impDraft.sp].n, solvedRb = impDraft.ribbon;

    /* 手動改一欄（等級）→ 校驗碼必須立刻變紅。
       **每次都要重新查元素** —— 任何欄位改動都會讓 renderImpReview() 重畫整個
       #impRow（和寶可夢箱一樣：摘要不重畫就會和選單不一致），所以第一次拿到的
       節點在改完之後已經脫離 DOM。在脫離的節點上 dispatch 不會冒泡到 #impRow
       的委派處理器 —— 改動靜靜地不生效，而測試會以為「改不回來」是程式的錯。 */
    const lvEl = () => $('impRow').querySelector('[data-k="level"]');
    let lv = lvEl();
    lv.value = 55; lv.dispatchEvent(new Event('change', {bubbles:true}));
    const wentBad = $('impChecks').innerHTML.includes('impck bad');
    lv = lvEl();                                    // ← 上面那次已經重畫過了
    lv.value = 60; lv.dispatchEvent(new Event('change', {bubbles:true}));
    const backOk = !$('impChecks').innerHTML.includes('impck bad');
    const backLevel = impDraft.level;

    $('impSave').click();
    const added = roster.length === before + 1;
    const last = roster[roster.length - 1];
    return { reviewShown, rowFields, notWritten, solvedSp, solvedRb, wentBad, backOk, backLevel,
             added, savedSp: last && D.dex[last.sp].n, savedRb: last && last.ribbon,
             savedLevel: last && last.level,
             formCleared: $('impLevel').value === '' && $('impReview').hidden };
  }, IMP_CASES[0].obs);
  ok('按「自動判斷」會開出校對區', flow.reviewShown);
  ok('校對區反解出正確的物種與緞帶', flow.solvedSp === 'VICTREEBEL' && flow.solvedRb === 4,
     `${flow.solvedSp} / 緞帶${flow.solvedRb}`);
  ok('每個原本可選的欄位都還能改（種類／等級／性格／副技能／食材／技能Lv／緞帶）',
     ['sp','level','nature','ss','ingSet','skillLv','ribbon'].every(k => flow.rowFields.includes(k)),
     flow.rowFields.join(','));
  ok('確認之前絕對不會寫進箱子', flow.notWritten);
  ok('手動改壞欄位 → 校驗碼立刻標紅', flow.wentBad);
  ok('改回正確值 → 校驗碼恢復', flow.backOk && flow.backLevel === 60,
     `backOk=${flow.backOk} level=${flow.backLevel}`);
  ok('按「存入箱子」才真的加進 roster',
     flow.added && flow.savedSp === 'VICTREEBEL' && flow.savedRb === 4 && flow.savedLevel === 60,
     `${flow.savedSp} / 緞帶${flow.savedRb} / Lv${flow.savedLevel}`);
  ok('存入後表單與草稿都清空', flow.formCleared);

  /* regression：露營券留「未指定」時 impSolve 會兩種都試，重新校驗必須用
     **這組解實際採用的那一種**。用 obs.camp（未指定→false）去算的話，
     camp=true 才成立的解會被誤報成「和畫面不符」。

     用的數字是同一隻大食花在**有開露營券**時畫面會顯示的值（26分32秒／42個，
     頻率與容量都 ×1.2）。這組只有 camp=true 成立 —— 舊做法會把兩個校驗碼
     都標紅，所以這條測試真的守得住那個 bug。 */
  const campless = await page.evaluate(obs => {
    const before = roster.length;
    $('impLevel').value = obs.level; $('impIvMin').value = 26; $('impIvSec').value = 32;
    $('impCarry').value = 42; $('impSpec').value = obs.specialty;
    $('impCamp').value = '';                      // ← 未指定
    $('impMs').value = obs.mainSkill;
    $('impSkillLv').value = obs.skillDisplayLv; $('impPayload').value = obs.skillPayload;
    $('impNature').value = obs.nature;
    [...$('impSs').querySelectorAll('[data-s]')].forEach((s, i) => { s.value = obs.ss[i] || ''; });
    $('impIng0').value = 2; $('impIng1').value = 4; $('impIng2').value = 6;
    $('impSolveBtn').click();
    const r = { sp: impDraft && D.dex[impDraft.sp].n,
      ribbon: impDraft && impDraft.ribbon,
      campUsed: impCampUsed,
      bad: $('impChecks').innerHTML.includes('impck bad'),
      saysCamp: /好露營券/.test($('impNotes').innerHTML),
      notWritten: roster.length === before };
    impResetForm();
    return r;
  }, IMP_CASES[0].obs);
  ok('露營券未指定時仍解出正確物種與緞帶',
     campless.sp === 'VICTREEBEL' && campless.ribbon === 4, `${campless.sp} / 緞帶${campless.ribbon}`);
  ok('這組數字確實是靠 camp=true 解出來的（否則測不到那個 bug）', campless.campUsed === true);
  ok('露營券未指定時校驗碼不會誤報不符', !campless.bad);
  ok('會講出這組解假設的露營券前提', campless.saysCamp);
  ok('這一輪也沒有偷偷寫進箱子', campless.notWritten);
}

/* 分批建箱子（我讀截圖 → 給 JSON → 使用者貼上）時，一次貼一隻卻把整箱換掉
   會吃掉前面輸入的全部資料。雲端同步與開機還原走的是「整份取代」，不能受影響。 */
console.log('\n[11c] JSON 匯入：追加 vs 取代');
{
  const r = await page.evaluate(() => {
    const mk = n => ({sp:n, level:30, nature:'Bashful', ss:[null,null,null,null,null],
                      ingSet:[0,0,0], skillLv:1, ribbon:0});
    const names = () => roster.map(m => D.dex[m.sp].n).join(',');
    deserialize({roster: [mk('PIKACHU'), mk('RAICHU')]});
    const start = names();
    deserialize({roster: [mk('GENGAR')]}, {append: true});
    const appended = names();
    deserialize({roster: [mk('MEW')]});
    const replaced = names();

    wk.areaBonus = 35;
    deserialize({roster: [mk('EEVEE')], wk: {areaBonus: 5}}, {append: true});
    const keptWk = wk.areaBonus;
    deserialize({roster: [mk('EEVEE')], wk: {areaBonus: 5}});
    const tookWk = wk.areaBonus;
    wk.areaBonus = 15;

    /* `sp` 的還原。serialize() 寫的是內部名，但手寫或別處產生的 JSON 可能用
       dex 索引。以前認不出來就靜靜退回索引 0 —— 五隻不同的寶可夢會一起變成
       妙蛙種子，畫面上沒有任何提示。實際踩過（2026-09-08）。 */
    const gi = D.dex.findIndex(x => x.n === 'GENGAR');
    const vi = D.dex.findIndex(x => x.n === 'VENUSAUR');
    const byIdx = deserialize({roster: [{...mk('MEW'), sp: gi}, {...mk('MEW'), sp: vi}]});
    const idxNames = names();
    const bad = deserialize({roster: [{...mk('MEW'), sp: 'NOT_A_POKEMON'}, {...mk('MEW'), sp: 9999}]});
    const badNames = names();
    return {start, appended, replaced, keptWk, tookWk,
            idxNames, idxBad: byIdx.badSp.length, badNames, bad: bad.badSp};
  });
  ok('起始兩隻', r.start === 'PIKACHU,RAICHU', r.start);
  ok('追加會接在現有的後面', r.appended === 'PIKACHU,RAICHU,GENGAR', r.appended);
  ok('取代會換掉整箱（備份還原用的）', r.replaced === 'MEW', r.replaced);
  ok('追加不會動到本週條件', r.keptWk === 35, String(r.keptWk));
  ok('取代會套用 JSON 裡的本週條件', r.tookWk === 5, String(r.tookWk));
  ok('sp 也接受 dex 索引（impSolve 產出的就是索引）',
     r.idxNames === 'GENGAR,VENUSAUR' && r.idxBad === 0, r.idxNames);
  ok('認不出來的 sp 會被回報，不是靜靜變成第一隻',
     r.bad.length === 2 && r.bad.includes('NOT_A_POKEMON') && r.bad.includes('9999'),
     JSON.stringify(r.bad));
  ok('（回報之後才退回第一隻，讓使用者有東西可以改）',
     r.badNames === 'BULBASAUR,BULBASAUR', r.badNames);
}

/* 自訂暱稱。遊戲的詳細頁**沒有物種名**，所以使用者認得的是自己取的名字
   （「樹果萌萌」而不是「嘎啦嘎啦」）。純標籤，引擎不看它 —— 但它是**唯一會進
   innerHTML 的使用者輸入**，所以 escape 是必須的，不是防禦性過頭。 */
console.log('\n[11f] 寶可夢箱：自訂暱稱');
{
  const r = await page.evaluate(() => {
    const one = (nick, sp) => ({sp: sp || 'MAROWAK', level:55, nature:'Bashful',
      ss:['Helping Speed M',null,null,null,null], ingSet:[0,0,0], skillLv:1, ribbon:0, nick});
    deserialize({roster: [one('樹果萌萌'), one(''), one('火7', 'GENGAR')]});
    clearBoxFilter(); monOpen.clear(); renderBox();
    const nameOf = i => $('boxList').querySelector(`[data-i="${i}"] .mon-name`);
    const named = {
      nick: nameOf(0).textContent, nickCls: nameOf(0).classList.contains('is-nick'),
      plain: nameOf(1).textContent, plainCls: nameOf(1).classList.contains('is-nick'),
      // 摺疊列被暱稱蓋掉時，學名要還在 title 裡（而 #圖鑑號 本來就在同一列上）
      title: nameOf(0).getAttribute('title'),
      no: $('boxList').querySelector('[data-i="0"] .mon-no').textContent,
    };
    // 展開後「種類」選單顯示的就是學名，而且改得動
    monOpen.add(0); renderBox();
    const card = $('boxList').querySelector('[data-i="0"]');
    const spSel = card.querySelector('[data-k="sp"]');
    const opened = {
      spVal: +spSel.value, spText: spSel.options[spSel.selectedIndex].text,
      nickVal: card.querySelector('[data-k="nick"]').value,
      // 沒取名的那隻，暱稱欄的 placeholder 就是學名
      ph: (()=>{ monOpen.add(1); renderBox();
        return $('boxList').querySelector('[data-i="1"] [data-k="nick"]').placeholder; })(),
    };
    // 改暱稱：走 change（text input 是離開欄位才觸發，所以 renderBox 不會吃掉輸入）
    monOpen.clear(); monOpen.add(1); renderBox();
    const inp = $('boxList').querySelector('[data-i="1"] [data-k="nick"]');
    inp.value = '  新名字  ';
    inp.dispatchEvent(new Event('change', {bubbles:true}));
    const edited = {stored: roster[1].nick,
      shown: $('boxList').querySelector('[data-i="1"] .mon-name').textContent};

    // 搜尋：暱稱和學名都要找得到同一隻
    const vis = () => [...$('boxList').querySelectorAll('[data-i]')].filter(e=>!e.hidden).map(e=>+e.dataset.i);
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    $('fltName').value = '樹果萌萌'; fire('fltName','input');
    const byNick = vis();
    $('fltName').value = '嘎啦嘎啦'; fire('fltName','input');
    const bySci = vis();
    clearBoxFilter(); renderBox();

    /* 重複偵測：數值一模一樣但暱稱不同 → 是兩隻不同的個體，不該標記。
       暱稱也一樣 → 同一隻的截圖看了兩遍，照樣要抓到。 */
    deserialize({roster: [one('甲'), one('乙')]});
    renderBox();
    const diffNick = [...monDup];
    deserialize({roster: [one('甲'), one('甲')]});
    renderBox();
    const sameNick = [...monDup];

    // escape：暱稱是使用者輸入，直接塞進 innerHTML 會被注入（payload 要短於 NICK_MAX）
    deserialize({roster: [one('<img src=x>"y')]});
    monOpen.clear(); monOpen.add(0); renderBox();
    const xss = {
      imgs: $('boxList').querySelectorAll('img').length,
      text: $('boxList').querySelector('.mon-name').textContent,
      // value="…" 屬性也不能被引號打斷
      inputVal: $('boxList').querySelector('[data-k="nick"]').value,
    };

    // 推演結果卡：暱稱與學名並列，而且專長標籤要有顏色（class 是 .tag.ing，不是 .tag.ingredient）
    deserialize({roster: [one('樹果萌萌', 'VICTREEBEL')]});
    const p = D.dex[roster[0].sp];
    const card2 = document.createElement('div');
    roster[0]._bs = baseStats(roster[0], wk);
    card2.innerHTML = memberCard(1, 0, null, {ing:new Float64Array(NING), berryStrength:0, skillStrength:0,
      sim:{freqBase:1800, procs:1, productive:1, snack:0, fastHours:1, fastShare:1}});
    const mem = {nm: card2.querySelector('.nm').textContent,
      sci: !!card2.querySelector('.nm-sci'),
      tagCls: card2.querySelector('.tag').className};

    // serialize 要帶上 nick，Sheet 的可讀鏡像也要有那一欄
    deserialize({roster: [one('樹果萌萌')]});
    const ser = serialize().roster[0].nick;
    const tbl = rosterTable();
    return {named, opened, edited, byNick, bySci, diffNick, sameNick, xss, mem,
            ser, head0: tbl[0][0], row0: tbl[1][0]};
  });
  ok('有暱稱時摺疊列顯示暱稱', r.named.nick === '樹果萌萌' && r.named.nickCls, JSON.stringify(r.named));
  ok('沒暱稱時顯示學名（而且不加暱稱標示）',
     r.named.plain === '嘎啦嘎啦' && !r.named.plainCls, JSON.stringify(r.named));
  ok('摺疊列仍然看得出是哪一隻（#圖鑑號 ＋ title 有學名）',
     r.named.no === '#105' && /嘎啦嘎啦/.test(r.named.title) && /Marowak/.test(r.named.title),
     `${r.named.no} / 「${r.named.title}」`);
  ok('展開後「種類」選單就是學名，而且是選中狀態',
     r.opened.spText.startsWith('嘎啦嘎啦') && r.opened.nickVal === '樹果萌萌', JSON.stringify(r.opened));
  ok('沒取名時暱稱欄的 placeholder 是學名', r.opened.ph === '嘎啦嘎啦', r.opened.ph);
  ok('改暱稱會 trim 並即時反映到摺疊列',
     r.edited.stored === '新名字' && r.edited.shown === '新名字', JSON.stringify(r.edited));
  ok('打暱稱搜得到', r.byNick.join(',') === '0', r.byNick.join(','));
  ok('打學名也搜得到同一隻（取了暱稱也不例外）', r.bySci.join(',') === '0,1', r.bySci.join(','));
  ok('數值相同但暱稱不同 → 不是重複（是兩隻不同的個體）',
     r.diffNick.length === 0, JSON.stringify(r.diffNick));
  ok('數值與暱稱都相同 → 照樣抓到重複', r.sameNick.join(',') === '0,1', JSON.stringify(r.sameNick));
  ok('暱稱有 escape：不會注入標記', r.xss.imgs === 0 && /<img/.test(r.xss.text), JSON.stringify(r.xss));
  ok('暱稱有 escape：引號不會打斷 value 屬性',
     r.xss.inputVal === '<img src=x>"y', `「${r.xss.inputVal}」`);
  ok('推演結果卡並列暱稱與學名',
     /樹果萌萌/.test(r.mem.nm) && /大食花/.test(r.mem.nm) && r.mem.sci, JSON.stringify(r.mem));
  ok('推演結果卡的專長標籤用對的 class（.tag.ing，不是 .tag.ingredient）',
     r.mem.tagCls === 'tag ing', r.mem.tagCls);
  ok('serialize 帶上暱稱（所以會跟著同步）', r.ser === '樹果萌萌', String(r.ser));
  ok('Sheet 可讀鏡像有「暱稱」欄',
     r.head0 === '暱稱' && r.row0 === '樹果萌萌', `${r.head0} / ${r.row0}`);
}

/* 箱子 UI 重做（一隻一張卡、三列、加篩選）。最要守住的是 data-i：
   篩選是用 hidden 切換而不是重建列表，所以 data-i 一定要是**真實的 roster 索引** ——
   用篩選後的序號當索引，改一格就會改到別隻身上，而且沒有任何錯誤訊息。 */
console.log('\n[11d] 寶可夢箱 UI：篩選、真實索引、完整顯示');
{
  const r = await page.evaluate(() => {
    const mk = (n, lv) => ({sp:n, level:lv||60, nature:'Bashful',
      ss:['Helping Speed M',null,null,null,null], ingSet:[0,0,0], skillLv:1, ribbon:0});
    /* regression：`deserialize` 整批換掉 roster 時必須清掉 `monOpen`。它存的是
       roster 索引，留著就會展開到「剛好是同一個索引」的**別隻**身上 —— 從雲端
       下載、JSON「取代」匯入都會走到這條。和 del 之後要 clear 同一個理由。
       這一節後面所有「預設摺疊」的斷言都靠它，所以刻意先塞兩個進去。 */
    monOpen.add(0); monOpen.add(2);
    // 順序刻意讓「篩選後的位置」和「真實索引」不一致：食材型在索引 1 和 3
    deserialize({roster: [mk('RAICHU'), mk('VICTREEBEL'), mk('SLOWKING'), mk('BLASTOISE')]});
    const openAfterLoad = monOpen.size;
    clearBoxFilter(); renderBox();
    const vis = () => [...$('boxList').querySelectorAll('[data-i]')].filter(e => !e.hidden).map(e => +e.dataset.i);
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));

    const all = vis();
    // 預設全部摺疊 —— 這是「一隻不要佔太多版面」的關鍵，摺疊時不該有任何編輯控制項
    const collapsedControls = $('boxList').querySelectorAll('[data-k]').length;
    // 摺疊列上要看得到摘要：副技能有稀有度色塊、食材有 ×N
    const firstHead = $('boxList').querySelector('[data-i="0"] .mon-head');
    const summary = {
      rr: firstHead.querySelectorAll('.rr').length,
      rrClass: firstHead.querySelector('.rr').className,
      ing: firstHead.querySelectorAll('.mon-i').length,
      ingText: firstHead.querySelector('.mon-i').textContent,
      /* 食材必須在**自己那一列**（`.mon-ings`），不能混在副技能的 `.mon-sum` 裡 ——
         兩種標籤混排、斷行位置又隨寬度浮動，掃 60 隻時分不出哪個是哪個。 */
      ingsRow: firstHead.querySelectorAll('.mon-ings').length,
      ingInSum: firstHead.querySelectorAll('.mon-sum .mon-i').length,
      ingInRow: firstHead.querySelectorAll('.mon-ings .mon-i').length,
      ssInRow: firstHead.querySelectorAll('.mon-ings .rr').length,
    };

    $('fltSpec').value = 'ingredient'; fire('fltSpec', 'change');
    const ingOnly = vis();
    const countText = $('boxCount').textContent;

    /* 展開第一張「可見」卡片，然後改它的等級 → 必須落在它 data-i 指的那一隻身上。
       篩選是用 hidden 切換，所以第一張可見的是索引 1（不是 0）。 */
    const card = $('boxList').querySelector('[data-i]:not([hidden])');
    const targetIdx = +card.dataset.i;
    card.querySelector('.mon-head').click();
    const openedControls = $('boxList').querySelector(`[data-i="${targetIdx}"]`).querySelectorAll('[data-k]').length;
    const lvInput = $('boxList').querySelector(`[data-i="${targetIdx}"] [data-k="level"]`);
    lvInput.value = 41; lvInput.dispatchEvent(new Event('change', {bubbles:true}));
    const levels = roster.map(m => m.level);
    // 再點一次要收起來
    $('boxList').querySelector(`[data-i="${targetIdx}"] .mon-head`).click();
    const reclosed = $('boxList').querySelectorAll('[data-k]').length;

    // 文字搜尋（中文名）
    $('fltSpec').value = ''; fire('fltSpec', 'change');
    $('fltName').value = '水箭龜'; fire('fltName', 'input');
    const searched = vis();
    // 搜尋副技能也要能命中
    $('fltName').value = '幫忙速度M'; fire('fltName', 'input');
    const bySs = vis().length;
    $('fltClear').click();
    const cleared = vis();

    /* 新增一隻要清掉篩選並自動展開，否則新的那隻（皮卡丘＝樹果型）會被篩掉、
       看起來像沒反應。**但排序不能一起清** —— 先設成「圖鑑編號」再新增。 */
    $('fltSort').value = 'no'; fire('fltSort', 'change');
    $('fltSpec').value = 'skill'; fire('fltSpec', 'change');
    $('addBtn').click();
    const newIdx = roster.length - 1;
    const newCard = $('boxList').querySelector(`[data-i="${newIdx}"]`);
    const afterAdd = {n: roster.length, spec: $('fltSpec').value,
      sort: boxFlt.sort, sortSel: $('fltSort').value,
      order: [...$('boxList').querySelectorAll('[data-i]')].map(e => D.dex[roster[+e.dataset.i].sp].no),
      newVisible: !newCard.hidden, newOpen: !!newCard.querySelector('.mon-edit'),
      /* 新增的那隻要**渲染在最前面**（「新增一隻」的按鈕就在畫面最上面 ——
         push 到最後的話 60 隻的箱子得往下拉到底才找得到那張要填的表單）。
         而且一定要標「剛新增」：在「加入順序」排序下把最新的一隻提到最前面，
         不講就等於排序的名稱在說謊。 */
      newFirst: +$('boxList').querySelector('[data-i]').dataset.i === newIdx,
      newTag: $('boxList').querySelectorAll('.mon-new').length,
      newTagOnIt: !!newCard.querySelector('.mon-new')};

    // 完整顯示：副技能選項是全名（不是 Help M 這種縮寫）、食材選項只放名稱、數量在旁邊
    const ssSel = newCard.querySelector('[data-k="ss"]');
    const ssText = [...ssSel.options].find(o => o.value === 'Helping Speed M').text;
    const ingSel = newCard.querySelector('[data-k="ingSet"]');
    const ingText = ingSel.options[0].text;
    const amount = ingSel.closest('.ingpick').querySelector('b').textContent;

    /* 收起來 ＝ 填完了 → 回到目前排序該有的位置，標記也要跟著消失。
       （置頂是「我正在編輯這一隻」的暫時狀態，不是一個新的排序規則。）
       重新 querySelector：上面那次 click 已經整個重畫過，舊的節點是脫離的。 */
    $('boxList').querySelector(`[data-i="${newIdx}"] .mon-head`).click();
    const afterCollapse = {
      order: [...$('boxList').querySelectorAll('[data-i]')].map(e => D.dex[roster[+e.dataset.i].sp].no),
      tag: $('boxList').querySelectorAll('.mon-new').length};

    /* 刪除會讓後面的索引整批位移 → 展開狀態必須清掉，
       不然會展開到「原本是下一隻」的那一隻身上。
       🗑 會先問一次 —— 這裡把 confirm 換掉，才能同時測「取消」和「確定」。
       （不用原生對話框：它會擋住 renderer，在 page.evaluate 裡容易卡死。） */
    const realConfirm = window.confirm;
    let askedMsg = '';
    monOpen.clear(); monOpen.add(2);
    renderBox();

    // 先按取消 —— 一隻都不能少
    window.confirm = (msg) => { askedMsg = msg; return false; };
    const beforeDel = roster.length;
    $('boxList').querySelector('[data-i="0"] [data-act="del"]').click();
    const afterCancel = {n: roster.length, msg: askedMsg};

    // 再按確定
    window.confirm = () => true;
    $('boxList').querySelector('[data-i="0"] [data-act="del"]').click();
    const afterDel = {n: roster.length, open: monOpen.size,
      anyEdit: $('boxList').querySelectorAll('.mon-edit').length, before: beforeDel};

    // ＋隊／📌／✕（排除）就在 🗑 旁邊，它們**不該**問 —— 隨手切換用的，而且可逆
    let askedForToggle = false;
    window.confirm = () => { askedForToggle = true; return true; };
    $('boxList').querySelector('[data-i="0"] [data-act="pin"]').click();
    $('boxList').querySelector('[data-i="0"] [data-act="ex"]').click();
    const toggleAsked = askedForToggle;
    window.confirm = realConfirm;

    // regression：夢幻／達克萊伊的 [null,0] 空欄位以前會顯示成 "undefined×0"
    deserialize({roster: [mk('MEW')]});
    clearBoxFilter(); monOpen.clear(); monOpen.add(0); renderBox();
    const mewSlot3 = [...$('boxList').querySelectorAll('[data-k="ingSet"]')][2].options[0].text;

    /* 未解鎖的食材格：和副技能同一個處理方式 —— 變淡但照樣顯示、照樣可改。
       以前是 disabled ＋ 顯示「未解鎖」，結果截圖校對時那一格根本改不了，而遊戲
       畫面明明預告了它（🔒Lv.60 加食材圖與 ×N）。 */
    const g = D.dex.findIndex(x => x.n === 'GENGAR');
    deserialize({roster: [{sp:g, level:50, nature:'Lonely', ss:[null,null,null,null,null],
                           ingSet:[0,0,1], skillLv:3, ribbon:3, pin:false, ex:false}]});
    clearBoxFilter(); monOpen.clear(); monOpen.add(0); renderBox();
    const gCard = $('boxList').querySelector('[data-i="0"]');
    const heads = [...gCard.querySelectorAll('.mon-i')];
    const picks = [...gCard.querySelectorAll('.ingpick')];
    const locked = {
      heads: heads.length,
      headLock: heads.map(e => e.classList.contains('lock')).join(','),
      headText: heads[2].textContent,
      pickLock: picks.map(e => e.classList.contains('locked')).join(','),
      disabled: picks.filter(e => e.querySelector('select').disabled).length,
      amount3: picks[2].querySelector('b').textContent,
      sel3: picks[2].querySelector('select').value,
    };

    /* 無修正的性格（`p === 'neutral'`，25 種裡有 5 種）以前會渲染成
       「害羞 +undefined −undefined」—— `'neutral'` 是 truthy，直接查 NAT_AB 就是
       undefined。性格選單（natLabel）和摺疊列（natBrief）都中。 */
    deserialize({roster: [{sp:'GENGAR', level:60, nature:'Bashful', ss:[null,null,null,null,null],
                           ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false},
                          {sp:'GENGAR', level:60, nature:'Lonely', ss:[null,null,null,null,null],
                           ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false}]});
    clearBoxFilter(); monOpen.clear(); monOpen.add(0); renderBox();
    const natTexts = {
      neutral: $('boxList').querySelector('[data-i="0"] .mon-nat').textContent.trim(),
      normal:  $('boxList').querySelector('[data-i="1"] .mon-nat').textContent.trim(),
      // 性格選單裡那 5 種也不能有 undefined
      optNeutral: [...$('boxList').querySelector('[data-k="nature"]').options]
                    .find(o => o.value === 'Bashful').text,
      optAll: [...$('boxList').querySelector('[data-k="nature"]').options]
                    .filter(o => /undefined/.test(o.text)).length,
    };

    return {openAfterLoad, all, collapsedControls, summary, ingOnly, countText, targetIdx, openedControls,
            levels, reclosed, searched, bySs, cleared, afterAdd, afterCollapse, afterCancel, afterDel,
            toggleAsked, ssText, ingText, amount, mewSlot3, locked, natTexts};
  });
  ok('整批載入 roster 會清掉展開狀態（否則展開到別隻身上）', r.openAfterLoad === 0, String(r.openAfterLoad));
  ok('未篩選時四隻都看得到', r.all.join(',') === '0,1,2,3', r.all.join(','));
  ok('預設摺疊：完全沒有編輯控制項（這才省得下版面）', r.collapsedControls === 0, String(r.collapsedControls));
  ok('摺疊列有副技能摘要，且底色帶稀有度',
     r.summary.rr === 1 && /\b(gold|silver|white)\b/.test(r.summary.rrClass), JSON.stringify(r.summary));
  ok('摺疊列有食材摘要（含 ×N）', r.summary.ing === 3 && /×\d/.test(r.summary.ingText),
     JSON.stringify(r.summary));
  ok('食材獨立成第二列，不和副技能混在同一個容器',
     r.summary.ingsRow === 1 && r.summary.ingInSum === 0 &&
     r.summary.ingInRow === 3 && r.summary.ssInRow === 0, JSON.stringify(r.summary));
  ok('依專長篩選（食材型是索引 1 和 3）', r.ingOnly.join(',') === '1,3', r.ingOnly.join(','));
  ok('會顯示篩選後的數量', /顯示 2 \/ 4/.test(r.countText), r.countText);
  ok('點摺疊列會展開出編輯控制項', r.openedControls > 8, String(r.openedControls));
  ok('篩選＋展開後改欄位會落在正確的那一隻（data-i 是真實索引）',
     r.targetIdx === 1 && r.levels.join(',') === '60,41,60,60', `idx=${r.targetIdx} levels=${r.levels.join(',')}`);
  ok('再點一次會收起來', r.reclosed === 0, String(r.reclosed));
  ok('文字搜尋中文名', r.searched.join(',') === '3', r.searched.join(','));
  ok('文字搜尋也能搜副技能', r.bySs === 4, String(r.bySs));
  ok('清除篩選會全部顯示', r.cleared.join(',') === '0,1,2,3', r.cleared.join(','));
  ok('新增一隻會清篩選、看得到、而且自動展開',
     r.afterAdd.n === 5 && r.afterAdd.spec === '' && r.afterAdd.newVisible && r.afterAdd.newOpen,
     JSON.stringify(r.afterAdd));
  /* 排序不是篩選。以前 clearBoxFilter() 連排序一起清掉 —— 用「圖鑑編號」在看箱子，
     按一下「新增一隻」整個列表就跳回加入順序，看起來像排序自己壞掉（實際踩過）。
     清除篩選、截圖存入、JSON 匯入三條路徑都走同一個函式，所以三條都中。
     置頂只影響新增的**那一張**，其餘仍照排序 —— 所以這裡比的是「去掉第一張之後」。 */
  ok('新增一隻不會把排序打掉（排序不是篩選）',
     r.afterAdd.sort === 'no' && r.afterAdd.sortSel === 'no' &&
     r.afterAdd.order.slice(1).join(',') === [...r.afterAdd.order.slice(1)].sort((a,b)=>a-b).join(','),
     `sort=${r.afterAdd.sort}/${r.afterAdd.sortSel} order=#${r.afterAdd.order.join(' #')}`);
  /* 「新增一隻」的按鈕在篩選列上（畫面最上面），但 roster.push 讓新的那隻排在最後 ——
     60 隻的箱子就得往下拉到底才找得到那張要填的表單，填完再拉回來按下一次。 */
  ok('新增的那一隻渲染在最前面，就在「新增一隻」按鈕底下',
     r.afterAdd.newFirst && r.afterAdd.order[0] === 25, JSON.stringify(r.afterAdd.order));
  ok('置頂的那一張標「剛新增」（否則等於排序的名稱在說謊）',
     r.afterAdd.newTag === 1 && r.afterAdd.newTagOnIt,
     `tag=${r.afterAdd.newTag} onIt=${r.afterAdd.newTagOnIt}`);
  ok('收起來就回到排序該有的位置，標記也消失（置頂只是「正在編輯」的暫時狀態）',
     r.afterCollapse.tag === 0 &&
     r.afterCollapse.order.join(',') === [...r.afterCollapse.order].sort((a,b)=>a-b).join(','),
     `tag=${r.afterCollapse.tag} order=#${r.afterCollapse.order.join(' #')}`);
  ok('副技能選項顯示全名', r.ssText === '幫忙速度M', r.ssText);
  ok('食材選項只放名稱，數量顯示在旁邊', r.ingText === '特選蘋果' && r.amount === '×1',
     `「${r.ingText}」 / 「${r.amount}」`);
  /* 刪除就排在三顆隨手切換的按鈕旁邊，手滑一格就少一隻，而且 save() 是即時的、
     雲端馬上跟著覆蓋 —— 沒有 undo。所以刪除一定要問，而且訊息要寫出是哪一隻。
     圖示也要分得開（見 11k）：✕ 讓給可逆的「排除」，刪除用 🗑。 */
  ok('按 🗑 會先問，按取消一隻都不會少',
     r.afterCancel.n === r.afterDel.before, `${r.afterCancel.n} vs ${r.afterDel.before}`);
  ok('確認訊息寫出是哪一隻（排序／篩選後才分得出按到誰）',
     /#\d+/.test(r.afterCancel.msg) && /Lv\d+/.test(r.afterCancel.msg) && /雷丘|皮卡丘|大食花|呆殼獸|河馬獸|水箭龜|耿鬼/.test(r.afterCancel.msg),
     `「${r.afterCancel.msg}」`);
  ok('按確定才真的刪，並清掉展開狀態（否則會展開到別隻身上）',
     r.afterDel.n === 4 && r.afterDel.before === 5 && r.afterDel.open === 0 && r.afterDel.anyEdit === 0,
     JSON.stringify(r.afterDel));
  ok('📌 / ✕（排除）不會問（隨手切換用的，而且可逆）', r.toggleAsked === false, String(r.toggleAsked));
  ok('空食材欄位顯示「（無）」而不是 undefined', r.mewSlot3 === '（無）', r.mewSlot3);
  ok('摺疊列三格食材都顯示，未解鎖那格變淡（和副技能一致）',
     r.locked.heads === 3 && r.locked.headLock === 'false,false,true', JSON.stringify(r.locked));
  ok('摺疊列的未解鎖格仍然寫出食材與數量（品鮮蘑菇×6）',
     /品鮮蘑菇×6/.test(r.locked.headText), r.locked.headText);
  ok('展開後未解鎖那格變淡但**不 disable**（校對時要改得動）',
     r.locked.pickLock === 'false,false,true' && r.locked.disabled === 0, JSON.stringify(r.locked));
  ok('未解鎖那格顯示 ×6，不是「未解鎖」',
     r.locked.amount3 === '×6' && r.locked.sel3 === '1', JSON.stringify(r.locked));
  /* `'neutral'` 是 truthy，所以 `n.p ? NAT_AB[n.p] : …` 會走 true 分支拿到 undefined。
     25 種性格裡有 5 種是這樣（害羞／勤奮／坦率／浮躁／認真）。 */
  ok('無修正的性格顯示「無修正」，不是 +undefined −undefined',
     r.natTexts.neutral === '害羞 無修正', `「${r.natTexts.neutral}」`);
  ok('有修正的性格照樣顯示 +／−', /怕寂寞\s*\+速度\s*−活力/.test(r.natTexts.normal), `「${r.natTexts.normal}」`);
  ok('性格選單裡沒有任何 undefined',
     r.natTexts.optNeutral === '害羞 無修正' && r.natTexts.optAll === 0, JSON.stringify(r.natTexts));
}

/* 排序、展開／收起全部、重複偵測、主技能顯示。
   排序最要守住的是「只改渲染順序，data-i 仍是真實索引」—— 和篩選同一個坑。 */
console.log('\n[11e] 寶可夢箱：排序、展開全部、重複偵測');
{
  const r = await page.evaluate(() => {
    const mk = (n, lv, ss) => ({sp:n, level:lv, nature:'Bashful',
      ss:[...(ss||[]), ...Array(5-(ss||[]).length).fill(null)], ingSet:[0,0,0], skillLv:1, ribbon:0});
    // RAICHU=樹果 SLOWKING=技能 VICTREEBEL=食材 ；等級刻意亂序
    deserialize({roster: [mk('RAICHU',30), mk('SLOWKING',60), mk('VICTREEBEL',45)]});
    const order = () => [...$('boxList').querySelectorAll('[data-i]')].map(e => +e.dataset.i);
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    /* 排序要**明確**設回加入順序 —— clearBoxFilter() 刻意不動排序（見 11d 的
       「新增一隻不會把排序打掉」），所以不能靠它把上一節留下的排序清掉。 */
    clearBoxFilter(); $('fltSort').value = 'added'; fire('fltSort', 'change');
    monOpen.clear(); renderBox();

    const added = order();
    /* 圖鑑編號：摺疊列第一個顯示的就是 #圖鑑號，所以這是唯一「照畫面上的數字排」
       的順序。雷丘 #26 ／大食花 #71 ／呆呆王 #199 → 索引 0,2,1（加入順序是亂的）。 */
    $('fltSort').value = 'no'; fire('fltSort', 'change');
    const byNo = order();
    const byNoNums = [...$('boxList').querySelectorAll('[data-i]')]
      .map(e => D.dex[roster[+e.dataset.i].sp].no);
    const sortOpts = [...$('fltSort').options].map(o => o.value);
    $('fltSort').value = 'level'; fire('fltSort', 'change');
    const byLevel = order();
    $('fltSort').value = 'spec'; fire('fltSort', 'change');
    const bySpec = [...$('boxList').querySelectorAll('[data-i]')]
      .map(e => D.dex[roster[+e.dataset.i].sp].sp);
    // 排序後改欄位仍必須落在正確的那一隻
    const firstCard = $('boxList').querySelector('[data-i]');
    const sortedFirstIdx = +firstCard.dataset.i;
    firstCard.querySelector('.mon-head').click();
    const lv = $('boxList').querySelector(`[data-i="${sortedFirstIdx}"] [data-k="level"]`);
    lv.value = 7; lv.dispatchEvent(new Event('change', {bubbles:true}));
    const levelsAfter = roster.map(m => m.level);
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    monOpen.clear(); renderBox();

    // 主技能要顯示在摺疊列上
    const msTexts = [...$('boxList').querySelectorAll('.mon-ms')].map(e => e.textContent);

    // 展開全部 / 收起全部
    const before = $('boxExpand').textContent;
    $('boxExpand').click();
    const openedAll = {n: monOpen.size, edits: $('boxList').querySelectorAll('.mon-edit').length,
      label: $('boxExpand').textContent};
    $('boxExpand').click();
    const closedAll = {n: monOpen.size, edits: $('boxList').querySelectorAll('.mon-edit').length,
      label: $('boxExpand').textContent};
    // 有篩選時只展開看得到的那些
    $('fltSpec').value = 'ingredient'; fire('fltSpec', 'change');
    $('boxExpand').click();
    const openedFiltered = {n: monOpen.size, only: [...monOpen].every(i => D.dex[roster[i].sp].sp === 'ingredient')};
    monOpen.clear(); clearBoxFilter(); renderBox();

    // 重複偵測：完全一樣的兩隻才算；同物種同等級但副技能不同不算
    deserialize({roster: [
      mk('RAICHU', 30, ['Helping Speed M']),
      mk('RAICHU', 30, ['Helping Speed M']),      // ← 和上一隻完全相同
      mk('RAICHU', 30, ['Berry Finding S']),      // ← 副技能不同，不算重複
      mk('SLOWKING', 60),
    ]});
    clearBoxFilter(); renderBox();
    const dup = {set: [...monDup].sort((a,b)=>a-b), badges: $('boxList').querySelectorAll('.mon-dup').length,
      count: $('boxCount').textContent};
    $('fltState').value = 'dup'; fire('fltState', 'change');
    const dupOnly = [...$('boxList').querySelectorAll('[data-i]')].filter(e=>!e.hidden).map(e=>+e.dataset.i);
    // 改掉其中一隻的等級 → 不再重複
    monOpen.clear(); monOpen.add(1); clearBoxFilter(); renderBox();
    const lv2 = $('boxList').querySelector('[data-i="1"] [data-k="level"]');
    lv2.value = 31; lv2.dispatchEvent(new Event('change', {bubbles:true}));
    const dupGone = {set: monDup.size, badges: $('boxList').querySelectorAll('.mon-dup').length};
    monOpen.clear();
    return {added, byNo, byNoNums, sortOpts, byLevel, bySpec, sortedFirstIdx, levelsAfter, msTexts,
            before, openedAll, closedAll, openedFiltered, dup, dupOnly, dupGone};
  });
  ok('預設是加入順序', r.added.join(',') === '0,1,2', r.added.join(','));
  ok('排序選單有「圖鑑編號」這一項', r.sortOpts.includes('no'), r.sortOpts.join(','));
  ok('圖鑑編號排序（#26,#71,#199 → 索引 0,2,1）',
     r.byNo.join(',') === '0,2,1' && r.byNoNums.join(',') === '26,71,199',
     `${r.byNo.join(',')} / #${r.byNoNums.join(' #')}`);
  ok('等級高→低排序（60,45,30 → 索引 1,2,0）', r.byLevel.join(',') === '1,2,0', r.byLevel.join(','));
  ok('專長排序（樹果→食材→技能）', r.bySpec.join(',') === 'berry,ingredient,skill', r.bySpec.join(','));
  ok('排序只改顯示順序，data-i 仍是真實索引',
     r.sortedFirstIdx === 0 && r.levelsAfter.join(',') === '7,60,45',
     `first=${r.sortedFirstIdx} levels=${r.levelsAfter.join(',')}`);
  ok('摺疊列顯示主技能', r.msTexts.length === 3 && r.msTexts.includes('活力療癒S'), r.msTexts.join(' / '));
  ok('按鈕初始是「展開全部」', r.before === '展開全部', r.before);
  ok('展開全部：三隻都展開、按鈕變「收起全部」',
     r.openedAll.n === 3 && r.openedAll.edits === 3 && r.openedAll.label === '收起全部',
     JSON.stringify(r.openedAll));
  ok('收起全部：編輯區全部消失',
     r.closedAll.n === 0 && r.closedAll.edits === 0 && r.closedAll.label === '展開全部',
     JSON.stringify(r.closedAll));
  ok('有篩選時只展開看得到的那些', r.openedFiltered.n === 1 && r.openedFiltered.only,
     JSON.stringify(r.openedFiltered));
  ok('重複偵測：只有完全相同的兩隻被標記（索引 0,1）',
     r.dup.set.join(',') === '0,1' && r.dup.badges === 2, JSON.stringify(r.dup));
  ok('同物種同等級但副技能不同不算重複', !r.dup.set.includes(2), r.dup.set.join(','));
  ok('數量列會提示重複數', /⚠ 2 隻重複/.test(r.dup.count), r.dup.count);
  ok('「只看重複」篩選有效', r.dupOnly.join(',') === '0,1', r.dupOnly.join(','));
  ok('改掉其中一隻之後重複標記就消失', r.dupGone.set === 0 && r.dupGone.badges === 0,
     JSON.stringify(r.dupGone));
}

/* 個體產能。**只是顯示** —— 每週的推薦完全走原本的演算法。

   這一節守的是「這些數字不是憑空來的，而且不會誘導錯誤的比較」：
   三種專長各有自己的主指標與單位、排序先分專長、跨週穩定、理想值不低於實際值、
   量不到的東西（幫忙加成）要標出來而不是假裝算進去了。 */
console.log('\n[11g] 寶可夢箱：個體產能（三種專長各自的軸）');
{
  const r = await page.evaluate(() => {
    const mk = (n, lv, nat, ss, sk, rib) => ({
      sp: n, level: lv, nature: nat,
      ss: [...(ss||[]), ...Array(5 - (ss||[]).length).fill(null)],
      ingSet: [0,0,0], skillLv: sk||1, ribbon: rib||0, pin:false, ex:false, nick:'',
    });
    deserialize({roster: [
      mk('RAICHU', 60, 'Adamant', ['Berry Finding S','Helping Speed M'], 3, 4),      // 0 樹果
      mk('VENUSAUR', 60, 'Quiet', ['Ingredient Finder M','Helping Speed M'], 3, 4),  // 1 食材
      mk('WIGGLYTUFF', 60, 'Careful', ['Skill Trigger M','Helping Bonus'], 6, 4),    // 2 技能（隊伍型副技能）
      mk('BLASTOISE', 60, 'Sassy', ['Inventory Up M'], 3, 4),                        // 3 食材
      mk('PIKACHU', 5, 'Bashful', [], 1, 0),                                         // 4 樹果（很弱）
    ]});
    showView('box'); clearBoxFilter(); monOpen.clear();
    $('fltSort').value = 'added'; $('fltSort').dispatchEvent(new Event('change', {bubbles:true}));
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    const P = roster.map(m => monPowerCached(m));

    /* 主指標依專長而不同 —— 這是整個設計的重點。 */
    const mains = P.map(p => powerMain(p));
    const specs = P.map(p => p.spec);
    const units = P.map(p => powerText(p).u);

    /* 跨週可比：改本週加成樹果之後產能**完全不變**。 */
    const before = P.map(p => Math.round(p.total));
    const favWas = new Set(wk.fav);
    wk.fav = new Set(['GREPA','DURIN','PECHA']);
    _powerCache.clear();
    const after = roster.map(m => Math.round(monPowerCached(m).total));
    wk.fav = favWas; _powerCache.clear();

    /* 產能是純函式：不碰 POOL（不像前一版要 buildPool(參考條件) 再還原）。 */
    wk.recipeScope = 'type'; wk.dishType = 'salad'; buildPool(wk);
    const poolBefore = POOL.length;
    roster.forEach(m => monPower(m));
    const poolAfter = POOL.length;

    // 排序：先分專長，再組內高→低
    $('fltSort').value = 'power'; fire('fltSort', 'change');
    const order = [...$('boxList').querySelectorAll('[data-i]')].map(e => +e.dataset.i);
    const orderSpecs = order.map(i => P[i].spec);
    const groupedOk = orderSpecs.join(',') === [...orderSpecs].sort(
      (a,b) => SPEC_ORD.indexOf(a) - SPEC_ORD.indexOf(b)).join(',');
    const withinOk = order.every((idx, k) =>
      k === 0 || P[order[k-1]].spec !== P[idx].spec || powerMain(P[order[k-1]]) >= powerMain(P[idx]));

    // 同專長名次
    const ranks = roster.map((_, i) => rankOf(i));
    const chips = $('boxList').querySelectorAll('.mon-power').length;
    const rankChips = [...$('boxList').querySelectorAll('.mon-rank')].map(e => e.textContent);
    // 幫忙加成量不到 → 一定要標徽章
    const teamBadges = $('boxList').querySelectorAll('.mon-team').length;

    // 展開 → 產能列有四個原始數字；理想值不得低於實際值
    $('boxList').querySelector('[data-i="2"] .mon-head').click();
    const rowText = $('boxList').querySelector('[data-i="2"] .mon-scorerow').textContent.replace(/\s+/g,' ').trim();
    /* 分子是 `ideal.self`（＝牠在評價等級上的產能），不是當前產能 —— 這一隻本來
       就是 Lv60，所以兩者相同，但斷言要照實際用的那條算式寫。 */
    const ideal2 = idealCache.get(idealKey(roster[2]));
    const idealGE = !!ideal2 && powerMain(ideal2) >= powerMain(ideal2.self) - 1e-9;
    const pct = ideal2 ? Math.round(powerMain(ideal2.self) / powerMain(ideal2) * 100) : -1;
    /* 理想個體的目標函式必須是**那個專長的**主指標。技能型看發動次數，
       所以牠的理想副技能應該挑得到技能觸發那一類，而不是食材／樹果那一類。 */
    const idealSs2 = ideal2 ? ideal2.member.ss.filter(Boolean) : [];

    // 展開全部（5 隻，門檻 6）→ 仍然自動算；再確認不會炸
    $('boxExpand').click(); $('boxExpand').click();
    const rows = $('boxList').querySelectorAll('.mon-scorerow').length;

    monOpen.clear(); clearBoxFilter();
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    return {mains, specs, units, before, after, poolBefore, poolAfter,
            order, orderSpecs, groupedOk, withinOk, ranks, chips, rankChips, teamBadges,
            rowText, idealGE, pct, idealSs2, rows,
            note: $('scoreNote').textContent.trim(),
            /* 長篇說明摺起來了（使用者反映「介紹太多了」），但**會害人讀錯數字的那四件事
               必須留在摺疊外面** —— 摺起來等於沒有。這裡分開看摘要和摺疊區。 */
            sum: $('scoreNote').querySelector('.sum').textContent.trim(),
            exOpen: $('scoreNote').querySelector('details.more').open,
            exText: $('scoreNote').querySelector('details.more>div').textContent.trim(),
            interval0: P[0].interval, procs2: P[2].procs, ingE1: P[1].ingE, ingCount1: P[1].ingCount};
  });
  ok('每一隻都算得出主指標', r.mains.every(v => v > 0), r.mains.map(v => v.toFixed(2)).join(', '));
  /* 這是重新設計的核心：三種專長各有自己的軸，**單位不同就是在提醒別跨專長比**。 */
  ok('樹果型看總產能能量', r.units[0] === '產能/日', r.units[0]);
  ok('食材型看食材原始能量', r.units[1] === '食材能量/日', r.units[1]);
  ok('技能型看主技能發動次數', r.units[2] === '發動/日' && r.procs2 > 0,
     `${r.units[2]} / ${r.procs2.toFixed(2)}`);
  ok('食材型同時給得出顆數與能量', r.ingE1 > 0 && r.ingCount1 > 0,
     `${Math.round(r.ingE1)} 能量 / ${r.ingCount1.toFixed(1)} 顆`);
  /* 幫忙間隔和遊戲寶可夢詳細頁是同一個數字（nHB=0）—— 所以使用者對得起來。 */
  ok('幫忙間隔用單獨一隻的情境（和遊戲畫面同一個數字）', r.interval0 > 0 && r.interval0 < 4000,
     `${r.interval0}s`);
  ok('產能不吃本週加成樹果（跨週可比）', r.before.join(',') === r.after.join(','),
     `${r.before.join(',')} vs ${r.after.join(',')}`);
  /* 前一版要 buildPool(參考條件) 再還原；這一版是純函式，根本不碰 POOL。 */
  ok('算產能不會動到 POOL（純函式，不需要參考隊）',
     r.poolBefore === r.poolAfter && r.poolBefore > 0, `${r.poolBefore} → ${r.poolAfter}`);
  ok('排序先分專長（不把三種混在一起排）', r.groupedOk, r.orderSpecs.join(','));
  ok('同專長內由高到低', r.withinOk, r.order.join(','));
  ok('摺疊列每一張都有主指標', r.chips === 5, String(r.chips));
  /* 同專長內的名次才是可以跨專長讀的東西（「我最好的食材型」）。 */
  ok('摺疊列有同專長名次', r.rankChips.length === 5 && /樹果 1\/2|食材 1\/2/.test(r.rankChips.join(' ')),
     r.rankChips.join(' | '));
  ok('名次是同專長內算的', r.ranks[4].of === 2 && r.ranks[4].at === 2, JSON.stringify(r.ranks[4]));
  /* 「幫忙加成」的價值在加速隊友，單獨一隻量不到 —— 量不到就要說，不能假裝算進去了。 */
  ok('隊伍型副技能會標徽章（因為這個數字量不到它）', r.teamBadges === 1, String(r.teamBadges));
  ok('展開後有產能列，含樹果／食材／技能／間隔',
     /樹果/.test(r.rowText) && /食材/.test(r.rowText) && /技能/.test(r.rowText) && /間隔/.test(r.rowText),
     `「${r.rowText}」`);
  ok('理想值不會低於實際值（百分比不會超過 100%）', r.idealGE && r.pct <= 100 && r.pct > 0, `${r.pct}%`);
  /* 理想個體的目標函式是**那個專長的**主指標。技能型看發動次數，所以挑出來的
     副技能必須是提高發動率那一類 —— 用總產能當目標會挑出完全不同的一組。 */
  ok('技能型的理想個體挑的是提高發動率的副技能',
     r.idealSs2.some(n => /Skill Trigger/.test(n)), r.idealSs2.join(', ') || '(空)');
  ok('展開全部照樣算得出來', r.rows === 5, String(r.rows));
  /* 一個沒有出處的數字比沒有數字更糟，而「可以互相比」的暗示比沒有數字更糟。 */
  ok('說明文案講明三種專長不能互相比較', /不能互相比較/.test(r.note), r.note.slice(0, 60));
  ok('說明文案講明基準是單獨一隻、不含本週加成',
     /單獨一隻/.test(r.note) && /不含本週加成/.test(r.note), r.note.slice(0, 60));
  ok('說明文案講明不影響推演', /不影響推演/.test(r.note), r.note.slice(-40));
  ok('說明文案講明隊伍型副技能量不到', /量不到/.test(r.note), r.note.slice(-90));
  /* 完整說明有 300 多字，攤在篩選列和箱子列表中間會把真正要看的東西推到畫面外。
     所以摺疊 —— 但**摘要那一行要獨力守住四件事**：基準情境、不能跨專長比、
     資質% 是練滿後的比值、不影響推演。少任何一件，摺起來的人就會讀錯數字。 */
  ok('長篇說明預設摺起來（不然會把箱子列表推到畫面外）', r.exOpen === false && r.exText.length > 200,
     `open=${r.exOpen} len=${r.exText.length}`);
  ok('摘要那一行獨力講完會害人讀錯的事（基準／不能跨專長比／三個數字各答哪個問題／不影響推演）',
     /單獨一隻/.test(r.sum) && /不含本週加成樹果/.test(r.sum) &&
     /不能互相比較/.test(r.sum) && /練滿/.test(r.sum) && /資質/.test(r.sum) &&
     /技能/.test(r.sum) && /不影響推演/.test(r.sum),
     r.sum);
  ok('摘要要短（超過 160 字就等於沒摺）', r.sum.length <= 160, `${r.sum.length} 字`);
}

/* 食材篩選：「誰產這幾種食材、誰產最多」。食譜要的是**一組**特定食材，所以篩選
   是攤平的可複選 chips 而不是下拉 —— 下拉一次只能選一個，問不出「誰供得起這道菜」。
   這也是箱子裡唯一**可以跨專長排**的名次：同一組食材、同一個單位。 */
console.log('\n[11h] 寶可夢箱：食材篩選（可複選）與選中食材的產量排名');
{
  const r = await page.evaluate(() => {
    const mk = (n, lv, ingSet) => ({sp: n, level: lv, nature: 'Bashful',
      ss: [null,null,null,null,null], ingSet, skillLv: 1, ribbon: 0, pin: false, ex: false, nick: ''});
    // 耿鬼 Lv50 的第 3 格（Lv60 才解鎖）是刻意的：欄位有、產量 0
    deserialize({roster: [
      mk('VENUSAUR', 60, [0,0,0]), mk('VENUSAUR', 30, [0,0,0]),
      mk('RAICHU', 60, [0,0,0]), mk('GENGAR', 50, [0,0,2]),
    ]});
    showView('box'); clearBoxFilter(); monOpen.clear();
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    const vis = () => [...$('boxList').querySelectorAll('[data-i]')].filter(e => !e.hidden).map(e => +e.dataset.i);
    const tap = i => $('fltIng').querySelector(`[data-ing="${i}"]`).click();
    const pressed = () => $('fltIng').querySelectorAll('[aria-pressed="true"]').length;

    const chips = [...$('fltIng').querySelectorAll('[data-ing]')];
    const zh = chips.map(c => c.textContent);
    const flatOk = !$('fltIng').querySelector('option') && chips.length === ING_NAME.length &&
      zh.join('|') === [...zh].sort((a,b)=>a.localeCompare(b,'zh-Hant')).join('|');

    const a0 = ingPick(roster[0], 0)[0];      // 兩隻妙蛙花都產
    const r2 = ingPick(roster[2], 0)[0];      // 只有雷丘產
    tap(a0);
    const one = {vis: vis(), n: pressed(), count: $('boxCount').textContent,
                 unit: $('boxList').querySelector('[data-i="0"] .mon-power i').textContent};
    tap(r2);                                   // 複選：任一種 → 聯集
    const anyMode = {vis: vis(), note: $('fltIngNote').textContent,
                     unit: $('boxList').querySelector('[data-i="0"] .mon-power i').textContent,
                     val: parseFloat($('boxList').querySelector('[data-i="2"] .mon-power').textContent)};
    $('fltIngMode').querySelector('[data-mode="all"]').click();   // 全部都要 → 交集
    const allMode = {vis: vis(), note: $('fltIngNote').textContent, none: !$('boxNone').hidden};
    $('fltIngMode').querySelector('[data-mode="any"]').click();
    tap(r2);                                   // 再點一次取消
    const off = {vis: vis(), size: boxFlt.ing.size};

    $('fltSort').value = 'ingAmt'; fire('fltSort', 'change');
    const order = vis();
    const amts = order.map(i => ingSum(roster[i]));
    const descOk = amts.every((v, k) => k === 0 || amts[k-1] >= v);

    tap(a0);                                   // 取消，改選耿鬼那個未解鎖的
    const g3 = ingPick(roster[3], 2)[0];
    tap(g3);
    const locked = {shown: vis().includes(3), amt: ingSum(roster[3]),
                    dim: !!$('boxList').querySelector('[data-i="3"] .mon-power.zero')};
    tap(g3);
    const hint = $('boxCount').textContent;    // 沒選食材卻用這個排序
    tap(a0);
    $('fltClear').click();
    const cleared = {size: boxFlt.ing.size, n: vis().length, pressed: pressed()};

    monOpen.clear(); clearBoxFilter();
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    return {flatOk, nChips: chips.length, one, anyMode, allMode, off, order, amts, descOk,
            locked, hint, cleared, a0zh: iz(ING_NAME[a0])};
  });
  ok('食材篩選是攤平的可複選 chips（不是下拉），照中文名排序', r.flatOk, `${r.nChips} 個 chip`);
  ok('選一種：篩出產它的那些', r.one.vis.join(',') === '0,1' && r.one.n === 1, r.one.vis.join(','));
  ok('摺疊列的數字換成該食材的產量', r.one.unit === `${r.a0zh}/日`, r.one.unit);
  ok('數量列反映篩選', /顯示 2 \/ 4/.test(r.one.count), r.one.count);
  ok('複選「任一種」＝聯集', r.anyMode.vis.join(',') === '0,1,2' && /任一種/.test(r.anyMode.note),
     `${r.anyMode.vis.join(',')} / ${r.anyMode.note}`);
  ok('複選時摺疊列顯示的是選中那幾種的總量',
     r.anyMode.unit === '2 種食材/日' && r.anyMode.val > 0, `${r.anyMode.unit} = ${r.anyMode.val}`);
  ok('「全部都要」＝交集（這組沒有一隻同時產）',
     r.allMode.vis.length === 0 && r.allMode.none && /全部都產/.test(r.allMode.note), r.allMode.note);
  ok('再點一次會取消選取', r.off.vis.join(',') === '0,1' && r.off.size === 1, JSON.stringify(r.off));
  ok('依選中食材的總產量由高到低排序', r.descOk && r.order.join(',') === '0,1',
     `${r.order.join(',')} / ${r.amts.map(v=>v.toFixed(1)).join(', ')}`);
  /* 遊戲畫面預告得出來，所以要篩得到；但實際產量是 0。藏起來使用者看不出
     「為什麼牠沒出現」，顯示成正常值又是說謊。 */
  ok('未解鎖的食材格也篩得到，但產量 0 且變淡',
     r.locked.shown && r.locked.amt < 1e-9 && r.locked.dim, JSON.stringify(r.locked));
  ok('沒選食材就用這個排序時會講出來', /排序要先選食材/.test(r.hint), r.hint);
  ok('清除篩選會清掉食材選取，chips 也彈回來',
     r.cleared.size === 0 && r.cleared.n === 4 && r.cleared.pressed === 0, JSON.stringify(r.cleared));
}

/* 摺疊列上的「資質 N%」（＝ 牠 ÷ 同物種同等級的理想個體）與**雙向**排序。
   守兩件事：
   ① 那個百分比和展開後產能列上的是**同一個數字**（兩份算式一定會走鐘）。
   ② 方向只寫在按鈕上。`<option>` 裡再寫一次「高→低」，按了反轉就有一個變成謊話。 */
console.log('\n[11i] 寶可夢箱：資質（理想個體 %）與雙向排序');
{
  const r = await page.evaluate(() => {
    const mk = (n, lv, nat, ss, sk, rib) => ({
      sp:n, level:lv, nature:nat||'Bashful',
      ss:[...(ss||[]), ...Array(5-(ss||[]).length).fill(null)],
      ingSet:[0,0,0], skillLv:sk||1, ribbon:rib||0, pin:false, ex:false, nick:''});
    deserialize({roster: [
      mk('RAICHU', 60, 'Adamant', ['Berry Finding S','Helping Speed M'], 3, 4),  // 0 練得不錯
      mk('RAICHU', 60, 'Bashful', [], 1, 0),                                     // 1 同物種同等級，白板
      mk('VENUSAUR', 30, 'Quiet', ['Ingredient Finder M'], 3, 4),                // 2 別的專長、別的等級
    ]});
    showView('box'); clearBoxFilter(); monOpen.clear();
    $('fltSort').value = 'added'; $('fltSort').dispatchEvent(new Event('change', {bubbles:true}));
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    /* 背景填算是 setTimeout 排的，在同一個 evaluate 裡不會跑到 —— 這裡直接
       同步算完，測的才是排序與顯示，不是計時器。 */
    roster.forEach(m => idealOf(m, true));
    renderBox();

    const order = () => [...$('boxList').querySelectorAll('[data-i]')].map(e => +e.dataset.i);
    const chips = [...$('boxList').querySelectorAll('[data-i]')].map(e => {
      const c = e.querySelector('.mon-idl');
      return c ? c.textContent.trim() : null;
    });
    const pcts = roster.map(m => idealPct(m));
    /* 基準是固定的 Lv60（超過就用實際等級），不是牠現在的等級。
       所以同一隻在 Lv30 和 Lv45 必須給出**完全一樣**的資質 —— 升級不會讓
       這個數字自己跳動（以前會：跨過 50／60 才把第 3 格副技能／食材算進去）。 */
    const lvls = roster.map(m => idealOf(m).lvl);
    // 這一段直接叫引擎，所以 sp 要是 dex 索引（roster 裡的形式），不是內部名
    const at = (n, lv, ss) => ({...mk(n, lv, 'Adamant', ss, 3, 4), sp: D.dex.findIndex(p => p.n === n)});
    const r30 = monIdeal(at('RAICHU', 30, ['Berry Finding S','Helping Speed M']));
    const r45 = monIdeal(at('RAICHU', 45, ['Berry Finding S','Helping Speed M']));
    const r75 = monIdeal(at('WIGGLYTUFF', 75, ['Skill Trigger M']));
    const pctOf = x => Math.round(powerMain(x.self) / powerMain(x) * 100);
    const fixed = {lv30: r30.lvl, lv45: r45.lvl, lv75: r75.lvl,
      pct30: pctOf(r30), pct45: pctOf(r45),
      // 快取鍵也要正規化，否則 Lv30／Lv45 會各算一次同樣的東西
      sameKey: idealKey(at('RAICHU', 30, [])) === idealKey(at('RAICHU', 45, []))};
    /* 副技能還有空格 → 分子只會被低估 → 顯示成下界（≥）。填滿就不該有 ≥。 */
    const partial = at('RAICHU', 60, ['Berry Finding S','Helping Speed M']);
    const filled  = at('RAICHU', 60, ['Berry Finding S','Helping Speed M','Inventory Up M']);
    idealOf(partial, true); idealOf(filled, true);
    const bound = {partial: idealChip(partial).includes('≥'), full: idealChip(filled).includes('≥')};
    /* 版面：資質在摺疊列的**第二列、欄 1**（名字／等級底下）。DOM 上它必須是
       `.mon-head` 的直接子元素，而且排在 `.mon-rest` 之後、`.mon-ings` 之前 ——
       grid 的自動排版照 DOM 走，順序錯了就會掉到別的格子。 */
    const head = $('boxList').querySelector('[data-i="0"] .mon-head');
    const kids = [...head.children].map(e => e.className.split(' ')[0]);
    const layout = {kids, direct: head.querySelector(':scope > .mon-idl') !== null,
      inIdy: head.querySelectorAll('.mon-idy .mon-idl').length,
      inIngs: head.querySelectorAll('.mon-ings .mon-idl').length};

    // 摺疊列的百分比必須等於展開後產能列上的那一個
    $('boxList').querySelector('[data-i="0"] .mon-head').click();
    const rowPct = ($('boxList').querySelector('[data-i="0"] .mon-ideal b')||{}).textContent;
    const headPct = $('boxList').querySelector('[data-i="0"] .mon-idl b').textContent;
    monOpen.clear(); renderBox();

    // 資質排序（正向＝高→低）
    $('fltSort').value = 'ideal'; fire('fltSort', 'change');
    const byIdeal = order(), dirFwd = $('fltDir').textContent.trim();
    const fwdPcts = byIdeal.map(i => idealPct(roster[i]));
    // 反轉 → 整份倒過來
    $('fltDir').click();
    const revIdeal = order(), dirRev = $('fltDir').textContent.trim();

    // 「加入順序」也要能反轉（它沒有比較器，靠的是同鍵時的 tie-break）
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    const addedFwd = order(), addedDir = boxFlt.dir;      // 換排序時方向要回到正向
    $('fltDir').click();
    const addedRev = order();
    // 等級：正向是高→低，反轉就是低→高
    $('fltSort').value = 'level'; fire('fltSort', 'change');
    const lvFwd = order().map(i => roster[i].level);
    $('fltDir').click();
    const lvRev = order().map(i => roster[i].level);
    const revLabel = $('fltDir').textContent.trim();

    /* 方向不能同時寫在 `<option>` 裡 —— 反轉之後其中一個一定變成謊話。 */
    const optTexts = [...$('fltSort').options].map(o => o.text);
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    monOpen.clear(); clearBoxFilter(); renderBox();
    return {chips, pcts, layout, rowPct, headPct, byIdeal, fwdPcts, revIdeal, lvls, fixed, bound,
            dirFwd, dirRev, addedFwd, addedRev, addedDir, lvFwd, lvRev, revLabel, optTexts,
            note: $('scoreNote').textContent.trim()};
  });
  ok('摺疊列每一隻都有「資質 N%」', r.chips.every(t => t && /資質\s*≥?\d+%/.test(t)), r.chips.join(' | '));
  ok('資質是比值，不會超過 100%（理想個體含牠自己、且同在評價基準上）',
     r.pcts.every(v => v > 0 && v <= 100), r.pcts.join(', '));
  /* 基準固定在 Lv60（超過就用實際等級）。以前跟著當前等級走，於是升到 50／60
     跨過門檻時第 3 格副技能／食材才被算進去，百分比會自己往下掉 —— 而使用者問的是
     「該把糖果餵給哪一隻」，那是關於練滿之後的問題。 */
  ok(`評價等級固定在 Lv${60}（Lv30／Lv45 都評在 60）`,
     r.fixed.lv30 === 60 && r.fixed.lv45 === 60, `${r.fixed.lv30} / ${r.fixed.lv45}`);
  ok('已經超過 60 的用牠的實際等級（不丟掉已知的第 4 格副技能）',
     r.fixed.lv75 === 75, String(r.fixed.lv75));
  ok('同一隻在 Lv30 和 Lv45 的資質完全相同（升級不會讓這個數字自己跳動）',
     r.fixed.pct30 === r.fixed.pct45, `${r.fixed.pct30}% vs ${r.fixed.pct45}%`);
  ok('快取鍵也依評價等級正規化（Lv30／Lv45 共用同一格）', r.fixed.sameKey, String(r.fixed.sameKey));
  ok('箱子裡的每一隻都評在 ≥60', r.lvls.every(v => v >= 60), r.lvls.join(', '));
  /* 空著的副技能格只會讓分子變小（副技能沒有負值），所以那個百分比是下界。
     靜靜地把「還沒記」當成「就是沒有」，會誤導投資判斷。 */
  ok('副技能有空格時標成下界（≥），填滿就不標',
     r.bound.partial && !r.bound.full, JSON.stringify(r.bound));
  /* 同物種同等級：練得好的那一隻百分比一定比白板高 —— 這正是「個體資質」要回答的問題。 */
  ok('同物種同等級時，副技能／性格好的那一隻百分比比較高',
     r.pcts[0] > r.pcts[1], `${r.pcts[0]}% vs ${r.pcts[1]}%`);
  ok('資質在摺疊列第二列欄 1（.mon-head 的直接子元素，排在 .mon-rest 之後）',
     r.layout.direct && r.layout.inIdy === 0 && r.layout.inIngs === 0 &&
     r.layout.kids.join(',') === 'mon-idy,mon-rest,mon-idl,mon-ings', r.layout.kids.join(','));
  /* 兩份算式一定會走鐘，而走鐘的那份會靜靜地顯示錯的數字。 */
  ok('摺疊列的百分比和展開後產能列上的是同一個數字',
     r.headPct === r.rowPct && /%$/.test(r.headPct), `摺疊 ${r.headPct} / 展開 ${r.rowPct}`);
  ok('依資質排序（高→低）',
     r.fwdPcts.join(',') === [...r.fwdPcts].sort((a,b)=>b-a).join(','), r.fwdPcts.join(', '));
  ok('反轉之後就是整份倒過來',
     r.revIdeal.join(',') === [...r.byIdeal].reverse().join(','),
     `${r.byIdeal.join(',')} → ${r.revIdeal.join(',')}`);
  ok('「加入順序」也反轉得了（它沒有比較器，靠 tie-break）',
     r.addedFwd.join(',') === '0,1,2' && r.addedRev.join(',') === '2,1,0',
     `${r.addedFwd.join(',')} → ${r.addedRev.join(',')}`);
  /* 「等級低→高」按完換去看「主技能」，繼承一個反向會讓人以為排序壞了。 */
  ok('換排序時方向回到正向', r.addedDir === 1, String(r.addedDir));
  ok('等級：正向高→低、反轉低→高',
     r.lvFwd.join(',') === [...r.lvFwd].sort((a,b)=>b-a).join(',') &&
     r.lvRev.join(',') === [...r.lvRev].sort((a,b)=>a-b).join(','),
     `${r.lvFwd.join(',')} → ${r.lvRev.join(',')}`);
  ok('按鈕上寫著目前的方向（↓／↑ ＋ 文字）',
     /^↓/.test(r.dirFwd) && /資質高→低/.test(r.dirFwd) &&
     /^↑/.test(r.dirRev) && /資質低→高/.test(r.dirRev) && /等級低→高/.test(r.revLabel),
     `${r.dirFwd} / ${r.dirRev} / ${r.revLabel}`);
  /* 方向寫在兩個地方，按了反轉就有一個在說謊。 */
  ok('排序選單本身不寫方向（方向只在按鈕上）',
     !r.optTexts.some(t => /高→低|低→高/.test(t)), r.optTexts.join(' | '));
  ok('說明文案講明資質是比值、只在同物種之間有意義',
     /只在同物種之間有意義/.test(r.note) && /100% 的皮卡丘/.test(r.note),
     r.note.slice(-120));
  /* 一個沒有出處的數字比沒有數字更糟 —— 基準的三樣都要寫出來。
     少了「緞帶4、主技能滿級」，讀者就無從知道「還沒練」不會壓低這個數字。 */
  ok('說明文案講明基準是 Lv60 以上 ＋ 緞帶4 ＋ 主技能滿級',
     /Lv60 以上/.test(r.note) && /緞帶4/.test(r.note) && /主技能滿級/.test(r.note),
     r.note.slice(-260));
}

/* 用另開的頁面跑 —— 這一節刻意觸發致命錯誤，不能污染上面的 errors 收集。 */
console.log('\n[11j] 自組隊伍：手動指定 5 隻，計算基礎必須和推演一致');
{
  const mkm = (n) => ({sp:n, level:55, nature:'Bashful',
    ss:['Helping Speed M','Ingredient Finder M','Skill Trigger M',null,null],
    ingSet:[0,0,0], skillLv:6, ribbon:0, pin:false, ex:false, nick:''});
  const BOX = ['SALAMENCE','STEELIX','SWAMPERT','BLAZIKEN','CLEFABLE','KANGASKHAN',
               'VENUSAUR','AMPHAROS','ESPEON','GALLADE'];
  await page.evaluate((names, mk) => {
    deserialize({roster: names.map(n => JSON.parse(mk.replace('__N__', n)))});
  }, BOX, JSON.stringify(mkm('__N__')));
  await doRun(`wk.recipeScope='all'; wk.recipePick='auto'; syncWeeklyUI()`);

  /* ---- 這一節的核心：自組隊伍與推演對**同一組 5 隻**必須算出相同的數字。
     這是「計算基礎完全比照推演」唯一可執行的定義。走鐘的話兩個分頁會對同一支
     隊伍給出不同的總能量，那比沒有這個功能更糟。 ---- */
  const same = await page.evaluate(() => {
    const best = lastResults[0];
    showView('team');
    teams = [newTeam()];
    teams[0].members = best.idxs.slice();
    renderTeamsView();
    const mine = teams[0].result;
    const F = ['total','berryS','dishS','skillS','cooksCapped','rv','potEff'];
    return {
      diffs: F.filter(k => Math.abs((best[k]||0) - (mine[k]||0)) > 1e-6)
              .map(k => `${k}: ${best[k]} vs ${mine[k]}`),
      recipe: [best.recipe.n, mine.recipe.n],
      hasMp: !!mine.mp,
    };
  });
  ok('自組隊伍 = 推演（逐欄位）', same.diffs.length === 0, same.diffs.join(' | '));
  ok('自組隊伍選中的主食譜也相同', same.recipe[0] === same.recipe[1], same.recipe.join(' vs '));
  ok('自組隊伍有跑 21 餐排程', same.hasMp);

  // 順序不變：members 的排列不該影響結果（和引擎的順序不變量同一個道理）
  const ord = await page.evaluate(() => {
    const a = teams[0].result.total;
    teams[0].members = teams[0].members.slice().reverse();
    renderTeamsView();
    return [a, teams[0].result.total];
  });
  ok('members 順序不影響結果', Math.abs(ord[0] - ord[1]) < 1e-6, ord.join(' vs '));

  // 不足 5 隻不給結果 —— teamContext 的 energyTeam*5 / qE(energy/5) 都寫死 5 人
  const partial = await page.evaluate(() => {
    teams[0].members[4] = null;
    renderTeamsView();
    return {res: teams[0].result, txt: $('teamList').innerText, detail: $('teamDetail').innerText};
  });
  ok('不足 5 隻不算結果', partial.res === null);
  ok('不足 5 隻要說還差幾隻', /還差\s*1\s*隻/.test(partial.txt), partial.txt.slice(0, 60));
  ok('不足 5 隻不顯示詳情', !/本週卡比獸總能量/.test(partial.detail));

  /* ---- 選擇器 ---- */
  const pick = await page.evaluate(() => {
    teams = [newTeam()];
    teams[0].members = [0, 1, 2, null, null];
    renderTeamsView();
    const slot = $('teamList').querySelector('[data-pick="0.3"]');
    openPicker(0, 3, slot);
    const rows = [...$('pickList').querySelectorAll('[data-take]')];
    return {
      open: !$('tmPicker').hidden,
      total: rows.length,
      disabled: rows.filter(r => r.disabled).map(r => +r.dataset.take).sort((a,b)=>a-b),
    };
  });
  ok('點空位會開啟選擇器', pick.open);
  ok('同一隊已選的不能重複選', JSON.stringify(pick.disabled) === JSON.stringify([0,1,2]),
     JSON.stringify(pick.disabled));
  ok('其餘的都可以選', pick.total === 10, `列出 ${pick.total} 隻`);

  // 搜尋走共用的 monHaystack —— 暱稱與學名都要吃
  const search = await page.evaluate(() => {
    roster[7].nick = '電電';                       // AMPHAROS
    renderTeamsView();
    openPicker(0, 3, $('teamList').querySelector('[data-pick="0.3"]'));
    const hit = (q) => { pickerQ = q; renderPickerList();
      return [...$('pickList').querySelectorAll('[data-take]')].map(r => +r.dataset.take); };
    return {nick: hit('電電'), sci: hit('電龍'), none: hit('這個一定找不到')};
  });
  ok('選擇器搜得到暱稱', search.nick.length === 1 && search.nick[0] === 7, JSON.stringify(search.nick));
  ok('選擇器也搜得到學名', search.sci.includes(7), JSON.stringify(search.sci));
  ok('搜不到就是空的', search.none.length === 0);

  // 跨隊可以重複（比較兩隊通常只換 1~2 隻），同隊不行
  const cross = await page.evaluate(() => {
    pickerQ = ''; closePicker();
    teams = [newTeam(), newTeam()];
    teams[0].members = [0,1,2,3,4];
    teams[1].members = [0,1,2,3,null];
    renderTeamsView();
    openPicker(1, 4, $('teamList').querySelector('[data-pick="1.4"]'));
    const rows = [...$('pickList').querySelectorAll('[data-take]')];
    const r4 = rows.find(r => +r.dataset.take === 4);
    return {canTake4: !r4.disabled, marked: /隊伍\s*1/.test(r4.innerText)};
  });
  ok('同一隻可以同時在兩隊', cross.canTake4);
  ok('已在別隊的要標出來', cross.marked);

  /* ---- 比較列 ---- */
  const cmp = await page.evaluate(() => {
    closePicker();
    teams[1].members = [0,1,2,3,5];
    renderTeamsView();
    const t = $('teamCompare').innerText;
    return {shown: t.length > 20, hasDiff: /[+−]/.test(t), base: /差額對「隊伍 1」/.test(t),
            rows: /本週卡比獸總能量/.test(t) && /料理/.test(t) && /主技能/.test(t)};
  });
  ok('兩隊都滿才出現比較列', cmp.shown);
  ok('比較列有差額', cmp.hasDiff);
  ok('比較列寫明基準是隊伍 1', cmp.base);
  ok('比較列有四個分項', cmp.rows);
  const oneTeam = await page.evaluate(() => {
    teams = [newTeam()]; teams[0].members = [0,1,2,3,4]; teamShown = 0;
    renderTeamsView();
    return {cmp: $('teamCompare').innerText.trim(), detail: /本週卡比獸總能量/.test($('teamDetail').innerText)};
  });
  ok('只有一隊時不出現比較列', oneTeam.cmp === '', oneTeam.cmp.slice(0, 40));
  ok('只有一隊時照樣有完整詳情', oneTeam.detail);

  /* ---- 上限與刪除 ---- */
  const lim = await page.evaluate(() => {
    teams = [newTeam(), newTeam(), newTeam(), newTeam()];
    renderTeamsView();
    return {disabled: $('tmAdd').disabled, n: teams.length, max: TEAMS_MAX};
  });
  ok(`最多 ${lim.max} 支隊伍`, lim.disabled && lim.n === lim.max);

  const del = await page.evaluate(() => {
    const orig = window.confirm;
    const out = {};
    teams = [newTeam(), newTeam()];
    teams[0].members = [0,1,2,3,4];
    renderTeamsView();
    // 有成員 → 要問，按取消就不刪
    window.confirm = (m) => { out.asked = m; return false; };
    $('teamList').querySelector('[data-delteam="0"]').click();
    out.afterCancel = teams.length;
    // 空的那一隊 → 不該問
    out.asked2 = null;
    window.confirm = (m) => { out.asked2 = m; return true; };
    $('teamList').querySelector('[data-delteam="1"]').click();
    out.afterEmptyDel = teams.length;
    window.confirm = orig;
    return out;
  });
  ok('刪除有成員的隊伍要 confirm', !!del.asked, String(del.asked).slice(0, 50));
  ok('confirm 訊息寫出是哪幾隻', /・|、/.test(del.asked || '') || (del.asked || '').length > 12, del.asked);
  ok('按取消就不刪', del.afterCancel === 2);
  ok('空隊伍直接刪不打斷', del.asked2 === null && del.afterEmptyDel === 1);

  /* ---- roster 索引維護：和 monOpen 完全一樣的陷阱 ---- */
  const idx = await page.evaluate(() => {
    teams = [newTeam()];
    teams[0].members = [0, 2, 4, 6, 8];
    const before = teams[0].members.map(i => D.dex[roster[i].sp].n);
    teamsAfterDelete(2);                 // 假裝箱子刪掉了第 2 隻
    roster.splice(2, 1);
    const after = teams[0].members.map(i => i == null ? null : D.dex[roster[i].sp].n);
    return {before, after};
  });
  ok('roster 刪除後：被刪的那格清空', idx.after[1] === null, JSON.stringify(idx.after));
  ok('roster 刪除後：後面的索引跟著前移（還是同一隻）',
     idx.after[2] === idx.before[2] && idx.after[3] === idx.before[3] && idx.after[4] === idx.before[4],
     `${JSON.stringify(idx.before)} → ${JSON.stringify(idx.after)}`);

  const reset = await page.evaluate((names, mk) => {
    teams = [newTeam(), newTeam()];
    teams[0].members = [0,1,2,3,4];
    teamShown = 1;
    deserialize({roster: names.map(n => JSON.parse(mk.replace('__N__', n)))});
    return {n: teams.length, m: teams[0].members, shown: teamShown};
  }, BOX, JSON.stringify(mkm('__N__')));
  ok('整批取代 roster 要清空自組隊伍', reset.n === 1 && reset.m.every(x => x === null),
     JSON.stringify(reset));
  ok('清空時 teamShown 也要歸零', reset.shown === 0);

  /* ---- 從推演結果複製 ---- */
  const copy = await page.evaluate(() => {
    teams = [newTeam()];
    teamFromResult(0);
    const filled = teams[0].members.slice();
    teamFromResult(1);                    // 第一支已經有人 → 應該長出第二支
    return {first: filled, n: teams.length, second: teams[1].members.slice(),
            same: JSON.stringify(filled) === JSON.stringify(lastResults[0].idxs),
            second2: JSON.stringify(teams[1].members) === JSON.stringify(lastResults[1].idxs)};
  });
  ok('複製推演結果會填滿 5 格', copy.same, JSON.stringify(copy.first));
  ok('第一支有人時會長出新的一支', copy.n === 2 && copy.second2);

  /* ---- strictBerry：不擋選，但要講出來 ---- */
  const sb = await page.evaluate(() => {
    // 找一隻樹果型，然後把本週加成樹果設成別的
    const bi = roster.findIndex(m => D.dex[m.sp].sp === 'berry');
    const mine = D.dex[roster[bi].sp].b;
    const other = D.berries.map(b => b[0]).find(b => b !== mine);
    wk.fav = new Set([other]); wk.strictBerry = true;
    teams = [newTeam()];
    teams[0].members = [bi, ...roster.map((_,i)=>i).filter(i=>i!==bi).slice(0,4)];
    renderTeamsView();
    return {has: !!teams[0].result, txt: $('teamList').innerText,
            name: monName(roster[bi])};
  });
  ok('strictBerry 不擋手動選（照樣算得出結果）', sb.has);
  ok('但要講出推演不會選這組', /推演分頁.*不會選|不產本週加成樹果/.test(sb.txt), sb.txt.slice(0, 120));
  ok('而且要寫出是哪一隻', sb.txt.includes(sb.name), sb.name);

  /* ---- 食材利用率（推演與自組共用同一份）----
     這一節盯的是**診斷不能歸錯原因**。第一版的文案說「一週最多 21 餐 × 鍋容量，
     所以要先提高鍋子容量」，但實測 21 餐早就排滿、而且鍋子加到 4 倍利用率也不動 ——
     真正的原因是木桶效應（每道料理要湊齊每一味）。歸錯原因會害人去加沒用的東西。 */
  const util = await page.evaluate(() => {
    wk.fav = new Set(); wk.strictBerry = true;
    /* produced 全押在食材 0；煮掉 cnt×n，鍋子空位（potEff−cnt 每餐）再塞進去，
       真正剩下的才留在 leftover。填充是 2026-09-09 補上的機制（見 mealPlan）。 */
    const fake = (produced, cnt, n, potEff) => {
      const wIng = new Float64Array(NING), leftover = new Float64Array(NING);
      const room = Math.max(0, potEff - cnt) * n;
      const fillN = Math.max(0, Math.min(room, produced - cnt * n));
      wIng[0] = produced; leftover[0] = produced - cnt * n - fillN;
      return {wIng, potEff, mp: {plan: [{r: {cnt, n: D.recipes[0].n}, n, each: 100}],
                                 idleMeals: 0, leftover, room, fillN, fillE: fillN * 100}};
    };
    return {
      low:     ingUtilNotice(fake(1000, 10, 2, 200)),   // 煮掉 20 → 2%，鍋子放得下所有食譜
      blocked: ingUtilNotice(fake(1000, 10, 2, 20)),    // 同上，但鍋子只有 20 → 真的擋到高價食譜
      high:    ingUtilNotice(fake(1000, 45, 21, 200)),  // 煮掉 945 → 94.5%
      idle:    (() => { const f = fake(1000, 10, 2, 200); f.mp.idleMeals = 6; return ingUtilNotice(f); })(),
      none:    ingUtilNotice({wIng: new Float64Array(NING), potEff: 57, mp: null}),
    };
  });
  ok('食材大量過剩時要出聲', /食材利用率/.test(util.low), util.low.slice(0, 90));
  /* 用量要拆成兩段，否則使用者對不上：食譜指定的量 ＋ 塞進鍋子空位的量。
     使用者原本的困惑（「一週產 1393、一餐可以用 81，為什麼只煮掉 519」）就是
     因為填充那一段以前根本沒算。 */
  ok('用量要拆成「食譜指定」＋「填鍋子空位」',
     /食譜指定 \d+ ＋ 填進鍋子空位 \d+/.test(util.low), util.low.slice(0, 160));
  ok('空位塞滿時要明講', /空位也全部塞滿了/.test(util.low), util.low.slice(0, 240));
  // 診斷要可行動：填充補上之後，鍋子容量才真的是瓶頸
  ok('要給可行動的兩條路', /加大鍋子容量/.test(util.low) && /食材數較少/.test(util.low),
     util.low.slice(0, 300));
  ok('要列出剩最多的是哪幾味', /剩最多的是/.test(util.low), util.low.slice(-120));
  ok('鍋子擋到高價食譜時要另外提', /加鍋子容量對這一項也有幫助/.test(util.blocked),
     util.blocked.slice(-140));
  ok('餐數沒排滿時要講出來，並說明拌拌料理不計分',
     /餐排不進去/.test(util.idle) && /不計分/.test(util.idle), util.idle.slice(0, 160));
  ok('利用率高就不囉嗦', util.high === '');
  ok('沒有排程結果時不猜數字', util.none === '');

  // 「這隊最能煮的食譜」要指出卡在哪一味 —— rankRecipesForTeam 本來就算了 bn，只是沒顯示
  const bn = await page.evaluate(() => {
    teams = [newTeam()]; teams[0].members = lastResults[0].idxs.slice();
    renderTeamsView();
    const th = [...$('teamDetail').querySelectorAll('th')].map(e => e.innerText);
    return {hasCol: th.includes('卡在'), txt: $('teamDetail').innerText};
  });
  ok('食譜表有「卡在」欄', bn.hasCol);
  ok('「卡在」欄有填東西', /卡在/.test(bn.txt));

  // 收尾：把狀態還原，不要影響後面的節次
  await page.evaluate(() => { teams = [newTeam()]; teamShown = 0; closePicker(); showView('plan'); });
}

/* 寶可夢箱的四顆動作鈕。兩件事：
   ①「＋隊」把箱子裡的一隻直接放進**目前顯示的那一支**自組隊伍 —— 找寶可夢的地方
     本來就是箱子（有篩選、排序、資質%），所以「看到就順手放進去」該少三步。
   ② 圖示不能撞：`✕` 是「從推演中排除」（可逆），刪除是 `🗑`（不可逆）。原本
     排除用 `○`，而 `○` 在中文慣例裡是「可以」，掛在一顆叫「排除」的按鈕上意思正好相反。 */
console.log('\n[11k] 寶可夢箱：「＋隊」直接加進自組隊伍，以及按鈕圖示不能撞');
{
  const r = await page.evaluate(() => {
    const mk = (n) => ({sp:n, level:60, nature:'Bashful', ss:[null,null,null,null,null],
                        ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false});
    deserialize({roster: ['RAICHU','SLOWKING','VICTREEBEL','GENGAR','ESPEON','SUDOWOODO'].map(mk)});
    teams = [newTeam()]; teamShown = 0;
    clearBoxFilter(); $('fltSort').value = 'added';
    $('fltSort').dispatchEvent(new Event('change', {bubbles:true}));
    monOpen.clear(); renderBox();
    const btn = (i, a) => $('boxList').querySelector(`[data-i="${i}"] [data-act="${a}"]`);

    /* 圖示：排除是 ✕（可逆的切換）、刪除是 🗑（不可逆）。兩顆長一樣就是在請人按錯。 */
    const icons = {ex: btn(0,'ex').textContent.trim(), del: btn(0,'del').textContent.trim(),
                   delTitle: btn(0,'del').title,
                   danger: btn(0,'del').classList.contains('danger')};
    // 排除中的狀態要看得出來（🚫），而且 title 要說得出怎麼放回去
    roster[0].ex = true; renderBox();
    const exOn = {icon: btn(0,'ex').textContent.trim(), title: btn(0,'ex').title};
    roster[0].ex = false; renderBox();

    // ＋隊：放進 teamShown 的第一個空格
    const t0 = btn(1,'team').title;
    btn(1,'team').click();
    const add1 = {members: teams[0].members.slice(), status: $('saveStatus').textContent,
                  on: btn(1,'team').classList.contains('on'), title: btn(1,'team').title};
    // 同一隻再按一次：不能塞進第二格
    btn(1,'team').click();
    const again = {members: teams[0].members.slice(), status: $('saveStatus').textContent};

    // 補滿到 5 隻，第 6 隻要被擋下來並說清楚
    [0,2,3,4].forEach(i => btn(i,'team').click());
    const full = {members: teams[0].members.slice(), status: $('saveStatus').textContent};
    btn(5,'team').click();
    const over = {members: teams[0].members.slice(), status: $('saveStatus').textContent,
                  n: teams[0].members.filter(x => x != null).length};

    /* 目標是 `teamShown`，不是「隨便找一支空的」—— 逐隻放的時候，一隻進 A、
       下一隻跳到 B 就根本組不起來。切到隊伍 2 之後才該進隊伍 2。 */
    teams.push(newTeam()); teamShown = 1; renderBox();
    const t2title = btn(5,'team').title;
    btn(5,'team').click();
    const second = {t1: teams[0].members.slice(), t2: teams[1].members.slice(),
                    status: $('saveStatus').textContent};
    // 跨隊重複是允許的（比較兩隊通常只換 1~2 隻），按鈕要列出牠在哪幾支
    btn(1,'team').click();
    const cross = {t2: teams[1].members.slice(), title: btn(1,'team').title};

    // 自組隊伍不進 serialize()（純檢視狀態）—— ＋隊不能把它寫進去
    const ser = JSON.stringify(serialize());
    teams = [newTeam()]; teamShown = 0; closePicker(); showView('plan');
    return {icons, exOn, t0, add1, again, full, over, t2title, second, cross,
            serHasTeams: /"teams"/.test(ser)};
  });
  ok('「從推演中排除」是 ✕（原本的 ○ 在中文慣例裡是「可以」，意思正好相反）',
     r.icons.ex === '✕', `「${r.icons.ex}」`);
  ok('排除中改顯示 🚫，而且 title 說得出怎麼放回去',
     r.exOn.icon === '🚫' && /放回候選/.test(r.exOn.title), `「${r.exOn.icon}」 ${r.exOn.title}`);
  /* 不可逆的動作不該和可逆的長得一樣 —— 這是「刪除一定要 confirm」之外的第二層防線。 */
  ok('刪除改用 🗑，和旁邊三顆可逆的切換分得開',
     r.icons.del === '🗑' && r.icons.del !== r.icons.ex && r.icons.danger,
     `${r.icons.del} / danger=${r.icons.danger}`);
  ok('title 要說出刪除沒有復原', /沒有復原/.test(r.icons.delTitle), r.icons.delTitle);

  ok('＋隊的 title 寫出目標是哪一支隊伍（畫面上可能同時有 4 支）',
     /隊伍 1/.test(r.t0), r.t0);
  ok('＋隊放進第一個空格', r.add1.members.join(',') === '1,,,,', r.add1.members.join(','));
  ok('加進去要出聲，訊息帶名字與格號',
     /隊伍 1/.test(r.add1.status) && /第 1 格/.test(r.add1.status) && /還差 4 隻/.test(r.add1.status),
     r.add1.status);
  /* 按下去有沒有生效，不該要切分頁才看得到。 */
  ok('已經在隊伍裡的那一隻按鈕會點亮，title 也列出隊號',
     r.add1.on && /目前在隊伍 1/.test(r.add1.title), `on=${r.add1.on} ${r.add1.title}`);
  /* 同一隻放進同一隊兩次會讓 Helper Boost 的物種計數、流星群的龍屬性種類數全部算錯。 */
  ok('同隊不可重複：再按一次不會塞進第二格，而且要說明原因',
     r.again.members.join(',') === '1,,,,' && /已經在隊伍 1/.test(r.again.status),
     `${r.again.members.join(',')} / ${r.again.status}`);
  ok('補到 5 隻', r.full.members.filter(x => x != null).length === 5, r.full.members.join(','));
  ok('滿 5 隻時說「滿了」而不是靜靜地什麼都沒發生',
     r.over.n === 5 && /滿 5 隻/.test(r.over.status), `${r.over.n} / ${r.over.status}`);
  ok('目標是「目前顯示的那一支」，不是隨便找一支空的',
     /隊伍 2/.test(r.t2title) && r.second.t1.filter(x => x != null).length === 5 &&
     r.second.t2.join(',') === '5,,,,', `${r.t2title} | t2=${r.second.t2.join(',')}`);
  ok('跨隊重複是允許的，按鈕要列出牠在哪幾支',
     r.cross.t2.join(',') === '5,1,,,' && /目前在隊伍 1、2/.test(r.cross.title),
     `${r.cross.t2.join(',')} | ${r.cross.title}`);
  /* 自組隊伍和 monOpen / boxFlt 同待遇：切分頁保留、重新整理清空。 */
  ok('＋隊不會把自組隊伍寫進 serialize()（純檢視狀態）', r.serHasTeams === false);
}

/* 三個投資數字，各對應一種資源 —— 而且**必須彼此獨立**：
     練滿   → 等級糖果先餵誰（絕對值，同專長內比）
     資質   → 這一隻是不是好貨（比值，同物種內比）
     技能   → 技能糖果先給誰（能量/日，全體比）
   這一節最重要的一條是「資質不受緞帶／主技能等級影響」：以前分子沒有規範化那兩樣，
   於是同一份資質會**因為還沒練而顯示低分**（實測妙蛙花 51% vs 78%），使用者照著
   排序略過低分的，剛好略過最該投資的那幾隻（使用者 2026-09-10 反映）。 */
console.log('\n[11L] 寶可夢箱：練滿／資質／技能成長是三個獨立的數字');
{
  const r = await page.evaluate(() => {
    const mk = (n, o) => ({sp:n, level:60, nature:'Adamant',
      ss:['Helping Speed M','Ingredient Finder M','Helping Bonus',null,null],
      ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false, nick:'', ...(o||{})});
    /* 0 與 1 是**同一份資質**，只差「練得起來的東西」（緞帶 0→4、技能 Lv1→滿級）。 */
    deserialize({roster: [
      mk('VENUSAUR'),
      mk('VENUSAUR', {ribbon:4}),
      mk('RAICHU'),
      mk('GENGAR', {level:30}),
    ]});
    /* 滿級**從資料查**，不要寫死 —— 妙蛙花的食材獲取S 上限是 7 而不是 6，
       硬寫 6 會讓「技能滿級」那一條靜靜地測不到它想測的東西。 */
    roster[1].skillLv = (D.ms[D.dex[roster[1].sp].ms] || {max: 6}).max;
    showView('box'); clearBoxFilter(); monOpen.clear();
    $('fltSort').value = 'added'; $('fltSort').dispatchEvent(new Event('change', {bubbles:true}));
    roster.forEach(m => idealOf(m, true));
    renderBox();
    const cell = (i, cls) => {
      const e = $('boxList').querySelector(`[data-i="${i}"] .${cls}`);
      return e ? e.textContent.trim() : null;
    };
    const idl  = roster.map((_, i) => cell(i, 'mon-idl'));
    const full = roster.map((_, i) => cell(i, 'mon-full'));
    const room = roster.map((_, i) => cell(i, 'mon-room'));
    const pcts = roster.map(m => idealPct(m));
    const ideals = roster.map(m => idealOf(m));
    /* 「練滿」是絕對值，必須 >= 當前產能（等級／緞帶／技能只會往上推，不會往下）。 */
    const grow = roster.map((m, i) => fullMain(ideals[i]) >= powerMain(monPowerCached(m)) - 1e-9);
    // 技能已滿級的那一隻：技能成長 = 0，而且要寫成「技能滿級」而不是 +0
    const maxed = {room: skillRoom(ideals[1]), text: room[1]};
    const fire = (id, ev) => $(id).dispatchEvent(new Event(ev, {bubbles:true}));
    const order = () => [...$('boxList').querySelectorAll('[data-i]')].map(e => +e.dataset.i);
    $('fltSort').value = 'full'; fire('fltSort', 'change');
    const byFull = order(), fullDir = $('fltDir').textContent, fullWhat = $('boxCount').textContent;
    $('fltSort').value = 'skillRoom'; fire('fltSort', 'change');
    const byRoom = order(), roomVals = byRoom.map(i => skillRoom(ideals[i]));
    const roomDir = $('fltDir').textContent;
    const optTexts = [...$('fltSort').options].map(o => o.text);
    $('fltSort').value = 'added'; fire('fltSort', 'change');
    clearBoxFilter(); renderBox();
    return {idl, full, room, pcts, grow, maxed, byFull, byRoom, roomVals,
            fullDir, roomDir, fullWhat, optTexts,
            sum: $('scoreNote').querySelector('.sum').textContent.trim()};
  });
  /* 這是整組改動的核心：資質量的是**改不掉的東西**，所以「還沒練」不能壓低它。 */
  ok('資質不受緞帶與主技能等級影響（同一份性格／副技能 → 同一個 %）',
     r.pcts[0] === r.pcts[1] && r.pcts[0] > 0, `緞帶0技Lv1 ${r.pcts[0]}% vs 緞帶4技滿 ${r.pcts[1]}%`);
  ok('摺疊列每一隻都有「資質 N%」', r.idl.every(t => t && /資質\s*≥?\d+%/.test(t)), r.idl.join(' | '));
  ok('摺疊列每一隻都有「練滿」的絕對值', r.full.every(t => t && /練滿\s*[\d,]+/.test(t)), r.full.join(' | '));
  /* 練滿 >= 現在 —— 等級／緞帶／技能等級都只會往上推。低於當前產能就是算錯了。 */
  ok('「練滿」一定 >= 目前的產能', r.grow.every(Boolean), r.grow.join(','));
  ok('技能還沒滿的顯示「技能 +N」', /技能\s*\+[\d,]+/.test(r.room[0] || ''), String(r.room[0]));
  /* 靜靜地顯示 +0 會讓人以為還有空間；藏起來又會被當成還沒算完。 */
  ok('技能已滿級的寫「技能滿級」而不是 +0',
     r.maxed.room === 0 && /技能滿級/.test(r.maxed.text || ''), `${r.maxed.room} / ${r.maxed.text}`);
  /* SPEC_ORD 是 ['berry','ingredient','skill','all']，所以樹果（雷丘 i=2）排最前面，
     再是三隻食材型依練滿由高到低：妙蛙花 15464（i=0、i=1 同值，靠 tie-break 回到
     加入順序）、耿鬼 9569（i=3）。 */
  ok('「練滿」排序：先分專長、再組內高→低（＝等級糖果先餵誰）',
     r.byFull.join(',') === '2,0,1,3', r.byFull.join(','));
  ok('「技能成長」排序可以跨專長（技能糖果是同一種資源）',
     r.roomVals.join(',') === [...r.roomVals].sort((a,b)=>b-a).join(','), r.roomVals.join(', '));
  ok('兩個新排序的方向都寫在按鈕上',
     /練滿高→低/.test(r.fullDir) && /技能成長高→低/.test(r.roomDir), `${r.fullDir} / ${r.roomDir}`);
  /* 三個數字回答三個不同的問題，混著讀就會用錯軸做投資決定 —— 所以每個排序都要
     在 boxCount 上寫出它排的是什麼、可比範圍到哪。 */
  ok('排序時 boxCount 寫出這個名次能怎麼讀',
     /等級糖果先餵誰/.test(r.fullWhat) && /同專長內比/.test(r.fullWhat), r.fullWhat);
  ok('排序選單本身仍然不寫方向', !r.optTexts.some(t => /高→低|低→高/.test(t)), r.optTexts.join(' | '));
  /* 摘要那一行要獨力講完三個數字各答哪個問題 —— 少了它，介面就是在請人用錯的軸。 */
  ok('摘要寫出三個數字各答哪個問題',
     /練滿/.test(r.sum) && /資質/.test(r.sum) && /技能/.test(r.sum) &&
     /同專長內/.test(r.sum) && /同物種內/.test(r.sum), r.sum);
}

/* 「回自己活力」只有牠自己拿得到。以前這一份被併進 `energyGiven`，再由 teamContext
   `/5` 攤給全隊 —— 持有者少拿 4/5、另外四隻白拿。因為 `energyF` 是階梯函數，
   「集中給一個人」和「攤平給五個人」差非常多：實測持有者的幫忙次數低估 31%。
   這和夢魘的扣活力是同一條規則（CLAUDE.md 陷阱 6c）：**只有某些人拿到的量，
   不可以走 `ctx.supportEnergy` 那條共用管道。** */
console.log('\n[11m] 引擎：主技能「回自己活力」不可以攤給全隊');
{
  const r = await page.evaluate(() => {
    const wk = {fav:new Set(), camp:false, sleepH:8.5, collectH:4, strictBerry:false, recipeLevels:{}};
    const mk = n => {
      const sp = D.dex.findIndex(p => p.n === n);
      const m = {sp, level:60, nature:'Bashful', ss:[null,null,null,null,null],
                 ingSet:[0,0,0], skillLv:6, ribbon:4};
      m._bs = baseStats(m, wk); return m;
    };
    // 大食花 ＝ 活力填充S（只回自己）。其餘四隻不帶任何活力技能。
    const team = ['VICTREEBEL','RAICHU','GENGAR','ESPEON','SUDOWOODO'].map(mk);
    const ctx = teamContext([0,1,2,3,4], team, wk, new Map());
    const out = team.map(m => memberOutput(m, wk, ctx));
    /* 對照組：把持有者換掉，隊友的產出必須**完全不變** —— 變了就代表自回活力
       又漏進共用管道了。 */
    const team2 = ['SUDOWOODO','RAICHU','GENGAR','ESPEON','SUDOWOODO'].map(mk);
    const ctx2 = teamContext([0,1,2,3,4], team2, wk, new Map());
    const mate2 = [1,2,3].map(i => memberOutput(team2[i], wk, ctx2).sim.procs);
    const solo = memberOutput(team[0], wk, SCORE_CTX);
    const pay = skillPayload(team[0]._bs.p.ms, team[0]._bs.skillLv);
    return {
      holderSelf: out[0].energySelfGiven, holderTeam: out[0].energyGiven,
      mateSelf: [1,2,3,4].map(i => out[i].energySelfGiven),
      support: ctx.supportEnergy,
      mateProcs: [1,2,3].map(i => out[i].sim.procs), mate2,
      hasEnergy: !!pay.energySelf,
      soloHelps: solo.sim.helpsDay + solo.sim.helpsNight,
      soloSelf: solo.energySelfGiven,
    };
  });
  ok('活力填充S 的自回活力算在 energySelfGiven，不在 energyGiven',
     r.hasEnergy && r.holderSelf > 0 && r.holderTeam === 0,
     `self=${r.holderSelf.toFixed(2)} team=${r.holderTeam}`);
  ok('不帶活力技能的隊友 energySelfGiven 都是 0', r.mateSelf.every(v => v === 0), r.mateSelf.join(','));
  /* 這一條就是那個 bug 的正面：自回活力不可以變成全隊的 supportEnergy。 */
  ok('隊上只有「回自己」的技能時，共用的 supportEnergy 必須是 0', r.support === 0, String(r.support));
  ok('把持有者換掉，隊友的技能發動次數完全不變（＝牠們本來就沒拿到那份活力）',
     r.mateProcs.every((v, i) => Math.abs(v - r.mate2[i]) < 1e-9),
     `${r.mateProcs.map(v=>v.toFixed(4)).join(',')} vs ${r.mate2.map(v=>v.toFixed(4)).join(',')}`);
  /* 單獨一隻也要收得到 —— 個體產能（寶可夢箱）用的就是這個情境。 */
  ok('單獨一隻時自己也收得到（寶可夢箱的個體產能就是這個情境）',
     r.soloSelf > 0 && r.soloHelps > 0, `自回 ${r.soloSelf.toFixed(1)}／日，幫忙 ${r.soloHelps.toFixed(1)} 次/日`);
}

/* 「為什麼選這一隻」只放得下三句，所以**挑哪三句**本身就是一個會說謊的地方。
   規則：一句話在卡片上「還有沒有別的地方看得到」——看不到的優先。
   實際踩過：純補師的卡片留下「食材 佔這隊食材的 9%」，而「每日補活力 每隻 90」
   （牠入選的唯一理由，實測值 +18.9%）排在第 4 被砍掉。 */
console.log('\n[11n] 結果卡：三句話要挑對，代價不准被擠掉');
{
  const r = await page.evaluate(() => {
    const mk = (n, ss, sk) => ({sp:n, level:60, nature:'Bashful',
      ss:[...ss, ...Array(5-ss.length).fill(null)],
      ingSet:[0,0,0], skillLv:sk, ribbon:4, pin:false, ex:false, nick:''});
    /* 胖可丁＝活力全體療癒S（補師）、達克萊伊＝夢魘（有代價）。
       兩隻都刻意帶「幫忙加成」，讓靜態標籤把三格塞滿 —— 舊排序下
       補活力與代價都會被擠掉，這一節就是要擋住那件事。 */
    deserialize({roster: [
      mk('WIGGLYTUFF', ['Helping Bonus','Skill Trigger M','Skill Trigger S'], 6),
      mk('DARKRAI',    ['Helping Bonus','Skill Trigger M','Skill Trigger S'], 6),
      mk('RAICHU',     ['Helping Bonus','Helping Speed M','Skill Trigger M'], 4),
      mk('VENUSAUR',   ['Helping Bonus','Helping Speed M','Skill Trigger M'], 4),
      mk('GENGAR',     ['Helping Bonus','Helping Speed M','Skill Trigger M'], 4),
    ]});
    // 讓每一隻都吃到「產本週加成樹果」那個靜態標籤，把三格塞得更滿
    wk.fav = new Set(roster.map(m => D.dex[m.sp].b));
    buildPool(wk);
    roster.forEach(m => { m._bs = baseStats(m, wk); });
    const r0 = scoreTeam([0,1,2,3,4], roster, wk, new Map());
    const res = finalizeTeams([r0], roster, wk, 1)[0];
    const whys = [0,1,2,3,4].map(k => pickReason(k, res));
    const at = n => res.idxs.findIndex(i => D.dex[roster[i].sp].n === n);
    return {whys,
      wig: whys[at('WIGGLYTUFF')], dark: whys[at('DARKRAI')],
      plain: whys[at('RAICHU')],
      giving: res.outs.map(o => +o.energyGiven.toFixed(1)),
      drain: res.outs.map(o => +o.energyDrain.toFixed(1))};
  });
  /* 補師的整張卡片上，只有這一句說得出「是誰供的活力」—— 底下那排 pill 只有整隊合計。 */
  ok('補師的「每日補活力」不准被靜態標籤擠掉',
     /每日補活力/.test(r.wig), r.wig);
  ok('而且要標「每隻」（和 pill 同單位）', /每隻/.test(r.wig), r.wig);
  /* 只講好處就是選擇性呈現 —— 代價不佔那三格，另外接在後面。 */
  ok('夢魘的「代價」不准被擠掉', /代價/.test(r.dark) && /扣非惡屬性隊友活力/.test(r.dark), r.dark);
  ok('沒有隊伍效果的那幾隻照樣講得出自己的主要產出',
     /佔這隊.{1,3}的 \d+%/.test(r.plain), r.plain);
  /* 句數上限：三句（有代價時是兩句＋代價）。多了會把卡片撐開。 */
  ok('每一句都不超過四段（三句，或兩句＋代價）',
     r.whys.every(w => w.split('　·　').length <= 3), r.whys.map(w=>w.split('　·　').length).join(','));
  ok('補師確實有在發活力、夢魘確實有在扣',
     r.giving.some(v => v > 0) && r.drain.some(v => v < 0),
     `發 ${r.giving.join(',')} / 扣 ${r.drain.join(',')}`);
}

/* 食譜要「解鎖」才煮得出來（使用者 2026-09-10）。
   **單一真實來源：`wk.recipeLevels[name]` 的有無就是解鎖狀態**，沒有第二份停用清單。
   這是候選過濾，所以陷阱 4 的三條配套都要測：排除的道數看得見、一道都沒有時要出聲、
   「指定食譜」的選單不能列出煮不出來的。 */
console.log('\n[11p] 食譜等級：沒解鎖的完全不列入推演');
{
  const r = await page.evaluate(() => {
    const names = D.recipes.slice(0, 4).map(x => x.n);
    wk.recipeLevels = {}; wk.recipeScope = 'all'; wk.recipeLv = 25;
    // ① 一道都沒解鎖：池子必須是空的，而且不能炸
    buildPool(wk);
    const none = {pool: POOL.length, on: recipesOn(wk)};
    // ② 設了等級的才進池子
    wk.recipeLevels = {[names[0]]: 30, [names[1]]: 10};
    buildPool(wk);
    const some = {pool: POOL.length, names: POOL.map(c => c.r.n).sort(),
                  lv: POOL.map(c => [c.r.n, c.lv]).sort()};
    // ③ 等級是 0／負數／非數字都不算解鎖（舊資料可能有髒值）
    wk.recipeLevels = {[names[0]]: 0, [names[1]]: -3, [names[2]]: '20', [names[3]]: null};
    buildPool(wk);
    const dirty = {pool: POOL.length, on: recipesOn(wk)};

    // ④ UI：解鎖鈕就是在寫 recipeLevels，沒有第二份狀態
    wk.recipeLevels = {}; save();
    showView('recipes'); $('rlvType').value = 'all'; $('rlvSearch').value = '';
    renderRecipeLevels();
    const rowOf = n => $('rlvBody').querySelector(`[data-r="${n}"]`);
    const togOf = n => rowOf(n).querySelector('[data-tog]');
    const offRow = {cls: rowOf(names[0]).className,
                    btn: togOf(names[0]).textContent.trim(),
                    inputDisabled: rowOf(names[0]).querySelector('[data-rlv]').disabled};
    const noneWarn = $('rlvNone').hidden === false;
    const countTxt = $('rlvCount').textContent;
    togOf(names[0]).click();                       // 解鎖 → 填入預設等級
    const afterOn = {lv: wk.recipeLevels[names[0]],
                     btn: togOf(names[0]).textContent.trim(),
                     cls: rowOf(names[0]).className,
                     warnHidden: $('rlvNone').hidden,
                     count: $('rlvCount').textContent};
    togOf(names[0]).click();                       // 再點一次 → 鎖上，等級一起清掉
    const afterOff = {has: names[0] in wk.recipeLevels, on: recipesOn(wk)};

    // ⑤ 「指定食譜」的選單只列已解鎖的
    wk.recipeLevels = {}; wk.dishType = D.recipes[0].t; fillRecipes();
    const emptyPicker = [...$('recipe').options].map(o => o.value);
    const curry = D.recipes.filter(x => x.t === wk.dishType).slice(0, 2).map(x => x.n);
    wk.recipeLevels = {[curry[0]]: 20, [curry[1]]: 20}; fillRecipes();
    const picker = [...$('recipe').options].map(o => o.value).sort();

    wk.recipeLevels = {}; save(); showView('plan');
    return {none, some, dirty, offRow, noneWarn, countTxt, afterOn, afterOff,
            emptyPicker, picker, want: curry.slice().sort(), n0: names[0],
            total: D.recipes.length};
  });
  ok('一道都沒解鎖 → 池子是空的（不是退回預設等級全開）',
     r.none.pool === 0 && r.none.on === 0, JSON.stringify(r.none));
  ok('有設等級的才進池子，而且等級就是設的那個',
     r.some.pool === 2 && r.some.lv.every(([, v]) => v === 30 || v === 10),
     JSON.stringify(r.some));
  /* 舊資料可能有 0／負數／字串 —— 那些都不是「已解鎖」，不能靜靜地當成 Lv1。 */
  ok('0／負數／字串／null 都不算解鎖', r.dirty.pool === 0 && r.dirty.on === 0,
     JSON.stringify(r.dirty));
  /* 藏起來就看不出「為什麼它沒被算」，顯示成正常數字又是說謊 —— 所以變淡但照樣列。 */
  ok('沒解鎖的那一列變淡、按鈕寫「鎖上」、等級欄不能填',
     /rlv-off/.test(r.offRow.cls) && /鎖上/.test(r.offRow.btn) && r.offRow.inputDisabled === true,
     JSON.stringify(r.offRow));
  /* 一道都沒解鎖 ＝ 料理必然 0 分。那是懸崖，不可以靜靜地發生。 */
  ok('一道都沒解鎖時要跳警告', r.noneWarn === true, String(r.noneWarn));
  ok('解鎖道數要寫出來（N / 全部）',
     new RegExp(`已解鎖 0 / ${r.total}`).test(r.countTxt), r.countTxt);
  ok('按「解鎖」= 填入預設等級，按鈕與列同時變狀態',
     r.afterOn.lv === 25 && /已解鎖/.test(r.afterOn.btn) && !/rlv-off/.test(r.afterOn.cls) &&
     r.afterOn.warnHidden === true && /已解鎖 1 /.test(r.afterOn.count),
     JSON.stringify(r.afterOn));
  /* 等級的有無就是解鎖狀態 —— 鎖上必須把 key 刪掉，留著就是第二份狀態。 */
  ok('再按一次 = 鎖上，等級一起清掉（沒有第二份狀態）',
     r.afterOff.has === false && r.afterOff.on === 0, JSON.stringify(r.afterOff));
  /* 選得到卻煮不出來就是自相矛盾。 */
  ok('「指定食譜」的選單只列已解鎖的',
     r.picker.join(',') === r.want.join(','), `${r.picker.join(',')} vs ${r.want.join(',')}`);
  ok('一道都沒解鎖時選單要說出來，而不是列一堆煮不出來的',
     r.emptyPicker.length === 1 && r.emptyPicker[0] === '', JSON.stringify(r.emptyPicker));
  /* 改成「沒填＝沒解鎖」之後，一個字串髒值的後果從「等級不準」變成「那道菜整個
     不見」—— 所以入口要正規化。舊 JSON／Sheet 都可能帶字串進來。 */
  const rv = await page.evaluate(() => {
    const n = D.recipes[0].n, m = D.recipes[1].n, z = D.recipes[2].n;
    deserialize({wk: {recipeLevels: {[n]: '35', [m]: 0, [z]: 'abc'}}});
    const got = {...wk.recipeLevels};
    wk.recipeLevels = {}; save();
    return {got, keys: Object.keys(got), n};
  });
  ok('反序列化把數字字串救回來，0／非數字則丟掉（不然那道菜會靜靜消失）',
     rv.keys.length === 1 && rv.got[rv.n] === 35, JSON.stringify(rv.got));
}

console.log('\n[11q] 收取間隔：每一隻多久滿包、整隊多久該上去一次');
{
  /* ---- 引擎：**兩個**天花板都要算（背包、主技能存滿），而且都不可以跟著
     「你設定多久收一次」跑 —— 那會變成自己追自己的尾巴。 ---- */
  const e = await page.evaluate(() => {
    const CTX = {nHB:0, nERB:0, supportEnergy:0, extraHelps:0, hbRows:{}, darkDrain:0};
    const one = (n, over, rib) => {
      const w = {...wk, ...over};
      const m = {sp: D.dex.findIndex(p => p.n === n), level: 60, nature: 'Bashful',
        ss: ['Helping Speed M','Ingredient Finder M','Skill Trigger M',null,null],
        ingSet: [0,0,0], skillLv: 6, ribbon: rib == null ? 4 : rib, pin: false, ex: false, nick: ''};
      m._bs = baseStats(m, w);
      const bs = m._bs, sim = memberOutput(m, w, CTX).sim;
      return {fillH: sim.fillH, skillH: sim.skillH, helpsDay: sim.helpsDay,
              carry: bs.carry, eff: bs.effSkill, spec: bs.p.sp,
              drop: (1-bs.ingChance)*bs.berriesPerDrop + bs.ingChance*bs.avgIngAmt,
              wakeH: (1440 - Math.round(w.sleepH*60)) / 60};
    };
    return {
      g4:  one('GOLDUCK',  {collectH: 4,   sleepH: 8.5}),
      g6:  one('GOLDUCK',  {collectH: 6,   sleepH: 8.5}),
      g0:  one('GOLDUCK',  {collectH: 0,   sleepH: 8.5}),
      dk:  one('DARKRAI',  {collectH: 4,   sleepH: 8.5}),
      r0:  one('RAICHU',   {collectH: 4,   sleepH: 8.5}, 0),
      r4:  one('RAICHU',   {collectH: 4,   sleepH: 8.5}, 4),
    };
  });
  /* 定義本身要被釘住：**白天**的平均速度（不是含夜間的全日速度）—— 夜間那一段
     沒辦法中途收，它的損失走 nightSnack，不該混進「多久該上線」。 */
  const want = s => (s.carry / s.drop) / (s.helpsDay / s.wakeH);
  ok('背包裝滿的時間 = 裝滿要幾次幫忙 ÷ 白天每小時幫忙幾次',
     Math.abs(e.g4.fillH - want(e.g4)) < 1e-9 && Math.abs(e.r4.fillH - want(e.r4)) < 1e-9,
     `${e.g4.fillH} vs ${want(e.g4)}`);
  /* 這是「這一隻能撐多久」，不是「你設定收多久」的函數。跟著設定跑的話，
     使用者一調設定建議就跟著動，那個建議就沒有意義了。 */
  ok('滿包／存滿的時間不隨 wk.collectH 改變',
     Math.abs(e.g4.fillH - e.g6.fillH) < 1e-9 && Math.abs(e.g4.fillH - e.g0.fillH) < 1e-9 &&
     Math.abs(e.g4.skillH - e.g6.skillH) < 1e-9,
     JSON.stringify([e.g4.fillH, e.g6.fillH, e.g0.fillH]));
  /* 陷阱 6e 的那個偏差就長在這裡：高頻技能型的主技能遠早於背包就存滿，
     只顯示背包時間會讓那段時間看起來什麼都沒漏。 */
  ok('技能專長最多存 2 次，換算成時間就是 skillH',
     e.g4.spec === 'skill' &&
     Math.abs(e.g4.skillH - (2 / e.g4.eff) / (e.g4.helpsDay / e.g4.wakeH)) < 1e-9,
     JSON.stringify([e.g4.skillH, e.g4.eff]));
  ok('高頻技能型（哥達鴨）先存滿技能，不是先滿背包',
     e.g4.skillH < e.g4.fillH, `skill ${e.g4.skillH} vs fill ${e.g4.fillH}`);
  ok('低頻的（達克萊伊）反過來，先滿的是背包',
     e.dk.fillH < e.dk.skillH, `fill ${e.dk.fillH} vs skill ${e.dk.skillH}`);
  ok('持有上限越大就撐越久（緞帶 4 vs 0）',
     e.r4.carry > e.r0.carry && e.r4.fillH > e.r0.fillH,
     `${e.r0.carry}/${e.r0.fillH} vs ${e.r4.carry}/${e.r4.fillH}`);

  /* ---- 滿包之後到底發生什麼（2026-09-10 查證，來源見 engine.js 的註解）。
     這三條**都很容易被當成 bug 順手改掉**，所以直接釘住：
       ① 樹果機率 100% → `snack*berriesPerDrop` 刻意不乘 `(1-ingChance)`
       ② 食材機率 0%   → `ing` 只吃 `productive`
       ③ 技能抽選不做 → `procs` 用 `normal` 而不是 `h` ---- */
  const full = await page.evaluate(() => {
    const CTX = {nHB:0, nERB:0, supportEnergy:0, extraHelps:0, hbRows:{}, darkDrain:0};
    const w = {...wk, collectH: 8, sleepH: 8.5};
    return ['VICTREEBEL', 'GENGAR'].map(n => {
      const m = {sp: D.dex.findIndex(p => p.n === n), level: 60, nature: 'Bashful',
        ss: ['Helping Speed M','Ingredient Finder M','Skill Trigger M',null,null],
        ingSet: [0,0,0], skillLv: 6, ribbon: 0, pin: false, ex: false, nick: ''};
      m._bs = baseStats(m, w);
      const bs = m._bs, o = memberOutput(m, w, CTX), s = o.sim;
      return {n, snack: s.snack, berries: s.berries,
              berriesNoSnack: s.productive*(1-bs.ingChance)*bs.berriesPerDrop,
              drop: bs.berriesPerDrop, magnet: !!o.pay.ingSpread,
              ing: o.ing.reduce((a, b) => a + b, 0),
              ingFromProductive: s.productive*bs.ingChance*bs.ingVec.reduce((a, b) => a + b, 0),
              procs: s.procs, prodEff: s.productive*bs.effSkill,
              allEff: (s.helpsDay + s.helpsNight)*bs.effSkill};
    });
  });
  ok('測到的確有滿包（不然下面三條是空的）', full.every(x => x.snack > 1),
     JSON.stringify(full.map(x => [x.n, x.snack])));
  /* 「食材掉落發動確定不會有能量嗎」→ 會。滿包的幫忙 100% 變成樹果，自動餵給卡比獸。
     所以那一項**刻意不乘 `(1-ingChance)`** —— 看起來像漏寫，改掉就錯了。 */
  ok('滿包之後的幫忙仍然產樹果（100%，不是按食材機率打折）',
     full.every(x => Math.abs((x.berries - x.berriesNoSnack) - x.snack*x.drop) < 1e-9),
     JSON.stringify(full.map(x => [x.n, x.berries - x.berriesNoSnack, x.snack*x.drop])));
  ok('滿包之後拿不到食材（`ing` 只吃 productive）',
     full.every(x => x.magnet || Math.abs(x.ing - x.ingFromProductive) < 1e-9),
     JSON.stringify(full.map(x => [x.n, x.ing, x.ingFromProductive])));
  /* `procs` 若改成吃 `h`（含滿包那些），這條就會破 —— 那正是要擋的那個改動。 */
  ok('滿包之後不做技能抽選（procs 不吃 snack 那幾次）',
     full.every(x => x.procs <= x.prodEff + 1e-9 && x.procs < x.allEff - 1e-6),
     JSON.stringify(full.map(x => [x.n, x.procs, x.prodEff, x.allEff])));

  /* ---- UI：成員卡回答「這一隻能撐多久」，pill 回答「那我到底該多久上去一次」。
     只給前者的話，使用者還得自己去把最小值找出來。 ---- */
  await page.evaluate((names, mk) => {
    deserialize({roster: names.map(n => JSON.parse(mk.replace('__N__', n)))});
  }, ['GOLDUCK','KANGASKHAN','VENUSAUR','AMPHAROS','ESPEON','RAICHU','GALLADE'],
     JSON.stringify({sp:'__N__', level:55, nature:'Bashful',
       ss:['Helping Speed M','Ingredient Finder M','Skill Trigger M',null,null],
       ingSet:[0,0,0], skillLv:6, ribbon:0, pin:false, ex:false, nick:''}));
  await doRun(`wk.collectH = 4; wk.recipeLevels = {}; D.recipes.forEach(r => wk.recipeLevels[r.n] = 20);
               wk.recipeScope = 'all'; wk.recipePick = 'auto'; syncWeeklyUI()`);
  const u = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#results .mem .out')]
      .map(x => x.innerText.replace(/\s+/g, ' '));
    const pill = [...document.querySelectorAll('#results .pillrow .pill')]
      .map(x => x.textContent.trim()).find(t => /建議收取間隔/.test(t));
    const r = lastResults[0];
    const cap = r.outs.map(o => Math.min(o.sim.fillH, o.sim.skillH));
    /* 自組隊伍共用同一個渲染器（teamDetailHTML）—— 兩邊各寫一份就一定會走鐘。 */
    showView('team'); teams = [newTeam()];
    teams[0].members = r.idxs.slice(); renderTeamsView();
    const t = $('teamDetail').innerText;
    showView('plan');
    return {rows, pill, wantMin: durH(Math.min(...cap)), n: r.idxs.length,
            team: {mem: (t.match(/背包裝滿/g) || []).length, pill: /建議收取間隔/.test(t)}};
  });
  ok('每一隻的卡片都寫出「背包裝滿 N」',
     u.rows.length === u.n && u.rows.every(t => /背包裝滿/.test(t)), u.rows[0]);
  ok('整隊有一顆「建議收取間隔」的 pill', !!u.pill, String(u.pill));
  /* pill 由**最先到頂的那一隻**決定 —— 一次上線是全隊一起收。 */
  ok('pill 的數字 = 全隊 min(滿包, 技能存滿)',
     !!u.pill && u.pill.includes(u.wantMin), `${u.pill} 應含 ${u.wantMin}`);
  ok('自組隊伍也有（共用同一個渲染器）',
     u.team.mem === u.n && u.team.pill === true, JSON.stringify(u.team));

  /* 收取間隔設得比建議長 ＝ 推演**已經**把溢出扣掉了。那要講出來，否則使用者
     看到分數低於預期卻不知道為什麼 —— 和「靜靜地少算候選」同一類。 */
  await doRun(`wk.collectH = 12; syncWeeklyUI()`);
  const late = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('#results .pillrow .pill')]
      .find(x => /建議收取間隔/.test(x.textContent));
    return {warn: /⚠/.test(pill.textContent),
            neg: /--neg/.test(pill.getAttribute('style') || ''),
            tip: pill.getAttribute('title') || '',
            mem: [...document.querySelectorAll('#results .mem .out')]
                   .some(x => /⚠/.test(x.innerHTML))};
  });
  ok('收得比建議晚 → pill 標紅並加 ⚠', late.warn && late.neg,
     JSON.stringify([late.warn, late.neg]));
  ok('說明要寫出「推演已經把溢出扣掉了」，不是只給一個數字',
     /扣掉/.test(late.tip) && /12/.test(late.tip), late.tip.slice(0, 140));
  ok('該收沒收的那幾隻自己也要標出來', late.mem === true, String(late.mem));
  await doRun(`wk.collectH = DEFAULT_COLLECT_H; syncWeeklyUI()`);
}

console.log('\n[12] 快取偏移：schema 不符必須明確擋下');
{
  ok('資料帶著 schema 版本', await page.evaluate(() => typeof D.meta.schema === 'number'));

  tamperSchema = 999;
  const p2 = await browser.newPage();
  await p2.goto(PAGE);
  await p2.waitForTimeout(2000);
  const t = await p2.evaluate(() => document.querySelector('.wrap').innerText);
  ok('顯示版本不符的說明', /版本.*不符|無法啟動/.test(t), t.slice(0, 80));
  ok('明確叫使用者強制重新整理', /強制重新整理/.test(t), t.slice(0, 80));
  ok('沒有硬撐著算出數字', await p2.evaluate(() => !document.getElementById('results')), 'results 區塊還在，表示 app 繼續跑了');
  await p2.close();

  tamperSchema = null;
  const p3 = await browser.newPage();
  await p3.goto(PAGE);
  await p3.waitForTimeout(2000);
  ok('schema 正確時照常啟動', await p3.evaluate(() => typeof run === 'function' && !!document.getElementById('results')));
  await p3.close();
}

// 放最後才檢查，才能涵蓋上面每一節（schema 那節刻意的錯誤發生在另開的頁面，不算在內）
ok('全程沒有 JS 錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
statics.close();
console.log(`\n${fail === 0 ? '✓ 全部通過' : '✗ 有失敗'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
