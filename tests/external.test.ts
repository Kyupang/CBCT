/**
 * Checks against downloaded public samples (data/external, git-ignored).
 * Skipped when the files are not present — run `npm run fetch-samples` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeries } from '../src/dicom/load';
import { parseSlice } from '../src/dicom/parse';
import { samplePlane } from '../src/dicom/resample';
import { add } from '../src/dicom/vec';
import { sampleAtPatient } from '../src/dicom/volume';

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

// ToothFairy (NewTom VGi CBCT exports, CC BY-SA, manual download — see data/external/README.md)
const tfRoot = path.join(root, 'toothfairy');
const tfCases = ['P221', 'P36'].filter((p) => fs.existsSync(path.join(tfRoot, 'raw', p)));

/** Constant LPS offset (mm) found between the vendor cross-sections' header geometry and their pixel content (DENTAL-LOG #D4). */
const VENDOR_OFFSET: Record<string, [number, number, number]> = { P221: [-0.11, -6.66, 1.27], P36: [-0.4, -10.1, -7.25] };

describe.skipIf(!tfCases.length)('ToothFairy dental CBCT (real scanner export)', () => {
  const cache = new Map<string, { vol: ReturnType<typeof loadSeries>; files: { name: string; bytes: Uint8Array }[] }>();
  const get = (p: string) => {
    if (!cache.has(p)) {
      const files = readDir(`toothfairy/raw/${p}`)!;
      cache.set(p, { vol: loadSeries(files), files });
    }
    return cache.get(p)!;
  };

  it.each(tfCases)('%s: picks the acquired axial series, not the larger-looking or derived ones', (p) => {
    const { vol } = get(p);
    expect(vol.spacing.map((s) => +s.toFixed(4))).toEqual([0.3, 0.3, 0.3]);
    expect(vol.report.otherSeries.map((o) => o.role).sort()).toEqual(
      p === 'P221' ? ['localizer', 'reformat', 'reformat', 'reformat'] : ['localizer', 'reformat', 'reformat'],
    );
    expect(vol.report.spacing.uniform).toBe(true);
  });

  it.each(tfCases)('%s: same value at the same LPS point as ITK (SimpleITK/GDCM)', (p) => {
    const ref = path.join(tfRoot, `${p}.sitk.json`);
    if (!fs.existsSync(ref)) return; // python scripts/validate_sitk.py not run
    const sitk = JSON.parse(fs.readFileSync(ref, 'utf8')) as { origin: number[]; points: { lps: [number, number, number]; value: number }[] };
    const { vol } = get(p);
    sitk.origin.forEach((v, a) => expect(vol.origin[a]).toBeCloseTo(v, 3));
    let same = 0;
    for (const pt of sitk.points) if (sampleAtPatient(vol, pt.lps) === pt.value) same++;
    expect(same).toBe(sitk.points.length);
  });

  it.each(tfCases)('%s: vendor cross-sections = our resampling, but only after one constant offset', (p) => {
    const { vol, files } = get(p);
    const cs = files
      .flatMap((f) => {
        try {
          return [parseSlice(f.bytes, f.name)];
        } catch {
          return [];
        }
      })
      .filter((s) => s.imageType.includes('REFORMATTED') && s.cols < 150);
    expect(cs.length).toBeGreaterThan(50);
    const corrAt = (shift: [number, number, number]) => {
      const rs = cs.map((s) => {
        const ours = samplePlane(vol, {
          origin: add(s.ipp, shift),
          rowDir: [s.iop[0], s.iop[1], s.iop[2]],
          colDir: [s.iop[3], s.iop[4], s.iop[5]],
          rows: s.rows,
          cols: s.cols,
          pixelSpacing: s.pixelSpacing,
        });
        // Burned-in annotation (the cross-section number) is written as saturated pixels
        // (stored 65535); leave it out or ~500 white pixels dominate the correlation.
        const sat = (1 << s.bitsStored) - 1;
        s.stored.forEach((v, q) => {
          if (v === sat) ours[q] = NaN;
        });
        return pearson(ours, Float32Array.from(s.stored, (v) => v * s.slope + s.intercept));
      });
      return rs.sort((a, b) => a - b)[Math.floor(rs.length / 2)];
    };
    expect(corrAt([0, 0, 0])).toBeLessThan(0.5); // header geometry as written: not the same anatomy
    expect(corrAt(VENDOR_OFFSET[p])).toBeGreaterThan(0.95);
  });
});

function pearson(a: Float32Array, b: Float32Array): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; // prettier-ignore
  for (let q = 0; q < a.length; q++) {
    if (Number.isNaN(a[q])) continue;
    n++;
    sa += a[q]; sb += b[q]; saa += a[q] * a[q]; sbb += b[q] * b[q]; sab += a[q] * b[q]; // prettier-ignore
  }
  return (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
}
