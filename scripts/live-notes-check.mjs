import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRelay } from '../server/relay.mjs';
import { reserveLiveRequest } from './provider-batching-budget.mjs';
const cfg = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
const upstreamChecks = [];
const relay = createRelay({
  ...cfg,
  providerFetch: async (...args) => {
    await reserveLiveRequest('deepinfra', 'streamed-notes-through-managed-relay', 0.02);
    const start = performance.now();
    try {
      const r = await fetch(...args);
      upstreamChecks.push({
        status: r.status,
        contentType: r.headers.get('content-type'),
        elapsedMs: performance.now() - start,
      });
      return r;
    } catch (e) {
      upstreamChecks.push({
        error: e.name,
        causeCode: e.cause?.code,
        elapsedMs: performance.now() - start,
      });
      throw e;
    }
  },
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const port = relay.address().port;
try {
  await build({
    entryPoints: ['src/assistant/provider.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: 'artifacts/provider-batching/live-provider.mjs',
    define: { LISTEN_TRANSCRIPTION_URL: JSON.stringify(`http://127.0.0.1:${port}/transcribe`) },
  });
  const { analyze, deeper } = await import('../artifacts/provider-batching/live-provider.mjs');
  const ref = JSON.parse(
    await readFile('training:meeting/verified-excerpts-v1-76136748b154/reference.json', 'utf8'),
  );
  const texts = ref.annotations
    .filter((a) => a.status === 'speech' && a.text?.trim() && a.text.length >= 95)
    .slice(0, 2)
    .map((a) => ({ label: a.id, text: a.text }));
  texts.push({
    label: 'user-supplied-vlog',
    text: "It's actually raining today. Which is the first rain that we've had. Honestly, it gives nice cozy vibes. Very, very good coffee. Actually, one of my favorite coffees.",
  });
  const rows = [];
  for (const item of texts) {
    const input = {
      sessionId: 'live-notes-' + item.label,
      version: 1,
      goal: '',
      segments: [
        { id: 0, sessionId: 'live-notes-' + item.label, startMs: 0, endMs: 8000, text: item.text },
      ],
      memory: [],
      history: [],
      contextGap: false,
    };
    try {
      const result = await analyze(
        cfg.relayToken,
        'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        input,
        new AbortController().signal,
        'deepinfra',
      );
      rows.push({ label: item.label, valid: true, ...result });
      console.log(
        JSON.stringify({
          label: item.label,
          valid: true,
          summaryCharacters: result.analysis.summary.length,
          latencyMs: result.latencyMs,
        }),
      );
    } catch (e) {
      rows.push({
        label: item.label,
        valid: false,
        status: e.status,
        category: e.category,
        reason: e.reason,
        issues: e.validationIssues,
      });
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  try {
    const old = JSON.parse(await readFile('artifacts/provider-batching/live-notes.json', 'utf8'));
    let history = [];
    try {
      history = JSON.parse(
        await readFile('artifacts/provider-batching/live-notes-history.json', 'utf8'),
      );
    } catch {}
    history.push(old);
    await writeFile(
      'artifacts/provider-batching/live-notes-history.json',
      JSON.stringify(history, null, 2),
    );
  } catch {}
  await writeFile(
    'artifacts/provider-batching/live-notes.json',
    JSON.stringify(
      {
        scope:
          'Real DeepInfra streaming via production adapter and managed relay; actual reviewed/supplied transcript inputs, no audio/browser capture in this check.',
        rows,
        upstreamChecks,
      },
      null,
      2,
    ),
  );
  console.log('Upstream transport:', JSON.stringify(upstreamChecks));
} finally {
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
}
