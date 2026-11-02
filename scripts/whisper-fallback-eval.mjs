// Same pinned production worker; isolated extension; no LLM calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { withWhisperDebug } from './whisper-debug-browser.mjs';
import { audioStats, transformPcm } from './whisper-debug-metrics.mjs';
import { FALLBACK_POLICY, assessDecode, decodeWithFallback } from './whisper-fallback-policy.mjs';
const output = process.argv[2] || 'artifacts/whisper-fallback-eval.json';
const manifestBytes = await readFile('artifacts/latency-corpus/manifest.json');
const manifest = JSON.parse(manifestBytes);
const captureBytes = await readFile('artifacts/whisper-debug-podcast.json');
const capture = JSON.parse(captureBytes);
const sourceHash = createHash('sha256');
for (const file of [
  'whisper-fallback-eval.mjs',
  'whisper-fallback-policy.mjs',
  'whisper-debug-browser.mjs',
  'whisper-debug-worker.js',
  'whisper-debug-metrics.mjs',
])
  sourceHash.update(file).update(await readFile('scripts/' + file));
const bundle = await build({
  stdin: {
    contents: "export {removeOverlap} from './src/transcription/segmenter.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { removeOverlap } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
);
let state = 20261023;
const nextSeed = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
};
const pairs = [];
for (const clip of manifest.clips)
  for (const prependMs of [0, 64]) {
    pairs.push({
      id: clip.id + (prependMs ? '-leading64' : ''),
      clip,
      prependMs,
      cohort: prependMs ? 'alignment-stress' : 'read-speech',
      order: nextSeed() >= 0x80000000 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
      seed: nextSeed(),
    });
  }
const first = capture.asrDebug.find((x) => x.kind === 'input');
for (const seed of [11, 22, 33, 44, 55])
  pairs.push({
    id: 'podcast-leading64-seed-' + seed,
    pcm: first,
    prependMs: 64,
    cohort: 'podcast-diagnostic',
    seed,
    order: seed % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
  });
pairs.push({
  id: 'digital-silence',
  cohort: 'silence-control',
  silence: true,
  prependMs: 0,
  seed: 66,
  order: ['baseline', 'candidate'],
});
const report = {
  kind: 'offline-ASR-fallback-evaluation',
  startedAt: new Date().toISOString(),
  complete: false,
  policy: FALLBACK_POLICY,
  manifestHash: createHash('sha256').update(manifestBytes).digest('hex'),
  captureHash: createHash('sha256').update(captureBytes).digest('hex'),
  harnessHash: sourceHash.digest('hex'),
  design: {
    seed: 20261023,
    pairs: pairs.map(({ id, cohort, seed, order, prependMs }) => ({
      id,
      cohort,
      seed,
      order,
      prependMs,
    })),
    primary: '20 read-speech controls; 10 Indonesian and 10 English',
    secondary:
      'Same 20 clips with leading 64ms silence; five stochastic seeds of one podcast window; digital silence',
    segmentation:
      'Offline 8s windows, 1s overlap; production overlap cleanup. Does not exercise VAD or real-time capture.',
    acceptance:
      'Do not enable from this evaluation alone. Require lower errors on triggered reference cases, no aggregate WER regression on clean controls, bounded extra inference, and verified natural-speech review.',
    normalization:
      'Jiwer literal WER: Unicode punctuation replaced with spaces; lowercase; whitespace collapsed. No number expansion or spelling repair.',
    failureHandling:
      'Retain baseline if both retries fail structural checks or error; report unresolved. Never select by reference transcript.',
    warning:
      'EOS/repetition checks are structural and do not establish factual accuracy. Seeded repeats are not independent recordings.',
  },
  results: [],
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
// Freeze plan before any model evaluation output is observed.
await writeFile(output + '.plan.json', JSON.stringify(report, null, 2));
await withWhisperDebug(async ({ evaluate, load, context, modelWorkerHash, observerHash }) => {
  Object.assign(report, {
    load,
    browser: context.browser().version(),
    modelWorkerHash,
    observerHash,
  });
  async function decode(bytes, overrides = {}, seed = 1) {
    const base64 = bytes.toString('base64');
    return evaluate(`(async()=>{
      window.debugGenerations=[];
      const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));
      const result=await gateRequest('TRANSCRIBE',{audio:new Float32Array(bytes.buffer),sessionId:'fallback-eval',
        debugOverrides:${JSON.stringify(overrides)},debugSeed:${seed}});
      return {result,generations:window.debugGenerations};
    })()`);
  }
  for (const pair of pairs) {
    const row = {
      id: pair.id,
      cohort: pair.cohort,
      order: pair.order,
      seed: pair.seed,
      reference: pair.clip?.reference ?? null,
      language: pair.clip?.language ?? null,
      variants: {},
    };
    try {
      let pcm;
      if (pair.silence) pcm = Buffer.alloc(8 * 16000 * 4);
      else if (pair.pcm) {
        pcm = await readFile(pair.pcm.pcm);
        if (audioStats(pcm).sha256 !== pair.pcm.sha256) throw Error('Captured PCM hash mismatch');
      } else {
        const wav = await readFile(pair.clip.audio);
        if (createHash('sha256').update(wav).digest('hex') !== pair.clip.sha256)
          throw Error('Fixture hash mismatch');
        // Chrome decodes native WAV data; reference is never sent to the model.
        const encoded = wav.toString('base64');
        const base64 = await evaluate(`(async()=>{
          const c=new AudioContext({sampleRate:16000});
          try {
            const data=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
            const decoded=await c.decodeAudioData(data.buffer);
            if(decoded.sampleRate!==16000||decoded.numberOfChannels!==1)throw Error('Expected 16k mono');
            const bytes=new Uint8Array(decoded.getChannelData(0).buffer);let binary='';
            for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            return btoa(binary);
          } finally {await c.close();}
        })()`);
        pcm = Buffer.from(base64, 'base64');
      }
      pcm = transformPcm(pcm, { prependMs: pair.prependMs });
      row.inputStats = audioStats(pcm);
      for (const variant of pair.order) {
        const result = {
          windows: [],
          text: '',
          elapsedMs: 0,
          inferenceMs: 0,
          retries: 0,
          unresolvedWindows: 0,
        };
        row.variants[variant] = result;
        let previous = '';
        const started = performance.now();
        for (let at = 0; at < pcm.length; at += 7 * 16000 * 4) {
          // No reference or future-window transcript can enter a decode.
          const bytes = pcm.subarray(at, Math.min(at + 8 * 16000 * 4, pcm.length));
          if (at && bytes.length < 1600 * 4) break;
          let window;
          if (variant === 'candidate')
            window = await decodeWithFallback(
              (overrides, seed) => decode(bytes, overrides, seed),
              (pair.seed + at) >>> 0,
            );
          else {
            const initial = await decode(bytes, {}, (pair.seed + at) >>> 0);
            window = {
              attempts: [{ ...initial, assessment: assessDecode(initial), overrides: {} }],
              selected: 0,
              unresolved: false,
            };
          }
          const selected = window.attempts[window.selected];
          const text = removeOverlap(previous, selected.result.text, at > 0);
          if (text) previous = text;
          result.text = [result.text, text].filter(Boolean).join(' ');
          result.inferenceMs += window.attempts.reduce(
            (sum, a) => sum + (a.result?.inferenceMs || 0),
            0,
          );
          result.retries += window.attempts.length - 1;
          result.unresolvedWindows += Number(window.unresolved);
          result.windows.push({ atSample: at / 4, inputStats: audioStats(bytes), ...window });
          if (at + 8 * 16000 * 4 >= pcm.length) break;
        }
        result.elapsedMs = performance.now() - started;
      }
      console.log(
        row.id,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row.variants).map(([k, v]) => [k, { retries: v.retries, text: v.text }]),
          ),
        ),
      );
    } catch (error) {
      row.error = String(error);
    }
    report.results.push(row);
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  report.complete = true;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
});
