export const FAILURE_REASONS = [
  'unknown',
  'json_syntax',
  'schema_mismatch',
  'unknown_evidence',
  'response_too_large',
  'output_truncated',
  'unexpected_finish',
  'missing_tool',
  'unexpected_tool',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
const VALIDATION_FIELDS = [
  'response',
  'summary',
  'question',
  'question.text',
  'question.reason',
  'question.issueKey',
  'question.evidenceSegmentIds',
  'question.evidenceSegmentIds[]',
  'updates',
  'updates[]',
  'updates[].kind',
  'updates[].key',
  'updates[].text',
  'updates[].evidenceSegmentIds',
  'updates[].evidenceSegmentIds[]',
] as const;
const VALIDATION_CODES = [
  'invalid_type',
  'too_big',
  'too_small',
  'unrecognized_keys',
  'invalid_value',
  'other',
] as const;
export interface ValidationIssue {
  field: (typeof VALIDATION_FIELDS)[number];
  code: (typeof VALIDATION_CODES)[number];
  limit?: number;
  size?: number;
}
/** Only structural metadata. Never retain Zod messages, keys, expected values or input. */
export function safeValidationIssues(value: unknown): ValidationIssue[] | undefined {
  if (!Array.isArray(value)) return;
  const issues: ValidationIssue[] = [];
  for (const item of value.slice(0, 5)) {
    if (
      !item ||
      typeof item !== 'object' ||
      !VALIDATION_FIELDS.includes(item.field) ||
      !VALIDATION_CODES.includes(item.code)
    )
      continue;
    const issue: ValidationIssue = { field: item.field, code: item.code };
    for (const key of ['limit', 'size'] as const)
      if (Number.isSafeInteger(item[key]) && item[key] >= 0 && item[key] <= 16000)
        issue[key] = item[key];
    issues.push(issue);
  }
  return issues.length ? issues : undefined;
}
export class AssistantAPIError extends Error {
  public validationIssues?: ValidationIssue[];
  constructor(
    public status: number,
    public retryAfterMs: number = 0,
    public category = status === 408 || status === 504 ? 'timeout' : 'request',
    public reason: FailureReason = 'unknown',
    validationIssues?: unknown,
  ) {
    super(
      status === 401 || status === 403
        ? 'The selected AI connection was rejected. Check its connection in Settings, then try again.'
        : status === 429
          ? 'AI rate limit reached. Listen will wait before trying again.'
          : category === 'timeout'
            ? 'AI took too long. Recording and transcription continue.'
            : status >= 500
              ? 'The AI service is temporarily unavailable. Recording and transcription continue.'
              : category === 'format'
                ? 'The model returned an invalid result. Recording and transcription continue.'
                : 'Could not reach the AI model. Recording and transcription continue.',
    );
    this.validationIssues = safeValidationIssues(validationIssues);
  }
}

/** Safe codes only: never forward provider bodies or schema values into diagnostics. */
export function formatError(error: unknown): AssistantAPIError {
  if (error instanceof AssistantAPIError) return error;
  return new AssistantAPIError(
    0,
    0,
    'format',
    error instanceof SyntaxError
      ? 'json_syntax'
      : error instanceof Error && error.name === 'ZodError'
        ? 'schema_mismatch'
        : 'unknown',
  );
}

export function retryable(error: AssistantAPIError): boolean {
  return (
    error.status < 400 ||
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429
  );
}
