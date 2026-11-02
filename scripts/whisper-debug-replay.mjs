// Exact PCM replay; no LLM requests. Based on existing transcription-gate harness.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audioStats, compressionRatio, transformPcm, pcmWav } from './whisper-debug-metrics.mjs';
import { withWhisperDebug } from './whisper-debug-browser.mjs';
const inputReport = process.argv[2];
const outputReport = process.argv[3] || 'artifacts/whisper-debug-replay.json';
if (!inputReport)
  throw Error('Usage: node scripts/whisper-debug-replay.mjs CAPTURE.json [OUTPUT.json]');
await withWhisperDebug(async ({ evaluate, load, context, modelWorkerHash, observerHash }) => {
  const capture = JSON.parse(await readFile(inputReport, 'utf8'));
  const inputs = capture.asrDebug.filter((x) => x.kind === 'input');
  if (!inputs.length) throw Error('No exact PCM inputs in capture');
  const results = [];
  // Baseline repeats use identical bytes. Probes alter one decoding parameter.
  const first = inputs[0];
  const cases = [
    ...[1, 2, 3].map((n) => ({ label: `baseline-repeat-${n}`, input: first })),
    { label: 'token-cap-256', input: first, overrides: { max_new_tokens: 256 } },
    { label: 'repeat-ngram-3', input: first, overrides: { no_repeat_ngram_size: 3 } },
    { label: 'gain-times-two', input: first, gain: 2 },
    ...[32, 64, 128].map((ms) => ({ label: `prepend-${ms}ms-trim-tail`, input: first, shift: ms })),
    ...[2, 3].map((n) => ({ label: `shift-64ms-repeat-${n}`, input: first, shift: 64 })),
    { label: 'prepend-64ms-preserve-tail', input: first, prependMs: 64 },
    { label: 'trim-tail-64ms-only', input: first, trimTailMs: 64 },
    {
      label: 'shift-64ms-token-cap-256',
      input: first,
      shift: 64,
      overrides: { max_new_tokens: 256 },
    },
    {
      label: 'shift-64ms-repeat-ngram-3',
      input: first,
      shift: 64,
      overrides: { no_repeat_ngram_size: 3 },
    },
    ...inputs.slice(1).map((input, i) => ({ label: `other-window-${i + 1}`, input })),
    { label: 'silence-control', silence: true },
  ];
  for (const item of cases) {
    let bytes = item.silence ? Buffer.alloc(8 * 16000 * 4) : await readFile(item.input.pcm);
    if (item.input && audioStats(bytes).sha256 !== item.input.sha256)
      throw Error('PCM hash mismatch');
    const transformation = {
      gain: item.gain || 1,
      prependMs: item.shift || item.prependMs || 0,
      trimTailMs: item.shift || item.trimTailMs || 0,
    };
    bytes = transformPcm(bytes, transformation);
    let reviewAudio;
    if (item.label === 'prepend-64ms-preserve-tail') {
      reviewAudio = path.resolve(outputReport + '.boundary-repro.wav');
      await writeFile(reviewAudio, pcmWav(bytes));
    }
    const b64 = bytes.toString('base64');
    const output = await evaluate(`(async()=>{
      window.debugGenerations=[];
      const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
      const result=await gateRequest('TRANSCRIBE',{
        audio:new Float32Array(bytes.buffer), sessionId:'debug-replay',
        debugOverrides:${JSON.stringify(item.overrides || {})}
      });
      return {result,generations:window.debugGenerations};
    })()`);
    const result = {
      label: item.label,
      input: item.input?.pcm || '8s digital silence',
      inputStats: audioStats(bytes),
      transformation,
      reviewAudio,
      overrides: item.overrides || {},
      ...output,
      compressionRatio: compressionRatio(output.result.text),
    };
    console.log(JSON.stringify(result));
    results.push(result);
    await writeFile(
      outputReport,
      JSON.stringify(
        {
          kind: 'local-ASR-replay',
          sourceCapture: path.resolve(inputReport),
          scope:
            'Exact captured PCM; production model and processor; bypasses live capture/VAD; diagnostic probes are NOT production changes or proven accuracy improvements',
          browser: context.browser().version(),
          modelWorkerHash,
          observerHash,
          load,
          results,
        },
        null,
        2,
      ),
    );
  }
});
