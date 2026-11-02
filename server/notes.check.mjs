import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRelay } from './relay.mjs';
import { NOTES_MODEL, NOTES_TIMEOUT_MS, MOM_TIMEOUT_MS, serveNotes } from './notes.mjs';
const sse =
  'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
async function fixture(t, providerFetch) {
  const server = createRelay({
    apiKey: 'provider-secret',
    relayToken: 'relay-token',
    providerFetch,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const body = {
  model: NOTES_MODEL,
  messages: [
    { role: 'system', content: 'JSON only' },
    { role: 'user', content: 'Transcript' },
  ],
  stream: true,
  max_tokens: 1600,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'meeting_analysis', schema: { type: 'object' } },
  },
};
const request = (value) => ({
  method: 'POST',
  headers: { Authorization: 'Bearer relay-token', 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
test('a cancelled notes stream aborts upstream and releases its own slot', async (t) => {
  let signal;
  const url = await fixture(t, async (_endpoint, options) => {
    signal = options.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
          options.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const abort = new AbortController();
  const response = await fetch(url + '/v1/openai/chat/completions', {
    ...request(body),
    signal: abort.signal,
  });
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(signal.aborted, true);
});
test('notes relay enforces the fixed model, uses the backend key and streams content', async (t) => {
  const url = await fixture(t, async (endpoint, options) => {
    assert.equal(endpoint, 'https://api.deepinfra.com/v1/openai/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer provider-secret');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, NOTES_MODEL);
    assert.equal(sent.reasoning_effort, 'none');
    assert.equal(sent.apiKey, undefined);
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await fetch(
    url + '/v1/openai/chat/completions',
    request({ ...body, apiKey: 'must-not-forward' }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), sse);
  const health = await fetch(url + '/health', { headers: { Authorization: 'Bearer relay-token' } });
  assert.equal((await health.json()).notes.model, NOTES_MODEL);
});
test('rejects other models, malformed bodies, invalid auth, roles and oversized requests before upstream', async (t) => {
  const url = await fixture(t, () => {
    throw Error('Must not reach provider');
  });
  for (const value of [
    null,
    { ...body, model: 'other' },
    { ...body, max_tokens: 20000 },
    { ...body, messages: [{ role: 'assistant', content: 'x' }] },
    { ...body, messages: [{ role: 'user', content: 'x'.repeat(132000) }] },
  ])
    assert.ok((await fetch(url + '/v1/openai/chat/completions', request(value))).status >= 400);
  const noauth = request(body);
  delete noauth.headers.Authorization;
  assert.equal((await fetch(url + '/v1/openai/chat/completions', noauth)).status, 401);
});
test('redacts provider error bodies while preserving retry status', async (t) => {
  const url = await fixture(
    t,
    async () => new Response('provider-secret', { status: 429, headers: { 'retry-after': '13' } }),
  );
  const response = await fetch(url + '/v1/openai/chat/completions', request(body));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '13');
  assert.ok(!(await response.text()).includes('provider-secret'));
});

test('allows only versioned MoM schemas their larger output limit while preserving live limits', async (t) => {
  let calls = 0;
  const url = await fixture(t, async () => { calls++; return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }); });
  for (const name of ['meeting_minutes_extract_v1', 'meeting_minutes_compose_v1', 'meeting_minutes_review_v1']) {
    const response = await fetch(url + '/v1/openai/chat/completions', request({ ...body, max_tokens: 3200, response_format: { type: 'json_schema', json_schema: { name, schema: { type: 'object' } } } }));
    assert.equal(response.status, 200); await response.text();
  }
  for (const name of ['meeting_minutes_unknown_v1', 'live_memo_review_v2']) {
    const response = await fetch(url + '/v1/openai/chat/completions', request({ ...body, max_tokens: 3200, response_format: { type: 'json_schema', json_schema: { name, schema: { type: 'object' } } } }));
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(calls, 3);
  const health = await fetch(url + '/health', { headers: { Authorization: 'Bearer relay-token' } });
  assert.deepEqual((await health.json()).notes.supportedEndMeetingProtocols, [1]);
});

test('MoM has an independent 60-second relay deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const value = { ...body, max_tokens: 3200, response_format: { type: 'json_schema', json_schema: { name: 'meeting_minutes_compose_v1', schema: { type: 'object' } } } };
  const req = Readable.from([Buffer.from(JSON.stringify(value))]); req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter(); res.writableEnded = false; res.headersSent = false;
  const slots = { active: 0 }; const replies = [];
  let signal, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const work = serveNotes(req, res, { apiKey: 'provider-secret', slots, cors: {}, reply: status => { replies.push(status); res.writableEnded = true; }, providerFetch: async (_url, options) => {
    signal = options.signal; entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private detail')), { once: true }));
  } });
  await ready;
  t.mock.timers.tick(NOTES_TIMEOUT_MS); assert.equal(signal.aborted, false);
  t.mock.timers.tick(MOM_TIMEOUT_MS - NOTES_TIMEOUT_MS); await work;
  assert.equal(signal.aborted, true); assert.deepEqual(replies, [504]); assert.equal(slots.active, 0);
});

test('preserves provider 503 backoff and exposes it to the permitted extension', async (t) => {
  const url = await fixture(
    t,
    async () =>
      new Response('private-provider-detail', {
        status: 503,
        headers: { 'retry-after': '17' },
      }),
  );
  const options = request(body);
  options.headers.Origin = 'chrome-extension://' + 'a'.repeat(32);
  const response = await fetch(url + '/v1/openai/chat/completions', options);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '17');
  assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.ok(!(await response.text()).includes('private-provider-detail'));
});

test('an errored provider error-body preserves rate-limit status and retry delay', async (t) => {
  const url = await fixture(
    t,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error('private-provider-detail');
          },
        }),
        { status: 429, headers: { 'retry-after': '11' } },
      ),
  );
  const response = await fetch(url + '/v1/openai/chat/completions', request(body));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '11');
  assert.ok(!(await response.text()).includes('private-provider-detail'));
});

test('converts a bounded provider HTTP-date into retry seconds without retrying early', async (t) => {
  const target = Date.now() + 30_000;
  const url = await fixture(
    t,
    async () =>
      new Response('busy', {
        status: 503,
        headers: { 'retry-after': new Date(target).toUTCString() },
      }),
  );
  const response = await fetch(url + '/v1/openai/chat/completions', request(body));
  const wait = Number(response.headers.get('retry-after'));
  assert.ok(wait >= 29 && wait <= 30);
  assert.equal(response.status, 503);
  await response.text();
});

test('a relay deadline is a 504 timeout and releases its notes slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json' };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headersSent = false;
  const slots = { active: 0 };
  let signal;
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const replies = [];
  const work = serveNotes(req, res, {
    apiKey: 'provider-secret',
    slots,
    cors: {},
    reply: (status, value) => {
      replies.push({ status, value });
      res.writableEnded = true;
    },
    providerFetch: async (_endpoint, options) => {
      signal = options.signal;
      reached();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('private-provider-detail'));
          },
          { once: true },
        ),
      );
    },
  });
  await entered;
  assert.equal(slots.active, 1);
  t.mock.timers.tick(NOTES_TIMEOUT_MS);
  await work;
  assert.equal(signal.aborted, true);
  assert.equal(slots.active, 0);
  assert.equal(replies[0].status, 504);
  assert.match(replies[0].value.error.message, /timed out/);
  assert.ok(!JSON.stringify(replies).includes('private-provider-detail'));
});
test('supports bounded longer ASR WAVs and rejects payloads above 24 seconds', async (t) => {
  let calls = 0;
  const url = await fixture(t, async () => {
    calls++;
    return new Response(
      JSON.stringify({ text: 'long audio', inference_status: { status: 'succeeded' } }),
    );
  });
  const wav = (seconds) => {
    const audio = Buffer.alloc(44 + seconds * 16000 * 4);
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
  };
  const options = {
    method: 'POST',
    headers: { Authorization: 'Bearer relay-token', 'Content-Type': 'audio/wav' },
  };
  assert.equal((await fetch(url + '/transcribe', { ...options, body: wav(24) })).status, 200);
  assert.equal((await fetch(url + '/transcribe', { ...options, body: wav(25) })).status, 413);
  assert.equal(calls, 1);
});
test('accepts the two versioned live schemas, preserves legacy, rejects unknown schema names', async (t) => {
  let calls = 0;
  const url = await fixture(t, async () => {
    calls++;
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  for (const name of [
    'meeting_analysis',
    'live_memo_proposal_v1',
    'live_memo_review_v1',
    'live_memo_proposal_v2',
    'live_memo_review_v2',
  ]) {
    const response = await fetch(
      url + '/v1/openai/chat/completions',
      request({
        ...body,
        response_format: { type: 'json_schema', json_schema: { name, schema: { type: 'object' } } },
      }),
    );
    assert.equal(response.status, 200);
    await response.text();
  }
  const response = await fetch(
    url + '/v1/openai/chat/completions',
    request({
      ...body,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'arbitrary', schema: { type: 'object' } },
      },
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(calls, 5);
  const health = await fetch(url + '/health', { headers: { Authorization: 'Bearer relay-token' } });
  assert.equal((await health.json()).notes.liveMemoProtocol, 1);
});
