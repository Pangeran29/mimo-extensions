import http from 'node:http';
import { serveNotes, NOTES_MODEL } from './notes.mjs';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_ASR_SECONDS = 24;
const MAX_ASR_BYTES = 44 + MAX_ASR_SECONDS * 16000 * 4;
export const MODEL = 'Qwen/Qwen3-ASR-0.6B';
const upstream = `https://api.deepinfra.com/v1/inference/${MODEL}`;
const equal = (a, b) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createRelay({ apiKey, relayToken, providerFetch = fetch, allowedOrigin } = {}) {
  if (!apiKey || !relayToken)
    throw new Error('Configure backend credentials before starting the relay.');
  let active = 0;
  const notesSlots = { active: 0 };
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const permitted =
      origin &&
      (allowedOrigin ? origin === allowedOrigin : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
    const reply = (status, data) => {
      if (!res.headersSent)
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(permitted ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
        });
      res.end(JSON.stringify(data));
    };
    // Local development only. No unauthenticated public relay is provided.
    if (
      req.headers.host !== `127.0.0.1:${req.socket.localPort}` &&
      req.headers.host !== `localhost:${req.socket.localPort}`
    )
      return reply(403, { error: 'Invalid host' });
    if (origin && !permitted) return reply(403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(permitted ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Listen-Session',
      });
      return res.end();
    }
    if (!equal(req.headers.authorization || '', `Bearer ${relayToken}`))
      return reply(401, { error: 'Access denied' });
    if (req.url === '/health' && req.method === 'GET')
      return reply(200, {
        ready: true,
        model: MODEL,
        notes: {
          configured: true,
          model: NOTES_MODEL,
          liveMemoProtocol: 1,
          supportedLiveMemoProtocols: [1, 2],
        },
      });
    if (req.url === '/v1/openai/chat/completions' && req.method === 'POST')
      return serveNotes(req, res, {
        apiKey,
        providerFetch,
        reply,
        slots: notesSlots,
        cors: permitted ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {},
      });
    if (req.url !== '/transcribe' || req.method !== 'POST')
      return reply(404, { error: 'Not found' });
    if (req.headers['content-type'] !== 'audio/wav')
      return reply(415, { error: 'Expected WAV audio' });
    if (active >= 2) return reply(429, { error: 'Busy; retry later' });
    active++;
    let timer;
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_ASR_BYTES) {
          reply(413, { error: 'Audio window too large' });
          return;
        }
        chunks.push(chunk);
      }
      const audio = Buffer.concat(chunks);
      if (
        audio.length < 44 ||
        audio.toString('ascii', 0, 4) !== 'RIFF' ||
        audio.toString('ascii', 8, 12) !== 'WAVE' ||
        audio.toString('ascii', 12, 16) !== 'fmt ' ||
        audio.readUInt32LE(16) !== 16 ||
        audio.readUInt16LE(20) !== 3 ||
        audio.readUInt16LE(22) !== 1 ||
        audio.readUInt32LE(24) !== 16000 ||
        audio.readUInt16LE(34) !== 32 ||
        audio.toString('ascii', 36, 40) !== 'data' ||
        audio.readUInt32LE(40) !== audio.length - 44 ||
        audio.length <= 44 ||
        (audio.length - 44) % 4 !== 0
      )
        return reply(400, { error: 'Invalid audio window' });
      const form = new FormData();
      form.set('audio', new Blob([audio], { type: 'audio/wav' }), 'excerpt.wav');
      timer = setTimeout(() => controller.abort(), 45000);
      const response = await providerFetch(upstream, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return reply(503, { error: 'Transcription temporarily unavailable' });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');
      const parts = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        parts.push(Buffer.from(value));
      }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (
        typeof data.text !== 'string' ||
        data.text.length > 20000 ||
        data.inference_status?.status !== 'succeeded'
      )
        throw new Error('Invalid provider response');
      reply(200, {
        text: data.text,
        language: typeof data.language === 'string' ? data.language : 'auto',
      });
    } catch {
      reply(503, { error: 'Transcription temporarily unavailable' });
    } finally {
      clearTimeout(timer);
      active--;
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(
    await readFile(new URL('../.local/deepinfra.json', import.meta.url), 'utf8'),
  );
  const server = createRelay(config);
  server.requestTimeout = 60000;
  server.listen(8787, '127.0.0.1', () =>
    console.log('Listen transcription relay ready at http://127.0.0.1:8787 (loopback only).'),
  );
}
