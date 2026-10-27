import { parseSlice, type ParsedSlice } from './parse';
import { buildVolume, type Volume } from './volume';

export interface InputFile {
  name: string;
  bytes: ArrayBuffer | Uint8Array;
}

/** Parse every file independently (one bad file must not sink the series), then build. */
export function loadSeries(files: InputFile[]): Volume {
  const slices: ParsedSlice[] = [];
  const ignored: { fileName: string; reason: string }[] = [];
  for (const f of files) {
    try {
      slices.push(parseSlice(f.bytes, f.name));
    } catch (e) {
      ignored.push({ fileName: f.name, reason: (e as Error).message ?? String(e) });
    }
  }
  if (slices.length === 0) {
    const why = ignored.slice(0, 3).map((i) => `${i.fileName}: ${i.reason}`).join('; ');
    throw new Error(`No usable DICOM image in ${files.length} file(s). ${why}`);
  }
  return buildVolume(slices, ignored);
}
