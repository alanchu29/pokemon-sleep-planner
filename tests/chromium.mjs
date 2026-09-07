/**
 * 找一個能用的 Chromium。
 *
 * 為什麼需要這個：原本測試寫死 `/opt/pw-browsers/chromium`（容器內的路徑），
 * 在別的機器上必須每次都加 `CHROMIUM=...` 前綴。那個前綴很煩，而且會讓
 * `.claude/settings.json` 的 `Bash(npm test)` 允許規則匹配不到（權限比對看的是
 * 整條指令字串，有 env 前綴就不是 `npm test` 了）。
 *
 * 順序：CHROMIUM 環境變數 → playwright-core 自己下載的 → 系統裝的 Chrome/Edge → 容器路徑。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CANDIDATES = [
  // playwright-core 用 `npx playwright-core install chromium` 下載的那份
  () => {
    try { return require('playwright-core').chromium.executablePath(); } catch { return null; }
  },
  // Windows
  () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  () => 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  () => 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  () => 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  () => '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux / 容器
  () => '/opt/pw-browsers/chromium',
  () => '/usr/bin/chromium',
  () => '/usr/bin/chromium-browser',
  () => '/usr/bin/google-chrome',
];

export function resolveChromium() {
  if (process.env.CHROMIUM) {
    if (!existsSync(process.env.CHROMIUM))
      throw new Error(`CHROMIUM 指到的檔案不存在：${process.env.CHROMIUM}`);
    return process.env.CHROMIUM;
  }
  for (const get of CANDIDATES) {
    let p; try { p = get(); } catch { continue; }
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chromium。裝一個或指定路徑：\n' +
    '  npx playwright-core install chromium\n' +
    '  CHROMIUM="/path/to/chrome" npm test'
  );
}
