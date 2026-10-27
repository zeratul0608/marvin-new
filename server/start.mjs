import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAiMiddleware } from './ai-middleware.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };
const inside = (root, target) => { const path = relative(root, target); return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path); };
function error(res, status, text) { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(text); }

/** Creates an HTTP server; call listen on 127.0.0.1 only. */
export function createAppServer(options = {}) {
  const dist = resolve(options.dist ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const ai = createAiMiddleware(options.ai);
  const serve = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { error(res, 405, 'Method not allowed'); return; }
    let pathname;
    try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0]); }
    catch { error(res, 400, 'Invalid path'); return; }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) { error(res, 403, 'Forbidden'); return; }
    let target = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!inside(dist, target)) { error(res, 403, 'Forbidden'); return; }
    try {
      const root = await realpath(dist);
      target = await realpath(target);
      if (!inside(root, target)) { error(res, 403, 'Forbidden'); return; }
      const info = await stat(target);
      if (!info.isFile()) { error(res, 404, 'Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch { error(res, 404, 'Not found. Run npm run build first.'); }
  };
  return createServer((req, res) => { void ai(req, res, () => { void serve(req, res); }); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createAppServer();
  server.listen(4173, '127.0.0.1', () => { console.log('Molecule Workbench: http://127.0.0.1:4173'); });
  server.on('error', () => { console.error('Unable to start local server on 127.0.0.1:4173.'); process.exitCode = 1; });
}
