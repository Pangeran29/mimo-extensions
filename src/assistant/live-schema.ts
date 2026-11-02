import { z } from 'zod';
import type { AnalysisInput } from './types';
import { AssistantAPIError } from './errors';
const refs = z.array(z.number().int().nonnegative()).min(1).max(8);
const topic = z.strictObject({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(180),
  sources: refs,
});
const memory = z.strictObject({
  key: z.string().min(1).max(120),
  kind: z.enum(['fact', 'constraint', 'proposal', 'decision', 'open', 'resolved', 'correction']),
  topic: z.string().min(1).max(120),
  text: z.string().min(1).max(600),
  sources: refs,
  replaces: z.string().max(120).nullable(),
});
const candidate = z.strictObject({
  kind: z.enum(['question', 'explanation', 'connection', 'suggestion', 'correction']),
  title: z.string().min(1).max(120).nullable(),
  body: z.string().trim().min(1).max(1200),
  sources: refs,
  interpretation: z.boolean(),
  generalKnowledge: z.boolean(),
  proposal: z.boolean(),
});
export const ProposalSchema = z.strictObject({
  protocol: z.literal(1),
  topic: topic.nullable(),
  topicChanged: z.boolean(),
  updates: z.array(memory).max(8),
  decision: z.enum(['wait', 'silent', 'candidate']),
  reason: z.string().min(1).max(600),
  candidate: candidate.nullable(),
});
export const ReviewSchema = z.strictObject({
  protocol: z.literal(1),
  accept: z.boolean(),
  reason: z.string().min(1).max(600),
});
export const PROPOSAL_JSON_SCHEMA = z.toJSONSchema(ProposalSchema);
export const REVIEW_JSON_SCHEMA = z.toJSONSchema(ReviewSchema);
export function validateLive(raw: unknown, input: AnalysisInput, review = false) {
  if (review) return ReviewSchema.parse(raw);
  const value = ProposalSchema.parse(raw);
  if ((value.decision === 'candidate') !== !!value.candidate)
    throw new AssistantAPIError(0, 0, 'format', 'schema_mismatch');
  const known = new Set(input.segments.map((s) => s.id));
  for (const ids of [
    value.topic?.sources ?? [],
    ...value.updates.map((m) => m.sources),
    value.candidate?.sources ?? [],
  ])
    if (ids.some((id) => !known.has(id)))
      throw new AssistantAPIError(0, 0, 'format', 'unknown_evidence');
  if (value.candidate && /(^|\n)\s*(#{1,6}\s|```)/.test(value.candidate.body))
    throw new AssistantAPIError(0, 0, 'format', 'schema_mismatch');
  return value;
}
