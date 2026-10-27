/**
 * First guess of the dental arch from one axial slab: threshold the slab MIP to the
 * brightest pixels (teeth and cortical bone), then fit y = a x^2 + b x + c with RANSAC so
 * the spine, hyoid and metal streaks do not drag the curve. Users correct it by clicking.
 *
 * Coordinates are in-plane mm of the acquisition grid (x along +i, y along +j).
 */
import type { Arch } from './panorama';
import { voxelIndex, type Volume } from '../dicom/volume';

export interface ArchFit {
  arch: Arch;
  threshold: number;
  inliers: number;
  candidates: number;
  coeffs: [number, number, number];
}

export interface ArchFitOptions {
  slabMm?: number;
  /** fraction of slab pixels kept as candidates (brightest) */
  keepFraction?: number;
  /** inlier distance, mm */
  tolMm?: number;
  controlPoints?: number;
  seed?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Least squares y = a x^2 + b x + c (normal equations, 3x3 Cramer). */
export function fitParabola(xs: number[], ys: number[]): [number, number, number] | undefined {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0; // prettier-ignore
  for (let n = 0; n < xs.length; n++) {
    const x = xs[n];
    const x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; // prettier-ignore
    t0 += ys[n]; t1 += x * ys[n]; t2 += x2 * ys[n]; // prettier-ignore
  }
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [s4, s3, s2, s3, s2, s1, s2, s1, s0];
  const D = det(M);
  if (Math.abs(D) < 1e-9) return undefined;
  const a = det([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D;
  const b = det([s4, t2, s2, s3, t1, s1, s2, t0, s0]) / D;
  const c = det([s4, s3, t2, s3, s2, t1, s2, s1, t0]) / D;
  return [a, b, c];
}

export function fitArch(vol: Volume, k0: number, opts: ArchFitOptions = {}): ArchFit | undefined {
  const { slabMm = 10, keepFraction = 0.06, tolMm = 2.5, controlPoints = 9, seed = 1 } = opts;
  const [nx, ny, nz] = vol.dims;
  const [sx, sy, sz] = vol.spacing;
  const half = Math.max(0, Math.round(slabMm / 2 / sz));
  const k1 = Math.max(0, Math.round(k0) - half);
  const k2 = Math.min(nz - 1, Math.round(k0) + half);
  const mip = new Float32Array(nx * ny).fill(-Infinity);
  for (let k = k1; k <= k2; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v = vol.data[voxelIndex(vol, i, j, k)];
        if (v > mip[i + nx * j]) mip[i + nx * j] = v;
      }

  // Threshold at a high percentile: in CBCT the "HU" scale is device-dependent, so a fixed
  // number (e.g. 1000) picks bone on one scanner and noise on another.
  const sorted = Float32Array.from(mip).sort();
  const threshold = sorted[Math.floor(sorted.length * (1 - keepFraction))];
  const xs: number[] = [];
  const ys: number[] = [];
  const rnd = mulberry32(seed);
  const stride = Math.max(1, Math.floor(Math.sqrt((nx * ny * keepFraction) / 4000))); // ~4k candidates
  for (let j = 0; j < ny; j += stride)
    for (let i = 0; i < nx; i += stride)
      if (mip[i + nx * j] >= threshold) {
        xs.push(i * sx);
        ys.push(j * sy);
      }
  if (xs.length < 20) return undefined;

  // RANSAC on 3-point parabolas; residual measured vertically (adequate for a shallow U).
  let best: [number, number, number] | undefined;
  let bestIn = 0;
  for (let it = 0; it < 400; it++) {
    const idx = [0, 1, 2].map(() => Math.floor(rnd() * xs.length));
    const p = fitParabola(idx.map((q) => xs[q]), idx.map((q) => ys[q]));
    if (!p || Math.abs(p[0]) < 1e-4) continue; // a straight line is not an arch
    let inl = 0;
    for (let q = 0; q < xs.length; q++) if (Math.abs(p[0] * xs[q] ** 2 + p[1] * xs[q] + p[2] - ys[q]) < tolMm) inl++;
    if (inl > bestIn) {
      bestIn = inl;
      best = p;
    }
  }
  if (!best) return undefined;
  const ix: number[] = [];
  const iy: number[] = [];
  for (let q = 0; q < xs.length; q++)
    if (Math.abs(best[0] * xs[q] ** 2 + best[1] * xs[q] + best[2] - ys[q]) < tolMm) {
      ix.push(xs[q]);
      iy.push(ys[q]);
    }
  const coeffs = fitParabola(ix, iy) ?? best;
  const sx2 = [...ix].sort((a, b) => a - b);
  const xLo = sx2[Math.floor(sx2.length * 0.02)];
  const xHi = sx2[Math.floor(sx2.length * 0.98)];
  const points: [number, number][] = [];
  for (let q = 0; q < controlPoints; q++) {
    const x = xLo + ((xHi - xLo) * q) / (controlPoints - 1);
    points.push([x, coeffs[0] * x * x + coeffs[1] * x + coeffs[2]]);
  }
  return { arch: { k0: Math.round(k0), points }, threshold, inliers: ix.length, candidates: xs.length, coeffs };
}
