/**
 * Passwords: scrypt with a per-user salt. Access tokens: HS256 JWT built on node:crypto
 * (header.payload.signature), short-lived. Share links: 32 random bytes; only the SHA-256
 * of the token is stored, so a database leak does not leak working links.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64url')}:${scryptSync(pw, salt, 32).toString('base64url')}`;
}

export function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  const a = scryptSync(pw, Buffer.from(salt, 'base64url'), 32);
  const b = Buffer.from(hash, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Claims {
  sub: string; // user id
  clinic: string;
  role: 'dentist' | 'staff' | 'device';
  exp: number; // unix seconds
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signJwt(claims: Omit<Claims, 'exp'>, secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...claims, exp: nowSec + ttlSec });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Claims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [head, body, sig] = parts;
  const want = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    if (JSON.parse(Buffer.from(head, 'base64url').toString()).alg !== 'HS256') return undefined;
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
    return typeof c.exp === 'number' && c.exp > nowSec ? c : undefined;
  } catch {
    return undefined;
  }
}

export const newShareToken = () => randomBytes(32).toString('base64url');
export const sha256hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
