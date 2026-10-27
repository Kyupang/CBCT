/**
 * Browser side of the cloud API: log in, list studies, and open one progressively —
 * the 1/8-size level first (seconds on a slow line), then full resolution.
 */
import type { Volume } from '../dicom/volume';
import type { Vec3 } from '../dicom/vec';
import { volumeFromLevel, type LevelInfo, type VolumeMeta } from './volumeFormat';

export const API = (import.meta.env?.VITE_API as string | undefined) ?? 'http://127.0.0.1:5191';

export interface StudyRow {
  id: string;
  patient_ref: string;
  status: string;
  file_count: number;
  total_bytes: number;
  created_at: string;
}

export interface Annotation {
  id: number;
  label: string;
  lps: Vec3;
  source: 'desktop' | 'web';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `HTTP ${r.status}`);
  return body;
}

export const login = (email: string, password: string) =>
  call<{ token: string; role: string; clinic: string; expiresInSec: number }>('/api/login', undefined, { method: 'POST', body: JSON.stringify({ email, password }) });
export const listStudies = (token: string) => call<StudyRow[]>('/api/studies', token);
export const addAnnotation = (token: string, id: string, label: string, lps: Vec3) =>
  call<{ id: number }>(`/api/studies/${id}/annotations`, token, { method: 'POST', body: JSON.stringify({ label, lps, source: 'web' }) });

export interface LevelLoaded {
  vol: Volume;
  level: LevelInfo;
  /** ms since openStudy started */
  atMs: number;
  /** compressed bytes fetched for this level */
  bytes: number;
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Fetch levels coarse → fine and hand each to `onLevel` as soon as it is decoded.
 * `maxLevelFactor`: stop before levels finer than this (low-spec mode keeps only 1/2 per axis).
 */
export async function openStudy(
  token: string | undefined,
  idOrShare: { id: string } | { share: string },
  onLevel: (l: LevelLoaded) => void,
  opts: { fullResolution: boolean } = { fullResolution: true },
): Promise<{ meta: VolumeMeta; annotations: Annotation[] }> {
  const t0 = performance.now();
  const path = 'id' in idOrShare ? `/api/studies/${idOrShare.id}/volume` : `/api/share/${idOrShare.share}`;
  const v = await call<{ meta: VolumeMeta; levels: (LevelInfo & { url: string })[]; annotations: Annotation[]; study: { patientRef: string } }>(path, token);
  const levels = [...v.levels].sort((a, b) => b.factor - a.factor).filter((l) => opts.fullResolution || l.factor > 1 || v.levels.length === 1);
  for (const l of levels) {
    const r = await fetch(l.url);
    if (!r.ok) throw new ApiError(r.status, `level ${l.level}: storage answered ${r.status} (link expired?)`);
    const gz = await r.arrayBuffer();
    const vol = volumeFromLevel(v.meta, l, await gunzip(gz), `${v.study.patientRef}`);
    onLevel({ vol, level: l, atMs: performance.now() - t0, bytes: gz.byteLength });
  }
  return { meta: v.meta, annotations: v.annotations };
}

/** What this browser can do, read once: decides 3D on/off and whether to fetch full resolution. */
export function deviceCaps() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const max3d = gl ? (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number) : 0;
  const renderer = gl ? String(gl.getParameter((gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) as number)) : 'none';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  const memGB = (navigator as { deviceMemory?: number }).deviceMemory;
  return { webgl2: !!gl, max3d, renderer, memGB, cores: navigator.hardwareConcurrency };
}
