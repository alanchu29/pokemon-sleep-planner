"use strict";
/* 推演用的 Worker。薄薄一層 —— 真正的計算全在 engine.js，主執行緒也載入同一份，
   所以不會有「兩份引擎走鐘」的問題。

   協定：
     主 → worker  { type:'init', data, v }                  先塞資料再 importScripts
     主 → worker  { type:'shard', roster, wk, shard, finalists }
     （回傳的候選是精簡的 {idxs, score}；主執行緒用 engine.js 的 rehydrate() 還原）
     worker → 主  { type:'ready', v }                       v = 這個 worker 實際載到的 ENGINE_V
     worker → 主  { type:'progress', done, total }          done 是「這個分片」的進度
     worker → 主  { type:'shard', cands, count, excluded, total, ms }
     worker → 主  { type:'error', message }

   **worker 只做列舉與評分，不跑決賽。** 決賽（bestPlan，21 餐排程）由主執行緒
   在合併所有分片之後跑一次 —— 每個 worker 各跑一遍是白費工，而且會拿到不同的
   候選集合。見 engine.js 的 finalizeTeams。

   **取消是靠主執行緒 terminate()，不是傳訊息。** 搜尋是同步迴圈，跑的時候
   worker 根本不會去處理訊息佇列，所以送 'cancel' 進來永遠等到搜尋結束才被讀到。
   SharedArrayBuffer + Atomics 可以做到真正的中斷，但那需要 COOP/COEP 標頭，
   GitHub Pages 給不了。所以 app.js 直接砍掉 worker 再開新的。 */

let ready = false;

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      self.GAMEDATA = msg.data;
      /* `?v=` 一定要跟著帶進來 —— Worker 與 importScripts 走的是**另一條**快取路徑，
         主執行緒的 `<script src="./src/engine.js?v=…">` 擋不到它。少了這一段，
         部署之後有一段窗口 worker 會用舊引擎列舉評分、主執行緒用新引擎 rehydrate
         與跑決賽，兩套公式算出來的分數對不起來，而且**不會有任何錯誤訊息**。
         回報 ENGINE_V 讓主執行緒可以真的斷言（`?v=` 只降低機率，斷言才擋得住）。 */
      importScripts('./engine.js' + (msg.v ? '?v=' + encodeURIComponent(msg.v) : ''));
      ready = true;
      self.postMessage({ type: 'ready', v: (typeof ENGINE_V === 'string' ? ENGINE_V : null) });
      return;
    }
    if (msg.type === 'shard') {
      if (!ready) { self.postMessage({ type: 'error', message: 'worker 尚未 init' }); return; }
      let last = 0;
      const t0 = Date.now();
      const r = searchShard(msg.roster, msg.wk, {
        shard: msg.shard,
        finalists: msg.finalists,
        lean: true,   // 只回傳 idxs/score —— 完整物件太大，主執行緒會用 rehydrate() 還原
        onProgress: (done, total) => {
          // 節流：每 80ms 最多一次，不然 postMessage 本身會變成瓶頸
          const now = Date.now();
          if (now - last < 80) return;
          last = now;
          self.postMessage({ type: 'progress', done, total });
        },
      });
      if (r.error) { self.postMessage({ type: 'shard', error: r.error, n: r.n, cut: r.cut }); return; }
      self.postMessage({ type: 'shard', cands: r.cands, count: r.count,
                         excluded: r.excluded, total: r.total, ms: Date.now() - t0 });
      return;
    }
    self.postMessage({ type: 'error', message: '未知的訊息型別：' + msg.type });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
