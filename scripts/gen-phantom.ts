/**
 * Writes phantom DICOM series to disk (for drag-and-drop or checking in other tools such as
 * 3D Slicer / pydicom), plus truth.json with the known geometry.
 *
 *   npm run phantom                 -> data/phantom/{axial,oblique-gap,implicit-12bit}/
 *   npm run phantom -- <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { generatePhantom, type PhantomOptions } from '../src/phantom/phantom';
import { TS_IMPLICIT_LE } from '../src/phantom/dicomWriter';

const outRoot = path.resolve(process.argv[2] ?? 'data/phantom');
const sets: Record<string, Partial<PhantomOptions>> = {
  axial: {},
  'oblique-gap': { tiltDeg: 20, yawDeg: 15, missingSlices: [30] },
  'implicit-12bit': { transferSyntax: TS_IMPLICIT_LE, pixelRepresentation: 0, bitsStored: 12, intercept: -1024, dirtyHighBits: true },
};

for (const [name, opts] of Object.entries(sets)) {
  const dir = path.join(outRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { files, truth } = generatePhantom(opts);
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.bytes);
  fs.writeFileSync(path.join(dir, 'truth.json'), JSON.stringify(truth, null, 2));
  console.log(`${name}: ${files.length} files -> ${dir}`);
}
