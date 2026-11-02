import { expect, it } from 'vitest';
import { assistantPresence, summaryChanges } from '../src/assistant/presentation';
import { emptyAssistant } from '../src/assistant/controller';
import { emptyState } from '../src/assistant/v2/types';
import type { Status } from '../src/types';
import type { TranscriptSnapshot } from '../src/transcription/types';
const recording: Status = { phase: 'recording', retained: [] };
const ai = { ...emptyAssistant(), phase: 'listening' as const, sessionId: 'test' };
const transcript: TranscriptSnapshot = {
  phase: 'transcribing',
  sessionId: 'test',
  modelReady: true,
  incomplete: false,
  lagMs: 0,
  segments: [],
};
it('distinguishes actual speech, recognition and AI activity without an invented 8-second timer', () => {
  expect(assistantPresence(recording, ai, { ...transcript, activity: 'waiting' }).label).toBe(
    'Wait…',
  );
  expect(assistantPresence(recording, ai, { ...transcript, activity: 'speech' }).label).toBe(
    'I hear you.',
  );
  expect(assistantPresence(recording, ai, { ...transcript, activity: 'recognizing' }).label).toBe(
    'Catching that…',
  );
  const thinking = assistantPresence(
    recording,
    { ...ai, phase: 'thinking', analyzingSince: 1000 },
    { ...transcript, activity: 'recognizing' },
    11000,
  );
  expect(thinking.label).toBe('Thinking it through…');
  expect(thinking.seconds).toBe(10);
  expect(thinking.detail).toContain('longer than usual');
});
it('does not advertise successful updates during an authentication failure or stopped transcription', () => {
  expect(
    assistantPresence(recording, { ...ai, phase: 'paused', updatedAt: Date.now() }, transcript)
      .recovery,
  ).toBe('retry');
  expect(assistantPresence(recording, ai, { ...transcript, phase: 'failed' }).recovery).toBe(
    'settings',
  );
  expect(assistantPresence({ phase: 'save-failed', retained: [] }, ai, transcript).key).toBe(
    'save-failed',
  );
});
it('acknowledges unchanged results without pretending that a new revision arrived', () => {
  const result = assistantPresence(
    recording,
    {
      ...ai,
      summary: 'Same summary.',
      updatedAt: 2000,
      summaries: [
        {
          version: 1,
          createdAt: 1000,
          summary: 'Same summary.',
          evidenceSegmentIds: [],
          memory: [],
        },
      ],
    },
    transcript,
    2500,
  );
  expect(result.label).toBe('Still with you.');
  expect(result.detail).toBe('No new takeaways yet.');
});
it('marks changed text safely while preserving punctuation, spacing, and multilingual content', () => {
  const next = 'Target Jumat. Maya owns QA.';
  const diff = summaryChanges('Target Jumat. QA is unassigned.', next);
  expect(diff.map((p) => p.text).join('')).toBe(next);
  expect(
    diff
      .filter((p) => p.added)
      .map((p) => p.text)
      .join(''),
  ).toContain('Maya');
  expect(summaryChanges(next, next).every((p) => !p.added)).toBe(true);
  expect(summaryChanges('', '<script>alert(1)</script>')[0].text).toBe('<script>alert(1)</script>');
});

it('shows the live reading view only during a session or while its work finishes', async () => {
  const { showLiveAssistant } = await import('../src/assistant/presentation');
  expect(showLiveAssistant({ phase: 'idle', retained: [] })).toBe(false);
  expect(showLiveAssistant({ phase: 'recording', retained: [] })).toBe(true);
  expect(showLiveAssistant({ phase: 'starting', retained: [] })).toBe(false);
  expect(showLiveAssistant({ phase: 'idle', retained: [], assistantBusy: true })).toBe(false);
  expect(showLiveAssistant({ phase: 'idle', retained: [], assistantBusy: true }, true)).toBe(true);
  expect(showLiveAssistant({ phase: 'save-failed', retained: [] })).toBe(false);
});

it('shows a failed summary limit alongside the automatic retry countdown', () => {
  const presence = assistantPresence(
    recording,
    {
      ...ai,
      analysisError: 'Invalid result',
      retryAt: 20000,
      lastFailure: {
        at: 0,
        requestId: 'test:1',
        status: 0,
        category: 'format',
        reason: 'schema_mismatch',
        count: 1,
        validationIssues: [{ field: 'summary', code: 'too_big', limit: 2400, size: 2800 }],
      },
    },
    transcript,
    3000,
  );
  expect(presence.detail).toContain('Notes exceeded 2400 characters (received 2800)');
  expect(presence.detail).toContain('Retrying in 17s');
});

it('explains validated empty notes and never infers that outcome from a timer or no transcript alone', () => {
  const empty = {
    ...ai,
    updatedAt: 1000,
    lastAnalysis: {
      requestId: 'test:1',
      version: 1,
      at: 1000,
      summaryCharacters: 0,
      memoCharacters: 0,
      outcome: 'empty' as const,
    },
  };
  const presence = assistantPresence(recording, empty, transcript, 1100);
  expect(presence.key).toBe('no-new-notes');
  expect(presence.detail).toContain('returned no notes');
  expect(assistantPresence(recording, ai, transcript, 1100).key).not.toBe('no-new-notes');
  expect(
    assistantPresence(
      recording,
      { ...empty, analysisError: 'failure', retryAt: 10000 },
      transcript,
      1100,
    ).key,
  ).toBe('retrying');
  expect(assistantPresence(recording, { ...empty, phase: 'thinking' }, transcript, 1100).key).toBe(
    'thinking',
  );
});


it('keeps live automatic retries distinct from a manual recovery action', () => {
  const presence = assistantPresence(recording, {
    ...ai, liveV2: { ...emptyState(), closed: false },
    analysisError: 'The AI service is temporarily unavailable.', retryAt: 20000,
  }, transcript, 15000);
  expect(presence.key).toBe('live-retrying');
  expect(presence.detail).toContain('temporarily unavailable');
  expect(presence.detail).toContain('automatically in 5s');
  expect(presence.recovery).toBeUndefined();
  expect(presence.working).not.toBe(true);
});

it('shows an actual live review in flight instead of asking to retry its older error', () => {
  const presence = assistantPresence(recording, {
    ...ai, phase: 'thinking', liveV2: { ...emptyState(), closed: false, stage: 'review' },
    analysisError: 'AI took too long.', retryAt: 10000,
  }, transcript, 15000);
  expect(presence.key).toBe('live-working');
  expect(presence.working).toBe(true);
  expect(presence.recovery).toBeUndefined();
});

it('keeps the manual retry action for paused live work after automatic retries are exhausted', () => {
  const presence = assistantPresence(recording, {
    ...ai, phase: 'paused', liveV2: { ...emptyState(), closed: false },
    analysisError: 'AI took too long.',
  }, transcript);
  expect(presence.key).toBe('paused');
  expect(presence.detail).toContain('AI took too long');
  expect(presence.recovery).toBe('retry');
});

it('never offers to revive closed live work because an old transport error remains', () => {
  const presence = assistantPresence(recording, {
    ...ai, phase: 'complete', liveV2: { ...emptyState(), closed: true },
    analysisError: 'The AI service is temporarily unavailable.', retryAt: 20000,
  }, transcript, 15000);
  expect(presence.key).toBe('live-closed');
  expect(presence.recovery).toBeUndefined();
});
