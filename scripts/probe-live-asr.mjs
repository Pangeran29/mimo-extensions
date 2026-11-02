import { readFile, writeFile } from 'node:fs/promises';
import { reserveLiveRequest } from './provider-batching-budget.mjs';
const cfg = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
await reserveLiveRequest('deepinfra', 'direct-ASR-diagnostic', 0.01);
const form = new FormData();
form.set(
  'audio',
  new Blob(
    [await readFile('training:meeting/verified-excerpts-v1-76136748b154/clips/0792-combined.wav')],
    { type: 'audio/wav' },
  ),
  'excerpt.wav',
);
const start = performance.now();
let report;
try {
  const r = await fetch('https://api.deepinfra.com/v1/inference/Qwen/Qwen3-ASR-0.6B', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45000),
  });
  const data = await r.json();
  report = {
    status: r.status,
    elapsedMs: performance.now() - start,
    providerStatus: data.inference_status?.status,
    textCharacters: data.text?.length,
    error: r.ok ? undefined : data,
  };
} catch (e) {
  report = {
    status: 0,
    error: e.name,
    causeCode: e.cause?.code,
    elapsedMs: performance.now() - start,
  };
}
await writeFile(
  'artifacts/provider-batching/asr-diagnostic.json',
  JSON.stringify(report, null, 2).replaceAll(cfg.apiKey, '[REDACTED]'),
);
console.log(JSON.stringify(report).replaceAll(cfg.apiKey, '[REDACTED]'));
