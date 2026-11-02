import { expect, it } from 'vitest';
import { endJobSettled, recoveredEndTranscript, terminalTranscriptFailure } from '../src/end-meeting/lifecycle';
import type { TranscriptSnapshot } from '../src/transcription/types';
import type { EndMeetingJob } from '../src/end-meeting/types';
const transcript: TranscriptSnapshot = { phase: 'complete', sessionId: 'ended', segments: [], incomplete: false, lagMs: 0, modelReady: true };
const job = (phase: EndMeetingJob['phase']) => ({ phase }) as EndMeetingJob;
it('finishes an incomplete replay once ASR has terminally failed but not while recovery is busy', () => {
  const failed = { ...transcript, phase: 'failed' as const, incomplete: true };
  expect(terminalTranscriptFailure(failed, false)).toBe(true);
  expect(endJobSettled(job('waiting_transcript'), failed, false)).toBe(true);
  expect(endJobSettled(job('waiting_transcript'), failed, true)).toBe(false);
  expect(endJobSettled(job('waiting_transcript'), transcript, false)).toBe(false);
  expect(endJobSettled(job('generating'), transcript, false)).toBe(false);
  expect(endJobSettled(job('ready'), transcript, false)).toBe(true);
});
it('preserves a complete durable transcript when only the end-job save was interrupted', () => {
  const restored = recoveredEndTranscript(transcript, false);
  expect(restored.phase).toBe('complete'); expect(restored.incomplete).toBe(false);
  expect(restored.modelReady).toBe(false); expect(transcript.modelReady).toBe(true);
});
it('never claims an interrupted capture or partial transcript is complete', () => {
  expect(recoveredEndTranscript(transcript, true).incomplete).toBe(true);
  expect(recoveredEndTranscript({ ...transcript, phase: 'finishing' }, false).phase).toBe('failed');
});
