// Headless screenshots of the running dev server (npm run dev, port 5190).
// Usage: node scripts/screens.mjs   (CHROME=<path to chrome.exe> to override the browser)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5190';
const out = path.resolve(import.meta.dirname, '../docs/screens');
fs.mkdirSync(out, { recursive: true });

const pwDir = path.join(os.homedir(), 'AppData/Local/ms-playwright');
const guess = fs.existsSync(pwDir)
  ? fs
      .readdirSync(pwDir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => path.join(pwDir, d, 'chrome-win64/chrome.exe'))
      .find((p) => fs.existsSync(p))
  : undefined;
const executablePath = process.env.CHROME ?? guess;

const browser = await chromium.launch({
  executablePath,
  headless: true,
  // headless has no GPU: ANGLE + SwiftShader gives a software WebGL2 context
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

async function ready() {
  await page.waitForSelector('[data-view="axial"] canvas', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid=status]')?.textContent?.includes('불러오는 중'), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}
async function shot(name) {
  await page.screenshot({ path: path.join(out, name) });
  console.log('saved', name);
}
async function viewBox(kind) {
  return page.locator(`[data-view="${kind}"]`).boundingBox();
}
async function hover(kind, fx, fy) {
  const b = await viewBox(kind);
  await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
  await page.waitForTimeout(200);
}

// 1. axial phantom, MIP, hover readout
await page.goto(`${BASE}/?sample=axial`);
await ready();
await page.locator('[data-view="axial"] canvas').click({ position: { x: 300, y: 170 } });
await hover('coronal', 0.62, 0.42);
await shot('01-phantom-mip.png');
console.log('status:', await page.locator('[data-testid=status]').textContent());

// 2. ISO surface + bone window + measurement on axial
await page.getByRole('button', { name: '뼈 (Bone)' }).click();
await page.getByRole('button', { name: 'ISO 표면' }).click();
await page.getByRole('button', { name: '거리 측정' }).click();
{
  const b = await viewBox('axial');
  await page.mouse.click(b.x + b.width * 0.35, b.y + b.height * 0.5);
  await page.mouse.click(b.x + b.width * 0.65, b.y + b.height * 0.5);
}
await hover('sagittal', 0.5, 0.5);
await page.waitForTimeout(800);
await shot('02-phantom-iso-measure.png');


// 3. oblique + missing slice + 12-bit unsigned with dirty high bits
await page.goto(`${BASE}/?sample=oblique`);
await ready();
await hover('axial', 0.55, 0.45);
await shot('03-phantom-oblique-gap.png');

// 4. real data (dev server only; needs npm run fetch-samples)
const idx = await (await fetch(`${BASE}/external/index.json`)).json().catch(() => ({}));
if (idx['daikon-brain']) {
  await page.goto(`${BASE}/?sample=ext:daikon-brain`);
  await ready();
  await hover('axial', 0.5, 0.45);
  await shot('04-real-mr-oblique.png');
  await page.getByRole('button', { name: 'ISO 표면' }).click();
  await page.waitForTimeout(800);
  await shot('05-real-mr-iso.png');

  // ray step artifacts: MIP at 0.25 samples/voxel without / with jitter vs 3 samples/voxel
  await page.getByRole('button', { name: 'MIP' }).click();
  const v3 = page.locator('[data-view="3d"]');
  const vb = await v3.boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(100);
  }
  for (const [q, jit, name] of [
    ['0.25', false, '07-mip-step025-nojitter.png'],
    ['0.25', true, '08-mip-step025-jitter.png'],
    ['3', false, '09-mip-step3.png'],
  ]) {
    await page.locator('label:has-text("샘플/복셀") input').fill(q);
    if (jit) await page.locator('label:has-text("지터") input').check();
    else await page.locator('label:has-text("지터") input').uncheck();
    await page.waitForTimeout(1500);
    await v3.screenshot({ path: path.join(out, name) });
    console.log('saved', name);
  }
}
if (idx['pydicom-dicomdirtests']) {
  await page.goto(`${BASE}/?sample=ext:pydicom-dicomdirtests/CT2`);
  await ready();
  await page.getByRole('button', { name: '뼈 (Bone)' }).click();
  await page.waitForTimeout(500);
  await shot('06-real-ct-gap.png');
}

fs.writeFileSync(path.join(out, 'console.log.txt'), logs.join('\n') + '\n');
console.log(`console messages: ${logs.length}`);
for (const l of logs.filter((l) => /error|warn/i.test(l)).slice(0, 20)) console.log(l);
await browser.close();
