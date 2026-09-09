#!/usr/bin/env node
/**
 * 慢速驗證 —— 搜尋正確性的對照實驗。跑幾分鐘，所以不放在 smoke 裡。
 *
 *   npm run verify
 *
 * 這裡的每一項都對應一個「靠讀程式碼看不出來」的問題：
 *
 *   1. 順序不變性（大箱子）—— smoke 的第 4 節只能用 22 隻（26,334 組），
 *      抓不到「只在大箱子觸發的啟發式」。曾經有個預篩在 >120 萬組合時
 *      按 roster 順序砍到前 42 隻，實測差 −16.34%。這一節用 60 隻真的重現那個規模。
 *   2. FINALISTS 夠不夠 —— 搜尋階段用 mealPlan 單起點（真值的下界），決賽用 bestPlan
 *      多起點。若 FINALISTS 太小，最佳隊伍會被擠出決賽（前科：原本 8，低估 27%）。
 *
 *      ⚠ 這一節「放大 FINALISTS 前 8 名不變」的實驗**偵測不到搜尋評分函式本身的偏差**。
 *      2026-09-09 之前搜尋用的是 proxyDish（樂觀上界），而決賽也是按它排序
 *      （finalizeTeams 的 if 在上界之下永遠不成立），所以多放進來的隊伍不會翻身 ——
 *      這個測試當年因此給出「proxyDish 沒有擠掉最佳解」的錯誤結論。真正要驗的是
 *      「搜尋排名 vs 真實排程排名」，那在 smoke.mjs 第 2b 節（搜尋分數必須是下界）。
 *
 * 什麼時候該跑：動 searchTeams / scoreTeam / mealPlan / bestPlan / FINALISTS 之後。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './chromium.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = resolveChromium();   // 見 tests/chromium.mjs

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`); }
};

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
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(PAGE);
await page.waitForTimeout(2000);

/* 共用的 helper：注入到頁面裡 */
await page.evaluate(() => {
  window.__mkBox = (n, everyNth) => {
    const picks = D.dex.filter(x => x.ms && x.b).filter((_, i) => i % everyNth === 0).slice(0, n);
    return picks.map((x, i) => ({
      sp: D.dex.indexOf(x), level: 30 + (i % 25),
      nature: ['Adamant', 'Modest', 'Careful', 'Mild', 'Sassy'][i % 5],
      ss: ['Helping Bonus', null, null, null, null], ingSet: [0, 0, 0], skillLv: 3 + (i % 4),
      ribbon: 0, pin: false, ex: false,
    }));
  };
  /* strictBerry: false —— 這裡要驗的是「純窮舉的順序不變性」與「FINALISTS 夠不夠」，
     必須讓搜尋空間完整才有意義。產品規則（樹果型必須符合本週樹果）本身的
     順序不變性由 smoke 第 4 節守住。 */
  window.__mkWk = () => ({
    island: 'greengrass', fav: new Set(['ORAN', 'PAMTRE', 'PECHA']), areaBonus: 15, pot: 57,
    sleepH: 8.5, camp: 0, mode: 'total', dishType: 'curry', recipeName: null, recipeLv: 20,
    recipePick: 'auto', recipeScope: 'all', recipeLevels: {}, strictBerry: false,
  });
  window.__shuffle = (arr, seed) => {
    const a = arr.slice(); let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // 用物種名稱集合當 key —— 索引會隨順序改變，不能直接比
  window.__go = (roster, opts) => {
    const res = searchTeams(roster.map(m => ({ ...m })), window.__mkWk(), opts || {});
    return {
      count: res.count, ms: res.ms,
      top: res.best.map(x => x.idxs.map(i => D.dex[roster[i].sp].n).sort().join('+')),
      total: Math.round(res.best[0].total * 100) / 100,
    };
  };
});

const nCk = (n, k) => { let v = 1; for (let i = 0; i < k; i++) v = v * (n - i) / (i + 1); return v; };

console.log('\n[1] 順序不變性 — 60 隻箱子（舊預篩會在這個規模觸發）');
{
  const r = await page.evaluate(() => {
    const base = window.__mkBox(60, 4);
    return {
      n: base.length,
      runs: [
        { label: '原順序', ...window.__go(base) },
        { label: 'seed=7', ...window.__go(window.__shuffle(base, 7)) },
        { label: 'seed=99', ...window.__go(window.__shuffle(base, 99)) },
        { label: 'seed=4242', ...window.__go(window.__shuffle(base, 4242)) },
        { label: 'seed=31337', ...window.__go(window.__shuffle(base, 31337)) },
      ],
    };
  });
  const expect = Math.round(nCk(r.n, 5));
  for (const x of r.runs) console.log(`      ${x.label.padEnd(11)} ${x.count.toLocaleString().padStart(10)} 組 · ${String(x.ms).padStart(6)}ms · 第1名 ${x.total}`);

  ok(`每次都窮舉全部 C(${r.n},5)=${expect.toLocaleString()} 組`,
     r.runs.every(x => x.count === expect), r.runs.map(x => x.count).join(' / '));

  const ref = r.runs[0];
  const bad = r.runs.filter(x => x.top.join('|') !== ref.top.join('|'));
  ok('4 種洗牌的前 8 名與原順序完全相同', bad.length === 0,
     bad.map(x => `${x.label}: ${x.top[0]} (${x.total}) vs ${ref.top[0]} (${ref.total}) → ${((x.total / ref.total - 1) * 100).toFixed(2)}%`).join('\n      '));
  ok(`第 1 名 total 全部相同（${ref.total}）`, r.runs.every(x => x.total === ref.total),
     r.runs.map(x => `${x.label}=${x.total}`).join(' '));
}

console.log('\n[2] FINALISTS = 50 夠不夠 — 40 隻箱子比 50 / 200 / 1000');
{
  const r = await page.evaluate(() => {
    const base = window.__mkBox(40, 6);
    return {
      n: base.length,
      runs: [50, 200, 1000].map(f => ({ label: `finalists=${f}`, ...window.__go(base, { finalists: f }) })),
    };
  });
  for (const x of r.runs) console.log(`      ${x.label.padEnd(15)} ${String(x.ms).padStart(6)}ms · 第1名 ${x.total}`);
  const ref = r.runs[0];
  const bad = r.runs.filter(x => x.top.join('|') !== ref.top.join('|'));
  ok('放大決賽名額不改變前 8 名（FINALISTS = 50 夠大）', bad.length === 0,
     bad.map(x => `${x.label}: ${x.top[0]} (${x.total}) vs ${ref.top[0]} (${ref.total}) → ${((x.total / ref.total - 1) * 100).toFixed(3)}%`).join('\n      '));
}

ok('全程沒有 JS 錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
statics.close();
console.log(`\n${fail === 0 ? '✓ 全部通過' : '✗ 有失敗'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
