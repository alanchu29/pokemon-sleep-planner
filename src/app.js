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

/* 資料結構版本。`data/game.json` 的 meta.schema 必須等於這個值。
   動到欄位結構（改名／改型別／移除）時兩邊一起 +1；純數值更新不用動。

   為什麼需要這個：拆檔之後 app.js 與 game.json 是兩個獨立快取的資源，
   GitHub Pages 送 max-age=600，所以更新後有最多 10 分鐘的窗口，瀏覽器可能
   拿到「新 app.js ＋ 舊 game.json」。純數值過期還好，結構變了就會算出錯的
   數字或直接壞掉 —— 而使用者只會看到壞頁面，不知道重新整理就好。 */
const SCHEMA = 1;

/** 致命錯誤：整頁換成一段說明。這種狀況下繼續跑只會產生錯的數字。 */
function fatal(html){
  const w = document.querySelector('.wrap');
  if (w) w.innerHTML = `<section><h1 style="margin:0 0 10px">無法啟動</h1><p class="muted">${html}</p></section>`;
  throw new Error('fatal: ' + html.replace(/<[^>]*>/g, ''));
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
/** 睡眠緞帶的標籤。索引就是 m.ribbon，對應 engine.js 的 RIBBON_CARRY。 */
const RIBBON_LABEL = ['無','200h','500h','1000h','2000h'];
const NAT_AB = {speed:"速度",ingredient:"食材",skill:"技能",energy:"活力",exp:"EXP"};
const natZ = n => (Z.natures && Z.natures[n.n]) || n.n;
const natLabel = n => natZ(n) + (n.p ? " +"+NAT_AB[n.p]+" −"+NAT_AB[n.m] : " 無修正");
const recipeZh = n => (Z.recipes && Z.recipes[n]) || n.split('_').map(w=>w[0]+w.slice(1).toLowerCase()).join(' ');
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e4 ? Math.round(n/1e3)+'k' : Math.round(n).toLocaleString();
const f1 = n => (Math.round(n*10)/10).toFixed(1);


/* ================= STATE ================= */
const BLANK = () => ({sp: D.dex.findIndex(p=>p.n==='PIKACHU'), level:30, nature:'Bashful', ss:[null,null,null,null,null], ingSet:[0,0,0], skillLv:1, ribbon:0, pin:false, ex:false});
let roster = [];
let wk = {island:'greengrass', fav:new Set(), areaBonus:15, pot:57, sleepH:8.5, camp:0, mode:'total', dishType:'curry', recipeName:null, recipeLv:20, recipePick:'auto', recipeScope:'type', recipeLevels:{}, strictBerry:true};
let lastResults = null, shownAlt = 0;

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
  return {roster: roster.map(m=>({sp:D.dex[m.sp].n, level:m.level, nature:m.nature, ss:m.ss, ingSet:m.ingSet, skillLv:m.skillLv, ribbon:m.ribbon, pin:!!m.pin, ex:!!m.ex})),
          wk: {...wk, fav:[...wk.fav], recipe:undefined}, updatedAt: new Date().toISOString(), v:1};
}
/** 還原一份 serialize() 的輸出。
 *
 *  `opts.append`：只把 roster **接在現有的後面**，不動 wk。分批建箱子時要的是這個
 *  —— 一次貼一隻卻把整箱換掉，會把前面輸入的都吃掉。雲端同步與開機還原走的是
 *  預設的「整份取代」，不要改。 */
function deserialize(o, opts){
  if (!o) return;
  const revive = r => {
    const sp = D.dex.findIndex(p=>p.n===r.sp);
    return {...BLANK(), ...r, sp: sp<0?0:sp, ss:(r.ss||[null,null,null,null,null]).slice(0,5), ingSet:(r.ingSet||[0,0,0]).slice(0,3)};
  };
  if (Array.isArray(o.roster)){
    const incoming = o.roster.map(revive);
    roster = (opts && opts.append) ? roster.concat(incoming) : incoming;
  }
  if (o.wk && !(opts && opts.append)){
    const f = o.wk.fav||[];
    wk = {...wk, ...o.wk, fav:new Set(f), recipeLevels:o.wk.recipeLevels||{}};
  }
}
/** A human-readable mirror of the roster, so the Sheet is worth opening. */
function rosterTable(){
  const head = ['種類','圖鑑','等級','性格','副技能1','副技能2','副技能3','副技能4','副技能5','食材1','食材2','食材3','技能Lv','主技能','緞帶','固定','排除'];
  const rows = roster.map(m=>{
    const p = D.dex[m.sp], opts = [p.i0, p.i30, p.i60];
    const ings = [0,1,2].map(k=>{
      const list = opts[k] || [];
      const pick = list[Math.min(m.ingSet[k]||0, list.length-1)];
      return pick ? iz(ING_NAME[pick[0]]) + '×' + pick[1] : '';
    });
    return [pz(p), p.no, m.level, natZ(NAT[m.nature]||NAT.Bashful),
            ...[0,1,2,3,4].map(i=>m.ss[i] ? ssz(m.ss[i]) : ''),
            ...ings, m.skillLv, msz(p.ms), RIBBON_LABEL[m.ribbon||0], m.pin?'是':'', m.ex?'是':''];
  });
  return [head, ...rows];
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
  try { const raw = localStorage.getItem('psleep-box'); if (raw) deserialize(JSON.parse(raw)); } catch(e){}
  const selfHosted = !window.claude;
  if (selfHosted && $('syncSection')) $('syncSection').hidden = false;
  if ($('syncUrl')){ $('syncUrl').value = sync.url; $('syncToken').value = sync.token; }
  renderAll();

  const db = await (window.claude && window.claude.use ? window.claude.use('db') : Promise.resolve(null));
  if (db){
    dbObj = db;
    dbRef = db.doc('box/main');
    try {
      const snap = await dbRef.get();
      if (snap.exists) { deserialize(snap.data()); renderAll(); setStatus('已同步'); }
      else { await dbRef.set(serialize()); setStatus('已同步'); }
    } catch(e){ setStatus('只存在這台裝置'); }
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
        deserialize(remote); renderAll();
        setStatus('已同步 Sheet'); setSyncStatus('已下載雲端版本（' + (remote.updatedAt||'').slice(0,16).replace('T',' ') + '）');
      } else if (local){
        await sheetPut(local);
        setStatus('已同步 Sheet'); setSyncStatus('本機較新，已上傳');
      } else {
        setStatus('已同步 Sheet'); setSyncStatus('雲端為空');
      }
    } catch(e){
      setStatus('Sheet 連線失敗（用本機資料）'); setSyncStatus('連線失敗：' + e.message);
    }
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
  $('syncPull').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('連線中…');
    try {
      const remote = await sheetGet();
      if (remote){ deserialize(remote); renderAll(); setSyncStatus('已下載（' + (remote.roster||[]).length + ' 隻）'); setStatus('已同步 Sheet'); }
      else { setSyncStatus('連線成功，但雲端還是空的 —— 按「立即上傳」把本機資料推上去'); }
    } catch(e){ setSyncStatus('連線失敗：' + e.message); }
  });
  $('syncPush').addEventListener('click', async ()=>{
    readFields();
    if (!sync.on){ setSyncStatus('網址和金鑰都要填'); return; }
    setSyncStatus('上傳中…');
    try { await sheetPut(serialize()); setSyncStatus('已上傳 ' + roster.length + ' 隻'); setStatus('已同步 Sheet'); }
    catch(e){ setSyncStatus('上傳失敗：' + e.message); }
  });
  $('syncOff').addEventListener('click', ()=>{
    sync = {url:'', token:'', on:false};
    $('syncUrl').value = ''; $('syncToken').value = '';
    saveSyncConfig(); setSyncStatus('已停用，資料只留在這台瀏覽器'); setStatus('只存在這台裝置');
  });
}

/* ================= UI: weekly ================= */
function buildWeekly(){
  $('island').innerHTML = D.islands.map(i=>`<option value="${i.s}">${isl(i.n)}</option>`).join('');
  $('favBerries').innerHTML = BERRY_NAMES.map(b=>`<button type="button" class="chip" data-berry="${b}" aria-pressed="false" title="${b.toLowerCase()}">${bz(b)}</button>`).join('');
  $('favBerries').addEventListener('click', e=>{
    const b = e.target.closest('[data-berry]'); if (!b) return;
    const k = b.dataset.berry;
    if (wk.fav.has(k)) wk.fav.delete(k); else wk.fav.add(k);
    syncWeeklyUI(); save();
  });
  $('island').addEventListener('change', e=>{
    wk.island = e.target.value;
    const isl = D.islands.find(i=>i.s===wk.island);
    if (isl && isl.b.length){ wk.fav = new Set(isl.b); }
    syncWeeklyUI(); save();
  });
  $('dishType').addEventListener('change', e=>{ wk.dishType = e.target.value; wk.recipeName = null; fillRecipes(); save(); });
  $('recipe').addEventListener('change', e=>{ wk.recipeName = e.target.value; syncRecipeIngs(); save(); });
  for (const [id, key, num] of [['areaBonus','areaBonus',1],['pot','pot',1],['sleepH','sleepH',1],['recipeLv','recipeLv',1],['camp','camp',1]]){
    $(id).addEventListener('change', e=>{ wk[key] = num ? Number(e.target.value) : e.target.value; save(); });
  }
  $('mode').addEventListener('change', e=>{ wk.mode = e.target.value; save(); });
  $('recipePick').addEventListener('change', e=>{ wk.recipePick = e.target.value; syncWeeklyUI(); save(); });
  $('recipeScope').addEventListener('change', e=>{ wk.recipeScope = e.target.value; syncWeeklyUI(); save(); });
  $('strictBerry').addEventListener('change', e=>{ wk.strictBerry = e.target.checked; save(); });
  $('runBtn').addEventListener('click', run);
}
/* option 只放名稱與食材數。完整食材清單放在 select 下方的 #recipeIngs ——
   最長的食譜（絕對睡眠奶油咖哩）連食材清單要 555px，而這一欄就算 span2 也只有
   約 320px，塞進 option 會被裁掉，而被裁掉的資訊等於沒有。 */
function fillRecipes(){
  const list = D.recipes.filter(r=>r.t===wk.dishType).sort((a,b)=>a.cnt-b.cnt);
  $('recipe').innerHTML = list.map(r=>
    `<option value="${r.n}">${recipeZh(r.n)}（${r.cnt} 材）</option>`).join('');
  if (!wk.recipeName || !list.some(r=>r.n===wk.recipeName)){
    const pick = list.find(r=>r.cnt>=21) || list[list.length-1];
    wk.recipeName = pick && pick.n;
  }
  $('recipe').value = wk.recipeName;
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
  $('dishType').value = wk.dishType; $('recipeLv').value = wk.recipeLv;
  $('recipePick').value = wk.recipePick; $('recipeScope').value = wk.recipeScope;
  $('strictBerry').checked = wk.strictBerry !== false;
  const nSet = Object.keys(wk.recipeLevels||{}).length;
  $('rlvCount').textContent = nSet ? `（${nSet} 道已個別設定）` : '';
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
const SPECIES_OPTS = D.dex.map((p,i)=>`<option value="${i}">${pz(p)}　#${p.no} ${p.d} · ${SPEC_ZH[p.sp]} · ${bz(p.b)}</option>`).join('');
const NATURE_OPTS = D.natures.map(n=>`<option value="${n.n}">${natLabel(n)}</option>`).join('');
const SS_OPTS = `<option value="">—</option>` + D.subskills.map(s=>`<option value="${s.n}" title="${ssz(s.n)}">${sss(s.n)}</option>`).join('');
function ingSetOpts(m, slot){
  const p = D.dex[m.sp], list = [p.i0, p.i30, p.i60][slot] || [];
  if (!list.length) return `<option value="0">—</option>`;
  return list.map((x,i)=>`<option value="${i}">${iz(ING_NAME[x[0]])}×${x[1]}</option>`).join('');
}
function renderBox(){
  const host = $('boxList');
  $('boxEmpty').style.display = roster.length ? 'none' : 'block';
  host.innerHTML = roster.map((m,idx)=>{
    const p = D.dex[m.sp];
    const slots = Math.min(Math.floor(m.level/30)+1, 3);
    return `<div class="boxrow" data-i="${idx}">
      <div data-lbl="種類"><select data-k="sp">${SPECIES_OPTS}</select></div>
      <div data-lbl="等級"><input type="number" data-k="level" min="1" max="70" value="${m.level}"></div>
      <div data-lbl="性格"><select data-k="nature">${NATURE_OPTS}</select></div>
      <div data-lbl="副技能"><div class="ss-mini">${[0,1,2,3,4].map(s=>
        `<select data-k="ss" data-s="${s}" title="第 ${s+1} 格 — Lv${SS_SLOT_LV[s]} 解鎖${m.ss[s]?'：'+ssz(m.ss[s]):''}"${m.level<SS_SLOT_LV[s]?' style="opacity:.45"':''}>${SS_OPTS}</select>`).join('')}</div></div>
      <div data-lbl="食材組合"><div class="ss-mini" style="grid-template-columns:repeat(3,1fr)">${[0,1,2].map(s=>
        `<select data-k="ingSet" data-s="${s}"${s>=slots?' disabled style="opacity:.35"':''}>${ingSetOpts(m,s)}</select>`).join('')}</div></div>
      <div data-lbl="技能Lv"><input type="number" data-k="skillLv" min="1" max="8" value="${m.skillLv}"></div>
      <div data-lbl="緞帶"><select data-k="ribbon" title="睡眠緞帶：縮短未進化寶可夢的幫手間隔並提升攜帶上限">${
        RIBBON_LABEL.map((t,i)=>`<option value="${i}">${t}</option>`).join('')}</select></div>
      <div data-lbl="" style="display:flex;gap:5px;justify-content:flex-end">
        <button class="btn sm ghost" data-act="pin" title="固定在隊上">${m.pin?'📌':'📍'}</button>
        <button class="btn sm ghost" data-act="ex" title="排除">${m.ex?'🚫':'○'}</button>
        <button class="btn sm ghost" data-act="del" title="刪除">✕</button>
      </div>
    </div>`;
  }).join('');
  roster.forEach((m,idx)=>{
    const row = host.querySelector(`[data-i="${idx}"]`);
    row.querySelector('[data-k="sp"]').value = m.sp;
    row.querySelector('[data-k="nature"]').value = m.nature;
    row.querySelectorAll('[data-k="ss"]').forEach(s=>{ s.value = m.ss[+s.dataset.s] || ''; });
    row.querySelectorAll('[data-k="ingSet"]').forEach(s=>{ s.value = String(m.ingSet[+s.dataset.s]||0); });
    row.querySelector('[data-k="ribbon"]').value = String(m.ribbon||0);
    row.style.opacity = m.ex ? .5 : 1;
  });
}
$('boxList').addEventListener('change', e=>{
  const row = e.target.closest('[data-i]'); if (!row) return;
  const m = roster[+row.dataset.i], k = e.target.dataset.k;
  if (!k) return;
  if (k==='sp'){ m.sp = +e.target.value; m.ingSet = [0,0,0]; m.skillLv = 1; renderBox(); }
  else if (k==='ss') m.ss[+e.target.dataset.s] = e.target.value || null;
  else if (k==='ingSet') m.ingSet[+e.target.dataset.s] = +e.target.value;
  else if (k==='level'){ m.level = Math.max(1, Math.min(70, +e.target.value||1)); renderBox(); }
  else if (k==='skillLv') m.skillLv = Math.max(1, Math.min(8, +e.target.value||1));
  else if (k==='nature') m.nature = e.target.value;
  else if (k==='ribbon') m.ribbon = +e.target.value;
  save();
});
$('boxList').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const i = +btn.closest('[data-i]').dataset.i, a = btn.dataset.act;
  if (a==='del') roster.splice(i,1);
  else if (a==='pin'){ roster[i].pin = !roster[i].pin; if (roster[i].pin) roster[i].ex = false; }
  else if (a==='ex'){ roster[i].ex = !roster[i].ex; if (roster[i].ex) roster[i].pin = false; }
  renderBox(); save();
});
$('addBtn').addEventListener('click', ()=>{ roster.push(BLANK()); renderBox(); save();
  const rows = $('boxList').querySelectorAll('[data-i]'); rows[rows.length-1].scrollIntoView({block:'nearest'}); });
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
    deserialize(o, {append});
    renderAll(); save();
    setStatus(append ? `已追加 ${n} 隻（共 ${roster.length} 隻）` : `已匯入 ${roster.length} 隻`);
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
  const slots = Math.min(Math.floor(m.level/30)+1, 3);
  const ambIng = s => (impAmbIng[s] && impAmbIng[s].length > 1) ? ' class="amb"' : '';
  $('impRow').innerHTML = `<div class="boxrow">
    <div data-lbl="種類"><select data-k="sp"${impAmbSp?' class="amb"':''}>${SPECIES_OPTS}</select></div>
    <div data-lbl="等級"><input type="number" data-k="level" min="1" max="70" value="${m.level}"></div>
    <div data-lbl="性格"><select data-k="nature">${NATURE_OPTS}</select></div>
    <div data-lbl="副技能"><div class="ss-mini">${[0,1,2,3,4].map(s=>
      `<select data-k="ss" data-s="${s}" title="第 ${s+1} 格 — Lv${SS_SLOT_LV[s]} 解鎖${m.ss[s]?'：'+ssz(m.ss[s]):''}"${m.level<SS_SLOT_LV[s]?' style="opacity:.45"':''}>${SS_OPTS}</select>`).join('')}</div></div>
    <div data-lbl="食材組合"><div class="ss-mini" style="grid-template-columns:repeat(3,1fr)">${[0,1,2].map(s=>
      s>=slots
        ? `<select data-k="ingSet" data-s="${s}" disabled style="opacity:.35">${ingSetOpts(m,s)}</select>`
        : `<select data-k="ingSet" data-s="${s}"${ambIng(s)}>${ingSetOpts(m,s)}</select>`).join('')}</div></div>
    <div data-lbl="技能Lv"><input type="number" data-k="skillLv" min="1" max="8" value="${m.skillLv}"></div>
    <div data-lbl="緞帶"><select data-k="ribbon"${impAmbRb?' class="amb"':''} title="截圖上看不到，由持有上限反解">${
      RIBBON_LABEL.map((t,i)=>`<option value="${i}">${t}</option>`).join('')}</select></div>
    <div></div>
  </div>`;
  const row = $('impRow').querySelector('.boxrow');
  row.querySelector('[data-k="sp"]').value = m.sp;
  row.querySelector('[data-k="nature"]').value = m.nature;
  row.querySelectorAll('[data-k="ss"]').forEach(s=>{ s.value = m.ss[+s.dataset.s] || ''; });
  row.querySelectorAll('[data-k="ingSet"]').forEach(s=>{ s.value = String(m.ingSet[+s.dataset.s]||0); });
  row.querySelector('[data-k="ribbon"]').value = String(m.ribbon||0);
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
  $('comboCount').textContent = `${res.count.toLocaleString()} 種組合 · ${Math.round(performance.now()-t0)}ms`
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
function memberCard(rank, i, r, o){
  const m = roster[i], p = D.dex[m.sp], bs = m._bs;
  const act = bs.act.map(a=>sss(a));
  const ingList = [];
  for (let k=0;k<NING;k++) if (o.ing[k]*7 > 12) ingList.push(iz(ING_NAME[k])+' '+f1(o.ing[k]*7));
  return `<div class="mem">
    <div class="rank">${rank}</div>
    <div>
      <div class="nm">${pz(p)}<span class="tag ${p.sp}">${SPEC_ZH[p.sp]}</span>${wk.fav.has(p.b)?`<span class="tag fav">加成樹果</span>`:''}${m.pin?`<span class="tag pin">固定</span>`:''}</div>
      <div class="meta">Lv${m.level} · ${natZ(NAT[m.nature]||NAT.Bashful)} · ${act.length?act.join('／'):'無副技能'} · 頻率 ${Math.round(o.sim.freqBase/60*10)/10}分</div>\n      <div class="meta">${msz(p.ms)} Lv${bs.skillLv} · 每日發動 ${f1(o.sim.procs)} 次</div>
      <div class="meta" style="color:var(--ing)">${ingList.length?ingList.join('　'):'（無食材產出）'}</div>
    </div>
    <div class="out">
      <div><span class="muted">週能量</span> ${fmt((o.berryStrength+o.skillStrength)*7*(1+wk.areaBonus/100))}</div>
      <div class="muted">幫手 ${f1(o.sim.productive)}／日${o.sim.snack>0.5?` · 偷吃 ${f1(o.sim.snack)}`:''}</div>
      <div class="muted" style="color:${o.sim.fastShare>=0.6?'var(--pos)':o.sim.fastShare>=0.3?'var(--ing)':'var(--neg)'}">最快檔位 ${f1(o.sim.fastHours)}h／日（${Math.round(o.sim.fastShare*100)}%）</div>
    </div>
  </div>`;
}
function renderResults(){
  if (!lastResults || !lastResults.length){
    $('results').innerHTML = roster.filter(m=>!m.ex).length < 5
      ? `<div class="notice">先到右上角「寶可夢箱」分頁建立至少 5 隻，才能開始推演。</div>`
      : `<div class="notice">設定好本週條件後，按「推演最佳隊伍」。</div>`;
    return;
  }
  const r = lastResults[shownAlt];
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
  const bn = r.bottleneck!=null ? iz(ING_NAME[r.bottleneck]) : '—';

  $('results').innerHTML = `
  ${warn}
  <div class="panel hero" style="margin-top:${warn?'12px':'0'}">
    <div class="roster">
      <div class="eyebrow">建議先發 5 隻</div>
      ${r.idxs.map((i,n)=>memberCard(n+1, i, r, r.outs[n])).join('')}
      <div class="pillrow" style="margin-top:4px">
        <span class="pill">HB ×${r.ctx.nHB}</span>
        <span class="pill">ERB ×${r.ctx.nERB}</span>
        <span class="pill">技能補能量 ${Math.round(r.ctx.supportEnergy)}/日</span>
        ${r.ctx.extraHelps>0.2?`<span class="pill">額外幫手 ${f1(r.ctx.extraHelps)}/日</span>`:''}
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
      <div class="phead"><h3>這隊最能煮的食譜</h3><span class="muted" style="font-size:12px">以目前產量排序</span></div>
      <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
      <table><thead><tr><th>食譜</th><th style="text-align:right">煮/週</th><th style="text-align:right">週能量</th><th></th></tr></thead>
      <tbody>${rankRecipesForTeam(r, wk).slice(0,7).map(x=>`<tr${x.rec.n===wk.recipe.n?' style="background:color-mix(in srgb,var(--accent) 12%,transparent)"':''}>
        <td>${recipeZh(x.rec.n)} <span class="muted num">共${x.rec.cnt}</span>${x.fits?'':' <span class="tag pin">鍋子不足</span>'}</td>
        <td class="n" style="text-align:right">${x.capped}</td>
        <td class="n" style="text-align:right">${fmt(x.strength)}</td>
        <td><button class="btn sm ghost" data-setrecipe="${x.rec.n}">設為目標</button></td></tr>`).join('')}
      </tbody></table></div></div>
    </div>
  </div>

  ${r.mp ? `<div class="panel" style="margin-top:16px">
    <div class="phead"><h3>本週 21 餐排程</h3><span class="muted" style="font-size:12px">同一個食材池貪婪填滿 · 依單道能量由高到低</span></div>
    <div class="pbody" style="padding:0"><div class="scroll" style="border:0">
    <table><thead><tr><th>餐次</th><th>食譜</th><th style="text-align:right">次數</th><th style="text-align:right">單道</th><th style="text-align:right">小計</th></tr></thead>
    <tbody>${r.mp.plan.map((x,n)=>`<tr>
      <td class="n">${n+1}</td>
      <td>${recipeZh(x.r.n)} <span class="muted num">共${x.r.cnt}</span>${(x.primary || x.r.n===TR.n)?' <span class="tag pin">主食譜</span>':''}</td>
      <td class="n" style="text-align:right">${x.n}</td>
      <td class="n" style="text-align:right">${fmt(x.each)}</td>
      <td class="n" style="text-align:right">${fmt(x.n*x.each*r.mul)}</td></tr>`).join('')}
      ${r.mp.idleMeals>0?`<tr><td></td><td class="muted">食材不足，${r.mp.idleMeals} 餐無法排入（實際遊戲會退成拌拌料理）</td><td class="n" style="text-align:right">${r.mp.idleMeals}</td><td></td><td class="n" style="text-align:right">—</td></tr>`:''}
    </tbody></table></div></div>
  </div>` : ''}

  <div class="grid" style="grid-template-columns:1fr;margin-top:16px;gap:16px">
    <div class="panel">
      <div class="phead"><h3>替代隊伍</h3><span class="muted" style="font-size:12px">點一列切換</span></div>
      <div class="pbody" style="padding:0">
        <div class="scroll" style="border:0;border-radius:0 0 12px 12px">
        <table><thead><tr><th>#</th><th>組合</th><th style="text-align:right">週能量</th><th style="text-align:right">煮</th></tr></thead>
        <tbody>${lastResults.map((x,n)=>`<tr class="alt${n===shownAlt?' on':''}" data-alt="${n}">
          <td class="n">${n+1}</td>
          <td>${x.idxs.map(i=>pz(D.dex[roster[i].sp])).join('・')}</td>
          <td class="n" style="text-align:right">${fmt(x.total)}</td>
          <td class="n" style="text-align:right">${x.cooksCapped}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>
  </div>`;
  $('results').querySelectorAll('.alt').forEach(tr=>tr.addEventListener('click', ()=>{ shownAlt = +tr.dataset.alt; renderResults(); }));
  $('results').querySelectorAll('[data-setrecipe]').forEach(b=>b.addEventListener('click', ()=>{
    wk.recipeName = b.dataset.setrecipe; $('recipe').value = wk.recipeName; syncRecipeIngs(); save(); run();
  }));
}

/* ================= VIEWS ================= */
function showView(name){
  for (const v of ['plan','box','recipes']) $('view-'+v).hidden = (v !== name);
  for (const b of $('viewNav').querySelectorAll('[data-view]'))
    b.setAttribute('aria-pressed', b.dataset.view === name ? 'true' : 'false');
  if (name === 'recipes') renderRecipeLevels();
  window.scrollTo({top:0, behavior:'instant'});
}
$('viewNav').addEventListener('click', e=>{
  const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view);
});

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
  }).map(r=>({r, lv: rlvl(r, wk), set: typeof (wk.recipeLevels||{})[r.n] === 'number',
              val: recipeValue(r, rlvl(r, wk))}));
  const cmp = {value:(a,b)=>b.val-a.val, lv:(a,b)=>b.lv-a.lv, cnt:(a,b)=>a.r.cnt-b.r.cnt,
               name:(a,b)=>recipeZh(a.r.n).localeCompare(recipeZh(b.r.n),'zh-Hant')}[sort];
  list.sort(cmp);
  const TYPE_ZH = {curry:'咖哩／濃湯', salad:'沙拉', dessert:'甜點／飲品'};
  $('rlvBody').innerHTML = list.map(x=>{
    const mul = D.rlb[x.lv] || 1;
    return `<tr data-r="${x.r.n}">
      <td><b>${recipeZh(x.r.n)}</b><div class="muted" style="font-size:11.5px">${x.r.ings.map(([i,a])=>iz(ING_NAME[i])+'×'+a).join('・')}</div></td>
      <td class="muted" style="font-size:12px">${TYPE_ZH[x.r.t]}</td>
      <td class="n" style="text-align:right">${x.r.cnt}</td>
      <td style="text-align:center"><input type="number" min="1" max="70" step="1" data-rlv="${x.r.n}" value="${x.set ? x.lv : ''}" placeholder="${wk.recipeLv}"></td>
      <td class="n" style="text-align:right;color:${mul>=2?'var(--pos)':mul>=1.4?'var(--ing)':'var(--muted)'}">×${mul.toFixed(2)}</td>
      <td class="n" style="text-align:right">${fmt(x.val)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="muted" style="padding:22px;text-align:center">沒有符合的食譜</td></tr>`;
  const n = Object.keys(wk.recipeLevels||{}).length;
  $('rlvCount').textContent = n ? `（${n} 道已個別設定）` : '';
}
$('rlvBody').addEventListener('change', e=>{
  const k = e.target.dataset.rlv; if (!k) return;
  wk.recipeLevels = wk.recipeLevels || {};
  const v = e.target.value.trim();
  if (v === '') delete wk.recipeLevels[k];
  else wk.recipeLevels[k] = Math.max(1, Math.min(70, Math.round(Number(v)) || 1));
  save(); renderRecipeLevels();
});
for (const id of ['rlvType','rlvSearch','rlvSort']) $(id).addEventListener('input', renderRecipeLevels);
$('rlvClear').addEventListener('click', ()=>{
  if (!Object.keys(wk.recipeLevels||{}).length) return;
  if (!window.confirm('清除所有個別設定的食譜等級？全部會改回套用預設等級。')) return;
  wk.recipeLevels = {}; save(); renderRecipeLevels();
});

/* ================= DATA VERSION ================= */
let metaStatus = null, metaReq = null;
function renderVersion(){
  const m = D.meta || {};
  const selfHosted = !window.claude;
  $('verSrc').innerHTML = `${m.src||'—'}<br>commit ${m.commit||'—'} · ${m.commitDate||'—'}<br>打包於 ${m.builtAt||'—'}`;
  $('verZh').textContent = m.zhSrc || '—';
  $('verBuild').textContent = selfHosted
    ? '自架版本（GitHub Pages 等）· 寶可夢箱存在你的 Google Sheet 或本機瀏覽器'
    : 'claude.ai artifact 版本 · 寶可夢箱存在 artifact 資料庫';
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
function renderAll(){ syncWeeklyUI(); renderBox(); renderResults(); renderVersion(); if (!$('view-recipes').hidden) renderRecipeLevels(); }
buildWeekly();
buildImport();
if (!wk.fav.size) wk.fav = new Set(['ORAN','PAMTRE','PECHA']);
boot().then(()=>{ if (roster.length>=5) run(); });
