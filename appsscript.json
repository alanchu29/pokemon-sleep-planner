/**
 * 卡比獸週隊推演台 — Google Sheet 後端
 *
 * 部署方式見 repo 根目錄的 SETUP-google-sheet.md。
 *
 * 資料模型：
 *   _raw    工作表：A1 起逐格存放寶可夢箱的 JSON（超長會自動分片），這是唯一的真實來源
 *   roster  工作表：由前端送來的可讀表格，方便你直接開 Sheet 檢視／核對
 *
 * roster 工作表是「唯讀鏡像」—— 你在上面手改不會回寫，改資料請在網頁上改。
 */

// ⚠️ 換成你自己的隨機字串，並且和網頁「存取金鑰」欄位填一樣的值。
const TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

const RAW_SHEET = '_raw';
const VIEW_SHEET = 'roster';
const CHUNK = 40000;               // 單格上限 50,000 字，留餘裕

function doGet(e) {
  try {
    if (!authorized(e && e.parameter)) return json({ error: 'unauthorized' });
    return json({ ok: true, data: readRaw() });
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return json({ error: 'malformed json body' });
    }
    if (!authorized(body)) return json({ error: 'unauthorized' });
    if (!body.data || typeof body.data !== 'object') return json({ error: 'missing data' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      writeRaw(body.data);
      if (Array.isArray(body.table)) writeView(body.table);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

/* ---------------- helpers ---------------- */

function authorized(src) {
  return !!src && typeof src.token === 'string' && src.token === TOKEN;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function book() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet(name) {
  var ss = book();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readRaw() {
  var sh = book().getSheetByName(RAW_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 1) return null;
  var cells = sh.getRange(1, 1, last, 1).getValues();
  var text = cells.map(function (r) { return r[0] == null ? '' : String(r[0]); }).join('');
  if (!text) return null;
  try { return JSON.parse(text); } catch (err) { return null; }
}

function writeRaw(data) {
  var sh = sheet(RAW_SHEET);
  var text = JSON.stringify(data);
  var parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push([text.substr(i, CHUNK)]);
  if (!parts.length) parts = [['']];
  sh.clear();
  sh.getRange(1, 1, parts.length, 1).setValues(parts);
}

function writeView(table) {
  var sh = sheet(VIEW_SHEET);
  sh.clear();
  if (!table.length) return;
  var width = table.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  var padded = table.map(function (r) {
    var row = r.slice();
    while (row.length < width) row.push('');
    return row.map(function (v) { return v == null ? '' : v; });
  });
  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, width); } catch (err) {}
}

/* 在編輯器裡手動跑一次，確認腳本能存取這份 Sheet（會建立兩個工作表） */
function selfTest() {
  writeRaw({ roster: [], wk: {}, updatedAt: new Date().toISOString(), v: 1 });
  writeView([['種類', '等級'], ['（測試）', 1]]);
  Logger.log('OK — 已寫入 ' + RAW_SHEET + ' 與 ' + VIEW_SHEET);
}
