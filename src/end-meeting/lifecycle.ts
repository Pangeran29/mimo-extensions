import type { TranscriptSnapshot } from '../transcription/types';
import type { EndMeetingJob } from './types';

/** A terminal ASR error is an incomplete result, not an eternally active replay. */
export function terminalTranscriptFailure(snapshot: TranscriptSnapshot, busy: boolean): boolean {
  return !busy && (snapshot.phase === 'failed' || snapshot.incomplete);
}

export function endJobSettled(job: EndMeetingJob | undefined, snapshot: TranscriptSnapshot, busy: boolean): boolean {
  if (!job || busy || job.phase === 'generating') return false;
  return job.phase !== 'waiting_transcript' || terminalTranscriptFailure(snapshot, busy);
}

export function recoveredEndTranscript(snapshot: TranscriptSnapshot, captureInterrupted: boolean): TranscriptSnapshot {
  if (!captureInterrupted && snapshot.phase === 'complete' && !snapshot.incomplete)
    return { ...structuredClone(snapshot), modelReady: false };
  return { ...structuredClone(snapshot), phase: 'failed', incomplete: true, modelReady: false };
}
