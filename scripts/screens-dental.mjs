// Viewer screenshots for the dental write-up. Needs `npm run dev` and the samples in
// data/external (toothfairy/raw/P221, sts3d-tooth/raw/ROI_L_001).
// Usage: node scripts/screens-dental.mjs <out_dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5190';
const out = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../docs/screens/dental'));
fs.mkdirSync(out, { recursive: true });
const pwDir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const guess = fs.existsSync(pwDir)
  ? fs
      .readdirSync(pwDir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => path.join(pwDir, d, 'chrome-win64/chrome.exe'))
      .find((p) => fs.existsSync(p))
  : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? guess,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function open(q, waitFor = '[data-view="axial"] canvas') {
  await page.goto(`${BASE}/${q}`);
  await page.waitForSelector(waitFor, { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid=status]')?.textContent?.includes('불러오는 중'), null, { timeout: 180000 });
  await page.waitForTimeout(2500);
}

// 1. dental mode on the real NewTom export
await open('?sample=ext:toothfairy/P221&dental=1', '[data-view="panorama"] canvas');
await page.screenshot({ path: path.join(out, '01-dental-mode.png') });
console.log('saved 01-dental-mode.png');

// 2. stacking by InstanceNumber vs by position (same files)
for (const [name, q] of [
  ['naive', '?sample=ext:sts3d-tooth/ROI_L_001&order=naive'],
  ['position', '?sample=ext:sts3d-tooth/ROI_L_001'],
]) {
  await open(q);
  await page.locator('[data-view="sagittal"]').screenshot({ path: path.join(out, `raw-sagittal-${name}.png`) });
  console.log('saved', `raw-sagittal-${name}.png`);
}
await browser.close();
