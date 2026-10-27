/** CPU-side timing for a CBCT-sized phantom: parse+build volume, then 3D texture prep. */
import { generatePhantom } from '../src/phantom/phantom';
import { loadSeries } from '../src/dicom/load';
import { buildTextureVolume } from '../src/three/volumeTexture';

const [cols, rows, slices] = (process.argv[2] ?? '512x512x300').split('x').map(Number);
const sp = 80 / cols;
let t = performance.now();
const { files } = generatePhantom({ cols, rows, slices, colSpacing: sp, rowSpacing: sp, sliceSpacing: 80 / slices });
const mb = files.reduce((n, f) => n + f.bytes.length, 0) / 1048576;
console.log(`generate ${cols}x${rows}x${slices}: ${(performance.now() - t).toFixed(0)} ms, ${mb.toFixed(0)} MB of DICOM`);
t = performance.now();
const vol = loadSeries(files);
console.log(`loadSeries (parse + sort + HU): ${(performance.now() - t).toFixed(0)} ms, ${vol.report.storageType}, ${(vol.data.byteLength / 1048576).toFixed(0)} MB`);
t = performance.now();
const tex = buildTextureVolume(vol);
console.log(`texture: ${tex.dims.join('x')} factor ${tex.factor}, ${(tex.bytes / 1048576).toFixed(0)} MB R16F, ${(performance.now() - t).toFixed(0)} ms`);
console.log(`heap used ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
