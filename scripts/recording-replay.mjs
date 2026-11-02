// Recorded-audio baseline evaluation; never changes dist/, production settings, or the running relay.
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { createRelay } from '../server/relay.mjs';
import { ReplayClock } from './recording-replay-clock.mjs';
import { renderReplayReport } from './recording-replay-report.mjs';

const { values: options } = parseArgs({ options: {
  run: { type: 'boolean' }, offline: { type: 'boolean' },
  recording: { type: 'string' }, 'limit-seconds': { type: 'string' },
  output: { type: 'string', default: 'artifacts/recording-replay/baseline-2026-10-29' },
} });
const limit = options['limit-seconds'] === undefined ? Infinity : Number(options['limit-seconds']);
if (!(limit > 0)) throw Error('limit-seconds must be positive');
const root = path.resolve(options.output);
const cache = path.resolve('artifacts/recording-replay/cache');
await mkdir(root, { recursive: true });
await mkdir(cache, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const require = createRequire(import.meta.url);
const sourceFiles = ['src/transcription/segmenter.ts', 'src/transcription/batch.ts', 'src/transcription/client.ts', 'src/transcription/wav.ts', 'src/assistant/controller.ts', 'src/assistant/provider.ts', 'src/assistant/prompt.ts', 'src/assistant/schema.ts', 'src/assistant/types.ts', 'src/assistant/timing.ts', 'src/assistant/errors.ts', 'src/assistant/summaries.ts', 'server/notes.mjs', 'server/relay.mjs', 'scripts/recording-replay.mjs', 'scripts/recording-replay-clock.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (f) => [f, hash(await readFile(f))])));
const sourceHash = hash(JSON.stringify(sourceHashes));
const labels = options.recording ? [options.recording] : ['lemhanas-16-10', 'lemhanas-28-10'];
for (const label of labels) if (!['lemhanas-16-10', 'lemhanas-28-10'].includes(label)) throw Error('Unknown recording');
const config = options.offline ? { apiKey: 'synthetic', relayToken: 'synthetic' } : JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
const counts = { asr: 0, notes: 0, cached: 0 };
const relay = createRelay({ ...config, providerFetch: async (...args) => {
  const kind = String(args[0]).includes('/v1/inference/') ? 'asr' : 'notes';
  counts[kind]++;
  if (counts.asr + counts.notes > 1800) throw Error('Evaluation request ceiling reached');
  if (!options.offline) return fetch(...args);
  if (kind === 'asr') return Response.json({ text: 'Synthetic evaluation fixture: the team proposes reviewing the plan tomorrow.', inference_status: { status: 'succeeded' }, language: 'en' });
  const body = JSON.parse(args[1].body);
  const context = JSON.parse(body.messages[1].content);
  const id = context.newTranscript.at(-1)?.id ?? 0;
  const text = JSON.stringify({ summary: '# Synthetic evaluation\nThe team proposes reviewing the plan tomorrow.', updates: [{ kind: 'fact', key: 'review-proposal', text: 'Reviewing the plan tomorrow is proposed.', evidenceSegmentIds: [id] }], question: null });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
const runtime = path.join(root, 'runtime.mjs');
await build({ stdin: { contents: `export {AssistantController} from './src/assistant/controller.ts'; export {analyze} from './src/assistant/provider.ts'; export {messages} from './src/assistant/prompt.ts'; export {SpeechSegmenter,removeOverlap} from './src/transcription/segmenter.ts'; export {selectBatch} from './src/transcription/batch.ts'; export {ModelClient} from './src/transcription/client.ts'; export {DEFAULT_SETTINGS,DEEPINFRA_MODEL} from './src/assistant/types.ts';`, resolveDir: process.cwd() }, outfile: runtime, bundle: true, platform: 'node', format: 'esm', packages: 'external', define: {
  LISTEN_TRANSCRIPTION_URL: JSON.stringify(relayOrigin + '/transcribe'), LISTEN_RELAY_TOKEN: JSON.stringify(config.relayToken),
}, plugins: [{ name: 'evaluation-clock-and-capture', setup(b) {
  b.onLoad({ filter: /assistant\/controller\.ts$/ }, async ({ path: file }) => ({ contents: `const {setTimeout,clearTimeout}=globalThis.replayClock; const Date={now:()=>globalThis.replayClock.now};\n${await readFile(file, 'utf8')}`, loader: 'ts' }));
  b.onLoad({ filter: /src\/agent-diagnostics\.ts$/ }, () => ({ contents: 'export const agentEvent=(...args)=>globalThis.replayCapture?.(...args);', loader: 'ts' }));
} }] });
// The isolated bundle has a local token, as the extension does; never a provider API key.
const clock = new ReplayClock();
globalThis.replayClock = clock;
const runtimeAPI = await import(runtime);
const { SpeechSegmenter, removeOverlap, selectBatch, AssistantController, ModelClient, analyze, messages, DEFAULT_SETTINGS, DEEPINFRA_MODEL } = runtimeAPI;
const ort = require(require.resolve('onnxruntime-web/wasm', { paths: [require.resolve('@ricky0123/vad-web')] }));
ort.env.wasm.numThreads = 1;
const { SileroV5 } = require('@ricky0123/vad-web/dist/models/v5');
const vadBytes = await readFile(require.resolve('@ricky0123/vad-web/dist/silero_vad_v5.onnx'));
let vad;
const index = { createdAt: new Date().toISOString(), sourceHash, mode: options.offline ? 'SYNTHETIC transport verification' : 'LIVE recorded-audio baseline', recordings: [] };
const flushMicrotasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

try {
  for (const label of labels) {
    clock.now = 0; clock.events.clear();
    const folder = path.resolve('training:meeting', label);
    const name = (await readdir(folder)).find((f) => f.endsWith('-combined.webm'));
    const source = path.join(folder, name);
    const sourceFileHash = hash(await readFile(source));
    const decoded = path.join(cache, `${sourceFileHash}.f32`);
    try { await readFile(decoded); } catch {
      const ffmpeg = process.env.LISTEN_FFMPEG_PATH || path.resolve('artifacts/meeting-audio-tools/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1');
      const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', decoded], { encoding: 'utf8' });
      if (result.status !== 0) throw Error('Decode failed: ' + result.stderr);
    }
    const bytes = await readFile(decoded);
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice(0, Math.floor(limit * 16000));
    const durationMs = pcm.length / 16;
    const windowKey = hash(JSON.stringify({ sourceFileHash, samples: pcm.length, segmenter: sourceHashes['src/transcription/segmenter.ts'], vad: hash(vadBytes) }));
    const windowPath = path.join(cache, `${windowKey}.windows.json`);
    let windows;
    try { windows = JSON.parse(await readFile(windowPath, 'utf8')); } catch {
      vad ??= await SileroV5.new(ort, async () => vadBytes.buffer.slice(vadBytes.byteOffset, vadBytes.byteOffset + vadBytes.byteLength));
      vad.reset_state(); windows = [];
      const segmenter = new SpeechSegmenter((w) => windows.push({ id: windows.length, startSample: w.startSample, endSample: w.endSample, overlap: w.overlap }));
      console.log(JSON.stringify({ label, stage: 'detecting-speech', durationMs }));
      for (let at = 0; at < pcm.length; at += 512) {
        const frame = new Float32Array(512); frame.set(pcm.subarray(at, at + 512));
        const p = await vad.process(frame); segmenter.push(frame, p.isSpeech);
      }
      segmenter.flush();
      await writeFile(windowPath, JSON.stringify(windows));
    }
    const output = path.join(root, label); await mkdir(output, { recursive: true });
    const report = { label, source, sourceFileHash, durationMs, status: options.run ? 'running' : 'prepared; no inference requested',
      scope: 'Recorded combined audio decoded to 16 kHz mono; production Silero V5 and SpeechSegmenter, serial Qwen ASR with queued-window merging capped at 16 seconds, current notes controller/prompt/schema and real DeepSeek via an isolated authenticated relay. Virtual source/controller clock skips idle time; real request durations determine simulated delivery. Excludes browser capture, resampler equivalence, durable outbox/restart, rendering, and acoustic quality assessment. No model training or prompt tuning.',
      provenance: { sourceHash, sourceHashes, sourceFileHash, decodedPcmHash: hash(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)), vadHash: hash(vadBytes), mode: index.mode, limitSeconds: Number.isFinite(limit) ? limit : null, batchSeconds: 16, memoPolicy: 'baseline', model: DEEPINFRA_MODEL, reasoningEffort: 'none', objective: DEFAULT_SETTINGS.goal, transcriptContextSeconds: 90, approximateTranscriptTokenCap: 2500, createdAt: new Date().toISOString() }, windows, asr: [], notes: [], transcript: [], finalSnapshot: null };
    const checkpoint = async () => {
      await writeFile(path.join(output, 'run.json.tmp'), JSON.stringify(report, null, 2));
      await rename(path.join(output, 'run.json.tmp'), path.join(output, 'run.json'));
      await renderReplayReport(report, path.join(output, 'review.html'));
      await writeFile(path.join(output, 'final-notes.md'), `# ${label}\n\nStatus: ${report.status}. Machine output; human review pending.\n\n${report.finalSnapshot?.summary || '(No accepted memo)' }\n`);
    };
    await checkpoint();
    index.recordings.push({ label, durationMs, windows: windows.length, review: `${label}/review.html`, status: report.status });
    await writeFile(path.join(root, 'index.json'), JSON.stringify(index, null, 2));
    console.log(JSON.stringify({ label, stage: 'prepared', durationMs, windows: windows.length, run: !!options.run }));
    if (!options.run) continue;
    const pendingNetwork = new Set();
    let controller, asrBusy = false, sourceEnded = false, finishing = false, terminal = false;
    const queue = [];
    const notesById = new Map();
    let networkError;
    const timed = (task, done) => {
      const virtualStart = clock.now;
      const realStart = performance.now();
      let promise;
      promise = (async () => {
        let value, error;
        try { value = await task(); } catch (e) { error = e; }
        const elapsed = Math.max(1, performance.now() - realStart);
        clock.at(virtualStart + elapsed, () => done(value, error, elapsed));
      })().finally(() => pendingNetwork.delete(promise));
      pendingNetwork.add(promise);
    };
    globalThis.replayCapture = (_sessionId, kind, data, requestId) => {
      const row = notesById.get(requestId);
      if (kind === 'decision' && row) { row.decision = structuredClone(data); row.outcome = data.outcome; }
    };
    const runner = { close() {}, request(type, model, input, signal) {
      if (type !== 'ANALYZE') throw Error('Only automatic baseline analysis supported');
      const row = { requestId: input.requestId, dispatchedAtMs: clock.now, input: structuredClone(input), messages: messages(input) };
      report.notes.push(row); notesById.set(input.requestId, row);
      return new Promise((resolve, reject) => timed(async () => {
        const result = await analyze(config.relayToken, model, input, signal, 'deepinfra', (kind, data) => {
          if (kind === 'request') row.requestBody = structuredClone(data);
          if (kind === 'response') { row.rawResponse = data.text; row.transport = data; }
        });
        row.result = result;
        return result;
      }, (result, error, elapsed) => {
        row.networkMs = elapsed; row.completedAtMs = clock.now;
        if (error) { row.error = { name: error.name, message: error.message, reason: error.reason, category: error.category, validationIssues: error.validationIssues }; reject(error); }
        else resolve(result);
      }));
    } };
    controller = new AssistantController(runner, (snapshot) => {
      report.finalSnapshot = structuredClone(snapshot);
      const row = notesById.get(snapshot.lastAnalysis?.requestId);
      if (row) { row.memoryAfter = structuredClone(snapshot.memory); row.questionAfter = structuredClone(snapshot.question); }
    }, async () => {}, () => {});
    controller.configure({ ...DEFAULT_SETTINGS, enabled: true, provider: 'deepinfra', model: DEEPINFRA_MODEL });
    const sessionId = `replay-${label}-${sourceFileHash.slice(0, 12)}`;
    const transcriptState = () => ({ sessionId, segments: report.transcript, phase: sourceEnded ? 'finishing' : 'transcribing', incomplete: false, lagMs: 0, modelReady: true });
    const client = new ModelClient(); await client.prepare();
    const finishIfDrained = () => {
      if (sourceEnded && !asrBusy && !queue.length && !finishing) { finishing = true; controller.finish(); }
    };
    let batch, retries = 0;
    const pump = () => {
      if (asrBusy || !queue.length || terminal) return finishIfDrained();
      batch ??= selectBatch(queue, 16); asrBusy = true;
      const current = batch;
      const row = { windowIds: current.jobs.map((w) => w.id), startMs: current.startSample / 16, endMs: current.endSample / 16, dispatchedAtMs: clock.now, status: 'pending' };
      report.asr.push(row);
      timed(async () => {
        const key = hash(Buffer.concat([Buffer.from('Qwen/Qwen3-ASR-0.6B:float32-wav:v1:'), Buffer.from(current.audio.buffer, current.audio.byteOffset, current.audio.byteLength)]));
        const filename = path.join(cache, `${key}.asr.json`);
        if (!options.offline) try { const cached = JSON.parse(await readFile(filename, 'utf8')); row.cached = true; counts.cached++; row.originalNetworkMs = cached.networkMs; return cached.result; } catch {}
        const start = performance.now(); const result = await client.transcribe(current.audio, sessionId);
        if (!options.offline) await writeFile(filename, JSON.stringify({ result, networkMs: performance.now() - start }));
        return result;
      }, (result, error, elapsed) => {
        asrBusy = false; row.networkMs = row.originalNetworkMs || elapsed;
        // Cached recognition retains its original measured delivery delay.
        const deliver = () => {
          row.completedAtMs = clock.now;
          if (error) {
            row.status = 'failed'; row.error = error.message;
            if (++retries > 5) { terminal = true; networkError = Error('ASR failed six consecutive attempts; retained partial report'); return; }
            clock.setTimeout(pump, Math.min(30000, 2000 * 2 ** (retries - 1))); return;
          }
          retries = 0; row.status = 'succeeded'; row.rawText = result.text;
          row.text = removeOverlap(report.transcript.at(-1)?.text || '', result.text, current.overlap);
          if (row.text) { row.segmentId = report.transcript.length; report.transcript.push({ id: row.segmentId, sessionId, startMs: row.startMs, endMs: row.endMs, text: row.text }); controller.observe(transcriptState()); }
          queue.splice(0, current.jobs.length); batch = undefined; pump(); finishIfDrained();
        };
        if (row.cached && row.originalNetworkMs > elapsed) { asrBusy = true; clock.setTimeout(() => { asrBusy = false; deliver(); }, row.originalNetworkMs - elapsed); }
        else deliver();
      });
    };
    for (const w of windows) clock.at(w.endSample / 16, () => {
      const audio = new Float32Array(w.endSample - w.startSample); audio.set(pcm.subarray(w.startSample, Math.min(w.endSample, pcm.length)));
      queue.push({ ...w, audio, sessionId }); pump();
    });
    clock.at(Math.max(durationMs, windows.at(-1)?.endSample / 16 || 0), () => { sourceEnded = true; finishIfDrained(); });
    let lastCheckpoint = 0;
    try {
      while (!terminal) {
        await flushMicrotasks();
        if (pendingNetwork.size) { await Promise.all([...pendingNetwork]); await flushMicrotasks(); }
        if (!clock.next()) { await flushMicrotasks(); if (!pendingNetwork.size && !clock.events.size) break; }
        if (performance.now() - lastCheckpoint > 5000) {
          await flushMicrotasks(); await checkpoint(); lastCheckpoint = performance.now();
          console.log(JSON.stringify({ label, stage: 'replay', audioTimeSeconds: Math.round(clock.now / 1000), durationSeconds: Math.round(durationMs / 1000), asr: report.asr.length, notes: report.notes.length, memoCharacters: report.finalSnapshot?.summary.length || 0, counts }));
        }
        if (report.notes.length > windows.length * 3 + 20) throw Error('Notes retry ceiling reached');
      }
      if (networkError) throw networkError;
      await flushMicrotasks();
      if (queue.length || !sourceEnded || pendingNetwork.size) throw Error('Replay ended before draining');
      report.status = report.finalSnapshot?.incomplete || report.finalSnapshot?.phase === 'paused' ? 'completed with incomplete notes' : 'complete';
    } catch (e) { report.status = 'failed; partial evidence retained'; report.error = e.message; }
    client.terminate(); report.provenance.finishedAt = new Date().toISOString();
    report.provenance.networkCountsAtFinish = { ...counts }; report.replayEndMs = clock.now;
    await checkpoint();
    Object.assign(index.recordings.at(-1), { status: report.status, asrAttempts: report.asr.length, notesAttempts: report.notes.length, transcriptSegments: report.transcript.length });
    await writeFile(path.join(root, 'index.json'), JSON.stringify(index, null, 2));
    console.log(JSON.stringify({ label, stage: 'finished', status: report.status, counts }));
  }
} finally { await vad?.release(); relay.closeAllConnections(); await new Promise((r) => relay.close(r)); }
await writeFile(path.join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Recorded audio baseline</title><style>body{font:17px/1.6 system-ui;max-width:1000px;margin:48px auto;padding:20px}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ccd4d5;text-align:left}a{color:#006a76}</style><h1>Recorded audio baseline</h1><p>${index.mode}. Current production notes behavior; no prompt tuning. Open each report to review the complete transcript-to-context-to-memo sequence.</p><table><tr><th>Recording</th><th>Duration</th><th>Status</th><th>Review</th></tr>${index.recordings.map((r) => `<tr><td>${r.label}</td><td>${(r.durationMs / 60000).toFixed(2)} min</td><td>${r.status}</td><td><a href="${r.review}">Open sequence table</a></td></tr>`).join('')}</table>`);
console.log(JSON.stringify({ review: path.join(root, 'index.html'), counts }));
