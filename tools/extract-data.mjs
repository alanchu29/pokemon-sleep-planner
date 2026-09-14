#!/usr/bin/env node
/**
 * 從上游 Neroli's Lab 重建 data/game.json。
 *
 *   node tools/extract-data.mjs [--out data/game.json] [--offline]
 *
 *   --offline  不 fetch 上游，沿用現有的 .tmp/nl（只改了 tools/*.txt 想重建時用）
 *
 * 流程：
 *   1. clone 上游到 .tmp/nl（已存在則 fetch）
 *   2. 用 esbuild 把 common/src/index.ts bundle 成 CJS
 *   3. 萃取成本專案用的精簡結構
 *   4. 合併 tools/zh.txt 的繁中對照表（上游沒有這份，務必保留）
 *   4b. 由樹果推導屬性（見下方說明）、合併 tools/skills-extra.json 的主技能表（上游沒有，務必保留）
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

/* `--offline`：不要動 .tmp/nl，就用現在那份 clone 重建。
   用途是「只改了 tools/*.txt（繁中、屬性、主技能表）想重建，但**不想順便把上游拉到新的
   commit**」—— 那會讓一次 diff 同時包含兩件事，而 CLAUDE.md 要求重建後逐位比對數值，
   混在一起就分不出哪一項造成的差異。沒有 clone 時仍然會 clone。 */
const offline = args.includes('--offline');
if (!existsSync(NL)) {
  console.log('clone 上游…');
  sh(`git clone --depth=1 ${UPSTREAM} nl`, TMP);
} else if (offline) {
  console.log('--offline：沿用現有的 .tmp/nl，不 fetch');
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
  // 屬性就是從這裡推導出來的（每隻一個 ＝ 牠的樹果屬性），推完就從 data 拿掉、不寫進 game.json。
  // 18 顆樹果剛好一顆對一個屬性，所以它是「每一隻至少一個屬性有上游來源」的唯一憑據。
  bt: A.berry.BERRIES.map((b: any) => [b.name, b.type]),
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
/* `/\r?\n/` 不是防禦性寫法：`core.autocrlf=true` 的 Windows checkout 會把 zh.txt 變成 CRLF，
   只切 '\n' 的話 465 個中文名會全部帶一個尾隨 \r —— 那在 UI 上看不出來。types.txt 本來就這樣切。 */
for (const line of zhTxt.split(/\r?\n/)) {
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
  /* 屬性名。上游的 i18n 也沒有這一組（因為上游根本沒有屬性資料），所以和 types.txt
     一樣是本專案維護。18 個固定的官方譯名，使用者一眼可以全部核對完 —— 這是
     「不要自創中文名」那條規則的例外理由：它擋的是寶可夢與食譜名，那些譯錯了看不出來。 */
  types: sec.TYPES,
};
/* ---- 屬性：直接由樹果推導（2026-09-14 起，不再手動維護清單）----

   **Pokémon Sleep 的每一隻只有一個屬性，而且就是牠撿的那種樹果的屬性。**
   18 顆樹果對 18 個屬性，剛好一對一（上游 `berries.ts` 的 `Berry.type`）。

   怎麼確定的：
     · 使用者 2026-09-14 在遊戲裡核對出拉帝亞斯／拉帝歐斯**只有龍屬性**，
       而本傳與官方圖鑑兩隻都是龍／超能力 —— 遊戲有自己的一套，且與樹果一致
       （牠們的樹果是番荔果 YACHE，`type: 'dragon'`）。
     · 對照當時那份手維護清單：122 隻單屬性的**全部**等於自己的樹果屬性（0 例外），
       247 隻的樹果屬性也都在各自的清單裡。也就是說那份清單只是「樹果屬性 ＋ 本傳
       多出來的第二屬性」，而第二屬性在 Sleep 裡並不存在。

   **所以 `tools/types.txt` 廢除了。** 它有 247 行，而且和樹果欄位是同一份資料的兩個
   副本 —— 重複的兩份總有一份會先走鐘，而走鐘的那一份**在執行期完全沒有症狀**
   （那一隻只是靜靜地不符合任何屬性條件）。從樹果推導之後這整類 bug 就不存在了：
   不會漏掉新寶可夢、不會打錯字、不會在重建時弄丟、也不再需要「第二屬性靠使用者
   在畫面上核對」那道人工防線。

   ⚠ **哪天遊戲真的出現雙屬性，就把 types.txt 復活成「覆寫檔」**（只列例外的那幾隻），
   不要退回整份手維護 —— 那等於把上面那整類 bug 一起請回來。

   輸出的形狀完全沒變：依屬性分組的 `{dark:[...], dragon:[...], ...}`，
   所以 engine 的 `DARK` / `DRAGON` 兩個 Set 與 `TYPES_OF` 反查表都不用動。 */
const TYPE_NAMES = ['normal','fire','water','electric','grass','ice','fighting','poison','ground',
                    'flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'];
data.types = Object.fromEntries(TYPE_NAMES.map((t) => [t, []]));
{
  const berryType = Object.fromEntries(data.bt);
  /* 三道守門。前兩道擋的是「上游改了樹果資料」，第三道擋的是「某一隻的樹果我們不認得」
     —— 三者都會讓那一隻靜靜地沒有屬性，而那在執行期沒有任何症狀。 */
  // 1. 18 顆樹果必須剛好覆蓋 18 個屬性，一對一。這是整個推導的前提。
  const seen = new Set(Object.values(berryType));
  if (seen.size !== TYPE_NAMES.length || TYPE_NAMES.some((t) => !seen.has(t)))
    throw new Error(`上游 berry.type 不再與 18 個屬性一對一（看到 ${seen.size} 種：`
      + `${[...seen].sort().join(',')}）—— 屬性推導的前提垮了，先確認上游改了什麼`);
  // 2. 屬性名必須都是那 18 個
  for (const [b, t] of Object.entries(berryType))
    if (!TYPE_NAMES.includes(t)) throw new Error(`上游樹果 ${b} 的屬性「${t}」不在 18 個屬性裡`);
  // 3. 每一隻的樹果都要查得到
  const orphan = data.dex.filter((p) => !berryType[p.b]).map((p) => `${p.n}（樹果 ${p.b}）`);
  if (orphan.length) throw new Error(`有 ${orphan.length} 隻的樹果查不到屬性：\n  ` + orphan.join('\n  '));

  for (const p of data.dex) data.types[berryType[p.b]].push(p.n);
}
delete data.bt; // 推導用，不進 game.json

/* ---- 合併上游沒有的主技能數值表（tools/skills-extra.json）----
   例如流星群（樹果遽增）依「隊上不同種類的龍屬性數」決定樹果數的那張表 ——
   遊戲技能頁有，上游快照沒有。同樣是 repo 自己維護、重建時不能弄丟。
   `_` 開頭的鍵是註解，不寫進 data。 */
const msExtraRaw = JSON.parse(readFileSync(resolve(ROOT, 'tools/skills-extra.json'), 'utf8'));
data.msExtra = {};
for (const [k, v] of Object.entries(msExtraRaw)) {
  if (k.startsWith('_')) continue;
  if (!data.ms[k]) throw new Error('tools/skills-extra.json 提到不存在的主技能：' + k);
  data.msExtra[k] = Object.fromEntries(Object.entries(v).filter(([kk]) => !kk.startsWith('_')));
}

data.meta = {
  // 資料結構版本。app.js 有一份 SCHEMA 常數會斷言它相等 —— 兩者不合就顯示「請重新整理」，
  // 避免瀏覽器拿到「新 app.js ＋ 舊 game.json」這種偏移組合而算出錯的數字。
  // 動到欄位結構（改名／改型別／移除）時，這裡和 app.js 的 SCHEMA 要一起 +1。
  schema: 5,
  src: 'nerolis-lab/nerolis-lab', commit, commitDate,
  builtAt: new Date().toISOString().slice(0, 10),
  zhSrc: 'RaenonX i18n + 52poke zh-hant',
  typesSrc: '由樹果推導（Pokémon Sleep 每隻只有一個屬性，就是牠撿的樹果的屬性；'
          + '18 顆樹果對 18 個屬性，來源是上游 berries.ts 的 Berry.type）',
  msExtraSrc: 'tools/skills-extra.json（本專案維護 —— 上游快照沒有這些表）',
};

/* ---- 缺漏報告：絕對不要自創中文名，缺就留英文並記錄 ---- */
const gaps = {
  pokemon: missP,
  recipes: missR,
  mainskills: Object.keys(data.ms).filter((k) => !data.zh.ms[k]),
  subskills: data.subskills.map((s) => s.n).filter((n) => !data.zh.subskills[n]),
  islands: data.islands.map((i) => i.n).filter((n) => !data.zh.islands[n]),
  types: TYPE_NAMES.filter((t) => !data.zh.types || !data.zh.types[t]),
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
