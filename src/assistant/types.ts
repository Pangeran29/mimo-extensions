import type { TranscriptSegment } from '../transcription/types';
export const HPOP_BASE_URL = 'https://hpop.ai/v1';
export const DEEPINFRA_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017' as const;
export type AssistantProvider = 'hpop' | 'deepinfra';
export const CANDIDATES = [
  DEEPINFRA_MODEL,
  'gpt-6-luna',
  'claude-haiku-4-5-20251001',
  'qwen3.7-plus',
  'claude-sonnet-5-5',
] as const;
export type AssistantModel = (typeof CANDIDATES)[number];
export interface AssistantSettings {
  provider?: AssistantProvider;
  enabled: boolean;
  model: AssistantModel;
  goal: string;
  benchmarkPassed: boolean;
}
export const DEFAULT_SETTINGS: AssistantSettings = {
  enabled: false,
  provider: 'hpop',
  model: 'claude-sonnet-5-5',
  goal: '',
  benchmarkPassed: false,
};
export interface EvidenceItem {
  kind: 'fact' | 'decision' | 'open' | 'resolved';
  key: string;
  text: string;
  evidenceSegmentIds: number[];
}
export interface Question {
  text: string;
  reason: string;
  issueKey: string;
  evidenceSegmentIds: number[];
}
export interface Analysis {
  summary: string;
  updates: EvidenceItem[];
  question: Question | null;
}
export interface QuestionRecord extends Question {
  feedback: 'shown' | 'useful' | 'dismissed' | 'resolved';
  createdAt: number;
}
export interface SummaryRevision {
  format?: 'incremental' | 'memo';
  version: number;
  createdAt: number;
  throughMs?: number;
  summary: string;
  memory: EvidenceItem[];
  evidenceSegmentIds: number[];
}
export interface AssistantSnapshot {
  liveV2?: import('./v2/types').State;
  live?: import('./live-types').LiveState;
  provider?: AssistantProvider;
  phase:
    | 'disabled'
    | 'ready'
    | 'listening'
    | 'thinking'
    | 'finishing'
    | 'paused'
    | 'complete'
    | 'error';
  sessionId?: string;
  version: number;
  summary: string;
  summaries: SummaryRevision[];
  updatedAt?: number;
  analyzingSince?: number;
  retryAt?: number;
  analysisError?: string;
  /** Latest validated response only; counts and IDs, never rejected/response text. */
  lastAnalysis?: {
    provider?: AssistantProvider;
    model?: AssistantModel;
    requestId: string;
    version: number;
    at: number;
    summaryCharacters: number;
    memoCharacters: number;
    outcome: 'empty' | 'unchanged' | 'updated';
  };
  /** Last failure metadata survives recovery/reload; no model output or transcript. */
  lastFailure?: {
    buildId?: string;
    at: number;
    requestId: string;
    status: number;
    category: string;
    reason: import('./errors').FailureReason;
    validationIssues?: import('./errors').ValidationIssue[];
    count: number;
  };
  question: QuestionRecord | null;
  memory: EvidenceItem[];
  history: QuestionRecord[];
  message: string;
  model: AssistantModel;
  lastSegmentId: number;
  incomplete: boolean;
  latencyMs?: number;
  deeper?: string;
  deeperError?: string;
  deeperBusy: boolean;
  contextGap: boolean;
}
export type MemoPolicy = 'baseline' | 'short-first-note';
/** Rollout gate has not passed; internal rollback/default stays baseline. */
export const DEFAULT_MEMO_POLICY: MemoPolicy = 'baseline';
export interface AnalysisInput {
  liveV2Input?: import('./v2/types').Input;
  liveInput?: import('./live-types').LiveInput;
  validationFeedback?: import('./errors').ValidationIssue[];
  memoPolicy?: MemoPolicy;
  requestId?: string;
  sessionId: string;
  version: number;
  goal: string;
  segments: TranscriptSegment[];
  memory: EvidenceItem[];
  history: QuestionRecord[];
  contextGap: boolean;
  previousSummary?: string;
  newSegmentIds?: number[];
  recentSummaries?: string[];
}
export interface AnalysisResult {
  analysis: Analysis;
  latencyMs: number;
  firstTokenMs: number;
  usage?: { input: number; output: number };
}
export type AssistantAction =
  | { type: 'ASSISTANT_STATUS' }
  | { type: 'ASSISTANT_SETTINGS' }
  | { type: 'ASSISTANT_DEFAULTS'; goal: string }
  | {
      type: 'ASSISTANT_CONFIGURE';
      settings: AssistantSettings;
      apiKey?: string;
      clearKey?: boolean;
    }
  | {
      type: 'ASSISTANT_FEEDBACK';
      sessionId: string;
      issueKey: string;
      feedback: 'useful' | 'not-helpful' | 'dismissed';
    }
  | { type: 'ASSISTANT_DEEPER'; sessionId: string }
  | { type: 'ASSISTANT_RESUME' };
