import { expect, it } from 'vitest';
import { renderReplayReport, type ReplayEvidence } from '../src/replay/report';
import { describeReplayEvent, replayEventDescriptor } from '../src/replay/describe';

it('exports transcript and model text as inert evidence, with explicit observation limits', () => {
  const payload = '<script>alert("audio")</script><img src=x onerror=alert(1)>';
  const evidence: ReplayEvidence = {
    format: 'memo-replay-lab',
    version: 1,
    exportedAt: '2026-10-31',
    run: { source: { sha256: 'abc', name: payload } },
    events: [{ kind: payload, data: { text: payload } }],
    limitations: ['DOM is not proof of paint.'],
  };
  const html = renderReplayReport(evidence);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain('DOM is not proof of paint.');
  expect(html).toContain('abc');
});

it('classifies wrapped pipeline failures and source errors using structured evidence', () => {
  expect(
    replayEventDescriptor('pipeline-diagnostic', { name: 'asr.error', status: 503 }),
  ).toMatchObject({ stage: 'error', title: 'ASR request failed' });
  expect(replayEventDescriptor('pipeline-diagnostic', { name: 'vad.window' }).stage).toBe(
    'transcript',
  );
  expect(
    replayEventDescriptor('pipeline-diagnostic', { name: 'memo.presentation_estimate' }).stage,
  ).toBe('display');
  expect(replayEventDescriptor('pipeline-diagnostic', { name: 'llm.request' }).stage).toBe('ai');
  expect(
    replayEventDescriptor('run-finished', { reason: 'source-error', partial: true }),
  ).toMatchObject({ stage: 'error', title: 'Replay ended with an error' });
  expect(replayEventDescriptor('stop-requested', { reason: 'drain-timeout' }).stage).toBe('error');
  expect(replayEventDescriptor('assistant-state', { analysisError: 'Could not save.' }).stage).toBe(
    'error',
  );
  expect(
    replayEventDescriptor('transcript-state', {
      phase: 'failed',
      message: 'Recognition is unavailable.',
    }).description,
  ).toBe('Recognition is unavailable.');
});
it('does not treat transcript words, reviewer rejection, or deliberate Stop as pipeline errors', () => {
  expect(
    replayEventDescriptor('transcript-state', {
      phase: 'transcribing',
      segments: [{ text: 'There was an error in November.' }],
    }).stage,
  ).toBe('transcript');
  expect(
    replayEventDescriptor('response', {
      text: '{"memo":{"accept":false,"reason":"Unsupported claim"}}',
    }).stage,
  ).toBe('ai');
  expect(replayEventDescriptor('stop-requested', { reason: 'manual' }).stage).toBe('audio');
  expect(replayEventDescriptor('run-finished', { reason: 'manual', partial: true }).stage).toBe(
    'audio',
  );
});
it('distinguishes proposals, reviewer verdicts, accepted states and incomplete responses', () => {
  expect(
    describeReplayEvent('response', {
      text: JSON.stringify({
        memoUpdate: { action: 'keep' },
        decision: 'silent',
        reason: 'No extra value.',
      }),
    }),
  ).toContain('keep understanding; no additional contribution');
  expect(
    describeReplayEvent('response', {
      text: JSON.stringify({
        memo: { accept: false, reason: 'Unsupported date.' },
        contribution: { accept: true },
      }),
    }),
  ).toContain('understanding rejected; contribution accepted. Unsupported date.');
  expect(describeReplayEvent('response', { text: 'unfinished' })).toContain('could not be read');
  expect(
    describeReplayEvent('assistant-state', { liveV2: { memo: { text: 'A date is proposed.' } } }),
  ).toBe('Accepted understanding: A date is proposed.');
  expect(
    describeReplayEvent('transcript-state', {
      segments: [{ id: 4, text: 'November is only proposed.' }],
    }),
  ).toBe('Latest transcript [4]: November is only proposed.');
});
