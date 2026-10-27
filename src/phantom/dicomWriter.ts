/**
 * Minimal DICOM Part 10 writer — just enough to emit single-frame grayscale images
 * for the synthetic phantom. Supports Explicit VR Little Endian (1.2.840.10008.1.2.1)
 * and Implicit VR Little Endian (1.2.840.10008.1.2). Not a general-purpose encoder.
 */

export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1' as const;
export const TS_IMPLICIT_LE = '1.2.840.10008.1.2' as const;

export type VR = 'UI' | 'CS' | 'DS' | 'IS' | 'LO' | 'PN' | 'US' | 'OB' | 'OW' | 'UL' | 'SH' | 'DA' | 'TM';

export interface Element {
  tag: number; // (group << 16) | element
  vr: VR;
  value: string | string[] | number | number[] | Uint8Array;
}

const LONG_VRS = new Set<VR>(['OB', 'OW']); // VRs with 2 reserved bytes + 4-byte length (subset we use)

function encodeValue(el: Element): Uint8Array {
  const { vr, value } = el;
  if (vr === 'US') {
    const arr = (Array.isArray(value) ? value : [value]) as number[];
    const out = new Uint8Array(arr.length * 2);
    const dv = new DataView(out.buffer);
    arr.forEach((v, i) => dv.setUint16(i * 2, v, true));
    return out;
  }
  if (vr === 'UL') {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value as number, true);
    return out;
  }
  if (vr === 'OB' || vr === 'OW') {
    const bytes = value as Uint8Array;
    if (bytes.length % 2 === 0) return bytes;
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    return padded;
  }
  // string VRs; multi-values joined by backslash. UI pads with NUL, others with space.
  const s = Array.isArray(value) ? value.join('\\') : String(value);
  const bytes = new TextEncoder().encode(s);
  if (bytes.length % 2 === 0) return bytes;
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  padded[bytes.length] = vr === 'UI' ? 0x00 : 0x20;
  return padded;
}

function encodeElement(el: Element, explicit: boolean): Uint8Array {
  const val = encodeValue(el);
  const group = el.tag >>> 16;
  const elem = el.tag & 0xffff;
  let header: Uint8Array;
  if (explicit) {
    if (LONG_VRS.has(el.vr)) {
      header = new Uint8Array(12);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, group, true);
      dv.setUint16(2, elem, true);
      header[4] = el.vr.charCodeAt(0);
      header[5] = el.vr.charCodeAt(1);
      dv.setUint32(8, val.length, true);
    } else {
      header = new Uint8Array(8);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, group, true);
      dv.setUint16(2, elem, true);
      header[4] = el.vr.charCodeAt(0);
      header[5] = el.vr.charCodeAt(1);
      dv.setUint16(6, val.length, true);
    }
  } else {
    header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    dv.setUint16(0, group, true);
    dv.setUint16(2, elem, true);
    dv.setUint32(4, val.length, true);
  }
  const out = new Uint8Array(header.length + val.length);
  out.set(header);
  out.set(val, header.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Writes preamble + "DICM" + file meta group (always explicit LE) + dataset in the given transfer syntax. */
export function writePart10(dataset: Element[], meta: { sopClassUID: string; sopInstanceUID: string; transferSyntax: string }): Uint8Array {
  const metaEls: Element[] = [
    { tag: 0x00020001, vr: 'OB', value: new Uint8Array([0, 1]) },
    { tag: 0x00020002, vr: 'UI', value: meta.sopClassUID },
    { tag: 0x00020003, vr: 'UI', value: meta.sopInstanceUID },
    { tag: 0x00020010, vr: 'UI', value: meta.transferSyntax },
    { tag: 0x00020012, vr: 'UI', value: '1.2.826.0.1.3680043.10.1001.1' },
  ];
  const metaBody = concat(metaEls.map((e) => encodeElement(e, true)));
  const groupLen = encodeElement({ tag: 0x00020000, vr: 'UL', value: metaBody.length }, true);
  const explicit = meta.transferSyntax === TS_EXPLICIT_LE;
  const sorted = [...dataset].sort((a, b) => a.tag - b.tag);
  const body = concat(sorted.map((e) => encodeElement(e, explicit)));
  const preamble = new Uint8Array(128);
  const magic = new TextEncoder().encode('DICM');
  return concat([preamble, magic, groupLen, metaBody, body]);
}

/** Format a number as a DICOM Decimal String (max 16 chars). */
export function ds(v: number): string {
  if (Object.is(v, -0) || Math.abs(v) < 1e-12) return '0';
  let s = String(Number(v.toPrecision(10)));
  if (s.length > 16) s = v.toExponential(8);
  return s;
}
