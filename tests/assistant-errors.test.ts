import { expect, it } from 'vitest';
import { AssistantAPIError, safeValidationIssues } from '../src/assistant/errors';
it('drops private fields, schema messages, unknown paths and model-chosen enum values', () => {
  const safe = safeValidationIssues([
    {
      field: 'summary',
      code: 'too_big',
      limit: 2400,
      size: 2800,
      input: 'private',
      message: 'private',
    },
    { field: 'private injected path', code: 'invalid_value', expected: 'private' },
    { field: 'updates[].kind', code: 'invalid_value', values: ['private'] },
  ]);
  expect(safe).toEqual([
    { field: 'summary', code: 'too_big', limit: 2400, size: 2800 },
    { field: 'updates[].kind', code: 'invalid_value' },
  ]);
  expect(
    JSON.stringify(new AssistantAPIError(0, 0, 'format', 'schema_mismatch', safe)),
  ).not.toContain('private');
  expect(
    safeValidationIssues([{ field: 'summary', code: 'too_big', size: 1e12, limit: -1 }]),
  ).toEqual([{ field: 'summary', code: 'too_big' }]);
});
