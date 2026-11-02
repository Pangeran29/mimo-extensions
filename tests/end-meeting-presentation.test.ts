import { describe, expect, it } from 'vitest';
import { canReadEndJob, isUnclaimedBundle, unsavedEndJobs } from '../src/end-meeting/presentation';
import type { EndMeetingJob } from '../src/end-meeting/types';
import type { Session } from '../src/types';

describe('post-meeting reader selection and recovery', () => {
  it('old automatic results do not replace the last active session', () => {
    expect(canReadEndJob('older', 'latest', 'idle')).toBe(false);
    expect(canReadEndJob('latest', 'latest', 'idle')).toBe(true);
  });
  it('an explicit idle selection can open an older result and fences newer events', () => {
    expect(canReadEndJob('older', 'latest', 'idle', 'older')).toBe(true);
    expect(canReadEndJob('latest', 'latest', 'idle', 'older')).toBe(false);
  });
  it('selection cannot take over starting, recording, or stopping capture', () => {
    for (const phase of ['starting', 'recording', 'stopping'] as const)
      expect(canReadEndJob('older', 'latest', phase, 'older')).toBe(false);
  });
  it('lists only other unfinished bundles, including partially saved results', () => {
    const job = (id: string, phases: string[]) => ({ sessionId: id, files: Object.fromEntries(['audio', 'transcript', 'mom'].map((key, i) => [key, { phase: phases[i] }])) }) as EndMeetingJob;
    const rows = [job('current', ['pending', 'pending', 'pending']), job('older', ['saved', 'saved', 'failed']), job('complete', ['saved', 'saved', 'saved'])];
    expect(unsavedEndJobs(rows, 'current').map((row) => row.sessionId)).toEqual(['older']);
  });
  it('interrupted bundle audio without a job remains recoverable, while claimed bundles use the end reader', () => {
    const audio = { id: 'raw', exportKind: 'meeting-bundle-v1', status: 'capturing' } as Session;
    expect(isUnclaimedBundle(audio, new Set())).toBe(true);
    expect(isUnclaimedBundle(audio, new Set(['raw']))).toBe(false);
    expect(isUnclaimedBundle({ ...audio, exportKind: undefined }, new Set())).toBe(false);
  });
});
