import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelay, MODEL } from './relay.mjs';

function wav() {
  const audio = Buffer.alloc(44 + 16000 * 4);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVE', 8);
  audio.write('fmt ', 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(3, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt16LE(32, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}
async function setup(t, providerFetch) {
  const server = createRelay({
    apiKey: 'provider-secret',
    relayToken: 'local-access',
    providerFetch,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-access',
      'Content-Type': 'audio/wav',
      Origin: 'chrome-extension://' + 'a'.repeat(32),
    },
    body: wav(),
  };
  return { url, options };
}
test('forwards only exact WAV and provider key, returning a minimal successful transcript', async (t) => {
  let calls = 0;
  const { url, options } = await setup(t, async (endpoint, request) => {
    calls++;
    assert.equal(endpoint, `https://api.deepinfra.com/v1/inference/${MODEL}`);
    assert.equal(request.headers.Authorization, 'Bearer provider-secret');
    assert.deepEqual([...request.body.keys()], ['audio']);
    assert.deepEqual(Buffer.from(await request.body.get('audio').arrayBuffer()), wav());
    return new Response(
      JSON.stringify({
        text: 'Halo 世界',
        language: 'auto',
        inference_status: { status: 'succeeded', cost: 0.1 },
      }),
    );
  });
  const response = await fetch(url + '/transcribe', options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Halo 世界', language: 'auto' });
  assert.equal(calls, 1);
});
test('rejects unauthenticated, web-page, bad-host and malformed audio without charging upstream', async (t) => {
  const { url, options } = await setup(t, () => {
    throw new Error('Must not call upstream');
  });
  for (const patch of [
    { headers: { ...options.headers, Authorization: '' } },
    { headers: { ...options.headers, Origin: 'https://example.com' } },
    { headers: { ...options.headers, Host: 'attacker.example' } },
    { body: Buffer.alloc(10) },
  ]) {
    const response = await fetch(url + '/transcribe', { ...options, ...patch });
    assert.ok(response.status >= 400);
  }
});
test('never forwards an upstream credential/error body to the extension', async (t) => {
  const { url, options } = await setup(
    t,
    async () => new Response('provider-secret and raw error', { status: 401 }),
  );
  const response = await fetch(url + '/transcribe', options);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('provider-secret'), false);
});
test('malformed or unsuccessful upstream JSON remains retryable', async (t) => {
  const { url, options } = await setup(
    t,
    async () => new Response('{"text":"partial","inference_status":{"status":"failed"}}'),
  );
  assert.equal((await fetch(url + '/transcribe', options)).status, 503);
});
test('aborts upstream work when the local caller disconnects', async (t) => {
  let entered, aborted;
  const called = new Promise((r) => {
    entered = r;
  });
  const stopped = new Promise((r) => {
    aborted = r;
  });
  const { url, options } = await setup(t, async (_url, options) => {
    entered();
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => {
        aborted();
        reject(new Error('aborted'));
      }),
    );
  });
  const controller = new AbortController();
  const request = fetch(url + '/transcribe', { ...options, signal: controller.signal });
  const rejected = assert.rejects(request);
  await called;
  controller.abort();
  await rejected;
  await stopped;
});
