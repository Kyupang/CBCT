/**
 * DICOM linear VOI LUT (PS3.3 C.11.2.1.2.1):
 *   if (x <= c - 0.5 - (w-1)/2)      y = ymin
 *   else if (x > c - 0.5 + (w-1)/2)  y = ymax
 *   else y = ((x - (c - 0.5)) / (w-1) + 0.5) * (ymax - ymin) + ymin
 */
export function windowLinear(x: number, center: number, width: number, ymin = 0, ymax = 255): number {
  const w = Math.max(width, 1);
  const lo = center - 0.5 - (w - 1) / 2;
  const hi = center - 0.5 + (w - 1) / 2;
  if (x <= lo) return ymin;
  if (x > hi) return ymax;
  return ((x - (center - 0.5)) / (w - 1 || 1) + 0.5) * (ymax - ymin) + ymin;
}

export interface WindowPreset {
  name: string;
  center: number;
  width: number;
}

export const WINDOW_PRESETS: WindowPreset[] = [
  { name: '뼈 (Bone)', center: 500, width: 2000 },
  { name: '연조직 (Soft)', center: 40, width: 400 },
  { name: '폐 (Lung)', center: -600, width: 1500 },
  { name: '치아/CBCT', center: 1000, width: 4000 },
];

/** 8-bit lookup for integer inputs in [min, max] — avoids per-pixel branching in the MPR loop. */
export function buildWindowLut(min: number, max: number, center: number, width: number): { lut: Uint8Array; offset: number } {
  const lo = Math.floor(min);
  const n = Math.max(1, Math.ceil(max) - lo + 1);
  const lut = new Uint8Array(n);
  for (let i = 0; i < n; i++) lut[i] = Math.round(windowLinear(lo + i, center, width));
  return { lut, offset: -lo };
}
