/**
 * Object storage behind one small interface: S3 (AWS, or SeaweedFS locally — same SDK, same
 * signatures) and an in-memory fake for tests.
 *
 * The bucket is private. Browsers and the device agent only ever get presigned URLs that
 * expire in minutes and name exactly one object.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface Storage {
  ensureBucket(): Promise<void>;
  presignPut(key: string, expiresSec: number): Promise<string>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string; contentEncoding?: string }): Promise<void>;
  remove(key: string): Promise<void>;
}

export function s3Storage(cfg: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }): Storage {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true, // SeaweedFS / local endpoints; harmless on AWS
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Newer SDKs add CRC32 checksum headers to presigned PUTs by default; a plain browser
    // PUT would then fail the signature. Only send checksums when an operation needs them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = cfg.bucket;
  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
    presignPut: (key, expiresIn) => getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key }), { expiresIn }),
    presignGet: (key, expiresIn) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn }),
    async list(prefix) {
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return r.Body!.transformToByteArray();
    },
    async put(key, body, opts = {}) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: opts.contentType, ContentEncoding: opts.contentEncoding }));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/** Test double: presigned URLs are `mem://` strings; tests write objects with put(). */
export function memoryStorage(): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const enc = (s: Uint8Array | string) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
  return {
    objects,
    async ensureBucket() {},
    presignPut: async (key, exp) => `mem://put/${key}?exp=${exp}`,
    presignGet: async (key, exp) => `mem://get/${key}?exp=${exp}`,
    list: async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.byteLength })),
    async get(key) {
      const v = objects.get(key);
      if (!v) throw new Error(`NoSuchKey ${key}`);
      return v;
    },
    async put(key, body) {
      objects.set(key, enc(body));
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

/**
 * File paths in an upload manifest come from the client. They become object keys, so they
 * must not escape the study prefix (`..`, absolute paths, backslashes, control characters).
 */
export function safeRelPath(p: string): string | undefined {
  const norm = p.replace(/\\/g, '/');
  if (!norm || norm.length > 255 || norm.startsWith('/') || /[\x00-\x1f]/.test(norm)) return undefined;
  const parts = norm.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  return parts.join('/');
}

export const keys = {
  raw: (clinic: string, study: string, rel = '') => `raw/${clinic}/${study}/${rel}`,
  derived: (clinic: string, study: string, name = '') => `derived/${clinic}/${study}/${name}`,
};
