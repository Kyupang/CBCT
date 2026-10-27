import { describe, expect, it } from 'vitest';
import { generatePhantom, phantomHU, type PhantomOptions, type PhantomTruth } from '../src/phantom/phantom';
import { TS_IMPLICIT_LE } from '../src/phantom/dicomWriter';
import { loadSeries } from '../src/dicom/load';
import { parseSlice } from '../src/dicom/parse';
import { patientToVoxel, sampleAtPatient, voxelToPatient, type Volume } from '../src/dicom/volume';
import { add, dist, dot, type Vec3 } from '../src/dicom/vec';

function expectVec(a: Vec3, b: Vec3, tol = 1e-3) {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
}

/** Every object centre must read back the object's HU at its known LPS position. */
function expectObjectsAtTruth(vol: Volume, truth: PhantomTruth) {
  for (const o of truth.objects) {
    expect(sampleAtPatient(vol, o.center), o.name).toBe(o.hu);
  }
}

describe('phantom: slice ordering', () => {
  const { files, truth } = generatePhantom();

  it('files are emitted shuffled, with scrambled InstanceNumber', () => {
    const order = files.map((f) => truth.sliceIndexByFile[f.name]);
    expect(order).not.toEqual([...order].sort((a, b) => a - b));
    const byName = [...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => truth.sliceIndexByFile[f.name]);
    expect(byName).not.toEqual([...byName].sort((a, b) => a - b));
  });

  it('sorts by IPP projected on the normal, not by name or InstanceNumber', () => {
    const vol = loadSeries(files);
    expect(vol.report.instanceNumberMatchesPosition).toBe('no');
    expect(vol.dims).toEqual([truth.options.cols, truth.options.rows, truth.options.slices]);
    expectVec(vol.origin, truth.origin);
    // slice k of the volume must equal the file whose true index is k
    for (const f of files.slice(0, 8)) {
      const k = truth.sliceIndexByFile[f.name];
      const s = parseSlice(f.bytes, f.name);
      const per = s.rows * s.cols;
      for (let p = 0; p < per; p += 97) expect(vol.data[k * per + p]).toBe(s.stored[p] * s.slope + s.intercept);
    }
  });
});

describe('phantom: spacing', () => {
  it('uses measured spacing, not SliceThickness', () => {
    const { files, truth } = generatePhantom({ sliceSpacing: 1.25, sliceThickness: 2.0 });
    const vol = loadSeries(files);
    expect(vol.spacing[2]).toBeCloseTo(truth.options.sliceSpacing, 6);
    expect(vol.report.spacing.uniform).toBe(true);
    expect(vol.report.notes.join(' ')).toMatch(/SliceThickness/);
  });

  it('PixelSpacing[0] is row spacing (along column dir), [1] is column spacing', () => {
    const { files, truth } = generatePhantom({ rowSpacing: 0.8, colSpacing: 0.6 });
    const vol = loadSeries(files);
    expect(vol.spacing[0]).toBeCloseTo(0.6, 6); // along i (rowDir)
    expect(vol.spacing[1]).toBeCloseTo(0.8, 6); // along j (colDir)
    expectObjectsAtTruth(vol, truth);
  });

  it('detects a missing slice, reports where, and keeps geometry correct', () => {
    const { files, truth } = generatePhantom({ missingSlices: [20] });
    expect(files.length).toBe(truth.options.slices - 1);
    const vol = loadSeries(files);
    expect(vol.report.spacing.gaps).toHaveLength(1);
    expect(vol.report.spacing.gaps[0].missingEstimate).toBe(1);
    expect(vol.report.spacing.gaps[0].afterIndex).toBe(19);
    expect(vol.report.resampled).toBe(true);
    expect(vol.dims[2]).toBe(truth.options.slices); // gap filled, not collapsed
    expect(vol.spacing[2]).toBeCloseTo(truth.options.sliceSpacing, 6);
    expectObjectsAtTruth(vol, truth);
    // a naive stack would put true slice 41 at index 40 — check positions past the gap line up
    const p = voxelToPatient(vol, 10, 10, 40);
    expect(dot(p, truth.normal)).toBeCloseTo(dot(truth.origin, truth.normal) + 40 * truth.options.sliceSpacing, 6);
  });

  it('splits instead of interpolating across a huge gap', () => {
    const missing = Array.from({ length: 20 }, (_, i) => 40 + i);
    const { files } = generatePhantom({ missingSlices: missing });
    const vol = loadSeries(files);
    expect(vol.dims[2]).toBe(40);
    expect(vol.report.warnings.join(' ')).toMatch(/largest contiguous run/);
  });
});

describe('phantom: HU conversion and pixel representation', () => {
  const cases = [
    { name: 'signed 16-bit, intercept 0', o: { pixelRepresentation: 1 as const, bitsStored: 16, intercept: 0, slope: 1 } },
    { name: 'unsigned 12-bit, intercept -1024', o: { pixelRepresentation: 0 as const, bitsStored: 12, intercept: -1024, slope: 1 } },
    { name: 'unsigned 12-bit + garbage in high bits', o: { pixelRepresentation: 0 as const, bitsStored: 12, intercept: -1024, slope: 1, dirtyHighBits: true } },
    { name: 'signed 12-bit, sign-extended', o: { pixelRepresentation: 1 as const, bitsStored: 12, intercept: 0, slope: 1 } },
    { name: 'signed 12-bit + garbage in high bits', o: { pixelRepresentation: 1 as const, bitsStored: 12, intercept: 0, slope: 1, dirtyHighBits: true } },
    { name: 'slope 0.5 (float storage)', o: { pixelRepresentation: 1 as const, bitsStored: 16, intercept: -1000.25, slope: 0.5 } },
    { name: 'implicit VR little endian', o: { transferSyntax: TS_IMPLICIT_LE } as Partial<PhantomOptions> },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const { files, truth } = generatePhantom(c.o);
      const vol = loadSeries(files);
      expect(vol.report.ignoredFiles).toEqual([]);
      const isHalf = 'slope' in c.o && c.o.slope === 0.5;
      for (const o of truth.objects) {
        const hu = sampleAtPatient(vol, o.center)!;
        // slope 0.5 with intercept .25 quantises HU to 0.5 steps
        expect(Math.abs(hu - o.hu), o.name).toBeLessThanOrEqual(isHalf ? 0.25 : 0);
      }
      expect(vol.min).toBeGreaterThanOrEqual(-1001);
      expect(vol.max).toBeLessThanOrEqual(2000.5);
      expect(vol.report.storageType).toBe(isHalf ? 'float32' : 'int16');
    });
  }
});

describe('phantom: patient coordinates (LPS mm)', () => {
  for (const [tilt, yaw] of [
    [0, 0],
    [17, 0],
    [25, 30],
  ]) {
    it(`tilt ${tilt}°, yaw ${yaw}°: objects recovered at known LPS positions`, () => {
      const { files, truth } = generatePhantom({ tiltDeg: tilt, yawDeg: yaw });
      const vol = loadSeries(files);
      expectVec(vol.rowDir, truth.rowDir, 1e-6);
      expectVec(vol.normal, truth.normal, 1e-6);
      expectObjectsAtTruth(vol, truth);
      // voxel centres read back the analytic phantom value at their patient position
      let mismatches = 0;
      let checked = 0;
      for (let k = 0; k < vol.dims[2]; k += 7)
        for (let j = 0; j < vol.dims[1]; j += 5)
          for (let i = 0; i < vol.dims[0]; i += 5) {
            checked++;
            const p = voxelToPatient(vol, i, j, k);
            if (vol.data[i + vol.dims[0] * (j + vol.dims[1] * k)] !== phantomHU(truth.objects, p)) mismatches++;
          }
      expect(checked).toBeGreaterThan(1000);
      // allow a tiny fraction for DS (decimal string) rounding of IPP/IOP right at object boundaries
      expect(mismatches / checked).toBeLessThan(0.002);
    });
  }

  it('voxel <-> patient round trip is identity', () => {
    const { files } = generatePhantom({ tiltDeg: 25, yawDeg: 30 });
    const vol = loadSeries(files);
    for (const v of [
      [0, 0, 0],
      [12.5, 40.25, 7.75],
      [127, 111, 63],
    ] as Vec3[]) {
      expectVec(patientToVoxel(vol, voxelToPatient(vol, ...v)), v, 1e-9);
    }
  });

  it('distance in mm between two known objects is preserved on an oblique grid', () => {
    const { files, truth } = generatePhantom({ tiltDeg: 25, yawDeg: 30 });
    const vol = loadSeries(files);
    const [a, b] = [truth.objects[1].center, truth.objects[2].center];
    const va = patientToVoxel(vol, a);
    const vb = patientToVoxel(vol, b);
    expect(dist(voxelToPatient(vol, ...va), voxelToPatient(vol, ...vb))).toBeCloseTo(dist(a, b), 6);
  });

  it('LPS marker is at patient Left/Posterior/Superior of the centre, mirrors are empty', () => {
    const { files, truth } = generatePhantom();
    const vol = loadSeries(files);
    const marker = truth.objects.find((o) => o.name === 'LPS marker')!;
    const c = truth.options.center;
    expect(sampleAtPatient(vol, marker.center)).toBe(2000);
    expect(sampleAtPatient(vol, add(c, [-22, 22, 22]))).not.toBe(2000);
    expect(sampleAtPatient(vol, add(c, [22, -22, 22]))).not.toBe(2000);
    expect(sampleAtPatient(vol, add(c, [22, 22, -22]))).not.toBe(2000);
  });
});

describe('analyzeSpacing', () => {
  it('quantised positions: uses span/(n-1), tolerates rounding, still flags a real gap', async () => {
    const { analyzeSpacing } = await import('../src/dicom/volume');
    const pos = Array.from({ length: 20 }, (_, k) => Math.round((k * 7.0005) * 10) / 10);
    const a = analyzeSpacing(pos);
    expect(a.uniform).toBe(true);
    expect(a.spacing).toBeCloseTo(7.0, 1);
    const withGap = [...pos.slice(0, 8), ...pos.slice(9)];
    const b = analyzeSpacing(withGap);
    expect(b.uniform).toBe(false);
    expect(b.gaps).toHaveLength(1);
    expect(b.gaps[0].afterIndex).toBe(7);
  });
});
