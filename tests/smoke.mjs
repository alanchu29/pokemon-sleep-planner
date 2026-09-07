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
const statics = http.createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = resolve(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const buf = await readFile(file);
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

console.log('\n[2] 引擎');
await page.evaluate(seed);
await page.evaluate(() => { wk.recipeScope = 'all'; wk.recipePick = 'auto'; syncWeeklyUI(); run(); });
await page.waitForTimeout(1500);
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
  const base = await page.evaluate(async () => { wk.recipeLevels = {}; run(); await new Promise(r=>setTimeout(r,1200)); return lastResults[0].total; });
  let worst = 0, bad = 0;
  const names = await page.evaluate(() => D.recipes.map(r => r.n));
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 6; t++) {
    const lv = {};
    for (let j = 0; j < 6; j++) lv[names[Math.floor(rnd() * names.length)]] = 30 + Math.floor(rnd() * 40);
    const got = await page.evaluate(async (l) => { wk.recipeLevels = l; run(); await new Promise(r=>setTimeout(r,1200)); return lastResults[0].total; }, lv);
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
    wk.recipe = D.recipes[0]; wk.recipeScope = 'all'; buildPool();
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

ok('全程沒有 JS 錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
statics.close();
console.log(`\n${fail === 0 ? '✓ 全部通過' : '✗ 有失敗'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
