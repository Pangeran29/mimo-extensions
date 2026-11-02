import type { TranscriptSegment } from '../transcription/types';
export const LIVE_MEMO_PROTOCOL = 1;
export type LiveKind = 'question' | 'explanation' | 'connection' | 'suggestion' | 'correction';
export interface LiveMemory {
  key: string;
  kind: 'fact' | 'constraint' | 'proposal' | 'decision' | 'open' | 'resolved' | 'correction';
  topic: string;
  text: string;
  sources: number[];
  replaces: string | null;
}
export interface LiveCandidate {
  kind: LiveKind;
  title: string | null;
  body: string;
  sources: number[];
  interpretation: boolean;
  generalKnowledge: boolean;
  proposal: boolean;
}
export interface Contribution extends LiveCandidate {
  id: string;
  topic: string;
  createdAt: number;
  archivedAt?: number;
  archivedReason?: 'replaced' | 'topic' | 'dismissed';
  feedback?: 'useful' | 'not-helpful' | 'dismissed';
}
export interface LiveState {
  protocol: 1;
  topic: { key: string; label: string; sources: number[] } | null;
  memory: LiveMemory[];
  contributions: Contribution[];
  activeId: string | null;
  decision: 'wait' | 'silent' | 'candidate';
  stage?: 'proposal' | 'review';
  closed: boolean;
  feedbackVersion: number;
  legacyNote?: string;
}
export interface LiveInput {
  protocol: 1;
  topic: LiveState['topic'];
  newTranscript: TranscriptSegment[];
  recentTranscript: TranscriptSegment[];
  recalled: { item: LiveMemory; quotes: TranscriptSegment[] }[];
  contributions: Contribution[];
  candidate?: LiveCandidate;
  evidence?: TranscriptSegment[];
}
export interface LiveProposal {
  protocol: 1;
  topic: LiveState['topic'];
  topicChanged: boolean;
  updates: LiveMemory[];
  decision: 'wait' | 'silent' | 'candidate';
  reason: string;
  candidate: LiveCandidate | null;
}
export interface LiveReview {
  protocol: 1;
  accept: boolean;
  reason: string;
}
export interface LiveResult<T = LiveProposal | LiveReview> {
  value: T;
  latencyMs: number;
  firstTokenMs: number;
  usage?: { input: number; output: number };
}
export function emptyLive(): LiveState {
  return {
    protocol: 1,
    topic: null,
    memory: [],
    contributions: [],
    activeId: null,
    decision: 'wait',
    closed: false,
    feedbackVersion: 0,
  };
}
