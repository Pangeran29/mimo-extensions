import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const { values: v } = parseArgs({
  options: {
    reports: { type: 'string' },
    prepare: { type: 'boolean' },
    review: { type: 'string' },
    output: { type: 'string', default: 'artifacts/notes-review.json' },
  },
});
if (!v.reports) throw Error('--reports JSON array of browser-report paths required');
const files = JSON.parse(await readFile(v.reports, 'utf8'));
const reports = await Promise.all(
  files.map(async (file) => ({ file, report: JSON.parse(await readFile(file, 'utf8')) })),
);
function attemptFor(report, version) {
  const commit = report.events.find((e) => e.name === 'memo.committed' && e.version === version);
  return report.events.find(
    (e) =>
      e.name === 'ai.attempt' &&
      (commit?.requestId ? e.requestId === commit.requestId : e.version === version),
  );
}
const idFor = (file) => createHash('sha256').update(file).digest('hex').slice(0, 16);
if (v.prepare) {
  const cases = reports.map(({ file, report: r }) => ({
    id: idFor(file),
    firstSubstantiveSpeechMs: null,
    firstUsefulEvidenceMs: null,
    scenario: null,
    language: null,
    sourceAudio: r.source,
    playbackOffsetMs: r.audioPlaybackAt && r.captureAt ? r.audioPlaybackAt - r.captureAt : null, // No variant, provider timings, or condition name in the blind packet.
    revisions: r.revisions.map((revision) => {
      const attempt = attemptFor(r, revision.version);
      const supplied = r.attempts?.find((a) => a.requestId === attempt?.requestId)?.context;
      return {
        version: revision.version,
        memo: revision.memo,
        previousMemo: supplied?.previousSummary ?? '',
        evidenceMemory: supplied?.memory ?? [],
        evidenceAvailableAtDispatch: supplied
          ? [...(supplied.earlierTranscript || []), ...(supplied.newTranscript || [])]
          : r.segments
              .filter((s) => attempt && s.availableAt <= attempt.at)
              .map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text })),
        useful: null,
        faithful: null,
        criticalUnsupported: null,
        materialDistortion: null,
        unnecessaryRetraction: null,
        explanation: '',
      };
    }),
  }));
  // Deterministic shuffled ordering conceals paired condition order.
  cases.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(
    v.output,
    JSON.stringify(
      {
        instructions:
          'Review each memo only against dispatch evidence first. Then inspect later speech for retractions. Annotate evidence readiness in recording-relative milliseconds. Use spontaneous, mixed-language, corrections, uncertainty, silence/music, unfinished, short-turn, continuous, podcast, or read-speech-control as scenario.',
        continuousSession: { passed: null, report: '' },
        cases,
      },
      null,
      2,
    ),
  );
  console.log(
    `Wrote blind review ${v.output}. Timing and variants remain in source reports; keep those separate during review.`,
  );
  process.exit(0);
}
if (!v.review) throw Error('--review completed blind packet required, or use --prepare');
const review = JSON.parse(await readFile(v.review, 'utf8'));
const percentile = (xs, p) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1] : null;
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96,
    q = k / n,
    d = 1 + (z * z) / n,
    c = (q + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((q * (1 - q)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const rows = reports.map(({ file, report: r }) => {
  const q = review.cases?.find((c) => c.id === idFor(file));
  const reviewed =
    !!q &&
    r.revisions.every((revision) => {
      const a = q.revisions?.find((a) => a.version === revision.version);
      return (
        a &&
        [
          'useful',
          'faithful',
          'criticalUnsupported',
          'materialDistortion',
          'unnecessaryRetraction',
        ].every((k) => typeof a[k] === 'boolean')
      );
    });
  const firstUseful = q?.revisions?.find(
    (a) =>
      a.useful === true &&
      a.faithful === true &&
      a.criticalUnsupported === false &&
      a.materialDistortion === false,
  );
  const attempt = firstUseful && attemptFor(r, firstUseful.version);
  const presentation =
    firstUseful &&
    r.events.find(
      (e) => e.name === 'memo.presentation_estimate' && e.version === firstUseful.version,
    );
  const stop = r.events.find((e) => e.name === 'capture.stopped');
  const eligible =
    Number.isFinite(q?.firstUsefulEvidenceMs) &&
    q.firstUsefulEvidenceMs >= 0 &&
    q.firstUsefulEvidenceMs <= 8000;
  const usefulMs =
    presentation && r.clickAt && attempt && (!stop || presentation.at < stop.at)
      ? presentation.at - r.clickAt
      : null;
  return {
    id: idFor(file),
    fixture: r.fixtureHash || r.source,
    variant: r.variant,
    eligible,
    reviewed,
    censorMs: stop && r.clickAt ? stop.at - r.clickAt : null,
    cohort: r.cohort,
    sourceHash: r.sourceHash,
    harnessHash: r.harnessHash,
    evaluationGateHash: r.evaluationGateHash,
    buildHash: r.buildHash,
    model: r.model,
    language: q?.language,
    measured: r.kind === 'measured',
    complete: r.complete,
    usefulMs,
    scenario: q?.scenario,
    droppedEvents: r.droppedEvents,
    critical: q?.revisions?.some((a) => a.criticalUnsupported === true) ?? true,
    distortions: q?.revisions?.filter((a) => a.materialDistortion === true).length ?? 0,
    firstNoteWords: r.revisions[0]?.memo.trim().split(/\s+/).length ?? 0,
    retractions: q?.revisions?.filter((a) => a.unnecessaryRetraction === true).length ?? 0,
    emptyResponses: r.events.filter((e) => e.name === 'ai.validated' && e.empty).length,
    errors: r.events.filter((e) => e.name === 'ai.error').length,
    tokens: r.events
      .filter((e) => e.name === 'ai.validated')
      .reduce((n, e) => n + (e.inputTokens || 0) + (e.outputTokens || 0), 0),
  };
});
const primaryRows = rows.filter((r) => r.measured && r.cohort === 'warmed' && r.eligible);
const uniqueRuns = new Set(primaryRows.map((r) => `${r.fixture}:${r.variant}`));
if (uniqueRuns.size !== primaryRows.length)
  throw Error(
    'Use one warmed run per opening and variant in the primary analysis; report repeated runs separately.',
  );
const conditions = {};
for (const variant of ['baseline', 'short-first-note']) {
  const rs = rows.filter(
    (r) => r.variant === variant && r.eligible && r.measured && r.cohort === 'warmed',
  );
  conditions[variant] = {
    n: rs.length,
    distinct: new Set(rs.map((r) => r.fixture)).size,
    deadlines: [15000, 20000, 30000].map((ms) => {
      const k = rs.filter((r) => r.reviewed && r.usefulMs !== null && r.usefulMs <= ms).length;
      return {
        ms,
        successes: k,
        total: rs.length,
        rate: rs.length ? k / rs.length : null,
        wilson95: wilson(k, rs.length),
      };
    }),
    p50ObservedMs: percentile(
      rs.flatMap((r) => (r.usefulMs === null ? [] : [r.usefulMs])),
      0.5,
    ),
    p95ObservedMs: percentile(
      rs.flatMap((r) => (r.usefulMs === null ? [] : [r.usefulMs])),
      0.95,
    ),
    censored: rs.filter((r) => r.usefulMs === null).length,
  };
}
const candidate = rows.filter(
  (r) => r.variant === 'short-first-note' && r.eligible && r.measured && r.cohort === 'warmed',
);
const paired = candidate.map((c) => ({
  c,
  b: rows.find(
    (b) =>
      b.fixture === c.fixture &&
      b.variant === 'baseline' &&
      b.measured &&
      b.eligible &&
      b.cohort === 'warmed',
  ),
}));
// Use the baseline's observed censor time as a conservative latency lower bound.
// Candidate misses are +Infinity, so a faster median cannot hide their deadline failures.
const pairsComplete =
  paired.length > 0 &&
  paired.every(
    (p) =>
      p.b &&
      p.c.reviewed &&
      p.b.reviewed &&
      (p.b.usefulMs !== null || Number.isFinite(p.b.censorMs)),
  );
const improves =
  pairsComplete &&
  percentile(
    paired.map((p) => p.c.usefulMs ?? Infinity),
    0.5,
  ) <
    percentile(
      paired.map((p) => p.b.usefulMs ?? p.b.censorMs),
      0.5,
    );
const quality =
  rows.filter((r) => r.variant === 'short-first-note').every((r) => r.firstNoteWords <= 50) &&
  rows.every((r) => r.measured && r.reviewed && r.complete && !r.droppedEvents && !r.critical) &&
  paired.every(
    (p) => p.b && p.c.distortions <= p.b.distortions && p.c.retractions <= p.b.retractions,
  );
const scenarios = new Set(rows.map((r) => r.scenario));
const languages = new Set(rows.map((r) => r.language));
const comparable =
  rows.every(
    (r) => r.sourceHash && r.buildHash && r.harnessHash && r.evaluationGateHash && r.model,
  ) &&
  new Set(rows.map((r) => r.harnessHash)).size === 1 &&
  new Set(rows.map((r) => r.evaluationGateHash)).size === 1 &&
  new Set(rows.map((r) => r.sourceHash)).size === 1 &&
  new Set(rows.map((r) => r.buildHash)).size === 1 &&
  new Set(rows.map((r) => r.model)).size === 1;
const representative =
  ['id', 'en', 'mixed'].every((l) => languages.has(l)) &&
  [
    'podcast',
    'mixed-language',
    'corrections',
    'uncertainty',
    'silence/music',
    'unfinished',
    'short-turn',
    'continuous',
  ].every((s) => scenarios.has(s));
const deadline = conditions['short-first-note'].deadlines.find(
  (d) => d.total >= 20 && d.rate >= 0.95,
);
const rollout =
  !!deadline &&
  conditions['short-first-note'].distinct >= 20 &&
  improves &&
  quality &&
  comparable &&
  representative &&
  review.continuousSession?.passed === true &&
  !!review.continuousSession?.report;
const stageNames = ['startupMs', 'asrMs', 'providerMs', 'commitToPresentationMs'];
const stageRows = reports.map(({ report: r }) => {
  const pairs = (start, end) =>
    r.events
      .filter((e) => e.name === start)
      .flatMap((a) => {
        const b = r.events.find(
          (b) =>
            b.name === end &&
            b.at >= a.at &&
            (a.requestId
              ? b.requestId === a.requestId
              : a.windowId !== undefined
                ? b.windowId === a.windowId
                : a.version !== undefined
                  ? b.version === a.version
                  : true),
        );
        return b ? [b.at - a.at] : [];
      });
  return {
    variant: r.variant,
    startupMs: pairs('listen.clicked', 'capture.started'),
    asrMs: pairs('asr.started', 'asr.complete'),
    providerMs: pairs('provider.sent', 'provider.complete'),
    commitToPresentationMs: pairs('memo.committed', 'memo.presentation_estimate'),
  };
});
const stages = Object.fromEntries(
  ['baseline', 'short-first-note'].map((variant) => [
    variant,
    Object.fromEntries(
      stageNames.map((name) => {
        const xs = stageRows.filter((r) => r.variant === variant).flatMap((r) => r[name]);
        return [name, { n: xs.length, p50: percentile(xs, 0.5), p95: percentile(xs, 0.95) }];
      }),
    ),
  ]),
);
const result = {
  stages,
  rollout: rollout ? 'eligible-for-enabling' : 'retain-baseline',
  selectedDeadlineMs: rollout ? deadline.ms : null,
  gates: {
    enoughDistinct: conditions['short-first-note'].distinct >= 20,
    improves,
    quality,
    comparable,
    representative,
    continuous: review.continuousSession?.passed === true,
  },
  conditions,
  rows,
  warning:
    'Observed percentiles exclude censored runs; censored counts are explicit. Wilson intervals are descriptive and do not certify population reliability. This command never changes the shipped policy.',
};
await writeFile(v.output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    { rollout: result.rollout, selectedDeadlineMs: result.selectedDeadlineMs, gates: result.gates },
    null,
    2,
  ),
);
