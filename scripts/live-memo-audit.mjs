import { renderLiveMemoReport } from './live-memo-report.mjs';
// Read-only integrity checks and a consolidated review entry point.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const base = 'artifacts/live-memo-v1';
const full = process.argv[2];
const checkpoints = process.argv[3];
const continuation = process.argv[4];
if (!full || !checkpoints)
  throw Error('Usage: node scripts/live-memo-audit.mjs FULL_REPLAY_ROOT CHECKPOINT_ROOT');
const load = async (p) => JSON.parse(await readFile(p, 'utf8'));
const main = await load(full + '/index.json'),
  probes = await load(checkpoints + '/index.json'),
  budget = await load(base + '/provider-budget.json');
const report = {
  at: new Date().toISOString(),
  technicalStatus: 'pending',
  userAcceptance: 'pending',
  providerAttempts: budget.attempts.length,
  providerLimit: 800,
  fullRuns: [],
  checkpointRuns: probes.runs,
  syntheticScenarios: [],
  checks: [],
  limitations: [],
};
assert.ok(budget.attempts.length <= 800);
assert.equal(probes.runs.length, 17);
assert.ok(probes.runs.every((r) => r.status === 'completed' && r.errors === 0));
for (const label of ['lemhanas-16-10', 'lemhanas-28-10']) {
  const leaf = await load((continuation || full) + '/' + label + '/run.json');
  const chain = [];
  let part = leaf;
  while (part) {
    chain.unshift(part);
    part = part.resumedFrom ? await load(part.resumedFrom) : undefined;
  }
  const run = {
    ...leaf,
    trace: chain.flatMap((p) => p.trace),
    states: chain.flatMap((p) => p.states).sort((a, b) => a.at - b.at),
    sourceRuns: chain.map((p) => ({
      status: p.status,
      resumedFrom: p.resumedFrom,
      requests: p.trace.length,
    })),
    errors: chain.flatMap((p) => p.errors),
  };

  const raw = await readFile(`artifacts/recording-replay/baseline-2026-10-29/${label}/run.json`);
  const baseline = JSON.parse(raw);
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    main.baselineHashes[label],
    'Baseline was altered',
  );
  assert.equal(run.status, 'completed');
  assert.equal(run.transcript.length, baseline.transcript.length);
  assert.deepEqual(
    run.transcript,
    baseline.transcript,
    'Replay must use exact baseline transcript',
  );
  const attempts = run.trace;
  const proposals = attempts.filter((t) => t.type === 'PROPOSE'),
    reviews = attempts.filter((t) => t.type === 'REVIEW');
  for (const row of attempts) {
    const available = new Set(
      baseline.asr.filter((a) => a.completedAtMs <= row.startedAt).map((a) => a.segmentId),
    );
    for (const s of row.input.segments)
      assert.ok(available.has(s.id), `Future source ${s.id} in ${row.requestId}`);
    if (row.value?.candidate) {
      assert.ok(row.value.candidate.body.length <= 1200);
      const known = new Set(row.input.segments.map((t) => t.id));
      assert.ok(row.value.candidate.sources.every((id) => known.has(id)));
    }
    if (row.type === 'REVIEW' && row.value)
      assert.deepEqual(Object.keys(row.value).sort(), ['accept', 'protocol', 'reason']);
  }
  const contributions = run.finalSnapshot.live.contributions;
  for (const c of contributions) {
    const review = reviews.find((r) => r.parent === c.id);
    assert.equal(review?.value?.accept, true, 'Unreviewed contribution published');
    assert.equal(
      c.body,
      proposals.find((p) => p.requestId === c.id)?.value?.candidate?.body,
      'Reviewer rewrote candidate',
    );
  }
  const decisions = Object.fromEntries(
    ['wait', 'silent', 'candidate'].map((d) => [
      d,
      proposals.filter((r) => r.value?.decision === d).length,
    ]),
  );
  const unprocessed = baseline.transcript
    .filter((t) => t.id > run.finalSnapshot.lastSegmentId)
    .map((t) => t.id);
  const failureExplanations = attempts
    .filter((t) => t.error)
    .map((t) => {
      const target = Math.max(...(t.input.newSegmentIds?.length ? t.input.newSegmentIds : [-1]));
      const recovered = proposals.find(
        (p) => p.startedAt > t.startedAt && p.value && Math.max(...p.input.newSegmentIds) >= target,
      );
      const explanation =
        t.type === 'REVIEW'
          ? 'Reviewer transport failed; candidate was discarded, stage-one memory was retained.'
          : recovered
            ? `Request rejected/failed (${t.error.category}/${t.error.reason}); later proposal ${recovered.requestId} processed the pending source range.`
            : 'Request cancelled or failed at Stop; the continuation processes the retained transcript.';
      t.errorExplanation = explanation;
      return {
        requestId: t.requestId,
        category: t.error.category,
        reason: t.error.reason,
        recoveredBy: recovered?.requestId,
        explanation,
      };
    });
  await mkdir(base + '/' + label, { recursive: true });
  await writeFile(base + '/' + label + '/run.json', JSON.stringify(run, null, 2));
  await writeFile(
    base + '/' + label + '/review.html',
    renderLiveMemoReport(run, {
      ...main,
      mode: 'Real provider: original arrival replay plus explicit evaluation checkpoint continuation',
    }),
  );
  assert.equal(
    unprocessed.length,
    0,
    'Complete review requires all transcript segments to be processed across the linked runs',
  );
  const entry = {
    label,
    transcriptSegments: baseline.transcript.length,
    proposals: proposals.length,
    reviews: reviews.length,
    decisions,
    reviewRejected: reviews.filter((t) => t.value?.accept === false).length,
    modelAcceptedButSuppressed: reviews.filter(
      (t) => t.value?.accept === true && !contributions.some((c) => c.id === t.parent),
    ).length,
    displayed: contributions.length,
    processingFailures: attempts
      .filter((t) => t.error)
      .map((t) => ({ requestId: t.requestId, ...t.error })),
    unprocessedAtStop: unprocessed,
    sourceHash: main.baselineHashes[label],
    failureExplanations,
    sourceRuns: run.sourceRuns,
  };
  if (unprocessed.length)
    report.limitations.push(
      `${label}: ${unprocessed.length} final transcript segment(s) arrived before Stop but were not committed to live memory before cancellation. They remain in the full transcript. No final MOM/recap call was made.`,
    );
  report.fullRuns.push(entry);
}
for (const run of main.runs.filter((r) => r.label.startsWith('synthetic-'))) {
  assert.equal(run.status, 'completed');
  assert.equal(run.errors, 0);
  report.syntheticScenarios.push(run);
}
const ui = await load(base + '/ui/result.json'),
  pipeline = await load(base + '/browser-pipeline/result.json');
assert.equal(ui.success, true);
assert.equal(pipeline.success, true);
report.checks = [
  '223 application tests plus relay/tool checks (see verification log)',
  '17 real-provider frozen/five-minute checkpoint probes',
  '3 synthetic non-meeting transcripts with real-provider responses',
  'Exact baseline transcript and ASR-arrival evidence cutoffs',
  'Source reference validation and body cap',
  'Every published contribution has an accepting independent review and unchanged body',
  'Separate-profile real Chrome capture/VAD/ASR/live memo smoke',
  'UI sources, feedback, history pages, saved history, themes, narrow viewport, native 200% Chrome zoom',
  'Shared request cap including superseded experiments',
];
report.technicalStatus =
  'Technical checks passed; handled provider/schema failures are documented; usefulness acceptance pending';
report.limitations.push(
  'Model quality review is not certification. The user has not accepted usefulness. No validated usefulness percentage is claimed.',
  'Replay timings use a virtual arrival clock and measured provider time; browser smoke timings cover only the short integration excerpt.',
  'The original second recording paused after repeated provider errors. Evaluation resumed from the last committed context in a new run; all prior failures remain visible. This does not change production recovery: a closed session never resumes live contributions.',
  'After provider deadline failures in the map/dashboard suffix, the proposal prompt was tightened to emit only concise changed memory (normally up to three records, target 160 characters each). Only that failed suffix was replayed from its saved source-linked state. Earlier outputs remain original measurements, not a fresh from-zero run under the compact-memory instruction.',
  'The initial harness classified some deadline-aborted streams as unexpected_finish/network. Later runs add real 20/10-second abort signals; final provider code prioritizes timeout classification. Lifecycle and diagnostic corrections are covered by final tests.',
  'The original schema-mismatch response was not retained by the first harness, so its exact invalid field is unavailable. A bounded re-probe of that same input succeeded; the original rejection and limitation remain visible.',
);
await writeFile(base + '/verification.json', JSON.stringify(report, null, 2));
const partials = [];
for (const dir of await readdir(base)) {
  if (!dir.startsWith('replay-')) continue;
  try {
    const value = await load(base + '/' + dir + '/index.json');
    if (value.status?.startsWith('partial')) partials.push({ dir, status: value.status });
  } catch {}
}
const rel = (p) => path.relative(base, p);
const table = report.fullRuns
  .map(
    (r) =>
      `| ${r.label} | ${r.transcriptSegments} | ${r.proposals} | ${r.decisions.wait} / ${r.decisions.silent} | ${r.reviews} | ${r.reviewRejected} | ${r.modelAcceptedButSuppressed} | ${r.displayed} | ${r.processingFailures.length} |`,
  )
  .join('\n');
await writeFile(
  base + '/REVIEW.md',
  `# Live memo review\n\nImplementation and technical validation are complete. Activation and usefulness acceptance are pending your review.\n\n| Recording | Transcript segments | Proposals | Wait / silent | Reviews | Reviewer rejects | Accepted but stale/closed | Displayed | Provider/format errors |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\nProvider attempts across all experiments and smoke runs: **${budget.attempts.length}/800**. Superseded partial experiments remain in the ledger.\n\n- [Complete consolidated replay tables](review.html)
- [Original runs and synthetic scenarios](${rel(full)}/index.html)\n- [17 independent checkpoint probes](${rel(checkpoints)}/index.html)\n- [Integrity and technical verification](verification.json)\n- [Real Chrome audio pipeline smoke](browser-pipeline/result.json)\n- [UI checks](ui/result.json)\n\nThe full replay also contains three synthetic non-meeting scenarios. Each report has input/context details, sources, silence/candidate decisions, reviewer outcomes, timing/tokens, and exportable user feedback. Use: membantu, mengulang, salah konteks, terlalu menebak, sebaiknya diam.\n\n${report.limitations.map((s) => '- ' + s).join('\n')}\n\nNo installed extension reload or existing relay restart was performed. Candidate build: candidate-build/. MOM remains deferred.\n`,
);
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
await writeFile(
  base + '/review.html',
  `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Live memo — review kandidat</title><style>body{font:16px/1.6 system-ui;color:#172a3b;background:#fff;margin:40px auto;max-width:1100px;padding:0 20px}a{color:#006b80}td,th{text-align:left;padding:12px;border-bottom:1px solid #dce6ed}table{width:100%;border-collapse:collapse}li{margin:12px 0}pre{white-space:pre-wrap}small{color:#526779}</style><h1>Live memo — kontribusi aktif + riwayat</h1><p>Implementasi kandidat dan tes teknis selesai. <strong>Belum diaktifkan pada extension lo.</strong> Kegunaan output masih menunggu review lo.</p><p>${budget.attempts.length}/800 percobaan request provider, termasuk percobaan parsial dan smoke test.</p><table><tr><th>Rekaman</th><th>Wait / silent</th><th>Pemeriksa</th><th>Ditolak</th><th>Diterima tapi kedaluwarsa</th><th>Ditampilkan</th></tr>${report.fullRuns.map((r) => `<tr><td><a href="${r.label}/review.html">${r.label}</a></td><td>${r.decisions.wait} / ${r.decisions.silent}</td><td>${r.reviews}</td><td>${r.reviewRejected}</td><td>${r.modelAcceptedButSuppressed}</td><td>${r.displayed}</td></tr>`).join('')}</table><h2>Mulai review</h2><ul><li><a href="${rel(checkpoints)}/index.html">17 checkpoint terpisah: tujuh yang lama + sepuluh interval lima menit</a></li><li><a href="${rel(full)}/index.html">Replay penuh dan tiga skenario non-meeting</a></li><li><a href="verification.json">Bukti verifikasi teknis dan batas pengujian</a></li><li><a href="browser-pipeline/result.json">Smoke test audio → ASR → live memo di Chrome terisolasi</a></li><li><a href="ui/result.json">Tes UI dan zoom Chrome 200%</a></li></ul><p>Di setiap tabel, buka detail konteks/sumber dan beri label: <strong>membantu, mengulang, salah konteks, terlalu menebak, sebaiknya diam</strong>. Feedback tersimpan lokal di browser dan bisa diekspor sebagai JSON. Diam juga perlu dinilai: terlalu sering diam dapat melewatkan kesempatan membantu.</p><h2>Batas dan catatan</h2><ul>${report.limitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><details><summary>Percobaan awal yang dihentikan</summary><ul>${partials.map((p) => `<li><a href="${p.dir}/index.json">${p.dir}</a>: ${esc(p.status)}</li>`).join('')}</ul><p>Hasil parsial bukan hasil lulus; seluruh request tetap dihitung pada batas yang sama.</p></details><p><small>Baseline asli tetap utuh. Kandidat build ada di candidate-build/. MOM belum dibuat dan tidak dijalankan saat Stop.</small></p></html>`,
);
await writeFile(base + '/index.html', await readFile(base + '/review.html'));
console.log(JSON.stringify(report, null, 2));
