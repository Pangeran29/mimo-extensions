// Isolated, wall-clock replay of measured final-transcript arrivals through the
// CURRENT controller and provider. Does not change the shipped extension.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { reserveRequest, budgetStatus } from './notes-latency-budget.mjs';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    output: { type: 'string' },
    repeats: { type: 'string', default: '5' },
    seed: { type: 'string', default: '20261020' },
    run: { type: 'boolean' },
    help: { type: 'boolean' },
    budget: { type: 'string', default: 'artifacts/notes-latency-budget.json' },
  },
});
if (values.help || !values.fixture) {
  console.log(
    'Usage: node scripts/notes-latency-benchmark.mjs --fixture TRACE.json [--repeats 5] [--seed 20261020] [--run] [--output REPORT.json]\nDefault: validate and print the plan without network requests. --run requires LISTEN_HPOP_KEY. See docs/NOTES-LATENCY.md for trace format and limitations.',
  );
  process.exit(values.help ? 0 : 1);
}
const rawFixture = await readFile(values.fixture, 'utf8');
const trace = JSON.parse(rawFixture);
const repeats = Number(values.repeats);
let seed = Number(values.seed);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 30 || !Number.isSafeInteger(seed))
  throw Error('Use 1–30 repeats and an integer seed.');
if (
  !['measured', 'synthetic'].includes(trace.kind) ||
  !trace.label ||
  !trace.environment ||
  !Number.isFinite(trace.durationMs) ||
  trace.durationMs < 30000 ||
  trace.durationMs > 120000 ||
  !Array.isArray(trace.segments) ||
  !trace.segments.length
)
  throw Error('Trace requires kind, label, environment, durationMs (30000–120000), and segments.');
let lastArrival = -1;
let lastId = -1;
for (const segment of trace.segments) {
  if (
    !Number.isInteger(segment.id) ||
    segment.id <= lastId ||
    !Number.isFinite(segment.startMs) ||
    !Number.isFinite(segment.endMs) ||
    !Number.isFinite(segment.availableAtMs) ||
    segment.startMs < 0 ||
    segment.endMs <= segment.startMs ||
    segment.availableAtMs < segment.endMs ||
    segment.availableAtMs < lastArrival ||
    segment.availableAtMs > trace.durationMs ||
    typeof segment.text !== 'string' ||
    !segment.text.trim()
  )
    throw Error(
      'Segments need increasing unique IDs, valid audio times, and ordered measured availability times within durationMs.',
    );
  lastArrival = segment.availableAtMs;
  lastId = segment.id;
}
// Randomized paired blocks: each repeat contains both variants, in seeded order.
const jobs = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const variants =
    seed & 0x80000000 ? ['baseline', 'short-first-note'] : ['short-first-note', 'baseline'];
  for (const variant of variants) jobs.push({ repeat, variant });
}
console.log(
  JSON.stringify(
    {
      scope: 'controller/provider replay; not browser end-to-end',
      fixture: trace.label,
      kind: trace.kind,
      runs: jobs.length,
      durationPerRunMs: trace.durationMs,
      deadlinesMs: [15000, 20000, 30000],
      jobs,
    },
    null,
    2,
  ),
);
if (!values.run) process.exit(0);
if (!process.env.LISTEN_HPOP_KEY)
  throw Error(
    'Set LISTEN_HPOP_KEY locally before --run. Never put the key in the fixture or a report.',
  );

await mkdir('artifacts', { recursive: true });
const runtime = 'artifacts/notes-latency-runtime.mjs';
await build({
  stdin: {
    contents: `export { AssistantController } from './src/assistant/controller.ts';
export { analyzeNativeClaude } from './src/assistant/provider.ts';
export { DEFAULT_SETTINGS } from './src/assistant/types.ts';`,
    resolveDir: process.cwd(),
  },
  outfile: runtime,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { AssistantController, analyzeNativeClaude, DEFAULT_SETTINGS } = await import(
  '../' + runtime
);
const hash = createHash('sha256');
hash.update(await readFile('scripts/notes-latency-benchmark.mjs'));
for (const file of [
  'controller',
  'provider',
  'prompt',
  'schema',
  'types',
  'timing',
  'errors',
  'summaries',
])
  hash.update(file).update(await readFile(`src/assistant/${file}.ts`));
const report = {
  createdAt: new Date().toISOString(),
  sourceHash: hash.digest('hex'),
  fixtureHash: createHash('sha256').update(rawFixture).digest('hex'),
  seed: Number(values.seed),
  scope:
    'Recorded final-transcript arrival replay through current controller and live HPOP. Excludes browser messaging, rendering, and fresh ASR execution. No end-to-end SLO claimed.',
  quality: 'UNREVIEWED. Nonempty validated JSON does not establish useful or faithful notes.',
  trace: {
    label: trace.label,
    source: trace.source,
    kind: trace.kind,
    environment: trace.environment,
  },
  model: DEFAULT_SETTINGS.model,
  durationMs: trace.durationMs,
  runs: [],
};
const output = values.output || 'artifacts/notes-latency-benchmark.json';
const originalFetch = globalThis.fetch;
// Count every actual HTTP attempt, across replay and browser tools, before sending.
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://hpop.ai/'))
    await reserveRequest(values.budget, { tool: 'replay', fixtureHash: report.fixtureHash });
  return originalFetch(url, options);
};
try {
  for (const job of jobs) {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const row = { ...job, firstNonemptyMemoMs: null, firstMemo: null, requests: [], revisions: [] };
    const pending = new Set();
    const runner = {
      close() {},
      async request(type, model, input, signal) {
        if (type !== 'ANALYZE') throw Error('Unexpected deeper request');
        const request = {
          startedMs: elapsed(),
          version: input.version,
          segmentIds: input.segments.map((s) => s.id),
          firstMemoAttempt: !input.previousSummary?.trim(),
        };
        row.requests.push(request);

        const promise = analyzeNativeClaude(process.env.LISTEN_HPOP_KEY, model, input, signal);
        pending.add(promise);
        try {
          const result = await promise;
          Object.assign(request, {
            completedMs: elapsed(),
            ok: true,
            latencyMs: result.latencyMs,
            firstToolDeltaMs: result.firstTokenMs,
            usage: result.usage,
            nonempty: !!result.analysis.summary.trim(),
          });
          return result;
        } catch (error) {
          Object.assign(request, {
            completedMs: elapsed(),
            ok: false,
            status: error.status ?? 0,
            category: error.category ?? 'unknown',
            aborted: signal.aborted,
          });
          throw error;
        } finally {
          pending.delete(promise);
        }
      },
    };
    let lastMemo = '';
    const controller = new AssistantController(
      runner,
      (snapshot) => {
        if (snapshot.summary.trim() && snapshot.summary !== lastMemo) {
          lastMemo = snapshot.summary;
          const atMs = elapsed();
          row.revisions.push({
            atMs,
            throughSegmentId: snapshot.lastSegmentId,
            memo: snapshot.summary,
          });
          if (row.firstNonemptyMemoMs === null) {
            row.firstNonemptyMemoMs = atMs;
            row.firstMemo = snapshot.summary;
          }
        }
      },
      async () => {},
      () => {},
    );
    const settings = { ...DEFAULT_SETTINGS, enabled: true };
    controller.setMemoPolicy(job.variant);
    controller.configure(settings);
    const sessionId = `latency-${job.repeat}-${job.variant}`;
    const segments = [];
    for (const segment of trace.segments) {
      await sleep(Math.max(0, segment.availableAtMs - elapsed()));
      segments.push({
        id: segment.id,
        sessionId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      });
      controller.observe({
        phase: 'transcribing',
        sessionId,
        segments: [...segments],
        incomplete: false,
        lagMs: 0,
        modelReady: true,
      });
    }
    await sleep(Math.max(0, trace.durationMs - elapsed()));
    row.phaseAtEnd = controller.snapshot.phase;
    // No Stop-triggered extra pass: this benchmark measures live first notes.
    controller.configure({ ...settings, enabled: false });
    await Promise.allSettled([...pending]);
    row.deadlines = [15000, 20000, 30000].map((deadlineMs) => ({
      deadlineMs,
      nonemptyMemoInTime: row.firstNonemptyMemoMs !== null && row.firstNonemptyMemoMs <= deadlineMs,
    }));
    report.runs.push(row);
    report.budget = await budgetStatus(values.budget);
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(
      `${job.variant} repeat ${job.repeat}: first nonempty memo ${row.firstNonemptyMemoMs ?? 'none'} ms; usefulness review pending`,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  `Saved ${output}. Review notes against only speech available at each revision. This report does not select a winner automatically.`,
);
