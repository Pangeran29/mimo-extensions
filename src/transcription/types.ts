export type TranscriptPhase =
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'transcribing'
  | 'recovering'
  | 'finishing'
  | 'complete'
  | 'failed';
export interface TranscriptSegment {
  id: number;
  sessionId: string;
  startMs: number;
  endMs: number;
  text: string;
}
export interface TranscriptSnapshot {
  phase: TranscriptPhase;
  sessionId?: string;
  segments: TranscriptSegment[];
  message?: string;
  incomplete: boolean;
  lagMs: number;
  modelReady: boolean;
  audioQueueMs?: number;
  lastInferenceMs?: number;
  activity?: 'waiting' | 'speech' | 'recognizing';
  retryAt?: number;
  pendingWindows?: number;
}
export interface AudioWindow {
  pendingId?: string;
  traceId?: number;
  audio: Float32Array;
  startSample: number;
  endSample: number;
  overlap: boolean;
}
export const SAMPLE_RATE = 16000;
