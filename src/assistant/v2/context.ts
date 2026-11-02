import type { AssistantSnapshot, AnalysisInput } from '../types';
import type { TranscriptSegment } from '../../transcription/types';
import type { Proposal, State } from './types';
import { liveContext } from '../live-context';
export function context(
  snapshot: AssistantSnapshot,
  all: TranscriptSegment[],
  goal: string,
  proposed?: Proposal,
): AnalysisInput {
  const state = snapshot.liveV2!;
  const basis = liveContext(
    { ...snapshot, live: { ...state, protocol: 1 } },
    all,
    goal,
    proposed?.candidate ?? undefined,
  );
  // Review always reads the latest ASR, even for a memo-only update.
  if (proposed && !proposed.candidate) {
    const probe = liveContext({ ...snapshot, live: { ...state, protocol: 1 } }, all, goal, {
      kind: 'explanation',
      title: null,
      body: 'review',
      sources: [],
      interpretation: false,
      generalKnowledge: false,
      proposal: false,
    });
    basis.liveInput = probe.liveInput;
    basis.segments = probe.segments;
  }
  const v = basis.liveInput!;
  const wanted = new Set([
    ...(state.memo?.sources ?? []),
    ...(state.contributions.find((c) => c.id === state.activeId)?.sources ?? []),
    ...(state.contributions.find((c) => c.id === state.activeId)?.statusSources ?? []),
    ...(proposed?.memoUpdate.sources ?? []),
    ...(proposed?.statusUpdate?.sources ?? []),
    ...(proposed?.topic?.sources ?? []),
  ]);
  const evidence = [
    ...new Map(
      [...(v.evidence ?? []), ...all.filter((t) => wanted.has(t.id))].map((t) => [t.id, t]),
    ).values(),
  ];
  const contributions = v.contributions
    .map((c) => state.contributions.find((i) => i.id === c.id)!)
    .filter(Boolean);
  return {
    ...basis,
    liveInput: undefined,
    liveV2Input: {
      protocol: 2,
      topic: state.topic,
      memo: state.memo,
      activeContribution: state.contributions.find((c) => c.id === state.activeId) ?? null,
      newTranscript: proposed ? [] : v.newTranscript,
      recentTranscript: v.recentTranscript,
      recalled: v.recalled,
      evidence,
      contributions,
      ...(proposed
        ? {
            proposed: {
              memoUpdate: proposed.memoUpdate,
              candidate: proposed.candidate,
              statusUpdate: proposed.statusUpdate,
              topic: proposed.topic,
            },
          }
        : {}),
    },
    segments: [...new Map([...basis.segments, ...evidence].map((t) => [t.id, t])).values()],
  };
}
export function migration(s: AssistantSnapshot): AssistantSnapshot {
  if (s.liveV2) return { ...s, liveV2: { ...s.liveV2, closed: true, stage: undefined } };
  const old = s.live;
  const liveV2: State = {
    protocol: 2,
    topic: old?.topic ?? null,
    memory: old?.memory ?? [],
    memo: null,
    contributions: (old?.contributions ?? []).map((c) => ({
      ...c,
      status: 'previous_topic',
      statusSources: [],
    })),
    activeId: old?.activeId ?? null,
    decision: 'wait',
    closed: true,
    feedbackVersion: old?.feedbackVersion ?? 0,
    legacyNote: old?.legacyNote ?? (!old ? s.summary || undefined : undefined),
  };
  return { ...s, live: undefined, liveV2, summary: '', summaries: [], question: null };
}
