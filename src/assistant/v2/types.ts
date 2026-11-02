import type { TranscriptSegment } from '../../transcription/types';
import type { LiveMemory, LiveCandidate, Contribution, LiveState } from '../live-types';
export const PROTOCOL = 2;
export type Topic = LiveState['topic'];
export type ContributionStatus = 'relevant' | 'previous_topic' | 'answered' | 'corrected';
export interface ContributionV2 extends Contribution {
  status: ContributionStatus;
  statusSources: number[];
  statusUpdatedAt?: number;
}
export interface Memo {
  id: string;
  text: string;
  topic: Topic;
  sources: number[];
  createdAt: number;
  throughSegmentId: number;
}
export interface State {
  protocol: 2;
  topic: Topic;
  memory: LiveMemory[];
  memo: Memo | null;
  contributions: ContributionV2[];
  activeId: string | null;
  decision: 'wait' | 'silent' | 'candidate';
  stage?: 'proposal' | 'review';
  closed: boolean;
  feedbackVersion: number;
  legacyNote?: string;
}
export interface MemoUpdate {
  action: 'keep' | 'replace';
  text: string | null;
  sources: number[];
}
export interface StatusUpdate {
  contributionId: string;
  status: ContributionStatus;
  sources: number[];
}
export interface Proposal {
  protocol: 2;
  topic: Topic;
  topicChanged: boolean;
  updates: LiveMemory[];
  decision: 'wait' | 'silent' | 'candidate';
  reason: string;
  memoUpdate: MemoUpdate;
  candidate: LiveCandidate | null;
  statusUpdate: StatusUpdate | null;
}
export interface Verdict {
  accept: boolean;
  reason: string;
}
export interface Review {
  protocol: 2;
  memo: Verdict;
  contribution: Verdict;
  status: Verdict;
}
export interface Input {
  protocol: 2;
  topic: Topic;
  memo: Memo | null;
  activeContribution: ContributionV2 | null;
  newTranscript: TranscriptSegment[];
  recentTranscript: TranscriptSegment[];
  recalled: { item: LiveMemory; quotes: TranscriptSegment[] }[];
  contributions: ContributionV2[];
  evidence: TranscriptSegment[];
  proposed?: {
    memoUpdate: MemoUpdate;
    candidate: LiveCandidate | null;
    statusUpdate: StatusUpdate | null;
    topic: Topic;
  };
}
export interface Result<T = Proposal | Review> {
  value: T;
  latencyMs: number;
  firstTokenMs: number;
  usage?: { input: number; output: number };
  componentErrors?: string[];
}
export const emptyState = (): State => ({
  protocol: 2,
  topic: null,
  memory: [],
  memo: null,
  contributions: [],
  activeId: null,
  decision: 'wait',
  closed: false,
  feedbackVersion: 0,
});
