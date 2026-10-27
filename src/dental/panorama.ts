/**
 * Dental reformats: a panoramic image unrolled along the dental arch, and cross-sections
 * perpendicular to the arch.
 *
 * The arch is a curve in one axial plane of the acquisition grid (voxel k fixed), held in
 * in-plane millimetres (x = i * spacing[0], y = j * spacing[1]). The vertical axis of both
 * reformats is the grid's k axis, which is also what the scanner software in the ToothFairy
 * export uses (its reformats carry IOP column vector = -slice normal).
 */
import { CatmullRomCurve3, Vector3 } from 'three';
import type { PlaneImage } from '../dicom/mpr';
import { sampleLinear } from '../dicom/resample';
import type { Volume } from '../dicom/volume';

export interface Arch {
  /** voxel slice index of the plane the curve was drawn on */
  k0: number;
  /** control points, in-plane mm: [i * spacing[0], j * spacing[1]] */
  points: [number, number][];
}

export interface ArchSample {
  x: number;
  y: number;
  /** unit in-plane normal, pointing away from the inside of the arch (buccal) */
  nx: number;
  ny: number;
}

export interface ArchPath {
  arch: Arch;
  /** arc-length step between samples, mm */
  step: number;
  lengthMm: number;
  samples: ArchSample[];
}

/** Uniform arc-length samples along a centripetal Catmull-Rom spline through the points. */
export function buildArchPath(vol: Volume, arch: Arch, step = Math.min(vol.spacing[0], vol.spacing[1])): ArchPath {
  if (arch.points.length < 2) throw new Error('An arch needs at least 2 points');
  const curve = new CatmullRomCurve3(
    arch.points.map(([x, y]) => new Vector3(x, y, 0)),
    false,
    'centripetal',
  );
  const lengthMm = curve.getLength();
  const n = Math.max(2, Math.round(lengthMm / step) + 1);
  const pts = curve.getSpacedPoints(n - 1);
  // The centroid of the control points sits inside the opening of the U, so the normal at
  // the middle of the arch must point away from it; the sign then holds along the curve.
  const cx = arch.points.reduce((s, p) => s + p[0], 0) / arch.points.length;
  const cy = arch.points.reduce((s, p) => s + p[1], 0) / arch.points.length;
  const mid = Math.floor(n / 2);
  const tMid = curve.getTangentAt(mid / (n - 1));
  const sign = (-tMid.y) * (pts[mid].x - cx) + tMid.x * (pts[mid].y - cy) >= 0 ? 1 : -1;
  const samples = pts.map((p, idx) => {
    const t = curve.getTangentAt(idx / (n - 1));
    return { x: p.x, y: p.y, nx: -t.y * sign, ny: t.x * sign };
  });
  return { arch, step: lengthMm / (n - 1), lengthMm, samples };
}

/** Screen row r -> voxel k, so that patient Superior ends up at the top (as in planeDef). */
function rowToK(vol: Volume, r: number): number {
  return vol.normal[2] > 0 ? vol.dims[2] - 1 - r : r;
}

export interface PanoramaOptions {
  /** slab thickness across the arch, mm (averaged) */
  thicknessMm?: number;
  /** shift of the slab centre along the buccal normal, mm */
  offsetMm?: number;
}

/** Panorama: columns follow the arch (arc length), rows follow the slice axis. */
export function panorama(vol: Volume, path: ArchPath, opts: PanoramaOptions = {}): PlaneImage {
  const thickness = opts.thicknessMm ?? 8;
  const offset = opts.offsetMm ?? 0;
  const [sx, sy] = vol.spacing;
  const dStep = Math.min(sx, sy);
  const nd = Math.max(1, Math.round(thickness / dStep));
  const width = path.samples.length;
  const height = vol.dims[2];
  const values = new Float32Array(width * height);
  for (let c = 0; c < width; c++) {
    const s = path.samples[c];
    for (let r = 0; r < height; r++) {
      const k = rowToK(vol, r);
      let sum = 0;
      let cnt = 0;
      for (let q = 0; q < nd; q++) {
        const d = offset + (nd === 1 ? 0 : -thickness / 2 + (q * thickness) / (nd - 1));
        const val = sampleLinear(vol, (s.x + d * s.nx) / sx, (s.y + d * s.ny) / sy, k);
        if (!Number.isNaN(val)) {
          sum += val;
          cnt++;
        }
      }
      values[r * width + c] = cnt ? sum / cnt : vol.min;
    }
  }
  return { width, height, pixelMm: [path.step, vol.spacing[2]], values };
}

/** Cross-section at sample `index`: lingual on the left, buccal on the right, Superior up. */
export function crossSection(vol: Volume, path: ArchPath, index: number, widthMm = 30): PlaneImage {
  const [sx, sy] = vol.spacing;
  const step = Math.min(sx, sy);
  const s = path.samples[Math.min(path.samples.length - 1, Math.max(0, Math.round(index)))];
  const width = Math.max(2, Math.round(widthMm / step) + 1);
  const height = vol.dims[2];
  const values = new Float32Array(width * height);
  for (let c = 0; c < width; c++) {
    const d = -widthMm / 2 + c * step;
    const i = (s.x + d * s.nx) / sx;
    const j = (s.y + d * s.ny) / sy;
    for (let r = 0; r < height; r++) {
      const val = sampleLinear(vol, i, j, rowToK(vol, r));
      values[r * width + c] = Number.isNaN(val) ? vol.min : val;
    }
  }
  return { width, height, pixelMm: [step, vol.spacing[2]], values };
}
