import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReplayAudioSource } from '../src/replay/source';

class AudioFixture extends EventTarget {
  readyState = 2;
  duration = 9;
  currentTime = 0;
  playbackRate = 1;
  preload = '';
  src = '';
  seeking = false;
  onended = null;
  onerror = null;
  pause = vi.fn();
  load = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
  removeAttribute = vi.fn();
}
let audio: AudioFixture;
let close: ReturnType<typeof vi.fn>;
let trackStop: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  audio = new AudioFixture();
  close = vi.fn().mockResolvedValue(undefined);
  trackStop = vi.fn();
  disconnect = vi.fn();
  revoke = vi.fn();
  vi.stubGlobal('Audio', class { constructor() { return audio; } });
  vi.stubGlobal('AudioContext', class {
    destination = {};
    close = close;
    resume = vi.fn().mockResolvedValue(undefined);
    createMediaStreamDestination() {
      return { stream: { getTracks: () => [{ stop: trackStop }] }, channelCount: 2 };
    }
    createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect }));
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:replay-fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('prepares a stream without playing or requesting a microphone, then plays at 1×', async () => {
  const source = new ReplayAudioSource();
  await source.prepare(new Blob(['audio']));
  expect(audio.play).not.toHaveBeenCalled();
  expect(audio.playbackRate).toBe(1);
  expect(source.durationMs).toBe(9000);
  await source.play();
  expect(audio.play).toHaveBeenCalledTimes(1);
  audio.currentTime = 1.25;
  expect(source.positionMs).toBe(1250);
  await source.release();
  await source.release();
  expect(audio.pause).toHaveBeenCalledTimes(1);
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledWith('blob:replay-fixture');
  expect(close).toHaveBeenCalledTimes(1);
  await expect(source.play()).rejects.toThrow('already released');
});
it('rejects invalid media before playback and supports resource cleanup after failure', async () => {
  audio.readyState = 0;
  const source = new ReplayAudioSource();
  const preparation = source.prepare(new Blob(['invalid']));
  audio.dispatchEvent(new Event('error'));
  await expect(preparation).rejects.toThrow('could not decode');
  expect(audio.play).not.toHaveBeenCalled();
  await source.release();
  expect(close).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledTimes(1);
});
