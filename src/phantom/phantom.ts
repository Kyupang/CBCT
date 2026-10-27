/**
 * Synthetic CT phantom with known geometry, emitted as a DICOM series.
 * Everything here is "ground truth" the loader must recover: slice order, spacing,
 * HU values and where each object sits in patient (LPS, mm) space.
 */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from '../dicom/vec';
import { ds, TS_EXPLICIT_LE, TS_IMPLICIT_LE, writePart10, type Element } from './dicomWriter';

export type PhantomObject =
  | { kind: 'sphere'; name: string; center: Vec3; radius: number; hu: number }
  | { kind: 'cylinder'; name: string; center: Vec3; axis: Vec3; radius: number; halfLength: number; hu: number }
  | { kind: 'ellipsoid'; name: string; center: Vec3; semi: Vec3; hu: number };

export interface PhantomOptions {
  cols: number;
  rows: number;
  slices: number;
  /** PixelSpacing[0] (0028,0030): distance between adjacent ROWS, i.e. along the column direction. */
  rowSpacing: number;
  /** PixelSpacing[1]: distance between adjacent COLUMNS, i.e. along the row direction. */
  colSpacing: number;
  sliceSpacing: number;
  /** Written to SliceThickness (0018,0050); deliberately allowed to differ from sliceSpacing. */
  sliceThickness: number;
  /** Tilt about patient X, then rotate about patient Z (degrees). 0/0 = pure axial. */
  tiltDeg: number;
  yawDeg: number;
  center: Vec3;
  pixelRepresentation: 0 | 1;
  bitsStored: number;
  slope: number;
  intercept: number;
  /** Put garbage in the bits above BitsStored (some scanners store overlays there). */
  dirtyHighBits: boolean;
  /** Slice indices (in true spatial order) to omit from the output. */
  missingSlices: number[];
  transferSyntax: typeof TS_EXPLICIT_LE | typeof TS_IMPLICIT_LE;
  seed: number;
}

export const DEFAULT_PHANTOM: PhantomOptions = {
  cols: 128,
  rows: 112,
  slices: 64,
  rowSpacing: 0.8,
  colSpacing: 0.6,
  sliceSpacing: 1.25,
  sliceThickness: 2.0,
  tiltDeg: 0,
  yawDeg: 0,
  center: [10, -20, 30],
  pixelRepresentation: 1,
  bitsStored: 16,
  slope: 1,
  intercept: 0,
  dirtyHighBits: false,
  missingSlices: [],
  transferSyntax: TS_EXPLICIT_LE,
  seed: 42,
};

export interface PhantomTruth {
  options: PhantomOptions;
  rowDir: Vec3;
  colDir: Vec3;
  normal: Vec3;
  /** IPP of the first (most negative along normal) slice, including missing ones. */
  origin: Vec3;
  objects: PhantomObject[];
  /** Spatial index of each emitted slice, keyed by file name. */
  sliceIndexByFile: Record<string, number>;
}

export interface PhantomFile {
  name: string;
  bytes: Uint8Array;
}

const AIR = -1000;

/** Objects are defined relative to the phantom centre, in patient LPS mm. */
export function phantomObjects(center: Vec3): PhantomObject[] {
  const c = (d: Vec3): Vec3 => add(center, d);
  return [
    { kind: 'ellipsoid', name: 'body (water)', center: c([0, 0, 0]), semi: [34, 38, 36], hu: 0 },
    { kind: 'sphere', name: 'bone', center: c([14, 0, 8]), radius: 8, hu: 1000 },
    { kind: 'sphere', name: 'soft tissue', center: c([-14, 10, -8]), radius: 6, hu: 60 },
    { kind: 'sphere', name: 'fat', center: c([-12, -16, 10]), radius: 5, hu: -100 },
    { kind: 'cylinder', name: 'vessel (S-I)', center: c([0, 18, 0]), axis: [0, 0, 1], radius: 3.5, halfLength: 24, hu: 300 },
    // Asymmetric marker: patient Left (+x), Posterior (+y), Superior (+z). Catches flips.
    { kind: 'sphere', name: 'LPS marker', center: c([22, 22, 22]), radius: 3, hu: 2000 },
  ];
}

export function phantomHU(objects: PhantomObject[], p: Vec3): number {
  let hu = AIR;
  for (const o of objects) {
    const d = sub(p, o.center);
    let inside = false;
    if (o.kind === 'sphere') inside = length(d) <= o.radius;
    else if (o.kind === 'ellipsoid') inside = (d[0] / o.semi[0]) ** 2 + (d[1] / o.semi[1]) ** 2 + (d[2] / o.semi[2]) ** 2 <= 1;
    else {
      const a = normalize(o.axis);
      const t = dot(d, a);
      inside = Math.abs(t) <= o.halfLength && length(sub(d, scale(a, t))) <= o.radius;
    }
    if (inside) hu = o.hu;
  }
  return hu;
}

function rotation(tiltDeg: number, yawDeg: number) {
  const t = (tiltDeg * Math.PI) / 180;
  const y = (yawDeg * Math.PI) / 180;
  const rx = (v: Vec3): Vec3 => [v[0], v[1] * Math.cos(t) - v[2] * Math.sin(t), v[1] * Math.sin(t) + v[2] * Math.cos(t)];
  const rz = (v: Vec3): Vec3 => [v[0] * Math.cos(y) - v[1] * Math.sin(y), v[0] * Math.sin(y) + v[1] * Math.cos(y), v[2]];
  const r = (v: Vec3) => rz(rx(v));
  return { rowDir: r([1, 0, 0]), colDir: r([0, 1, 0]) };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function phantomGeometry(o: PhantomOptions) {
  const { rowDir, colDir } = rotation(o.tiltDeg, o.yawDeg);
  const normal = cross(rowDir, colDir);
  const origin = sub(
    sub(sub(o.center, scale(rowDir, ((o.cols - 1) / 2) * o.colSpacing)), scale(colDir, ((o.rows - 1) / 2) * o.rowSpacing)),
    scale(normal, ((o.slices - 1) / 2) * o.sliceSpacing),
  );
  return { rowDir, colDir, normal, origin };
}

export function generatePhantom(opts: Partial<PhantomOptions> = {}): { files: PhantomFile[]; truth: PhantomTruth } {
  const o: PhantomOptions = { ...DEFAULT_PHANTOM, ...opts };
  const { rowDir, colDir, normal, origin } = phantomGeometry(o);
  const objects = phantomObjects(o.center);
  const rnd = mulberry32(o.seed);

  const studyUID = `1.2.826.0.1.3680043.10.1001.${o.seed}.1`;
  const seriesUID = `${studyUID}.${o.tiltDeg | 0}${o.yawDeg | 0}${o.missingSlices.length}.2`;
  const present = Array.from({ length: o.slices }, (_, k) => k).filter((k) => !o.missingSlices.includes(k));
  // InstanceNumber deliberately scrambled: it must NOT be used for ordering.
  const instanceNumbers = shuffle(present.map((_, i) => i + 1), rnd);
  const order = shuffle(present, rnd);

  const mask = (1 << o.bitsStored) - 1;
  const files: PhantomFile[] = [];
  const sliceIndexByFile: Record<string, number> = {};
  const usedNames = new Set<string>();

  for (const k of order) {
    const ipp = add(origin, scale(normal, k * o.sliceSpacing));
    const pixels = new Uint8Array(o.rows * o.cols * 2);
    const dv = new DataView(pixels.buffer);
    for (let r = 0; r < o.rows; r++) {
      for (let c = 0; c < o.cols; c++) {
        const p = add(add(ipp, scale(rowDir, c * o.colSpacing)), scale(colDir, r * o.rowSpacing));
        const hu = phantomHU(objects, p);
        let stored = Math.round((hu - o.intercept) / o.slope);
        let word = stored & mask; // two's complement within BitsStored for signed data
        if (o.bitsStored < 16) {
          if (o.dirtyHighBits) word |= 0xa000 & ~mask & 0xffff;
          else if (o.pixelRepresentation === 1 && stored < 0) word |= ~mask & 0xffff; // sign-extend
        }
        stored = word & 0xffff;
        dv.setUint16((r * o.cols + c) * 2, stored, true);
      }
    }
    let name: string;
    do name = `IMG_${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}.dcm`;
    while (usedNames.has(name));
    usedNames.add(name);
    const sopInstanceUID = `${seriesUID}.${k + 1}`;
    const inst = instanceNumbers[present.indexOf(k)];
    const ds6 = [...rowDir, ...colDir].map(ds);
    const dataset: Element[] = [
      { tag: 0x00080016, vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.2' },
      { tag: 0x00080018, vr: 'UI', value: sopInstanceUID },
      { tag: 0x00080060, vr: 'CS', value: 'CT' },
      { tag: 0x0008103e, vr: 'LO', value: `SYNTHETIC PHANTOM tilt${o.tiltDeg} yaw${o.yawDeg}` },
      { tag: 0x00100010, vr: 'PN', value: 'PHANTOM^SYNTHETIC' },
      { tag: 0x00100020, vr: 'LO', value: 'PHANTOM-0001' },
      { tag: 0x00180050, vr: 'DS', value: ds(o.sliceThickness) },
      { tag: 0x0020000d, vr: 'UI', value: studyUID },
      { tag: 0x0020000e, vr: 'UI', value: seriesUID },
      { tag: 0x00200013, vr: 'IS', value: String(inst) },
      { tag: 0x00200032, vr: 'DS', value: ipp.map(ds) },
      { tag: 0x00200037, vr: 'DS', value: ds6 },
      { tag: 0x00280002, vr: 'US', value: 1 },
      { tag: 0x00280004, vr: 'CS', value: 'MONOCHROME2' },
      { tag: 0x00280010, vr: 'US', value: o.rows },
      { tag: 0x00280011, vr: 'US', value: o.cols },
      { tag: 0x00280030, vr: 'DS', value: [ds(o.rowSpacing), ds(o.colSpacing)] },
      { tag: 0x00280100, vr: 'US', value: 16 },
      { tag: 0x00280101, vr: 'US', value: o.bitsStored },
      { tag: 0x00280102, vr: 'US', value: o.bitsStored - 1 },
      { tag: 0x00280103, vr: 'US', value: o.pixelRepresentation },
      { tag: 0x00281050, vr: 'DS', value: '40' },
      { tag: 0x00281051, vr: 'DS', value: '400' },
      { tag: 0x00281052, vr: 'DS', value: ds(o.intercept) },
      { tag: 0x00281053, vr: 'DS', value: ds(o.slope) },
      { tag: 0x7fe00010, vr: 'OW', value: pixels },
    ];
    files.push({ name, bytes: writePart10(dataset, { sopClassUID: '1.2.840.10008.5.1.4.1.1.2', sopInstanceUID, transferSyntax: o.transferSyntax }) });
    sliceIndexByFile[name] = k;
  }

  return { files, truth: { options: o, rowDir, colDir, normal, origin, objects, sliceIndexByFile } };
}
