/** Starts the API against S3 (SeaweedFS locally: `npm run s3`). */
import { buildApp } from './app';
import { config } from './config';
import { openDb } from './db';
import { seed } from './seed';
import { s3Storage } from './storage';

const storage = s3Storage(config.s3);
await storage.ensureBucket();
const db = openDb(config.dbPath);
seed(db); // demo accounts (INSERT OR IGNORE)
const app = buildApp({ db, storage, ...config });
await app.listen({ port: config.apiPort, host: '127.0.0.1' });
console.log(`API http://127.0.0.1:${config.apiPort}  (S3 ${config.s3.endpoint}/${config.s3.bucket})`);
