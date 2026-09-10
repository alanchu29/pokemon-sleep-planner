"use strict";
/* UI 與持久層。引擎在 src/engine.js，由 index.html 的 loader 在這個檔之前注入 —— 
   所以 D / ING_NAME / scoreTeam / buildPool 這些名字在這裡直接可用（同為 classic
   script，共用全域作用域）。這個檔不要自己宣告 D，會和 engine.js 撞成 SyntaxError。

   app.js 刻意是 classic script（不是 module）—— 頂層宣告必須留在全域，
   tests/smoke.mjs 靠 page.evaluate 直接驅動 roster / run() / scoreTeam()。 */
const $ = id => document.getElementById(id);

/* 使用者可見文案裡提到的檔案路徑與指令，一律從這裡取，不要寫死在字串裡。

   為什麼：拆檔的時候踩過一次 —— UI 還在教使用者「替換 index.html 裡的
   <script id="gamedata">」，但那個區塊早就不存在了。這種「文案描述了不存在的
   東西」的 bug 讀程式碼看不出來，只有截圖才會發現。

   tests/smoke.mjs 的「文案一致性」那一節會斷言：PATHS.files 裡的每個路徑
   在 repo 裡真的存在、PATHS.cmds 裡的每個指令真的定義在 package.json。
   改檔名或改 npm script 時，測試會逼你連文案一起改。 */
const PATHS = {
  files: {
    data:   'data/game.json',
    app:    'src/app.js',
    engine: 'src/engine.js',
    worker: 'src/engine.worker.js',
    import: 'src/import.js',
    html:   'index.html',
  },
  cmds: {
    rebuild: 'npm run data',
    serve:   'npm run serve',
    test:    'npm test',
  },
};
const P = PATHS.files, C = PATHS.cmds;
const code = s => `<code>${s}</code>`;
/** HTML escape。
 *  寶可夢的**暱稱**是這支程式裡唯一會進 innerHTML 的使用者輸入 —— 其他插值全部
 *  來自 `game.json`。不 escape 的話，暱稱裡一個 `"` 就會把 `value="…"` 屬性打斷、
 *  一個 `<` 就是直接注入標記。而暱稱會經由 Sheet 同步到別的裝置。 */
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* 資料結構版本。`data/game.json` 的 meta.schema 必須等於這個值。
   動到欄位結構（改名／改型別／移除）時兩邊一起 +1；純數值更新不用動。

   為什麼需要這個：拆檔之後 app.js 與 game.json 是兩個獨立快取的資源，
   GitHub Pages 送 max-age=600，所以更新後有最多 10 分鐘的窗口，瀏覽器可能
   拿到「新 app.js ＋ 舊 game.json」。純數值過期還好，結構變了就會算出錯的
   數字或直接壞掉 —— 而使用者只會看到壞頁面，不知道重新整理就好。 */
const SCHEMA = 4;   // 4: 新增 msExtra{}（上游沒有的主技能數值表，目前是流星群的基礎樹果表）

/* 這一份 app.js 的資源版本。必須等於 index.html 裡的 ASSET_V（以及 app.css 的 ?v=）。
   動到 app.css 或 src/*.js 就三個地方一起往前推。

   為什麼需要：app.css / app.js 沒有 game.json 那種資料版本可以比對，實際踩過兩次
   「新的 index.html ＋ 舊的 app.js」—— 畫面畫出舊版 UI，而使用者只會覺得
   「你根本沒改」，完全不知道是快取。有了這個斷言，過期的 app.js 會直接被擋下來
   並要求強制重新整理。tests/smoke.mjs 第 11 節會斷言三處一致。 */
const APP_V = '20260910b';

/** 致命錯誤：整頁換成一段說明。這種狀況下繼續跑只會產生錯的數字。 */
function fatal(html){
  const w = document.querySelector('.wrap');
  if (w) w.innerHTML = `<section><h1 style="margin:0 0 10px">無法啟動</h1><p class="muted">${html}</p></section>`;
  throw new Error('fatal: ' + html.replace(/<[^>]*>/g, ''));
}
/* 只有 window.ASSET_V 存在（＝新版載入器）時才比對。舊的載入器沒有設這個，
   那種情況下 index.html 本身也是舊的，跟著它的 app.js 就是對的一組。 */
if (window.ASSET_V && window.ASSET_V !== APP_V){
  fatal(`程式檔的版本不一致（<code>index.html</code> 要 <code>${window.ASSET_V}</code>，`
      + `但載到的 ${code(P.app)} 是 <code>${APP_V}</code>）。`
      + `這是瀏覽器快取到舊的程式檔 —— 請<b>強制重新整理</b>（Ctrl+Shift+R，Mac 是 Cmd+Shift+R）。`);
}
if (!D || !D.meta || D.meta.schema !== SCHEMA){
  fatal(`遊戲資料的版本和程式不符（資料 <code>schema=${D && D.meta ? D.meta.schema : '?'}</code>，程式預期 <code>${SCHEMA}</code>）。`
      + `這通常是瀏覽器快取到一半新一半舊 —— 請<b>強制重新整理</b>（Ctrl+Shift+R，Mac 是 Cmd+Shift+R）。`
      + `如果重新整理還是一樣，那就是 ${code(P.data)} 和 ${code(P.app)} 沒有一起更新。`);
}
const Z = D.zh || {};
const bz  = k => (Z.berries   && Z.berries[k])   || k;
const iz  = k => (Z.ings      && Z.ings[k])      || k;
const pz  = p => (Z.pk        && Z.pk[p.n])      || p.d;
const isl = n => (Z.islands   && Z.islands[n])   || n;
const msz = n => (Z.ms        && Z.ms[n])        || n;
const ssz = n => (Z.subskills && Z.subskills[n]) || n;
const sss = n => (Z.ssShort   && Z.ssShort[n])   || (SS[n] ? SS[n].s : n);
const SPEC_ZH = {berry:"樹果",ingredient:"食材",skill:"技能",all:"全能"};
/* 專長 → CSS 類名。刻意不是 p.sp 本身：app.css 的類是 .tag.ing，不是 .tag.ingredient，
   直接用 p.sp 會拿到一個不存在的類（沒有顏色，而且看不出來壞了）。 */
const SPEC_TAG = {berry:"berry",ingredient:"ing",skill:"skill",all:"all"};
/** 睡眠緞帶的標籤。索引就是 m.ribbon，對應 engine.js 的 RIBBON_CARRY。 */
const RIBBON_LABEL = ['無','200h','500h','1000h','2000h'];
const NAT_AB = {speed:"速度",ingredient:"食材",skill:"技能",energy:"活力",exp:"EXP"};
const natZ = n => (Z.natures && Z.natures[n.n]) || n.n;
/* 無修正的性格在資料裡是字串 `'neutral'`，**不是空值** —— 而 `'neutral'` 是 truthy。
   所以 `n.p ? NAT_AB[n.p] : ...` 會走進 true 分支拿到 undefined，畫面變成
   「害羞 +undefined −undefined」。25 種性格裡有 5 種是這樣（害羞／勤奮／坦率／
   浮躁／認真），而性格選單和摺疊列都中。實際踩過。
   對照表查不到的鍵就顯示原始鍵 —— 也不要變成 undefined。 */
const natAb = k => NAT_AB[k] || String(k);
const natMod = n => (n.p && n.p !== 'neutral') ? {up: natAb(n.p), dn: natAb(n.m)} : null;
const natLabel = n => { const d = natMod(n); return natZ(n) + (d ? ` +${d.up} −${d.dn}` : ' 無修正'); };
const recipeZh = n => (Z.recipes && Z.recipes[n]) || n.split('_').map(w=>w[0]+w.slice(1).toLowerCase()).join(' ');
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e4 ? Math.round(n/1e3)+'k' : Math.round(n).toLocaleString();
const f1 = n => (Math.round(n*10)/10).toFixed(1);


/* ================= STATE ================= */
/* `nick` = 你在遊戲裡自己取的名字。純標籤，完全不參與計算 —— 引擎連看都不看它。
   存在的理由：截圖上顯示的就是暱稱，而遊戲的詳細頁**沒有物種名**，所以你認得的
   是「樹果萌萌」而不是「嘎啦嘎啦」。空字串就退回物種名。 */
const NICK_MAX = 24;
const BLANK = () => ({sp: D.dex.findIndex(p=>p.n==='PIKACHU'), level:30, nature:'Bashful', ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:1, ribbon:0, nick:'', pin:false, ex:false});
let roster = [];
let wk = {island:'greengrass', fav:new Set(), areaBonus:15, pot:57, sleepH:8.5, camp:0, collectH:DEFAULT_COLLECT_H, mode:'total', dishType:'curry', recipeName:null, recipeLv:20, recipePick:'auto', recipeScope:'type', recipeLevels:{}, strictBerry:true};
let lastResults = null, shownAlt = 0;
/* 自組隊伍（見檔案後段的「自組隊伍」那一區）。**宣告放在這裡而不是那一區旁邊** ——
   `deserialize` 會呼叫 `teamsReset()`，而它在前段；`let` 不會提升，宣告留在後面就有
   TDZ 風險（和陷阱 1 的 `$` 同一類）。函式本身是 function 宣告，會提升，留在後面沒問題。 */
const TEAMS_MAX = 4;
const newTeam = () => ({members:[null,null,null,null,null], result:null});
let teams = [newTeam()];
let teamShown = 0;
let picker = null;                       // {t, s} = 正在挑「隊伍 t 的第 s 格」
let pickerQ = '', pickerSpec = '';

/* ================= PERSISTENCE ================= */
/* One codebase, two backends:
   - inside a claude.ai artifact -> the artifact's own database
   - self-hosted (GitHub Pages etc.) -> the user's Google Sheet via Apps Script
   localStorage is always written as an offline copy in both cases. */
let dbRef = null, dbObj = null;
let sync = {url:'', token:'', on:false};
const statusEl = document.getElementById('saveStatus');
function setStatus(t){ statusEl.textContent = t; }
function setSyncStatus(t){ const e = $('syncStatus'); if (e) e.textContent = t; }

function serialize(){
  return {roster: roster.map(m=>({sp:D.dex[m.sp].n, level:m.level, nature:m.nature, ss:m.ss, ingSet:m.ingSet, skillLv:m.skillLv, ribbon:m.ribbon, nick:m.nick||'', pin:!!m.pin, ex:!!m.ex})),
          wk: {...wk, fav:[...wk.fav], recipe:undefined}, updatedAt: new Date().toISOString(), v:1};
}
/** 還原一份 serialize() 的輸出。
 *
 *  `opts.append`：只把 roster **接在現有的後面**，不動 wk。分批建箱子時要的是這個
 *  —— 一次貼一隻卻把整箱換掉，會把前面輸入的都吃掉。雲端同步與開機還原走的是
 *  預設的「整份取代」，不要改。 */
function deserialize(o, opts){
  if (!o) return {badSp: []};
  const badSp = [];
  const revive = r => ({...BLANK(), ...r, sp: reviveSp(r.sp, badSp),
    ss:(r.ss||[null,null,null,null,null]).slice(0,5), ingSet:(r.ingSet||[0,0,0]).slice(0,3),
    // 舊資料沒有 nick，非字串（數字暱稱之類）也要正規化 —— 它會被塞進 HTML
    nick: typeof r.nick === 'string' ? r.nick.slice(0, NICK_MAX) : (r.nick == null ? '' : String(r.nick).slice(0, NICK_MAX))});
  if (Array.isArray(o.roster)){
    const incoming = o.roster.map(revive);
    roster = (opts && opts.append) ? roster.concat(incoming) : incoming;
    /* 整批取代 → 一定要清掉展開狀態。`monOpen` 存的是 roster 索引，而這裡把
       整個 roster 換掉了 —— 留著就會展開到「剛好是同一個索引」的那一隻身上
       （從雲端下載、JSON「取代」匯入都會走到這）。和 del 之後要 clear 同一個
       理由，見 CLAUDE.md「刪除之後的展開狀態」。append 不動舊的索引，所以不清。 */
    if (!(opts && opts.append)) { monOpen.clear(); teamsReset(); }
  }
  if (o.wk && !(opts && opts.append)){
    const f = o.wk.fav||[];
    wk = {...wk, ...o.wk, fav:new Set(f), recipeLevels:reviveRecipeLevels(o.wk.recipeLevels)};
  }
  return {badSp};
}
/** 還原食譜等級。**等級的有無就是解鎖狀態**（見 engine 的 `recipeOn`），所以這裡
 *  的正規化不只是整潔問題 —— 一個 `"20"` 字串會讓那道食譜**靜靜地從推演裡消失**。
 *
 *  舊語意下沒填的會退回 `wk.recipeLv`，髒值頂多讓等級不準；改成「沒填 ＝ 沒解鎖」
 *  之後，同一個髒值的後果變成「那道菜整個不見」。**改動讓既有失效模式變嚴重時，
 *  就要在入口補一道正規化。**
 *
 *  認得的：數字、以及看得出是數字的字串（Sheet／舊 JSON 都可能出現）。
 *  其餘（0、負數、null、NaN）一律當成沒解鎖 —— 那本來就是它們的意思。 */
function reviveRecipeLevels(src){
  const out = {};
  for (const [k, v] of Object.entries(src || {})){
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (Number.isFinite(n) && n >= 1) out[k] = Math.min(70, Math.max(1, Math.round(n)));
  }
  return out;
}
/** 還原 `sp`。`serialize()` 寫的是**內部名**（`VENUSAUR`），這是唯一穩定的形式。
 *
 *  以前認不出來就靜靜退回索引 0 —— 一份用圖鑑索引寫的 JSON 會讓**每一隻都變成
 *  妙蛙種子**，而畫面上沒有任何提示。實際踩過（2026-09-08）。所以現在兩件事都做：
 *
 *  1. **整數當 dex 索引接受**，因為 `impSolve` 產出的就是索引。注意索引只在同一份
 *     `data/game.json` 快照裡穩定，重建資料可能位移 —— 但沒有任何地方會**寫出**
 *     索引（`serialize` 一律寫名字），所以風險只在貼上那一瞬間。
 *  2. 真的認不出來就記進 `badSp` 讓呼叫端**講出來**，不要默默給一隻錯的。 */
function reviveSp(v, bad){
  if (Number.isInteger(v) && v >= 0 && v < D.dex.length) return v;
  const i = D.dex.findIndex(p=>p.n===v);
  if (i >= 0) return i;
  bad.push(String(v));
  return 0;
}
/** A human-readable mirror of the roster, so the Sheet is worth opening. */
function rosterTable(){
  /* 暱稱放第一欄 —— 直接開 Sheet 的時候，你認得的就是自己取的名字。 */
  const head = ['暱稱','種類','圖鑑','等級','性格','副技能1','副技能2','副技能3','副技能4','副技能5','食材1','食材2','食材3','技能Lv','主技能','緞帶','固定','排除'];
  const rows = roster.map(m=>{
    const p = D.dex[m.sp];
    // 和 UI 共用 ingPick()，順便避開 ING_NAME[null] 會寫出 "undefined×0" 的問題
    const ings = [0,1,2].map(k=>{
      const pick = ingPick(m, k);
      if (!pick) return '';
      return (pick[0] != null ? iz(ING_NAME[pick[0]]) : '（無）') + '×' + pick[1];
    });
    return [(m.nick||'').trim(), pz(p), p.no, m.level, natZ(NAT[m.nature]||NAT.Bashful),
            ...[0,1,2,3,4].map(i=>m.ss[i] ? ssz(m.ss[i]) : ''),
            ...ings, m.skillLv, msz(p.ms), RIBBON_LABEL[m.ribbon||0], m.pin?'是':'', m.ex?'是':''];
  });
  return [head, ...rows];
}

/* ---- 「資料存在哪裡」的單一來源 ----
   `serialize()` 存的**不只是寶可夢箱** —— 本週條件與個別設定的食譜等級都在同一份
   payload 裡（`wk.recipeLevels`），所以三個後端都會一起同步。

   但原本三處文案（同步面板標題、同步面板說明、版本面板）都只寫「寶可夢箱」，
   結果使用者以為食譜等級是本機的、換裝置要重填 78 道 —— 實際踩過（使用者直接問）。
   食譜等級那一頁根本沒講。所以集中在這裡，四個地方都取同一句，跟 `PATHS` 一樣。 */
const SYNCED_WHAT = '寶可夢箱、本週條件、以及個別設定的食譜等級';
/* 目前實際生效的後端，由 boot() 決定：'artifact' | 'sheet' | 'local'。
   **刻意不從 `window.claude` / `sync.on` 推斷** —— 那兩個只代表「有設定」，
   連不上的時候推斷出來的答案就是假的，而這句話正是使用者用來決定「要不要設定
   同步」的依據。連不上就得老實說只在本機。 */
let backend = 'local';
function storageWhere(){
  if (backend === 'artifact') return {short: 'artifact 資料庫',
    html: `${SYNCED_WHAT}都存在這個 artifact 的<b>雲端資料庫</b>，改一格就自動存 —— `
        + `換裝置開同一個 artifact 就會看到一樣的內容。`};
  if (backend === 'sheet') return {short: '你的 Google Sheet',
    html: `${SYNCED_WHAT}都存在<b>你的 Google Sheet</b>，改一格就自動上傳 —— `
        + `換裝置只要把 Apps Script 網址與存取金鑰填一次（那兩個是每台瀏覽器各自存的），其餘會自己同步下來。`};
  return {short: '只有這台瀏覽器',
    html: `${SYNCED_WHAT}目前<b>只存在這台瀏覽器</b>（localStorage）—— 換裝置或清掉瀏覽器資料就沒了。`
        + (window.claude ? '' : '要跨裝置請到「寶可夢箱」頁面設定<b>雲端同步</b>。')};
}
/* 三處文案都在這裡寫，包括版本面板的那一行 —— 不然停用同步之後版本面板還會停在
   「存在你的 Google Sheet」（`renderVersion()` 沒被重跑）。 */
function renderStorageNote(){
  const s = storageWhere();
  const a = $('rlvWhere'); if (a) a.innerHTML = s.html;
  const b = $('syncWhat'); if (b) b.innerHTML = `會一起同步的是：<b>${SYNCED_WHAT}</b>。`;
  const d = $('scoreNote');
  if (d){
    d.innerHTML = scoreNote();
    /* innerHTML 每次都重建，所以摺疊狀態要自己記 —— 這個函式在同步成功時會重跑。 */
    const ex = d.querySelector('details.more');
    if (ex) ex.addEventListener('toggle', () => { scoreNoteOpen = ex.open; });
  }
  const c = $('verBuild');
  if (c) c.textContent = (window.claude ? 'claude.ai artifact 版本' : '自架版本（GitHub Pages 等）')
                       + ' · 資料存在：' + s.short;
}

/* ---- Google Sheet backend ---- */
function loadSyncConfig(){
  try {
    sync.url = localStorage.getItem('psleep-sync-url') || '';
    sync.token = localStorage.getItem('psleep-sync-token') || '';
    sync.on = !!(sync.url && sync.token);
  } catch(e){}
}
function saveSyncConfig(){
  try {
    localStorage.setItem('psleep-sync-url', sync.url);
    localStorage.setItem('psleep-sync-token', sync.token);
  } catch(e){}
}
/* ---- 一次性設定連結（`#sync=…&token=…`）----
   換裝置原本要手動貼兩個欄位，而那組網址是 Apps Script 的 `.../exec`，
   長得幾乎沒辦法用手打。所以「複製同步連結」把兩者包成一條網址：在新裝置上
   開那條連結就等於填好了。

   **參數一定放在 hash（`#`）而不是 query（`?`）。** 金鑰是這個後端唯一的憑證，
   而 hash 不會送到伺服器 —— query 會進 GitHub Pages（或任何靜態主機）的存取
   記錄。為了容錯兩種都讀得進來，但產生出來的一律是 hash。

   讀完立刻 `history.replaceState` 把參數拿掉：金鑰不該留在網址列上被截圖、
   被複製、或留在瀏覽器歷史裡。

   **和現有設定不同就不自動套用。** 一條連結能改掉資料的目的地，換掉之後本機
   的改動會開始往別人的 Sheet 上傳、自己那份停在舊版 —— 跟「刪除沒有 undo」
   同一類的不可逆。所以只有「本機還沒設定」或「和現在完全相同」才直接套用
   （那正是換裝置的實際情境，沒有東西會被蓋掉）；不同就只填欄位並警告，
   要使用者自己確認再按「連線並下載」。 */
function parseSyncLink(){
  const pick = s => {
    if (!s || s.length < 2) return null;
    const q = new URLSearchParams(s.slice(1));
    const url = (q.get('sync') || '').trim(), token = (q.get('token') || '').trim();
    return (url || token) ? {url, token} : null;
  };
  return pick(location.hash) || pick(location.search);
}
/* 只清掉我們自己的兩個鍵。hash 也可能是別人的（將來加了 `#view-box` 之類），
   所以沒有我們的鍵就整段原封不動 —— 否則 URLSearchParams 會把它重寫成 `x=`。 */
function stripSyncLink(){
  try {
    const clean = (s, sep) => {
      if (!s || s.length < 2) return '';
      const q = new URLSearchParams(s.slice(1));
      if (!q.has('sync') && !q.has('token')) return s;
      q.delete('sync'); q.delete('token');
      const r = q.toString();
      return r ? sep + r : '';
    };
    history.replaceState(null, '',
      location.pathname + clean(location.search, '?') + clean(location.hash, '#'));
  } catch(e){}
}
function buildSyncLink(){
  return location.origin + location.pathname
       + '#sync=' + encodeURIComponent(sync.url) + '&token=' + encodeURIComponent(sync.token);
}
const linkHost = u => { try { return new URL(u).host; } catch(e){ return u.slice(0, 40); } };
/** 網址列帶了設定 → 套用或警告。回傳要顯示的訊息（沒帶就是 null）。 */
function applySyncLink(){
  const link = parseSyncLink();
  if (!link) return null;
  stripSyncLink();
  if (!link.url || !link.token)
    return {warn: true, html: '連結裡的同步設定<b>不完整</b>（要同時有網址與金鑰），已忽略。'};
  if (link.url === sync.url && link.token === sync.token)
    return {warn: false, html: '連結裡的同步設定和這台裝置現有的<b>相同</b>，不需要做什麼。'};
  if (sync.url || sync.token)
    return {warn: true, fill: link,
      html: `連結裡的同步設定和這台裝置<b>現有的不同</b>（連結指向 <code>${esc(linkHost(link.url))}</code>）—— `
          + `已填入下面的欄位但<b>還沒套用</b>。套用之後這台裝置的改動就會上傳到連結指定的那份，`
          + `確認是你自己的網址再按「連線並下載」。`};
  sync.url = link.url; sync.token = link.token; sync.on = true;
  saveSyncConfig();
  return {warn: false, html: `已從連結帶入同步設定（<code>${esc(linkHost(link.url))}</code>），正在連線。`};
}
function showSyncLinkNote(m){
  const e = $('syncLinkNote'); if (!e) return;
  e.innerHTML = m.html;
  e.classList.toggle('warn', !!m.warn);
  e.hidden = false;
}

async function sheetGet(){
  const u = sync.url + (sync.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(sync.token);
  const res = await fetch(u, {method:'GET', redirect:'follow'});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.data || null;
}
async function sheetPut(payload){
  // text/plain keeps this a "simple request" — Apps Script does not answer CORS preflight
  const res = await fetch(sync.url, {method:'POST', redirect:'follow',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify({token: sync.token, data: payload, table: rosterTable()})});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j;
}

/* 自動同步：改任何一格就寫 localStorage（同步、不會失敗），再防抖 900ms 上傳雲端。
   900ms 是刻意的 —— 連續改五格只上傳一次，不會打 Apps Script 五次。

   `dirty` / `pending` 存在的理由是兩個真實的漏洞：
   1. 改完立刻關分頁：那次上傳還在等防抖，就永遠不會送出 —— localStorage 有、
      雲端停在上一版。所以 `pagehide` 與 `visibilitychange` 會把它立刻沖出去。
   2. 上傳失敗不會自己好：以前失敗就停在那，除非使用者又改了什麼。現在 `dirty`
      會留著，回到這個分頁（visibilitychange）或下一次 save 都會重試。
   上傳的是**完整快照**，所以重試不需要合併，最後一次寫入就是正確結果。 */
let saveTimer = null, savePending = null, saveDirty = false;
function save(){
  const payload = serialize();
  try { localStorage.setItem('psleep-box', JSON.stringify(payload)); } catch(e){}
  savePending = payload;
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 900);
}
async function flushSave(){
  clearTimeout(saveTimer); saveTimer = null;
  if (!saveDirty || !savePending) return;
  const payload = savePending;
  if (dbRef){
    try { await dbRef.set(payload); saveDirty = false; setStatus('已同步'); }
    catch(e){ setStatus('同步失敗（本機已存）'); }
  } else if (sync.on){
    setStatus('上傳中…');
    try {
      await sheetPut(payload);
      saveDirty = false;
      setStatus('已同步 Sheet');
      setSyncStatus('已上傳 ' + new Date().toLocaleTimeString('zh-TW'));
    } catch(e){
      setStatus('Sheet 同步失敗（本機已存）');
      setSyncStatus('上傳失敗：' + e.message + '（回到這個分頁時會重試）');
    }
  } else {
    saveDirty = false;   // 沒有任何後端，localStorage 就是全部
  }
}
/* 刻意不檢查 visibilityState：切到背景要沖出去，切回來要重試失敗的那次，
   兩件事都想要。`pagehide` 覆蓋關閉分頁與手機切換 app。 */
document.addEventListener('visibilitychange', flushSave);
window.addEventListener('pagehide', flushSave);

async function boot(){
  loadSyncConfig();
  const selfHosted = !window.claude;
  /* artifact 版本用的是 artifact 自己的資料庫，Sheet 設定根本不會生效 —— 所以
     不套用，但**還是要把參數清掉**，不然金鑰就留在網址列上。 */
  const linkMsg = selfHosted ? applySyncLink() : (stripSyncLink(), null);
  try { const raw = localStorage.getItem('psleep-box'); if (raw) deserialize(JSON.parse(raw)); } catch(e){}
  if (selfHosted && $('syncSection')) $('syncSection').hidden = false;
  if ($('syncUrl')){
    // 「和現有不同」那條路徑刻意顯示連結裡的值（等使用者確認），不是現有的值
    const f = (linkMsg && linkMsg.fill) || sync;
    $('syncUrl').value = f.url; $('syncToken').value = f.token;
  }
  if (linkMsg) showSyncLinkNote(linkMsg);
  renderAll();

  const db = await (window.claude && window.claude.use ? window.claude.use('db') : Promise.resolve(null));
  if (db){
    dbObj = db;
    dbRef = db.doc('box/main');
    try {
      const snap = await dbRef.get();
      if (snap.exists) { deserialize(snap.data()); backend = 'artifact'; renderAll(); setStatus('已同步'); }
      else { await dbRef.set(serialize()); backend = 'artifact'; setStatus('已同步'); }
    } catch(e){ setStatus('只存在這台裝置'); }
    renderStorageNote();      // 連上了才敢說存在雲端 —— 上面 catch 到就維持 'local'
    Promise.all([db.doc('meta/status').get(), db.doc('meta/refresh').get()]).then(([st,rq])=>{
      if (st.exists) metaStatus = st.data();
      if (rq.exists) metaReq = rq.data();
      renderVersion();
    }).catch(()=>{});
    return;
  }

  if (sync.on){
    setStatus('連線 Sheet…'); setSyncStatus('連線中…');
    try {
      const remote = await sheetGet();
      const localRaw = localStorage.getItem('psleep-box');
      const local = localRaw ? JSON.parse(localRaw) : null;
      // last write wins
      if (remote && (!local || !local.updatedAt || (remote.updatedAt || '') >= local.updatedAt)){
        deserialize(remote); backend = 'sheet'; renderAll();
        setStatus('已同步 Sheet'); setSyncStatus('已下載雲端版本（' + (remote.updatedAt||'').slice(0,16).replace('T',' ') + '）');
      } else if (local){
        await sheetPut(local); backend = 'sheet';
        setStatus('已同步 Sheet'); setSyncStatus('本機較新，已上傳');
      } else {
        backend = 'sheet';
        setStatus('已同步 Sheet'); setSyncStatus('雲端為空');
      }
    } catch(e){
      setStatus('Sheet 連線失敗（用本機資料）'); setSyncStatus('連線失敗：' + e.message);
    }
    renderStorageNote();
  } else {
    setStatus('只存在這台裝置');
    setSyncStatus(selfHosted ? '尚未設定' : '');
  }
}

/* ---- sync panel wiring ---- */
if ($('syncPull')){
  const readFields = ()=>{
    sync.url = $('syncUrl').value.trim();
    sync.token = $('syncToken').value.trim();
    sync.on = !!(sync.url && sync.token);
    saveSyncConfig();
  };
  /* backend 只在**真的成功往返過**之後才改成 'sheet' —— 填了欄位不等於連得上。 */
  const sheetOk = ()=>{ backend = 'sheet'; renderStorageNote(); };
  $('syncPull').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('連線中…');
    try {
      const remote = await sheetGet();
      if (remote){ deserialize(remote); sheetOk(); renderAll(); setSyncStatus('已下載（' + (remote.roster||[]).length + ' 隻）'); setStatus('已同步 Sheet'); }
      else { sheetOk(); setSyncStatus('連線成功，但雲端還是空的 —— 按「立即上傳」把本機資料推上去'); }
    } catch(e){ setSyncStatus('連線失敗：' + e.message); }
  });
  $('syncPush').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('上傳中…');
    try { await sheetPut(serialize()); sheetOk(); setSyncStatus('已上傳 ' + roster.length + ' 隻'); setStatus('已同步 Sheet'); }
    catch(e){ setSyncStatus('上傳失敗：' + e.message); }
  });
  /* 產生一次性設定連結。clipboard API 需要安全內容（https 或 localhost）＋使用者
     手勢，失敗就把連結攤在一個 input 裡讓他自己複製 —— 不然在 http 的本機
     server 上這顆按鈕會看起來壞掉。 */
  $('syncLink').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填才能產生連結'); return; }
    const link = buildSyncLink();
    try {
      await navigator.clipboard.writeText(link);
      $('syncLinkOut').hidden = true;
      setSyncStatus('已複製 —— 這條連結等於金鑰本身，不要貼到公開的地方');
    } catch(e){
      $('syncLinkOut').value = link;
      $('syncLinkOut').hidden = false;
      $('syncLinkOut').select();
      setSyncStatus('無法自動複製（需要 https），請手動複製下面那一行');
    }
  });
  $('syncOff').addEventListener('click', ()=>{
    sync = {url:'', token:'', on:false};
    $('syncUrl').value = ''; $('syncToken').value = '';
    $('syncLinkOut').hidden = true;
    if ($('syncLinkNote')) $('syncLinkNote').hidden = true;
    backend = 'local';
    saveSyncConfig(); renderStorageNote();
    setSyncStatus('已停用，資料只留在這台瀏覽器'); setStatus('只存在這台裝置');
  });
}

/* ================= UI: weekly ================= */
/* 週設定改動 → 存檔，**而且自組隊伍分頁開著的話立刻重算**。
   單隊 `scoreTeam` 是毫秒級，便宜到沒有不重算的道理，而「改個鍋容量看數字怎麼變」
   正是那個分頁的用途之一。推演結果刻意**不**自動重跑 —— 那是 3 萬組，得使用者自己按。 */
function weeklyChanged(){
  save();
  if (!$('view-team').hidden) renderTeamsView();
}
function buildWeekly(){
  $('island').innerHTML = D.islands.map(i=>`<option value="${i.s}">${isl(i.n)}</option>`).join('');
  $('favBerries').innerHTML = BERRY_NAMES.map(b=>`<button type="button" class="chip" data-berry="${b}" aria-pressed="false" title="${b.toLowerCase()}">${bz(b)}</button>`).join('');
  $('favBerries').addEventListener('click', e=>{
    const b = e.target.closest('[data-berry]'); if (!b) return;
    const k = b.dataset.berry;
    if (wk.fav.has(k)) wk.fav.delete(k); else wk.fav.add(k);
    syncWeeklyUI(); weeklyChanged();
  });
  $('island').addEventListener('change', e=>{
    wk.island = e.target.value;
    const isl = D.islands.find(i=>i.s===wk.island);
    if (isl && isl.b.length){ wk.fav = new Set(isl.b); }
    syncWeeklyUI(); weeklyChanged();
  });
  $('dishType').addEventListener('change', e=>{ wk.dishType = e.target.value; wk.recipeName = null; fillRecipes(); weeklyChanged(); });
  $('recipe').addEventListener('change', e=>{ wk.recipeName = e.target.value; syncRecipeIngs(); weeklyChanged(); });
  for (const [id, key, num] of [['areaBonus','areaBonus',1],['pot','pot',1],['sleepH','sleepH',1],['collectH','collectH',1],['recipeLv','recipeLv',1],['camp','camp',1]]){
    $(id).addEventListener('change', e=>{ wk[key] = num ? Number(e.target.value) : e.target.value; weeklyChanged(); });
  }
  $('mode').addEventListener('change', e=>{ wk.mode = e.target.value; weeklyChanged(); });
  $('recipePick').addEventListener('change', e=>{ wk.recipePick = e.target.value; syncWeeklyUI(); weeklyChanged(); });
  $('recipeScope').addEventListener('change', e=>{ wk.recipeScope = e.target.value; syncWeeklyUI(); weeklyChanged(); });
  $('strictBerry').addEventListener('change', e=>{ wk.strictBerry = e.target.checked; weeklyChanged(); });
  $('runBtn').addEventListener('click', run);
}
/* option 只放名稱與食材數。完整食材清單放在 select 下方的 #recipeIngs ——
   最長的食譜（絕對睡眠奶油咖哩）連食材清單要 555px，而這一欄就算 span2 也只有
   約 320px，塞進 option 會被裁掉，而被裁掉的資訊等於沒有。 */
function fillRecipes(){
  /* **只列已解鎖的。** 選得到卻煮不出來就是自相矛盾 —— 推演會把它排除，畫面上
     卻還寫著「指定食譜：某某」，那是最糟的一種文案說謊。 */
  const list = D.recipes.filter(r=>r.t===wk.dishType && recipeOn(r, wk)).sort((a,b)=>a.cnt-b.cnt);
  $('recipe').innerHTML = list.length
    ? list.map(r=>`<option value="${r.n}">${recipeZh(r.n)}（${r.cnt} 材）</option>`).join('')
    : `<option value="">（這個類型還沒有解鎖任何食譜）</option>`;
  if (!wk.recipeName || !list.some(r=>r.n===wk.recipeName)){
    const pick = list.find(r=>r.cnt>=21) || list[list.length-1];
    wk.recipeName = pick ? pick.n : null;
  }
  $('recipe').value = wk.recipeName || '';
  syncRecipeIngs();
}
function syncRecipeIngs(){
  const r = D.recipes.find(x=>x.n===wk.recipeName);
  $('recipeIngs').textContent = r
    ? r.ings.map(([i,a])=>iz(ING_NAME[i])+'×'+a).join('・') + `（共 ${r.cnt}）`
    : '';
}
function syncWeeklyUI(){
  $('island').value = wk.island; $('areaBonus').value = wk.areaBonus; $('pot').value = wk.pot;
  $('sleepH').value = wk.sleepH; $('camp').value = wk.camp; $('mode').value = wk.mode;
  /* 舊資料沒有 collectH —— deserialize 的 {...wk, ...o.wk} 會保留預設值，這裡只是畫出來 */
  $('collectH').value = wk.collectH != null ? wk.collectH : DEFAULT_COLLECT_H;
  $('dishType').value = wk.dishType; $('recipeLv').value = wk.recipeLv;
  $('recipePick').value = wk.recipePick; $('recipeScope').value = wk.recipeScope;
  $('strictBerry').checked = wk.strictBerry !== false;
  syncRecipeCount();
  const auto = wk.recipePick === 'auto';
  $('recipe').disabled = auto;
  $('recipe').style.opacity = auto ? .5 : 1;
  $('recipeAutoNote').textContent = auto ? '（自動模式下由推演決定，這裡只是備援）' : '';
  $('recipeIngs').style.opacity = auto ? .5 : 1;
  $('dishType').disabled = auto && wk.recipeScope === 'all';
  for (const el of $('favBerries').querySelectorAll('[data-berry]'))
    el.setAttribute('aria-pressed', wk.fav.has(el.dataset.berry) ? 'true' : 'false');
  fillRecipes();
}

/* ================= UI: box ================= */
/* 種類選單刻意只放「中文名 #圖鑑號」。之前塞了英文名、專長、樹果，結果在實際寬度下
   整串被裁成「大食花　#71 Vi…」—— 被裁掉的資訊等於沒有。專長／樹果／主技能改成
   卡片上的獨立標籤（也才能拿來篩選）。打中文名跳選照樣可用，因為中文名在最前面。 */
const SPECIES_OPTS = D.dex.map((p,i)=>`<option value="${i}">${pz(p)}　#${p.no}</option>`).join('');
const NATURE_OPTS = D.natures.map(n=>`<option value="${n.n}">${natLabel(n)}</option>`).join('');
/* 副技能用**全名**，不用縮寫 —— 這一欄要「完全顯示」，卡片版面已經給足寬度。 */
const SS_OPTS = `<option value="">—</option>` + D.subskills.map(s=>`<option value="${s.n}">${ssz(s.n)}</option>`).join('');
/** 某一格目前選中的 [食材索引, 數量]；沒有就 null。 */
function ingPick(m, slot){
  const p = D.dex[m.sp], list = [p.i0, p.i30, p.i60][slot] || [];
  return list[Math.min(m.ingSet[slot]||0, list.length-1)] || null;
}
/* 選項只放食材名，數量顯示在選單旁邊。
   為什麼不做成兩個選單：同一格裡食材種類不會重複（`[null,0]` 那個空欄位除外），
   所以**數量由食材決定**，選好食材後數量只有一個可能值。做成兩個選單會假裝有
   不存在的彈性。夢幻／達克萊伊有 `[null,0]` 這個空選項，要顯示成「（無）」——
   否則 `ING_NAME[null]` 會讓選項變成 "undefined×0"。 */
function ingSetOpts(m, slot){
  const p = D.dex[m.sp], list = [p.i0, p.i30, p.i60][slot] || [];
  if (!list.length) return `<option value="0">—</option>`;
  return list.map((x,i)=>
    `<option value="${i}">${x && x[0]!=null ? iz(ING_NAME[x[0]]) : '（無）'}</option>`).join('');
}

/* 展開中的卡片（roster 索引）。純檢視狀態，不進 serialize()。
   刪除會讓後面的索引整批位移，所以 del 之後一律清空 —— 留著會展開到別隻身上。 */
const monOpen = new Set();
/* 重複的 roster 索引（每個欄位都相同的那些）。由 findDups() 在 renderBox 開頭重算。
   宣告放在 monHead 之前是刻意的 —— monHead 會讀它，`let` 沒有提升，
   宣告放後面就是 CLAUDE.md 陷阱 1 那種 TDZ。 */
let monDup = new Set();
/** 目前解鎖的食材格數。 */
const ingSlots = m => Math.min(Math.floor(m.level/30)+1, 3);

/* ---- 個體產能（顯示用，engine.js 的 monPower / monIdeal）----
   **這只是顯示。** 每週的推薦完全走原本那條演算法，一個字都沒改。

   **三種專長的分數彼此不可比。** 職責不同、單位不同：樹果型看總產能能量、
   食材型看食材原始能量、技能型看主技能發動次數。所以每一個數字旁邊都必須有
   專長標籤與單位，而且**排序是先分專長、再組內比**（見 BOX_SORTS.power）——
   把三種混在一起排，那個排名本身就是謊話。

   同專長內的名次（`3/12`）反而是可以跨專長讀的：「我最好的食材型」和
   「我最好的樹果型」是同一種語意。 */
const num = v => Math.round(v).toLocaleString('en-US');
/** 主指標的顯示文字（值 ＋ 單位）。單位不同就是在提醒「別跨專長比」。 */
function powerText(p){
  if (p.spec === 'skill') return {v: p.procs.toFixed(2), u: '發動/日'};
  if (p.spec === 'ingredient') return {v: num(p.ingE), u: '食材能量/日'};
  return {v: num(p.total), u: '產能/日'};
}
/** 同專長內的名次。`Map<專長, 由高到低的 roster 索引>`，每次 renderBox 重算。 */
let powerRank = new Map();
function rebuildPowerRank(){
  const by = new Map();
  roster.forEach((m, i) => {
    const p = monPowerCached(m);
    if (!by.has(p.spec)) by.set(p.spec, []);
    by.get(p.spec).push(i);
  });
  for (const arr of by.values())
    arr.sort((a, b) => powerMain(monPowerCached(roster[b])) - powerMain(monPowerCached(roster[a])) || a - b);
  powerRank = by;
}
function rankOf(idx){
  const p = monPowerCached(roster[idx]);
  const arr = powerRank.get(p.spec) || [];
  const at = arr.indexOf(idx);
  return at < 0 ? null : {at: at + 1, of: arr.length};
}
/* 摺疊狀態要跨 renderStorageNote() 保留 —— 那個函式在雲端同步成功時會重跑，
   不記住的話「讀到一半突然自己收起來」。純檢視狀態，和 monOpen 同待遇：不進 serialize()。 */
let scoreNoteOpen = false;
/** 基準說明。
 *
 *  **摘要那一行一定要顯示** —— 沒有它，摺疊列上那些數字就是憑空來的（見 CLAUDE.md
 *  「個體產能」第 4 條：一個沒有出處的數字比沒有數字更糟，而「暗示可以互相比」又更糟）。
 *  但完整說明有 300 多字，攤在篩選列和箱子列表中間會把真正要看的東西推到畫面外，
 *  所以拆成兩段：**會害人讀錯數字的事留在外面**（基準情境、不能跨專長比、
 *  三個數字各答哪個問題、不影響推演），其餘（為什麼是這三個軸、為什麼基準是 Lv60、
 *  ≥ 是什麼意思、隊伍型徽章）摺進 `<details>`。
 *
 *  **「三個數字各答哪個問題」是摘要裡最不能省的一句。** 使用者本來會拿唯一能排序的
 *  那個數字去決定練誰，而那個數字（資質）是同物種內才有意義的比值 —— 少了這句話，
 *  介面本身就在請人用錯的軸做投資決定（使用者 2026-09-10 反映）。 */
function scoreNote(){
  const brief = `<b>產能</b>是<b>單獨一隻</b>的每日產出（沒有隊友加成、無露營券、`
              + `<b>不含本週加成樹果</b>）；<b>三種專長的數字不能互相比較</b>。`
              + `摺疊列的三個數字各答一個問題：<b>練滿</b>＝等級糖果先餵誰（同專長內比）、`
              + `<b>資質</b>＝性格與副技能是不是好貨（<b>同物種內</b>比）、`
              + `<b>技能</b>＝技能糖果先給誰。<b>這些數字不影響推演。</b>`;
  const full = `基準就是遊戲寶可夢詳細頁顯示幫忙間隔時的那個情境：單獨一隻、無露營券、睡 8.5 小時、`
       + `不含本週加成樹果，所以跨週可比。`
       + `<b>三種專長各有自己的軸</b>，因為職責不同：`
       + `<b>樹果型</b>看總產能（樹果＋食材＋技能能量）、`
       + `<b>食材型</b>看食材原始能量（未經料理加成；配不配得上本週食譜是<b>推演</b>要決定的事）、`
       + `<b>技能型</b>看主技能發動次數（不同技能給的東西不同，換算成能量只會是憑空的假設）。`
       + `單位不同就是在提醒別跨專長比 —— 能比的是<b>同專長內的名次</b>。`
       + `<br><br>`
       + `三個投資數字**共用同一個基準**：<b>Lv${IDEAL_LEVEL} 以上、緞帶4、主技能滿級</b>。`
       + `等級要規範化是因為第 3 格食材要 Lv60、第 3 格副技能要 Lv50 才解鎖 ——`
       + `用當前等級當基準的話，那一格是好是壞會等到升上去<b>那一刻</b>才被算進去。`
       + `<b>緞帶與主技能等級也要規範化</b>，否則同一份資質會因為「還沒練」而顯示低分`
       + `（實測妙蛙花 51% vs 78%），於是照百分比排序的人剛好略過最該投資的那幾隻。`
       + `<br><br>`
       + `<b>練滿</b>是絕對值，和左邊的當前產能同單位，所以<b>同專長內</b>可以直接比大小 ——`
       + `這是「等級糖果先餵誰」。`
       + `<b>資質</b>是<b>牠 ÷ 同物種的理想個體</b>，規範化之後只剩性格、副技能、食材組合的差；`
       + `它是比值，<b>只在同物種之間有意義</b>：100% 的皮卡丘不會比 70% 的妙蛙花強。`
       + `副技能還有空格沒填時分子只會被低估，所以那種會標成 <b>≥</b>。`
       + `<b>技能</b>是主技能等級練到滿之後每天多產的能量 —— 技能糖果是同一種資源，`
       + `所以這一項<b>全體都可以比</b>。它用的是總產能能量而不是各專長的主指標`
       + `（技能型的主指標是發動次數，而發動次數幾乎不隨技能等級變），`
       + `而其中的食材是<b>未經料理加成</b>的原始能量，所以食材型在這個軸上被低估。`
       + `<br><br>`
       + `另外，「幫忙加成」這類<b>只對隊友有效</b>的副技能單獨一隻量不到，會另外標徽章。`
       + `<br><br>`
       + `<b>這些數字不影響推演</b> —— 每週的推薦還是原本的演算法，這裡只是幫你決定糖果餵給哪一隻。`;
  return `<div class="sum">${brief}</div>`
       + `<details class="more"${scoreNoteOpen ? ' open' : ''}>`
       + `<summary>這些數字怎麼來的、為什麼各自只能在特定範圍內比</summary>`
       + `<div>${full}</div></details>`;
}
/* 理想值一隻要跑約 170 次 monPower（≈15ms）。展開一兩張感覺不到，但「展開全部」
   一次開 60 隻還是會頓 —— 和「一次攤開 60 隻要建一萬多個 <option>」同一個考量。

   快取鍵是**整隻的簽章**：看起來理想個體只該由物種與等級決定，但 `monIdeal`
   的最後一步會把**牠自己**也放進候選（保證「理想 ≥ 實際」），那一步和這一隻有關。 */
const IDEAL_AUTO_MAX = 6;
/* 這三個排序的**順序就是背景算出來的值** —— 算完一定要整個 renderBox()，
   只補文字的話順序是錯的（見 idealFillAsync 收尾）。 */
const IDEAL_SORTS = new Set(['ideal', 'full', 'skillRoom']);
const idealCache = new Map();
/* 快取鍵要用**規範化過**的簽章。`monIdeal` 現在把等級、緞帶、主技能等級三樣
   全部推到基準（見那邊的說明），所以：
     · Lv30 和 Lv45 的同一隻共用一格（兩者的評價等級都是 60）
     · 只差緞帶的兩隻也共用一格
   主技能等級**不能**正規化掉 —— `skillNow`（技能成長的基準）就是看它。 */
const idealKey = m => monPowerKey({...m, level: Math.max(IDEAL_LEVEL, m.level), ribbon: 4});
function idealOf(m, allowCompute){
  const k = idealKey(m);
  if (idealCache.has(k)) return idealCache.get(k);
  if (!allowCompute) return undefined;         // undefined = 還沒算；null = 算不出來
  const v = monIdeal(m);
  idealCache.set(k, v);
  return v;
}
/** **資質** ＝ 牠 ÷ 同物種的理想個體，取整數百分比。
 *
 *  分子 `ideal.self` 是「牠**練滿**」的產能（Lv60 以上、緞帶 4、主技能滿級），
 *  分母也在同一個基準 —— 所以這個比值裡**只剩下改不掉的東西**：性格、副技能、
 *  食材組合。這就是它回答的問題：「這一隻是不是好貨」。
 *
 *  它**不**回答「該不該練牠」（那是 `fullMain`，絕對值），也不回答「牠現在有多好」
 *  （那是摺疊列上的當前產能）。三者混著讀就會用錯軸做投資決定。 */
function idealPctFrom(m, ideal){
  const top = powerMain(ideal);
  return top > 0 ? Math.round(powerMain(ideal.self) / top * 100) : null;
}
/** **練滿產能** ＝ 牠練滿之後的主指標（絕對值）。「等級糖果先餵誰」的答案。
 *  和摺疊列的當前產能同一個單位、同一條規則，所以**同專長內可比**。 */
const fullMain = ideal => powerMain(ideal.self);
/** **技能成長** ＝ 主技能等級從現在練到滿，每天多產多少能量。「技能糖果先給誰」。
 *
 *  用 `total`（樹果＋食材＋技能能量）而不是各專長的主指標，因為技能型的主指標是
 *  **發動次數**，而發動次數幾乎不隨技能等級變（活力填充S 那幾隻是例外，牠們靠
 *  自回活力間接加快幫忙）—— 用主指標去量，最該吃技能糖果的技能型會顯示 0。
 *
 *  ⚠ `total` 裡的食材是**未經料理加成的原始能量**（料理會再放大約 2.4 倍），
 *  所以食材型（食材獲取S 那類）在這個軸上被低估。tooltip 一定要寫出來 ——
 *  換算率是憑空的判斷，寧可標明低估也不要編一個係數。 */
const skillRoom = ideal => Math.max(0, ideal.self.total - ideal.skillNow.total);
/** 評價等級下「還空著、但已經生效」的副技能格數。
 *
 *  空格只會讓分子變小（副技能沒有負值），所以有空格時顯示的百分比是**下界** ——
 *  UI 要標成「≥」。靜靜地把「還沒記」當成「就是沒有」，那個數字會誤導投資判斷。 */
function idealUnknownSlots(m, ideal){
  const lvl = (ideal && ideal.lvl) || IDEAL_LEVEL;
  return [0,1,2,3,4].filter(s => lvl >= SS_SLOT_LV[s] && !m.ss[s]).length;
}
/** 已經算好的百分比；還沒算（或算不出來）就回 null。**不會觸發計算。** */
function idealPct(m){
  const ideal = idealOf(m);
  return ideal ? idealPctFrom(m, ideal) : null;
}

/* ---- 理想值的背景填算 ----
   摺疊列要顯示百分比，但一隻要跑約 210 次 monPower（≈15~40ms）—— 60 隻就是
   1~2 秒的凍結，而 renderBox 每改一個欄位就會跑一次。所以**畫面先出來、數字後到**：
   還沒算的顯示「—」，背景一次算幾隻，算完就地補上去。

   只算**目前看得到的那些**（`visibleIdx()`）—— 被篩掉的卡片看不到，付那個錢沒有意義。
   快取鍵是整隻的簽章，所以算過的改天再看是免費的；改了欄位才會重算那一隻。 */
const IDEAL_CHUNK = 2;              // 一批算幾隻。2 隻 ≈ 30~80ms，中間讓出去給瀏覽器
let idealJob = 0;                   // 每輪的號碼；renderBox 會 +1，舊的那輪自己停下來
let idealProg = null;               // {done, total}，給 boxCount 顯示進度用
function idealFillAsync(){
  idealProg = null;
  // 看不到的頁面不用付這個錢（開在推演頁時整個箱子都不必算）。切過去時 showView 會補開一輪。
  if ($('view-box').hidden){ idealJob++; return; }
  const todo = visibleIdx().filter(i => idealOf(roster[i]) === undefined);
  if (!todo.length){ idealJob++; return; }
  const job = ++idealJob, total = todo.length;
  idealProg = {done: 0, total};
  applyBoxFilter();                           // 進度文字要馬上出現，不是等第一批算完
  const step = ()=>{
    if (job !== idealJob) return;             // 已經有新的一輪（改了欄位／換了篩選）
    const batch = todo.splice(0, IDEAL_CHUNK);
    for (const i of batch){
      if (i < roster.length) idealOf(roster[i], true);
      idealProg.done++;
    }
    if (todo.length){
      paintIdealChips(batch);                 // 只補剛算好的那幾張，不要每批重寫 60 個
      applyBoxFilter();
      setTimeout(step, 0);
      return;
    }
    idealProg = null;
    /* 這三個排序的**順序**就是這些值 —— 算完一定要重畫，只補文字的話順序是錯的。
       其他排序不重畫：重畫會讓正在編輯的 select／input 掉焦點。 */
    if (IDEAL_SORTS.has(boxFlt.sort)) renderBox();
    else { paintIdealChips(batch); applyBoxFilter(); }
  };
  setTimeout(step, 0);
}
/** 就地把算好的百分比補進摺疊列（不重畫，才不會把正在編輯的欄位焦點弄掉）。
 *  `idxs` 省略就全部重寫。 */
function paintIdealChips(idxs){
  if (idxs && !idxs.length) return;
  const sel = suf => idxs ? idxs.map(i=>`[data-i="${i}"] ${suf}`).join(',') : `[data-i] ${suf}`;
  // querySelectorAll 回傳的是靜態列表，所以邊走邊換 outerHTML 是安全的
  const paint = (s, fn) => {
    for (const el of $('boxList').querySelectorAll(s)){
      const i = +el.closest('[data-i]').dataset.i;
      if (i < roster.length) el.outerHTML = fn(roster[i]);
    }
  };
  paint(sel('> .mon-head > .mon-idl'), idealChip);
  /* 「練滿」與「技能成長」也是同一批算出來的，**一定要一起補** —— 只補其中一邊，
     卡片上就會同時出現算好的資質和空著的練滿，看起來像壞掉。 */
  paint(sel('> .mon-head > .mon-rest > .mon-inv'), investChip);
}
/** 摺疊列第二列、欄 1 的「資質 N%」。
 *
 *  **這是比值，不是產能，而且只在同物種之間有意義。** 100% 的皮卡丘不會比 70% 的
 *  妙蛙花強 —— 它說的是「這一隻的性格與副技能組合，離同物種的天花板多近」。
 *
 *  **基準三樣全部規範化**（Lv60 以上、緞帶 4、主技能滿級）—— 見 monIdeal。
 *  所以「還沒練」不會壓低這個數字；「該不該練牠」要看旁邊的「練滿」。 */
const idealPend = why => `<span class="mon-idl pend" title="${why}">資質 <b>—</b></span>`;
function idealChip(m){
  const ideal = idealOf(m);
  if (ideal === undefined) return idealPend(`資質／練滿／技能成長 —— 背景計算中（一隻約 15~40ms）`);
  if (!ideal) return idealPend('這一隻的理想個體算不出來');
  const pct = idealPctFrom(m, ideal);
  if (pct == null) return idealPend('這一隻的理想個體算不出來');
  const band = pct >= 90 ? 'a' : pct >= 78 ? 'b' : pct >= 62 ? 'c' : 'd';
  const unk = idealUnknownSlots(m, ideal);
  const t = powerText(ideal.self), it = powerText(ideal), lv = ideal.lvl;
  return `<span class="mon-idl ${band}${unk?' lb':''}" title="`
       + `這一隻是不是好貨 —— 只比性格、副技能、食材組合這些改不掉的東西。&#10;`
       + `牠 ${t.v} ÷ 同物種理想個體 ${it.v}（${t.u}）&#10;`
       + `兩邊都在同一個基準：Lv${lv}${lv > m.level ? `（牠現在 Lv${m.level}）` : ''}、緞帶4、主技能滿級 ——`
       + `所以「還沒練」不會讓這個數字變低。&#10;`
       + `理想個體 ＝ 同物種的最佳性格＋最佳副技能＋最佳食材組合：&#10;`
       + `${natZ(NAT[ideal.member.nature]||NAT.Bashful)}／${ideal.member.ss.filter(Boolean).map(ssz).join('、')||'（無副技能）'}&#10;`
       + (unk ? `⚠ 還有 ${unk} 格副技能沒填 —— 填了只會讓分子變高，所以這是下界（≥）。&#10;` : '')
       + `只在同物種之間比：100% 的皮卡丘不會比 70% 的妙蛙花強。&#10;`
       + `「該練誰」看旁邊的「練滿」，「技能糖果給誰」看「技能」。&#10;`
       + `貪婪搜尋出來的參考線，不是證明過的上限。">資質 <b>${unk?'≥':''}${pct}%</b></span>`;
}
/** 摺疊列上的兩個**投資**數字，緊跟在當前產能後面：`練滿 X` 與 `技能 +N`。
 *
 *  三個數字各對應一種資源，這是刻意的分工：
 *
 *  | chip | 回答 | 可比範圍 |
 *  |---|---|---|
 *  | 當前產能（`scoreChip`） | 牠**現在**有多好 | 同專長內 |
 *  | 練滿（這裡） | **等級糖果**先餵誰 | 同專長內 |
 *  | 技能（這裡） | **技能糖果**先給誰 | 全體 —— 那是同一種資源 |
 *  | 資質（`idealChip`） | 這一隻是不是好貨 | **同物種內** |
 *
 *  **為什麼「練滿」非顯示不可、而且要能排序：** 使用者會很自然地拿摺疊列上唯一
 *  能排序的數字去決定練誰。以前那個數字是「潛力 %」，而它是同物種內才有意義的
 *  比值 —— 照它排序去略過低分的，等於用錯的軸做投資決定（使用者 2026-09-10 反映）。
 *
 *  背景算完才有值，所以 `paintIdealChips` 要把它和 `.mon-idl` **一起**補上。 */
function investChip(m){
  const ideal = idealOf(m);
  if (!ideal) return `<span class="mon-inv"></span>`;
  const fu = powerText(ideal.self), now = powerText(monPowerCached(m));
  const maxed = m.skillLv >= ideal.maxSkillLv;
  const room = skillRoom(ideal);
  return `<span class="mon-inv">`
    + `<span class="mon-full" title="牠練滿之後的產能：Lv${ideal.lvl}、緞帶4、主技能滿級。&#10;`
    + `這是「等級糖果先餵誰」的答案 —— 和左邊的當前產能同一個單位（${fu.u}），`
    + `所以同專長內可以直接比大小。&#10;`
    + `牠現在是 ${now.v}。">練滿 <b>${fu.v}</b></span>`
    + (maxed
      ? `<span class="mon-room done" title="主技能已經滿級（Lv${ideal.maxSkillLv}）—— 技能糖果餵給別隻。">技能滿級</span>`
      : `<span class="mon-room" title="主技能等級從 Lv${m.skillLv} 練到滿級 Lv${ideal.maxSkillLv}，每天多產的能量。&#10;`
        + `這是「技能糖果先給誰」的答案，而技能糖果是同一種資源，所以這一項全體都可以比。&#10;`
        + `⚠ 這裡用的是總產能能量（樹果＋食材＋技能），不是各專長的主指標 ——`
        + `技能型的主指標是發動次數，而發動次數幾乎不隨技能等級變，用它量會顯示 0。&#10;`
        + `⚠ 其中食材是未經料理加成的原始能量（料理會再放大約 2.4 倍），`
        + `所以食材型在這個軸上被低估。">技能 <b>+${num(room)}</b></span>`)
    + `</span>`;
}
/** 摺疊列上的那兩格：主指標 ＋ 同專長名次。
 *
 *  **選了食材篩選時，主指標會換成那一種食材的每日產量。** 不換的話，用
 *  「選定食材的產量」排序時畫面上顯示的還是各專長的主指標 —— 順序看起來就像壞了。 */
function scoreChip(m, idx){
  const p = monPowerCached(m);
  if (boxFlt.ing.size){
    const sel = [...boxFlt.ing];
    const v = ingSum(m);
    const each = sel.map(i => `${iz(ING_NAME[i])} ${p.ingAll[i].toFixed(1)}`).join('　');
    const label = sel.length === 1 ? iz(ING_NAME[sel[0]]) : `${sel.length} 種食材`;
    return `<span class="mon-power${v > 1e-9 ? '' : ' zero'}" title="選中食材的每日總產量。`
         + `&#10;${each}`
         + `&#10;篩選看的是食材欄位，這個數字是實際產量 —— 所以未解鎖的欄位會顯示 0。`
         + `&#10;含食材磁鐵那類主技能灑出來的份（灑得很平均，不可指定）。`
         + `&#10;${SPEC_ZH[p.spec]}型的主指標是 ${powerText(p).v} ${powerText(p).u}。">`
         + `${v.toFixed(1)}<i>${label}/日</i></span>`;
  }
  const t = powerText(p);
  const r = idx == null ? null : rankOf(idx);
  const tip = `${SPEC_ZH[p.spec]}型的主指標：${t.v} ${t.u}&#10;`
    + `樹果 ${num(p.berryE)} · 食材 ${num(p.ingE)}（${p.ingCount.toFixed(1)} 顆）· 技能能量 ${num(p.skillE)}&#10;`
    + `主技能發動 ${p.procs.toFixed(2)} 次/日 · 幫忙間隔 ${p.interval} 秒&#10;`
    + `單獨一隻、無隊友加成、不含本週加成樹果。展開後有完整說明。`;
  return `<span class="mon-power" title="${tip}">${t.v}<i>${t.u}</i></span>`
       + (r ? `<span class="mon-rank" title="同專長內的名次 —— 這個才是可以跨專長讀的">`
             + `${SPEC_ZH[p.spec]} ${r.at}/${r.of}</span>` : '')
       + (p.teamOnly ? `<span class="mon-team" title="牠有「${p.teamOnly}」——&#10;`
             + `那個價值取決於隊友（誰在隊上、帶什麼樹果），單獨一隻量不到，`
             + `所以上面那個數字沒有包含它。&#10;推演會正確計入。">隊伍型</span>` : '');
}
/** 展開後的產能列：主指標 ＋ 全部原始數字 ＋ 同物種同等級的理想個體。 */
function scoreRow(m, allowIdeal){
  const p = monPowerCached(m);
  const t = powerText(p);
  const ideal = idealOf(m, allowIdeal);
  let cmp;
  if (ideal === undefined)
    cmp = `<button class="btn sm ghost" data-act="ideal" type="button">算理想個體</button>`;
  else if (!ideal)
    cmp = `<span class="muted">理想值算不出來</span>`;
  else {
    const pct = idealPctFrom(m, ideal) ?? 0;    // 摺疊列的「資質 N%」用的是同一條算式
    const it = powerText(ideal), unk = idealUnknownSlots(m, ideal);
    const room = skillRoom(ideal), maxed = m.skillLv >= ideal.maxSkillLv;
    cmp = `<span class="mon-ideal" title="基準：Lv${ideal.lvl}${ideal.lvl > m.level ? `（牠現在 Lv${m.level}）` : ''}、緞帶4、主技能滿級。&#10;`
        + `所以左邊那個當前產能和這裡的數字不是同一個狀態的東西 ——`
        + `左邊是「現在有多好」，這裡是「練滿之後」。&#10;`
        + `練滿 ${powerText(ideal.self).v}：等級糖果先餵誰（同專長內比）。&#10;`
        + `資質 ${pct}%：牠 ÷ 同物種理想個體，只剩性格／副技能／食材組合的差（同物種內比）。&#10;`
        + (maxed ? `主技能已經滿級（Lv${ideal.maxSkillLv}）。&#10;`
                 : `技能成長 +${num(room)}：主技能練到 Lv${ideal.maxSkillLv} 每天多產的能量（全體可比）。&#10;`)
        + `理想個體 ＝ 同物種的最佳性格＋最佳副技能＋最佳食材組合，目標是這個專長的主指標（${t.u}）。&#10;`
        + `理想個體：${natZ(NAT[ideal.member.nature]||NAT.Bashful)}／`
        + `${ideal.member.ss.filter(Boolean).map(ssz).join('、') || '（無副技能）'}&#10;`
        + (unk ? `⚠ 還有 ${unk} 格副技能沒填，所以資質是下界（≥）。&#10;` : '')
        + `這是貪婪搜尋，不是證明過的上限 —— 當參考線看，別當天花板。">`
        + `練滿 ${powerText(ideal.self).v} · 理想 ${it.v} · 資質 <b>${unk?'≥':''}${pct}%</b>`
        + (maxed ? ` · 技能滿級` : ` · 技能 <b>+${num(room)}</b>`) + `</span>`;
  }
  const ings = p.ingTypes.length
    ? p.ingTypes.map(([n, v]) => `${iz(n)} ${v.toFixed(1)}`).join('、') : '無';
  return `<div class="mon-row mon-scorerow">
      <span class="mon-lbl">產能</span>
      <span class="mon-scv" title="${SPEC_ZH[p.spec]}型的主指標。單獨一隻、無隊友加成、不含本週加成樹果">${t.v}<i>${t.u}</i></span>
      <span class="mon-scparts">
        <span class="sc-b" title="樹果能量／日（含主技能給的樹果）">樹果 ${num(p.berryE)}</span>
        <span class="sc-d" title="食材原始能量／日（未經料理加成）&#10;每日 ${p.ingCount.toFixed(1)} 顆：${ings}">食材 ${num(p.ingE)}</span>
        <span class="sc-s" title="主技能發動次數／日${p.skillE > 0 ? `，直接給的能量 ${num(p.skillE)}／日` : '（這個技能不直接給能量）'}">技能 ${p.procs.toFixed(2)} 次</span>
        <span class="sc-h" title="幫忙間隔（秒）—— 和遊戲寶可夢詳細頁上的數字相同${p.snack > 0.05 ? `&#10;背包滿了之後的「零食」幫忙 ${p.snack.toFixed(1)} 次/日 —— 該補持有上限了` : ''}">間隔 ${p.interval}s${p.snack > 0.05 ? ' ⚠' : ''}</span>
      </span>
      ${cmp}
    </div>`;
}

/** 性格摘要：「頑皮 +速度 −技能」，加減用顏色分開。無修正的走 natMod 的 null 分支。 */
function natBrief(m){
  const n = NAT[m.nature] || NAT.Bashful, d = natMod(n);
  return d
    ? `${natZ(n)} <span class="up">+${d.up}</span> <span class="dn">−${d.dn}</span>`
    : `${natZ(n)} <span class="muted">無修正</span>`;
}
/** 摺疊列上顯示的名字：有暱稱就用暱稱，沒有就用物種名。
 *  物種身分不會因此消失 —— `#圖鑑號`、專長標籤、主技能標籤都還在同一列上，
 *  滑過名字有 title，展開後「種類」選單寫的就是學名。 */
const monName = m => (m.nick || '').trim() || pz(D.dex[m.sp]);

/* ---- 主技能的「已知不完整」清單 ----
 *
 *  **方向很重要，兩種的嚴重度差很多：**
 *    `under` ＝ 附加效果沒讀進來 → 會**低估** → 你可能錯過一隻好的。
 *    `over`  ＝ 已知的**扣分**沒有模型 → 會**高估** → 工具會主動把一支差的隊伍推薦給你。
 *
 *  達克萊伊是目前唯一的 `over`：快照裡「夢魘（能量填充M）」只有 `strength` 一欄，
 *  扣活力那一面完全不存在；而且 `data/game.json` 的 dex **沒有屬性欄位**
 *  （只有 n d no sp f ip sk b cs pe re ms i0 i30 i60），所以「全隊都是惡屬性」
 *  這個條件在這份資料裡根本表達不出來 —— 不是還沒做，是資料不夠。
 *
 *  靜靜地只算加成那一面，就是「文案說謊」那類 bug 裡最貴的一種。 */
const MS_CAVEAT = {
  'Bad Dreams (Charge Strength M)': {dir:'data', why:
    '扣活力那一面**有算**（每次發動讓隊上惡屬性以外的成員 −12 活力），但「誰是惡屬性」'
    + '不在上游資料裡 —— 那份清單由 repo 自己維護（tools/dark.txt，目前 13 隻）。'
    + '清單錯了不會有任何錯誤訊息，只會讓分數偏掉，所以惡屬性的寶可夢在箱子裡會標「惡」，可以自己核對。'},
  'Moonlight (Charge Energy S)':      {dir:'under', why:'暴擊加成沒讀進來（主要的補活力效果有算）。'},
  'Hyper Cutter (Ingredient Draw S)': {dir:'under', why:'暴擊時的額外食材沒讀進來（主要的食材效果有算）。'},
  /* 治癒波動：三個欄位現在都有算（補活力、額外幫忙、隊上有拉帝歐斯時的加碼），
     所以不再列 caveat。 */
  /* 流星群：基礎表（MS_EXTRA）＋ 拉帝亞斯那一份都算了，所以不再列 caveat。 */
  'Dream Shard Magnet S':             {dir:'under', why:'夢之碎片不計分 —— 這個工具只算能量。'},
  'Aura Sphere (Dream Shard Magnet S)':{dir:'under', why:'夢之碎片不計分 —— 這個工具只算能量。'},
  'Super Luck (Ingredient Draw S)':   {dir:'under', why:'夢之碎片不計分（食材那一面有算）。'},
};
/** 主技能旁邊的警告徽章。沒有 caveat 就回空字串。 */
function msCaveat(ms){
  const c = MS_CAVEAT[ms]; if (!c) return '';
  const over = c.dir === 'over', data = c.dir === 'data';
  const tail = over ? '方向是「高估」—— 這個數字比實際好，看到牠入選要自己再判斷一次。'
             : data ? '方向不確定 —— 效果有算，但它吃一份 repo 自己維護的資料，那份錯了分數就會偏。'
                    : '方向是「低估」—— 這個數字比實際保守，牠實際上可能更好。';
  return `<span class="ms-warn${over?' over':''}${data?' data':''}" title="${msz(ms)}：${c.why}&#10;&#10;${tail}">`
       + `${over?'⚠ 會高估':data?'※ 看惡屬性清單':'△ 會低估'}</span>`;
}
/** 摺疊列：唯讀、密、**兩列 × 兩欄的 grid**。
 *
 *  欄 1（`.mon-idy`）是**身分**：`▶ #圖鑑號 暱稱 Lv`。寬度**固定**，這樣所有卡片的
 *  欄 2 都從同一個 x 開始 —— 用 `max-content` 的話每張卡的起點會隨名字長度浮動，
 *  掃 60 隻時反而更亂。名字太長會在欄內自己折，不裁切（裁掉等於沒有）。
 *
 *  欄 2 第 1 列（`.mon-rest`）：`[專長] [主技能] 性格 副技能… 技Lv 產能 練滿 技能+N [＋隊 📍 ✕ 🗑]`
 *  欄 1 第 2 列（`.mon-idl`）：**資質 N%**（同物種內的個體品質），就在名字／等級底下。
 *  欄 2 第 2 列（`.mon-ings`）：**只有食材**，起點對齊上一列的專長標籤。
 *
 *  DOM 順序必須是 `.mon-idy` → `.mon-rest` → `.mon-idl` → `.mon-ings`：grid 的自動
 *  排版是照 DOM 走的，而 `.mon-idl`／`.mon-ings` 各自寫死了欄號（1／2）。
 *
 *  為什麼食材要獨立一列：原本副技能和食材同在一個 `.mon-sum` 裡靠 flex-wrap 自然
 *  換行，兩種標籤混排、斷行位置又隨寬度浮動 —— 掃 60 隻時分不出哪個是哪個。
 *
 *  副技能的底色就是**稀有度**（`game.json` 的 `subskills[].r`：gold／silver／white）——
 *  這是資料裡本來就有的分級，不是我編的配色。未解鎖的那幾格會變淡。 */
function monHead(m, idx, open){
  const p = D.dex[m.sp];
  const ss = [0,1,2,3,4].filter(s=>m.ss[s]).map(s=>{
    const lock = m.level < SS_SLOT_LV[s];
    return `<span class="rr ${(SS[m.ss[s]]||{}).r||'white'}${lock?' lock':''}"`
         + ` title="第 ${s+1} 格${lock?` — Lv${SS_SLOT_LV[s]} 才解鎖，目前不生效`:''}">${ssz(m.ss[s])}</span>`;
  }).join('');
  /* 未解鎖的食材格**照樣顯示，只是變淡** —— 和上面的副技能同一個處理方式。
     遊戲畫面會把它預告出來（🔒Lv.60 加食材圖與 ×N），藏起來反而看不出存錯了。 */
  const ing = [0,1,2].map(s=>{
    const k = ingPick(m, s); if (!k) return '';
    const lock = s >= ingSlots(m);
    return `<span class="mon-i${lock?' lock':''}"`
         + ` title="第 ${s+1} 格${lock?` — Lv${[1,30,60][s]} 才解鎖，目前不計入產出`:''}">`
         + `${k[0]!=null?iz(ING_NAME[k[0]]):'（無）'}×${k[1]}</span>`;
  }).join('');
  const nick = (m.nick || '').trim();
  /* 「牠現在在哪幾支自組隊伍裡」—— ＋隊那顆按鈕的狀態就是這個，不然按下去有沒有生效
     只能切分頁才看得到。跨隊重複是允許的（比較兩隊通常只換 1~2 隻），所以是列表不是布林。 */
  const inTeam = idx == null ? [] : teams.map((t, ti) => t.members.includes(idx) ? ti + 1 : 0).filter(Boolean);
  return `<div class="mon-head" data-act="toggle" title="點一下展開／收起">
      <span class="mon-idy">
        <span class="car">${open?'▼':'▶'}</span>
        ${idx === boxNew && isBoxNew() ? '<span class="mon-new" title="剛新增的，暫時放在最前面方便填 —— 收起來就會回到目前排序該有的位置">剛新增</span>' : ''}
        ${monDup.has(idx) ? '<span class="mon-dup" title="有另一隻的每一個欄位都和牠完全相同 —— 可能是重複輸入">⚠ 重複</span>' : ''}
        <span class="mon-no">#${p.no}</span>
        <span class="mon-name${nick?' is-nick':''}" title="${nick ? `暱稱「${esc(nick)}」 · 學名 ${pz(p)}（${p.d}）` : `${pz(p)}（${p.d}）`}">${nick ? esc(nick) : pz(p)}</span>
        <span class="mon-lv">Lv${m.level}</span>
      </span>
      <span class="mon-rest">
        <span class="tag ${SPEC_TAG[p.sp]}" title="專長">${SPEC_ZH[p.sp]}</span>${DARK.has(p.n)?`<span class="tag dark" title="惡屬性 —— 只影響達克萊伊「夢魘」的扣活力（惡屬性免疫）。這份清單由 repo 維護在 tools/dark.txt，上游資料沒有屬性欄位">惡</span>`:``}
        <span class="mon-ms" title="主技能（由種類決定）">${msz(p.ms)}</span>${msCaveat(p.ms)}
        <span class="mon-nat">${natBrief(m)}</span>
        <span class="mon-sum">${ss}</span>
        <span class="mon-sk" title="主技能 ${msz(p.ms)} 的基礎等級（副技能加成另計）">技Lv${m.skillLv}</span>
        ${scoreChip(m, idx)}${investChip(m)}
        <span class="mon-acts">
          <button class="btn sm ghost${inTeam.includes(teamShown+1)?' on':''}" data-act="team" title="${teamAddTitle(idx, inTeam)}">＋隊</button>
          <button class="btn sm ghost" data-act="pin" title="固定在隊上（推演一定選牠）">${m.pin?'📌':'📍'}</button>
          <button class="btn sm ghost" data-act="ex" title="${m.ex?'目前排除在推演之外 —— 點一下放回候選':'從推演中排除（點一下排除）'}">${m.ex?'🚫':'✕'}</button>
          <button class="btn sm ghost danger" data-act="del" title="刪除這一隻（會再問一次，沒有復原）">🗑</button>
        </span>
      </span>
      ${idealChip(m)}
      <span class="mon-ings"><span class="mon-ilbl">食材</span>${ing}</span>
    </div>`;
}
/** 展開後的編輯區。兩列：①暱稱／種類／專長／等級/性格 ②食材、副技能、技能Lv、緞帶。
 *  **「種類」選單一律在這裡**（顯示的就是學名）—— 摺疊列可能被暱稱蓋掉，所以展開後
 *  一定要看得到牠到底是哪一隻，而且可以改。 */
function monEdit(m, o){
  const p = D.dex[m.sp];
  const slots = ingSlots(m);
  const amb = (o && o.amb) || {};
  const allowIdeal = !!(o && o.allowIdeal);
  const ambCls = k => amb[k] ? ' class="amb"' : '';
  const ambIng = s => (amb.ing && amb.ing[s] && amb.ing[s].length>1) ? ' class="amb"' : '';
  return `<div class="mon-edit">
      <div class="mon-row">
        <label class="f w-nick">暱稱<input type="text" data-k="nick" maxlength="${NICK_MAX}"
          placeholder="${pz(p)}" value="${esc(m.nick||'')}"
          title="你在遊戲裡取的名字。只影響顯示，不影響計算 —— 留空就顯示學名"></label>
        <label class="f w-sp">種類<select data-k="sp"${ambCls('sp')}>${SPECIES_OPTS}</select></label>
        <span class="tag ${SPEC_TAG[p.sp]}" title="專長（由種類決定）" style="align-self:center">${SPEC_ZH[p.sp]}</span>
        <label class="f w-num">等級<input type="number" data-k="level" min="1" max="70" value="${m.level}"></label>
        <label class="f w-nat">性格<select data-k="nature">${NATURE_OPTS}</select></label>
      </div>
      <div class="mon-row"><span class="mon-lbl">食材</span><div class="mon-ing">${[0,1,2].map(s=>{
        const pick = ingPick(m, s), lock = s >= slots;
        /* 未解鎖的格子**不 disable**，理由和副技能一樣：遊戲畫面上看得到，先記
           下來是對的，而 disable 的話截圖校對時根本改不了那一格。 */
        return `<span class="ingpick${lock?' locked':''}"`
             + ` title="第 ${s+1} 格 — Lv${[1,30,60][s]} 解鎖${lock?'（目前不計入產出）':''}">`
             + `<select data-k="ingSet" data-s="${s}"${ambIng(s)}>${ingSetOpts(m,s)}</select>`
             + `<b>${pick ? '×'+pick[1] : '—'}</b></span>`;
      }).join('')}</div></div>
      <div class="mon-row"><span class="mon-lbl">副技能</span><div class="mon-ss">${[0,1,2,3,4].map(s=>
        /* 未解鎖的欄位只是變淡，**不 disable** —— 遊戲畫面上看得到（🔒Lv.70），
           先記下來是對的，引擎會自己依等級判斷要不要採計。 */
        `<select data-k="ss" data-s="${s}"${m.level<SS_SLOT_LV[s]?' class="dim"':''} title="第 ${s+1} 格 — Lv${SS_SLOT_LV[s]} 解鎖${m.level<SS_SLOT_LV[s]?'（尚未解鎖，可以先記）':''}">${SS_OPTS}</select>`).join('')}</div>
        <label class="f w-num">技能Lv<input type="number" data-k="skillLv" min="1" max="8" value="${m.skillLv}"></label>
        <label class="f w-rib">緞帶<select data-k="ribbon"${ambCls('rb')} title="睡眠緞帶：提升攜帶上限，未進化的還會縮短幫手間隔。遊戲畫面上看不到，是由持有上限反解出來的">${
          RIBBON_LABEL.map((t,i)=>`<option value="${i}">${t}</option>`).join('')}</select></label>
      </div>
      ${scoreRow(m, allowIdeal)}
    </div>`;
}
/** 一隻寶可夢的卡片。寶可夢箱與截圖校對區**共用這一份** ——
 *  兩邊各寫一份的話，改了一邊另一邊就會不一樣，而校對區看到的必須就是進箱子的東西。
 *  `idx == null` 代表校對區用：沒有摺疊列、永遠展開、沒有 data-i。 */
function monCard(m, idx, o){
  if (idx == null) return `<div class="mon open">${monEdit(m, o)}</div>`;
  const open = monOpen.has(idx);
  return `<div class="mon${m.ex?' is-ex':''}${m.pin?' is-pin':''}${open?' open':''}" data-i="${idx}">`
       + monHead(m, idx, open) + (open ? monEdit(m, o) : '') + `</div>`;
}
/** 把 m 的值套進一張已經渲染好的卡片。select 的 value 不能寫在 HTML 字串裡。 */
function setMonValues(el, m){
  const sp = el.querySelector('[data-k="sp"]');
  if (!sp) return;              // 摺疊中的卡片沒有編輯控制項
  sp.value = m.sp;
  el.querySelector('[data-k="nature"]').value = m.nature;
  el.querySelectorAll('[data-k="ss"]').forEach(s=>{ s.value = m.ss[+s.dataset.s] || ''; });
  el.querySelectorAll('[data-k="ingSet"]').forEach(s=>{ s.value = String(m.ingSet[+s.dataset.s]||0); });
  el.querySelector('[data-k="ribbon"]').value = String(m.ribbon||0);
}

/* ---- 篩選 ----
   只影響「顯示哪幾張卡」，不動 roster、不影響推演。純檢視偏好，所以不進 serialize()。

   實作用 `hidden` 切換而不是重建 innerHTML：一張卡有 246 個種類選項，60 隻就是
   一萬多個 <option>，每次打字都重建會卡。 */
let boxFlt = {spec:'', state:'', q:'', ing:new Set(), ingMode:'any', sort:'added', dir:1};

/* ---- 重複偵測 ----
   簽章用**每一個會影響計算的欄位**。兩隻同物種同等級但副技能不同是完全合法的
   （很常見），所以只有全部欄位都一樣才算重複 —— 那幾乎一定是輸入兩次。
   在大量建箱子的時候很容易發生（同一隻的截圖看了兩遍）。 */
/* 暱稱也算進簽章。它不影響計算，但**它是你自己給的身分標記** —— 兩隻數值一模一樣
   卻取了不同名字，那就是兩隻不同的個體，不該被標成重複。反過來，同一隻的截圖看了
   兩遍，暱稱一定也一樣，照樣抓得到。 */
const dupKey = m => [D.dex[m.sp].n, m.level, m.nature, m.ss.join('|'),
                     m.ingSet.join(','), m.skillLv, m.ribbon||0, (m.nick||'').trim()].join('/');
function findDups(){
  const seen = new Map();
  roster.forEach((m,i)=>{
    const k = dupKey(m);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(i);
  });
  monDup = new Set();
  for (const arr of seen.values()) if (arr.length > 1) for (const i of arr) monDup.add(i);
}

/* ---- 排序 ----
   只改**顯示順序**，不動 roster。roster 的順序會進 serialize()／Sheet，
   而且 monOpen 存的是真實索引 —— 動 roster 會讓兩者都跟著位移。
   （引擎本身對順序不敏感，那是 tests/verify.mjs 證過的，但沒必要動它。） */
const SPEC_ORD = ['berry','ingredient','skill','all'];
const BOX_SORTS = {
  added: null,
  /* 圖鑑編號。摺疊列第一個顯示的就是 `#圖鑑號`，所以這是唯一「照著畫面上的
     數字排」的順序 —— 也讓同一族的（妙蛙種子／草／花）自然排在一起。
     不同的種類不會共用 `no`，同 `no` 的多隻就是同物種的不同個體，靠 `|| a-b`
     回到加入順序。 */
  no:    (a,b)=> D.dex[roster[a].sp].no - D.dex[roster[b].sp].no,
  /* 產能：**先分專長、再組內由高到低**。三種專長的主指標單位不同（產能能量／
     食材能量／發動次數），混在一起排出來的名次本身就是謊話。 */
  power: (a,b)=> {
    const pa = monPowerCached(roster[a]), pb = monPowerCached(roster[b]);
    return SPEC_ORD.indexOf(pa.spec) - SPEC_ORD.indexOf(pb.spec) || powerMain(pb) - powerMain(pa);
  },
  /* 選定食材的每日產量，高→低。**這個可以跨專長排** —— 同一種食材、同一個單位，
     所以「誰產最多品鮮蘑菇」是一個有意義的問題，答案也可能是一隻全能型。
     沒選食材時退回加入順序（`boxCount` 會提示要先選）。 */
  ingAmt: (a,b)=> boxFlt.ing.size ? ingSum(roster[b]) - ingSum(roster[a]) : 0,
  /* 資質（性格＋副技能＋食材組合的品質），高→低。**只在同物種之間有意義** ——
     它是比值不是產能，所以整箱排出來的名次**不能**拿來決定「該練誰」。
     那是 `full` 的工作，`boxCount` 會把這句話寫出來。
     還沒算完的排最後（`-1`）—— 拿一半的值排出來的名次是錯的，而背景算完會重畫。 */
  ideal: (a,b)=> (idealPct(roster[b]) ?? -1) - (idealPct(roster[a]) ?? -1),
  /* 練滿之後的主指標，**先分專長、再組內由高到低** —— 和 `power` 完全同一條規則，
     因為它就是同一個單位的數字，只是把等級／緞帶／主技能等級都推到滿。
     **這才是「等級糖果先餵誰」的排序。** 還沒算完的排在該專長的最後。 */
  full: (a,b)=> {
    const ia = idealOf(roster[a]), ib = idealOf(roster[b]);
    return SPEC_ORD.indexOf(D.dex[roster[a].sp].sp) - SPEC_ORD.indexOf(D.dex[roster[b].sp].sp)
        || (ib ? fullMain(ib) : -1) - (ia ? fullMain(ia) : -1);
  },
  /* 技能等級練滿能多產多少能量／日，高→低。**這個可以跨專長排** —— 技能糖果是
     同一種資源，不放在一起比就分配不了。單位與「食材型被低估」見 `skillRoom`。 */
  skillRoom: (a,b)=> {
    const ia = idealOf(roster[a]), ib = idealOf(roster[b]);
    return (ib ? skillRoom(ib) : -1) - (ia ? skillRoom(ia) : -1);
  },
  level: (a,b)=> roster[b].level - roster[a].level,
  spec:  (a,b)=> SPEC_ORD.indexOf(D.dex[roster[a].sp].sp) - SPEC_ORD.indexOf(D.dex[roster[b].sp].sp),
  ms:    (a,b)=> msz(D.dex[roster[a].sp].ms).localeCompare(msz(D.dex[roster[b].sp].ms), 'zh-Hant'),
};
/* ---- 排序方向 ----
   每個排序的「正向」是上面那些比較器本來的方向，`boxFlt.dir === -1` 就整個反過來。

   **方向只寫在按鈕上，不寫在 `<option>` 裡。** 兩個地方各寫一次方向，按了反轉之後
   其中一個一定會變成謊話 —— 和「文案不能寫死檔名」同一類的問題。

   反轉的是**整個比較器**，包含同鍵時的加入順序，所以結果就是列表倒過來 ——
   「產能」那個連專長的分組順序也一起倒（樹果在最前 → 全能在最前），這樣才不會出現
   「按了反轉但前半段沒動」的怪狀態。按鈕的 title 會寫出這件事。 */
const SORT_DIR = {
  added:  ['先加的在前', '後加的在前'],
  no:     ['編號小→大', '編號大→小'],
  power:  ['產能高→低', '產能低→高'],
  ingAmt: ['產量高→低', '產量低→高'],
  ideal:  ['資質高→低', '資質低→高'],
  full:   ['練滿高→低', '練滿低→高'],
  skillRoom: ['技能成長高→低', '技能成長低→高'],
  level:  ['等級高→低', '等級低→高'],
  spec:   ['專長順序', '專長反序'],
  ms:     ['主技能 A→Z', '主技能 Z→A'],
};
/** 按鈕上的箭頭與文字。**方向的唯一真實來源是 `boxFlt.dir`**，這裡只是把它畫出來。 */
function syncSortDirUI(){
  const b = $('fltDir'), rev = boxFlt.dir === -1;
  const lab = (SORT_DIR[boxFlt.sort] || ['正向','反向'])[rev ? 1 : 0];
  b.textContent = `${rev ? '↑' : '↓'} ${lab}`;
  b.setAttribute('aria-pressed', rev ? 'true' : 'false');
  b.title = `點一下反轉排序方向。目前：${lab}。\n`
          + `反轉的是整份列表（同分時的加入順序也一起倒）`
          + `${boxFlt.sort === 'power' ? '，「產能」連專長的分組順序也會倒過來' : ''}。`;
}
/* 剛按「新增一隻」建出來的那一隻的**真實 roster 索引**，會被暫時提到列表最前面。
 *
 *  「新增一隻」的按鈕在篩選列上（＝畫面最上面），但 `roster.push` 讓新的那隻排在
 *  最後 —— 60 隻的箱子就得往下拉到底才找得到那張要填的表單，填完再拉回來按下一次。
 *
 *  **只在它還展開著的時候提前**（＝還在編輯它）。收起來就回到排序該有的位置，
 *  所以「加入順序」這個排序名稱不會因此變成謊話 —— 而且提前的那一張會標「剛新增」，
 *  不是靜靜地把順序換掉。 */
let boxNew = null;
function boxOrder(){
  const idx = roster.map((_,i)=>i);
  const cmp = BOX_SORTS[boxFlt.sort];
  const dir = boxFlt.dir === -1 ? -1 : 1;
  /* `|| a-b`：同鍵時回到加入順序，結果才是穩定且可預測的。
     `* dir` 整個乘進去（含那個 tie-break），反轉出來的就是完整倒過來的列表；
     「加入順序」沒有比較器，靠的就是這條 tie-break 反過來。 */
  const ord = idx.sort((a,b)=> ((cmp ? cmp(a,b) : 0) || a-b) * dir);
  /* 不再算數就**就地丟掉**，不要留著一個過期的索引 —— del／整批取代都會
     `monOpen.clear()`，那之後 `boxNew` 指到的已經是別隻了，留著就會在使用者
     下次展開那個索引時冒出一個「剛新增」的標記並把牠置頂。 */
  if (!isBoxNew()){ boxNew = null; return ord; }
  const at = ord.indexOf(boxNew);
  if (at > 0){ ord.splice(at, 1); ord.unshift(boxNew); }
  return ord;
}
/** 置頂那一隻還算數嗎（索引還在範圍內、而且還展開著）。 */
const isBoxNew = () => boxNew != null && boxNew < roster.length && monOpen.has(boxNew);

/* 「產這個食材的寶可夢」：看的是**食材欄位**，不是實際產量。
   食材磁鐵那類主技能會把食材灑遍 `MAGNET_POOL`（除了尾巴以外全部），所以按產量
   篩的話幾乎每一隻都會中，這個篩選就沒用了。欄位才是你能規劃的東西。

   **未解鎖的欄位也算中**（遊戲畫面本來就把它預告出來）。那種會排到最後，
   因為排名看的是實際產量，而未解鎖的那格產量是 0 —— 看得到、也看得出還沒生效。 */
/** 牠的食材欄位（三格，含未解鎖）產不產出食材 `ii`。 */
const producesIng = (m, ii) => [0,1,2].some(s => { const k = ingPick(m, s); return k && k[0] === ii; });
/** 選中那幾種食材的每日**總**產量。排序與摺疊列都用這個。 */
function ingSum(m){
  const p = monPowerCached(m);
  let v = 0;
  for (const i of boxFlt.ing) v += p.ingAll[i];
  return v;
}
/* 食材 chips。依中文名排序，而不是 game.json 的內部順序 —— 使用者是照名字找的。 */
function buildBoxBar(){
  const opts = ING_NAME.map((n, i) => [i, iz(n)]).sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'));
  $('fltIng').innerHTML = opts.map(([i, z]) =>
    `<button type="button" class="chip" data-ing="${i}" aria-pressed="false" title="${iz(ING_NAME[i])}　能量 ${ING_VAL[i]}">${z}</button>`).join('');
}
/** chips 的按下狀態與說明文字 —— 篩選狀態由 `boxFlt.ing` 決定，這裡只是把它畫出來。 */
function syncIngFilterUI(){
  for (const b of $('fltIng').querySelectorAll('[data-ing]'))
    b.setAttribute('aria-pressed', boxFlt.ing.has(+b.dataset.ing) ? 'true' : 'false');
  for (const b of $('fltIngMode').querySelectorAll('[data-mode]'))
    b.setAttribute('aria-pressed', boxFlt.ingMode === b.dataset.mode ? 'true' : 'false');
  const n = boxFlt.ing.size;
  $('fltIngNote').textContent = !n ? '不限（點食材可複選）'
    : boxFlt.ingMode === 'all' ? `選了 ${n} 種 —— 只顯示${n > 1 ? '全部都產' : '有產'}的`
    : `選了 ${n} 種 —— 產其中任一種就顯示`;
}
function monMatch(m, idx){
  const p = D.dex[m.sp];
  if (boxFlt.spec && p.sp !== boxFlt.spec) return false;
  if (boxFlt.ing.size){
    const hit = [...boxFlt.ing];
    const ok = boxFlt.ingMode === 'all'
      ? hit.every(i => producesIng(m, i))     // 一隻抵好幾隻
      : hit.some(i => producesIng(m, i));     // 供得起其中一味
    if (!ok) return false;
  }
  if (boxFlt.state === 'pin' && !m.pin) return false;
  if (boxFlt.state === 'ex' && !m.ex) return false;
  if (boxFlt.state === 'plain' && (m.pin || m.ex)) return false;
  if (boxFlt.state === 'dup' && !monDup.has(idx)) return false;
  if (boxFlt.q && !monHaystack(m).includes(boxFlt.q.toLowerCase())) return false;
  return true;
}
/* 搜尋用的字串。**寶可夢箱的篩選列與自組隊伍的選擇器共用這一份** —— 兩邊各寫一份的話，
   在其中一邊打得到、另一邊打不到，而那種差異不會有任何錯誤訊息。

   暱稱一定要可搜 —— 摺疊列顯示的就是它，搜不到等於這個功能只做一半。
   學名也留著：打「嘎啦嘎啦」照樣要找得到取名成「樹果萌萌」的那隻。 */
function monHaystack(m){
  const p = D.dex[m.sp];
  return [m.nick||'', pz(p), p.d, '#'+p.no, SPEC_ZH[p.sp], bz(p.b), msz(p.ms),
    ...m.ss.filter(Boolean).map(ssz),
    ...[0,1,2].map(s=>{ const k = ingPick(m, s); return k && k[0]!=null ? iz(ING_NAME[k[0]]) : ''; }),
  ].join(' ').toLowerCase();
}
/** 排序名稱之外還要講清楚「這個名次能怎麼讀」—— 見 boxCount。 */
const SORT_WHAT = {
  ideal:     '　（資質：只比性格與副技能，同物種之間才有意義）',
  full:      '　（練滿：等級糖果先餵誰，同專長內比）',
  skillRoom: '　（技能成長：技能糖果先給誰，能量/日）',
  power:     '　（現在的產能，同專長內比）',
};
/** 目前篩選下看得到的真實索引。 */
const visibleIdx = () => roster.map((m,i)=>i).filter(i=> monMatch(roster[i], i));
function applyBoxFilter(){
  let shown = 0;
  for (const el of $('boxList').querySelectorAll('[data-i]')){
    const i = +el.dataset.i;
    const ok = monMatch(roster[i], i);
    el.hidden = !ok;
    if (ok) shown++;
  }
  const on = !!(boxFlt.spec || boxFlt.state || boxFlt.q || boxFlt.ing.size);
  $('boxNone').hidden = !(roster.length && !shown);
  const dup = monDup.size ? `　⚠ ${monDup.size} 隻重複` : '';
  /* 「選定食材的產量」排序在沒選食材時等於沒作用 —— 靜靜地不排序就是「文案說謊」
     那類 bug 的一種，所以直接寫出來要先選哪個。 */
  const need = (boxFlt.sort === 'ingAmt' && !boxFlt.ing.size) ? '　（排序要先選食材）' : '';
  /* 理想值是背景算的，算到一半的名次是錯的 —— 進度要看得到。
     而且**每個排序都要寫出它排的是什麼、可比範圍到哪**：三個數字回答三個不同的
     問題（該練誰／是不是好貨／技能糖果給誰），混著讀就會用錯軸做投資決定。 */
  const busy = idealProg ? `　資質／練滿計算中 ${idealProg.done}/${idealProg.total}…` : '';
  const what = busy ? '' : (SORT_WHAT[boxFlt.sort] || '');
  $('boxCount').textContent = !roster.length ? ''
    : (on ? `顯示 ${shown} / ${roster.length} 隻` : `共 ${roster.length} 隻`) + dup + need + busy + what;
  // 展開／收起全部的按鈕文字要跟著目前狀態走
  $('boxExpand').textContent = monOpen.size ? '收起全部' : '展開全部';
  $('boxExpand').disabled = !roster.length;
}
function renderBox(){
  const host = $('boxList');
  $('boxEmpty').style.display = roster.length ? 'none' : 'block';
  findDups();                 // 排序與篩選都可能用到，而且摘要列要顯示 ⚠
  rebuildPowerRank();         // 同專長名次；排序與摺疊列都要用
  /* data-i 一律是**真實的 roster 索引**，排序只改渲染順序。
     用篩選／排序後的序號當索引，改一格就會改到別隻身上 —— 這裡最容易寫錯。 */
  /* 理想值一隻要 ~40ms，展開全部（60 隻）就是 2 秒的凍結。展開的卡片不多時才自動
     算，其餘留一顆按鈕 —— 和「展開全部只作用在看得到的那些」同一個考量。 */
  const allowIdeal = monOpen.size <= IDEAL_AUTO_MAX;
  host.innerHTML = boxOrder().map(idx => monCard(roster[idx], idx, {allowIdeal})).join('');
  for (const el of host.querySelectorAll('[data-i]')) setMonValues(el, roster[+el.dataset.i]);
  applyBoxFilter();
  /* 摺疊列的「資質／練滿／技能成長」是背景算的 —— 一定要放在 applyBoxFilter 之後，
     它算的是**目前看得到的那些**（`visibleIdx()` 只看 monMatch，和 hidden 無關，
     但進度文字要蓋在剛寫好的 boxCount 上）。 */
  idealFillAsync();
}
$('boxList').addEventListener('change', e=>{
  const row = e.target.closest('[data-i]'); if (!row) return;
  const m = roster[+row.dataset.i], k = e.target.dataset.k;
  if (!k) return;
  if (k==='sp'){ m.sp = +e.target.value; m.ingSet = [0,0,0]; m.skillLv = 1; }
  else if (k==='ss') m.ss[+e.target.dataset.s] = e.target.value || null;
  else if (k==='ingSet') m.ingSet[+e.target.dataset.s] = +e.target.value;
  else if (k==='level') m.level = Math.max(1, Math.min(70, +e.target.value||1));
  else if (k==='skillLv') m.skillLv = Math.max(1, Math.min(8, +e.target.value||1));
  else if (k==='nature') m.nature = e.target.value;
  else if (k==='ribbon') m.ribbon = +e.target.value;
  /* 暱稱：`change` 對 text input 是「離開欄位才觸發」，所以下面的 renderBox()
     不會把你正在打的字吃掉。存的是 trim 過的值 —— 只有空白的暱稱等於沒取名。 */
  else if (k==='nick') m.nick = e.target.value.trim().slice(0, NICK_MAX);
  /* 一律重畫。展開時摺疊列還在上面，而摺疊列顯示的就是副技能／食材／等級／
     性格／⚠重複 —— 只改值不重畫，摘要就會和下面的選單不一致。
     代價是 select 的焦點會掉，但 change 是「選完才觸發」，可以接受。 */
  renderBox();
  save();
});
/* ---- 篩選列 ---- */
for (const [id, key] of [['fltSpec','spec'], ['fltState','state']])
  $(id).addEventListener('change', e=>{ boxFlt[key] = e.target.value; applyBoxFilter(); });
/* 食材篩選要**重畫**，不能只切 hidden —— 選了之後摺疊列的數字會換成「選中那幾種
   的總產量」（見 scoreChip），只切 hidden 的話顯示的還是各專長的主指標。 */
$('fltIng').addEventListener('click', e=>{
  const b = e.target.closest('[data-ing]'); if (!b) return;
  const i = +b.dataset.ing;
  if (boxFlt.ing.has(i)) boxFlt.ing.delete(i); else boxFlt.ing.add(i);
  syncIngFilterUI(); renderBox();
});
$('fltIngMode').addEventListener('click', e=>{
  const b = e.target.closest('[data-mode]'); if (!b) return;
  boxFlt.ingMode = b.dataset.mode;
  syncIngFilterUI();
  if (boxFlt.ing.size) renderBox();
});
$('fltName').addEventListener('input', e=>{ boxFlt.q = e.target.value.trim(); applyBoxFilter(); });
/* 排序會改渲染順序 → 必須重畫，不能只切 hidden。
   換排序時**方向回到正向** —— 「等級低→高」按完換去看「主技能」，繼承一個反向會
   讓人以為排序壞了；而且每個排序的正向本來就是它最常用的方向。 */
$('fltSort').addEventListener('change', e=>{
  boxFlt.sort = e.target.value; boxFlt.dir = 1;
  syncSortDirUI(); renderBox();
});
$('fltDir').addEventListener('click', ()=>{
  boxFlt.dir = boxFlt.dir === -1 ? 1 : -1;
  syncSortDirUI(); renderBox();
});
/** 清掉**篩選**（專長／狀態／搜尋字）。**排序刻意保留。**
 *
 *  以前這裡連排序一起清掉，理由寫的是「否則新增的那隻會跑到中間去」——
 *  但那是把兩件事混在一起了：**篩選會讓新增的那隻完全不出現**（預設的皮卡丘
 *  常常不符合目前的條件，按了「新增一隻」卻什麼都沒有），而**排序只是換位置**，
 *  而換位置早就由 addBtn 的 `scrollIntoView(data-i)` 解決了。
 *
 *  實際踩過（2026-09-08）：使用者用「圖鑑編號」排序在看箱子，按一下「新增一隻」
 *  整個列表就跳回加入順序 —— 看起來像排序自己壞掉。清除篩選、截圖存入、JSON
 *  匯入三條路徑全都有這個問題，因為它們都走這個函式。 */
function clearBoxFilter(){
  boxFlt = {...boxFlt, spec:'', state:'', q:'', ing:new Set()};
  $('fltSpec').value = ''; $('fltState').value = ''; $('fltName').value = '';
  syncIngFilterUI();
}
$('fltClear').addEventListener('click', ()=>{ clearBoxFilter(); renderBox(); });
/* 展開／收起全部。只展開「目前看得到的」—— 一次攤開 60 隻要建一萬多個
   <option>，而且使用者要的本來就是「把我正在看的這幾隻打開」。 */
$('boxExpand').addEventListener('click', ()=>{
  if (monOpen.size) monOpen.clear();
  else for (const i of visibleIdx()) monOpen.add(i);
  renderBox();
});
$('boxList').addEventListener('click', e=>{
  /* closest 會先找到最內層 —— 點按鈕拿到按鈕，點列的空白處才拿到 mon-head 的 toggle。 */
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const card = btn.closest('[data-i]'); if (!card) return;
  const i = +card.dataset.i, a = btn.dataset.act;
  if (a==='toggle'){
    if (monOpen.has(i)) monOpen.delete(i); else monOpen.add(i);
    renderBox();              // 展開狀態是檢視偏好，不必 save()
    return;
  }
  // 理想值：展開太多張時不自動算（會凍住），按這顆才算那一隻。算完進快取。
  if (a==='ideal'){
    idealOf(roster[i], true);
    renderBox();
    return;
  }
  /* 刪除一定要問。它就排在三顆隨手切換的按鈕旁邊，手滑一格就少一隻，而且沒有 undo
     （`save()` 是即時的，雲端也馬上跟著覆蓋）。訊息裡要寫出是**哪一隻**，不然在排序
     或篩選過的列表上根本分不出按到誰。圖示是 🗑 而不是 ✕：✕ 現在是「從推演中排除」
     那顆可逆的切換，兩顆長一樣就是在請人按錯（原本 ✕＝刪除、○＝排除，而 ○ 在中文
     慣例裡是「可以」，掛在一顆叫「排除」的按鈕上意思正好相反）。 */
  if (a==='del'){
    const m = roster[i], p = D.dex[m.sp];
    if (!confirm(`確定要刪除「#${p.no} ${pz(p)} Lv${m.level} ${natZ(NAT[m.nature]||NAT.Bashful)}」嗎？\n\n刪掉之後沒辦法復原。`)) return;
    roster.splice(i,1); monOpen.clear();                    // 索引整批位移，全收起最安全
    teamsAfterDelete(i);      // 自組隊伍存的也是 roster 索引，同一個位移問題
  }
  /* ＋隊：純檢視狀態（自組隊伍不進 serialize()），所以不 save()，自己重畫就好。 */
  else if (a==='team'){ teamAddFromBox(i); return; }
  else if (a==='pin'){ roster[i].pin = !roster[i].pin; if (roster[i].pin) roster[i].ex = false; }
  else if (a==='ex'){ roster[i].ex = !roster[i].ex; if (roster[i].ex) roster[i].pin = false; }
  renderBox(); save();
});
/* 新增時先清掉篩選 —— 新的那隻（預設皮卡丘）常常不符合目前的篩選條件，
   結果按了「新增一隻」卻什麼都沒出現。**但排序要留著**（見 clearBoxFilter），
   新的那隻靠 `boxNew` 暫時置頂，收起來就回到排序該有的位置。 */
$('addBtn').addEventListener('click', ()=>{
  roster.push(BLANK());
  clearBoxFilter();
  const at = roster.length - 1;
  monOpen.clear(); monOpen.add(at);      // 新的那隻直接展開好編輯
  boxNew = at;                           // → 渲染到列表最前面，就在「新增一隻」按鈕底下
  renderBox(); save();
  /* 置頂之後還是要捲 —— 使用者可能正停在列表中段，那時第一張卡在視窗外。
     用 data-i 找，不要用「第一張」：`boxNew` 只在展開時才置頂。 */
  const card = $('boxList').querySelector(`[data-i="${at}"]`);
  if (card) card.scrollIntoView({block:'nearest'});
});
$('exportBtn').addEventListener('click', async ()=>{
  const t = JSON.stringify(serialize());
  try { await navigator.clipboard.writeText(t); setStatus('JSON 已複製'); }
  catch(e){ window.prompt('複製下面的 JSON：', t); }
});
$('importBtn').addEventListener('click', ()=>{
  const t = window.prompt('把 JSON 貼在這裡：');
  if (!t) return;
  let o;
  try { o = JSON.parse(t); }
  catch(e){ setStatus('JSON 格式不正確'); return; }
  const n = Array.isArray(o.roster) ? o.roster.length : 0;
  /* 箱子裡已經有東西時一定要問 —— 分批建箱子的人要的是「追加」，
     而還原備份的人要的是「取代」。默默選一邊就會吃掉別人的資料。 */
  let append = false;
  if (roster.length && n){
    append = confirm(`要把這 ${n} 隻**追加**到現有的 ${roster.length} 隻後面嗎？\n\n`
                   + `確定＝追加（變成 ${roster.length + n} 隻）\n`
                   + `取消＝取代整箱（現有的 ${roster.length} 隻會被丟掉）`);
  }
  try {
    const rep = deserialize(o, {append});
    clearBoxFilter();          // 匯入的可能不符合目前篩選，會看起來像沒進去
    renderAll(); save();
    let msg = append ? `已追加 ${n} 隻（共 ${roster.length} 隻）` : `已匯入 ${roster.length} 隻`;
    /* 認不出來的「種類」一定要講。默默退回第一隻的話，畫面上會是一整排看起來
       很正常的妙蛙種子 —— 使用者只會發現「後面算出來的東西怪怪的」。 */
    if (rep.badSp.length){
      const uniq = [...new Set(rep.badSp)];
      msg += ` ⚠ 但有 ${rep.badSp.length} 筆的「種類」認不出來（${uniq.slice(0,3).join('、')}`
           + `${uniq.length > 3 ? ' 等 '+uniq.length+' 種' : ''}），已暫時設成第一隻 —— 請自己改掉。`
           + `種類要填內部名（例如 VENUSAUR）或圖鑑索引數字。`;
    }
    setStatus(msg);
  } catch(e){ setStatus('匯入失敗：' + e.message); }
});

/* ================= UI: 從截圖建立 =================
   為什麼一定要有「確認」這一步：讀錯一個等級或一個副技能，推演結果就會被靜靜地
   污染，而使用者不會知道 —— 頁面只會顯示一個看起來很確定的錯數字。所以自動判斷
   只產生一份**草稿**，附上兩個校驗碼的結果，每一欄都還是可編輯的控制項，按下
   「存入箱子」才寫進 roster。這和 index.html 的「已知簡化」是同一個原則。

   反解在 src/import.js（純函式，用引擎的 baseStats/helpInterval，不複製公式）。 */

/* 注意命名：草稿物件叫 impDraft，裝它的 DOM 容器 id 是 impRow（不是 impDraft）。
   瀏覽器會為每個 id 在 window 上建同名屬性，兩者同名時 `let` 雖然會正確遮蔽，
   但那正是 CLAUDE.md 陷阱 1 那類讀不出來的坑 —— 直接避開。 */
let impDraft = null;    // 校對中的成員（roster 形狀）—— 確認前不進 roster
let impLast  = null;    // {obs, res} 上次求解的輸入與結果
let impPick  = 0;       // 目前選的是第幾組解
let impAmbIng = [null,null,null];  // 食材各格反解不出唯一值時的候選
let impAmbSp = false, impAmbRb = false;
let impIngBad = false;  // 改過物種／等級後，×N 數字對不上任何選項
let impSkill = null;    // 主技能等級的推導結果（含說明文字）
/* 這一組解是在「有／沒有好露營券」哪一種下成立的。
   使用者把露營券留成「未指定」時 impSolve 會兩種都試，所以重新校驗一定要用
   **這組解實際採用的那一種** —— 不然拿 obs.camp（未指定→false）去算，
   camp=true 才成立的解會被誤報成不符。 */
let impCampUsed = false;
let impFiles = [];      // 對照用的截圖（object URL，不儲存也不上傳）

const impNum = id => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
const impSecFmt = s => `${Math.floor(s/60)}分${String(s%60).padStart(2,'0')}秒`;

function buildImport(){
  $('impNature').innerHTML = `<option value="">未指定</option>` + NATURE_OPTS;
  $('impMs').innerHTML = `<option value="">未指定</option>` +
    Object.keys(D.ms).map(n=>({n, z:msz(n)})).sort((a,b)=>a.z.localeCompare(b.z,'zh-Hant'))
      .map(x=>`<option value="${x.n}">${x.z}</option>`).join('');
  $('impSs').innerHTML = [0,1,2,3,4].map(s=>
    `<select data-s="${s}" title="第 ${s+1} 格 — Lv${SS_SLOT_LV[s]} 解鎖">${SS_OPTS}</select>`).join('');

  // 圖片：點選、拖進、Ctrl+V
  const drop = $('impDrop');
  drop.addEventListener('click', ()=> $('impFile').click());
  drop.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); $('impFile').click(); } });
  $('impFile').addEventListener('change', e=>{ impAddFiles(e.target.files); e.target.value=''; });
  for (const ev of ['dragenter','dragover']) drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave','drop']) drop.addEventListener(ev, ()=> drop.classList.remove('over'));
  drop.addEventListener('drop', e=>{ e.preventDefault(); impAddFiles(e.dataTransfer && e.dataTransfer.files); });
  /* 全域貼上：只在寶可夢箱這個 view、而且剪貼簿裡真的有圖片時才接手，
     否則會搶走輸入框的正常貼上。
     兩個來源都要看：截圖有時只出現在 items（DataTransferItem）而不在 files。
     只讀一邊的話會變成「按了 Ctrl+V 沒反應」這種找不到原因的 bug。 */
  document.addEventListener('paste', e=>{
    if ($('view-box').hidden || !e.clipboardData) return;
    const cd = e.clipboardData;
    const imgs = [...(cd.files || [])].filter(f=>f && /^image\//.test(f.type));
    if (!imgs.length) for (const it of cd.items || []){
      if (it.kind !== 'file' || !/^image\//.test(it.type)) continue;
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
    if (!imgs.length) return;
    e.preventDefault();
    impAddFiles(imgs);
  });

  $('impSolveBtn').addEventListener('click', impRunSolve);
  $('impReset').addEventListener('click', impResetForm);
  $('impDiscard').addEventListener('click', impClearDraft);
  $('impSave').addEventListener('click', impSaveDraft);

  // 校對表：任何欄位改動 → 更新草稿 → 立刻重新校驗
  $('impRow').addEventListener('change', e=>{
    if (!impDraft) return;
    const k = e.target.dataset.k; if (!k) return;
    const m = impDraft;
    if (k==='sp'){ m.sp = +e.target.value; impAmbSp = false; impReResolveIng(); impReDeriveSkillLv(); }
    else if (k==='level'){ m.level = Math.max(1, Math.min(70, +e.target.value||1)); impReResolveIng(); impReDeriveSkillLv(); }
    else if (k==='ss'){ m.ss[+e.target.dataset.s] = e.target.value || null; impReDeriveSkillLv(); }
    else if (k==='ingSet'){ const s = +e.target.dataset.s; m.ingSet[s] = +e.target.value; impAmbIng[s] = null; }
    else if (k==='skillLv') m.skillLv = Math.max(1, Math.min(8, +e.target.value||1));
    else if (k==='nature') m.nature = e.target.value;
    else if (k==='ribbon'){ m.ribbon = +e.target.value; impAmbRb = false; }
    /* 暱稱：截圖上唯一「畫面有、但反解用不到」的欄位。校對時順手打進去，
       存入箱子之後才認得出是哪一隻 —— 遊戲的詳細頁沒有物種名。 */
    else if (k==='nick') m.nick = e.target.value.trim().slice(0, NICK_MAX);
    renderImpReview();
  });
  // 「其他可能」列表：點一列就換成那一組解
  $('impAlts').addEventListener('click', e=>{
    const tr = e.target.closest('[data-alt]'); if (!tr || !impLast) return;
    impSelectCand(+tr.dataset.alt);
  });
}

/* ---- 對照用的截圖 ---- */
function impAddFiles(files){
  for (const f of files || []){
    if (!f || !/^image\//.test(f.type)) continue;
    impFiles.push({url: URL.createObjectURL(f), name: f.name || '貼上的圖片'});
  }
  renderImpShots();
}
function renderImpShots(){
  $('impShots').innerHTML = impFiles.map((f,i)=>
    `<div class="impshot" data-shot="${i}"><img src="${f.url}" alt="${f.name}" title="${f.name}"><button type="button" data-rm="${i}" title="移除">✕</button></div>`).join('');
}
$('impShots').addEventListener('click', e=>{
  const rm = e.target.closest('[data-rm]');
  if (rm){
    const i = +rm.dataset.rm;
    URL.revokeObjectURL(impFiles[i].url);
    impFiles.splice(i,1); renderImpShots(); return;
  }
  const shot = e.target.closest('[data-shot]');
  if (shot) shot.classList.toggle('big');
});

/* ---- 讀取觀測值 ---- */
function impObs(){
  const iv = impSecs(impNum('impIvMin') || 0, impNum('impIvSec') || 0);
  const camp = $('impCamp').value;
  return {
    level: impNum('impLevel'),
    specialty: $('impSpec').value || null,
    mainSkill: $('impMs').value || null,
    skillDisplayLv: impNum('impSkillLv'),
    skillPayload: impNum('impPayload'),
    nature: $('impNature').value || null,
    ss: [...$('impSs').querySelectorAll('[data-s]')].map(s=>s.value || null),
    ingCounts: [impNum('impIng0'), impNum('impIng1'), impNum('impIng2')],
    intervalSec: iv > 0 ? iv : null,
    carry: impNum('impCarry'),
    camp: camp === '' ? null : camp === '1',
  };
}
/** 丟掉草稿與求解狀態（保留輸入的觀測值）。 */
function impClearDraft(){
  impDraft = null; impLast = null; impPick = 0; impSkill = null;
  impAmbIng = [null,null,null]; impAmbSp = false; impAmbRb = false;
  impIngBad = false; impCampUsed = false;
  $('impReview').hidden = true;
  $('impChecks').innerHTML = ''; $('impRow').innerHTML = '';
  $('impNotes').innerHTML = ''; $('impAlts').innerHTML = '';
  $('impStatus').textContent = ''; $('impSaveStatus').textContent = '';
}
function impResetForm(){
  for (const id of ['impLevel','impIvMin','impIvSec','impCarry','impSkillLv','impPayload','impIng0','impIng1','impIng2'])
    $(id).value = '';
  $('impSpec').value = ''; $('impCamp').value = ''; $('impMs').value = ''; $('impNature').value = '';
  for (const s of $('impSs').querySelectorAll('[data-s]')) s.value = '';
  impClearDraft();
}

/* ---- 求解 ---- */
function impRunSolve(){
  const obs = impObs();
  const res = impSolve(obs);
  impClearDraft();            // 先歸零，免得上一次的歧義標記／備註留在畫面上
  impLast = {obs, res};
  $('impReview').hidden = false;
  if (!res.cands.length){
    renderImpNotes();         // 無解時只顯示原因，不留一份猜的草稿
    $('impStatus').textContent = '找不到符合的組合';
    return;
  }
  $('impStatus').textContent = res.cands.length === 1 ? '唯一解 ✓' : `${res.cands.length} 組解`;
  impSelectCand(0);
}
function impSelectCand(i){
  const res = impLast.res, c = res.cands[i]; if (!c) return;
  impPick = i;
  impDraft = {...c.m, ss: c.m.ss.slice(), ingSet: c.m.ingSet.slice()};
  impAmbIng = c.amb.slice();
  impIngBad = false;
  impSkill = c.skill;
  impCampUsed = !!c.camp;
  impAmbSp = new Set(res.cands.map(x=>x.m.sp)).size > 1;
  impAmbRb = new Set(res.cands.filter(x=>x.m.sp === c.m.sp).map(x=>x.m.ribbon)).size > 1;
  renderImpReview();
}
/** 使用者手動改了物種或等級 —— 用同一組 ×N 數字重新收斂食材欄位。
 *  對不上的時候**不要**默默填第一個選項就算了：把 impIngBad 立起來讓 UI 講出來。 */
function impReResolveIng(){
  if (!impDraft || !impLast) return;
  const r = impIngSets(impDraft.sp, impDraft.level, impLast.obs.ingCounts);
  impIngBad = !!r.impossible;
  if (r.impossible){ impDraft.ingSet = [0,0,0]; impAmbIng = [null,null,null]; return; }
  impDraft.ingSet = r.pick.slice();
  impAmbIng = r.amb.slice();
}
/** 改了副技能／等級／物種之後，主技能的基礎等級要重新推導 ——
 *  「技能等級提升」的加成變了，或換成上限不同的主技能，基礎值就不一樣。
 *  沒有技能說明數字也沒有顯示等級時什麼都不做（不要把使用者的值改掉）。 */
function impReDeriveSkillLv(){
  if (!impDraft || !impLast) return;
  const o = impLast.obs;
  if (o.skillPayload == null && o.skillDisplayLv == null) return;
  const bonus = impSkillBonus(impDraft.ss, impDraft.level);
  impSkill = impSkillLv(D.dex[impDraft.sp].ms, o.skillDisplayLv, o.skillPayload, bonus);
  impDraft.skillLv = impSkill.base;
}

/* ---- 校對區 ---- */
function renderImpReview(){ renderImpChecks(); renderImpDraft(); renderImpNotes(); renderImpAlts(); }

/** 重新校驗用的觀測值：露營券一律用「這組解實際採用的那一種」。 */
const impObsForVerify = () => ({...impLast.obs, camp: impCampUsed});

function renderImpChecks(){
  if (!impDraft || !impLast){ $('impChecks').innerHTML = ''; return; }
  const v = impVerify(impDraft, impObsForVerify());
  const cell = (label, got, want, ok, f) => {
    const cls = ok === null ? '' : ok ? ' ok' : ' bad';
    const tail = ok === null ? '沒填，未校驗' : ok ? '＝畫面 ✓' : `畫面是 ${f(want)} ✗`;
    return `<div class="impck${cls}"><span>${label}</span><b>${f(got)}</b><span class="muted">${tail}</span></div>`;
  };
  const p = D.dex[impDraft.sp];
  $('impChecks').innerHTML =
    cell('幫忙間隔', v.interval.got, v.interval.want, v.interval.ok, impSecFmt) +
    cell('持有上限', v.carry.got, v.carry.want, v.carry.ok, n=>n+'個') +
    `<div class="impck"><span>反解物種</span><b>${pz(p)}</b>` +
      `<span class="muted">#${p.no} · ${SPEC_ZH[p.sp]} · ${bz(p.b)} · ${msz(p.ms)}</span></div>`;
}

function renderImpDraft(){
  const m = impDraft;
  if (!m){ $('impRow').innerHTML = ''; return; }
  // 和寶可夢箱共用 monCard()：校對區看到的版面就是進箱子之後的版面
  $('impRow').innerHTML = monCard(m, null, {amb: {sp: impAmbSp, rb: impAmbRb, ing: impAmbIng}});
  setMonValues($('impRow').querySelector('.mon'), m);
}

function renderImpNotes(){
  if (!impLast){ $('impNotes').innerHTML = ''; return; }
  const out = [];
  const bad = !impLast.res.cands.length;
  for (const n of impLast.res.notes) out.push(`<div class="impnote${bad?' bad':''}">${n}</div>`);
  if (bad) out.push(`<div class="impnote bad">先確認<b>幫忙間隔</b>、<b>持有上限</b>、<b>等級</b>、<b>性格</b>、<b>幫忙速度</b>類副技能有沒有看錯 —— 這五項任何一項錯，等式就對不起來。也確認一下截圖時是否開著<b>好露營券</b>。</div>`);
  if (impSkill) for (const n of impSkill.notes) out.push(`<div class="impnote">主技能等級：${n}</div>`);
  /* 露營券留「未指定」時兩種都會試。camp=true 的解算出來的數字不一樣，
     所以一定要講出這組解是在哪個前提下成立的，不然使用者無從判斷對不對。 */
  if (impLast.obs.camp == null && impDraft)
    out.push(`<div class="impnote">你沒指定好露營券，這組解是在<b>${impCampUsed?'有開':'沒開'}</b>露營券的前提下成立的（${impCampUsed?'頻率與容量 ×1.2':'無加成'}）。如果不對，把上面的「好露營券」選起來再按一次自動判斷。</div>`);
  if (impIngBad) out.push(`<div class="impnote bad">你填的 ×N 數字（${impLast.obs.ingCounts.map(x=>x==null?'—':x).join('／')}）在這隻身上找不到對應的食材選項 —— 三格已重設成第一個選項，<b>請自己對著截圖選</b>。</div>`);
  const ambSlots = [0,1,2].filter(s=>impAmbIng[s] && impAmbIng[s].length > 1);
  if (ambSlots.length) out.push(`<div class="impnote">食材第 ${ambSlots.map(s=>s+1).join('、')} 格光靠 ×N 的數字分不出來（有數量相同的選項）—— 請對著截圖的圖示自己選一下，已標橘框。</div>`);
  if (impAmbSp) out.push(`<div class="impnote">有多個物種都符合，已標橘框 —— 請對著截圖的圖像確認。</div>`);
  if (impAmbRb) out.push(`<div class="impnote">緞帶反解不出唯一值，已標橘框。</div>`);
  $('impNotes').innerHTML = out.join('');
}

function renderImpAlts(){
  const cands = impLast ? impLast.res.cands : [];
  if (cands.length < 2){ $('impAlts').innerHTML = ''; return; }
  const rows = cands.slice(0,20).map((c,i)=>{
    const p = D.dex[c.m.sp];
    return `<tr class="alt${i===impPick?' on':''}" data-alt="${i}">
      <td>${pz(p)}</td><td class="n">#${p.no}</td><td>${SPEC_ZH[p.sp]}</td>
      <td>${RIBBON_LABEL[c.m.ribbon]}</td><td>${c.camp?'有':'無'}</td>
      <td class="n">${impSecFmt(c.interval)}</td><td class="n">${c.carry}個</td></tr>`;
  }).join('');
  $('impAlts').innerHTML = `<div class="impalts">
    <div class="eyebrow" style="margin-bottom:6px">其他符合的組合（點一列切換）</div>
    <div class="scroll"><table><thead><tr>
      <th>種類</th><th>圖鑑</th><th>專長</th><th>緞帶</th><th>露營券</th><th>幫忙間隔</th><th>持有上限</th>
    </tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* ---- 存入箱子 ---- */
function impSaveDraft(){
  if (!impDraft){ $('impSaveStatus').textContent = '沒有可存的草稿'; return; }
  const v = impVerify(impDraft, impObsForVerify());
  const failed = [];
  if (v.interval.ok === false) failed.push('幫忙間隔');
  if (v.carry.ok === false) failed.push('持有上限');
  if (failed.length && !confirm(`${failed.join('、')}和截圖上的數字不一致 —— 這通常表示有欄位讀錯了，存進去會讓推演結果不準。\n\n還是要存入嗎？`))
    return;
  roster.push({...impDraft, ss: impDraft.ss.slice(), ingSet: impDraft.ingSet.slice(), pin:false, ex:false});
  clearBoxFilter();            // 剛存進去的那隻一定要看得到
  renderBox(); save();
  const p = D.dex[impDraft.sp];
  impResetForm();
  for (const f of impFiles) URL.revokeObjectURL(f.url);
  impFiles = []; renderImpShots();
  $('impSaveStatus').textContent = `已存入 ${pz(p)}，箱子現在 ${roster.length} 隻`;
  $('impStatus').textContent = '';
}

/* ---- Worker 池 ----
   引擎在 engine.js，主執行緒和每個 worker 都載入同一份，所以數值一定一致。

   分片：`combinations` 按第一個自由索引切，指派由 `shardAssign` 貪婪裝箱決定
   （不是 `i % N` —— i0 越小子樹越大，那樣會讓 shard 0 拿到 2.6 倍的量）。
   各 worker 回傳自己的前 FINALISTS 名（**精簡成 idxs/score，且不跑決賽**），
   主執行緒合併 → 取全域前 N → `rehydrate` 還原 → 跑一次 `finalizeTeams`。
   結果與單執行緒窮舉**完全相同** —— 全域前 N 名必然也在各自分片的前 N 名內，
   所以合併集合一定包含它們。理由與證明見 engine.js 的 searchShard。
   `tests/smoke.mjs` 第 10 節會斷言兩條路徑逐欄位相同。

   核心數上限刻意壓在 8：再多的邊際效益被 postMessage 的序列化成本吃掉
   （每個 worker 要回傳 50 組候選，含 Float64Array）。 */
/* 上限刻意不等於 hardwareConcurrency。

   實測（Intel Core Ultra 5 135H、18 邏輯核心、40 隻箱子 658,008 組）：
     1 worker 4776ms · 2 worker 3544ms · 4 worker 2818ms
     6 worker 2441ms · 8 worker 2360ms · 16 worker 2413ms
   6 個之後就飽和在約 2x。飽和**不是分配不均** —— 各分片耗時只差 1.06~1.11x、
   浪費 3~7%，所以動態工作竊取最多也只能買到那 3~7%，不值得那個複雜度。
   天花板是機器沒有更多空閒 CPU。量測細節見 DECISIONS.md。

   留幾個邏輯核心給 UI 執行緒和使用者的其他程式 —— 這個工具不該把機器吃滿。
   用 let 是為了能在 console 或量測腳本裡改。 */
let MAX_WORKERS = 6;
let pool = [];            // [{ w, ready }]
let runSeq = 0, running = false;

function poolSize(){
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(MAX_WORKERS, hc));
}

function spawnPool(n){
  const made = [];
  for (let i = 0; i < n; i++){
    const w = new Worker('./src/engine.worker.js');
    const ready = new Promise((ok, bad) => {
      const onMsg = (e) => {
        if (e.data && e.data.type === 'ready'){ w.removeEventListener('message', onMsg); ok(w); }
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', (ev) => bad(new Error(ev.message || 'worker 載入失敗')));
    });
    // 資料只在 init 送一次；之後每次推演只送 roster 與 wk
    w.postMessage({ type:'init', data: D });
    made.push({ w, ready });
  }
  pool = made;
  return made;
}

const CANCELLED = 'psleep-cancelled';
let pendingRejects = [];   // 讓 killPool 能結束所有還在等的 promise

/** 砍掉整個 worker 池。取消只能這樣做 —— 理由見 engine.worker.js 的檔頭。 */
function killPool(){
  for (const { w } of pool) { try { w.terminate(); } catch {} }
  pool = [];
  // terminate 之後 worker 永遠不會再回訊息，等它的 promise 會就這樣掛著。
  // 主動 reject 掉，否則每次取消都留下一堆永不 settle 的 async 呼叫。
  const rs = pendingRejects; pendingRejects = [];
  for (const r of rs) r(new Error(CANCELLED));
}

/**
 * 把一次推演分片丟給 worker 池。worker 不可用時回傳 null，由呼叫端退回主執行緒。
 * @returns Promise<{cands, count, excluded, total}> —— 已合併但**尚未決賽**
 */
function searchViaPool(payload, onProgress){
  if (typeof Worker === 'undefined') return null;
  try { if (!pool.length) spawnPool(poolSize()); } catch { return null; }
  const n = pool.length;
  const seen = new Array(n).fill(0);   // 每個分片最新回報的 count
  let grandTotal = 0;

  const jobs = pool.map(({ w, ready }, i) => ready.then(() => new Promise((ok, bad) => {
    pendingRejects.push(bad);
    const onMsg = (e) => {
      const m = e.data || {};
      if (m.type === 'progress'){
        seen[i] = m.done;
        grandTotal = m.total;   // 每個分片回報的 total 都是「全部組合數」
        onProgress(seen.reduce((s, x) => s + x, 0), grandTotal);
        return;
      }
      w.removeEventListener('message', onMsg);
      if (m.type === 'shard'){
        if (m.error) bad(Object.assign(new Error('shard-error'), { shardError: m }));
        else ok(m);
      } else bad(new Error(m.message || '推演失敗'));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'shard', shard:{ index:i, total:n }, ...payload });
  })));

  return Promise.all(jobs).then(parts => {
    pendingRejects = [];
    return {
      cands: parts.flatMap(p => p.cands),
      count: parts.reduce((s, p) => s + p.count, 0),
      excluded: parts[0].excluded,   // 每個分片算出來的排除名單相同
      total: parts[0].total,
      workers: n,
      shardMs: parts.map(p => p.ms),   // 診斷用：worker 自己量的耗時
    };
  });
}

function setRunning(on){
  running = on;
  $('runBtn').disabled = on;
  $('cancelBtn').hidden = !on;
  $('runProg').hidden = !on;
  if (!on){ $('runStatus').textContent = ''; $('runProg').value = 0; }
}

const RUN_ERR = {
  few:    n => `箱子裡至少要有 5 隻可用的寶可夢（目前 ${n} 隻）。`,
  nopool: () => `目前的料理類型／範圍下沒有任何食譜可比較。`,
  pins:   n => `固定（📌）的寶可夢超過 5 隻，請減少到 5 隻以內。`,
  fewBerry: n => `套用「樹果型只考慮本週加成樹果」之後只剩 ${n} 隻可用（需要 5 隻）。`
              + `請調整本週加成樹果、把需要的成員用 📌 固定（固定的不受此限），或關掉那個選項。`,
};

async function run(){
  if (running) return;                 // 一次只跑一個
  const seq = ++runSeq;

  // 前置驗證與主執行緒的準備工作（這些都要 DOM 或會被 renderResults 用到）
  const active = roster.filter(m => !m.ex);
  if (active.length < 5){ $('results').innerHTML = `<div class="notice warn">${RUN_ERR.few(active.length)}</div>`; return; }
  wk.recipe = D.recipes.find(r=>r.n===wk.recipeName) || D.recipes[0];
  buildPool(wk);                       // renderResults 的 rankRecipesForTeam 需要 POOL
  if (!POOL.length){ $('results').innerHTML = `<div class="notice warn">${RUN_ERR.nopool()}</div>`; return; }
  roster.forEach(m => { m._bs = baseStats(m, wk); });   // memberCard 需要 _bs

  setRunning(true);
  $('runStatus').textContent = '推演中…';
  const onProgress = (done, total) => {
    if (seq !== runSeq) return;
    const pct = total ? Math.min(100, Math.round(done/total*100)) : 0;
    $('runProg').value = pct;
    $('runStatus').textContent = `推演中… ${pct}%（${done.toLocaleString()} / ${total.toLocaleString()}）`;
  };

  // _bs 和 recipe 不必送過去：worker 自己會算 / 自己從 recipeName 解析。
  // 少送這兩樣可以讓 postMessage 的 payload 小很多。
  const payload = {
    roster: roster.map(m => { const c = {...m}; delete c._bs; return c; }),
    wk: { ...wk, recipe: undefined },
  };

  const t0 = performance.now();
  let res = null, nWorkers = 0;
  try {
    const p = searchViaPool(payload, onProgress);
    if (p){
      const merged = await p;
      if (seq !== runSeq) return;
      nWorkers = merged.workers;
      /* worker 回傳的是精簡候選（只有 idxs/score）。合併 → 取全域前 FINALISTS 名
         → 在主執行緒 rehydrate 成完整結果 → 跑一次決賽。
         POOL 與 _bs 上面都準備好了，rehydrate 與 finalizeTeams 都需要。 */
      const top = merged.cands.slice().sort(byScore).slice(0, FINALISTS);
      res = { best: finalizeTeams(rehydrate(top, roster, wk), roster, wk),
              count: merged.count, shardMs: merged.shardMs,
              excluded: merged.excluded.map(i => D.dex[roster[i].sp].n) };
    }
  } catch (err){
    if (err.message === CANCELLED) return;   // 使用者按了取消，狀態已由 cancelBtn 處理好
    if (err.shardError){                     // worker 回報了引擎層的錯誤（例如候選不足 5 隻）
      setRunning(false);
      const m = err.shardError, f = RUN_ERR[m.error];
      $('results').innerHTML = `<div class="notice warn">${f ? f(m.n) : '推演失敗，請重試。'}</div>`;
      return;
    }
    console.warn('worker 推演失敗，退回主執行緒：', err.message);
    killPool();
    res = null;
  }
  if (seq !== runSeq) return;           // 已經有更新的推演，丟棄這次結果

  if (!res){
    // 退路：沒有 Worker（或 worker 掛了）就在主執行緒跑，UI 會凍住但至少有答案
    $('runStatus').textContent = '推演中…（無 Worker，畫面會暫停）';
    await new Promise(r => setTimeout(r, 20));   // 讓上面那行先畫出來
    res = searchTeams(roster, wk, {});
    if (seq !== runSeq) return;
  }

  setRunning(false);
  if (!res || res.error){
    const f = res && RUN_ERR[res.error];
    if (res && res.error === 'stopped') return;
    $('results').innerHTML = `<div class="notice warn">${f ? f(res.n) : '推演失敗，請重試。'}</div>`;
    return;
  }
  lastResults = res.best; shownAlt = 0;
  const cut = res.excluded ? res.excluded.length : 0;
  /* **煮得出來的只有幾道，一定要寫在這裡。** 沒解鎖的食譜整個不進池子，那是候選
     過濾 —— 陷阱 4：靜靜地少算候選就是「文案說謊」那一類的 bug。 */
  $('comboCount').textContent = `${res.count.toLocaleString()} 種組合 · ${Math.round(performance.now()-t0)}ms`
    + ` · 食譜 ${recipesOn(wk)}/${D.recipes.length} 道已解鎖`
    + (cut ? ` · 已排除 ${cut} 隻樹果不符的樹果型` : '')
    + (nWorkers ? ` · ${nWorkers} 執行緒` : ' · 主執行緒');
  // 排除名單要看得到 —— 靜靜地少算候選是這個 repo 最不想要的行為
  const shardTip = res.shardMs ? '\n\n各分片耗時：' + res.shardMs.map(x => x + 'ms').join(' / ') : '';
  $('comboCount').title = (cut
    ? '因「樹果型只考慮本週加成樹果」而未列入候選：\n' + res.excluded.map(n => pz(D.dex.find(d=>d.n===n))).join('、')
    : '') + shardTip;
  renderResults();
}

$('cancelBtn').addEventListener('click', ()=>{
  if (!running) return;
  runSeq++;                 // 讓還在飛的結果被丟棄
  killPool();               // 同步迴圈只能靠 terminate 中斷
  setRunning(false);
  $('comboCount').textContent = '已取消';
});

/* ================= RESULTS RENDER ================= */
/* 「為什麼是這一隻」。
 *
 * **每一句都從實際算出來的數字回推，不是事後編的說法。** 每個理由都對應到卡片上
 * 看得到的欄位，否則就變成無法查證的形容詞 —— 那比不解釋更糟。
 *
 * 主力那一項用的是「佔隊伍該分項的比例」而不是絕對值：三種產出的單位不同
 * （樹果／主技能是卡比獸能量，食材是還沒經過料理放大的原能量），絕對值不可比，
 * 但「牠貢獻了這隊樹果的幾成」是可比的。 */
function pickReason(k, r){
  const i = r.idxs[k], m = roster[i], p = D.dex[m.sp], o = r.outs[k], bs = m._bs;
  const A = 1 + wk.areaBonus/100;
  const ingOf = x => { let v = 0; for (let n = 0; n < NING; n++) v += x.ing[n] * ING_VAL[n]; return v; };
  const tot = f => r.outs.reduce((s, x) => s + f(x), 0);
  const parts = [
    ['樹果',   o.berryStrength, tot(x => x.berryStrength), v => `樹果 ${fmt(v * 7 * A)}／週`],
    ['主技能', o.skillStrength, tot(x => x.skillStrength), v => `主技能能量 ${fmt(v * 7 * A)}／週`],
    ['食材',   ingOf(o),        tot(ingOf),                v => `食材 ${fmt(v * 7)}／週（未經料理加成）`],
  ].filter(x => x[1] > 0);
  /* 四組，順序就是**優先度** —— 因為只放得下三句（見底下的 slice）。
     排序的準則不是「哪一句好聽」，而是**「這一句在卡片上還有沒有別的地方看得到」**：

     | 組 | 內容 | 別處看得到嗎 |
     |---|---|---|
     | `head` | 主要產出佔隊上幾成 | 卡片右邊就是那些數字，這句只是把它定位 |
     | `team` | 牠**對隊友**做了什麼，而且有數字 | **沒有** —— 底下那排 pill 只給整隊合計，看不出是誰供的 |
     | `own`  | 牠自己的其他量化貢獻 | 部分（食材列） |
     | `flag` | 靜態標籤 | pill 或名字旁的 tag 也看得到 |

     **踩過（2026-09-10，使用者反映「這個推演結果有點詭異」）：** 以前是一條固定順序
     推進同一個陣列再 `slice(0,3)`。於是純補師（胖可丁，活力全體療癒S）的卡片上留下的是
     「食材 17k／週　佔這隊食材的 9%」，而「每日補活力 每隻 90」排在第 4 被砍掉 ——
     **那是牠入選的唯一理由**：實測同一個位置換成非補師，隊伍週能量從 1,097,922 掉到
     923,140（−18.9%），另外四隻的活力從 100% 全部掉到 0%。畫面因此在解釋一個
     無關緊要的數字，然後把真正的理由藏起來。 */
  const head = [], team = [], own = [], flag = [];
  let cost = null;
  if (parts.length){
    const main = parts.slice().sort((a, b) => (b[1] / (b[2] || 1)) - (a[1] / (a[2] || 1)))[0];
    head.push(`${main[3](main[1])}　<b>佔這隊${main[0]}的 ${Math.round(main[1] / (main[2] || 1) * 100)}%</b>`);
  }
  /* 瓶頸食材是「為什麼非牠不可」最強的理由 —— 換掉牠，主食譜就少煮好幾次。 */
  if (r.bottleneck != null && o.ing[r.bottleneck] * 7 > 1)
    own.push(`供應瓶頸食材 <b>${iz(ING_NAME[r.bottleneck])}</b> ${f1(o.ing[r.bottleneck] * 7)}／週`);
  if (wk.fav.has(p.b)) flag.push(`產本週加成樹果（能量 ×2）`);
  if (bs.hasHB) flag.push(`帶「幫忙加成」：全隊幫手間隔 −5%`);
  if (bs.hasERB) flag.push(`帶「活力回復提升」：睡眠回復 +14%`);
  if (/^Helper Boost/.test(p.ms)) flag.push(`幫手加速：發動時讓全隊各多幫忙一次`);
  /* **單位要標出來。** `energyGiven` / `helpsGiven` 是「這隻一天發出去的總量」
     ＝ 每位成員拿到的量 × 5；而下方那排 pill 顯示的 `ctx.supportEnergy` /
     `ctx.extraHelps` 是 `/5` 之後的**每人平均**。同一個畫面上兩個差 5 倍的數字，
     不標單位就會被讀成同一件事（實際被問過）。 */
  /* 自回活力和「補給隊友」是兩件事，**不能併成一句**：前者只有牠自己拿得到，
     而且價值已經反映在牠自己的幫忙次數上（見 engine 的定點迭代）。以前這兩份被
     加在一起再 ÷5 攤給全隊，等於持有者少拿 4/5、隊友白拿。 */
  if (o.energySelfGiven > 0)
    own.push(`<span title="這隻的主技能每天回給**牠自己**的活力（活力填充S／月光）。&#10;活力越高幫忙間隔越短，所以這一份的價值已經算在上面的幫忙次數裡了。&#10;隊友拿不到 —— 那是另一條「每日補活力」。">每日自回活力 <b>${f1(o.energySelfGiven)}</b></span>`);
  if (o.energyGiven > 0)
    team.push(`<span title="這隻的主技能每天補給隊上**每一位成員**的活力。&#10;整隊 5 隻收到的合計是 ${f1(o.energyGiven)}／日。&#10;下面那排 pill 的「技能補活力 每隻」是隊上所有補師加起來的每人總量。&#10;活力越高幫忙間隔越短，所以補師的價值是透過隊友的產出體現的。">每日補活力 <b>每隻 ${f1(o.energyGiven/5)}</b></span>`);
  if (o.helpsGiven > 0.2)
    team.push(`<span title="這隻的主技能每天讓**每一位成員**多完成的幫忙次數。&#10;整隊 5 隻合計是 ${f1(o.helpsGiven)} 次／日。&#10;下面那排 pill 的「額外幫忙 每隻」是隊上所有來源加起來的每人總量。">每日多幫忙 <b>每隻 ${f1(o.helpsGiven/5)} 次</b></span>`);
  /* 代價也要寫出來 —— 只講好處就是選擇性呈現。夢魘的扣活力打的是非惡屬性隊友。 */
  if (o.energyDrain < 0) cost = `<span style="color:var(--neg)">代價：每日扣非惡屬性隊友活力 ${f1(-o.energyDrain)}</span>`;
  /* **代價永遠不能被砍掉** —— 只講好處就是選擇性呈現（見這一節的規則）。
     所以它不去搶那三格，而是另外接在後面，前面只留兩句。 */
  const shown = [...head, ...team, ...own, ...flag].slice(0, cost ? 2 : 3);
  return (cost ? [...shown, cost] : shown).join('　·　');
}
function memberCard(rank, i, r, o){
  const m = roster[i], p = D.dex[m.sp], bs = m._bs;
  const act = bs.act.map(a=>sss(a));
  const ingList = [];
  for (let k=0;k<NING;k++) if (o.ing[k]*7 > 12) ingList.push(iz(ING_NAME[k])+' '+f1(o.ing[k]*7));
  return `<div class="mem">
    <div class="rank">${rank}</div>
    <div>
      <div class="nm">${esc(monName(m))}${
        /* 推演結果是**最需要暱稱的地方**：箱子裡有兩隻妙蛙花時，選中的是哪一隻只有
           暱稱分得出來。但學名也一定要在（不然不知道要看哪一隻的數值），所以並列。 */
        (m.nick||'').trim() ? `<span class="nm-sci">${pz(p)}</span>` : ''
      }<span class="tag ${SPEC_TAG[p.sp]}">${SPEC_ZH[p.sp]}</span>${wk.fav.has(p.b)?`<span class="tag fav">加成樹果</span>`:''}${m.pin?`<span class="tag pin">固定</span>`:''}</div>
      <div class="meta">Lv${m.level} · ${natZ(NAT[m.nature]||NAT.Bashful)} · ${act.length?act.join('／'):'無副技能'} · 頻率 ${Math.round(o.sim.freqBase/60*10)/10}分</div>\n      <div class="meta">${msz(p.ms)} Lv${bs.skillLv} · 每日發動 ${f1(o.sim.procs)} 次 ${msCaveat(p.ms)}</div>
      <div class="meta" style="color:var(--ing)">${ingList.length?ingList.join('　'):'（無食材產出）'}</div>
      <div class="why">${pickReason(rank-1, r)}</div>
    </div>
    <div class="out">
      <div><span class="muted">週能量</span> ${fmt((o.berryStrength+o.skillStrength)*7*(1+wk.areaBonus/100))}</div>
      <div class="muted" title="每天實際完成的幫忙次數（含睡眠期間存下來的那些）。&#10;每次幫忙會帶回樹果或食材，也有機率發動主技能。">幫忙 ${f1(o.sim.productive)} 次／日${o.sim.snack>0.5?` · <span title="睡覺時背包裝滿之後仍在幫忙，但拿不到那些產物 —— 這個數字大就代表該補「持有上限」副技能或緞帶。">背包滿 ${f1(o.sim.snack)}</span>`:''}</div>
      <div class="muted" title="活力 80 以上時，幫忙間隔最短（×0.45）—— 也就是產出最快的狀態。&#10;這個數字 = 一天有幾個小時處在那個狀態。&#10;&#10;活力檔位（決定幫忙間隔要乘多少）：&#10;　80 以上 ×0.45（最快）&#10;　60〜79　 ×0.52&#10;　40〜59　 ×0.58&#10;　1〜39　　×0.66&#10;　0　　　　×1.00（最慢）&#10;&#10;80 到 150 是同一格 —— 超過 80 不會更快，但掉回 80 以下要更久&#10;（起床 100 只撐 3.3 小時，起床 150 撐 11.7 小時）。&#10;&#10;比例低就是這隻活力不夠：考慮帶補師（活力填充／活力全體療癒），或睡久一點。" style="color:${o.sim.fastShare>=0.6?'var(--pos)':o.sim.fastShare>=0.3?'var(--ing)':'var(--neg)'}">活力80以上 ${f1(o.sim.fastHours)}h／日（${Math.round(o.sim.fastShare*100)}%）</div>
    </div>
  </div>`;
}
/* 食材利用率：一週產出的食材裡，真正進了鍋的比例。
 *
 * **食材過剩以前完全不出聲。** UI 只在食材**不足**（`mp.idleMeals > 0`）時警告，但實際
 * 更常見的是相反：剩下的食材分數是零，而畫面一片安靜 —— 使用者只會覺得「推演怎麼都不
 * 選食材型」。靜靜地丟掉一半食材而不講，和「靜靜地少算候選」是同一類的文案說謊。
 *
 * **但診斷不能歸錯原因。** 第一版寫的是「一週最多 21 餐 × 鍋容量，所以食材型再多也吃
 * 不下，要先提高鍋子容量」—— 那是錯的，而且會害使用者去加一個沒用的東西。實測：
 *
 *   全食材隊 potEff 81：容量上限 21×81 = 1701，實際只煮掉 1373，而且 21 餐**全滿**
 *   樹果隊把鍋子加到 332：容量上限 6972，利用率還是 52%（加鍋子完全沒有幫助）
 *
 * 真正的原因是**木桶效應**：每道料理要湊齊它需要的**每一味**，`cooks` 取的是
 * `min(floor(pool[i]/a))` —— 最缺的那一味決定能煮幾次。所以產量高但種類不均的話，
 * 多的那幾味只能堆著（那支全食材隊剩 1259 個蜂蜜，卻因為可可／蛋只有 104 個而煮不了
 * 高價食譜）。鍋容量只有在**高價食譜的 `cnt` 超過 `potEff`** 時才真的在擋路，那要另外
 * 判斷，不能從利用率反推。
 *
 * 沒有 `mp`（還沒跑決賽排程）就不出聲 —— 猜一個數字比不講更糟。 */
const ING_UTIL_WARN = 0.75;
function ingUtilNotice(r){
  if (!r.mp) return '';
  let total = 0; for (let k=0;k<NING;k++) total += r.wIng[k];
  if (total <= 0) return '';
  /* 用掉的 = 食譜指定的 ＋ 塞進鍋子空位的。**填充那一段以前完全沒算**（見 mealPlan），
     所以這個百分比在 2026-09-09 之前是嚴重低估的。 */
  let cooked = 0; for (const x of r.mp.plan) cooked += x.r.cnt * x.n;
  const filled = r.mp.fillN || 0;
  const used = cooked + filled;
  if (used / total >= ING_UTIL_WARN) return '';

  /* 「哪幾味堆著沒用」比一個百分比有用得多 —— 那才是你能拿去做決定的東西。 */
  const left = [];
  for (let k=0;k<NING;k++) if (r.mp.leftover[k] > 1) left.push([k, r.mp.leftover[k]]);
  left.sort((a,b)=>b[1]-a[1]);
  const topLeft = left.slice(0,3).map(([k,v])=>`${iz(ING_NAME[k])} ${Math.round(v)}`).join('、');
  /* 鍋子是不是**真的**在擋路：看有沒有高價食譜因為 `cnt > potEff` 根本進不了鍋。
     POOL 已經按單道能量由高到低排序，所以看前段就夠。這是唯一能推薦「加鍋容量」的
     依據 —— 從利用率反推會推出錯的結論（見上面的實測）。 */
  const blocked = POOL.slice(0, 15).filter(c => c.cnt > r.potEff);
  /* **一定要講出「每道食譜的食材數是固定的」。**
     使用者的實際反應：「一週產 1393，一餐可以用掉 81，為什麼只煮掉 519？」——
     因為鍋容量是「一道最多能放幾個」的上限，而**每道食譜要幾個食材是食譜自己決定的**
     （78 道的中位數只有 33，最小 7）。那次排程排出來的是「×16 每道 23 個」＋
     「×5 每道 9 個」＝ 413 個，塞不進 81 個/餐的空間。只講百分比不講這件事，
     使用者會以為是程式算錯。 */
  const mealsCooked = r.mp.plan.reduce((s,x)=>s+x.n, 0);
  const roomLeft = (r.mp.room || 0) - filled;
  return `<div class="notice">食材利用率 <b>${Math.round(used/total*100)}%</b>`
    + `（一週產 ${Math.round(total)} 個，用掉 ${Math.round(used)} 個`
    + `＝食譜指定 ${Math.round(cooked)} ＋ 填進鍋子空位 ${Math.round(filled)}）`
    + `——剩下的 ${Math.round(total-used)} 個沒有分數。`
    + (r.mp.idleMeals > 0
        ? `<br>還有 <b>${r.mp.idleMeals} 餐排不進去</b>，表示連便宜的食譜都湊不齊食材。`
          + `（那幾餐在遊戲裡會退成拌拌料理，這個工具目前<b>不計分</b>。）`
        : roomLeft <= 0
          /* 填充補上之後，鍋子容量**真的**變成瓶頸了 —— 每一鍋的空位 = 容量 − 食譜的
             食材數，21 餐加起來就是能額外塞進去的總量。這和「食材種類湊不齊」是不同的
             限制：填充不挑種類，所以剩下的食材是被**空位**擋住，不是被木桶效應擋住。 */
          ? `<br><b>${MEALS_WEEK} 餐都排滿了，而且每一鍋的空位也全部塞滿了</b>`
            + `（總空位 ${Math.round(r.mp.room)} 格）。要再多用一點食材，只有兩條路：`
            + `<b>加大鍋子容量</b>（每餐多出來的格子 × ${mealsCooked} 餐），`
            + `或改煮<b>食材數較少</b>的食譜（空位變多，但單道能量較低 —— 通常不划算）。`
          : `<br>${MEALS_WEEK} 餐都排滿了，鍋子空位還有 ${Math.round(roomLeft)} 格沒填滿。`)
    + (topLeft ? `目前剩最多的是 <b>${topLeft}</b>。` : '')
    /* 這一句和上面那句是**兩件不同的事**：上面說的是「這 21 鍋的容量用完了」，
       這裡說的是「還有更貴的食譜連進鍋的機會都沒有」。 */
    + (blocked.length
        ? `<br>另外有 ${blocked.length} 道更高價的食譜因為鍋子容量只有 ${r.potEff} 而放不進去`
          + `（最貴的那道要 ${blocked[0].cnt} 個）—— 加鍋子容量對這一項也有幫助，`
          + `但還是要湊得齊它們要的食材種類。`
        : '')
    + `</div>`;
}

/* 一支隊伍的完整詳情：5 個 panel（成員卡＋能量拆解／食材缺口／最能煮的食譜／21 餐排程）。
 *
 * **推演分頁與「自組隊伍」分頁共用這一份。** 和 `monCard` 同時給寶可夢箱與截圖校對區用、
 * `idealPctFrom` 只能有一份是同一個理由：兩份一定會走鐘，而走鐘的那份會**靜靜地**顯示
 * 錯的數字。這裡尤其危險 —— 兩個分頁對同一支隊伍給出不同數字，整個工具的可信度就沒了。
 *
 * 吃的是 `scoreTeam` ＋ `finalizeTeams` 產出的結果物件，**不讀「目前在看哪一隊」那類
 * 全域狀態** —— 那是呼叫端的事。`opts.rosterLabel` 只換那行小標題（推演是「建議」，
 * 自組隊伍是使用者自己挑的，講「建議」就變成文案說謊）。 */
function teamDetailHTML(r, opts){
  const O = opts || {};
  const TR = r.recipe;
  const recipeIngs = new Map(TR.ings);
  const bars = TR.ings.map(([i,a])=>{
    const have = r.wIng[i], canCook = Math.floor(have/a);
    const ratio = Math.min(1, canCook/MEALS_WEEK), short = canCook < MEALS_WEEK;
    return `<div class="barrow${canCook<1?' lack':''}" title="一週產 ${f1(have)}，每次需 ${a}">
      <div>${iz(ING_NAME[i])}</div>
      <div class="bar"><i style="width:${Math.max(ratio*100,1.5).toFixed(1)}%;background:${canCook<1?'var(--neg)':short?'var(--ing)':'var(--pos)'}"></i></div>
      <div class="v">${canCook} 次</div>
    </div>`;
  }).join('');
  const extra = [];
  for (let k=0;k<NING;k++) if (!recipeIngs.has(k) && r.wIng[k] > 15) extra.push([k, r.wIng[k]]);
  extra.sort((a,b)=>b[1]-a[1]);

  const warn = !r.fits ? `<div class="notice warn">鍋子容量不足：這道食譜需要 ${TR.cnt} 個食材，你目前平日有效容量 ${r.potEff}。換小一點的食譜，或把「食譜選擇」切到自動配對讓它自己挑。</div>` : '';
  const util = ingUtilNotice(r);
  const bn = r.bottleneck!=null ? iz(ING_NAME[r.bottleneck]) : '—';

  return `
  ${warn}${util}
  <div class="panel hero" style="margin-top:${warn||util?'12px':'0'}">
    <div class="roster">
      <div class="eyebrow">${O.rosterLabel || '建議先發 5 隻'}</div>
      ${r.idxs.map((i,n)=>memberCard(n+1, i, r, r.outs[n])).join('')}
      <!-- 這一列是**整隊共用**的加成（teamContext 算出來的），不屬於任何一隻。
           以前寫 HB / ERB 這種縮寫 —— 那是原始碼裡的變數名，不是使用者看得懂的字。 -->
      <div class="pillrow" style="margin-top:4px">
        <span class="pill" title="隊上帶「幫忙加成」副技能的隻數。&#10;每一隻讓全隊的幫手間隔 −5%（最多算到 5 隻）—— 所以它的價值主要在隊友身上。">幫忙加成 ×${r.ctx.nHB}</span>
        <span class="pill" title="隊上帶「活力回復提升」副技能的隻數。&#10;每一隻讓睡眠回復的活力 +14%（最多算到 5 隻），活力越高幫忙間隔越短。">活力回復提升 ×${r.ctx.nERB}</span>
        <span class="pill" title="隊上的主技能（活力填充／活力全體療癒之類）每天補給**每一位成員**的活力。&#10;成員卡上那句「每日補活力 N 全隊合計」是這個數字 ×5。&#10;活力高 → 幫忙間隔短 → 產出變多。">技能補活力 每隻 ${Math.round(r.ctx.supportEnergy)}／日</span>
        ${r.ctx.extraHelps>0.2?`<span class="pill" title="幫手支援S、治癒波動之類的主技能，每天讓**每一位成員**額外完成的幫忙次數。&#10;成員卡上那句「每日多幫忙 N 次 全隊合計」是這個數字 ×5。">額外幫忙 每隻 ${f1(r.ctx.extraHelps)}／日</span>`:''}
        ${r.ctx.darkDrain<0?`<span class="pill" style="color:var(--neg)" title="夢魘（達克萊伊）每天扣掉的活力，只打在**惡屬性以外**的成員身上。&#10;惡屬性隊友與達克萊伊自己免疫。">夢魘扣活力 ${Math.round(-r.ctx.darkDrain)}／日</span>`:''}
      </div>
    </div>
    <div class="totals">
      <div>
        <div class="eyebrow">本週卡比獸總能量</div>
        <div class="bigfig">${fmt(r.total)}</div>
      </div>
      <div>
        <div class="subfig"><span>樹果</span><b>${fmt(r.berryS)}</b></div>
        <div class="subfig"><span>料理</span><b>${fmt(r.dishS)}</b></div>
        <div class="subfig"><span>主技能</span><b>${fmt(r.skillS)}</b></div>
      </div>
      <div>
        <div class="eyebrow">${wk.recipePick==='auto'?'自動選中的主食譜':'指定食譜'}</div>
        <div style="font-size:13.5px;font-weight:700;margin:3px 0 2px">${recipeZh(TR.n)}</div>
        <div class="subfig"><span>主食譜可煮</span><b>${r.cooksCapped} / 21 餐</b></div>
        <div class="subfig"><span>單道能量 (Lv${rlvl(TR, wk)})</span><b>${fmt(r.rv)}</b></div>
        <div class="subfig"><span>瓶頸食材</span><b>${bn}</b></div>
      </div>
    </div>
  </div>

  <div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);margin-top:16px;gap:16px">
    <div class="panel">
      <div class="phead"><h3>主食譜食材缺口</h3><span class="muted" style="font-size:12px">每樣食材夠煮幾次 · 滿格＝21 餐</span></div>
      <div class="pbody">${bars}
        ${extra.length?`<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
          <div class="eyebrow" style="margin-bottom:6px">其他食材（可換別的食譜）</div>
          <div class="chips">${extra.slice(0,10).map(([k,v])=>`<span class="pill">${iz(ING_NAME[k])} ${f1(v)}</span>`).join('')}</div></div>`:''}
      </div>
    </div>
    <div class="panel">
      <div class="phead"><h3>這隊最能煮的食譜</h3><span class="muted" style="font-size:12px">以目前產量排序 ·「卡在」＝最缺的那一味</span></div>
      <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
      <table><thead><tr><th>食譜</th><th style="text-align:right">煮/週</th><th>卡在</th><th style="text-align:right">週能量</th><th></th></tr></thead>
      <tbody>${rankRecipesForTeam(r, wk).slice(0,7).map(x=>`<tr${x.rec.n===wk.recipe.n?' style="background:color-mix(in srgb,var(--accent) 12%,transparent)"':''}>
        <td>${recipeZh(x.rec.n)} <span class="muted num">共${x.rec.cnt}</span>${x.fits?'':' <span class="tag pin">鍋子不足</span>'}</td>
        <td class="n" style="text-align:right">${x.capped}</td>
        <td class="muted" style="font-size:11.5px">${x.capped < MEALS_WEEK && x.bn != null ? iz(ING_NAME[x.bn]) : '—'}</td>
        <td class="n" style="text-align:right">${fmt(x.strength)}</td>
        <td><button class="btn sm ghost" data-setrecipe="${x.rec.n}">設為目標</button></td></tr>`).join('')}
      </tbody></table></div></div>
    </div>
  </div>

  ${r.mp ? `<div class="panel" style="margin-top:16px">
    <div class="phead"><h3>本週 21 餐排程</h3><span class="muted" style="font-size:12px">同一個食材池貪婪填滿 · 依單道能量由高到低 · 鍋子剩下的空位會塞其他食材</span></div>
    <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
    <table><thead><tr><th>餐次</th><th>食譜</th><th style="text-align:right">次數</th><th style="text-align:right">單道</th><th style="text-align:right">小計</th></tr></thead>
    <tbody>${r.mp.plan.map((x,n)=>`<tr>
      <td class="n">${n+1}</td>
      <td>${recipeZh(x.r.n)} <span class="muted num">共${x.r.cnt}</span>${(x.primary || x.r.n===TR.n)?' <span class="tag pin">主食譜</span>':''}</td>
      <td class="n" style="text-align:right">${x.n}</td>
      <td class="n" style="text-align:right">${fmt(x.each)}</td>
      <td class="n" style="text-align:right">${fmt(x.n*x.each*r.mul)}</td></tr>`).join('')}
      ${r.mp.fillN>0?`<tr><td></td>
        <td title="湊齊食譜需要的食材之後，鍋子剩下的空位可以繼續塞別的食材進去。&#10;額外食材只算它的原始基礎單價 —— 不吃食譜等級倍率、也不吃食譜加成，&#10;但大成功與島嶼加成作用在整鍋總和上，所以那兩個照吃。&#10;因此填鍋優先用基礎單價高的食材（呆呆獸尾巴 342、南瓜 250、大蔥 185…）。&#10;每一鍋的空位 = 鍋子容量 − 該食譜的食材數。"><b>鍋子空位填入其他食材</b> <span class="muted num">共 ${r.mp.room} 格</span> <span class="muted" style="font-size:11px">只計基礎單價</span></td>
        <td class="n" style="text-align:right">${r.mp.fillN} 個</td>
        <td class="n" style="text-align:right">—</td>
        <td class="n" style="text-align:right">${fmt(r.mp.fillE)}</td></tr>`:''}
      ${r.mp.idleMeals>0?`<tr><td></td><td class="muted">食材不足，${r.mp.idleMeals} 餐無法排入（實際遊戲會退成拌拌料理，這個工具不計分）</td><td class="n" style="text-align:right">${r.mp.idleMeals}</td><td></td><td class="n" style="text-align:right">—</td></tr>`:''}
    </tbody></table></div></div>
  </div>` : ''}`;
}

/* 「設為目標」按鈕。詳情 HTML 掛在哪裡就在哪裡綁。
   `after` 是改完食譜之後要做的事 —— 推演分頁要重跑整個推演（3 萬組，很貴），
   自組隊伍分頁只要重畫（單隊 scoreTeam 是毫秒級）。 */
function bindTeamDetail(host, after){
  host.querySelectorAll('[data-setrecipe]').forEach(b=>b.addEventListener('click', ()=>{
    wk.recipeName = b.dataset.setrecipe; $('recipe').value = wk.recipeName; syncRecipeIngs(); save();
    (after || run)();
  }));
}

function renderResults(){
  if (!lastResults || !lastResults.length){
    $('results').innerHTML = roster.filter(m=>!m.ex).length < 5
      ? `<div class="notice">先到右上角「寶可夢箱」分頁建立至少 5 隻，才能開始推演。</div>`
      : `<div class="notice">設定好本週條件後，按「推演最佳隊伍」。</div>`;
    return;
  }
  const r = lastResults[shownAlt];
  $('results').innerHTML = teamDetailHTML(r) + `
  <div class="grid" style="grid-template-columns:1fr;margin-top:16px;gap:16px">
    <div class="panel">
      <div class="phead"><h3>替代隊伍</h3><span class="muted" style="font-size:12px">點一列切換　·　「→ 自組隊伍」把那一組帶去手動換人</span></div>
      <div class="pbody" style="padding:0">
        <div class="scroll" style="border:0;border-radius:0 0 12px 12px">
        <table><thead><tr><th>#</th><th>組合</th><th style="text-align:right">週能量</th><th style="text-align:right">煮</th><th></th></tr></thead>
        <tbody>${lastResults.map((x,n)=>`<tr class="alt${n===shownAlt?' on':''}" data-alt="${n}">
          <td class="n">${n+1}</td>
          <td>${x.idxs.map(i=>pz(D.dex[roster[i].sp])).join('・')}</td>
          <td class="n" style="text-align:right">${fmt(x.total)}</td>
          <td class="n" style="text-align:right">${x.cooksCapped}</td>
          <td><button class="btn sm ghost" data-toteam="${n}" title="把這一組複製成一支新的自組隊伍，可以換人再看數字">→ 自組隊伍</button></td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>
  </div>`;
  $('results').querySelectorAll('.alt').forEach(tr=>tr.addEventListener('click', e=>{
    if (e.target.closest('[data-toteam]')) return;   // 按鈕不該順便切換「正在看哪一組」
    shownAlt = +tr.dataset.alt; renderResults();
  }));
  $('results').querySelectorAll('[data-toteam]').forEach(b=>b.addEventListener('click', ()=>{
    teamFromResult(+b.dataset.toteam);
  }));
  bindTeamDetail($('results'));
}

/* ================= 自組隊伍 =================
   手動指定 5 隻看數字，而不是讓推演去找。和推演分頁的關係是「同一件事的兩種模式」。

   **計算基礎百分之百比照推演**：同一份 `wk`、同一個 `scoreTeam`、同一個 `finalizeTeams`。
   刻意不自己重寫決賽排程 —— 兩份一定會走鐘，而這裡走鐘的後果是兩個分頁對同一支隊伍
   給出不同的數字。`tests/smoke.mjs` 直接斷言「自組隊伍算出的 total ＝ 推演對同一組
   算出的 total」，那是「計算基礎一致」唯一可執行的定義。

   **不進 `serialize()`。** 純檢視狀態，和 `boxFlt` / `monOpen` 同一個待遇：切分頁保留、
   重新整理清空。所以 `SCHEMA` 不用動，也沒有雲端同步的問題。

   `members` 存的是**真實 roster 索引**（和 `data-i` 同一套慣例）。因此箱子刪除成員時
   一定要跟著修（`teamsAfterDelete`）、整批取代 roster 時一定要清（`teamsReset`）——
   和 `monOpen` 完全一樣的陷阱，而且同樣不會有任何錯誤訊息，只是靜靜地指到別隻。

   狀態（`teams` / `teamShown` / `picker`…）宣告在檔案前段的狀態區，見那裡的註解。 */

/** roster 被刪掉第 di 隻：指到牠的格子清空，後面的索引整批前移一格。 */
function teamsAfterDelete(di){
  for (const t of teams)
    t.members = t.members.map(x => x == null ? null : x === di ? null : (x > di ? x - 1 : x));
}
/** 整批換掉 roster（雲端下載、JSON「取代」匯入）時，舊索引指的已經是完全不同的寶可夢。 */
function teamsReset(){ teams = [newTeam()]; teamShown = 0; picker = null; }
/** 索引越界就地清成 null —— 任何路徑漏了上面兩個掛鉤時的最後一道防線。 */
function sanitizeTeams(){
  for (const t of teams)
    t.members = t.members.map(x => (x != null && x >= 0 && x < roster.length) ? x : null);
  if (teamShown >= teams.length) teamShown = 0;
}

/** 搜尋與 POOL 的前置，和 `run()` 開頭做的是同一件事。 */
function prepTeamCalc(){
  wk.recipe = D.recipes.find(r=>r.n===wk.recipeName) || D.recipes[0];
  buildPool(wk);
  if (!POOL.length) return false;
  roster.forEach(m => { m._bs = baseStats(m, wk); });
  return true;
}
/** 一支隊伍的結果。**湊滿 5 隻才算**（見下），沒滿就是 null。 */
function computeTeam(t, ready){
  t.result = null;
  if (!ready) return;
  if (t.members.some(x => x == null)) return;
  /* `teamContext` 的 `energyTeam*5` 與 `qE(energy/5)` 兩邊都寫死 5 人，所以不足 5 隻
     算出來的數字沒有意義（技能補的能量會被低估）。與其給一個看起來像答案的錯數字，
     不如老實說還差幾隻。 */
  const r = scoreTeam(t.members, roster, wk, new Map());
  t.result = finalizeTeams([r], roster, wk, 1)[0] || null;
}

/* `lastResults` 是**跑推演那一刻**的 roster 索引。之後在箱子裡刪掉一隻，那些索引就
   會越界或指到別隻 —— 而刪除只呼叫 `renderBox()`，不會清掉 lastResults。所以凡是要
   拿舊結果的索引去讀 `roster` 的地方，都要先確認它還有效。 */
const resultAlive = r => !!r && r.idxs.every(i => i >= 0 && i < roster.length);

/** 把推演結果的第 n 組複製成一支自組隊伍。推演分頁與本分頁共用這一個入口。 */
function teamFromResult(n){
  const r = lastResults && lastResults[n];
  if (!resultAlive(r)) return;
  let ti = teams.findIndex(t => t.members.every(x => x == null));
  if (ti < 0){
    if (teams.length < TEAMS_MAX){ teams.push(newTeam()); ti = teams.length - 1; }
    else {
      ti = teams.length - 1;
      if (!confirm(`已經有 ${TEAMS_MAX} 支隊伍（上限）。要覆蓋「隊伍 ${ti+1}」嗎？`)) return;
    }
  }
  teams[ti].members = r.idxs.slice();
  teamShown = ti;
  showView('team');
  renderTeamsView();
}

/** ＋隊按鈕的 title。**要說出目標是哪一支隊伍** —— 畫面上同時有 4 支的可能，
 *  按下去進了哪一支不講清楚就是猜的。 */
function teamAddTitle(idx, inTeam){
  const here = inTeam.includes(teamShown + 1);
  return (here ? `已經在隊伍 ${teamShown + 1} 裡` : `加進「自組隊伍」的隊伍 ${teamShown + 1}（放進第一個空格）`)
       + (inTeam.length ? ` · 目前在隊伍 ${inTeam.join('、')}` : '');
}
/** 從寶可夢箱直接把一隻放進自組隊伍。
 *
 *  **目標是「目前顯示的那一支」（`teamShown`）的第一個空格**，不是隨便找一支空的 ——
 *  和 `teamFromResult` 不同，那個是「整組複製過來」所以該開新的一支；這個是逐隻放，
 *  一隻放進 A、下一隻卻跳到 B 的話根本組不起來。
 *
 *  找寶可夢的地方本來就是箱子（有篩選、排序、資質%），所以「看到就順手放進去」比
 *  「切到自組隊伍 → 開選擇器 → 再搜尋一次」少三步。規則和選擇器共用：
 *  **同隊不可重複**（會讓 Helper Boost 的物種計數、流星群的龍屬性種類數全部算錯），
 *  跨隊可以。滿了就說滿了，不要靜靜地什麼都沒發生。 */
function teamAddFromBox(i){
  sanitizeTeams();
  const t = teams[teamShown]; if (!t) return;
  const nm = monLabel(i), tn = teamShown + 1;
  const at = t.members.indexOf(i);
  if (at >= 0){ setStatus(`${nm} 已經在隊伍 ${tn} 的第 ${at + 1} 格`); return; }
  const s = t.members.indexOf(null);
  if (s < 0){ setStatus(`隊伍 ${tn} 已經滿 5 隻 —— 到「自組隊伍」清掉一格，或按 ＋ 開新的一支`); return; }
  t.members[s] = i;
  const left = t.members.filter(x => x == null).length;
  setStatus(`${nm} → 隊伍 ${tn} 第 ${s + 1} 格` + (left ? `（還差 ${left} 隻）` : '（滿 5 隻，可以看數字了）'));
  renderBox();              // ＋隊按鈕的狀態要跟著更新（只有箱子分頁按得到，所以不必重畫自組隊伍）
}
/** 給提示訊息用的稱呼：暱稱優先，但學名一定要在 —— 箱子裡有兩隻妙蛙花時分不出是哪一隻。 */
function monLabel(i){
  const m = roster[i]; if (!m) return '';
  const p = D.dex[m.sp], nick = (m.nick || '').trim();
  return nick ? `「${nick}」（${pz(p)}）` : `「${pz(p)}」`;
}

/* `strictBerry` 是**候選過濾**規則，不是計分規則 —— 手動隊已經親手指定了 5 隻，所以它
   自然不生效（你的立場：手動權力最大）。但那會造成一個看起來矛盾的狀況：這裡算得好好的
   一支隊伍，推演分頁永遠不會推薦。講出來才不會變成另一種「文案說謊」。 */
function teamBerryWarn(t){
  if (wk.strictBerry === false || !wk.fav || !wk.fav.size) return '';
  const bad = t.members.filter(i => i != null).filter(i => {
    const dx = D.dex[roster[i].sp];
    return dx.sp === 'berry' && !wk.fav.has(dx.b);
  });
  if (!bad.length) return '';
  const who = bad.map(i => `${esc(monName(roster[i]))}（${bz(D.dex[roster[i].sp].b)}）`).join('、');
  return `<div class="notice" style="margin:8px 0 0">這裡照算：${who} 是樹果型但不產本週加成樹果。`
       + `推演分頁因為「樹果型必須產本週加成樹果」不會選出這個組合 —— 數字本身沒問題，`
       + `只是別拿它跟推演的名次對照。</div>`;
}

function teamSlotHTML(ti, si){
  const i = teams[ti].members[si];
  if (i == null)
    return `<button type="button" class="tmslot empty" data-pick="${ti}.${si}">＋ 選擇</button>`;
  const m = roster[i], p = D.dex[m.sp], bs = m._bs;
  const nick = (m.nick||'').trim();
  const lv = bs ? ` Lv${bs.skillLv}` : '';
  return `<div class="tmslot filled">
    <button type="button" class="tmpick" data-pick="${ti}.${si}" title="換一隻">
      <div class="tms-1"><span class="num">#${p.no}</span><b${nick?' class="is-nick"':''}>${esc(nick || pz(p))}</b><span class="num">Lv${m.level}</span><span class="tag ${SPEC_TAG[p.sp]}">${SPEC_ZH[p.sp]}</span>${m.ex?'<span class="tag" title="在推演裡被排除，但自組隊伍不受限">🚫</span>':''}</div>
      <div class="tms-2">${nick?esc(pz(p))+' · ':''}${msz(p.ms)}${lv} · ${natZ(NAT[m.nature]||NAT.Bashful)}</div>
    </button>
    <button type="button" class="tmx" data-clear="${ti}.${si}" title="移除這一格">✕</button>
  </div>`;
}
function teamCardHTML(t, ti){
  const filled = t.members.filter(x => x != null).length;
  const r = t.result;
  return `<div class="tmcard${ti===teamShown?' on':''}" data-team="${ti}">
    <div class="tmhead">
      <b>隊伍 ${ti+1}</b>
      ${r ? `<span class="tmtot">週能量 ${fmt(r.total)}</span>`
          : `<span class="muted">還差 ${5-filled} 隻</span>`}
      <button type="button" class="tmx" data-delteam="${ti}"
        title="${teams.length>1?'刪除這支隊伍':'清空這支隊伍'}">✕</button>
    </div>
    <div class="tmslots">${[0,1,2,3,4].map(s=>teamSlotHTML(ti,s)).join('')}</div>
    ${teamBerryWarn(t)}
  </div>`;
}

/* 比較列。**差額一律對「第一支算得出結果的隊伍」算** —— 對「目前在看的那一隊」算會讓
   數字隨著點來點去一直變，對「目前最高分」算則在你刻意比較兩個非最佳方案時繞路。 */
const TEAM_ROWS = [
  ['本週卡比獸總能量', r => r.total,  true],
  ['樹果',            r => r.berryS, true],
  ['料理',            r => r.dishS,  true],
  ['主技能',          r => r.skillS, true],
  ['主食譜可煮',      r => r.cooksCapped, false],
];
function renderTeamCompare(){
  const host = $('teamCompare');
  const done = teams.map((t,i)=>({t,i})).filter(x => x.t.result);
  if (done.length < 2){ host.innerHTML = ''; return; }
  const base = done[0];
  const diff = (v, bv, money) => {
    const d = v - bv;
    if (Math.abs(d) < 0.5) return '';
    const s = (d > 0 ? '+' : '−') + (money ? fmt(Math.abs(d)) : Math.abs(d));
    return ` <span class="tmdiff ${d>0?'up':'down'}">${s}</span>`;
  };
  host.innerHTML = `<div class="panel" style="margin-top:16px">
    <div class="phead"><h3>隊伍比較</h3><span class="muted" style="font-size:12px">差額對「隊伍 ${base.i+1}」</span></div>
    <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
    <table><thead><tr><th>項目</th>${done.map(x=>`<th style="text-align:right">隊伍 ${x.i+1}</th>`).join('')}</tr></thead>
    <tbody>${TEAM_ROWS.map(([label, get, money])=>`<tr>
      <td>${label}</td>
      ${done.map(x=>{
        const v = get(x.t.result), bv = get(base.t.result);
        return `<td class="n" style="text-align:right">${money?fmt(v):v}${x.i===base.i?'':diff(v,bv,money)}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody></table></div></div>
  </div>`;
}
function renderTeamDetailPane(){
  const host = $('teamDetail');
  const done = teams.map((t,i)=>({t,i})).filter(x => x.t.result);
  if (!done.length){
    host.innerHTML = roster.length
      ? `<div class="notice" style="margin-top:16px">每支隊伍湊滿 5 隻才會算出結果 —— 隊伍情境（幫忙加成、技能補能量、Helper Boost 的列數）要 5 隻才成立，不足 5 隻算出來的數字沒有意義。</div>`
      : '';
    return;
  }
  if (!teams[teamShown] || !teams[teamShown].result) teamShown = done[0].i;
  const tabs = done.length > 1
    ? `<div class="tmtabs">${done.map(x=>`<button type="button" class="tmtab${x.i===teamShown?' on':''}" data-showteam="${x.i}">隊伍 ${x.i+1}</button>`).join('')}</div>`
    : '';
  host.innerHTML = `<div style="margin-top:16px">${tabs}</div>`
    + teamDetailHTML(teams[teamShown].result, {rosterLabel:`隊伍 ${teamShown+1} 的 5 隻`});
  bindTeamDetail(host, renderTeamsView);
}
function syncTeamBar(){
  $('tmAdd').disabled = teams.length >= TEAMS_MAX;
  $('tmAdd').title = teams.length >= TEAMS_MAX
    ? `最多 ${TEAMS_MAX} 支 —— 再多就比不動了，先刪掉一支反而更容易做決定`
    : '再加一支隊伍來比較';
  /* 只列出索引還有效的那幾組（見 resultAlive）—— 箱子刪過寶可夢之後，舊的推演結果
     指到的可能已經是別隻或越界。`value` 用原本的名次，選了才對得回 lastResults。 */
  const alive = (lastResults || []).map((x,n)=>({x,n})).filter(o => resultAlive(o.x));
  $('tmPlanSel').disabled = !alive.length;
  $('tmFromPlan').disabled = !alive.length;
  $('tmPlanSel').innerHTML = alive.length
    ? alive.map(({x,n})=>`<option value="${n}">推演 #${n+1}　${fmt(x.total)}　${x.idxs.map(i=>pz(D.dex[roster[i].sp])).join('・')}</option>`).join('')
    : `<option>（還沒跑過推演）</option>`;
  $('tmNote').textContent = alive.length ? ''
    : (lastResults && lastResults.length ? '箱子改過了，推演結果已過期 —— 請重新推演一次。'
                                         : '「從推演結果複製」要先到推演分頁跑一次。');
}
function renderTeamsView(){
  sanitizeTeams();
  const host = $('teamList');
  if (!roster.length){
    host.innerHTML = `<div class="notice">先到「寶可夢箱」分頁建立寶可夢，才能組隊。</div>`;
    $('teamCompare').innerHTML = ''; $('teamDetail').innerHTML = '';
    syncTeamBar(); return;
  }
  const ready = prepTeamCalc();
  teams.forEach(t => computeTeam(t, ready));
  host.innerHTML = teams.map((t,i)=>teamCardHTML(t,i)).join('');
  renderTeamCompare();
  renderTeamDetailPane();
  syncTeamBar();
}

/* ---- 選擇器（浮層）----
   點空位在旁邊開一個浮層，不推擠版面 —— 這個分頁的核心動作是「換掉一隻馬上看數字
   怎麼變」，內嵌展開的話每開一次選擇器就把正在看的結果推走，每次換人都要重新找回視線。

   排序沿用寶可夢箱當前的 `boxFlt.sort`／`dir`（`boxOrder()`），搜尋走共用的
   `monHaystack` —— 但**篩選條件是選擇器自己的**（`pickerQ` / `pickerSpec`），
   不吃 `boxFlt` 的篩選，否則會出現「箱子篩了食材 → 這裡莫名少了一半」。 */
function openPicker(ti, si, anchor){
  picker = {t: ti, s: si};
  pickerQ = ''; pickerSpec = '';
  $('pickQ').value = '';
  renderPickerList();
  const el = $('tmPicker');
  el.hidden = false;
  for (const b of el.querySelectorAll('[data-pickspec]'))
    b.setAttribute('aria-pressed', b.dataset.pickspec === pickerSpec ? 'true' : 'false');
  positionPicker(anchor);
  $('pickQ').focus();
}
function closePicker(){ picker = null; $('tmPicker').hidden = true; }
function positionPicker(anchor){
  const el = $('tmPicker'), r = anchor.getBoundingClientRect();
  el.style.visibility = 'hidden'; el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left, top = r.bottom + 6;
  if (left + w > innerWidth - 8) left = Math.max(8, innerWidth - 8 - w);
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - 6 - h);   // 下面放不下就翻到上面
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.visibility = '';
}
function renderPickerList(){
  if (!picker) return;
  const t = teams[picker.t];
  /* 同一隊裡不能重複 —— `scoreTeam` 用 roster 索引，同一隻放兩次會讓 Helper Boost
     的物種計數、龍屬性種類數等等全部算錯。跨隊則刻意允許（比較兩隊通常只換 1~2 隻）。 */
  const taken = new Set(t.members.filter((x,k) => x != null && k !== picker.s));
  const q = pickerQ.trim().toLowerCase();
  const rows = boxOrder().filter(i => {
    const m = roster[i];
    if (pickerSpec && D.dex[m.sp].sp !== pickerSpec) return false;
    if (q && !monHaystack(m).includes(q)) return false;
    return true;
  });
  $('pickCount').textContent = rows.length ? `${rows.length} 隻` : '';
  $('pickList').innerHTML = rows.length ? rows.map(i => {
    const m = roster[i], p = D.dex[m.sp], nick = (m.nick||'').trim();
    const dis = taken.has(i);
    /* 在別隊出現過要標出來 —— 你正在比較兩隊，「這隻兩邊都有」正是你需要知道的事。 */
    const other = teams.map((x,n)=> n!==picker.t && x.members.includes(i) ? n+1 : 0).filter(Boolean);
    const pct = idealPct(m);
    return `<button type="button" class="pickrow" data-take="${i}"${dis?' disabled title="這一隊已經有牠了"':''}>
      <div class="pk-1"><span class="num">#${p.no}</span><b${nick?' class="is-nick"':''}>${esc(nick || pz(p))}</b><span class="num">Lv${m.level}</span><span class="tag ${SPEC_TAG[p.sp]}">${SPEC_ZH[p.sp]}</span>${m.ex?'<span class="tag">🚫</span>':''}${other.length?`<span class="tag pin">隊伍 ${other.join('、')}</span>`:''}</div>
      <div class="pk-2">${nick?esc(pz(p))+' · ':''}${msz(p.ms)}${pct!=null?` · 資質 ${Math.round(pct)}%`:''}</div>
    </button>`;
  }).join('') : `<div class="muted" style="padding:14px;text-align:center">找不到符合的</div>`;
}

/* ================= VIEWS ================= */
const VIEWS = ['plan','team','box','recipes'];
function showView(name){
  for (const v of VIEWS) $('view-'+v).hidden = (v !== name);
  for (const b of $('viewNav').querySelectorAll('[data-view]'))
    b.setAttribute('aria-pressed', b.dataset.view === name ? 'true' : 'false');
  if (name !== 'team') closePicker();     // 浮層是 fixed 的，切走了不關會浮在別的分頁上
  if (name === 'recipes') renderRecipeLevels();
  if (name === 'team') renderTeamsView();
  // 理想值只在看得到箱子的時候才背景算（見 idealFillAsync），所以切過來要補開一輪
  if (name === 'box') idealFillAsync();
  window.scrollTo({top:0, behavior:'instant'});
}
$('viewNav').addEventListener('click', e=>{
  const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view);
});

/* ---- 自組隊伍的事件（委派）----
   `renderTeamsView()` 每次都重畫整個 #teamList，所以綁在容器上一次就好 ——
   和寶可夢箱同一個做法。跨一次重畫沿用舊的元素參考會靜靜地失效（那個節點已經
   脫離 DOM，dispatchEvent 不會冒泡到委派處理器），測試裡要每次重新 querySelector。 */
$('teamList').addEventListener('click', e=>{
  const pick = e.target.closest('[data-pick]');
  if (pick){
    const [ti, si] = pick.dataset.pick.split('.').map(Number);
    openPicker(ti, si, pick);
    return;
  }
  const clr = e.target.closest('[data-clear]');
  if (clr){
    const [ti, si] = clr.dataset.clear.split('.').map(Number);
    teams[ti].members[si] = null;
    closePicker(); renderTeamsView();
    return;
  }
  const del = e.target.closest('[data-delteam]');
  if (del){
    const ti = +del.dataset.delteam;
    const t = teams[ti];
    const has = t.members.some(x => x != null);
    /* 有成員才問。重建一支隊伍要重選 5 隻，不是零成本 —— 和「刪除寶可夢一定要問」
       同一個道理，只是這裡不會動到真實資料，所以空隊直接刪不必打斷。 */
    if (has && !confirm(`要${teams.length>1?'刪除':'清空'}「隊伍 ${ti+1}」嗎？\n\n`
        + t.members.filter(x=>x!=null).map(i=>monName(roster[i])).join('、'))) return;
    if (teams.length > 1) teams.splice(ti, 1); else teams[0] = newTeam();
    if (teamShown >= teams.length) teamShown = teams.length - 1;
    closePicker(); renderTeamsView();
    return;
  }
  const card = e.target.closest('[data-team]');
  if (card){ teamShown = +card.dataset.team; renderTeamsView(); }
});
$('teamDetail').addEventListener('click', e=>{
  const tab = e.target.closest('[data-showteam]');
  if (tab){ teamShown = +tab.dataset.showteam; renderTeamsView(); }
});
$('tmAdd').addEventListener('click', ()=>{
  if (teams.length >= TEAMS_MAX) return;
  teams.push(newTeam());
  teamShown = teams.length - 1;
  renderTeamsView();
});
$('tmFromPlan').addEventListener('click', ()=>{
  const n = +$('tmPlanSel').value;
  if (Number.isFinite(n)) teamFromResult(n);
});

/* ---- 選擇器的事件 ---- */
$('pickQ').addEventListener('input', e=>{ pickerQ = e.target.value; renderPickerList(); });
$('tmPicker').addEventListener('click', e=>{
  const sp = e.target.closest('[data-pickspec]');
  if (sp){
    pickerSpec = sp.dataset.pickspec;
    for (const b of $('tmPicker').querySelectorAll('[data-pickspec]'))
      b.setAttribute('aria-pressed', b.dataset.pickspec === pickerSpec ? 'true' : 'false');
    renderPickerList();
    return;
  }
  const take = e.target.closest('[data-take]');
  if (take && !take.disabled && picker){
    teams[picker.t].members[picker.s] = +take.dataset.take;
    closePicker();
    renderTeamsView();
  }
});
/* 外點關閉。用 capture 是因為 #teamList 的處理器會在同一次點擊裡重畫整個列表 ——
   等冒泡上來時原本的目標節點已經不在 DOM 裡，closest 就判斷不出點在哪。 */
document.addEventListener('mousedown', e=>{
  if (!picker) return;
  if (e.target.closest('#tmPicker') || e.target.closest('[data-pick]')) return;
  closePicker();
}, true);
document.addEventListener('keydown', e=>{ if (e.key === 'Escape' && picker) closePicker(); });

/* ================= RECIPE LEVELS ================= */
const RLB_MAX = D.rlb[70] || 3.58;
function renderRecipeLevels(){
  const type = $('rlvType').value, q = $('rlvSearch').value.trim().toLowerCase();
  const sort = $('rlvSort').value;
  let list = D.recipes.filter(r=>{
    if (type !== 'all' && r.t !== type) return false;
    if (!q) return true;
    const hay = (recipeZh(r.n) + ' ' + r.n + ' ' + r.ings.map(([i])=>iz(ING_NAME[i])).join(' ')).toLowerCase();
    return hay.includes(q);
  }).map(r=>({r, lv: rlvl(r, wk), on: recipeOn(r, wk),
              val: recipeValue(r, rlvl(r, wk))}));
  const cmp = {value:(a,b)=>b.val-a.val, lv:(a,b)=>b.lv-a.lv, cnt:(a,b)=>a.r.cnt-b.r.cnt,
               name:(a,b)=>recipeZh(a.r.n).localeCompare(recipeZh(b.r.n),'zh-Hant')}[sort];
  list.sort(cmp);
  const TYPE_ZH = {curry:'咖哩／濃湯', salad:'沙拉', dessert:'甜點／飲品'};
  $('rlvBody').innerHTML = list.map(x=>{
    const mul = D.rlb[x.lv] || 1;
    return `<tr data-r="${x.r.n}"${x.on ? '' : ' class="rlv-off"'}>
      <td><b>${recipeZh(x.r.n)}</b><div class="muted" style="font-size:11.5px">${x.r.ings.map(([i,a])=>iz(ING_NAME[i])+'×'+a).join('・')}</div></td>
      <td class="muted" style="font-size:12px">${TYPE_ZH[x.r.t]}</td>
      <td class="n" style="text-align:right">${x.r.cnt}</td>
      <td style="text-align:center"><button type="button" class="btn sm ghost rlv-tog${x.on?' on':''}" data-tog="${x.r.n}"
        title="${x.on ? '已解鎖 —— 點一下改成「還沒解鎖」，它就不會進推演，等級也會清掉'
                      : `還沒解鎖 —— 點一下解鎖（等級先填 ${wk.recipeLv}，之後可以改）。&#10;沒解鎖的食譜煮不出來，所以完全不列入推演。`}">${x.on?'✓ 已解鎖':'鎖上'}</button></td>
      <td style="text-align:center"><input type="number" min="1" max="70" step="1" data-rlv="${x.r.n}"
        value="${x.on ? x.lv : ''}" placeholder="—"${x.on ? '' : ' disabled'}></td>
      <td class="n" style="text-align:right;color:${!x.on?'var(--muted)':mul>=2?'var(--pos)':mul>=1.4?'var(--ing)':'var(--muted)'}">${x.on?`×${mul.toFixed(2)}`:'—'}</td>
      <td class="n" style="text-align:right">${x.on?fmt(x.val):'—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted" style="padding:22px;text-align:center">沒有符合的食譜</td></tr>`;
  syncRecipeCount();
}
/** 「已解鎖 N / 78」有好幾個地方要用，所以只寫一份 —— 和 `PATHS`／`SYNCED_WHAT`
 *  同一個道理：同一件事有兩個來源，就一定會有一個在說謊。 */
function syncRecipeCount(){
  const on = recipesOn(wk), total = D.recipes.length;
  const txt = `（已解鎖 ${on} / ${total} 道）`;
  if ($('rlvCount')) $('rlvCount').textContent = txt;
  /* **一道都沒解鎖是個懸崖，一定要講出來。** 靜靜地把料理算成 0，使用者只會
     覺得推演壞了 —— 這就是陷阱 4 的「排除名單要顯示出來」。 */
  if ($('rlvNone')) $('rlvNone').hidden = on > 0;
}
$('rlvBody').addEventListener('change', e=>{
  const k = e.target.dataset.rlv; if (!k) return;
  wk.recipeLevels = wk.recipeLevels || {};
  const v = e.target.value.trim();
  /* 清空 ＝ 鎖上。**等級的有無就是解鎖狀態**，不另外存一份（見 engine 的 recipeOn）。 */
  if (v === '') delete wk.recipeLevels[k];
  else wk.recipeLevels[k] = Math.max(1, Math.min(70, Math.round(Number(v)) || 1));
  save(); renderRecipeLevels();
});
/* 解鎖／鎖上。解鎖時先填「本週條件」的預設等級當起點，使用者再改成實際的。 */
$('rlvBody').addEventListener('click', e=>{
  const b = e.target.closest('[data-tog]'); if (!b) return;
  const k = b.dataset.tog;
  wk.recipeLevels = wk.recipeLevels || {};
  if (recipeOn({n:k}, wk)) delete wk.recipeLevels[k];
  else wk.recipeLevels[k] = Math.max(1, Math.min(70, Math.round(Number(wk.recipeLv)) || 1));
  save(); renderRecipeLevels();
});
for (const id of ['rlvType','rlvSearch','rlvSort']) $(id).addEventListener('input', renderRecipeLevels);
/* 批次只作用在**目前篩選看得到的那幾道** —— 和箱子的「展開／收起全部」同一條規則。
   78 道一道一道點太痛，但「全部」在有篩選時會是個驚喜。 */
function rlvVisible(){
  const type = $('rlvType').value, q = $('rlvSearch').value.trim().toLowerCase();
  return D.recipes.filter(r=>{
    if (type !== 'all' && r.t !== type) return false;
    if (!q) return true;
    const hay = (recipeZh(r.n) + ' ' + r.n + ' ' + r.ings.map(([i])=>iz(ING_NAME[i])).join(' ')).toLowerCase();
    return hay.includes(q);
  });
}
$('rlvAllOn').addEventListener('click', ()=>{
  const list = rlvVisible(), lv = Math.max(1, Math.min(70, Math.round(Number(wk.recipeLv)) || 1));
  wk.recipeLevels = wk.recipeLevels || {};
  /* 已經有等級的不要蓋掉 —— 那是使用者一道一道填的，批次操作不該把它抹平。 */
  let n = 0;
  for (const r of list) if (!recipeOn(r, wk)){ wk.recipeLevels[r.n] = lv; n++; }
  save(); renderRecipeLevels();
  setStatus(n ? `解鎖了 ${n} 道（等級先填 ${lv}，記得改成實際的）` : '看得到的這些本來就全部解鎖了');
});
$('rlvAllOff').addEventListener('click', ()=>{
  const list = rlvVisible().filter(r=>recipeOn(r, wk));
  if (!list.length){ setStatus('看得到的這些本來就全部是鎖上的'); return; }
  /* 鎖上會把等級一起清掉，而等級是一道一道填的 —— 沒有 undo，所以要問，
     而且要寫出是幾道（和刪除寶可夢同一條規則）。 */
  if (!window.confirm(`把這 ${list.length} 道標成「還沒解鎖」？它們填過的等級會一起清掉，沒有復原。`)) return;
  for (const r of list) delete wk.recipeLevels[r.n];
  save(); renderRecipeLevels();
  setStatus(`鎖上了 ${list.length} 道`);
});

/* ================= DATA VERSION ================= */
let metaStatus = null, metaReq = null;
function renderVersion(){
  const m = D.meta || {};
  const selfHosted = !window.claude;
  $('verSrc').innerHTML = `${m.src||'—'}<br>commit ${m.commit||'—'} · ${m.commitDate||'—'}<br>打包於 ${m.builtAt||'—'}`;
  $('verZh').textContent = m.zhSrc || '—';
  renderStorageNote();      // #verBuild 那一行歸它管（停用同步時只有它會被重跑）
  $('verCounts').textContent = `${D.dex.length} 隻寶可夢 · ${D.recipes.length} 道食譜 · ${D.subskills.length} 個副技能 · ${D.islands.length} 個研究區域`;
  if (selfHosted){
    $('refreshBtn').disabled = true;
    $('refreshBtn').textContent = '自架版本不適用';
    $('refreshNote').innerHTML = `這是<b>自架版本</b>，遊戲資料是靜態快照，不會自己更新。更新方式：在 repo 根目錄跑 ${code(C.rebuild)} 從上游重新萃取，確認 ${code('git diff ' + P.data)} 合理後 commit。詳見 repo 的 README。`;
  }
  const parts = [];
  if (metaStatus && metaStatus.lastCheckedAt) parts.push('檢查：' + metaStatus.lastCheckedAt.slice(0,16).replace('T',' '));
  if (metaStatus && metaStatus.message) parts.push(metaStatus.message);
  if (metaReq && metaReq.requestedAt) parts.push('已排入更新請求：' + metaReq.requestedAt.slice(0,16).replace('T',' '));
  $('verStatus').innerHTML = parts.length ? parts.join('<br>') : '尚無記錄';
}
$('refreshBtn').addEventListener('click', async ()=>{
  const btn = $('refreshBtn');
  if (!dbObj){
    $('refreshNote').innerHTML = window.claude
      ? '<b style="color:var(--neg)">這個檢視連不上雲端資料庫，請求無法排隊。</b> 請直接在對話裡跟 Claude 說「更新資料」。'
      : `<b>自架版本沒有收單機制。</b> 更新方式是在 repo 根目錄跑 ${code(C.rebuild)} 重新萃取，然後 commit ${code(P.data)}。`;
    return;
  }
  btn.disabled = true; btn.textContent = '送出中…';
  try {
    metaReq = {requestedAt: new Date().toISOString(), source: 'page'};
    await dbObj.doc('meta/refresh').set(metaReq);
    btn.textContent = '已排入佇列 ✓';
    $('refreshNote').innerHTML = '請求已送出。Claude 下次收單（每週一早上）會比對上游與官網公告，有變動就更新並把結果寫回這裡。<b>等不了的話在對話裡說一句「更新資料」，我當場處理。</b>';
  } catch(e){
    btn.disabled = false; btn.textContent = '請求更新資料';
    $('refreshNote').innerHTML = '<b style="color:var(--neg)">送出失敗。</b> 請直接在對話裡跟 Claude 說「更新資料」。';
  }
  renderVersion();
});

/* ================= THEME ================= */
try { const t = localStorage.getItem('psleep-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch(e){}
$('themeBtn').addEventListener('click', ()=>{
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const now = cur ? cur : (sysDark ? 'dark' : 'light');
  const next = now==='dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('psleep-theme', next); } catch(e){}
});

/* ================= INIT ================= */
function renderAll(){ syncWeeklyUI(); renderBox(); renderResults(); renderVersion(); if (!$('view-recipes').hidden) renderRecipeLevels(); if (!$('view-team').hidden) renderTeamsView(); }
buildWeekly();
buildBoxBar(); syncIngFilterUI(); syncSortDirUI();
buildImport();
if (!wk.fav.size) wk.fav = new Set(['ORAN','PAMTRE','PECHA']);
boot().then(()=>{ if (roster.length>=5) run(); });
