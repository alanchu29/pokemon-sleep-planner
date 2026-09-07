"use strict";
/* 推演用的 Worker。薄薄一層 —— 真正的計算全在 engine.js，主執行緒也載入同一份，
   所以不會有「兩份引擎走鐘」的問題。

   協定：
     主 → worker  { type:'init', data }        先塞資料再 importScripts
     主 → worker  { type:'run', roster, wk }
     worker → 主  { type:'ready' }
     worker → 主  { type:'progress', done, total }
     worker → 主  { type:'done', result }      result 是 searchTeams() 的回傳
     worker → 主  { type:'error', message }

   **取消是靠主執行緒 terminate()，不是傳訊息。** 搜尋是同步迴圈，跑的時候
   worker 根本不會去處理訊息佇列，所以送 'cancel' 進來永遠等到搜尋結束才被讀到。
   SharedArrayBuffer + Atomics 可以做到真正的中斷，但那需要 COOP/COEP 標頭，
   GitHub Pages 給不了。所以 app.js 直接砍掉 worker 再開一個新的。 */

let ready = false;

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      self.GAMEDATA = msg.data;
      importScripts('./engine.js');   // 相對於這個 worker 檔的 URL
      ready = true;
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'run') {
      if (!ready) { self.postMessage({ type: 'error', message: 'worker 尚未 init' }); return; }
      let last = 0;
      const result = searchTeams(msg.roster, msg.wk, {
        onProgress: (done, total) => {
          // 節流：每 80ms 最多一次，不然 postMessage 本身會變成瓶頸
          const now = Date.now();
          if (now - last < 80 && done < total) return;
          last = now;
          self.postMessage({ type: 'progress', done, total });
        },
      });
      self.postMessage({ type: 'done', result });
      return;
    }
    self.postMessage({ type: 'error', message: '未知的訊息型別：' + msg.type });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
