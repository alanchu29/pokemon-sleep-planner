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
    return { monoU: mono.ctx.hbU, mixedU: mixed.ctx.hbU, monoHelps: mono.ctx.extraHelps, mixedHelps: mixed.ctx.extraHelps };
  });
  ok('同樹果隊的 unique 計數較高', r && r.monoU > r.mixedU, JSON.stringify(r));
  ok('同樹果隊拿到更多額外幫手', r && r.monoHelps > r.mixedHelps, JSON.stringify(r));
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
}

console.log('\n[9] 每個 view 都能渲染');
for (const v of ['plan', 'box', 'recipes']) {
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
}

/* 截圖匯入。這一節的 golden case 是**兩隻真實的寶可夢**（使用者 2026-09-07 提供的
   遊戲截圖），期望值是逐欄手算對照過的 —— 不是程式自己算出來再存回去，所以動到
   baseStats / helpInterval / impSolve 的係數時這裡會紅。 */
console.log('\n[11b] 截圖匯入：反解物種／緞帶／食材欄位');
const IMP_CASES = [
  { label: '大食花 Lv60 頑皮',
    obs: { level:60, specialty:'ingredient', mainSkill:'Charge Energy S',
           skillDisplayLv:6, skillPayload:43, nature:'Naughty',
           ss:['Skill Level Up M','Ingredient Finder M','Helping Speed M','Ingredient Finder S','Helping Speed S'],
           ingCounts:[2,4,6], intervalSec:1911, carry:35, camp:false },
    want: { sp:'VICTREEBEL', ribbon:4, ingSet:'0,1,1', skillLv:4, amb:'' } },
  { label: '水箭龜 Lv62 馬虎',
    obs: { level:62, specialty:'ingredient', mainSkill:'Ingredient Magnet S',
           skillDisplayLv:3, skillPayload:11, nature:'Rash',
           ss:['Inventory Up M','Helping Bonus','Inventory Up L','Ingredient Finder S','Skill Trigger S'],
           ingCounts:[2,3,7], intervalSec:2458, carry:65, camp:false },
    // i60 是 牛奶×7 / 可可×5 / 豆製肉×7 —— ×7 有兩個選項，所以第 3 格一定是歧義
    want: { sp:'BLASTOISE', ribbon:4, ingSet:'0,1,0', skillLv:3, amb:'3' } },
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
        amb: [0,1,2].filter(s => t.amb[s] && t.amb[s].length > 1).map(s => s+1).join(','),
        vOk: v.interval.ok === true && v.carry.ok === true };
    }, c.obs);
    ok(`${c.label}：唯一解`, r.n === 1, `得到 ${r.n} 組`);
    ok(`${c.label}：反解出 ${c.want.sp}`, r.sp === c.want.sp, `得到 ${r.sp}`);
    ok(`${c.label}：反解出緞帶 ${c.want.ribbon}（截圖上看不到）`, r.ribbon === c.want.ribbon, `得到 ${r.ribbon}`);
    ok(`${c.label}：食材欄位 [${c.want.ingSet}]`, r.ingSet === c.want.ingSet, `得到 [${r.ingSet}]`);
    ok(`${c.label}：主技能基礎等級 ${c.want.skillLv}（畫面顯示的是加成後）`,
       r.skillLv === c.want.skillLv, `得到 ${r.skillLv}，有效 ${r.eff}，來源 ${r.src}`);
    ok(`${c.label}：有效等級是從技能說明的數字反查`, r.src === 'payload', r.src);
    ok(`${c.label}：兩個校驗碼都重算得回截圖上的值`,
       r.iv === c.obs.intervalSec && r.cr === c.obs.carry && r.vOk,
       `${r.iv}s / ${r.cr}個`);
    ok(`${c.label}：歧義欄位標示正確（第 ${c.want.amb || '無'} 格）`, r.amb === c.want.amb, `得到「${r.amb}」`);
  }

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

    // 手動改一欄（等級）→ 校驗碼必須立刻變紅
    const lv = $('impRow').querySelector('[data-k="level"]');
    lv.value = 55; lv.dispatchEvent(new Event('change', {bubbles:true}));
    const wentBad = $('impChecks').innerHTML.includes('impck bad');
    // 改回去 → 恢復
    lv.value = 60; lv.dispatchEvent(new Event('change', {bubbles:true}));
    const backOk = !$('impChecks').innerHTML.includes('impck bad');

    $('impSave').click();
    const added = roster.length === before + 1;
    const last = roster[roster.length - 1];
    return { reviewShown, rowFields, notWritten, solvedSp, solvedRb, wentBad, backOk,
             added, savedSp: last && D.dex[last.sp].n, savedRb: last && last.ribbon,
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
  ok('改回正確值 → 校驗碼恢復', flow.backOk);
  ok('按「存入箱子」才真的加進 roster', flow.added && flow.savedSp === 'VICTREEBEL' && flow.savedRb === 4,
     `${flow.savedSp} / 緞帶${flow.savedRb}`);
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
    return {start, appended, replaced, keptWk, tookWk};
  });
  ok('起始兩隻', r.start === 'PIKACHU,RAICHU', r.start);
  ok('追加會接在現有的後面', r.appended === 'PIKACHU,RAICHU,GENGAR', r.appended);
  ok('取代會換掉整箱（備份還原用的）', r.replaced === 'MEW', r.replaced);
  ok('追加不會動到本週條件', r.keptWk === 35, String(r.keptWk));
  ok('取代會套用 JSON 裡的本週條件', r.tookWk === 5, String(r.tookWk));
}

/* 用另開的頁面跑 —— 這一節刻意觸發致命錯誤，不能污染上面的 errors 收集。 */
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
