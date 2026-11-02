import { z } from 'zod';
import { AssistantAPIError, formatError } from './errors';
import type { Analysis, AnalysisInput, QuestionRecord } from './types';
const refs = z.array(z.number().int().nonnegative()).min(1).max(4);
export const AnalysisSchema = z
  .object({
    question: z
      .object({
        text: z.string().min(5).max(220),
        reason: z.string().min(3).max(180),
        issueKey: z.string().min(3).max(80),
        evidenceSegmentIds: refs,
      })
      .strict()
      .nullable(),
    summary: z.string().max(2400),
    updates: z
      .array(
        z
          .object({
            kind: z.enum(['fact', 'decision', 'open', 'resolved']),
            key: z.string().min(3).max(80),
            text: z.string().max(180),
            evidenceSegmentIds: refs,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisSchema, {
  target: 'draft-7',
});
export function validateAnalysis(value: unknown, input: AnalysisInput): Analysis {
  let parsed;
  try {
    parsed = AnalysisSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => {
        const field =
          issue.path
            .map((p) => (typeof p === 'number' ? '[]' : String(p)))
            .join('.')
            .replace(/\.\[\]/g, '[]') || 'response';
        let received: unknown = value;
        // Values are used only to count string/array size, never retained.
        for (const part of issue.path) {
          if (!received || typeof received !== 'object') {
            received = undefined;
            break;
          }
          received = (received as Record<PropertyKey, unknown>)[part];
        }
        return {
          field,
          code: issue.code,
          limit:
            issue.code === 'too_big'
              ? issue.maximum
              : issue.code === 'too_small'
                ? issue.minimum
                : undefined,
          size:
            typeof received === 'string' || Array.isArray(received) ? received.length : undefined,
        };
      });
      throw new AssistantAPIError(0, 0, 'format', 'schema_mismatch', issues);
    }
    throw formatError(error);
  }
  const known = new Set([
    ...input.segments.map((s) => s.id),
    ...input.memory.flatMap((m) => m.evidenceSegmentIds),
  ]);
  for (const item of [...parsed.updates, ...(parsed.question ? [parsed.question] : [])]) {
    if (item.evidenceSegmentIds.some((id) => !known.has(id)))
      throw new AssistantAPIError(0, 0, 'format', 'unknown_evidence');
  }
  if (
    parsed.question &&
    /^(any (questions|thoughts|concerns)|anything (else|to add)|can you (elaborate|tell me more)|ada (pertanyaan|yang ingin ditambahkan)|bisa (jelaskan lebih lanjut|ceritakan lebih banyak))$/.test(
      normalize(parsed.question.text),
    )
  )
    parsed.question = null;
  return parsed;
}
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function duplicateQuestion(
  question: Analysis['question'],
  history: QuestionRecord[],
): boolean {
  if (!question) return false;
  const words = new Set(normalize(question.text).split(' '));
  return history.some((old) => {
    if (normalize(old.issueKey) === normalize(question.issueKey)) return true;
    const other = new Set(normalize(old.text).split(' '));
    const common = [...words].filter((w) => other.has(w)).length;
    return common / Math.max(1, new Set([...words, ...other]).size) >= 0.65;
  });
}
