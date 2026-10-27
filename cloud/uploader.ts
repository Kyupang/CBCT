/**
 * Upload agent for the CBCT PC. Resumable: a cut connection or a crash costs only the files
 * that were in flight.
 *
 *   npm run upload -- --dir <dicom folder> --patient P221 [--email device@a.test --password device-a]
 *
 * How resume works: the manifest (path, size, SHA-256 of every file) is registered first; the
 * server answers "which files are still missing" by listing storage, not by trusting the
 * client. The study id is kept in .data/uploads/<folder hash>.json so a restart continues it.
 *
 * Fault injection for the write-up:
 *   --cut-after N     exit hard after N successful PUTs (network cut / power loss)
 *   --corrupt N       send N files with one flipped byte (same size, wrong SHA-256)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const dir = arg('dir');
const patient = arg('patient');
if (!dir || !patient) {
  console.error('usage: --dir <folder> --patient <ref> [--email --password --api --concurrency --cut-after --corrupt --fresh]');
  process.exit(2);
}
const api = arg('api', `http://127.0.0.1:${config.apiPort}`)!;
const email = arg('email', 'device@a.test')!;
const password = arg('password', 'device-a')!;
const concurrency = Number(arg('concurrency', '4'));
const cutAfter = Number(arg('cut-after', '0'));
let corruptLeft = Number(arg('corrupt', '0'));

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

function walk(root: string, rel = ''): string[] {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? walk(root, r) : [r];
  });
}

let token = '';
async function login() {
  const r = await fetch(`${api}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  token = ((await r.json()) as { token: string }).token;
}
async function call<T>(method: string, url: string, body?: unknown, retried = false): Promise<{ status: number; json: T }> {
  const r = await fetch(`${api}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !retried) {
    await login(); // access tokens are short-lived; a long upload outlives one
    return call(method, url, body, true);
  }
  return { status: r.status, json: (await r.json()) as T };
}

/** PUT with retries and a timeout; exponential backoff 0.5 s, 1 s, 2 s, 4 s. */
async function put(url: string, body: Uint8Array): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(60_000) });
      if (r.ok) return;
      if (r.status === 403) throw Object.assign(new Error('presigned URL expired or rejected'), { fatal: true });
      throw new Error(`PUT ${r.status}`);
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || attempt >= 4) throw e;
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
}

const t0 = performance.now();
const files = walk(dir).sort();
log(`${files.length} files in ${dir} — hashing`);
const manifest = files.map((p) => {
  const bytes = fs.readFileSync(path.join(dir, p));
  return { path: p, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const total = manifest.reduce((s, f) => s + f.size, 0);

const stateFile = path.join('.data/uploads', `${createHash('sha256').update(path.resolve(dir) + patient).digest('hex').slice(0, 16)}.json`);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
await login();
let studyId: string | undefined = process.argv.includes('--fresh') || !fs.existsSync(stateFile) ? undefined : JSON.parse(fs.readFileSync(stateFile, 'utf8')).studyId;
if (studyId) {
  const r = await call<{ status: string }>('GET', `/api/studies/${studyId}`);
  if (r.status !== 200 || r.json.status === 'ready') studyId = undefined;
  else log(`resuming study ${studyId}`);
}
if (!studyId) {
  const r = await call<{ id: string; error?: string }>('POST', '/api/studies', { patientRef: patient, files: manifest });
  if (r.status !== 201) throw new Error(`create study: ${r.status} ${r.json.error}`);
  studyId = r.json.id;
  fs.writeFileSync(stateFile, JSON.stringify({ studyId, dir: path.resolve(dir), patient }));
  log(`study ${studyId} created (${(total / 1e6).toFixed(1)} MB)`);
}

let sent = 0;
let sentBytes = 0;
for (let round = 1; ; round++) {
  const r = await call<{ remaining: number; present: number; expected: number; urls: { path: string; url: string }[]; error?: string }>('POST', `/api/studies/${studyId}/upload-urls`, { limit: 200 });
  if (r.status !== 200) throw new Error(`upload-urls ${r.status} ${r.json.error}`);
  if (round === 1 || r.json.remaining === 0) log(`server has ${r.json.present}/${r.json.expected}, ${r.json.remaining} to send`);
  if (r.json.remaining === 0) {
    const c = await call<{ status: string; message?: string; files?: string[]; ms?: number }>('POST', `/api/studies/${studyId}/complete`);
    if (c.status === 200) {
      log(`complete: ${c.json.status} (server processing ${c.json.ms} ms) — total ${((performance.now() - t0) / 1000).toFixed(1)} s, sent ${sent} files this run`);
      fs.rmSync(stateFile);
      break;
    }
    log(`complete refused (${c.status}): ${c.json.message} → re-sending ${c.json.files?.length ?? 0} file(s)`);
    continue;
  }
  const queue = [...r.json.urls];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        let bytes = fs.readFileSync(path.join(dir, job.path));
        if (corruptLeft > 0) {
          corruptLeft--;
          bytes = Buffer.from(bytes);
          bytes[bytes.length - 1] ^= 0xff; // same size, different content
          log(`(fault injection) corrupting ${job.path}`);
        }
        await put(job.url, bytes);
        sent++;
        sentBytes += bytes.byteLength;
        if (sent % 50 === 0) log(`sent ${sent} files, ${(sentBytes / 1e6).toFixed(1)} MB`);
        if (cutAfter && sent >= cutAfter) {
          log(`(fault injection) connection cut after ${sent} files`);
          process.exit(3);
        }
      }
    }),
  );
}
