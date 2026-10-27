/**
 * Demo accounts: two clinics, so the permission rules have someone to keep out.
 *   dentist@a.test / dentist-a     clinic A, can share and read the audit log
 *   device@a.test  / device-a      clinic A, the CBCT PC's upload agent
 *   dentist@b.test / dentist-b     clinic B
 */
import { hashPassword } from './auth';
import type { Db } from './db';

export function seed(db: Db) {
  db.prepare('INSERT OR IGNORE INTO clinics (id, name) VALUES (?, ?)').run('clinic-a', 'A치과');
  db.prepare('INSERT OR IGNORE INTO clinics (id, name) VALUES (?, ?)').run('clinic-b', 'B치과');
  const user = db.prepare('INSERT OR IGNORE INTO users (id, clinic_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  user.run('u-dentist-a', 'clinic-a', 'dentist@a.test', hashPassword('dentist-a'), 'dentist');
  user.run('u-device-a', 'clinic-a', 'device@a.test', hashPassword('device-a'), 'device');
  user.run('u-dentist-b', 'clinic-b', 'dentist@b.test', hashPassword('dentist-b'), 'dentist');
}
