import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const fakes = vi.hoisted(() => ({
  ready: false,
  infer: vi.fn(),
  release: vi.fn(async () => {}),
  failPrepare: false,
  speechProbability: 0.9,
}));
vi.mock('../src/transcription/client', () => ({
  ModelClient: class {
    get ready() {
      return fakes.ready;
    }
    async prepare() {
      if (fakes.failPrepare) throw Error('GPU unavailable');
      fakes.ready = true;
    }
    transcribe(audio: Float32Array, id: string) {
      return fakes.infer(audio, id);
    }
    terminate() {
      fakes.ready = false;
    }
  },
}));
vi.mock('@ricky0123/vad-web/dist/real-time-vad', () => ({ ort: { env: { wasm: {} } } }));
vi.mock('@ricky0123/vad-web/dist/models/v5', () => ({
  SileroV5: {
    new: async () => ({
      reset_state: () => {},
      process: async () => ({ isSpeech: fakes.speechProbability }),
      release: fakes.release,
    }),
  },
}));
import { Transcriber } from '../src/transcription/controller';
import {
  saveTranscript,
  loadTranscript,
  pendingWindows,
  persistWindow,
  commitWindows,
} from '../src/transcription/store';
class Node {
  gain = { value: 1 };
  connect() {
    return this;
  }
  disconnect = vi.fn();
  port: {
    onmessage: ((event: { data: object }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  } = { onmessage: null, postMessage: vi.fn() };
  static latest: Node;
  constructor() {
    Node.latest = this;
  }
}
let transcriber: Transcriber;
let changed: ReturnType<typeof vi.fn>, settled: ReturnType<typeof vi.fn>;
const context = {
  audioWorklet: { addModule: async () => {} },
  createMediaStreamSource: () => new Node(),
  createGain: () => new Node(),
  destination: {},
} as unknown as AudioContext;
let port: Node['port'];
beforeEach(async () => {
  fakes.ready = false;
  fakes.failPrepare = false;
  fakes.speechProbability = 0.9;
  fakes.infer
    .mockReset()
    .mockResolvedValue({ text: 'Halo world', language: 'id', inferenceMs: 10 });
  fakes.release.mockClear();
  const db = await new Promise<IDBDatabase>((resolve) => {
    const r = indexedDB.open('listen-transcript', 2);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('latest');
      r.result.createObjectStore('pending', { keyPath: 'pendingId' });
    };
    r.onsuccess = () => resolve(r.result);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').clear();
    tx.oncomplete = () => resolve();
  });
  db.close();
  await saveTranscript({
    phase: 'unavailable',
    segments: [],
    modelReady: false,
    incomplete: false,
    lagMs: 0,
  });
  vi.stubGlobal('location', { href: 'chrome-extension://test/offscreen.html' });
  // Keep the worklet port separate from the subsequent source and sink nodes.
  vi.stubGlobal(
    'AudioWorkletNode',
    class extends Node {
      constructor() {
        super();
        port = this.port;
      }
    },
  );
  changed = vi.fn();
  settled = vi.fn();
  transcriber = new Transcriber(changed, settled);
  await transcriber.status();
});
afterEach(async () => {
  await transcriber.dispose();
  vi.unstubAllGlobals();
});
async function start() {
  await transcriber.prepare();
  await transcriber.start({} as MediaStream, 'session', context);
}
function frames(count: number) {
  for (let i = 0; i < count; i++)
    port.onmessage?.({ data: { message: 'AUDIO_FRAME', data: new Float32Array(512).buffer } });
}
describe('local recognition lifecycle', () => {
  it('publishes real speech and recognition activity without inventing partial transcript text', async () => {
    let resolve!: (value: object) => void;
    fakes.infer.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await start();
    expect(transcriber.snapshot.activity).toBe('waiting');
    frames(20);
    await vi.waitFor(() => expect(transcriber.snapshot.activity).toBe('speech'));
    expect(transcriber.snapshot.segments).toEqual([]);
    fakes.speechProbability = 0;
    frames(20);
    await vi.waitFor(() => expect(transcriber.snapshot.activity).toBe('recognizing'));
    expect(transcriber.snapshot.segments).toEqual([]);
    resolve({ text: 'Finalized speech.', language: 'en', inferenceMs: 10 });
    await vi.waitFor(() => expect(transcriber.snapshot.activity).toBe('waiting'));
    expect(transcriber.snapshot.segments[0].text).toBe('Finalized speech.');
    expect(
      changed.mock.calls.some(([value, ephemeral]) => value.activity === 'speech' && ephemeral),
    ).toBe(true);
  });
  it('flushes the final speech and retains text after releasing inference resources', async () => {
    await start();
    frames(20);
    await transcriber.stopCapture();
    await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'));
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect(fakes.infer).toHaveBeenCalledTimes(1);
    expect(fakes.infer.mock.calls[0][0].length).toBe(20 * 512);
    expect(transcriber.snapshot.segments[0].text).toBe('Halo world');
    expect(fakes.ready).toBe(false);
    expect(fakes.release).toHaveBeenCalled();
    expect((await loadTranscript())?.phase).toBe('complete');
  });
  it('allows a recording-only session after model preparation fails', async () => {
    fakes.failPrepare = true;
    await expect(transcriber.prepare()).rejects.toThrow('GPU unavailable');
    await transcriber.start({} as MediaStream, 'recording-only', context);
    expect(transcriber.busy).toBe(false);
    expect(transcriber.snapshot.message).toContain('GPU unavailable');
    expect(fakes.infer).not.toHaveBeenCalled();
  });
  it('fails explicitly at the 30-second PCM bound without retaining an unbounded queue', async () => {
    await start();
    frames(1000);
    expect(transcriber.snapshot.phase).toBe('failed');
    expect(transcriber.snapshot.message).toContain('queue is full');
    expect(transcriber.snapshot.incomplete).toBe(true);
    expect(port.onmessage).toBeNull();
  });
  it('has only one inference in flight and ignores a result from a failed session', async () => {
    let complete: (result: object) => void = () => {};
    fakes.infer.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await start();
    frames(250);
    await vi.waitFor(() => expect(fakes.infer).toHaveBeenCalledTimes(1));
    frames(1000);
    expect(transcriber.snapshot.phase).toBe('failed');
    complete({ text: 'stale text', language: 'en', inferenceMs: 20 });
    await new Promise((r) => setTimeout(r, 10));
    expect(transcriber.snapshot.segments).toHaveLength(0);
  });
  it('finishes queued windows in order before allowing another session', async () => {
    const resolvers: Array<(value: object) => void> = [];
    fakes.infer.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await start();
    frames(250);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    frames(40);
    await transcriber.stopCapture();
    expect(transcriber.snapshot.phase).toBe('finishing');
    expect(transcriber.busy).toBe(true);
    resolvers[0]({ text: 'first passage', language: 'en', inferenceMs: 20 });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(fakes.infer).toHaveBeenCalledTimes(2);
    resolvers[1]({ text: 'second passage', language: 'en', inferenceMs: 20 });
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect(transcriber.snapshot.segments.map((s) => s.text)).toEqual([
      'first passage',
      'second passage',
    ]);
    expect(transcriber.busy).toBe(false);
  });
  it('keeps failed windows and retries automatically after Stop, in order and without duplicates', async () => {
    try {
      fakes.infer.mockRejectedValueOnce(new Error('offline'));
      await start();
      frames(20);
      await transcriber.stopCapture();
      await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('recovering'));
      expect(await pendingWindows()).toHaveLength(1);
      expect(transcriber.snapshot.segments).toHaveLength(0);
      expect(transcriber.busy).toBe(true);
      await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'), {
        timeout: 4000,
      });
      expect(transcriber.snapshot.segments).toHaveLength(1);
      expect(await pendingWindows()).toHaveLength(0);
      expect(fakes.infer).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('continues accepting and retaining speech during a cloud outage', async () => {
    fakes.infer.mockRejectedValueOnce(new Error('offline'));
    await start();
    frames(250);
    await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('recovering'));
    expect(port.onmessage).not.toBeNull();
    frames(250);
    await vi.waitFor(async () => expect((await pendingWindows()).length).toBeGreaterThanOrEqual(2));
    await transcriber.stopCapture();
    await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'), { timeout: 4000 });
    expect(await pendingWindows()).toEqual([]);
    expect(fakes.infer.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('acknowledges empty output without leaving a permanent recovery job', async () => {
    fakes.infer.mockResolvedValue({ text: '', language: 'auto', inferenceMs: 5 });
    await start();
    frames(20);
    await transcriber.stopCapture();
    await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'));
    expect(transcriber.snapshot.segments).toEqual([]);
    expect(await pendingWindows()).toEqual([]);
  });
  it('restores durable audio after document teardown and commits recovered text once', async () => {
    const snapshot = {
      phase: 'recovering' as const,
      sessionId: 'saved',
      segments: [],
      incomplete: false,
      lagMs: 0,
      modelReady: false,
    };
    await persistWindow(snapshot, {
      pendingId: 'saved:0',
      sessionId: 'saved',
      startSample: 0,
      endSample: 16000,
      overlap: false,
      audio: new Float32Array(16000),
    });
    transcriber = new Transcriber(changed, settled);
    await transcriber.status();
    await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'));
    expect(transcriber.snapshot.segments.map((s) => s.text)).toEqual(['Halo world']);
    expect(await pendingWindows()).toEqual([]);
    const restored = new Transcriber(changed, settled);
    await restored.status();
    expect(restored.snapshot.segments).toHaveLength(1);
    expect(fakes.infer).toHaveBeenCalledTimes(1);
    await restored.dispose();
  });
});

it('reports audio duration and request progress in memory without persisting live readings', async () => {
  let resolve!: (value: object) => void;
  fakes.infer.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await start();
  frames(20);
  await vi.waitFor(() => expect(transcriber.liveProgress().audio.state).toBe('collecting'));
  expect(transcriber.liveProgress().audio.bufferedMs).toBe(640);
  fakes.speechProbability = 0;
  frames(20);
  await vi.waitFor(() => expect(transcriber.liveProgress().asr.state).toBe('running'));
  expect(transcriber.liveProgress().audio.lastWindowMs).toBeGreaterThan(640);
  const emits = changed.mock.calls.length;
  transcriber.liveProgress();
  transcriber.liveProgress();
  expect(changed).toHaveBeenCalledTimes(emits);
  resolve({ text: 'Supported speech.', language: 'en', inferenceMs: 10 });
  await vi.waitFor(() => expect(transcriber.liveProgress().asr.state).toBe('done'));
  expect(JSON.stringify(await loadTranscript())).not.toContain('elapsedMs');
  expect(JSON.stringify(await loadTranscript())).not.toContain('lastWindowMs');
});

it('batches only windows already waiting, preserving serial delivery and durable acknowledgement', async () => {
  await transcriber.dispose();
  transcriber = new Transcriber(changed, settled, 16);
  await transcriber.status();
  let first!: (value: object) => void, second!: (value: object) => void;
  fakes.infer
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          first = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          second = r;
        }),
    );
  await start();
  frames(251);
  await vi.waitFor(() => expect(fakes.infer).toHaveBeenCalledTimes(1));
  frames(438);
  await vi.waitFor(async () => expect(await pendingWindows()).toHaveLength(3));
  const queued = await pendingWindows();
  first({ text: 'First passage.', language: 'en', inferenceMs: 10 });
  await vi.waitFor(() => expect(fakes.infer).toHaveBeenCalledTimes(2));
  expect(fakes.infer.mock.calls[1][0].length).toBe(queued[2].endSample - queued[1].startSample);
  expect(await pendingWindows()).toHaveLength(2);
  frames(219);
  await vi.waitFor(async () => expect(await pendingWindows()).toHaveLength(3));
  expect(fakes.infer).toHaveBeenCalledTimes(2);
  expect(transcriber.liveProgress().asr.queued).toBe(1);
  second({ text: 'Combined queued passage.', language: 'en', inferenceMs: 10 });
  await vi.waitFor(async () => expect(await pendingWindows()).toHaveLength(0));
  expect(fakes.infer).toHaveBeenCalledTimes(3);
  expect(transcriber.snapshot.segments).toHaveLength(3);
  expect(transcriber.snapshot.segments[1].startMs).toBe(queued[1].startSample / 16);
  expect(transcriber.snapshot.segments[1].endMs).toBe(queued[2].endSample / 16);
});
it('aborts all acknowledgements if a batch storage operation throws halfway through', async () => {
  const jobs = [0, 1].map((n) => ({
    pendingId: 's:' + n,
    sessionId: 's',
    startSample: n * 16000,
    endSample: (n + 1) * 16000,
    overlap: false,
    audio: new Float32Array(16000),
  }));
  const before = structuredClone(transcriber.snapshot);
  for (const job of jobs) await persistWindow(before, job);
  const original = IDBObjectStore.prototype.delete;
  let deletes = 0;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
    this: IDBObjectStore,
    key: IDBValidKey | IDBKeyRange,
  ) {
    if (++deletes === 2) throw Error('Simulated storage failure');
    return original.call(this, key);
  });
  try {
    await expect(
      commitWindows({ ...before, message: 'Must not partially commit' }, jobs),
    ).rejects.toThrow('Simulated');
  } finally {
    spy.mockRestore();
  }
  expect(await pendingWindows()).toHaveLength(2);
  expect((await loadTranscript())?.message).toBe(before.message);
});

it('restores a queued batch, retries its same PCM, and acknowledges empty output once', async () => {
  await transcriber.dispose();
  const snapshot = {
    phase: 'recovering' as const,
    sessionId: 'saved',
    segments: [],
    incomplete: false,
    lagMs: 0,
    modelReady: false,
  };
  for (let n = 0; n < 3; n++)
    await persistWindow(snapshot, {
      pendingId: 'saved:' + n,
      sessionId: 'saved',
      startSample: n * 16000,
      endSample: (n + 1) * 16000,
      overlap: false,
      audio: new Float32Array(16000).fill(n),
    });
  fakes.infer
    .mockRejectedValueOnce(Error('Temporary outage'))
    .mockResolvedValue({ text: '', language: 'id', inferenceMs: 1 });
  transcriber = new Transcriber(changed, settled, 16);
  await transcriber.status();
  await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('recovering'));
  await vi.waitFor(() => expect(fakes.infer).toHaveBeenCalledTimes(1));
  expect(await pendingWindows()).toHaveLength(3);
  await vi.waitFor(() => expect(transcriber.snapshot.phase).toBe('complete'), { timeout: 3500 });
  expect(fakes.infer).toHaveBeenCalledTimes(2);
  expect(fakes.infer.mock.calls[0][0]).toBe(fakes.infer.mock.calls[1][0]);
  expect(fakes.infer.mock.calls[1][0].length).toBe(48000);
  expect(await pendingWindows()).toEqual([]);
  expect(transcriber.snapshot.segments).toEqual([]);
});
