/** Local development settings. In AWS these come from the environment / Secrets Manager. */
export const config = {
  apiPort: Number(process.env.API_PORT ?? 5191),
  /** origin allowed to call the API from a browser (the Vite dev server) */
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5190',
  dbPath: process.env.DB_PATH ?? '.data/cloud.db',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  /** access token lifetime; short so a leaked token is not a long-lived key */
  accessTokenSec: 15 * 60,
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'dicom',
    accessKeyId: process.env.S3_KEY ?? 'devkey',
    secretAccessKey: process.env.S3_SECRET ?? 'devsecret',
  },
  /** presigned URL lifetimes (seconds) */
  uploadUrlSec: 15 * 60,
  downloadUrlSec: 5 * 60,
};
