import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
await build({
  entryPoints: ['src/assistant/provider.ts'],
  outfile: 'artifacts/assistant-provider.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { analyze, controls } = await import('../artifacts/assistant-provider.mjs');
const models = ['gpt-6-luna', 'claude-haiku-4-5-20251001', 'qwen3.7-plus', 'claude-sonnet-5-5'];
const results = [];
for (const model of models) {
  const input = {
    sessionId: 'probe',
    version: 1,
    goal: 'Choose the cheaper vendor based on all-in cost.',
    memory: [],
    history: [],
    contextGap: false,
    segments: [
      {
        id: 0,
        sessionId: 'probe',
        startMs: 0,
        endMs: 6000,
        text: 'Vendor A costs 40 juta, vendor B costs 50 juta. These are license prices only. We want to decide which is cheaper overall, but migration and setup costs have not been checked.',
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await analyze(process.env.LISTEN_HPOP_KEY, model, input, controller.signal);
    results.push({ model, controls: controls(model), ok: true, ...r });
    console.log(model, Math.round(r.latencyMs) + 'ms', JSON.stringify(r.analysis));
  } catch (e) {
    results.push({
      model,
      controls: controls(model),
      ok: false,
      status: e.status ?? 0,
      category: e.category ?? 'unknown',
    });
    console.log(model, 'failed', e.status ?? 0, e.category ?? 'unknown');
  } finally {
    clearTimeout(timer);
  }
}
await writeFile('artifacts/assistant-probe.json', JSON.stringify(results, null, 2));
