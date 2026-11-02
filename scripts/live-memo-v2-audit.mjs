import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = 'artifacts/live-memo-v2';
const args = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, '').split('=')));
for (const key of ['full', 'checkpoints', 'overrides', 'synthetic'])
  if (!args[key]) throw Error('Required --' + key + '=RUN_ROOT');
const load = async (p) => JSON.parse(await readFile(p, 'utf8'));
const ledger = await load('artifacts/live-memo-v1/provider-budget.json');
assert.ok(ledger.attempts.length <= 800);
const ui = await load(base + '/ui/result.json'),
  audio = await load(base + '/browser-pipeline/result.json');
assert.equal(ui.success, true);
assert.equal(audio.success, true);
const report = {
  at: new Date().toISOString(),
  protocol: 2,
  activation: 'not activated',
  userAcceptance: 'pending',
  technicalChecks: 'passed (application, relay, isolated UI and audio smoke)',
  evaluationStatus: 'pending',
  budget: {
    initialUsed: 443,
    used: ledger.attempts.length,
    v2Attempts: ledger.attempts.length - 443,
    limit: 800,
    remaining: 800 - ledger.attempts.length,
  },
  fullRuns: [],
  checkpointCases: [],
  syntheticCases: [],
  limitations: [],
};
const main = await load(args.full + '/index.json');
for (const label of ['lemhanas-16-10', 'lemhanas-28-10']) {
  const raw = await readFile(`artifacts/recording-replay/baseline-2026-10-29/${label}/run.json`),
    baseline = JSON.parse(raw);
  let run;
  try {
    run = await load(args.full + '/' + label + '/run.json');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!run) {
    report.fullRuns.push({
      label,
      status: 'not started within budget',
      segmentsTotal: baseline.transcript.length,
      segmentsProcessed: 0,
      memoRevisions: 0,
      contributions: 0,
    });
    continue;
  }
  assert.equal(createHash('sha256').update(raw).digest('hex'), main.baselineHashes[label]);
  assert.deepEqual(run.transcript, baseline.transcript);
  const proposals = run.trace.filter((t) => t.type === 'PROPOSE'),
    reviews = run.trace.filter((t) => t.type === 'REVIEW');
  for (const row of run.trace) {
    const available = new Set(
      baseline.asr.filter((a) => a.completedAtMs <= row.startedAt).map((a) => a.segmentId),
    );
    for (const s of row.input.segments)
      assert.ok(available.has(s.id), 'Future transcript evidence');
  }
  const memos = new Map();
  for (const s of run.states) if (s.liveV2?.memo) memos.set(s.liveV2.memo.id, s.liveV2.memo);
  for (const memo of memos.values()) {
    const id = memo.id.replace(/:memo$/, '');
    const proposal = proposals.find((p) => p.requestId === id),
      review = reviews.find((r) => r.parent === id);
    assert.equal(review?.value?.memo.accept, true);
    assert.equal(memo.text, proposal?.value?.memoUpdate.text);
    assert.ok(memo.text.length <= 600);
    const known = new Set(proposal.input.segments.map((t) => t.id));
    assert.ok(memo.sources.every((id) => known.has(id)));
  }
  const contributions = run.finalSnapshot?.liveV2?.contributions ?? [];
  for (const c of contributions) {
    const p = proposals.find((p) => p.requestId === c.id),
      r = reviews.find((r) => r.parent === c.id);
    assert.equal(r?.value?.contribution.accept, true);
    assert.equal(c.body, p?.value?.candidate?.body);
    assert.ok(c.body.length <= 1200);
  }
  const latest = run.finalSnapshot ?? run.states.at(-1),
    cursor = latest?.lastSegmentId ?? -1;
  const errors = run.trace
    .filter((t) => t.error)
    .map((t) => ({ requestId: t.requestId, type: t.type, ...t.error }));
  const entry = {
    label,
    status: run.status,
    segmentsTotal: baseline.transcript.length,
    segmentsProcessed: baseline.transcript.filter((t) => t.id <= cursor).length,
    memoRevisions: memos.size,
    contributions: contributions.length,
    proposals: proposals.length,
    reviews: reviews.length,
    wait: proposals.filter((t) => t.value?.decision === 'wait').length,
    silent: proposals.filter((t) => t.value?.decision === 'silent').length,
    errors,
    componentRejections: run.trace
      .filter((t) => t.componentErrors?.length)
      .map((t) => ({ requestId: t.requestId, components: t.componentErrors })),
    publishedMemos: [...memos.values()],
    publishedContributions: contributions,
  };
  report.fullRuns.push(entry);
}
// Latest targeted attempt wins for the same frozen prefix, while original measurements remain linked.
const selected = new Map();
for (const root of [args.checkpoints, args.overrides]) {
  const index = await load(root + '/index.json');
  for (const item of index.runs) {
    const run = await load(root + '/' + item.label + '/run.json');
    const p = run.trace.find((t) => t.type === 'PROPOSE');
    const recording = item.label.split('-checkpoint-')[0],
      segmentId = p.input.newSegmentIds.at(-1);
    selected.set(item.label, {
      ...item,
      root,
      recording,
      segmentId,
      memo: run.finalSnapshot?.liveV2?.memo ?? null,
    });
  }
}
const originalCheckpoints = await load(args.checkpoints + '/index.json');
for (const item of originalCheckpoints.runs) {
  const run = await load(args.checkpoints + '/' + item.label + '/run.json');
  const p = run.trace.find((t) => t.type === 'PROPOSE');
  const recording = item.label.split('-checkpoint-')[0],
    segmentId = p.input.newSegmentIds.at(-1);
  report.checkpointCases.push({
    ...selected.get(item.label),
    originalLabel: item.label,
  });
}
assert.equal(report.checkpointCases.length, 17);
const synthetic = await load(args.synthetic + '/index.json');
for (const item of synthetic.runs) {
  const run = await load(args.synthetic + '/' + item.label + '/run.json');
  report.syntheticCases.push({
    ...item,
    root: args.synthetic,
    memo: run.finalSnapshot?.liveV2?.memo ?? null,
    contributions: run.finalSnapshot?.liveV2?.contributions ?? [],
  });
}
const complete = report.fullRuns.every(
  (r) => r.status === 'completed' && r.segmentsProcessed === r.segmentsTotal,
);
report.evaluationStatus = complete
  ? 'full coverage complete; usefulness review pending'
  : 'PARTIAL — full replay evaluation has not passed';
report.limitations.push(
  'Technical tests and model reviewer verdicts are not certification of factual quality or usefulness. User acceptance remains pending.',
  'The prior 443 requests and all v2 retries/superseded experiments share the original 800-attempt ceiling.',
  'Replay follows baseline ASR arrival order with measured provider durations on a virtual clock. Full browser end-to-end latency is not established.',
  'The 17 checkpoint set includes targeted retests after validation/prompt fixes. Earlier outputs remain in separate run folders.',
  'Actor/object selection validation is a conservative guard for a concrete ambiguity, not a general semantic entailment proof.',
);
if (!complete)
  report.limitations.push(
    'Incomplete recording coverage is explicitly partial; no usefulness percentage or full-evaluation pass is claimed.',
  );
await writeFile(base + '/verification.json', JSON.stringify(report, null, 2));
const relative = (p) => path.relative(base, p),
  esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const fullLinks = report.fullRuns
  .map(
    (r) =>
      `<tr><td>${r.proposals ? `<a href="${relative(args.full)}/${r.label}/review.html">${r.label}</a>` : r.label}</td><td>${r.segmentsProcessed}/${r.segmentsTotal}</td><td>${r.memoRevisions}</td><td>${r.contributions}</td><td>${esc(r.status)}</td></tr>`,
  )
  .join('');
const cases = report.checkpointCases
  .map(
    (c) =>
      `<tr><td>${c.recording} / ${c.segmentId}</td><td>${c.memo ? esc(c.memo.text) : 'Gathering context / retained state; no accepted narrative'}</td><td><a href="${relative(c.root)}/${c.label}/review.html">Open both stage inputs and verdicts</a></td></tr>`,
  )
  .join('');
const html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Live memo v2 — review</title><style>body{font:16px/1.6 system-ui;margin:32px auto;max-width:1100px;padding:0 20px;color:#172a3b;background:#fff}a{color:#006b80}td,th{text-align:left;padding:12px;border-bottom:1px solid #dce6ed;vertical-align:top}table{width:100%;border-collapse:collapse}li{margin:10px 0}img{max-width:100%;height:auto}small{color:#526779}</style><h1>Pemahaman saat ini + kontribusi tambahan</h1><p><strong>${esc(report.evaluationStatus)}</strong>. Build kandidat belum diaktifkan di extension utama.</p><p>Total provider: <strong>${report.budget.used}/800</strong>. Versi ini memakai ${report.budget.v2Attempts} dari sisa 357 request yang disetujui. Ledger lama tetap dipakai.</p><h2>Replay berurutan</h2><table><tr><th>Rekaman</th><th>Segmen diproses</th><th>Memo baru</th><th>Kontribusi</th><th>Status</th></tr>${fullLinks}</table><p>NEW MEMO dan NEW CONTRIBUTION adalah perubahan yang tampil. Unchanged menunjuk ID yang sama; teks tersebut dipertahankan, tidak dibuat ulang. Nilai memo dan kontribusi lewat dropdown yang terpisah. Kedua input LLM, sumber, raw response, verdict, timing, token, dan kegagalan tersedia pada tiap baris.</p><p>Segmen diproses berarti cursor ingatan tahap pertama. Publikasi memo/kontribusi tetap memerlukan pemeriksaan; review terakhir 28-10 diblokir oleh batas evaluasi sebelum request upstream.</p><h2>17 checkpoint</h2><p>Termasuk tujuh checkpoint lama dan sepuluh interval lima menit. Link memakai retest terbaru untuk prefix yang sama; semua percobaan awal tetap disimpan.</p><table><tr><th>Rekaman / sumber</th><th>Memo diterima</th><th>Jejak data</th></tr>${cases}</table><h2>Skenario non-meeting</h2><ul>${report.syntheticCases.map((c) => `<li><a href="${relative(c.root)}/${c.label}/review.html">${c.label}</a> — ${c.memos} memo revisions; ${c.contributions.length} contributions.</li>`).join('')}</ul><h2>Bukti teknis</h2><ul><li><a href="verification.json">Integritas sumber, coverage, dan status parsial</a></li><li><a href="verification-final.log">Pemeriksaan proyek dan build</a></li><li><a href="ui/result.json">UI: independensi, sumber, feedback, history, fokus/scroll, tema, panel sempit, zoom 200%</a></li><li><a href="browser-pipeline/result.json">Chrome terisolasi: audio → VAD → ASR → protocol v2, Stop dan recovery</a></li><li><a href="../live-memo-v1/provider-budget.json">Ledger provider keseluruhan</a></li></ul><p><a href="review-focus.json">Catatan kualitas yang perlu lo cek</a>: khususnya istilah ASR ambigu yang ditafsirkan menjadi “riset” atau “lokal/DKI”, serta narasi yang mungkin masih terlalu panjang.</p><h2>Catatan review</h2><ul>${report.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>Memo: nilai akurasi, kejelasan, fokus saat ini, dan keterlambatan. Kontribusi: nilai manfaat tambahan, pengulangan, asumsi, dan waktu tampil. Review semua output baru terlebih dahulu; saat area tetap, periksa apakah mempertahankan teks/status masih membantu.</p><p><small>MOM tetap ditunda. Build berada di candidate-build/. Extension utama dan relay yang berjalan tidak di-reload/restart.</small></p></html>`;
await writeFile(base + '/review.html', html);
await writeFile(base + '/index.html', html);
await writeFile(
  base + '/REVIEW.md',
  `# Live memo v2 review\n\n${report.evaluationStatus}\n\nProvider attempts: ${report.budget.used}/800; v2: ${report.budget.v2Attempts}/357. No activation.\n\n${report.fullRuns.map((r) => `- ${r.label}: ${r.segmentsProcessed}/${r.segmentsTotal} segments, ${r.memoRevisions} memo revisions, ${r.contributions} contributions (${r.status}).`).join('\n')}\n\n[Open review](review.html). Includes 17 checkpoint cases, three non-meeting scenarios and full inputs/verdicts. Technical results: verification-final.log, ui/result.json, browser-pipeline/result.json.\n\n${report.limitations.map((s) => '- ' + s).join('\n')}\n`,
);
console.log(
  JSON.stringify(
    {
      evaluationStatus: report.evaluationStatus,
      budget: report.budget,
      fullRuns: report.fullRuns.map(({ publishedMemos, publishedContributions, ...r }) => r),
    },
    null,
    2,
  ),
);
