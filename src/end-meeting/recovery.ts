import { validateMinutes, type MomCheckpoint } from './mom';
import type { EndMeetingJob } from './types';
import type { ReplayEvent } from '../replay/types';

/** Recover old v0.13.0 rejection feedback only from this run's exact final input. */
export function replayRejection(job: EndMeetingJob, events: ReplayEvent[]): MomCheckpoint['lastRejection'] {
  if (!job.checkpoint || job.checkpoint.lastRejection || !job.transcriptHash || !job.transcript || job.minutes)
    return undefined;
  let hash: unknown;
  let candidate: ReturnType<typeof validateMinutes> | undefined;
  let focusIndexes: number[] = [];
  let rejection: MomCheckpoint['lastRejection'];
  for (const event of events) {
    if (event.runId !== job.replayRunId) continue;
    const data = event.data as Record<string, any> | null;
    if (!data || typeof data !== 'object') continue;
    if (event.kind === 'end.transcript-final') {
      hash = data.hash; candidate = undefined; rejection = undefined;
    }
    if (hash !== job.transcriptHash) continue;
    if (event.kind === 'end.mom-response' && data.stage === 'compose') {
      rejection = undefined;
      try { candidate = validateMinutes(data.value, job.transcript.segments); }
      catch { candidate = undefined; }
    }
    if (event.kind === 'end.mom-request' && data.stage === 'review') {
      try {
        const input = JSON.parse(data.messages?.[1]?.content ?? 'null');
        focusIndexes = Array.isArray(input?.focusIndexes)
          ? input.focusIndexes.filter((i: unknown) => Number.isSafeInteger(i) && Number(i) >= 0 && Number(i) < (candidate?.bullets.length ?? 0))
          : [];
      } catch { focusIndexes = []; }
    }
    if (event.kind === 'end.mom-verdict') {
      if (data.accept === true) rejection = undefined;
      else if (candidate && data.accept === false && typeof data.reason === 'string' && data.reason.trim() && data.reason.length <= 600)
        rejection = { candidate, reason: data.reason, focusIndexes: focusIndexes.length ? focusIndexes : candidate.bullets.map((_, i) => i) };
    }
  }
  return rejection;
}
