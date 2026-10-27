/**
 * Cloud API: upload resume, integrity, permissions, and "does the desktop's point land on the
 * same anatomy on the web". Runs against an in-memory storage double; the same API runs on
 * S3 in `npm run api` (presigned-URL expiry is checked there, see docs/CLOUD-LOG.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../cloud/app';
import { signJwt, verifyJwt } from '../cloud/auth';
import { openDb } from '../cloud/db';
import { seed } from '../cloud/seed';
import { keys, memoryStorage, s3Storage, safeRelPath } from '../cloud/storage';
import { downsample, volumeFromLevel, type VolumeMeta } from '../src/cloud/volumeFormat';
import { patientToVoxel, sampleNearest, voxelToPatient } from '../src/dicom/volume';
import { generatePhantom } from '../src/phantom/phantom';
import type { Vec3 } from '../src/dicom/vec';

const SECRET = 'test-secret';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function setup() {
  const db = openDb(':memory:');
  seed(db);
  const storage = memoryStorage();
  const app = buildApp({ db, storage, jwtSecret: SECRET, accessTokenSec: 900, uploadUrlSec: 900, downloadUrlSec: 300, webOrigin: 'http://localhost:5190' });
  const login = async (email: string, password: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    return (r.json() as { token: string }).token;
  };
  const as = (token?: string) => (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { db, storage, app, login, as };
}

/** A small real DICOM series (the synthetic phantom), as an upload would see it */
function phantomFiles() {
  const { files } = generatePhantom({ cols: 48, rows: 40, slices: 24 });
  return files.map((f) => ({ path: `series/${f.name}`, bytes: f.bytes }));
}

describe('auth tokens', () => {
  it('rejects tampered, expired and wrong-key tokens', () => {
    const t = signJwt({ sub: 'u', clinic: 'c', role: 'dentist' }, SECRET, 60, 1000);
    expect(verifyJwt(t, SECRET, 1001)?.clinic).toBe('c');
    expect(verifyJwt(t, SECRET, 1061)).toBeUndefined(); // expired
    expect(verifyJwt(t, 'other', 1001)).toBeUndefined();
    const [h, b, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u', clinic: 'other-clinic', role: 'dentist', exp: 9e9 })).toString('base64url');
    expect(verifyJwt(`${h}.${forged}.${s}`, SECRET, 1001)).toBeUndefined();
    expect(verifyJwt(`${h}.${b}`, SECRET, 1001)).toBeUndefined();
  });

  it('presigned PUT URLs carry no precomputed checksum (a browser PUT of the real bytes would get 400)', async () => {
    // AWS SDK v3 adds x-amz-checksum-crc32 (of an empty body) by default — seen as HTTP 400 on SeaweedFS (CLOUD-LOG C1)
    const st = s3Storage({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' });
    const q = new URL(await st.presignPut('raw/a/b/c.dcm', 60)).searchParams;
    expect([...q.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(q.get('X-Amz-Expires')).toBe('60');
  });

  it('manifest paths cannot escape the study prefix', () => {
    expect(safeRelPath('a/b.dcm')).toBe('a/b.dcm');
    expect(safeRelPath('a\\b.dcm')).toBe('a/b.dcm');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a//b', './a', 'a\u0000b', '']) expect(safeRelPath(bad)).toBeUndefined();
  });
});

describe('upload: cut connection and corrupted files', () => {
  let t: ReturnType<typeof setup>;
  let device: string;
  const files = phantomFiles();
  const manifest = files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha(f.bytes) }));
  beforeEach(async () => {
    t = setup();
    device = await t.login('device@a.test', 'device-a');
  });

  it('after a cut, only the files storage does not have are handed out again', async () => {
    const { id } = (await t.as(device)('POST', '/api/studies', { patientRef: 'P1', files: manifest })).json() as { id: string };
    const first = (await t.as(device)('POST', `/api/studies/${id}/upload-urls`)).json() as { remaining: number; urls: { path: string }[] };
    expect(first.remaining).toBe(files.length);
    // "upload" 10 files, then the connection dies; one PUT was cut half way
    for (const f of files.slice(0, 10)) await t.storage.put(keys.raw('clinic-a', id, f.path), f.bytes);
    await t.storage.put(keys.raw('clinic-a', id, files[10].path), files[10].bytes.slice(0, 100));
    const again = (await t.as(device)('POST', `/api/studies/${id}/upload-urls`)).json() as { present: number; remaining: number; urls: { path: string }[] };
    expect(again.present).toBe(10);
    expect(again.remaining).toBe(files.length - 10);
    expect(again.urls.map((u) => u.path)).toContain(files[10].path); // truncated one is resent
    expect(again.urls.map((u) => u.path)).not.toContain(files[0].path);
    // completing early is refused, with the list of what is missing
    const early = await t.as(device)('POST', `/api/studies/${id}/complete`);
    expect(early.statusCode).toBe(409);
  });

  it('a corrupted file (same size, wrong SHA-256) is deleted and asked for again', async () => {
    const { id } = (await t.as(device)('POST', '/api/studies', { patientRef: 'P1', files: manifest })).json() as { id: string };
    for (const f of files) await t.storage.put(keys.raw('clinic-a', id, f.path), f.bytes);
    const bad = Uint8Array.from(files[3].bytes);
    bad[bad.length - 1] ^= 0xff;
    await t.storage.put(keys.raw('clinic-a', id, files[3].path), bad);
    const c = await t.as(device)('POST', `/api/studies/${id}/complete`);
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ status: 'checksum', files: [files[3].path] });
    const st = (await t.as(device)('POST', `/api/studies/${id}/upload-urls`)).json() as { urls: { path: string }[] };
    expect(st.urls.map((u) => u.path)).toEqual([files[3].path]);
    await t.storage.put(keys.raw('clinic-a', id, files[3].path), files[3].bytes);
    const ok = await t.as(device)('POST', `/api/studies/${id}/complete`);
    expect(ok.statusCode).toBe(200);
    // derived data carries no patient tags
    const meta = new TextDecoder().decode(await t.storage.get(keys.derived('clinic-a', id, 'meta.json')));
    expect(meta).not.toMatch(/Phantom|PatientName|PatientID/i);
  });

  it('rejects manifests that would escape the study folder or lie about sizes', async () => {
    const r1 = await t.as(device)('POST', '/api/studies', { patientRef: 'P1', files: [{ path: '../other-study/x.dcm', size: 10, sha256: 'a'.repeat(64) }] });
    expect(r1.statusCode).toBe(400);
    const r2 = await t.as(device)('POST', '/api/studies', { patientRef: 'Kim Minsu', files: manifest });
    expect(r2.statusCode).toBe(400); // a name is not a pseudonymous key
  });
});

describe('permissions', () => {
  it('no token, another clinic, the wrong role, an expired or revoked link — all refused', async () => {
    const t = setup();
    const device = await t.login('device@a.test', 'device-a');
    const dentistA = await t.login('dentist@a.test', 'dentist-a');
    const dentistB = await t.login('dentist@b.test', 'dentist-b');
    const files = phantomFiles();
    const { id } = (await t.as(device)('POST', '/api/studies', { patientRef: 'P1', files: files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha(f.bytes) })) })).json() as { id: string };
    for (const f of files) await t.storage.put(keys.raw('clinic-a', id, f.path), f.bytes);
    expect((await t.as(device)('POST', `/api/studies/${id}/complete`)).statusCode).toBe(200);

    expect((await t.as()('GET', `/api/studies/${id}/volume`)).statusCode).toBe(401);
    expect((await t.as('garbage')('GET', `/api/studies`)).statusCode).toBe(401);
    expect((await t.as(dentistA)('GET', `/api/studies/${id}/volume`)).statusCode).toBe(200);
    // clinic B cannot see it, and cannot tell it exists
    expect((await t.as(dentistB)('GET', `/api/studies/${id}/volume`)).statusCode).toBe(404);
    expect((await t.as(dentistB)('GET', `/api/studies/does-not-exist/volume`)).statusCode).toBe(404);
    expect((await t.as(dentistB)('GET', '/api/studies')).json()).toEqual([]);
    expect((await t.as(dentistB)('POST', `/api/studies/${id}/annotations`, { label: 'x', lps: [0, 0, 0], source: 'web' })).statusCode).toBe(404);
    // the upload agent cannot share
    expect((await t.as(device)('POST', `/api/studies/${id}/shares`, { hours: 1 })).statusCode).toBe(403);

    const share = (await t.as(dentistA)('POST', `/api/studies/${id}/shares`, { hours: 1000 })).json() as { token: string; expiresAt: string };
    expect(new Date(share.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(72 * 3600e3 + 5000); // capped
    expect((await t.as()('GET', `/api/share/${share.token}`)).json()).toMatchObject({ readOnly: true });
    expect((await t.as()('GET', `/api/share/${share.token}x`)).statusCode).toBe(404);
    // the database keeps only a hash of the link
    expect(JSON.stringify(t.db.prepare('SELECT * FROM shares').all())).not.toContain(share.token);
    t.db.prepare("UPDATE shares SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await t.as()('GET', `/api/share/${share.token}`)).statusCode).toBe(410);
    const s2 = (await t.as(dentistA)('POST', `/api/studies/${id}/shares`, { hours: 1 })).json() as { token: string };
    await t.as(dentistA)('DELETE', `/api/studies/${id}/shares`);
    expect((await t.as()('GET', `/api/share/${s2.token}`)).statusCode).toBe(410);

    const log = (await t.as(dentistA)('GET', `/api/studies/${id}/audit`)).json() as { action: string }[];
    expect(log.map((a) => a.action)).toEqual(expect.arrayContaining(['study-create', 'study-ready', 'view', 'share-create', 'view-shared', 'share-revoke']));
  });
});

describe('coordinates survive the trip: desktop point → server → web, at every level', () => {
  it('downsampling moves the origin to the block centre (otherwise markers drift half a block)', () => {
    // value = 10 * (LPS x) at every voxel centre, on an oblique grid
    const dims: [number, number, number] = [32, 30, 20];
    const spacing: [number, number, number] = [0.4, 0.5, 0.7];
    const c = Math.cos(0.35), s = Math.sin(0.35); // prettier-ignore
    const geo = { dims, spacing, origin: [-5, 3, 7] as Vec3, rowDir: [c, s, 0] as Vec3, colDir: [-s * 0.8, c * 0.8, 0.6] as Vec3, normal: [0, 0, 0] as Vec3 };
    geo.normal = [geo.rowDir[1] * geo.colDir[2] - geo.rowDir[2] * geo.colDir[1], geo.rowDir[2] * geo.colDir[0] - geo.rowDir[0] * geo.colDir[2], geo.rowDir[0] * geo.colDir[1] - geo.rowDir[1] * geo.colDir[0]];
    const data = new Float32Array(dims[0] * dims[1] * dims[2]);
    const vol = { ...geo, data, min: 0, max: 0 } as never as Parameters<typeof voxelToPatient>[0];
    for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) data[i + dims[0] * (j + dims[1] * k)] = 10 * voxelToPatient(vol, i, j, k)[0];
    const d = downsample({ ...geo, data }, 2);
    const low = { ...vol, dims: d.dims, spacing: d.spacing, origin: d.origin, data: d.data };
    // linear field: a block average equals the value at the block centre — if the origin is right
    for (const [i, j, k] of [[0, 0, 0], [5, 7, 3], [15, 14, 9]] as Vec3[]) {
      expect(d.data[i + d.dims[0] * (j + d.dims[1] * k)]).toBeCloseTo(10 * voxelToPatient(low, i, j, k)[0], 3);
    }
    // and the naive origin (unchanged) would be off by half a block
    const naive = { ...low, origin: geo.origin };
    expect(Math.abs(d.data[0] - 10 * voxelToPatient(naive, 0, 0, 0)[0])).toBeGreaterThan(1);
  });

  const tf = path.resolve(import.meta.dirname, '../data/external/toothfairy');
  const has = fs.existsSync(path.join(tf, 'raw/P221')) && fs.existsSync(path.join(tf, 'P221.sitk.json'));
  it.skipIf(!has)('P221: points placed by ITK ("desktop") come back on the same voxel and value via the API', async () => {
    const t = setup();
    const device = await t.login('device@a.test', 'device-a');
    const dentist = await t.login('dentist@a.test', 'dentist-a');
    const dir = path.join(tf, 'raw/P221');
    const files = fs.readdirSync(dir).map((n) => ({ path: n, bytes: new Uint8Array(fs.readFileSync(path.join(dir, n))) }));
    const { id } = (await t.as(device)('POST', '/api/studies', { patientRef: 'P221', files: files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha(f.bytes) })) })).json() as { id: string };
    for (const f of files) await t.storage.put(keys.raw('clinic-a', id, f.path), f.bytes);
    expect((await t.as(device)('POST', `/api/studies/${id}/complete`)).statusCode).toBe(200);

    const ref = JSON.parse(fs.readFileSync(path.join(tf, 'P221.sitk.json'), 'utf8')) as { points: { ijk: Vec3; lps: Vec3; value: number }[] };
    const pts = ref.points.slice(0, 40);
    for (const [q, p] of pts.entries()) await t.as(dentist)('POST', `/api/studies/${id}/annotations`, { label: `itk-${q}`, lps: p.lps, source: 'desktop' });

    const v = (await t.as(dentist)('GET', `/api/studies/${id}/volume`)).json() as { meta: VolumeMeta; annotations: { label: string; lps: Vec3 }[] };
    const levels = Object.fromEntries(
      await Promise.all(v.meta.levels.map(async (l) => [l.level, volumeFromLevel(v.meta, l, gunzipSync(await t.storage.get(keys.derived('clinic-a', id, `level${l.level}.bin.gz`)))
        .buffer as ArrayBuffer, 'P221')] as const)),
    );
    for (const [q, a] of v.annotations.entries()) {
      const ijk0 = patientToVoxel(levels[0], a.lps);
      // same voxel as ITK, to 0.005 voxel: IOP is written to 6 decimals, so the two readers'
      // direction matrices differ in the 7th digit (~1e-4 voxel at the far edge)
      ijk0.forEach((x, ax) => expect(x).toBeCloseTo(pts[q].ijk[ax], 2));
      expect(sampleNearest(levels[0], ...ijk0)).toBe(pts[q].value); // same value
      // low-res level: the point falls in the block that contains that voxel
      const ijk1 = patientToVoxel(levels[1], a.lps);
      ijk1.forEach((x, ax) => expect(x).toBeCloseTo((pts[q].ijk[ax] - 0.5) / 2, 2));
    }
  });
});
