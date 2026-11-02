import { expect, it } from 'vitest';
import { supportReport } from '../src/support-report';
import { emptyAssistant } from '../src/assistant/controller';
it('exports selected failure metadata without keys, text, notes, questions, or arbitrary exception data', () => {
  const snapshot = {
    ...emptyAssistant(),
    summary: 'private memo',
    message: 'private error',
    apiKey: 'private key',
    deeper: 'private deeper',
    memory: [{ text: 'private memory' }],
    lastFailure: {
      at: 1,
      requestId: 'internal',
      status: 0,
      category: 'format',
      reason: 'schema_mismatch',
      count: 3,
      response: 'private response',
      validationIssues: [
        { field: 'summary', code: 'too_big', limit: 2400, size: 2800, input: 'private input' },
      ],
    },
  } as any;
  const report = supportReport(snapshot, '0.7.2');
  expect(report.assistant.memoCharacters).toBe(12);
  expect(report.assistant.lastFailure?.validationIssues).toEqual([
    { field: 'summary', code: 'too_big', limit: 2400, size: 2800 },
  ]);
  expect(JSON.stringify(report)).not.toContain('private');
  expect(report.assistant.lastFailure?.build).toContain('older build');
});
it('reports no saved failure without starting work', () => {
  expect(supportReport(emptyAssistant(), '0.7.2').assistant.lastFailure).toBeNull();
});

it('correlates response, actual stored memo and panel, distinguishing empty output from commit, save and render problems', async () => {
  const { memoVerification } = await import('../src/support-report');
  const source = {
    ...emptyAssistant(),
    sessionId: 's',
    version: 1,
    lastAnalysis: {
      requestId: 's:1',
      version: 1,
      at: 1,
      summaryCharacters: 0,
      memoCharacters: 0,
      outcome: 'empty' as const,
    },
  };
  const panel = {
    sessionId: 's',
    requestId: 's:1',
    version: 1,
    memoCharacters: 0,
    domCharacters: 0,
    view: 'summary',
    emptyOutcomeMessage: true,
  };
  expect(memoVerification(source, source, panel).finding).toBe('confirmed_empty_summary');
  const nonempty = {
    ...source,
    lastAnalysis: { ...source.lastAnalysis, summaryCharacters: 10, outcome: 'updated' as const },
  };
  expect(memoVerification(nonempty, source, panel).finding).toBe('response_not_committed');
  const committed = { ...nonempty, summary: 'A real memo' };
  expect(memoVerification(committed, source, panel).finding).toBe('memo_not_saved');
  expect(memoVerification(committed, committed, panel).finding).toBe('memo_not_rendered');
  expect(
    memoVerification(committed, committed, { ...panel, memoCharacters: 11, domCharacters: 11 })
      .finding,
  ).toBe('memo_rendered');
  expect(memoVerification(source, source, { ...panel, requestId: 's:old' }).finding).toBe(
    'not_enough_correlated_data',
  );
  expect(memoVerification(source).finding).toBe('not_enough_correlated_data');
});

it('does not diagnose a current failed request as an old successful empty response', async () => {
  const { memoVerification } = await import('../src/support-report');
  const snapshot = {
    ...emptyAssistant(),
    sessionId: 's',
    version: 1,
    analysisError: 'Model failure',
    lastAnalysis: {
      requestId: 's:1',
      version: 1,
      at: 1,
      summaryCharacters: 0,
      memoCharacters: 0,
      outcome: 'empty' as const,
    },
  };
  const panel = {
    sessionId: 's',
    requestId: 's:1',
    version: 1,
    memoCharacters: 0,
    domCharacters: 0,
    view: 'summary',
    emptyOutcomeMessage: true,
  };
  expect(memoVerification(snapshot, snapshot, panel).finding).toBe(
    'validated_result_followed_by_failure',
  );
});
