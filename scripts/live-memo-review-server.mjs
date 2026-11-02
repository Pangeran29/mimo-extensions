// Read-only local viewer for the existing v2 review artifacts. No model/API calls.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function allowedReviewPath(relative) {
  if (relative === 'live-memo-v1/provider-budget.json') return true;
  if (!relative.startsWith('live-memo-v2/')) return false;
  const name = relative.slice('live-memo-v2/'.length);
  return (
    /^(?:review\.html|index\.html|verification\.json|verification-final\.log|review-focus\.json|report-browser-check\.json|REVIEW\.md)$/.test(
      name,
    ) ||
    /^(?:ui|browser-pipeline)\/result\.json$/.test(name) ||
    /^ui\/[a-z0-9-]+\.png$/.test(name) ||
    /^replay-[0-9TZ.-]+\/(?:index\.html|index\.json|source-hashes\.json)$/.test(name) ||
    /^replay-[0-9TZ.-]+\/[a-z0-9-]+\/(?:review\.html|run\.json)$/.test(name)
  );
}
export function createReviewServer({ artifactsRoot = path.join(projectRoot, 'artifacts') } = {}) {
  const base = path.resolve(artifactsRoot);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const reply = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    try {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(405, 'Read-only report viewer');
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || ''))
        return reply(403, 'Local report viewer');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ service: 'listen-review-viewer', version: 1 }));
      }
      if (url.pathname === '/') {
        res.writeHead(302, { Location: '/live-memo-v2/review.html' });
        return res.end();
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (!allowedReviewPath(relative)) return reply(404, 'Report artifact not found');
      const file = await realpath(path.join(base, relative));
      if (!file.startsWith((await realpath(base)) + path.sep))
        return reply(404, 'Report artifact not found');
      const data = await readFile(file);
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.log': 'text/plain; charset=utf-8',
        '.md': 'text/plain; charset=utf-8',
        '.png': 'image/png',
      }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      reply(error.code === 'ENOENT' ? 404 : 400, 'Report artifact not found');
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.find((s) => s.startsWith('--port='))?.slice(7) || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid review port');
  const server = createReviewServer();
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`Review viewer: http://127.0.0.1:${port}/live-memo-v2/review.html`),
  );
}
