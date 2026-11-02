import { expect, it } from 'vitest';
import { replayRejection } from '../src/end-meeting/recovery';
import type { EndMeetingJob } from '../src/end-meeting/types';
import type { ReplayEvent } from '../src/replay/types';

const candidate = { protocol: 1, language: 'Indonesian', emptyReason: null, bullets: [
  { kind: 'discussion', text: 'Server berada di pihak vendor.', sources: [119], quotes: [{ source: 119, text: 'Servernya di kita.' }] },
] };
const job = {
  sessionId: 'session', replayRunId: 'run', transcriptHash: 'same-source',
  checkpoint: { sourceHash: 'same-source' },
  transcript: { segments: [{ id: 119, sessionId: 'session', startMs: 0, endMs: 1000, text: 'Servernya di kita.' }] },
} as EndMeetingJob;
const event = (kind: string, data: unknown, runId = 'run'): ReplayEvent => ({ kind, data, runId, at: 1, sourceMs: 1000 });
const evidence = [
  event('end.transcript-final', { hash: 'same-source' }),
  event('end.mom-response', { stage: 'compose', value: candidate }),
  event('end.mom-request', { stage: 'review', messages: [{}, { content: JSON.stringify({ focusIndexes: [0] }) }] }),
  event('end.mom-verdict', { accept: false, reason: 'The candidate reverses server ownership.' }),
];
it('recovers the precise prior candidate and review feedback for the same final transcript without model calls', () => {
  const result = replayRejection(job, evidence)!;
  expect(result.reason).toContain('reverses server ownership');
  expect(result.focusIndexes).toEqual([0]);
  expect(result.candidate.bullets[0].text).toBe(candidate.bullets[0].text);
  expect(job.checkpoint!.lastRejection).toBeUndefined();
});
it('ignores feedback from another run, transcript revision, or a later accepted review', () => {
  expect(replayRejection({ ...job, replayRunId: 'different' }, evidence)).toBeUndefined();
  expect(replayRejection({ ...job, transcriptHash: 'new-source' }, evidence)).toBeUndefined();
  expect(replayRejection(job, [...evidence, event('end.mom-verdict', { accept: true, reason: 'Accepted.' })])).toBeUndefined();
});
it('does not recover a malformed or unsupported diagnostic candidate', () => {
  const bad = structuredClone(candidate); bad.bullets[0].quotes[0].text = 'A sentence absent from the transcript.';
  const events = [...evidence]; events[1] = event('end.mom-response', { stage: 'compose', value: bad });
  expect(replayRejection(job, events)).toBeUndefined();
});
