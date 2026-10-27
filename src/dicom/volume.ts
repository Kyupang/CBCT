/**
 * Turn a bag of parsed slices into a geometrically correct volume.
 *
 * Ordering is by IPP projected on the slice normal (row x col from IOP) — never by
 * file name or InstanceNumber. Spacing is measured from those projections; if it is not
 * uniform (gaps, jitter) the stack is resampled onto a uniform grid so that voxel index
 * -> patient mm stays a single affine transform.
 */
import type { ParsedSlice } from './parse';
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from './vec';

export type HUArray = Int16Array | Float32Array;

export interface Volume {
  /** [nx (columns), ny (rows), nz (slices)] */
  dims: [number, number, number];
  /** mm per voxel step along i, j, k: [PixelSpacing[1], PixelSpacing[0], slice spacing] */
  spacing: [number, number, number];
  /** Patient position (LPS mm) of voxel (0,0,0) centre */
  origin: Vec3;
  rowDir: Vec3; // +i
  colDir: Vec3; // +j
  normal: Vec3; // +k
  /** HU (or modality units) at voxel centres, index = i + nx*(j + ny*k) */
  data: HUArray;
  min: number;
  max: number;
  modality: string;
  seriesDescription: string;
  seriesInstanceUID: string;
  defaultWindow: { center: number; width: number } | undefined;
  report: VolumeReport;
}

export interface SpacingInfo {
  /** Positions along the normal (mm) of the sorted, de-duplicated input slices */
  positions: number[];
  diffs: number[];
  median: number;
  min: number;
  max: number;
  uniform: boolean;
  gaps: { afterIndex: number; from: number; to: number; missingEstimate: number }[];
}

export interface VolumeReport {
  sliceCount: number;
  ignoredFiles: { fileName: string; reason: string }[];
  otherSeries: { seriesInstanceUID: string; count: number }[];
  duplicatePositions: number;
  spacing: SpacingInfo;
  sliceThickness: number | undefined;
  resampled: boolean;
  storageType: 'int16' | 'float32';
  /** Largest distance (mm) of an IPP from the line origin + t*normal (gantry tilt / shear indicator) */
  maxLateralOffset: number;
  instanceNumberMatchesPosition: 'ascending' | 'descending' | 'no' | 'n/a';
  warnings: string[];
  notes: string[];
}

const ORIENTATION_TOL = 1e-3;
/** Relative spacing tolerance before we call the stack non-uniform. */
export const SPACING_REL_TOL = 0.01;
/** Gaps wider than this many typical spacings split the stack instead of being interpolated. */
export const HUGE_GAP_FACTOR = 10;

export function sliceNormal(iop: ParsedSlice['iop']): { rowDir: Vec3; colDir: Vec3; normal: Vec3 } {
  const rowDir = normalize([iop[0], iop[1], iop[2]]);
  const colDir = normalize([iop[3], iop[4], iop[5]]);
  return { rowDir, colDir, normal: normalize(cross(rowDir, colDir)) };
}

export function analyzeSpacing(positions: number[]): SpacingInfo {
  const diffs = positions.slice(1).map((p, i) => p - positions[i]);
  if (diffs.length === 0) return { positions, diffs, median: 1, min: 1, max: 1, uniform: true, gaps: [] };
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tol = Math.max(median * SPACING_REL_TOL, 1e-3);
  const uniform = diffs.every((d) => Math.abs(d - median) <= tol);
  const gaps = diffs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d > median * 1.5)
    .map(({ d, i }) => ({ afterIndex: i, from: positions[i], to: positions[i + 1], missingEstimate: Math.round(d / median) - 1 }));
  return { positions, diffs, median, min: sorted[0], max: sorted[sorted.length - 1], uniform, gaps };
}

export function buildVolume(all: ParsedSlice[], ignored: { fileName: string; reason: string }[] = []): Volume {
  if (all.length === 0) throw new Error('No image slices');
  const warnings: string[] = [];
  const notes = new Set<string>();

  // 1. Pick the series with the most slices; report the rest.
  const bySeries = new Map<string, ParsedSlice[]>();
  for (const s of all) bySeries.set(s.seriesInstanceUID, [...(bySeries.get(s.seriesInstanceUID) ?? []), s]);
  const seriesList = [...bySeries.entries()].sort((a, b) => b[1].length - a[1].length);
  const [seriesUID, seriesSlices] = seriesList[0];
  const otherSeries = seriesList.slice(1).map(([uid, l]) => ({ seriesInstanceUID: uid, count: l.length }));
  if (otherSeries.length) warnings.push(`${otherSeries.length} other series in the drop were ignored (showing the largest)`);

  // 2. Consistent geometry within the series.
  const ref = seriesSlices[0];
  const { rowDir, colDir, normal } = sliceNormal(ref.iop);
  const slices: ParsedSlice[] = [];
  for (const s of seriesSlices) {
    const reason =
      s.rows !== ref.rows || s.cols !== ref.cols
        ? `size ${s.cols}x${s.rows} differs from ${ref.cols}x${ref.rows}`
        : s.iop.some((v, i) => Math.abs(v - ref.iop[i]) > ORIENTATION_TOL)
          ? 'ImageOrientationPatient differs from the rest of the series'
          : Math.abs(s.pixelSpacing[0] - ref.pixelSpacing[0]) > 1e-4 || Math.abs(s.pixelSpacing[1] - ref.pixelSpacing[1]) > 1e-4
            ? 'PixelSpacing differs'
            : undefined;
    if (reason) ignored.push({ fileName: s.fileName, reason });
    else slices.push(s);
    s.notes.forEach((n) => notes.add(n));
  }
  if (Math.abs(dot(rowDir, colDir)) > 1e-3) warnings.push('Row and column direction cosines are not orthogonal');

  // 3. Sort by position along the normal.
  const withPos = slices.map((s) => ({ s, pos: dot(s.ipp, normal) })).sort((a, b) => a.pos - b.pos);
  let duplicatePositions = 0;
  const unique: typeof withPos = [];
  for (const e of withPos) {
    if (unique.length && Math.abs(e.pos - unique[unique.length - 1].pos) < 1e-3) {
      duplicatePositions++;
      ignored.push({ fileName: e.s.fileName, reason: `duplicate position ${e.pos.toFixed(3)} mm` });
    } else unique.push(e);
  }
  if (duplicatePositions) warnings.push(`${duplicatePositions} slice(s) share a position with another slice and were dropped`);

  // InstanceNumber is only checked, never used.
  const ins = unique.map((e) => e.s.instanceNumber);
  let instanceNumberMatchesPosition: VolumeReport['instanceNumberMatchesPosition'] = 'n/a';
  if (ins.every((v) => v !== undefined) && ins.length > 1) {
    const asc = ins.every((v, i) => i === 0 || v! > ins[i - 1]!);
    const desc = ins.every((v, i) => i === 0 || v! < ins[i - 1]!);
    instanceNumberMatchesPosition = asc ? 'ascending' : desc ? 'descending' : 'no';
  }

  // A gap far larger than the typical spacing is not "a few missing slices" — interpolating
  // across it would invent anatomy. Keep the largest contiguous run instead.
  let run = unique;
  {
    const pre = analyzeSpacing(unique.map((e) => e.pos));
    const breaks = pre.diffs.map((d, i) => (d > pre.median * HUGE_GAP_FACTOR ? i : -1)).filter((i) => i >= 0);
    if (breaks.length) {
      const cuts = [-1, ...breaks, unique.length - 1];
      let best: [number, number] = [0, 0];
      for (let c = 0; c < cuts.length - 1; c++) {
        const [a, b] = [cuts[c] + 1, cuts[c + 1]];
        if (b - a > best[1] - best[0]) best = [a, b];
      }
      run = unique.slice(best[0], best[1] + 1);
      for (const e of unique) if (!run.includes(e)) ignored.push({ fileName: e.s.fileName, reason: `separated from the main stack by a gap > ${HUGE_GAP_FACTOR}x spacing` });
      warnings.push(`Stack has a gap > ${HUGE_GAP_FACTOR}x the typical spacing — kept the largest contiguous run (${run.length}/${unique.length} slices)`);
    }
  }
  const kept = [...run];
  unique.length = 0;
  unique.push(...kept);

  const spacing = analyzeSpacing(unique.map((e) => e.pos));
  const first = unique[0].s;
  const origin = first.ipp;
  let maxLateralOffset = 0;
  for (const e of unique) {
    const d = sub(e.s.ipp, origin);
    maxLateralOffset = Math.max(maxLateralOffset, length(sub(d, scale(normal, dot(d, normal)))));
  }
  if (maxLateralOffset > 0.5) {
    warnings.push(`Slice origins drift ${maxLateralOffset.toFixed(2)} mm off the slice normal (gantry tilt / sheared stack?) — volume treated as unsheared`);
  }
  if (spacing.gaps.length) {
    const missing = spacing.gaps.reduce((n, g) => n + g.missingEstimate, 0);
    warnings.push(`Gap(s) in the stack: ~${missing} missing slice(s) — filled by linear interpolation`);
  } else if (!spacing.uniform) {
    warnings.push(`Non-uniform slice spacing (${spacing.min.toFixed(3)}–${spacing.max.toFixed(3)} mm) — resampled to ${spacing.median.toFixed(3)} mm`);
  }
  const st = first.sliceThickness;
  if (st !== undefined && unique.length > 1 && Math.abs(st - spacing.median) > 0.01) {
    notes.add(`SliceThickness ${st} mm ≠ measured spacing ${spacing.median.toFixed(3)} mm (spacing is used)`);
  }

  // 4. Rescale to HU. Int16 when it is exact, else float32.
  const nx = first.cols;
  const ny = first.rows;
  const per = nx * ny;
  const integral = unique.every((e) => Number.isInteger(e.s.slope) && Number.isInteger(e.s.intercept));
  let lo = Infinity;
  let hi = -Infinity;
  for (const { s } of unique) {
    for (let p = 0; p < per; p++) {
      const v = s.stored[p] * s.slope + s.intercept;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const asInt16 = integral && lo >= -32768 && hi <= 32767;
  const sliceHU = (s: ParsedSlice): HUArray => {
    const out = asInt16 ? new Int16Array(per) : new Float32Array(per);
    for (let p = 0; p < per; p++) out[p] = s.stored[p] * s.slope + s.intercept;
    return out;
  };

  // 5. Stack (or resample along k).
  const resampled = !spacing.uniform;
  const dz = spacing.median;
  const nz = resampled ? Math.round((spacing.positions[spacing.positions.length - 1] - spacing.positions[0]) / dz) + 1 : unique.length;
  const data: HUArray = asInt16 ? new Int16Array(per * nz) : new Float32Array(per * nz);
  if (!resampled) {
    unique.forEach((e, k) => data.set(sliceHU(e.s), k * per));
  } else {
    const hus = unique.map((e) => sliceHU(e.s));
    const pos = spacing.positions;
    let seg = 0;
    for (let k = 0; k < nz; k++) {
      const z = pos[0] + k * dz;
      while (seg < pos.length - 2 && pos[seg + 1] < z) seg++;
      const t = Math.min(1, Math.max(0, (z - pos[seg]) / (pos[seg + 1] - pos[seg])));
      const a = hus[seg];
      const b = hus[seg + 1];
      const o = k * per;
      for (let p = 0; p < per; p++) data[o + p] = asInt16 ? Math.round(a[p] * (1 - t) + b[p] * t) : a[p] * (1 - t) + b[p] * t;
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const wc = first.windowCenter;
  const ww = first.windowWidth;
  return {
    dims: [nx, ny, nz],
    spacing: [first.pixelSpacing[1], first.pixelSpacing[0], dz],
    origin,
    rowDir,
    colDir,
    normal,
    data,
    min,
    max,
    modality: first.modality,
    seriesDescription: first.seriesDescription,
    seriesInstanceUID: seriesUID,
    defaultWindow: wc !== undefined && ww !== undefined && ww > 0 ? { center: wc, width: ww } : undefined,
    report: {
      sliceCount: unique.length,
      ignoredFiles: ignored,
      otherSeries,
      duplicatePositions,
      spacing,
      sliceThickness: st,
      resampled,
      storageType: asInt16 ? 'int16' : 'float32',
      maxLateralOffset,
      instanceNumberMatchesPosition,
      warnings,
      notes: [...notes],
    },
  };
}

/** Continuous voxel index (i,j,k) -> patient LPS mm. */
export function voxelToPatient(v: Volume, i: number, j: number, k: number): Vec3 {
  return add(add(add(v.origin, scale(v.rowDir, i * v.spacing[0])), scale(v.colDir, j * v.spacing[1])), scale(v.normal, k * v.spacing[2]));
}

/** Patient LPS mm -> continuous voxel index. Valid because the axes are orthonormal. */
export function patientToVoxel(v: Volume, p: Vec3): Vec3 {
  const d = sub(p, v.origin);
  return [dot(d, v.rowDir) / v.spacing[0], dot(d, v.colDir) / v.spacing[1], dot(d, v.normal) / v.spacing[2]];
}

export function voxelIndex(v: Volume, i: number, j: number, k: number): number {
  return i + v.dims[0] * (j + v.dims[1] * k);
}

/** Nearest-voxel value, or undefined outside the volume. */
export function sampleNearest(v: Volume, i: number, j: number, k: number): number | undefined {
  const [x, y, z] = [Math.round(i), Math.round(j), Math.round(k)];
  if (x < 0 || y < 0 || z < 0 || x >= v.dims[0] || y >= v.dims[1] || z >= v.dims[2]) return undefined;
  return v.data[voxelIndex(v, x, y, z)];
}

export function sampleAtPatient(v: Volume, p: Vec3): number | undefined {
  const [i, j, k] = patientToVoxel(v, p);
  return sampleNearest(v, i, j, k);
}
