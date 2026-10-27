/**
 * Orthogonal MPR in voxel space. For an axially acquired series these are the familiar
 * axial / coronal / sagittal planes; for an oblique acquisition they are the planes of the
 * acquisition grid (labels on screen are derived from the actual direction cosines).
 */
import { voxelIndex, type Volume } from './volume';
import type { Vec3 } from './vec';

export type ViewKind = 'axial' | 'coronal' | 'sagittal';

export interface PlaneDef {
  /** voxel axis varying along screen x, screen y, and the fixed axis */
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
  w: 0 | 1 | 2;
  /** flip screen y so that patient Superior is up for coronal/sagittal */
  flipV: boolean;
  flipU: boolean;
}

export function planeDef(vol: Volume, kind: ViewKind): PlaneDef {
  // Superior (+z in LPS) should be at the top for planes that contain the slice axis.
  const flipV = vol.normal[2] > 0;
  if (kind === 'axial') return { u: 0, v: 1, w: 2, flipV: false, flipU: false };
  if (kind === 'coronal') return { u: 0, v: 2, w: 1, flipV, flipU: false };
  return { u: 1, v: 2, w: 0, flipV, flipU: false };
}

export interface PlaneImage {
  width: number; // pixels (voxels along u)
  height: number; // voxels along v
  /** physical size of one pixel in mm along screen x / y */
  pixelMm: [number, number];
  values: Float32Array;
}

/** Extract the plane through voxel coordinate `pos[w]` (nearest slice). */
export function extractPlane(vol: Volume, def: PlaneDef, pos: Vec3): PlaneImage {
  const width = vol.dims[def.u];
  const height = vol.dims[def.v];
  const fixed = Math.min(vol.dims[def.w] - 1, Math.max(0, Math.round(pos[def.w])));
  const values = new Float32Array(width * height);
  const idx: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const vy = def.flipV ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const ux = def.flipU ? width - 1 - x : x;
      idx[def.u] = ux;
      idx[def.v] = vy;
      idx[def.w] = fixed;
      values[y * width + x] = vol.data[voxelIndex(vol, idx[0], idx[1], idx[2])];
    }
  }
  return { width, height, pixelMm: [vol.spacing[def.u], vol.spacing[def.v]], values };
}

/** Screen pixel (in plane-image pixel units, continuous) -> voxel coordinate */
export function planeToVoxel(vol: Volume, def: PlaneDef, x: number, y: number, pos: Vec3): Vec3 {
  const width = vol.dims[def.u];
  const height = vol.dims[def.v];
  const out: Vec3 = [pos[0], pos[1], pos[2]];
  out[def.u] = def.flipU ? width - 1 - x : x;
  out[def.v] = def.flipV ? height - 1 - y : y;
  return out;
}

export function voxelToPlane(vol: Volume, def: PlaneDef, p: Vec3): [number, number] {
  const width = vol.dims[def.u];
  const height = vol.dims[def.v];
  return [def.flipU ? width - 1 - p[def.u] : p[def.u], def.flipV ? height - 1 - p[def.v] : p[def.v]];
}

/** Single-letter patient direction for a unit vector in LPS (dominant axis), e.g. +x -> 'L'. */
export function directionLabel(d: Vec3): string {
  const letters: [string, string][] = [
    ['L', 'R'],
    ['P', 'A'],
    ['S', 'I'],
  ];
  const order = [0, 1, 2].sort((a, b) => Math.abs(d[b]) - Math.abs(d[a]));
  let s = '';
  for (const a of order) {
    if (Math.abs(d[a]) < 0.25) break;
    s += d[a] > 0 ? letters[a][0] : letters[a][1];
  }
  return s;
}

export function axisVector(vol: Volume, axis: 0 | 1 | 2): Vec3 {
  return axis === 0 ? vol.rowDir : axis === 1 ? vol.colDir : vol.normal;
}
