#!/usr/bin/env node
/**
 * 煙霧測試 — 這裡每一項都對應一個真實發生過的 bug。加功能時請一起擴充。
 *
 *   npm i playwright-core && node tests/smoke.mjs
 *
 * 容器內 chromium 在 /opt/pw-browsers/chromium；可用 CHROMIUM 環境變數覆蓋。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const TOKEN = 'smoke-token';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ---- mock Apps Script endpoint ---- */
let store = null, lastTable = null;
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
// 設成數字時，game.json 的 meta.schema 會被改寫成該值 —— 用來模擬快取偏移（見第 9 節）
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

console.log('\n[4] 幫手加速依同樹果種類數放大');
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

console.log('\n[5] 揮指類技能不再算 0');
{
  const r = await page.evaluate(() => {
    const w = skillPayload('Metronome', 3);
    return { keys: Object.keys(w).length, strength: w.strength || 0 };
  });
  ok('揮指有非零產出', r.keys > 1 && r.strength > 0, JSON.stringify(r));
}

console.log('\n[6] 自架版本偵測與文案');
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

console.log('\n[7] Google Sheet 同步往返');
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

  await page.evaluate(() => { showView('box'); $('syncToken').value = 'wrong'; });
  await page.click('#syncPull');
  await page.waitForTimeout(900);
  ok('錯誤金鑰有明確錯誤', /unauthorized/.test(await page.evaluate(() => $('syncStatus').textContent)));
}

console.log('\n[8] 每個 view 都能渲染');
for (const v of ['plan', 'box', 'recipes']) {
  await page.evaluate((x) => showView(x), v);
  await page.waitForTimeout(400);
  ok(`view-${v} 有內容`, await page.evaluate((x) => $('view-' + x).innerText.trim().length > 50, v));
}

console.log('\n[9] Worker：40 隻的箱子推演期間 UI 不能凍住');
{
  // 40 隻 → C(40,5) = 658,008 組合。同步版本會凍住約 5 秒。
  await page.evaluate(() => {
    const picks = D.dex.filter(p => p.ms).slice(0, 40);
    roster = picks.map((p) => ({
      sp: D.dex.indexOf(p), level: 40, nature: 'Bashful',
      ss: [null, null, null, null, null], ingSet: [0, 0, 0], skillLv: 3,
      ribbon: 0, pin: false, ex: false,
    }));
    renderBox();
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

console.log('\n[10] 文案一致性 — 不能提到不存在的檔案或指令');
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

/* 用另開的頁面跑 —— 這一節刻意觸發致命錯誤，不能污染上面的 errors 收集。 */
console.log('\n[11] 快取偏移：schema 不符必須明確擋下');
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
