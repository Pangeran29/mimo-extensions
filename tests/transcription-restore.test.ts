import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let handler: any;
let enabled: boolean;
let exists: boolean;
let phase: string;
let modelReady: boolean;
let fail: boolean;
let recording: boolean;
let send: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let release: (() => void) | undefined;
beforeEach(async () => {
  enabled = true;
  exists = false;
  phase = 'unavailable';
  modelReady = false;
  fail = false;
  recording = false;
  release = undefined;
  create = vi.fn(async () => {
    exists = true;
  });
  send = vi.fn(async (msg: any) => {
    if (msg.type === 'TRANSCRIPT_STATUS')
      return { ok: true, value: { phase, modelReady, segments: [], lagMs: 0, incomplete: false } };
    if (msg.type === 'STATUS')
      return { ok: true, value: { phase: recording ? 'recording' : 'idle', retained: [] } };
    if (msg.type === 'PREPARE_TRANSCRIPTION') {
      if (release)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      phase = fail ? 'failed' : 'ready';
      modelReady = !fail;
      if (fail) return { ok: false, error: 'GPU unavailable' };
      return { ok: true, value: { phase, modelReady } };
    }
    return { ok: true };
  });
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      ContextType: { OFFSCREEN_DOCUMENT: 'offscreen' },
      getContexts: async () => (exists ? [{}] : []),
      sendMessage: send,
      onMessage: {
        addListener: (fn: any) => {
          handler = fn;
        },
      },
      onInstalled: event(),
      onStartup: event(),
    },
    storage: { local: { get: async () => ({ transcriptionEnabled: enabled }) } },
    offscreen: { createDocument: create, Reason: { USER_MEDIA: 'media', BLOBS: 'blob' } },
    downloads: { onChanged: event() },
  });
  vi.resetModules();
  await import('../src/worker');
});
afterEach(() => vi.unstubAllGlobals());
const status = () =>
  new Promise<any>((resolve) =>
    handler({ target: 'worker', type: 'TRANSCRIPT_STATUS' }, { id: 'test' }, resolve),
  );
it('restores an already configured model automatically after its offscreen worker is unloaded', async () => {
  const result = await status();
  expect(result).toMatchObject({ ok: true, value: { modelReady: true, phase: 'ready' } });
  expect(create).toHaveBeenCalledOnce();
  expect(send.mock.calls.filter(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toHaveLength(1);
  await status();
  expect(send.mock.calls.filter(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toHaveLength(1);
});
it('does not download a model automatically on a fresh install', async () => {
  enabled = false;
  expect((await status()).value.modelReady).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it('shares one restoration across concurrent status requests', async () => {
  release = () => {};
  const first = status(),
    second = status();
  await vi.waitFor(() =>
    expect(send.mock.calls.filter(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toHaveLength(1),
  );
  release!();
  expect((await first).value.modelReady).toBe(true);
  expect((await second).value.modelReady).toBe(true);
});
it('reports actual failed readiness without retrying endlessly on status polls', async () => {
  fail = true;
  expect((await status()).value).toMatchObject({ modelReady: false, phase: 'failed' });
  await status();
  await status();
  expect(send.mock.calls.filter(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toHaveLength(1);
});
it('never prepares over an active recording', async () => {
  exists = true;
  recording = true;
  await status();
  expect(send.mock.calls.some(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toBe(false);
});
it('leaves in-flight model preparation and transcription alone', async () => {
  exists = true;
  for (const active of ['loading', 'transcribing', 'finishing']) {
    phase = active;
    await status();
  }
  expect(send.mock.calls.some(([msg]) => msg.type === 'PREPARE_TRANSCRIPTION')).toBe(false);
});
