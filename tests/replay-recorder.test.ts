import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import * as db from '../src/db';
import { ReplayRecorder } from '../src/replay/recorder';

class Encoder {
  static instance: Encoder;
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(readonly stream: MediaStream) { Encoder.instance = this; }
  start() { this.state = 'recording'; }
  stop = vi.fn(() => {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['final-frame']) });
      this.onstop?.();
    });
  });
}
afterEach(async () => {
  for (const row of await db.sessions()) await db.deleteSession(row.id);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('commits the played stream and its final frame once, independently of original-file duration', async () => {
  vi.stubGlobal('MediaRecorder', Encoder);
  const recorder = new ReplayRecorder(), stream = {} as MediaStream;
  await recorder.start(stream, 'prefix-test', 1000, 'long-input.wav');
  expect(Encoder.instance.stream).toBe(stream);
  Encoder.instance.ondataavailable?.({ data: new Blob(['played-prefix-']) });
  const [a, b] = await Promise.all([recorder.stop(3500, true), recorder.stop(15_000)]);
  expect(a.id).toBe(b.id); expect(a.durationMs).toBe(3500); expect(a.partial).toBe(true);
  expect(a.sources).toEqual(['mixed']); expect(a.exportKind).toBe('meeting-bundle-v1');
  expect(Encoder.instance.stop).toHaveBeenCalledOnce();
  expect(await (await db.audioBlob(a.id, 'audio/webm')).text()).toBe('played-prefix-final-frame');
  await expect(db.audioBlob(a.id, 'audio/webm', 'microphone')).rejects.toThrow('No audio');
});
it('retains committed replay audio and marks an encoder failure as partial', async () => {
  vi.stubGlobal('MediaRecorder', Encoder);
  const recorder = new ReplayRecorder();
  await recorder.start({} as MediaStream, 'failed-encoder', 1000, 'fixture.wav');
  Encoder.instance.ondataavailable?.({ data: new Blob(['committed-']) });
  Encoder.instance.onerror?.();
  const session = await recorder.stop(2000);
  expect(session.partial).toBe(true); expect(session.error).toContain('encoder failed');
  expect(await (await db.audioBlob(session.id, 'audio/webm')).text()).toBe('committed-final-frame');
});
it('waits for final encoder events after an automatic failure has already made it inactive', async () => {
  vi.stubGlobal('MediaRecorder', Encoder);
  const recorder = new ReplayRecorder();
  await recorder.start({} as MediaStream, 'automatic-error', 1000, 'fixture.wav');
  const encoder=Encoder.instance;
  encoder.state='inactive'; encoder.onerror?.();
  let settled=false;
  const stopped=recorder.stop(2000).then(value=>{settled=true;return value;});
  await Promise.resolve(); expect(settled).toBe(false);
  encoder.ondataavailable?.({data:new Blob(['recoverable-final-frame'])}); encoder.onstop?.();
  const result=await stopped;
  expect(result.partial).toBe(true);
  expect(await (await db.audioBlob(result.id,'audio/webm')).text()).toBe('recoverable-final-frame');
});
