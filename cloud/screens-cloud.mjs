// Screenshots for docs/CLOUD-LOG.md: a cloud study with the desktop's points, and the same
// study on a browser without WebGL2. Needs dev server, S3, API, P221 uploaded and
// scripts/desktop_points.py run once.  Usage: node cloud/screens-cloud.mjs <out_dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const out = path.resolve(process.argv[2] ?? 'docs/screens/cloud');
fs.mkdirSync(out, { recursive: true });
const pwDir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const exe = fs
  .readdirSync(pwDir)
  .filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => path.join(pwDir, d, 'chrome-win64/chrome.exe'))
  .find((p) => fs.existsSync(p));

for (const [name, extra] of [
  ['01-cloud-desktop-points.png', []],
  ['02-no-webgl2.png', []], // WebGL2 refused, like an old office PC or a remote-desktop session
]) {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extra] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // --disable-es3-apis did not remove WebGL2 under SwiftShader, so refuse the context in JS
  if (name.startsWith('02')) {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return type === 'webgl2' ? null : orig.call(this, type, ...rest);
      };
    });
  }
  await page.goto('http://localhost:5190');
  await page.waitForSelector('[data-view="axial"] canvas', { timeout: 60000 });
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('button', { name: /^P221 ·/ }).click();
  const lowSpec = await page.getByLabel('저사양 모드 (저해상도만 받기)').isChecked();
  await page.locator('[data-testid=cloud-log]').nth(lowSpec ? 0 : 1).waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, name) });
  console.log('saved', name, '| low-spec auto:', lowSpec, '|', await page.locator('aside .note.mono').first().textContent());
  await browser.close();
}
