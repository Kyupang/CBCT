import type { InputFile } from '../dicom/load';

/** Collect files from a drop, descending into folders (webkitGetAsEntry). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return [...dt.files];
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most ~100 entries per call; loop until empty
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

export async function readFiles(files: File[]): Promise<InputFile[]> {
  // skip obvious non-DICOM companions (DICOMDIR is an index, not an image)
  const keep = files.filter((f) => !/\.(txt|md|json|xml|jpg|png|html?)$/i.test(f.name) && f.name.toUpperCase() !== 'DICOMDIR');
  return Promise.all(keep.map(async (f) => ({ name: f.webkitRelativePath || f.name, bytes: await f.arrayBuffer() })));
}
