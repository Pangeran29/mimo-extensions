import { renderLiveMemoReport } from './live-memo-report.mjs';
// Reuses baseline ASR arrival order; never retranscribes audio or alters baseline/dist.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { createRelay } from '../server/relay.mjs';
import { ReplayClock } from './recording-replay-clock.mjs';
import { reserveLiveMemoRequest } from './live-memo-budget.mjs';
const offline = process.argv.includes('--offline');
const checkpointOnly = process.argv.includes('--checkpoints');
const resumeRoot = process.argv.find((s) => s.startsWith('--resume='))?.slice(9);
const selectedRecording = process.argv.find((s) => s.startsWith('--recording='))?.slice(12);
const folder =
  process.argv.find((s) => s.startsWith('--output='))?.slice(9) ||
  `artifacts/live-memo-v1/replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const root = path.resolve(folder);
await mkdir(root, { recursive: false });
const sourceFiles = [
  'src/assistant/live-controller.ts',
  'src/assistant/live-context.ts',
  'src/assistant/live-prompt.ts',
  'src/assistant/live-schema.ts',
  'src/assistant/live-types.ts',
  'src/assistant/provider.ts',
  'scripts/live-memo-replay.mjs',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (f) => [
      f,
      createHash('sha256')
        .update(await readFile(f))
        .digest('hex'),
    ]),
  ),
);
await writeFile(root + '/source-hashes.json', JSON.stringify(sourceHashes, null, 2));
const config = offline
  ? { apiKey: 'synthetic', relayToken: 'synthetic' }
  : JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
let requests = 0,
  budgetReached = false;
const relay = createRelay({
  ...config,
  providerFetch: async (...args) => {
    if (!offline) {
      try {
        await reserveLiveMemoRequest(checkpointOnly ? 'checkpoint-LLM' : 'replay-LLM');
      } catch (e) {
        if (/cap reached/.test(e.message)) budgetReached = true;
        throw e;
      }
    }
    requests++;
    if (!offline) return fetch(...args);
    const body = JSON.parse(args[1].body),
      review = body.response_format.json_schema.name === 'live_memo_review_v1';
    const value = review
      ? { protocol: 1, accept: false, reason: 'Synthetic transport fixture.' }
      : {
          protocol: 1,
          topic: null,
          topicChanged: false,
          updates: [],
          decision: 'wait',
          reason: 'Synthetic transport fixture.',
          candidate: null,
        };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${relay.address().port}`;
await build({
  stdin: {
    contents: `export {LiveMemoController} from './src/assistant/live-controller'; export {liveStructured} from './src/assistant/provider'; export {DEFAULT_SETTINGS,DEEPINFRA_MODEL} from './src/assistant/types';`,
    resolveDir: process.cwd(),
  },
  outfile: root + '/runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: {
    LISTEN_TRANSCRIPTION_URL: JSON.stringify(origin + '/transcribe'),
    LISTEN_RELAY_TOKEN: JSON.stringify(config.relayToken),
  },
  plugins: [
    {
      name: 'replay-clock',
      setup(b) {
        b.onLoad({ filter: /assistant\/live-controller\.ts$/ }, async ({ path: file }) => ({
          contents: `const {setTimeout,clearTimeout}=globalThis.replayClock;const Date={now:()=>globalThis.replayClock.now};\n${await readFile(file, 'utf8')}`,
          loader: 'ts',
        }));
      },
    },
  ],
});
const clock = new ReplayClock();
globalThis.replayClock = clock;
const { LiveMemoController, liveStructured, DEFAULT_SETTINGS, DEEPINFRA_MODEL } = await import(
  root + '/runtime.mjs'
);
const index = {
  createdAt: new Date().toISOString(),
  mode: offline ? 'Synthetic transport' : 'Real DeepInfra; baseline ASR transcript replay',
  root,
  requestLimit: 800,
  runs: [],
  checkpoints: [],
  qualityAcceptance: 'Awaiting user review',
  latencyNote:
    'Virtual replay time uses measured provider latency; not browser microphone-to-display latency.',
};
const frozen = JSON.parse(await readFile('artifacts/hedy-inspired-review/index.json', 'utf8'));
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
async function saveIndex() {
  await writeFile(
    root + '/index.json',
    JSON.stringify({ ...index, requestsThisRun: requests }, null, 2),
  );
  await writeFile(
    root + '/index.html',
    `<!doctype html><meta charset="utf-8"><title>Live memo review</title><style>body{font:16px system-ui;margin:40px;max-width:1000px}td,th{padding:12px;border-bottom:1px solid #bbb;text-align:left}a{color:#075375}</style><h1>Live memo — contribution and silence</h1><p>${escape(index.mode)}. User review pending. ${requests} provider requests this run. Limit 800 across all implementation evaluations.</p><p>${escape(index.latencyNote)}</p><h2>Replay runs</h2><ul>${index.runs.map((r) => `<li><a href="${r.label}/review.html">${escape(r.label)}</a> — ${r.status}; ${r.proposals} proposals, ${r.reviews} reviews, ${r.contributions} displayed, ${r.errors} processing errors.</li>`).join('')}</ul><h2>Prepared checkpoints</h2><p>Checkpoint links show the first scheduled analysis covering its ASR segment. Coalescing is preserved. Compare sources available at that step; these are review expectations, not ground truth.</p><table><tr><th>Recording / checkpoint</th><th>Review focus</th><th>Decision</th></tr>${index.checkpoints.map((c) => `<tr><td><a href="${c.label}/review.html#${c.requestId}">${escape(c.label)} / ${c.segmentId}</a></td><td>${escape(c.expectation)}</td><td>${escape(c.decision)}</td></tr>`).join('')}</table>`,
  );
}
async function replay(
  label,
  transcript,
  arrivals,
  duration,
  checkpointList = [],
  initialCursor = -1,
  resumeData,
) {
  clock.now = resumeData?.at ?? 0;
  clock.events.clear();
  const run = {
    label,
    status: 'running',
    resumedFrom: resumeData?.from,
    durationMs: duration,
    asrArrivals: arrivals,
    trace: [],
    states: [],
    transcript,
    errors: [],
  };
  const dir = root + '/' + label;
  await mkdir(dir, { recursive: true });
  let parent,
    pending = new Set();
  const runner = {
    close() {},
    request(type, model, input, signal) {
      const row = {
        type,
        requestId: input.requestId,
        parent: type === 'REVIEW' ? parent : undefined,
        startedAt: clock.now,
        input,
      };
      if (type === 'PROPOSE') parent = input.requestId;
      run.trace.push(row);
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const task = liveStructured(
          config.relayToken,
          model,
          input,
          AbortSignal.any([signal, AbortSignal.timeout(type === 'REVIEW' ? 10000 : 20000)]),
          'deepinfra',
          (kind, data) => {
            if (kind === 'response') row.rawResponse = data;
          },
          type === 'REVIEW',
        )
          .then(
            async (v) => {
              row.value = v.value;
              row.usage = v.usage;
              row.elapsedMs = performance.now() - started;
              await writeFile(
                dir + '/progress.json',
                JSON.stringify(
                  { status: 'running', label, trace: run.trace, latestState: controller.snapshot },
                  null,
                  2,
                ),
              );
              clock.at(row.startedAt + row.elapsedMs, () => {
                row.completedAt = clock.now;
                resolve(v);
              });
            },
            async (e) => {
              row.error = { category: e.category, reason: e.reason, status: e.status };
              row.elapsedMs = performance.now() - started;
              await writeFile(
                dir + '/progress.json',
                JSON.stringify(
                  { status: 'running', label, trace: run.trace, latestState: controller.snapshot },
                  null,
                  2,
                ),
              );
              clock.at(row.startedAt + row.elapsedMs, () => {
                row.completedAt = clock.now;
                reject(e);
              });
            },
          )
          .finally(() => pending.delete(task));
        pending.add(task);
      });
    },
  };
  const controller = new LiveMemoController(
    runner,
    (s) => run.states.push({ at: clock.now, ...structuredClone(s) }),
    async () => {},
    () => {},
  );
  controller.configure({
    ...DEFAULT_SETTINGS,
    provider: 'deepinfra',
    enabled: true,
    model: DEEPINFRA_MODEL,
  });
  const received = [];
  const session = transcript[0]?.sessionId ?? label;
  controller.observe({
    phase: 'transcribing',
    sessionId: session,
    segments: [],
    incomplete: false,
    lagMs: 0,
    modelReady: true,
  });
  if (resumeData) {
    // Evaluation-only reconstruction of a previously paused replay. Production recovery remains closed.
    controller.restore(resumeData.snapshot);
    controller.snapshot.live.closed = false;
    controller.snapshot.phase = 'listening';
    controller.resume();
  }
  controller.snapshot.lastSegmentId = initialCursor;
  for (const a of arrivals)
    clock.at(Math.max(a.at, clock.now), () => {
      received.push(transcript.find((s) => s.id === a.id));
      controller.observe({
        phase: 'transcribing',
        sessionId: session,
        segments: [...received],
        incomplete: false,
        lagMs: 0,
        modelReady: true,
      });
    });
  clock.at(duration, () => controller.stopCapture());
  try {
    let iterations = 0;
    while (clock.events.size || pending.size) {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (pending.size) await Promise.all([...pending]);
      if (budgetReached)
        throw Error('Shared 800-request cap reached; evaluation is partial, not passed.');
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (++iterations > 20000) throw Error('Replay event loop exceeded bound');
      if (clock.events.size) clock.next();
    }
    run.finalSnapshot = controller.snapshot;
    run.status = run.states.some((s) => s.phase === 'paused') ? 'partial' : 'completed';
    if (run.status === 'partial')
      run.errors.push(
        'Provider failures exhausted retries; live memo paused. Transcript arrival replay completed, but processing coverage is partial.',
      );
  } catch (e) {
    run.status = 'partial';
    run.errors.push(e.message);
    controller.stopCapture();
  }
  for (const cp of checkpointList) {
    const row = run.trace.find(
      (t) => t.type === 'PROPOSE' && t.input.newSegmentIds.includes(cp.segmentId),
    );
    index.checkpoints.push({
      ...cp,
      label,
      requestId: row?.requestId ?? '',
      decision: row?.value?.decision ?? 'not processed',
    });
  }
  run.errors.push(
    ...run.trace.filter((t) => t.error).map((t) => ({ requestId: t.requestId, ...t.error })),
  );
  await writeFile(dir + '/run.json', JSON.stringify(run, null, 2));
  await writeFile(dir + '/review.html', renderLiveMemoReport(run, index));
  index.runs.push({
    label,
    status: run.status,
    proposals: run.trace.filter((t) => t.type === 'PROPOSE').length,
    reviews: run.trace.filter((t) => t.type === 'REVIEW').length,
    contributions: run.finalSnapshot?.live?.contributions.length ?? 0,
    errors: run.errors.length,
  });
  await saveIndex();
  console.log(JSON.stringify(index.runs.at(-1)));
}
try {
  if (!checkpointOnly && !resumeRoot && !selectedRecording) {
    // Non-meeting fixtures intentionally keep the same topic across a correction.
    for (const [label, texts] of [
      [
        'synthetic-concept',
        [
          'Dalam video ini, overfitting berarti model menghafal data latihan.',
          'Akurasi latihan 99 persen, tetapi data baru hanya 60 persen. Bagaimana kita membaca perbedaan ini?',
        ],
      ],
      [
        'synthetic-no-contribution',
        [
          'Video ini menjelaskan bahwa titik didih air bergantung pada tekanan udara.',
          'Pada permukaan laut, air murni mendidih sekitar 100 derajat Celsius. Tekanan yang lebih rendah menurunkan titik didih.',
        ],
      ],
      [
        'synthetic-correction',
        [
          'Podcast ini menyebut acara pada 23 November, masih berupa usulan.',
          'Koreksi: tanggalnya tetap 23 November, bukan Desember. Belum ada keputusan peserta.',
        ],
      ],
    ]) {
      const segments = texts.map((text, id) => ({
        id,
        sessionId: label,
        startMs: id * 15000,
        endMs: id * 15000 + 7000,
        text,
      }));
      await replay(
        label,
        segments,
        segments.map((s) => ({ id: s.id, at: s.endMs })),
        50000,
      );
    }
  }
  for (const label of ['lemhanas-16-10', 'lemhanas-28-10']) {
    if (budgetReached) break;
    if (selectedRecording && selectedRecording !== label) continue;
    const raw = await readFile(`artifacts/recording-replay/baseline-2026-10-29/${label}/run.json`);
    const baseline = JSON.parse(raw);
    const checkpointList = frozen.checkpoints
      .filter((c) => c.label === label)
      .map((c) => ({ segmentId: c.id, expectation: c.reviewExpectation }));
    const intervals = label === 'lemhanas-16-10' ? [5, 10, 15, 20] : [5, 10, 15, 20, 25, 30];
    for (const minute of intervals) {
      const segment = baseline.transcript.find((t) => t.endMs >= minute * 60000);
      checkpointList.push({
        segmentId: segment.id,
        expectation: `Additional ${minute}-minute checkpoint: timely value, novelty, evidence and appropriate silence.`,
      });
    }
    index.baselineHashes ??= {};
    index.baselineHashes[label] = createHash('sha256').update(raw).digest('hex');
    if (checkpointOnly) {
      for (const [i, cp] of checkpointList.entries()) {
        if (budgetReached) break;
        const prefix = baseline.transcript.filter((t) => t.id <= cp.segmentId);
        await replay(
          `${label}-checkpoint-${i + 1}`,
          prefix,
          prefix.map((t) => ({ id: t.id, at: 1 })),
          45000,
          [cp],
          cp.segmentId - 1,
        );
      }
      continue;
    }
    const arrivals = baseline.asr
      .filter((a) => Number.isInteger(a.segmentId))
      .map((a) => ({ id: a.segmentId, at: a.completedAtMs }));
    const previous = resumeRoot
      ? JSON.parse(await readFile(resumeRoot + '/' + label + '/run.json', 'utf8'))
      : undefined;
    const resumeAt = previous
      ? Math.max(...previous.trace.map((t) => t.completedAt ?? t.startedAt))
      : 0;
    await replay(
      label,
      baseline.transcript,
      arrivals,
      Math.max(baseline.durationMs, ...arrivals.map((a) => a.at), resumeAt) + 45000,
      checkpointList,
      previous?.finalSnapshot.lastSegmentId ?? -1,
      previous
        ? {
            from: resumeRoot + '/' + label + '/run.json',
            at: resumeAt,
            snapshot: previous.finalSnapshot,
          }
        : undefined,
    );
  }
} finally {
  await saveIndex();
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  console.log(root);
}
