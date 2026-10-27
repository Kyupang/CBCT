/**
 * After the device says "done": trust only what is actually in storage.
 *
 * 1. Every manifest file must exist with the declared size, and its SHA-256 must match.
 *    A mismatch (truncated / corrupted upload) deletes that object and sends the study back
 *    to 'uploading' so the device re-sends exactly those files.
 * 2. Parse with the same loader the viewer uses (series selection, IPP·n sorting, HU).
 * 3. Store the voxel grid at full and 1/8 size (gzip) + geometry JSON. No patient tags.
 *
 * Runs inline here; in AWS this is a queue (SQS) + worker so the API never blocks.
 */
import { gzipSync } from 'node:zlib';
import { sha256hex } from './auth';
import { now, type Db } from './db';
import { keys, type Storage } from './storage';
import { loadSeries } from '../src/dicom/load';
import { downsample, type LevelInfo, type VolumeMeta } from '../src/cloud/volumeFormat';

export interface UploadState {
  expected: number;
  present: string[];
  missing: string[];
  /** in storage but with a different size than declared (e.g. a cut-off PUT) */
  wrongSize: string[];
}

export async function uploadState(db: Db, storage: Storage, clinic: string, study: string): Promise<UploadState> {
  const files = db.prepare('SELECT path, size FROM study_files WHERE study_id = ?').all(study) as { path: string; size: number }[];
  const prefix = keys.raw(clinic, study);
  const have = new Map((await storage.list(prefix)).map((o) => [o.key.slice(prefix.length), o.size]));
  const present: string[] = [];
  const missing: string[] = [];
  const wrongSize: string[] = [];
  for (const f of files) {
    const s = have.get(f.path);
    if (s === undefined) missing.push(f.path);
    else if (s !== f.size) wrongSize.push(f.path);
    else present.push(f.path);
  }
  return { expected: files.length, present, missing, wrongSize };
}

export type ProcessResult =
  | { ok: true; meta: VolumeMeta; ms: number }
  | { ok: false; reason: 'incomplete' | 'checksum' | 'unreadable'; files?: string[]; message: string };

export async function processStudy(db: Db, storage: Storage, clinic: string, study: string): Promise<ProcessResult> {
  const t0 = performance.now();
  const st = await uploadState(db, storage, clinic, study);
  if (st.missing.length || st.wrongSize.length) {
    for (const p of st.wrongSize) await storage.remove(keys.raw(clinic, study, p));
    return { ok: false, reason: 'incomplete', files: [...st.missing, ...st.wrongSize], message: `${st.missing.length} missing, ${st.wrongSize.length} wrong size` };
  }
  db.prepare("UPDATE studies SET status = 'processing', error = NULL WHERE id = ?").run(study);

  const manifest = db.prepare('SELECT path, sha256 FROM study_files WHERE study_id = ?').all(study) as { path: string; sha256: string }[];
  const files: { name: string; bytes: Uint8Array }[] = [];
  const bad: string[] = [];
  for (const f of manifest) {
    const bytes = await storage.get(keys.raw(clinic, study, f.path));
    if (sha256hex(bytes) !== f.sha256) bad.push(f.path);
    else files.push({ name: f.path, bytes });
  }
  if (bad.length) {
    for (const p of bad) await storage.remove(keys.raw(clinic, study, p));
    db.prepare("UPDATE studies SET status = 'uploading', error = ? WHERE id = ?").run(`checksum mismatch: ${bad.length} file(s), re-upload`, study);
    return { ok: false, reason: 'checksum', files: bad, message: `${bad.length} file(s) failed SHA-256 — deleted, re-upload them` };
  }
  db.prepare('UPDATE study_files SET verified = 1 WHERE study_id = ?').run(study);

  let vol;
  try {
    vol = loadSeries(files);
  } catch (e) {
    const message = (e as Error).message;
    db.prepare("UPDATE studies SET status = 'failed', error = ? WHERE id = ?").run(message, study);
    return { ok: false, reason: 'unreadable', message };
  }

  const dtype = vol.data instanceof Int16Array ? 'int16' : 'float32';
  const levels: LevelInfo[] = [];
  const put = async (level: number, factor: number, g: { dims: [number, number, number]; spacing: [number, number, number]; origin: [number, number, number]; data: Int16Array | Float32Array }) => {
    const raw = new Uint8Array(g.data.buffer, g.data.byteOffset, g.data.byteLength);
    const gz = gzipSync(raw, { level: 6 });
    await storage.put(keys.derived(clinic, study, `level${level}.bin.gz`), gz, { contentType: 'application/octet-stream' });
    levels.push({ level, factor, dims: g.dims, spacing: g.spacing, origin: g.origin, dtype, bytes: gz.byteLength });
  };
  await put(1, 2, downsample(vol, 2));
  await put(0, 1, { dims: vol.dims, spacing: vol.spacing, origin: vol.origin, data: vol.data });
  levels.sort((a, b) => b.level - a.level); // coarse first: that is the order a viewer fetches

  const meta: VolumeMeta = {
    format: 'dwv-volume/1',
    rowDir: vol.rowDir,
    colDir: vol.colDir,
    normal: vol.normal,
    min: vol.min,
    max: vol.max,
    modality: vol.modality,
    defaultWindow: vol.defaultWindow,
    levels,
    source: {
      sliceCount: vol.report.sliceCount,
      fileCount: manifest.length,
      warnings: vol.report.warnings,
      notes: vol.report.notes,
      otherSeries: vol.report.otherSeries.map((o) => ({ role: o.role, count: o.count })),
    },
  };
  await storage.put(keys.derived(clinic, study, 'meta.json'), JSON.stringify(meta), { contentType: 'application/json' });
  db.prepare("UPDATE studies SET status = 'ready', ready_at = ? WHERE id = ?").run(now(), study);
  return { ok: true, meta, ms: performance.now() - t0 };
}
