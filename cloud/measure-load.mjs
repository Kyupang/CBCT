// Time to first image, on throttled network / CPU (Chrome DevTools Protocol emulation).
// Needs: npm run dev, npm run s3, npm run api, and P221 uploaded (npm run upload).
// Usage: node cloud/measure-load.mjs <out_dir>
//
// A  "DICOM as-is": the browser downloads all 330 files (87 MB) and parses them itself
// B  cloud, progressive: 1/8-size level first, then full resolution
// C  cloud, low-spec mode: the 1/8-size level only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5190';
const out = path.resolve(process.argv[2] ?? '.data/measure');
fs.mkdirSync(out, { recursive: true });
const pwDir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const exe = fs
  .readdirSync(pwDir)
  .filter((d) => /^chromium-\d+$/.test(d))
  .map((d) => path.join(pwDir, d, 'chrome-win64/chrome.exe'))
  .find((p) => fs.existsSync(p));

const PROFILES = [
  { name: '100 Mbps', down: 100e6 / 8, latency: 10, cpu: 1 },
  { name: '10 Mbps', down: 10e6 / 8, latency: 40, cpu: 1 },
  { name: '10 Mbps + CPU 1/4', down: 10e6 / 8, latency: 40, cpu: 4 },
];

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function session(profile) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE);
  await page.waitForSelector('[data-view="axial"] canvas', { timeout: 60000 }); // phantom loaded = app ready
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.down });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  return page;
}
const notBusy = (page) => page.waitForFunction(() => !document.querySelector('[data-testid=status]')?.textContent?.includes('불러오는 중'), null, { timeout: 600000 });

async function login(page) {
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByRole('button', { name: /^P221 ·/ }).waitFor({ timeout: 30000 });
}

const results = [];
for (const profile of PROFILES) {
  // A: raw DICOM through the browser
  {
    const page = await session(profile);
    const t0 = Date.now();
    await page.getByRole('button', { name: '실데이터 · toothfairy/P221' }).click();
    await page.waitForTimeout(200);
    await notBusy(page);
    const first = Date.now() - t0;
    results.push({ profile: profile.name, case: 'A DICOM 330개 그대로', firstMs: first, fullMs: first });
    console.log(results.at(-1));
    await page.close();
  }
  // B / C: cloud
  for (const lowSpec of [false, true]) {
    const page = await session(profile);
    await login(page);
    const box = page.getByLabel('저사양 모드 (저해상도만 받기)');
    if ((await box.isChecked()) !== lowSpec) await box.click();
    const t0 = Date.now();
    await page.getByRole('button', { name: /^P221 ·/ }).click();
    await page.locator('[data-testid=cloud-log]').first().waitFor({ timeout: 600000 });
    const first = Date.now() - t0;
    let full = first;
    if (!lowSpec) {
      await page.locator('[data-testid=cloud-log]').nth(1).waitFor({ timeout: 600000 });
      full = Date.now() - t0;
    }
    results.push({ profile: profile.name, case: lowSpec ? 'C 클라우드 · 저사양 모드' : 'B 클라우드 · 단계적', firstMs: first, fullMs: lowSpec ? null : full });
    console.log(results.at(-1));
    if (profile.name === '10 Mbps' && !lowSpec) await page.screenshot({ path: path.join(out, 'cloud-10mbps-full.png') });
    await page.close();
  }
}
fs.writeFileSync(path.join(out, 'load-times.json'), JSON.stringify(results, null, 2));
await browser.close();
