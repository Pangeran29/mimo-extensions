import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReviewServer } from './live-memo-review-server.mjs';
test('local review viewer serves HTML as a page and keeps artifact-relative navigation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'listen-viewer-'));
  const report = 'live-memo-v2/replay-2026-10-30T08-10-01-669Z/lemhanas-16-10/review.html';
  await mkdir(path.dirname(path.join(root, report)), { recursive: true });
  await writeFile(
    path.join(root, report),
    '<!doctype html><title>Review</title><h1>Rendered review</h1>',
  );
  const server = createReviewServer({ artifactsRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/' + report);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.ok((await response.text()).includes('<h1>Rendered review</h1>'));
  const redirect = await fetch(origin, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/live-memo-v2/review.html');
  const head = await fetch(origin + '/' + report, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test('local review viewer never serves runtime bundles, source backups or project secrets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'listen-viewer-'));
  const server = createReviewServer({ artifactsRoot: root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const file of [
    '.local/deepinfra.json',
    'live-memo-v2/replay-2026-10-30T08-10-01-669Z/runtime.mjs',
    'live-memo-v2/source-before/src/relay.ts',
    'live-memo-v2/candidate-build/assistant/network-worker.js',
    'live-memo-v2/%2e%2e/%2e%2e/.local/deepinfra.json',
  ])
    assert.equal((await fetch(origin + '/' + file)).status, 404, file);
  assert.equal((await fetch(origin + '/health', { method: 'POST' })).status, 405);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(
      origin + '/health',
      { headers: { Host: 'unrelated.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHost, 403);
});
