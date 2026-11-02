/** Display-only process readings. Never pass these to storage or diagnostics. */
export interface StageReading {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  elapsedMs: number;
}
export class LiveStageTimer {
  private startedAt = 0;
  private reading: StageReading = { state: 'idle', elapsedMs: 0 };
  start(): void {
    this.startedAt = performance.now();
    this.reading = { state: 'running', elapsedMs: 0 };
  }
  finish(state: 'done' | 'failed' | 'cancelled'): void {
    if (this.reading.state !== 'running') return;
    this.reading = { state, elapsedMs: Math.max(0, performance.now() - this.startedAt) };
  }
  reset(): void {
    this.reading = { state: 'idle', elapsedMs: 0 };
  }
  read(): StageReading {
    return this.reading.state === 'running'
      ? { state: 'running', elapsedMs: Math.max(0, performance.now() - this.startedAt) }
      : { ...this.reading };
  }
}
export interface PipelineProgress {
  sessionId?: string;
  audio: { state: 'collecting' | 'waiting' | 'stopped'; bufferedMs: number; lastWindowMs: number };
  asr: StageReading & { queued: number; retryInMs?: number };
  llm: StageReading & {
    queued: boolean;
    paused: boolean;
    retryInMs?: number;
    outcome?: 'empty' | 'unchanged' | 'updated';
  };
}
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
export function requestProgressText(reading: StageReading, retryInMs?: number): string {
  if (reading.state === 'running') return `${seconds(reading.elapsedMs)} · working`;
  if (retryInMs !== undefined) return `Retry in ${Math.ceil(Math.max(0, retryInMs) / 1000)}s`;
  if (reading.state === 'done') return `${seconds(reading.elapsedMs)} · last`;
  if (reading.state === 'failed') return `${seconds(reading.elapsedMs)} · failed`;
  if (reading.state === 'cancelled') return `${seconds(reading.elapsedMs)} · cancelled`;
  return 'Waiting';
}
