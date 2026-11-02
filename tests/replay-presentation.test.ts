import { expect, it } from 'vitest';
import { emptyAssistant } from '../src/assistant/controller';
import { emptyState, type ContributionV2 } from '../src/assistant/v2/types';
import { v2PresentationFields, V2PresentationTracker } from '../src/replay/presentation';

const snapshot = () => ({ ...emptyAssistant(), sessionId: 'replay-a', liveV2: emptyState() });
const contribution: ContributionV2 = {
  id: 'a:contribution',
  topic: 'launch',
  createdAt: 100,
  kind: 'question',
  title: null,
  body: 'Has the support capacity been confirmed?',
  sources: [0],
  interpretation: false,
  generalKnowledge: false,
  proposal: false,
  status: 'relevant',
  statusSources: [],
};

it('does not count thinking, silent runs or identical memo IDs as new rendered output', () => {
  const tracker = new V2PresentationTracker(),
    s = snapshot();
  expect(tracker.apply(s)?.initial).toBe(true);
  s.liveV2.memo = {
    id: 'a:memo',
    text: 'The group is discussing support capacity.',
    topic: null,
    sources: [0],
    createdAt: 100,
    throughSegmentId: 0,
  };
  expect(tracker.apply(s)).toMatchObject({
    initial: false,
    memoChanged: true,
    contributionChanged: false,
  });
  s.version++;
  s.phase = 'thinking';
  s.liveV2.stage = 'proposal';
  expect(tracker.apply(s)).toBeUndefined();
  s.phase = 'listening';
  s.liveV2.decision = 'silent';
  expect(tracker.apply(s)).toBeUndefined();
});

it('separates a contribution, checked status and feedback from narrative revisions', () => {
  const tracker = new V2PresentationTracker(),
    s = snapshot();
  tracker.apply(s);
  s.liveV2.contributions = [structuredClone(contribution)];
  s.liveV2.activeId = contribution.id;
  expect(tracker.apply(s)).toMatchObject({ memoChanged: false, contributionChanged: true });
  s.liveV2.contributions[0].status = 'answered';
  s.liveV2.contributions[0].statusSources = [1];
  expect(tracker.apply(s)).toMatchObject({
    memoChanged: false,
    contributionChanged: false,
    statusChanged: true,
  });
  s.liveV2.contributions[0].feedback = 'useful';
  expect(tracker.apply(s)).toMatchObject({
    memoChanged: false,
    contributionChanged: false,
    feedbackChanged: true,
  });
  s.liveV2.activeId = null;
  expect(tracker.apply(s)?.contributionChanged).toBe(true);
});

it('marks a restored/new session as initial rather than claiming a newly generated output', () => {
  const tracker = new V2PresentationTracker(),
    s = snapshot();
  tracker.apply(s);
  s.liveV2.closed = true;
  expect(tracker.apply(s)).toBeUndefined();
  s.sessionId = 'replay-b';
  expect(tracker.apply(s)?.initial).toBe(true);
});

it('captures state transitions once while distinguishing them from displayed revisions', () => {
  const tracker = new V2PresentationTracker(),
    s = snapshot();
  expect(tracker.received(s)).toBe(true);
  expect(tracker.received(structuredClone(s))).toBe(false);
  s.liveV2.stage = 'review';
  expect(tracker.received(s)).toBe(true);
  expect(tracker.received(s)).toBe(false);
});

it('reports current v2 identities and lengths instead of legacy summary values', () => {
  const s = snapshot();
  s.summary = 'Legacy summary that must not be reported as the current narrative.';
  s.liveV2.memo = {
    id: 'a:memo',
    text: 'Current topic.',
    topic: null,
    sources: [0],
    createdAt: 100,
    throughSegmentId: 0,
  };
  s.liveV2.contributions = [contribution];
  s.liveV2.activeId = contribution.id;
  expect(v2PresentationFields(s)).toMatchObject({
    sessionId: 'replay-a',
    memoId: 'a:memo',
    memoCharacters: 'Current topic.'.length,
    contributionId: contribution.id,
    contributionStatus: 'relevant',
  });
});
