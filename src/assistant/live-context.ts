import type { TranscriptSegment } from '../transcription/types';
import type { AnalysisInput, AssistantSnapshot } from './types';
import type { LiveCandidate } from './live-types';
export const estimateTokens = (v: unknown) =>
  Math.ceil(new TextEncoder().encode(JSON.stringify(v)).length / 3);
const terms = (s: string) => new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
export function liveContext(
  s: AssistantSnapshot,
  all: TranscriptSegment[],
  goal: string,
  review?: LiveCandidate,
): AnalysisInput {
  const live = s.live!;
  const pending: TranscriptSegment[] = [];
  for (const segment of all.filter((t) => t.id > s.lastSegmentId)) {
    if (estimateTokens([...pending, segment]) > 2500) {
      if (!pending.length) throw new Error('A transcript segment exceeds the context budget.');
      break;
    }
    pending.push(segment);
  }
  const end = review ? (all.at(-1)?.endMs ?? 0) : (pending.at(-1)?.endMs ?? all.at(-1)?.endMs ?? 0);
  const recent: TranscriptSegment[] = [];
  for (const segment of all.filter((t) => t.endMs <= end && t.endMs >= end - 90000).reverse()) {
    if (estimateTokens([...recent, segment]) <= 2500) recent.unshift(segment);
  }
  const query = terms([...pending.map((t) => t.text), live.topic?.label ?? ''].join(' '));
  const ranked = live.memory
    .map((item) => {
      const overlap = [...terms(item.text + ' ' + item.topic)].filter((t) => query.has(t)).length;
      return {
        item,
        score:
          overlap +
          (item.topic === live.topic?.key && ['constraint', 'open'].includes(item.kind) ? 4 : 0),
      };
    })
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score);
  const recalled: NonNullable<AnalysisInput['liveInput']>['recalled'] = [];
  const must = new Set([...(review?.sources ?? []), ...(live.topic?.sources ?? [])]);
  for (const { item } of ranked) {
    const record = { item, quotes: all.filter((t) => item.sources.includes(t.id)) };
    if (estimateTokens([...recalled, record]) <= 1500) recalled.push(record);
  }
  const source = all.filter((t) => must.has(t.id));
  const unique = new Map(
    [...recent, ...pending, ...source, ...recalled.flatMap((r) => r.quotes)].map((t) => [t.id, t]),
  );
  return {
    requestId: crypto.randomUUID(),
    sessionId: s.sessionId!,
    version: s.version + 1,
    goal,
    segments: [...unique.values()],
    memory: [],
    history: [],
    contextGap: false,
    newSegmentIds: pending.map((t) => t.id),
    liveInput: {
      protocol: 1,
      topic: live.topic,
      newTranscript: review ? [] : pending,
      recentTranscript: recent,
      recalled,
      evidence: source,
      contributions: [
        ...new Map(
          [
            ...live.contributions
              .filter((c) => c.topic === live.topic?.key && c.feedback)
              .slice(-6),
            ...live.contributions.slice(-8),
          ].map((c) => [c.id, c]),
        ).values(),
      ],
      ...(review ? { candidate: review } : {}),
    },
  };
}
