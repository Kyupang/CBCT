/**
 * The viewer-ready volume the server derives from an uploaded DICOM series.
 *
 * Browsers never download the 300+ DICOM files: the server parses them once (same loader as
 * the viewer), then stores the voxel grid as raw little-endian arrays at two resolutions plus
 * a small JSON with the geometry. No patient tags are copied into it.
 *
 * Geometry is kept in DICOM patient space (LPS mm), so a point measured on the desktop
 * viewer lands on the same anatomy at every level.
 */
import type { Volume } from '../dicom/volume';
import { add, scale, type Vec3 } from '../dicom/vec';

export interface LevelInfo {
  /** 0 = full resolution; n = averaged over factor^3 blocks */
  level: number;
  factor: number;
  dims: [number, number, number];
  spacing: [number, number, number];
  /** LPS mm of voxel (0,0,0) centre at this level */
  origin: Vec3;
  dtype: 'int16' | 'float32';
  bytes: number;
}

export interface VolumeMeta {
  format: 'dwv-volume/1';
  rowDir: Vec3;
  colDir: Vec3;
  normal: Vec3;
  min: number;
  max: number;
  modality: string;
  defaultWindow?: { center: number; width: number };
  levels: LevelInfo[];
  source: {
    sliceCount: number;
    fileCount: number;
    warnings: string[];
    notes: string[];
    otherSeries: { role: string; count: number }[];
  };
}

/**
 * Block-average by `f` along each axis. The new voxel (0,0,0) is the mean of old voxels
 * 0..f-1, so its centre sits (f-1)/2 old voxels further along each axis — the origin must
 * move with it, or every marker drifts by up to half a block.
 */
export function downsample(v: Pick<Volume, 'dims' | 'spacing' | 'origin' | 'rowDir' | 'colDir' | 'normal' | 'data'>, f: number) {
  const [nx, ny, nz] = v.dims;
  const dims: [number, number, number] = [Math.max(1, Math.floor(nx / f)), Math.max(1, Math.floor(ny / f)), Math.max(1, Math.floor(nz / f))];
  const float = v.data instanceof Float32Array;
  const out = float ? new Float32Array(dims[0] * dims[1] * dims[2]) : new Int16Array(dims[0] * dims[1] * dims[2]);
  const n = f * f * f;
  for (let k = 0; k < dims[2]; k++)
    for (let j = 0; j < dims[1]; j++)
      for (let i = 0; i < dims[0]; i++) {
        let s = 0;
        for (let c = 0; c < f; c++)
          for (let b = 0; b < f; b++) {
            const row = ((k * f + c) * ny + (j * f + b)) * nx + i * f;
            for (let a = 0; a < f; a++) s += v.data[row + a];
          }
        out[(k * dims[1] + j) * dims[0] + i] = float ? s / n : Math.round(s / n);
      }
  const half = (f - 1) / 2;
  const origin = add(add(add(v.origin, scale(v.rowDir, half * v.spacing[0])), scale(v.colDir, half * v.spacing[1])), scale(v.normal, half * v.spacing[2]));
  return { dims, spacing: v.spacing.map((s) => s * f) as [number, number, number], origin, data: out };
}

/** Rebuild a viewer Volume from one stored level. */
export function volumeFromLevel(meta: VolumeMeta, level: LevelInfo, buf: ArrayBuffer, label: string): Volume {
  const data = level.dtype === 'int16' ? new Int16Array(buf) : new Float32Array(buf);
  if (data.length !== level.dims[0] * level.dims[1] * level.dims[2]) throw new Error(`level ${level.level}: ${data.length} voxels, expected ${level.dims.join('x')}`);
  let min = Infinity;
  let max = -Infinity;
  for (let q = 0; q < data.length; q++) {
    if (data[q] < min) min = data[q];
    if (data[q] > max) max = data[q];
  }
  return {
    dims: level.dims,
    spacing: level.spacing,
    origin: level.origin,
    rowDir: meta.rowDir,
    colDir: meta.colDir,
    normal: meta.normal,
    data,
    min,
    max,
    modality: meta.modality,
    seriesDescription: label,
    seriesInstanceUID: label,
    defaultWindow: meta.defaultWindow,
    report: {
      sliceCount: meta.source.sliceCount,
      ignoredFiles: [],
      otherSeries: meta.source.otherSeries.map((o, q) => ({ seriesInstanceUID: `#${q}`, count: o.count, imageType: '', role: o.role as never })),
      duplicatePositions: 0,
      spacing: { positions: [], diffs: [], median: level.spacing[2], spacing: level.spacing[2], maxResidual: 0, min: level.spacing[2], max: level.spacing[2], uniform: true, gaps: [] },
      sliceThickness: undefined,
      resampled: false,
      storageType: level.dtype,
      maxLateralOffset: 0,
      instanceNumberMatchesPosition: 'n/a',
      warnings: [...meta.source.warnings, ...(level.factor > 1 ? [`저해상도 미리보기 (1/${level.factor}) — 원본 해상도를 받는 중`] : [])],
      notes: meta.source.notes,
    },
  };
}
