import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dev-only: serve downloaded public samples from data/external/<name>/raw so they are
 * never copied into public/ or the production bundle. GET /external/index.json lists them.
 * Files are served as opaque bytes (application/octet-stream); nothing in them is executed.
 */
function externalSamples(): Plugin {
  const root = path.resolve(__dirname, 'data/external');
  return {
    name: 'external-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/external', (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
        if (url === '/index.json') {
          const sets: Record<string, string[]> = {};
          if (fs.existsSync(root)) {
            for (const name of fs.readdirSync(root)) {
              const raw = path.join(root, name, 'raw');
              if (!fs.existsSync(raw)) continue;
              const files: string[] = [];
              const walk = (dir: string, rel: string) => {
                for (const f of fs.readdirSync(dir)) {
                  const p = path.join(dir, f);
                  if (fs.statSync(p).isDirectory()) walk(p, rel + f + '/');
                  else files.push(rel + f);
                }
              };
              walk(raw, '');
              sets[name] = files;
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(sets));
          return;
        }
        const [, name, ...rest] = url.split('/');
        const file = path.resolve(root, name ?? '', 'raw', ...rest);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), externalSamples()],
  server: { port: 5190, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as Parameters<typeof defineConfig>[0]);
