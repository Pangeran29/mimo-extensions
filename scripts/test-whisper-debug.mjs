import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { audioStats, compressionRatio, pcmWav, transformPcm } from './whisper-debug-metrics.mjs';
import { assessDecode, decodeWithFallback } from './whisper-fallback-policy.mjs';

const pcm = Buffer.alloc(12);
[0.5, -0.5, 0].forEach((x, i) => pcm.writeFloatLE(x, i * 4));
assert.equal(audioStats(pcm).rms, Math.sqrt(0.5 / 3));
assert.equal(audioStats(pcm).nonzero, 2);
assert.equal(audioStats(pcm).clipped, 0);
const bad = Buffer.alloc(8);
bad.writeFloatLE(NaN);
bad.writeFloatLE(1.2, 4);
assert.equal(audioStats(bad).nonFinite, 1);
assert.equal(audioStats(bad).clipped, 1);
assert.throws(() => audioStats(Buffer.alloc(3)));
assert.ok(compressionRatio('Terima kasih. '.repeat(30)) > 2.4);
assert.ok(compressionRatio('Hari ini kita membahas agenda rapat.') < 2.4);
assert.equal(pcmWav(pcm).readUInt16LE(20), 3);
assert.deepEqual(pcmWav(pcm).subarray(44), pcm);
const shifted = transformPcm(pcm, { prependMs: 1 });
assert.deepEqual(shifted.subarray(64), pcm);
assert.deepEqual(shifted.subarray(0, 64), Buffer.alloc(64));
assert.deepEqual(transformPcm(shifted, { trimTailMs: 1 }), shifted.subarray(0, 12));
assert.equal(transformPcm(pcm, { gain: 2 }).readFloatLE(0), 1);
assert.throws(() => transformPcm(pcm, { trimTailMs: 1 }));

// The actual native transfer detaches the buffer. The diagnostic copy must
// already exist and match it exactly, while the recipient receives every sample.
const events = [];
class Worker {
  listeners = [];
  addEventListener(type, listener) {
    this.listeners.push(listener);
  }
  postMessage(message, transfer) {
    this.received = structuredClone(message, { transfer });
  }
}
vm.runInNewContext(await readFile('scripts/whisper-debug-capture.js', 'utf8'), {
  Worker,
  Float32Array,
  Uint8Array,
  performance,
  btoa: (x) => Buffer.from(x, 'binary').toString('base64'),
  listenAsrDebug: (x) => events.push(JSON.parse(x)),
});
const worker = new Worker();
const audio = new Float32Array([0.5, -0.5, 0]);
worker.postMessage({ type: 'TRANSCRIBE', requestId: 2, sessionId: 'test', audio }, [audio.buffer]);
assert.equal(audio.byteLength, 0);
assert.deepEqual(Array.from(worker.received.audio), [0.5, -0.5, 0]);
assert.deepEqual(Buffer.from(events[0].audio, 'base64'), pcm);
worker.listeners[0]({ data: { type: 'RESULT', requestId: 2, text: 'evidence' } });
assert.equal(events[1].text, 'evidence');
for (let i = 0; i < 9; i++)
  worker.postMessage({ type: 'TRANSCRIBE', audio: new Float32Array(1) }, []);
assert.equal(events.filter((e) => e.kind === 'input').length, 8);
assert.equal(worker.listeners.length, 1);

// Observer returns the same tensor and forwards default options untouched.
const seen = [],
  messages = [];
const tensor = { tolist: () => [[50258n, 42n, 50257n]] };
const instance = {
  model: {
    generate: async (options) => {
      seen.push(options);
      return tensor;
    },
    _prepare_generation_config: (_config, options) => options,
    _retrieve_init_tokens: () => [50258],
  },
  tokenizer: { decode: () => 'diagnostic' },
};
let returned;
const options = { language: 'id', max_new_tokens: 128 };
const self = {
  onmessage: async () => {
    returned = await instance.model.generate(options);
  },
  postMessage: (m) => messages.push(m),
};
vm.runInNewContext(await readFile('scripts/whisper-debug-worker.js', 'utf8'), {
  self,
  prepare: async () => instance,
});
await self.onmessage({ data: { type: 'TRANSCRIBE', requestId: 2, sessionId: 'test' } });
assert.equal(seen[0], options);
assert.equal(returned, tensor);
assert.equal(messages[0].requestId, undefined); // Cannot resolve ModelClient pending request.
assert.equal(messages[0].detail.requestId, 2);
assert.deepEqual(Array.from(messages[0].detail.tokens), [50258, 42, 50257]);
await self.onmessage({
  data: {
    type: 'TRANSCRIBE',
    requestId: 3,
    debugOverrides: { max_new_tokens: 256, device: 'cpu' },
  },
});
assert.equal(seen[1].max_new_tokens, 256);
assert.equal(seen[1].device, undefined);
await self.onmessage({ data: { type: 'TRANSCRIBE', requestId: 4 } });
assert.equal(seen[2], options); // Probe options cannot leak into the next baseline.

function decodeOutput(text, { ended = true, limit = 128 } = {}) {
  return {
    result: { type: 'RESULT', text, language: 'id', inferenceMs: 10 },
    generations: [
      {
        kind: 'generation',
        tokens: ended ? [1, 2, 3, 99] : [1, ...Array(limit).fill(2)],
        prefixTokens: [1],
        config: { eos_token_id: 99, max_new_tokens: limit },
      },
    ],
  };
}
const good = decodeOutput('Rapat membahas jadwal besok.');
const badLoop = decodeOutput('Terima kasih. '.repeat(30));
assert.equal(assessDecode(good).flagged, false);
assert.ok(assessDecode(badLoop).reasons.includes('repetition'));
assert.ok(
  assessDecode(decodeOutput('terputus', { ended: false })).reasons.includes(
    'token-limit-without-eos',
  ),
);
assert.throws(() => assessDecode({ result: { type: 'RESULT', text: 'text' }, generations: [] }));
let called = [];
let recovered = await decodeWithFallback(async (overrides, seed) => {
  called.push({ overrides, seed });
  return called.length === 1 ? badLoop : good;
}, 17);
assert.equal(recovered.attempts.length, 2);
assert.equal(recovered.selected, 1);
assert.equal(recovered.unresolved, false);
assert.deepEqual(called[1], {
  overrides: { language: 'id', do_sample: true, temperature: 0.2, top_k: 0 },
  seed: 18,
});
called = [];
recovered = await decodeWithFallback(async (overrides) => {
  called.push(overrides);
  return good;
}, 17);
assert.equal(called.length, 1); // Normal speech incurs no retry.
assert.equal(recovered.selected, 0);
recovered = await decodeWithFallback(async () => badLoop, 17);
assert.equal(recovered.attempts.length, 3);
assert.equal(recovered.selected, 0); // Retain baseline if all attempts fail.
assert.equal(recovered.unresolved, true);
let failures = 0;
recovered = await decodeWithFallback(async () => {
  if (++failures === 1) return badLoop;
  throw Error('timeout');
}, 17);
assert.equal(failures, 3);
assert.equal(recovered.selected, 0);
assert.equal(recovered.unresolved, true);
assert.equal(recovered.attempts.filter((a) => a.error).length, 2);

// Seeded sampling repeats in the isolated worker and restores the native RNG,
// including when the production handler throws.
const math = Object.create(Math);
math.random = () => 0.123;
const draws = [];
const seededSelf = {
  onmessage: async () => {
    draws.push([math.random(), math.random()]);
  },
  postMessage: () => {},
};
vm.runInNewContext(await readFile('scripts/whisper-debug-worker.js', 'utf8'), {
  self: seededSelf,
  prepare: async () => instance,
  Math: math,
});
for (let i = 0; i < 2; i++)
  await seededSelf.onmessage({ data: { type: 'TRANSCRIBE', debugSeed: 123 } });
assert.deepEqual(draws[0], draws[1]);
assert.equal(math.random(), 0.123);
const throwingSelf = {
  onmessage: async () => {
    throw Error('inference failed');
  },
  postMessage: () => {},
};
vm.runInNewContext(await readFile('scripts/whisper-debug-worker.js', 'utf8'), {
  self: throwingSelf,
  prepare: async () => instance,
  Math: math,
});
await assert.rejects(() =>
  throwingSelf.onmessage({ data: { type: 'TRANSCRIBE', debugSeed: 123 } }),
);
assert.equal(math.random(), 0.123);
console.log(
  'Whisper diagnostics: PCM transfer, bounded capture, metrics, observer isolation passed.',
);
