import type { DiagnosticConfig } from './diagnostics';
import type { AssistantSettings, AssistantAction } from './assistant/types';
import type { ReplayAction } from './replay/types';
export const AUDIO_SOURCES = ['mixed', 'microphone', 'tab'] as const;
export type AudioSource = (typeof AUDIO_SOURCES)[number];
export type Phase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'saving'
  | 'save-failed'
  | 'error';
export interface Session {
  id: string;
  createdAt: number;
  sourceTitle: string;
  tabId: number;
  filename: string;
  status: 'capturing' | 'ready';
  bytes: number;
  chunks: number;
  durationMs: number;
  partial: boolean;
  error?: string;
  downloadId?: number;
  sources?: AudioSource[]; // Missing for recordings made before separate outputs existed.
  savedSources?: AudioSource[];
  downloadingSource?: AudioSource;
}
export interface Status {
  replay?: { runId: string; sourceMs: number; phase: string };
  transcriptionBusy?: boolean;
  assistantBusy?: boolean;
  phase: Phase;
  session?: Session;
  error?: string;
  retained: Session[];
}
export type UIMessage =
  | ReplayAction
  | { target: 'worker'; type: 'STATUS' }
  | { target: 'worker'; type: 'TRANSCRIPT_STATUS' | 'PREPARE_TRANSCRIPTION' }
  | { target: 'worker'; type: 'START'; tabId: number; title: string }
  | { target: 'worker'; type: 'STOP' }
  | { target: 'worker'; type: 'RETRY'; id: string }
  | { target: 'worker'; type: 'DISCARD'; id: string };
export type RecorderMessage = { diagnostics?: DiagnosticConfig } & (
  | ({ target: 'recorder' } & AssistantAction)
  | {
      target: 'recorder';
      type: 'ASSISTANT_INIT';
      settings: AssistantSettings;
      apiKey?: string;
    }
  | { target: 'recorder'; type: 'CHECK_MICROPHONE' }
  | { target: 'recorder'; type: 'REPLAY_START'; sourceId: string; monitor?: boolean }
  | { target: 'recorder'; type: 'REPLAY_STATUS' | 'REPLAY_STOP' }
  | {
      target: 'recorder';
      type: 'REPLAY_UI_EVENT';
      sessionId: string;
      event: Extract<ReplayAction, { type: 'REPLAY_UI_EVENT' }>['event'];
    }
  | { target: 'recorder'; type: 'STATUS' }
  | { target: 'recorder'; type: 'TRANSCRIPT_STATUS' | 'PREPARE_TRANSCRIPTION' }
  | {
      target: 'recorder';
      type: 'START';
      streamId: string;
      tabId: number;
      title: string;
      agentDiagnostics?: boolean;
    }
  | { target: 'recorder'; type: 'STOP' }
  | { target: 'recorder'; type: 'EXPORT'; id: string }
  | {
      target: 'recorder';
      type: 'DOWNLOAD_DONE';
      id: string;
      success: boolean;
      cancelled?: boolean;
      error?: string;
    }
  | { target: 'recorder'; type: 'DISCARD'; id: string }
);
export type RecorderEvent =
  | { target: 'worker'; type: 'AGENT_REPORT_EXPORT'; sessionId?: string; automatic?: boolean }
  | { target: 'worker'; type: 'TRANSCRIPTION_SETTLED' | 'ASSISTANT_SETTLED' }
  | { target: 'worker'; type: 'STATE'; status: Status }
  | { target: 'worker'; type: 'READY'; id: string };
export type Reply<T = Status> = { ok: true; value: T } | { ok: false; error: string };
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function filename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `meeting-recording-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.webm`;
}
export function duration(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
export const MIME = 'audio/webm;codecs=opus';

export function remainingSources(session: Session): AudioSource[] {
  return (session.sources ?? ['mixed']).filter((source) => !session.savedSources?.includes(source));
}
export function outputFilename(session: Session, source: AudioSource): string {
  if (!session.sources) return session.filename; // Preserve existing retained recordings.
  const suffix = source === 'mixed' ? 'combined' : source;
  return session.filename.replace(/\.webm$/, `-${suffix}.webm`);
}
