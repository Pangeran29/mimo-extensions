// One-variable local diagnostic: same Whisper base checkpoint, q4 vs fp32 decoder.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withWhisperDebug } from './whisper-debug-browser.mjs';
import { audioStats } from './whisper-debug-metrics.mjs';
import { assessDecode } from './whisper-fallback-policy.mjs';
const root = path.resolve(process.argv[2] || 'artifacts/meeting-baseline');
const reference = await readFile(path.join(root, 'reference.json'));
const pilotBytes = await readFile(path.join(root, 'pilot.json'));
const pilot = JSON.parse(pilotBytes);
if (JSON.parse(reference).pilotHash !== createHash('sha256').update(pilotBytes).digest('hex'))
  throw Error('Reference does not match baseline');
const referenceHash = createHash('sha256').update(reference).digest('hex');
await writeFile(
  path.join(root, 'reference-frozen-' + referenceHash.slice(0, 12) + '.json'),
  reference,
);
const output = path.join(root, 'precision-eval.json');
const report = {
  kind: 'decoder-precision-diagnostic',
  complete: false,
  referenceHash,
  baselineHash: createHash('sha256').update(pilotBytes).digest('hex'),
  design: {
    model: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    variants: ['q4', 'fp32'],
    encoder: 'fp32',
    changedVariable: 'decoder precision only',
    cases: pilot.results.map((row) => ({
      role: row.role,
      startSeconds: row.startSeconds,
      inputHash: row.inputStats.sha256,
    })),
    selection:
      'All 18 frozen clips, including 5 reviewed no-speech controls; no reference words sent to either decoder.',
    limitation:
      'One meeting, six periods. Serial precision blocks with preparation excluded from inference; descriptive latency only. Not representative independent recordings or a rollout gate.',
    acceptance:
      'Keep production q4. Report whether full precision improves verified errors; no automatic switch or correction rules.',
  },
  variants: {},
};
await writeFile(output + '.plan.json', JSON.stringify(report, null, 2));
for (const decoderDtype of ['q4', 'fp32'])
  await withWhisperDebug(
    async ({ evaluate, load, modelWorkerHash, observerHash, evaluationWorkerHash, context }) => {
      const block = {
        load,
        modelWorkerHash,
        observerHash,
        evaluationWorkerHash,
        browser: context.browser().version(),
        results: [],
      };
      report.variants[decoderDtype] = block;
      for (const row of pilot.results) {
        const bytes = await readFile(row.pcm);
        if (audioStats(bytes).sha256 !== row.inputStats.sha256) throw Error('Input PCM changed');
        const entry = {
          role: row.role,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds,
          inputStats: row.inputStats,
        };
        try {
          const base64 = bytes.toString('base64');
          const output = await evaluate(`(async()=>{
        window.debugGenerations=[];
        const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));
        const result=await gateRequest('TRANSCRIBE',{audio:new Float32Array(bytes.buffer),sessionId:'meeting-precision'});
        return {result,generations:window.debugGenerations};
      })()`);
          Object.assign(entry, output, { assessment: assessDecode(output) });
          console.log(
            decoderDtype,
            row.startSeconds,
            row.role,
            output.result.language,
            Math.round(output.result.inferenceMs) + 'ms',
          );
        } catch (error) {
          entry.error = String(error);
        }
        block.results.push(entry);
        await writeFile(output, JSON.stringify(report, null, 2));
      }
    },
    { decoderDtype },
  );
report.complete = true;
await writeFile(output, JSON.stringify(report, null, 2));
