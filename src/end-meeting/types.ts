import type { AssistantSettings } from '../assistant/types';
import type { TranscriptSnapshot } from '../transcription/types';
import type { MomCheckpoint } from './mom';

export type EndReason = 'manual' | 'eof' | 'source-error' | 'interrupted';
export type EndPhase = 'waiting_transcript' | 'generating' | 'ready' | 'empty' | 'failed';
export type ExportFile = 'audio' | 'transcript' | 'mom';
export type FilePhase = 'pending' | 'writing' | 'saved' | 'failed';
export interface MinuteBullet {
  kind: 'discussion' | 'decision' | 'action';
  text: string;
  sources: number[];
}
export interface Minutes {
  protocol: 1;
  language: string;
  bullets: MinuteBullet[];
  emptyReason: string | null;
}
export interface EndMeetingMeta {
  sessionId: string;
  createdAt: number;
  sourceTitle: string;
  durationMs: number;
  reason: EndReason;
  settings: AssistantSettings;
  replayRunId?: string;
}
export interface EndMeetingJob extends EndMeetingMeta {
  protocol: 1;
  updatedAt: number;
  revision: number;
  phase: EndPhase;
  audio: 'pending' | 'ready' | 'failed';
  audioError?: string;
  transcript?: TranscriptSnapshot;
  minutes?: Minutes;
  error?: string;
  retryAt?: number;
  destination: 'missing' | 'selected' | 'permission_required';
  directoryName?: string;
  folderName: string;
  audioFilename: string;
  files: Record<ExportFile, { phase: FilePhase; error?: string; bytes?: number }>;
  transcriptHash?: string;
  checkpoint?: MomCheckpoint;
  destinationKey?: string;
  audioReleased?: boolean;
  cleanupError?: string;
  cleanupAttempts?: number;
}
export type EndAction =
  | { type: 'END_MEETING'; sessionId?: string }
  | { type: 'END_STATUS'; sessionId?: string }
  | { type: 'END_DESTINATION'; sessionId: string }
  | { type: 'END_RETRY'; sessionId: string }
  | { type: 'END_SAVE'; sessionId: string }
  | { type: 'END_DISCARD'; sessionId: string };
