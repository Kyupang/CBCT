/**
 * Panoramic reformat on a synthetic jaw with a known answer: a U-shaped bone ridge
 * y = A x^2 + C in one axial band, plus "teeth" (spheres) at known arc lengths.
 */
import { describe, expect, it } from 'vitest';
import { fitArch } from '../src/dental/arch';
import { buildArchPath, crossSection, panorama } from '../src/dental/panorama';
import { sampleLinear, samplePlane } from '../src/dicom/resample';
import type { Volume } from '../src/dicom/volume';

const A = 0.02; // 1/mm
const C0 = 10; // mm
const sp = 0.5;
const [NX, NY, NZ] = [200, 160, 40];
const X0 = (NX * sp) / 2; // arch symmetric about x = 50 mm
const archY = (x: number) => A * (x - X0) ** 2 + C0;
// arc length of y = A u^2 from u = 0 to u = U
const arcFrom0 = (U: number) => {
  const t = 2 * A * U;
  return (t * Math.sqrt(1 + t * t) + Math.asinh(t)) / (4 * A);
};
const TEETH_U = [-30, -15, 0, 15, 30]; // x - X0 of each tooth centre, mm

function jaw(): Volume {
  const data = new Int16Array(NX * NY * NZ).fill(-1000);
  for (let k = 10; k < 30; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const x = i * sp;
        const y = j * sp;
        // vertical distance to the parabola is a fine proxy for distance on this shallow curve
        if (Math.abs(y - archY(x)) < 2 && Math.abs(x - X0) <= 40) data[i + NX * (j + NY * k)] = 1500;
        for (const u of TEETH_U) {
          const tx = X0 + u;
          if ((x - tx) ** 2 + (y - archY(tx)) ** 2 + ((k - 20) * sp) ** 2 < 9) data[i + NX * (j + NY * k)] = 3000;
        }
      }
  return {
    dims: [NX, NY, NZ],
    spacing: [sp, sp, sp],
    origin: [0, 0, 0],
    rowDir: [1, 0, 0],
    colDir: [0, 1, 0],
    normal: [0, 0, 1],
    data,
    min: -1000,
    max: 3000,
    modality: 'CT',
    seriesDescription: 'synthetic jaw',
    seriesInstanceUID: 'synthetic',
    defaultWindow: undefined,
    report: undefined as never,
  };
}

describe('dental panorama on a synthetic jaw', () => {
  const vol = jaw();

  it('RANSAC arch fit recovers the parabola', () => {
    const fit = fitArch(vol, 20, { keepFraction: 0.04 })!;
    expect(fit).toBeDefined();
    const [a, b] = fit.coeffs;
    expect(a).toBeCloseTo(A, 3);
    // vertex at x = -b / 2a
    expect(-b / (2 * a)).toBeCloseTo(X0, 0);
    for (const [x, y] of fit.arch.points) expect(Math.abs(y - archY(x))).toBeLessThan(0.6);
  });

  it('the arch path is uniform in arc length and as long as the analytic curve', () => {
    const pts: [number, number][] = [-40, -20, 0, 20, 40].map((u) => [X0 + u, archY(X0 + u)]);
    const path = buildArchPath(vol, { k0: 20, points: pts }, 0.5);
    expect(path.lengthMm).toBeCloseTo(2 * arcFrom0(40), 0);
    const d = path.samples.slice(1).map((s, q) => Math.hypot(s.x - path.samples[q].x, s.y - path.samples[q].y));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(0.02);
    // buccal normal points away from the inside of the U (towards smaller y at the vertex)
    expect(path.samples[Math.floor(path.samples.length / 2)].ny).toBeLessThan(-0.99);
  });

  it('teeth appear in the panorama at their arc-length positions, Superior up', () => {
    const pts: [number, number][] = [-40, -20, 0, 20, 40].map((u) => [X0 + u, archY(X0 + u)]);
    const path = buildArchPath(vol, { k0: 20, points: pts }, 0.5);
    const img = panorama(vol, path, { thicknessMm: 2 });
    const row = img.height - 1 - 20; // k = 20 with normal +z -> flipped to keep S up
    const profile = Array.from({ length: img.width }, (_, c) => img.values[row * img.width + c]);
    for (const u of TEETH_U) {
      const s = arcFrom0(40) + Math.sign(u) * arcFrom0(Math.abs(u));
      const col = Math.round(s / path.step);
      expect(profile[col]).toBeGreaterThan(2500);
    }
    // between teeth: bone, not tooth
    const mid = Math.round((arcFrom0(40) + arcFrom0(7.5)) / path.step);
    expect(profile[mid]).toBeGreaterThan(1000);
    expect(profile[mid]).toBeLessThan(2000);
  });

  it('a cross-section through a tooth is centred on it', () => {
    const pts: [number, number][] = [-40, -20, 0, 20, 40].map((u) => [X0 + u, archY(X0 + u)]);
    const path = buildArchPath(vol, { k0: 20, points: pts }, 0.5);
    const idx = Math.round(arcFrom0(40) / path.step); // the front tooth at u = 0
    const cs = crossSection(vol, path, idx, 20);
    const row = cs.height - 1 - 20;
    const centre = Math.floor(cs.width / 2);
    expect(cs.values[row * cs.width + centre]).toBeGreaterThan(2500);
    expect(cs.values[row * cs.width + 0]).toBe(-1000);
  });

  it('trilinear sampling and DICOM-style planes agree with the grid', () => {
    expect(sampleLinear(vol, 100, 20, 20)).toBe(vol.data[100 + NX * (20 + NY * 20)]);
    expect(sampleLinear(vol, -1, 0, 0)).toBeNaN();
    const p = samplePlane(vol, { origin: [0, 0, 10], rowDir: [1, 0, 0], colDir: [0, 1, 0], rows: NY, cols: NX, pixelSpacing: [sp, sp] });
    for (let q = 0; q < p.length; q += 997) expect(p[q]).toBe(vol.data[q + NX * NY * 20]);
  });
});
