import { afterEach, expect, it, vi } from 'vitest';
import { checkMicrophone } from '../src/microphone';
afterEach(() => vi.unstubAllGlobals());
function fake(permission = 'granted', live = true) {
  const stop = vi.fn();
  const track = { readyState: live ? 'live' : 'ended', stop };
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }));
  vi.stubGlobal('navigator', {
    permissions: { query: async () => ({ state: permission }) },
    mediaDevices: { getUserMedia },
  });
  return { stop, getUserMedia };
}
it('checks the device and releases the microphone immediately', async () => {
  const { stop, getUserMedia } = fake();
  await checkMicrophone();
  expect(stop).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
});
it('does not prompt when microphone permission needs setup', async () => {
  const { getUserMedia } = fake('prompt');
  await expect(checkMicrophone()).rejects.toThrow('Settings');
  expect(getUserMedia).not.toHaveBeenCalled();
});
it('releases tracks even when the returned microphone is unusable', async () => {
  const { stop } = fake('granted', false);
  await expect(checkMicrophone()).rejects.toThrow('unavailable');
  expect(stop).toHaveBeenCalledOnce();
});
it('rejects a disconnected microphone', async () => {
  const { getUserMedia } = fake();
  getUserMedia.mockRejectedValue(Error('NotFound'));
  await expect(checkMicrophone()).rejects.toThrow('unavailable');
});
