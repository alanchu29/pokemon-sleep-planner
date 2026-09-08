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
      newVisible: !newCard.hidden, newOpen: !!newCard.querySelector('.mon-edit')};

    // 完整顯示：副技能選項是全名（不是 Help M 這種縮寫）、食材選項只放名稱、數量在旁邊
    const ssSel = newCard.querySelector('[data-k="ss"]');
    const ssText = [...ssSel.options].find(o => o.value === 'Helping Speed M').text;
    const ingSel = newCard.querySelector('[data-k="ingSet"]');
    const ingText = ingSel.options[0].text;
    const amount = ingSel.closest('.ingpick').querySelector('b').textContent;

    /* 刪除會讓後面的索引整批位移 → 展開狀態必須清掉，
       不然會展開到「原本是下一隻」的那一隻身上。
       ✕ 現在會先問一次 —— 這裡把 confirm 換掉，才能同時測「取消」和「確定」。
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

    // 📌 和 🚫 就在 ✕ 旁邊，它們**不該**問 —— 隨手切換用的，而且可逆
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
            levels, reclosed, searched, bySs, cleared, afterAdd, afterCancel, afterDel,
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
     清除篩選、截圖存入、JSON 匯入三條路徑都走同一個函式，所以三條都中。 */
  ok('新增一隻不會把排序打掉（排序不是篩選）',
     r.afterAdd.sort === 'no' && r.afterAdd.sortSel === 'no' &&
     r.afterAdd.order.join(',') === [...r.afterAdd.order].sort((a,b)=>a-b).join(','),
     `sort=${r.afterAdd.sort}/${r.afterAdd.sortSel} order=#${r.afterAdd.order.join(' #')}`);
  ok('副技能選項顯示全名', r.ssText === '幫忙速度M', r.ssText);
  ok('食材選項只放名稱，數量顯示在旁邊', r.ingText === '特選蘋果' && r.amount === '×1',
     `「${r.ingText}」 / 「${r.amount}」`);
  /* ✕ 就在 📌 和 🚫 旁邊，手滑一格就少一隻，而且 save() 是即時的、雲端馬上跟著
     覆蓋 —— 沒有 undo。所以刪除一定要問，而且訊息要寫出是哪一隻。 */
  ok('按 ✕ 會先問，按取消一隻都不會少',
     r.afterCancel.n === r.afterDel.before, `${r.afterCancel.n} vs ${r.afterDel.before}`);
  ok('確認訊息寫出是哪一隻（排序／篩選後才分得出按到誰）',
     /#\d+/.test(r.afterCancel.msg) && /Lv\d+/.test(r.afterCancel.msg) && /雷丘|皮卡丘|大食花|呆殼獸|河馬獸|水箭龜|耿鬼/.test(r.afterCancel.msg),
     `「${r.afterCancel.msg}」`);
  ok('按確定才真的刪，並清掉展開狀態（否則會展開到別隻身上）',
     r.afterDel.n === 4 && r.afterDel.before === 5 && r.afterDel.open === 0 && r.afterDel.anyEdit === 0,
     JSON.stringify(r.afterDel));
  ok('📌 / 🚫 不會問（隨手切換用的，而且可逆）', r.toggleAsked === false, String(r.toggleAsked));
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
