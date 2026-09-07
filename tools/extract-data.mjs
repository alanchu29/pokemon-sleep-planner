#!/usr/bin/env node
/**
 * 從上游 Neroli's Lab 重建 data/game.json。
 *
 *   node tools/extract-data.mjs [--out data/game.json]
 *
 * 流程：
 *   1. clone 上游到 .tmp/nl（已存在則 fetch）
 *   2. 用 esbuild 把 common/src/index.ts bundle 成 CJS
 *   3. 萃取成本專案用的精簡結構
 *   4. 合併 tools/zh.txt 的繁中對照表（上游沒有這份，務必保留）
 *   5. 以 indent-2 寫出（一個欄位一行，動到哪隻寶可夢的哪個數值 diff 會直接顯示）
 *
 * 需要：node 18+、git、網路。會在 .tmp 下 npm i esbuild uuid。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = resolve(ROOT, '.tmp');
const NL = resolve(TMP, 'nl');
const UPSTREAM = 'https://github.com/nerolis-lab/nerolis-lab';

const args = process.argv.slice(2);
const outPath = resolve(ROOT, arg('--out') || 'data/game.json');
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const shq = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

mkdirSync(TMP, { recursive: true });

if (!existsSync(NL)) {
  console.log('clone 上游…');
  sh(`git clone --depth=1 ${UPSTREAM} nl`, TMP);
} else {
  console.log('fetch 上游…');
  sh('git fetch --depth=1 origin main && git reset --hard FETCH_HEAD', NL);
}
const commit = shq('git log -1 --format=%h', NL);
const commitDate = shq('git log -1 --format=%cs', NL);
console.log(`上游 commit ${commit} (${commitDate})`);

if (!existsSync(resolve(TMP, 'node_modules/esbuild'))) {
  console.log('安裝 esbuild / uuid…');
  writeFileSync(resolve(TMP, 'package.json'), JSON.stringify({ name: 'psleep-extract', private: true }));
  sh('npm i esbuild uuid --no-audit --no-fund', TMP);
}

// 萃取腳本：只取本專案需要的欄位，鍵名刻意縮短以壓小 payload
writeFileSync(resolve(TMP, 'extract.ts'), `
import * as C from './nl/common/src/index.js';
const A: any = C;
const ING_IDX: Record<string, number> = {};
A.ingredient.INGREDIENTS.forEach((i: any, n: number) => (ING_IDX[i.name] = n));
const set = (arr: any[] | undefined) => (arr || []).map((i: any) => [ING_IDX[i.ingredient.name], i.amount]);
const dex = A.COMPLETE_POKEDEX.map((p: any) => ({
  n: p.name, d: p.displayName, no: p.pokedexNumber, sp: p.specialty,
  f: p.frequency, ip: p.ingredientPercentage, sk: p.skillPercentage,
  b: p.berry?.name, cs: p.carrySize, pe: p.previousEvolutions, re: p.remainingEvolutions,
  ms: p.skill?.name, i0: set(p.ingredient0), i30: set(p.ingredient30), i60: set(p.ingredient60),
})).sort((a: any, b: any) => a.no - b.no || a.d.localeCompare(b.d));
const recipes = A.RECIPES.map((r: any) => ({
  n: r.name, t: r.type, bonus: r.bonus, cnt: r.nrOfIngredients,
  ings: r.ingredients.map((i: any) => [ING_IDX[i.ingredient.name], i.amount]),
}));
const ms: any = {};
for (const s of A.MAINSKILLS) {
  if (ms[s.name]) continue;
  const o: any = { max: s.RP?.length ?? 6 };
  for (const k of Object.keys(s)) if (k.endsWith('Amounts') && Array.isArray(s[k])) o[k.replace('Amounts', '')] = s[k];
  ms[s.name] = o;
}
const data = {
  ings: A.ingredient.INGREDIENTS.map((i: any) => [i.name, i.value]),
  berries: A.berry.BERRIES.map((b: any) => [b.name, b.value]),
  dex, recipes, ms,
  natures: A.nature.NATURES.map((n: any) => ({ n: n.name, p: n.positiveModifier, m: n.negativeModifier, f: n.frequency, i: n.ingredient, s: n.skill, e: n.energy })),
  subskills: A.subskill.SUBSKILLS.map((s: any) => ({ n: s.name, s: s.shortName, a: s.amount, r: s.rarity })),
  rlb: A.recipeLevelBonus.recipeLevelBonus ?? A.recipeLevelBonus,
  islands: A.ISLANDS.map((i: any) => ({ n: i.name, s: i.shortName, b: (i.berries || []).map((x: any) => x.name) })),
};
require('fs').writeFileSync(process.argv[2], JSON.stringify(data));
`);
sh('npx esbuild extract.ts --bundle --platform=node --format=cjs --outfile=extract.cjs --log-level=error', TMP);
const rawPath = resolve(TMP, 'raw.json');
sh(`node extract.cjs ${rawPath}`, TMP);

const data = JSON.parse(readFileSync(rawPath, 'utf8'));

/* ---- 合併繁中對照表 ---- */
const zhTxt = readFileSync(resolve(ROOT, 'tools/zh.txt'), 'utf8');
const sec = {};
let cur = null;
for (const line of zhTxt.split('\n')) {
  if (line.startsWith('##')) { cur = line.slice(2).trim(); sec[cur] = {}; continue; }
  if (!line.trim() || !cur) continue;
  const i = line.indexOf('=');
  sec[cur][line.slice(0, i)] = line.slice(i + 1);
}
const norm = (s) => s.replace(/['’']/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
const byNorm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [norm(k), v]));
const recByNorm = byNorm(sec.RECIPES), pkByNorm = byNorm(sec.POKEMON), formByNorm = byNorm(sec.FORMS);

const zhRecipes = {}, missR = [];
for (const r of data.recipes) {
  const hit = recByNorm[norm(r.n.replace(/_/g, ' '))];
  if (hit) zhRecipes[r.n] = hit; else missR.push(r.n);
}
const zhPk = {}, missP = [];
for (const p of data.dex) {
  const m = p.d.match(/^(.*?)\s*\((.+)\)$/);
  const base = m ? m[1] : p.d, form = m ? m[2] : null;
  const b = pkByNorm[norm(base)];
  if (!b) { missP.push(p.d); continue; }
  zhPk[p.n] = form ? `${b}（${formByNorm[norm(form)] || form}）` : b;
}
data.zh = {
  islands: sec.ISLANDS, berries: sec.BERRIES, ings: sec.INGS, natures: sec.NATURES,
  subskills: sec.SUBSKILLS, ssShort: sec.SUBSKILL_SHORT, ms: sec.MAINSKILLS,
  recipes: zhRecipes, pk: zhPk,
};
data.meta = {
  src: 'nerolis-lab/nerolis-lab', commit, commitDate,
  builtAt: new Date().toISOString().slice(0, 10),
  zhSrc: 'RaenonX i18n + 52poke zh-hant',
};

/* ---- 缺漏報告：絕對不要自創中文名，缺就留英文並記錄 ---- */
const gaps = {
  pokemon: missP,
  recipes: missR,
  mainskills: Object.keys(data.ms).filter((k) => !data.zh.ms[k]),
  subskills: data.subskills.map((s) => s.n).filter((n) => !data.zh.subskills[n]),
  islands: data.islands.map((i) => i.n).filter((n) => !data.zh.islands[n]),
};
const json = JSON.stringify(data, null, 2) + '\n';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, json);

console.log(`\n寫入 ${outPath} (${json.length} bytes)`);
console.log(`收錄：${data.dex.length} 隻寶可夢 · ${data.recipes.length} 道食譜 · ${data.subskills.length} 個副技能 · ${data.islands.length} 個研究區域`);
let clean = true;
for (const [k, v] of Object.entries(gaps)) {
  if (v.length) { clean = false; console.warn(`⚠ ${k} 缺中文名 (${v.length}): ${v.join(', ')}`); }
}
if (clean) console.log('繁中對照表 100% 覆蓋 ✓');
else console.warn('\n→ 請到 tools/zh.txt 補上，來源見 CLAUDE.md。沒有可靠來源就留英文，不要自創。');

console.log('\n→ 先 git diff data/game.json 確認改動合理，跑 node tests/smoke.mjs，再 commit');
