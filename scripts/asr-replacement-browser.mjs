// Candidate-only browser worker experiment; production source remains unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withWhisperDebug } from './whisper-debug-browser.mjs';
const work = path.resolve('artifacts/asr-replacement');
const bundle = path.resolve('training:meeting/verified-excerpts-v1-76136748b154');
const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json')));
const hash = (x) => createHash('sha256').update(x).digest('hex');
if (hash(await readFile(path.join(bundle, 'reference.json'))) !== manifest.referenceHash)
  throw Error('Frozen reference changed');
const candidate = JSON.parse(await readFile(path.join(work, 'candidate-revisions.json')))[3];
const localAssets = path.join(work, 'models/whisper-large-v3-turbo');
const files = JSON.parse(await readFile(path.join(work, 'upstream-file-hashes.json')))[3].files;
for (const name of ['onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx']) {
  const bytes = await readFile(path.join(localAssets, name));
  const expected = files.find((f) => f.path === name);
  if (bytes.length !== expected.size || hash(bytes) !== expected.lfs.sha256)
    throw Error('Checkpoint checksum mismatch: ' + name);
}
const report = {
  variant: 'whisper-turbo-q4', complete: false, checkpoint: candidate,
  referenceHash: manifest.referenceHash,
  design: {
    encoder: 'q4', decoder: 'q4', languageChoices: ['id', 'en', 'zh'], maxNewTokens: 128,
    scope: 'Six periods, 18 representations, one meeting. Mandarin capability untested.',
    latency: 'Full 8-second PCM at dispatch to complete ASR reply, not visible notes.',
    baseline: 'Saved production-base outputs; latency comparisons across runtimes are descriptive.',
    preparation: 'Pinned SHA256-verified weights staged inside isolated evaluation extension through Transformers.js localModelPath. Remote model loads disabled. Load time excludes public checkpoint download.',
    changes: 'Candidate model, encoder precision, and id/en/zh language candidates; maintained Transformers.js 3.8.1 WebGPU pipeline.',
  }, results: [],
};
const destination = path.join(work, 'whisper-turbo-q4.json');
await writeFile(destination, JSON.stringify(report, null, 2), { flag: 'wx' });
try {
  await withWhisperDebug(async ({ evaluate, load, context, ...hashes }) => {
    Object.assign(report, { load, browser: context.browser().version(), hashes });
    for (const clip of manifest.clips) {
      const pcm = await readFile(path.join(bundle, clip.pcm));
      if (hash(pcm) !== clip.inputHash) throw Error('Frozen audio changed');
      const row = { role: clip.role, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds,
        inputStats: { sha256: clip.inputHash } };
      try {
        Object.assign(row, await evaluate(`(async()=>{
          window.debugGenerations=[];
          const bytes=Uint8Array.from(atob(${JSON.stringify(pcm.toString('base64'))}),c=>c.charCodeAt(0));
          const result=await gateRequest('TRANSCRIBE',{audio:new Float32Array(bytes.buffer),sessionId:'replacement-eval'});
          return {result,generations:window.debugGenerations};
        })()`, 180000));
      } catch (error) { row.error = String(error); }
      report.results.push(row);
      await writeFile(destination, JSON.stringify(report, null, 2));
      console.log(clip.id, row.result?.inferenceMs ?? row.error);
    }
    report.complete = true;
  }, { replacement: { ...candidate, encoderDtype: 'q4', localAssets }, prepareTimeoutMs: 300000 });
} catch (error) { report.runError = String(error); throw error; }
finally { await writeFile(destination, JSON.stringify(report, null, 2)); }
