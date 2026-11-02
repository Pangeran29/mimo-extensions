import { describe, expect, it } from 'vitest';
import { isDownloadCancelled } from '../src/download';
describe('Chrome download cancellation', () => {
  it.each(['USER_CANCELED', 'Download canceled', 'Download canceled.'])('recognizes explicit cancellation: %s', reason => {
    expect(isDownloadCancelled(reason)).toBe(true);
  });
  it.each([undefined, 'FILE_ACCESS_DENIED', 'NETWORK_FAILED', 'USER_SHUTDOWN', 'CRASH', 'Download interrupted', 'Unknown error'])('retains audio for other failures: %s', reason => {
    expect(isDownloadCancelled(reason)).toBe(false);
  });
});
