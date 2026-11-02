// Verify completed evidence and add playable exact ASR windows. No network calls.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { renderReplayReport } from './recording-replay-report.mjs';
const root = path.resolve(process.argv[2] || 'artifacts/recording-replay/baseline-2026-10-29');
const onlyLabel = process.argv[3];
const labels = onlyLabel ? [onlyLabel] : ['lemhanas-16-10', 'lemhanas-28-10'];
const runtime = path.join(root, 'finalizer-runtime.mjs');
await build({ stdin: { contents: `export {encodeWav} from './src/transcription/wav.ts'; export {validateAnalysis} from './src/assistant/schema.ts';`, resolveDir: process.cwd() }, outfile: runtime, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { encodeWav, validateAnalysis } = await import(runtime);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const results = [];
let credentials;
try { credentials = JSON.parse(await readFile('.local/deepinfra.json', 'utf8')); } catch {}
for (const label of labels) {
  assert.ok(['lemhanas-16-10', 'lemhanas-28-10'].includes(label));
  const folder = path.join(root, label);
  const report = JSON.parse(await readFile(path.join(folder, 'run.json'), 'utf8'));
  assert.ok(report.status !== 'running', 'Do not finalize a report while its replay is running');
  assert.equal(hash(await readFile(report.source)), report.sourceFileHash, 'Source recording changed');
  const bytes = await readFile(path.resolve('artifacts/recording-replay/cache', report.sourceFileHash + '.f32'));
  const source = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  assert.equal(hash(bytes.subarray(0, Math.round(report.durationMs * 16) * 4)), report.provenance.decodedPcmHash);
  await mkdir(path.join(folder, 'audio'), { recursive: true });
  const succeeded = report.asr.filter((a) => a.status === 'succeeded');
  const delivered = new Map(succeeded.filter((a) => a.segmentId !== undefined).map((a) => [a.segmentId, a]));
  let previousMemo = '';
  for (const note of report.notes) {
    assert.equal(note.input.previousSummary, previousMemo, 'Previous memo chain diverged');
    for (const s of note.input.segments) assert.ok(delivered.get(s.id)?.completedAtMs <= note.dispatchedAtMs, 'Future transcript leaked');
    if (note.result) validateAnalysis(note.result.analysis, note.input);
    if (note.decision?.accepted) previousMemo = note.decision.memo;
  }
  assert.equal(report.finalSnapshot?.summary || '', previousMemo);
  if (report.status === 'complete') {
    assert.deepEqual(succeeded.flatMap((a) => a.windowIds), report.windows.map((w) => w.id), 'Speech window coverage diverged');
    assert.equal(report.finalSnapshot.lastSegmentId, report.transcript.at(-1)?.id ?? -1, 'Final memo processing did not cover final transcript');
  }
  for (const a of report.asr) {
    const start = Math.round(a.startMs * 16), end = Math.round(a.endMs * 16);
    const audio = new Float32Array(end - start);
    audio.set(source.subarray(start, Math.min(end, Math.round(report.durationMs * 16))));
    a.reviewAudio = `audio/${start}-${end}.wav`;
    await writeFile(path.join(folder, a.reviewAudio), Buffer.from(encodeWav(audio)));
  }
  report.reviewVerification = { verifiedAt: new Date().toISOString(), previousMemoChain: true, noFutureTranscript: true, structuredResponsesValidated: true, sourceRecordingUnchanged: true, exactWindowWavClips: true, fullWindowCoverage: report.status === 'complete', reportRendererHash: hash(await readFile('scripts/recording-replay-report.mjs')) };
  await writeFile(path.join(folder, 'run.json'), JSON.stringify(report, null, 2));
  await renderReplayReport(report, path.join(folder, 'review.html'));
  for (const filename of ['run.json', 'review.html', 'final-notes.md']) {
    const text = await readFile(path.join(folder, filename), 'utf8');
    for (const secret of [credentials?.apiKey, credentials?.relayToken].filter(Boolean)) assert.ok(!text.includes(secret), 'Credential in report');
  }
  const outcomes = {};
  for (const note of report.notes) { const outcome = note.outcome || (note.error ? 'failed' : 'cancelled-or-pending'); outcomes[outcome] = (outcomes[outcome] || 0) + 1; }
  const row = { label, status: report.status, durationSeconds: report.durationMs / 1000, speechWindows: report.windows.length, asrAttempts: report.asr.length, transcriptSegments: report.transcript.length, notesAttempts: report.notes.length, outcomes, finalMemoCharacters: previousMemo.length, verified: true, report: path.join(folder, 'review.html') };
  results.push(row); console.log(JSON.stringify(row));
}
await writeFile(path.join(root, onlyLabel ? `${onlyLabel}-verification.json` : 'verification.json'), JSON.stringify(results, null, 2));
