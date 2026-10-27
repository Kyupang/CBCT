/**
 * SQLite schema (node:sqlite). The same tables map 1:1 to PostgreSQL/RDS.
 *
 *   clinics ─< users
 *   clinics ─< studies ─< study_files      (upload manifest: what the device said it would send)
 *                      ─< annotations      (points in LPS mm, from desktop or web)
 *                      ─< shares           (expiring read-only links; only a hash is stored)
 *   audit                                  (who opened / uploaded / shared what, when)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      clinic_id TEXT NOT NULL REFERENCES clinics(id),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('dentist', 'staff', 'device'))
    );
    CREATE TABLE IF NOT EXISTS studies (
      id TEXT PRIMARY KEY,
      clinic_id TEXT NOT NULL REFERENCES clinics(id),
      patient_ref TEXT NOT NULL,          -- clinic's own pseudonymous key, not a name
      status TEXT NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
      error TEXT,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      ready_at TEXT
    );
    CREATE TABLE IF NOT EXISTS study_files (
      study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (study_id, path)
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      lps TEXT NOT NULL,                  -- JSON [x, y, z] in mm, DICOM patient space
      source TEXT NOT NULL CHECK (source IN ('desktop', 'web')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      token_hash TEXT PRIMARY KEY,
      study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,                -- user id, or 'share:<hash prefix>'
      action TEXT NOT NULL,
      study_id TEXT,
      detail TEXT
    );
  `);
  return db;
}

export const now = () => new Date().toISOString();

export function audit(db: Db, actor: string, action: string, studyId?: string, detail?: string) {
  db.prepare('INSERT INTO audit (at, actor, action, study_id, detail) VALUES (?, ?, ?, ?, ?)').run(now(), actor, action, studyId ?? null, detail ?? null);
}
