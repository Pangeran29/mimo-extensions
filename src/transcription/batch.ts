import { SAMPLE_RATE } from './types';
import type { PendingWindow } from './store';
declare const LISTEN_ASR_BATCH_SECONDS: number;
/** Merge only already-queued audio, capped at 16 seconds. Set 8 for baseline rollback. */
const configured = typeof LISTEN_ASR_BATCH_SECONDS === 'undefined' ? 16 : LISTEN_ASR_BATCH_SECONDS;
export const BATCH_SECONDS = [8, 16, 24].includes(configured) ? configured : 16;
export interface AudioBatch {
  jobs: PendingWindow[];
  audio: Float32Array;
  startSample: number;
  endSample: number;
  overlap: boolean;
  sessionId: string;
}
/** Oldest eligible prefix only. Never mutate originals or wait for another window. */
export function selectBatch(
  queue: readonly PendingWindow[],
  seconds: number,
): AudioBatch | undefined {
  const first = queue[0];
  if (!first) return;
  const jobs = [first];
  let end = first.endSample;
  const valid = (job: PendingWindow) =>
    Number.isSafeInteger(job.startSample) &&
    Number.isSafeInteger(job.endSample) &&
    job.startSample >= 0 &&
    job.endSample > job.startSample &&
    job.endSample - job.startSample === job.audio.length;
  if (seconds > 8 && valid(first))
    for (const job of queue.slice(1)) {
      if (
        !valid(job) ||
        job.sessionId !== first.sessionId ||
        job.startSample > end ||
        job.startSample < first.startSample ||
        job.endSample <= end ||
        job.endSample - first.startSample > Math.floor(Math.min(seconds, 24) * SAMPLE_RATE)
      )
        break;
      jobs.push(job);
      end = job.endSample;
    }
  if (jobs.length === 1)
    return {
      jobs,
      audio: first.audio,
      startSample: first.startSample,
      endSample: first.endSample,
      overlap: first.overlap,
      sessionId: first.sessionId,
    };
  const audio = new Float32Array(end - first.startSample);
  audio.set(first.audio);
  let writtenEnd = first.endSample;
  for (const job of jobs.slice(1)) {
    const skip = writtenEnd - job.startSample;
    audio.set(job.audio.subarray(skip), writtenEnd - first.startSample);
    writtenEnd = job.endSample;
  }
  return {
    jobs,
    audio,
    startSample: first.startSample,
    endSample: end,
    overlap: first.overlap,
    sessionId: first.sessionId,
  };
}
