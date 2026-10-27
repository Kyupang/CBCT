import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three';
import { buildTextureVolume, chooseDownsample } from '../src/three/volumeTexture';
import { generatePhantom } from '../src/phantom/phantom';
import { loadSeries } from '../src/dicom/load';
import { windowLinear } from '../src/dicom/window';
import { extractPlane, planeDef } from '../src/dicom/mpr';

describe('3D texture preparation', () => {
  it('half float keeps integer HU exact up to 2048, then 2-HU steps', () => {
    for (const v of [-1024, -1000, -1, 0, 40, 1000, 2047, 2048]) expect(DataUtils.fromHalfFloat(DataUtils.toHalfFloat(v))).toBe(v);
    expect(Math.abs(DataUtils.fromHalfFloat(DataUtils.toHalfFloat(3071)) - 3071)).toBe(1);
  });

  it('downsample factor respects the voxel budget and MAX_3D_TEXTURE_SIZE', () => {
    expect(chooseDownsample([512, 512, 400], 2048)).toBe(2); // 104.9M voxels > 64M budget
    expect(chooseDownsample([256, 256, 256], 2048)).toBe(1);
    expect(chooseDownsample([800, 800, 100], 256)).toBe(4); // texture size limit dominates
  });

  it('texture holds HU (not windowed) and downsampling averages blocks', () => {
    const vol = loadSeries(generatePhantom().files);
    const t1 = buildTextureVolume(vol);
    expect(t1.factor).toBe(1);
    for (let i = 0; i < vol.data.length; i += 1013) expect(DataUtils.fromHalfFloat(t1.data[i])).toBe(vol.data[i]);
    const t2 = buildTextureVolume(vol, 2048, Math.floor(vol.data.length / 4));
    expect(t2.factor).toBe(2);
    expect(t2.dims).toEqual(vol.dims.map((n) => Math.ceil(n / 2)));
    expect(t2.spacing[0]).toBeCloseTo(vol.spacing[0] * 2);
  });
});

describe('window / level (DICOM linear VOI)', () => {
  it('maps the window edges and centre', () => {
    expect(windowLinear(-1000, 40, 400)).toBe(0);
    expect(windowLinear(1000, 40, 400)).toBe(255);
    expect(windowLinear(40 - 0.5, 40, 400)).toBeCloseTo(127.5, 6);
    expect(windowLinear(-160, 40, 400)).toBe(0); // c - 0.5 - (w-1)/2 = -160
    expect(windowLinear(239.5, 40, 400)).toBe(255);
  });
});

describe('MPR plane extraction', () => {
  it('coronal/sagittal carry slice spacing on screen y, superior at top', () => {
    const vol = loadSeries(generatePhantom({ sliceSpacing: 1.25, rowSpacing: 0.8, colSpacing: 0.6 }).files);
    const cor = extractPlane(vol, planeDef(vol, 'coronal'), [0, 56, 0]);
    expect(cor.pixelMm).toEqual([0.6, 1.25]);
    expect([cor.width, cor.height]).toEqual([vol.dims[0], vol.dims[2]]);
    const sag = extractPlane(vol, planeDef(vol, 'sagittal'), [64, 0, 0]);
    expect(sag.pixelMm[0]).toBeCloseTo(0.8);
    // LPS marker (superior) must be in the upper half of the coronal image through it
    const def = planeDef(vol, 'coronal');
    expect(def.flipV).toBe(true);
  });
});
