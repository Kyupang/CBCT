/**
 * CPU-side preparation of the 3D texture.
 *
 * Format choice: R16F (half float) holding HU directly.
 *  - R16I / R16UI: exact, but integer textures cannot be linearly filtered in WebGL2 -> blocky
 *    rays unless we do 8-tap trilinear in the shader.
 *  - R32F: exact, but linear filtering needs OES_texture_float_linear (not universal) and 2x memory.
 *  - R8 normalised: 4x smaller but bakes one window into the data; W/L in 3D would band.
 *  - R16F: filterable in core WebGL2, 2 bytes/voxel. Integers are exact up to |2048|; above that
 *    the step is 2 HU (2048–4096) — irrelevant for rendering, and MPR/readout never use it.
 */
import { DataUtils } from 'three';
import type { Volume } from '../dicom/volume';

export interface TextureVolume {
  dims: [number, number, number];
  /** voxel size in mm after downsampling */
  spacing: [number, number, number];
  data: Uint16Array; // half-float bits
  factor: number;
  bytes: number;
}

/** Keep the 3D texture under this many voxels (~128 MB at 2 bytes/voxel). */
export const VOXEL_BUDGET = 64 * 1024 * 1024;

export function chooseDownsample(dims: [number, number, number], max3DSize: number, budget = VOXEL_BUDGET): number {
  let f = 1;
  const fits = (f: number) => {
    const d = dims.map((n) => Math.ceil(n / f));
    return d.every((n) => n <= max3DSize) && d[0] * d[1] * d[2] <= budget;
  };
  while (!fits(f)) f++;
  return f;
}

export function buildTextureVolume(vol: Volume, max3DSize = 2048, budget = VOXEL_BUDGET): TextureVolume {
  const f = chooseDownsample(vol.dims, max3DSize, budget);
  const [nx, ny, nz] = vol.dims;
  const d: [number, number, number] = [Math.ceil(nx / f), Math.ceil(ny / f), Math.ceil(nz / f)];
  const out = new Uint16Array(d[0] * d[1] * d[2]);

  // half-float lookup for integer HU (fast path for Int16 storage)
  const intLut = vol.data instanceof Int16Array ? new Uint16Array(65536) : undefined;
  if (intLut) for (let v = Math.floor(vol.min); v <= Math.ceil(vol.max); v++) intLut[v & 0xffff] = DataUtils.toHalfFloat(v);
  const half = (v: number) => (intLut && Number.isInteger(v) ? intLut[v & 0xffff] : DataUtils.toHalfFloat(v));

  if (f === 1) {
    for (let i = 0; i < out.length; i++) out[i] = half(vol.data[i]);
  } else {
    // box average of f^3 blocks (clipped at the edges)
    for (let z = 0; z < d[2]; z++)
      for (let y = 0; y < d[1]; y++)
        for (let x = 0; x < d[0]; x++) {
          let sum = 0;
          let n = 0;
          for (let k = z * f; k < Math.min(nz, z * f + f); k++)
            for (let j = y * f; j < Math.min(ny, y * f + f); j++)
              for (let i = x * f; i < Math.min(nx, x * f + f); i++) {
                sum += vol.data[i + nx * (j + ny * k)];
                n++;
              }
          out[x + d[0] * (y + d[1] * z)] = DataUtils.toHalfFloat(sum / n);
        }
  }
  return {
    dims: d,
    spacing: [vol.spacing[0] * f, vol.spacing[1] * f, vol.spacing[2] * f],
    data: out,
    factor: f,
    bytes: out.byteLength,
  };
}
