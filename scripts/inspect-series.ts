/** Usage: npm run inspect -- <dir>  — prints what the loader concluded about a series. */
import fs from 'node:fs';
import path from 'node:path';
import { loadSeries } from '../src/dicom/load';

for (const dir of process.argv.slice(2)) {
  const files = fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) }));
  const v = loadSeries(files);
  const r = v.report;
  console.log(`\n== ${dir}`);
  console.log(`dims ${v.dims.join('x')}  spacing ${v.spacing.map((s) => s.toFixed(4)).join(' x ')} mm  storage ${r.storageType}`);
  console.log(`modality ${v.modality}  HU range ${v.min}..${v.max}`);
  console.log(`rowDir ${v.rowDir.map((x) => x.toFixed(4))}  colDir ${v.colDir.map((x) => x.toFixed(4))}  normal ${v.normal.map((x) => x.toFixed(4))}`);
  console.log(`origin ${v.origin.map((x) => x.toFixed(3))}`);
  console.log(`slice diffs (mm): ${r.spacing.diffs.map((d) => d.toFixed(4)).join(', ')}`);
  console.log(`SliceThickness ${r.sliceThickness}  InstanceNumber vs position: ${r.instanceNumberMatchesPosition}  lateral drift ${r.maxLateralOffset.toFixed(4)} mm`);
  console.log(`warnings: ${JSON.stringify(r.warnings)}\nnotes: ${JSON.stringify(r.notes)}\nignored: ${JSON.stringify(r.ignoredFiles)}`);
}
