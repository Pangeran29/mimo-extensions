import type { AssistantSnapshot } from '../assistant/types';
import type { TranscriptSnapshot } from '../transcription/types';

export type ReplayPhase =
  | 'idle'
  | 'starting'
  | 'playing'
  | 'draining'
  | 'stopping'
  | 'complete'
  | 'error';
export interface ReplaySource {
  id: string;
  name: string;
  size: number;
  type: string;
  sha256: string;
  durationMs?: number;
  createdAt: number;
}
export interface ReplayRun {
  id: string;
  sourceId: string;
  sessionId: string;
  source: ReplaySource;
  startedAt: number;
  endedAt?: number;
  phase: ReplayPhase;
  buildId: string;
  protocol: 2;
  sourceMs: number;
  durationMs?: number;
  error?: string;
  partial?: boolean;
  limited?: boolean;
  eventBytes?: number;
  settings?: { provider?: string; model?: string; objective?: string; asrBatchSeconds?: number };
  finalAssistant?: AssistantSnapshot;
  finalTranscript?: TranscriptSnapshot;
  agentReport?: Awaited<ReturnType<typeof import('../agent-diagnostics').readAgentReport>>;
  stopReason?: 'manual' | 'eof' | 'drain-timeout' | 'source-error' | 'interrupted';
}
export interface ReplayEvent {
  sequence?: number;
  runId: string;
  kind: string;
  at: number;
  sourceMs: number;
  data: unknown;
}
export interface ReplayStatus {
  enabled: boolean;
  phase: ReplayPhase;
  run?: ReplayRun;
  sourceMs: number;
  durationMs?: number;
  transcriptionBusy: boolean;
  assistantBusy: boolean;
  error?: string;
}
export type ReplayAction =
  | { target: 'worker'; type: 'REPLAY_START'; sourceId: string; monitor?: boolean }
  | { target: 'worker'; type: 'REPLAY_STATUS' | 'REPLAY_STOP' }
  | {
      target: 'worker';
      type: 'REPLAY_UI_EVENT';
      sessionId: string;
      event: {
        kind: string;
        at: number;
        monotonicMs: number;
        timeOrigin: number;
        data: Record<string, unknown>;
      };
    };

