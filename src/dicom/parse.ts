/**
 * Per-file DICOM parsing: header fields we need for geometry + decoded stored pixel values.
 * Uses dicom-parser for the binary format; this module only interprets attributes.
 */
import * as dicomParser from 'dicom-parser';
import type { Vec3 } from './vec';

export const SUPPORTED_TRANSFER_SYNTAXES: Record<string, string> = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
};

export class UnsupportedDicomError extends Error {}

export interface SliceHeader {
  fileName: string;
  sopInstanceUID: string;
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  transferSyntax: string;
  rows: number;
  cols: number;
  /** (0020,0032) */
  ipp: Vec3;
  /** (0020,0037) row direction cosines, then column direction cosines */
  iop: [number, number, number, number, number, number];
  /** (0028,0030) [rowSpacing (between rows), colSpacing (between columns)] */
  pixelSpacing: [number, number];
  sliceThickness: number | undefined;
  instanceNumber: number | undefined;
  slope: number;
  intercept: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: 0 | 1;
  photometric: string;
  windowCenter: number | undefined;
  windowWidth: number | undefined;
  /** Notes about non-fatal oddities in this file (missing tags, defaults used). */
  notes: string[];
}

export interface ParsedSlice extends SliceHeader {
  /** Stored pixel values after BitsStored masking / sign extension (before rescale). Row-major, rows*cols. */
  stored: Int32Array;
}

function numbers(ds: dicomParser.DataSet, tag: string): number[] | undefined {
  const s = ds.string(tag);
  if (s === undefined || s.trim() === '') return undefined;
  return s.split('\\').map((x) => parseFloat(x));
}

function parseDataSet(bytes: Uint8Array): dicomParser.DataSet {
  try {
    return dicomParser.parseDicom(bytes);
  } catch (e) {
    // Files without the 128-byte preamble + "DICM" (raw dataset): dicom-parser needs a TS hint.
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes('DICM')) return dicomParser.parseDicom(bytes, { TransferSyntaxUID: '1.2.840.10008.1.2' });
    throw e;
  }
}

/** Extract only stored values; masks bits above BitsStored and sign-extends signed data. */
export function decodeStoredPixels(
  raw: Uint8Array,
  count: number,
  bitsAllocated: number,
  bitsStored: number,
  highBit: number,
  pixelRepresentation: 0 | 1,
): Int32Array {
  const out = new Int32Array(count);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bitsAllocated !== 16 && bitsAllocated !== 8) throw new UnsupportedDicomError(`BitsAllocated=${bitsAllocated} not supported`);
  const bytesPer = bitsAllocated / 8;
  if (raw.byteLength < count * bytesPer) throw new UnsupportedDicomError(`Pixel data too short: ${raw.byteLength} < ${count * bytesPer}`);
  const shift = highBit + 1 - bitsStored; // almost always 0
  const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  const signBit = 1 << (bitsStored - 1);
  for (let i = 0; i < count; i++) {
    let v = bytesPer === 2 ? dv.getUint16(i * 2, true) : raw[i];
    v = (v >>> shift) & mask;
    if (pixelRepresentation === 1 && v & signBit) v -= 1 << bitsStored;
    out[i] = v;
  }
  return out;
}

export function parseSlice(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedSlice {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ds = parseDataSet(bytes);
  const notes: string[] = [];
  const ts = ds.string('x00020010') ?? '1.2.840.10008.1.2';
  if (!SUPPORTED_TRANSFER_SYNTAXES[ts]) {
    throw new UnsupportedDicomError(`Transfer syntax ${ts} (compressed or big-endian) is not supported — convert to uncompressed little endian first`);
  }
  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const pixelEl = ds.elements.x7fe00010;
  if (!rows || !cols || !pixelEl) throw new UnsupportedDicomError('Not an image (no Rows/Columns/PixelData)');
  const spp = ds.uint16('x00280002') ?? 1;
  if (spp !== 1) throw new UnsupportedDicomError(`SamplesPerPixel=${spp} (color) not supported`);
  const frames = parseInt(ds.string('x00280008') ?? '1', 10);
  if (frames > 1) throw new UnsupportedDicomError(`Multi-frame (${frames} frames) not supported`);

  const ipp = numbers(ds, 'x00200032');
  const iop = numbers(ds, 'x00200037');
  if (!ipp || ipp.length !== 3 || !iop || iop.length !== 6) {
    throw new UnsupportedDicomError('Missing ImagePositionPatient / ImageOrientationPatient — cannot place slice in patient space');
  }
  let ps = numbers(ds, 'x00280030');
  if (!ps || ps.length !== 2) {
    ps = [1, 1];
    notes.push('PixelSpacing missing — assumed 1\\1 mm (measurements unreliable)');
  }
  const bitsAllocated = ds.uint16('x00280100') ?? 16;
  const bitsStored = ds.uint16('x00280101') ?? bitsAllocated;
  const highBit = ds.uint16('x00280102') ?? bitsStored - 1;
  const pixelRepresentation = (ds.uint16('x00280103') ?? 0) === 1 ? 1 : 0;
  const slopeS = ds.floatString('x00281053');
  const interceptS = ds.floatString('x00281052');
  if (slopeS === undefined || interceptS === undefined) notes.push('RescaleSlope/Intercept missing — using 1/0 (values are not HU)');

  const raw = new Uint8Array(bytes.buffer, bytes.byteOffset + pixelEl.dataOffset, pixelEl.length);
  const stored = decodeStoredPixels(raw, rows * cols, bitsAllocated, bitsStored, highBit, pixelRepresentation);

  return {
    fileName,
    sopInstanceUID: ds.string('x00080018') ?? fileName,
    seriesInstanceUID: ds.string('x0020000e') ?? 'unknown-series',
    seriesDescription: ds.string('x0008103e') ?? '',
    modality: ds.string('x00080060') ?? '',
    transferSyntax: ts,
    rows,
    cols,
    ipp: ipp as Vec3,
    iop: iop as SliceHeader['iop'],
    pixelSpacing: ps as [number, number],
    sliceThickness: ds.floatString('x00180050'),
    instanceNumber: ds.intString('x00200013'),
    slope: slopeS ?? 1,
    intercept: interceptS ?? 0,
    bitsAllocated,
    bitsStored,
    highBit,
    pixelRepresentation,
    photometric: ds.string('x00280004') ?? 'MONOCHROME2',
    windowCenter: ds.floatString('x00281050'),
    windowWidth: ds.floatString('x00281051'),
    stored,
    notes,
  };
}
