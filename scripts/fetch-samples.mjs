// Downloads the public sample series into data/external/<set>/raw (git-ignored).
// Files are only written as bytes; nothing from them is executed.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../data/external');
const PYDICOM = 'https://raw.githubusercontent.com/pydicom/pydicom/main/src/pydicom/data/test_files/dicomdirtests';
const DAIKON = 'https://raw.githubusercontent.com/rii-mango/Daikon/master/tests/data/volume';

const sets = [
  ...['17106', '17136', '17166', '17196'].map((f) => ['pydicom-dicomdirtests/raw/CT2', `${PYDICOM}/77654033/CT2/${f}`, f]),
  ...['2062', '2392', '2693', '3023', '3353'].map((f) => ['pydicom-dicomdirtests/raw/CT5N', `${PYDICOM}/98892001/CT5N/${f}`, f]),
  ...Array.from({ length: 20 }, (_, i) => {
    const f = `brain_${String(i + 1).padStart(3, '0')}.dcm`;
    return ['daikon-brain/raw', `${DAIKON}/${f}`, f];
  }),
];

for (const [dir, url, name] of sets) {
  const out = path.join(root, dir, name);
  if (fs.existsSync(out)) continue;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('fetched', dir, name);
}
console.log('done');
