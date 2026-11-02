import { expect, it } from 'vitest';
import { meetingMemo, memoBlocks } from '../src/assistant/summaries';
import { messages } from '../src/assistant/prompt';
import { validateAnalysis } from '../src/assistant/schema';
import type { AnalysisInput, SummaryRevision } from '../src/assistant/types';

it('shows the current memo without concatenating older versions', () => {
  const revision = {
    format: 'memo',
    version: 2,
    summary: 'Current memo.',
    createdAt: 1,
    memory: [],
    evidenceSegmentIds: [],
  } as SummaryRevision;
  expect(meetingMemo({ summary: 'Current memo.', summaries: [revision] })).toBe('Current memo.');
  expect(meetingMemo({ summary: '', summaries: [revision] })).toBe('Current memo.');
});
it('consolidates old incremental notes for context until the model revises them', () => {
  const note = {
    format: 'incremental',
    version: 1,
    summary: 'First point.',
    createdAt: 1,
    memory: [],
    evidenceSegmentIds: [],
  } as SummaryRevision;
  expect(
    meetingMemo({
      summary: 'New point.',
      summaries: [note, { ...note, version: 2, summary: 'New point.' }, { ...note, version: 3 }],
    }),
  ).toBe('First point.\n\nNew point.');
});
it('parses a safe memo document with stable section keys across updates', () => {
  const first = memoBlocks('# Launch\nOverview.\n## Decisions\n- Friday release.\n- Scope fixed.');
  const next = memoBlocks('# Launch\nOverview updated.\n## Decisions\n- Monday release.');
  expect(first.map((block) => block.type)).toEqual(['title', 'paragraph', 'heading', 'list']);
  expect(first.map((block) => block.key)).toEqual(next.map((block) => block.key));
  expect(first[3].lines).toEqual(['Friday release.', 'Scope fixed.']);
  expect(memoBlocks('<script>alert(1)</script>')[0].lines[0]).toBe('<script>alert(1)</script>');
});

it('presents only unprocessed speech as new transcript, with earlier context separate', () => {
  const input: AnalysisInput = {
    sessionId: 'test',
    version: 2,
    goal: '',
    memory: [],
    history: [],
    contextGap: false,
    previousSummary: 'An introduction.',
    recentSummaries: ['An introduction.'],
    newSegmentIds: [1],
    segments: [0, 1].map((id) => ({
      id,
      sessionId: 'test',
      startMs: id * 8000,
      endMs: id * 8000 + 7000,
      text: id ? 'A new point.' : 'An introduction.',
    })),
  };
  const payload = JSON.parse(messages(input)[1].content);
  expect(payload.newTranscript.map((s: { id: number }) => s.id)).toEqual([1]);
  expect(payload.earlierTranscript.map((s: { id: number }) => s.id)).toEqual([0]);
  expect(payload.recentSummaries).toEqual(['An introduction.']);
});

it('accepts a full memo beyond the former short-update limit and still enforces a bound', () => {
  const input: AnalysisInput = {
    sessionId: 'test',
    version: 1,
    goal: '',
    memory: [],
    history: [],
    contextGap: false,
    segments: [],
  };
  expect(
    validateAnalysis({ summary: 'Memo. '.repeat(100), updates: [], question: null }, input).summary
      .length,
  ).toBe(600);
  expect(() =>
    validateAnalysis({ summary: 'a'.repeat(2401), updates: [], question: null }, input),
  ).toThrow();
});
