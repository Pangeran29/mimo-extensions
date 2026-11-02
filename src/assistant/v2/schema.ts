import { z } from 'zod';
import type { AnalysisInput } from '../types';
import type { Proposal, Review } from './types';
import { AssistantAPIError } from '../errors';
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
const memo = z.strictObject({
  action: z.enum(['keep', 'replace']),
  text: z.string().trim().min(1).max(600).nullable(),
  sources: z.array(z.number().int().nonnegative()).max(8),
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
const status = z.strictObject({
  contributionId: z.string().min(1).max(160),
  status: z.enum(['relevant', 'previous_topic', 'answered', 'corrected']),
  sources: refs,
});
const base = {
  protocol: z.literal(2),
  topic: topic.nullable(),
  topicChanged: z.boolean(),
  updates: z.array(memory).max(8),
  decision: z.enum(['wait', 'silent', 'candidate']),
  reason: z.string().min(1).max(600),
};
export const ProposalSchema = z.strictObject({
  ...base,
  memoUpdate: memo,
  candidate: candidate.nullable(),
  statusUpdate: status.nullable(),
});
const envelope = z.strictObject({
  ...base,
  memoUpdate: z.unknown(),
  candidate: z.unknown(),
  statusUpdate: z.unknown(),
});
const verdict = z.strictObject({ accept: z.boolean(), reason: z.string().min(1).max(600) });
export const ReviewSchema = z.strictObject({
  protocol: z.literal(2),
  memo: verdict,
  contribution: verdict,
  status: verdict,
});
export const PROPOSAL_JSON_SCHEMA = z.toJSONSchema(ProposalSchema);
export const REVIEW_JSON_SCHEMA = z.toJSONSchema(ReviewSchema);
const keep = () => ({ action: 'keep' as const, text: null, sources: [] });
const plain = (s: string) => !/(^|\n)\s*(#{1,6}\s|```)/.test(s);
// Conservative entailment guard for ambiguous actor/object wording in ASR.
// "No decision by participants" does not establish anything about selecting attendees.
function unsupportedSelectionClaim(text: string, quotes: string): boolean {
  const objectClaim =
    /(keputusan\s+(?:mengenai|tentang|soal|terkait)\s+peserta|peserta(?:\s+acara)?\s+(?:belum|sudah|telah|akan)?\s*(?:diputuskan|ditentukan|ditetapkan|dipilih)|(?:attendees|participants)\s+(?:have\s+not\s+been|were\s+not|are\s+not|were|are)?\s*(?:selected|chosen)|decision\s+(?:about|regarding|on)\s+(?:the\s+)?(?:attendees|participants))/i;
  const explicitObject =
    /(daftar\s+peserta|pemilihan\s+peserta|(?:memilih|menentukan|menetapkan)\s+peserta|keputusan\s+(?:mengenai|tentang|soal|terkait)\s+peserta|peserta(?:\s+acara)?\s+(?:belum|sudah|telah|akan)?\s*(?:diputuskan|ditentukan|ditetapkan|dipilih)|(?:select|choose|selection\s+of)\s+(?:the\s+)?(?:attendees|participants)|(?:attendees|participants)\s+(?:were|are|have\s+been)\s+(?:selected|chosen))/i;
  return objectClaim.test(text) && !explicitObject.test(quotes);
}
export function validateV2(
  raw: unknown,
  input: AnalysisInput,
  review = false,
): { value: Proposal | Review; componentErrors: string[] } {
  if (review) return { value: ReviewSchema.parse(raw), componentErrors: [] };
  const root = envelope.parse(raw);
  const known = new Set(input.segments.map((s) => s.id));
  const validRefs = (ids: number[]) => ids.every((id) => known.has(id));
  if (!validRefs(root.topic?.sources ?? []) || root.updates.some((m) => !validRefs(m.sources)))
    throw new AssistantAPIError(0, 0, 'format', 'unknown_evidence');
  const errors: string[] = [];
  let memoUpdate: Proposal['memoUpdate'] = keep(),
    contribution: Proposal['candidate'] = null,
    statusUpdate: Proposal['statusUpdate'] = null;
  try {
    const v = memo.parse(root.memoUpdate);
    if (
      v.action === 'keep'
        ? v.text !== null || v.sources.length > 0
        : !v.text || !v.sources.length || !plain(v.text)
    )
      throw Error();
    if (!validRefs(v.sources)) throw Error();
    if (
      v.text &&
      unsupportedSelectionClaim(
        v.text,
        input.segments
          .filter((s) => v.sources.includes(s.id))
          .map((s) => s.text)
          .join(' '),
      )
    )
      throw Error();
    memoUpdate = v;
  } catch {
    errors.push('memo');
  }
  try {
    if (root.candidate !== null) {
      const v = candidate.parse(root.candidate);
      if (root.decision !== 'candidate' || !validRefs(v.sources) || !plain(v.body)) throw Error();
      contribution = v;
    } else if (root.decision === 'candidate') throw Error();
  } catch {
    errors.push('contribution');
  }
  try {
    if (root.statusUpdate !== null) {
      const v = status.parse(root.statusUpdate);
      if (
        (v.status === 'answered' && input.liveV2Input?.activeContribution?.kind !== 'question') ||
        v.contributionId !== input.liveV2Input?.activeContribution?.id ||
        !validRefs(v.sources)
      )
        throw Error();
      statusUpdate = v;
    }
  } catch {
    errors.push('status');
  }
  return {
    value: {
      ...root,
      memoUpdate,
      candidate: contribution,
      statusUpdate,
      decision: root.decision === 'candidate' && !contribution ? 'silent' : root.decision,
    } as Proposal,
    componentErrors: errors,
  };
}
