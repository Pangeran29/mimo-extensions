// Local baseline only. Source labels come from files, not inferred speakers.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withWhisperDebug } from './whisper-debug-browser.mjs';
import { audioStats, pcmWav } from './whisper-debug-metrics.mjs';
import { assessDecode } from './whisper-fallback-policy.mjs';
const intakePath = process.argv[2] || 'artifacts/meeting-baseline/intake.json';
const intakeBytes = await readFile(intakePath);
const intake = JSON.parse(intakeBytes);
const root = path.dirname(path.resolve(intakePath));
const output = path.join(root, 'pilot.json');
const report = {
  kind: 'private-meeting-baseline-pilot',
  complete: false,
  scope:
    'Re-decoded exported Opus, six energy-selected eight-second windows, three source files. Bypasses live capture/VAD. Machine drafts are not reference transcripts or accuracy measurements.',
  intakeHash: createHash('sha256').update(intakeBytes).digest('hex'),
  scriptHash: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex'),
  referenceStatus: 'PENDING HUMAN VERIFICATION',
  policy:
    'Production baseline, no retry or model change. No LLM calls or training. Unselected audio held out.',
  selection: intake.pilotSelection,
  results: [],
};
await writeFile(output + '.plan.json', JSON.stringify(report, null, 2));
await withWhisperDebug(async ({ evaluate, load, context, modelWorkerHash, observerHash }) => {
  Object.assign(report, {
    load,
    browser: context.browser().version(),
    modelWorkerHash,
    observerHash,
  });
  for (const [index, window] of intake.pilotSelection.entries()) {
    const roles = ['tab', 'microphone', 'combined'];
    // Rotate execution order; labels remain explicit and are not quality claims.
    const order = roles.slice(index % 3).concat(roles.slice(0, index % 3));
    for (const role of order) {
      const name = String(window.startSeconds).padStart(4, '0') + '-' + role;
      const file = path.join(root, name + '.f32');
      const bytes = await readFile(file);
      const row = {
        role,
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        category: window.category,
        inputStats: audioStats(bytes),
        pcm: file,
        reviewAudio: path.join(root, name + '.wav'),
        reference: null,
      };
      await writeFile(row.reviewAudio, pcmWav(bytes));
      try {
        const encoded = bytes.toString('base64');
        const result = await evaluate(`(async()=>{
          window.debugGenerations=[];
          const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
          const result=await gateRequest('TRANSCRIBE',{audio:new Float32Array(bytes.buffer),sessionId:'meeting-pilot'});
          return {result,generations:window.debugGenerations};
        })()`);
        Object.assign(row, result, { assessment: assessDecode(result) });
        console.log(
          role,
          window.startSeconds,
          JSON.stringify({
            language: result.result.language,
            chars: result.result.text.length,
            flagged: row.assessment.flagged,
          }),
        );
      } catch (error) {
        row.error = String(error);
      }
      report.results.push(row);
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  }
  report.complete = true;
  await writeFile(output, JSON.stringify(report, null, 2));
});
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
let review =
  '# Private meeting pilot: reference review\n\nMachine drafts below are unverified. Listen to the source audio and fill reference text before scoring. Preserve uncertain words as uncertain; do not copy model guesses into the reference.\n\n';
for (const window of intake.pilotSelection) {
  review += `## ${clock(window.startSeconds)}–${clock(window.endSeconds)}\n\nEnergy selection: ${window.category}; this does not identify speakers or confirm simultaneous speech.\n\n`;
  for (const row of report.results.filter((r) => r.startSeconds === window.startSeconds)) {
    review += `### ${row.role}\n\n[Review audio](<${row.reviewAudio}>)\n\nDraft: ${row.result?.text || '(empty or failed)'}\n\nVerified transcript: **PENDING**\n\nUncertain words / names / numbers / overlapping speech: **PENDING**\n\n`;
  }
}
await writeFile(path.join(root, 'REFERENCE-REVIEW.md'), review);
