import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
await build({
  entryPoints: ['src/assistant/provider.ts'],
  outfile: 'artifacts/assistant-benchmark-provider.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { analyze, analyzeNativeClaude, controls } = await import(
  '../artifacts/assistant-benchmark-provider.mjs'
);
const fixtures = JSON.parse(await readFile('tests/fixtures/assistant-checkpoints.json', 'utf8'));
const probes = JSON.parse(await readFile('artifacts/assistant-probe.json', 'utf8'));
const models = ['gpt-6-luna', 'claude-haiku-4-5-20251001', 'qwen3.7-plus', 'claude-sonnet-5-5'];
const report = {
  createdAt: new Date().toISOString(),
  sourceHash: createHash('sha256')
    .update(await readFile('src/assistant/provider.ts'))
    .update(await readFile('src/assistant/prompt.ts'))
    .digest('hex'),
  qualityReview: 'pending independent review; automated labels do not establish usefulness',
  forwardedControls:
    'Not independently verified at upstream provider; no candidate eligible for automatic default.',
  models: [],
};
for (const model of models) {
  const probe = probes.find((p) => p.model === model);
  if (probe?.status === 503) {
    report.models.push({
      model,
      excluded: true,
      reason:
        'HPOP route returned 503 during authenticated preflight. No 60-checkpoint replay claimed.',
    });
    continue;
  }
  const rows = [];
  const native = model.startsWith('claude-');
  // One candidate at a time, at most two concurrent calls; retain each checkpoint immediately.
  for (let i = 0; i < fixtures.length * 2; i += 2) {
    await Promise.all(
      [i, i + 1].map(async (n) => {
        const fixture = fixtures[n % fixtures.length],
          pass = Math.floor(n / fixtures.length) + 1;
        const sessionId = `${fixture.id}-${pass}`;
        const input = {
          sessionId,
          version: 1,
          goal: 'General work decisions and clear commitments.',
          memory: [],
          history: [],
          contextGap: false,
          segments: [{ id: 0, sessionId, startMs: 0, endMs: 7000, text: fixture.text }],
        };
        const abort = new AbortController(),
          timer = setTimeout(() => abort.abort(), 8000),
          start = performance.now();
        try {
          const r = await (native ? analyzeNativeClaude : analyze)(
            process.env.LISTEN_HPOP_KEY,
            model,
            input,
            abort.signal,
          );
          rows.push({
            checkpoint: fixture.id,
            pass,
            gap: fixture.gap,
            topic: fixture.topic,
            ok: true,
            ...r,
          });
          console.log(
            model,
            fixture.id,
            pass,
            Math.round(r.latencyMs),
            r.analysis.question?.text ?? 'null',
          );
        } catch (e) {
          rows.push({
            checkpoint: fixture.id,
            pass,
            gap: fixture.gap,
            topic: fixture.topic,
            ok: false,
            status: e.status ?? 0,
            category: e.category ?? 'unknown',
            elapsedMs: performance.now() - start,
          });
          console.log(model, fixture.id, pass, 'failed', e.status, e.category);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    await writeFile(
      'artifacts/assistant-benchmark-progress.json',
      JSON.stringify({ ...report, current: { model, rows } }, null, 2),
    );
  }
  const latencies = rows
    .filter((r) => r.ok)
    .map((r) => r.latencyMs + 150)
    .sort((a, b) => a - b);
  const percentile = (p) =>
    latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] ?? null;
  const metrics = {
    valid: latencies.length,
    total: rows.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    costUSD: rows
      .filter((r) => r.ok)
      .reduce(
        (sum, r) =>
          sum +
          ((r.usage?.input ?? 0) * (model.includes('haiku') ? 0.75 : 1.5)) / 1e6 +
          ((r.usage?.output ?? 0) * (model.includes('haiku') ? 3.75 : 7.5)) / 1e6,
        0,
      ),
    costNote: 'Estimate using observed public pricing, actual routing/cache billing may differ.',
  };
  report.models.push({
    model,
    adapter: native ? 'anthropic' : 'openai',
    controls: native
      ? model.includes('haiku')
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
      : controls(model),
    metrics,
    rows,
  });
  await writeFile('artifacts/assistant-benchmark.json', JSON.stringify(report, null, 2));
}
await writeFile('artifacts/assistant-benchmark.json', JSON.stringify(report, null, 2));
console.log(
  'Benchmark complete. No automatic default selected. Review quality and upstream control forwarding separately.',
);
