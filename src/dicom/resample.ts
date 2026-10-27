/**
 * Sampling the volume off the voxel grid: trilinear interpolation and arbitrary planes
 * defined in patient (LPS) space, the way DICOM describes an image (IPP + IOP + PixelSpacing).
 */
import { patientToVoxel, voxelIndex, type Volume } from './volume';
import { add, scale, type Vec3 } from './vec';

/** Trilinear value at a continuous voxel coordinate; `outside` beyond the grid. */
export function sampleLinear(v: Volume, i: number, j: number, k: number, outside = NaN): number {
  const [nx, ny, nz] = v.dims;
  if (i < -0.5 || j < -0.5 || k < -0.5 || i > nx - 0.5 || j > ny - 0.5 || k > nz - 0.5) return outside;
  const x = Math.min(nx - 1, Math.max(0, i));
  const y = Math.min(ny - 1, Math.max(0, j));
  const z = Math.min(nz - 1, Math.max(0, k));
  const x0 = Math.min(nx - 2, Math.floor(x));
  const y0 = Math.min(ny - 2, Math.floor(y));
  const z0 = Math.min(nz - 2, Math.floor(z));
  const fx = nx > 1 ? x - x0 : 0;
  const fy = ny > 1 ? y - y0 : 0;
  const fz = nz > 1 ? z - z0 : 0;
  const d = v.data;
  const at = (a: number, b: number, c: number) => d[voxelIndex(v, Math.max(0, a), Math.max(0, b), Math.max(0, c))];
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x0 + 1, y0, z0) * fx;
  const c10 = at(x0, y0 + 1, z0) * (1 - fx) + at(x0 + 1, y0 + 1, z0) * fx;
  const c01 = at(x0, y0, z0 + 1) * (1 - fx) + at(x0 + 1, y0, z0 + 1) * fx;
  const c11 = at(x0, y0 + 1, z0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1, z0 + 1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

export function sampleLinearAtPatient(v: Volume, p: Vec3, outside = NaN): number {
  const [i, j, k] = patientToVoxel(v, p);
  return sampleLinear(v, i, j, k, outside);
}

export interface PlaneSpec {
  /** LPS mm of the centre of pixel (row 0, column 0) — DICOM ImagePositionPatient */
  origin: Vec3;
  /** unit vector of increasing column index — IOP[0:3] */
  rowDir: Vec3;
  /** unit vector of increasing row index — IOP[3:6] */
  colDir: Vec3;
  rows: number;
  cols: number;
  /** [between rows, between columns] mm — DICOM PixelSpacing order */
  pixelSpacing: [number, number];
}

/** Resample the volume on a plane described the DICOM way. Row-major, NaN outside. */
export function samplePlane(v: Volume, p: PlaneSpec): Float32Array {
  const out = new Float32Array(p.rows * p.cols);
  for (let r = 0; r < p.rows; r++) {
    const rowStart = add(p.origin, scale(p.colDir, r * p.pixelSpacing[0]));
    for (let c = 0; c < p.cols; c++) {
      out[r * p.cols + c] = sampleLinearAtPatient(v, add(rowStart, scale(p.rowDir, c * p.pixelSpacing[1])));
    }
  }
  return out;
}
