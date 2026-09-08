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
 *   4b. 合併 tools/types.txt 的屬性清單、tools/skills-extra.json 的主技能表（上游都沒有，務必保留）
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
/* ---- 合併惡屬性清單（上游沒有屬性欄位，這份 repo 自己維護）----
   夢魘的扣活力只打在惡屬性以外的成員身上、流星群看隊上的龍屬性種類數 —— 沒有這份清單就寫不出那些判斷。
   和 zh.txt 同一個性質：**重建時絕對不能弄丟。** 名字對不上 dex 就直接報錯，
   因為錯的名字不會有任何症狀 —— 只會讓那一隻被夢魘白扣一次。 */
const typesTxt = readFileSync(resolve(ROOT, 'tools/types.txt'), 'utf8');
data.types = {};
{
  let cur = null;
  for (const raw of typesTxt.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('##')) { cur = l.slice(2).trim().toLowerCase(); data.types[cur] = []; continue; }
    if (!l || l.startsWith('#') || !cur) continue;
    data.types[cur].push(l);
  }
  const known = new Set(data.dex.map((p) => p.n));
  for (const [k, v] of Object.entries(data.types)) {
    const bad = v.filter((n) => !known.has(n));
    if (bad.length) throw new Error('tools/types.txt 的 ' + k + ' 有不在 dex 裡的名字：' + bad.join(', '));
  }

/* ---- 合併上游沒有的主技能數值表（tools/skills-extra.json）----
   例如流星群（樹果遽增）依「隊上不同種類的龍屬性數」決定樹果數的那張表 ——
   遊戲技能頁有，上游快照沒有。同樣是 repo 自己維護、重建時不能弄丟。
   `_` 開頭的鍵是註解，不寫進 data。 */
const msExtraRaw = JSON.parse(readFileSync(resolve(ROOT, 'tools/skills-extra.json'), 'utf8'));
data.msExtra = {};
for (const [k, v] of Object.entries(msExtraRaw)) {
  if (k.startsWith('_')) continue;
  if (!ms[k]) throw new Error('tools/skills-extra.json 提到不存在的主技能：' + k);
  data.msExtra[k] = Object.fromEntries(Object.entries(v).filter(([kk]) => !kk.startsWith('_')));
}
}

data.meta = {
  // 資料結構版本。app.js 有一份 SCHEMA 常數會斷言它相等 —— 兩者不合就顯示「請重新整理」，
  // 避免瀏覽器拿到「新 app.js ＋ 舊 game.json」這種偏移組合而算出錯的數字。
  // 動到欄位結構（改名／改型別／移除）時，這裡和 app.js 的 SCHEMA 要一起 +1。
  schema: 4,
  src: 'nerolis-lab/nerolis-lab', commit, commitDate,
  builtAt: new Date().toISOString().slice(0, 10),
  zhSrc: 'RaenonX i18n + 52poke zh-hant',
  typesSrc: 'tools/types.txt（本專案維護 —— 上游的寶可夢資料沒有屬性欄位）',
  msExtraSrc: 'tools/skills-extra.json（本專案維護 —— 上游快照沒有這些表）',
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
