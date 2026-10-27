/**
 * Checks against downloaded public samples (data/external, git-ignored).
 * Skipped when the files are not present — run `npm run fetch-samples` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeries } from '../src/dicom/load';

const root = path.resolve(import.meta.dirname, '../data/external');
function readDir(rel: string) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return undefined;
  return fs.readdirSync(dir).map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) }));
}

const ct5n = readDir('pydicom-dicomdirtests/raw/CT5N');
const ct2 = readDir('pydicom-dicomdirtests/raw/CT2');
const brain = readDir('daikon-brain/raw');

describe.skipIf(!ct5n)('pydicom CT5N (real CT, 5 slices)', () => {
  it('InstanceNumber runs opposite to spatial order; sorting by position still works', () => {
    const vol = loadSeries(ct5n!);
    expect(vol.dims).toEqual([16, 16, 5]);
    expect(vol.report.instanceNumberMatchesPosition).toBe('descending');
    expect(vol.spacing[2]).toBeCloseTo(2.5, 4);
    expect(vol.report.spacing.uniform).toBe(true);
    expect(vol.origin[2]).toBeCloseTo(-1.2375, 4); // most inferior slice first
    expect(vol.min).toBeGreaterThanOrEqual(-1024);
  });
});

describe.skipIf(!ct2)('pydicom CT2 (real CT, 4 slices with a 200 mm jump)', () => {
  it('huge gap is not interpolated; the contiguous run is kept', () => {
    const vol = loadSeries(ct2!);
    expect(vol.dims[2]).toBe(3);
    expect(vol.spacing[2]).toBeCloseTo(1.25, 4);
    expect(vol.report.ignoredFiles.map((f) => f.fileName)).toEqual(['17106']);
  });
});

describe.skipIf(!brain)('Daikon brain MR (real, oblique, 20 slices)', () => {
  it('oblique orientation and spacing from IPP (not SliceThickness=5)', () => {
    const vol = loadSeries(brain!);
    expect(vol.dims[0]).toBe(256);
    expect(vol.normal[1]).toBeLessThan(-0.1); // tilted ~7.7° about patient X
    // span/(n-1) = 7.0005 mm; the median diff (6.9718) would drift the last slice by ~0.55 mm
    expect(vol.report.spacing.spacing).toBeCloseTo(7.0005, 3);
    expect(vol.report.spacing.median).toBeCloseTo(6.9718, 3);
    expect(vol.report.spacing.uniform).toBe(true);
    expect(vol.report.spacing.maxResidual).toBeLessThan(0.08);
    expect(vol.dims[2]).toBe(20);
    expect(vol.report.sliceThickness).toBe(5);
    expect(vol.report.maxLateralOffset).toBeLessThan(0.5);
  });
});
