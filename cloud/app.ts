/**
 * REST API. Permission rules, in one place:
 *
 * - Every /api route except /api/login and /api/share/* needs `Authorization: Bearer <jwt>`.
 * - A study is visible only to users of the clinic that owns it. Another clinic's study id
 *   answers 404, not 403, so ids cannot be probed.
 * - Storage is never public: the API hands out presigned URLs for one object, minutes long.
 * - Share links are read-only, expire (max 72 h), can be revoked, and are audited.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { checkPassword, newShareToken, sha256hex, signJwt, verifyJwt, type Claims } from './auth';
import { audit, now, type Db } from './db';
import { processStudy, uploadState } from './process';
import { keys, safeRelPath, type Storage } from './storage';
import type { VolumeMeta } from '../src/cloud/volumeFormat';

export interface AppDeps {
  db: Db;
  storage: Storage;
  jwtSecret: string;
  accessTokenSec: number;
  uploadUrlSec: number;
  downloadUrlSec: number;
  webOrigin: string;
}

interface StudyRow {
  id: string;
  clinic_id: string;
  patient_ref: string;
  status: string;
  error: string | null;
  file_count: number;
  total_bytes: number;
  created_at: string;
  ready_at: string | null;
}

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_SHARE_HOURS = 72;

export function buildApp(d: AppDeps) {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  const { db, storage } = d;

  // CORS for the viewer origin only (no wildcard: the API takes credentials)
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin === d.webOrigin) {
      reply.header('Access-Control-Allow-Origin', d.webOrigin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  const claimsOf = (req: FastifyRequest): Claims | undefined => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? verifyJwt(h.slice(7), d.jwtSecret) : undefined;
  };
  const requireUser = (req: FastifyRequest, reply: FastifyReply): Claims | undefined => {
    const c = claimsOf(req);
    if (!c) reply.code(401).send({ error: 'login required' });
    return c;
  };
  const studyFor = (c: Claims, id: string, reply: FastifyReply): StudyRow | undefined => {
    const s = db.prepare('SELECT * FROM studies WHERE id = ?').get(id) as StudyRow | undefined;
    if (!s || s.clinic_id !== c.clinic) {
      reply.code(404).send({ error: 'study not found' });
      return undefined;
    }
    return s;
  };
  const volumeResponse = async (s: StudyRow) => {
    const meta = JSON.parse(new TextDecoder().decode(await storage.get(keys.derived(s.clinic_id, s.id, 'meta.json')))) as VolumeMeta;
    const urls = await Promise.all(meta.levels.map((l) => storage.presignGet(keys.derived(s.clinic_id, s.id, `level${l.level}.bin.gz`), d.downloadUrlSec)));
    const annotations = db.prepare('SELECT id, label, lps, source, created_at FROM annotations WHERE study_id = ? ORDER BY id').all(s.id) as { lps: string }[];
    return {
      study: { id: s.id, patientRef: s.patient_ref, readyAt: s.ready_at },
      meta,
      levels: meta.levels.map((l, q) => ({ ...l, url: urls[q] })),
      urlExpiresSec: d.downloadUrlSec,
      annotations: annotations.map((a) => ({ ...a, lps: JSON.parse(a.lps) })),
    };
  };

  app.post('/api/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '')) as
      | { id: string; clinic_id: string; role: Claims['role']; password_hash: string }
      | undefined;
    if (!u || !checkPassword(String(password ?? ''), u.password_hash)) {
      audit(db, `email:${String(email ?? '').slice(0, 64)}`, 'login-failed');
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    audit(db, u.id, 'login');
    return { token: signJwt({ sub: u.id, clinic: u.clinic_id, role: u.role }, d.jwtSecret, d.accessTokenSec), expiresInSec: d.accessTokenSec, role: u.role, clinic: u.clinic_id };
  });

  // --- upload (device PC or staff) --------------------------------------------------------
  app.post('/api/studies', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const { patientRef, files } = (req.body ?? {}) as { patientRef?: string; files?: { path: string; size: number; sha256: string }[] };
    if (!patientRef || !/^[A-Za-z0-9_-]{1,64}$/.test(patientRef)) return reply.code(400).send({ error: 'patientRef: 1-64 of [A-Za-z0-9_-] (a pseudonymous key, not a name)' });
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return reply.code(400).send({ error: `files: 1-${MAX_FILES} entries` });
    const seen = new Set<string>();
    for (const f of files) {
      const p = safeRelPath(String(f?.path ?? ''));
      if (!p) return reply.code(400).send({ error: `unsafe path: ${String(f?.path).slice(0, 80)}` });
      if (seen.has(p)) return reply.code(400).send({ error: `duplicate path: ${p}` });
      if (!Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_FILE_BYTES) return reply.code(400).send({ error: `bad size: ${p}` });
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) return reply.code(400).send({ error: `bad sha256: ${p}` });
      seen.add(p);
      f.path = p;
    }
    const id = randomUUID();
    const total = files.reduce((s, f) => s + f.size, 0);
    db.exec('BEGIN');
    try {
      db.prepare("INSERT INTO studies (id, clinic_id, patient_ref, status, file_count, total_bytes, created_by, created_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?)").run(
        id, c.clinic, patientRef, files.length, total, c.sub, now(), // prettier-ignore
      );
      const ins = db.prepare('INSERT INTO study_files (study_id, path, size, sha256) VALUES (?, ?, ?, ?)');
      for (const f of files) ins.run(id, f.path, f.size, f.sha256);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    audit(db, c.sub, 'study-create', id, `${files.length} files, ${total} bytes`);
    return reply.code(201).send({ id });
  });

  /** Presigned PUTs for the files storage does not have yet — the resume point after a cut. */
  app.post('/api/studies/:id/upload-urls', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    if (s.status !== 'uploading') return reply.code(409).send({ error: `study is ${s.status}` });
    const { limit = 200 } = (req.body ?? {}) as { limit?: number };
    const st = await uploadState(db, storage, s.clinic_id, s.id);
    const todo = [...st.missing, ...st.wrongSize].slice(0, Math.min(1000, Math.max(1, limit)));
    const urls = await Promise.all(todo.map(async (p) => ({ path: p, url: await storage.presignPut(keys.raw(s.clinic_id, s.id, p), d.uploadUrlSec) })));
    return { expected: st.expected, present: st.present.length, remaining: st.missing.length + st.wrongSize.length, expiresInSec: d.uploadUrlSec, urls };
  });

  app.post('/api/studies/:id/complete', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    if (s.status === 'ready') return { status: 'ready' };
    const r = await processStudy(db, storage, s.clinic_id, s.id);
    audit(db, c.sub, r.ok ? 'study-ready' : `study-${r.reason}`, s.id, r.ok ? `${r.ms.toFixed(0)} ms` : r.message);
    if (!r.ok) return reply.code(r.reason === 'unreadable' ? 422 : 409).send({ status: r.reason, message: r.message, files: r.files });
    return { status: 'ready', ms: Math.round(r.ms), levels: r.meta.levels.map(({ level, dims, bytes }) => ({ level, dims, bytes })) };
  });

  // --- viewing ----------------------------------------------------------------------------
  app.get('/api/studies', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    return db.prepare('SELECT id, patient_ref, status, error, file_count, total_bytes, created_at, ready_at FROM studies WHERE clinic_id = ? ORDER BY created_at DESC').all(c.clinic);
  });

  app.get('/api/studies/:id', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    const st = s.status === 'uploading' ? await uploadState(db, storage, s.clinic_id, s.id) : undefined;
    return { ...s, upload: st && { expected: st.expected, present: st.present.length, missing: st.missing.length, wrongSize: st.wrongSize.length } };
  });

  app.get('/api/studies/:id/volume', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    if (s.status !== 'ready') return reply.code(409).send({ error: `study is ${s.status}` });
    audit(db, c.sub, 'view', s.id);
    return volumeResponse(s);
  });

  // --- annotations: points in LPS mm, from the desktop viewer or the web ----------------
  app.post('/api/studies/:id/annotations', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    const { label, lps, source } = (req.body ?? {}) as { label?: string; lps?: number[]; source?: string };
    if (!Array.isArray(lps) || lps.length !== 3 || !lps.every(Number.isFinite)) return reply.code(400).send({ error: 'lps: [x, y, z] in mm (DICOM LPS)' });
    if (source !== 'desktop' && source !== 'web') return reply.code(400).send({ error: "source: 'desktop' | 'web'" });
    const r = db.prepare('INSERT INTO annotations (study_id, label, lps, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      s.id, String(label ?? '').slice(0, 80), JSON.stringify(lps), source, c.sub, now(), // prettier-ignore
    );
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  // --- sharing ----------------------------------------------------------------------------
  app.post('/api/studies/:id/shares', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    if (c.role !== 'dentist') return reply.code(403).send({ error: 'only a dentist can share' });
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    const hours = Math.min(MAX_SHARE_HOURS, Math.max(1, Number((req.body as { hours?: number } | undefined)?.hours ?? 24)));
    const token = newShareToken();
    const expires = new Date(Date.now() + hours * 3600e3).toISOString();
    db.prepare('INSERT INTO shares (token_hash, study_id, created_by, expires_at) VALUES (?, ?, ?, ?)').run(sha256hex(token), s.id, c.sub, expires);
    audit(db, c.sub, 'share-create', s.id, `expires ${expires}`);
    return reply.code(201).send({ token, expiresAt: expires });
  });

  app.delete('/api/studies/:id/shares', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    const r = db.prepare('UPDATE shares SET revoked = 1 WHERE study_id = ? AND revoked = 0').run(s.id);
    audit(db, c.sub, 'share-revoke', s.id, `${r.changes} link(s)`);
    return { revoked: r.changes };
  });

  app.get('/api/share/:token', async (req, reply) => {
    const hash = sha256hex((req.params as { token: string }).token);
    const sh = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(hash) as { study_id: string; expires_at: string; revoked: number } | undefined;
    if (!sh) return reply.code(404).send({ error: 'unknown link' });
    if (sh.revoked) return reply.code(410).send({ error: 'link revoked' });
    if (sh.expires_at <= now()) return reply.code(410).send({ error: 'link expired' });
    const s = db.prepare('SELECT * FROM studies WHERE id = ?').get(sh.study_id) as unknown as StudyRow;
    audit(db, `share:${hash.slice(0, 12)}`, 'view-shared', s.id);
    return { ...(await volumeResponse(s)), readOnly: true, expiresAt: sh.expires_at };
  });

  app.get('/api/studies/:id/audit', async (req, reply) => {
    const c = requireUser(req, reply);
    if (!c) return;
    if (c.role !== 'dentist') return reply.code(403).send({ error: 'dentist only' });
    const s = studyFor(c, (req.params as { id: string }).id, reply);
    if (!s) return;
    return db.prepare('SELECT at, actor, action, detail FROM audit WHERE study_id = ? ORDER BY id').all(s.id);
  });

  return app;
}
