/**
 * Raw images for the dental write-up (docs/DENTAL-LOG.md): writes 8-bit PGMs + a JSON of
 * numbers into <out>, which scripts/compose_dental_figures.py turns into PNG figures.
 *
 *   npx vite-node scripts/dental-figures.ts data/external/toothfairy/raw/P221 <out>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fitArch } from '../src/dental/arch';
import { buildArchPath, panorama } from '../src/dental/panorama';
import { loadSeries } from '../src/dicom/load';
import { parseSlice, type ParsedSlice } from '../src/dicom/parse';
import { samplePlane } from '../src/dicom/resample';
import { add, type Vec3 } from '../src/dicom/vec';
import { windowLinear } from '../src/dicom/window';

const [dir, out] = process.argv.slice(2);
const OFFSET: Vec3 = [-0.11, -6.66, 1.27]; // P221, measured in DENTAL-LOG #D4
fs.mkdirSync(out, { recursive: true });

const files = fs.readdirSync(dir).map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) }));
const vol = loadSeries(files);
const slices = files.flatMap((f): ParsedSlice[] => {
  try {
    return [parseSlice(f.bytes, f.name)];
  } catch {
    return [];
  }
});

function pgm(name: string, vals: ArrayLike<number>, w: number, h: number) {
  const px = Buffer.alloc(w * h);
  for (let q = 0; q < px.length; q++) px[q] = Number.isNaN(vals[q]) ? 0 : windowLinear(vals[q], 1000, 4000);
  fs.writeFileSync(path.join(out, name), Buffer.concat([Buffer.from(`P5 ${w} ${h} 255\n`), px]));
}

function pearson(a: Float32Array, s: ParsedSlice): number {
  const sat = (1 << s.bitsStored) - 1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; // prettier-ignore
  for (let q = 0; q < a.length; q++) {
    if (Number.isNaN(a[q]) || s.stored[q] === sat) continue;
    const b = s.stored[q] * s.slope + s.intercept;
    n++;
    sa += a[q]; sb += b; saa += a[q] * a[q]; sbb += b * b; sab += a[q] * b; // prettier-ignore
  }
  return (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
}

// 1. vendor cross-section vs our resampling at the header geometry, and after the offset
const cs = slices.filter((s) => s.imageType.includes('REFORMATTED') && s.cols < 150).sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
const s = cs[27];
const plane = (o: Vec3) =>
  samplePlane(vol, { origin: o, rowDir: [s.iop[0], s.iop[1], s.iop[2]], colDir: [s.iop[3], s.iop[4], s.iop[5]], rows: s.rows, cols: s.cols, pixelSpacing: s.pixelSpacing });
const asIs = plane(s.ipp);
const shifted = plane(add(s.ipp, OFFSET));
pgm('cs-vendor.pgm', Float32Array.from(s.stored, (v) => v * s.slope + s.intercept), s.cols, s.rows);
pgm('cs-ours-header.pgm', asIs, s.cols, s.rows);
pgm('cs-ours-shifted.pgm', shifted, s.cols, s.rows);

// 2. vendor panorama (middle layer) vs ours from the automatic arch
const panos = slices.filter((x) => x.imageType.includes('REFORMATTED') && x.cols > 500);
const bySeries = new Map<string, ParsedSlice[]>();
for (const p of panos) bySeries.set(p.seriesInstanceUID, [...(bySeries.get(p.seriesInstanceUID) ?? []), p]);
// The export holds 51 panoramic layers at different depths; show the one through the
// teeth: the most pixels in the tooth range (burned-in labels are saturated, so excluded).
const toothPixels = (x: ParsedSlice) => {
  let n = 0;
  for (const v of x.stored) {
    const hu = v * x.slope + x.intercept;
    if (hu > 2000 && v !== (1 << x.bitsStored) - 1) n++;
  }
  return n;
};
const vp = [...bySeries.values()].flat().reduce((best, x) => (toothPixels(x) > toothPixels(best) ? x : best));
pgm('pano-vendor.pgm', Float32Array.from(vp.stored, (v) => v * vp.slope + vp.intercept), vp.cols, vp.rows);
const k0 = Math.round(vol.dims[2] / 2);
const fit = fitArch(vol, k0)!;
const pathA = buildArchPath(vol, fit.arch, 0.3);
const ours = panorama(vol, pathA, { thicknessMm: 8 });
pgm('pano-ours.pgm', ours.values, ours.width, ours.height);

const numbers = {
  crossSection: { instance: s.instanceNumber, rHeader: pearson(asIs, s), rShifted: pearson(shifted, s), offset: OFFSET },
  panorama: { vendorWidth: vp.cols, vendorMm: vp.cols * vp.pixelSpacing[1], oursWidth: ours.width, oursMm: pathA.lengthMm, k0, threshold: fit.threshold, inliers: fit.inliers, candidates: fit.candidates },
};
fs.writeFileSync(path.join(out, 'numbers.json'), JSON.stringify(numbers, null, 2));
console.log(JSON.stringify(numbers));
