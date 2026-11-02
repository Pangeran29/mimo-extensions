import type { AssistantSnapshot } from '../assistant/types';
import { REPLAY_LAB } from './config';

/** Full-content research observations. These are never emitted by the regular build. */
let current: AssistantSnapshot | undefined;
export function setPresentationContext(snapshot: AssistantSnapshot): void {
  current = snapshot;
}

export function v2PresentationFields(snapshot: AssistantSnapshot) {
  const state = snapshot.liveV2;
  const contribution = state?.contributions.find((item) => item.id === state.activeId);
  return {
    sessionId: snapshot.sessionId,
    requestId: snapshot.lastAnalysis?.requestId,
    version: snapshot.version,
    memoId: state?.memo?.id ?? null,
    memoCharacters: state?.memo?.text.length ?? 0,
    contributionId: contribution?.id ?? null,
    contributionStatus: contribution?.status ?? null,
    contributionCharacters: contribution?.body.length ?? 0,
  };
}

export function presentationEvent(
  kind: string,
  data: Record<string, unknown> = {},
  sessionId = current?.sessionId,
): void {
  if (!REPLAY_LAB || !sessionId) return;
  try {
    void chrome.runtime
      .sendMessage({
        target: 'worker',
        type: 'REPLAY_UI_EVENT',
        sessionId,
        event: {
          kind,
          at: Date.now(),
          monotonicMs: performance.now(),
          timeOrigin: performance.timeOrigin,
          data: {
            ...(current?.sessionId === sessionId ? v2PresentationFields(current) : {}),
            ...data,
          },
        },
      })
      .catch(() => {});
  } catch {
    // Research capture must never affect presentation or recording controls.
  }
}

interface Revision {
  sessionId?: string;
  memoId: string | null;
  contributionId: string | null;
  status: string | null;
  feedback: string | null;
}
export interface PresentationChanges {
  initial: boolean;
  memoChanged: boolean;
  contributionChanged: boolean;
  statusChanged: boolean;
  feedbackChanged: boolean;
}
/** Tracks identity, not version: a silent inference is not a fresh displayed output. */
export class V2PresentationTracker {
  private receivedKey?: string;
  private applied?: Revision;
  revision = 0;

  received(snapshot: AssistantSnapshot): boolean {
    const state = snapshot.liveV2;
    const key = JSON.stringify([
      this.fields(snapshot),
      snapshot.version,
      snapshot.phase,
      state?.stage,
      state?.decision,
      state?.closed,
      snapshot.lastAnalysis?.requestId,
    ]);
    if (this.receivedKey === key) return false;
    this.receivedKey = key;
    return true;
  }

  apply(snapshot: AssistantSnapshot): PresentationChanges | undefined {
    if (!snapshot.liveV2) return;
    const next = this.fields(snapshot),
      previous = this.applied,
      initial = !previous || previous.sessionId !== next.sessionId;
    const changes = {
      initial,
      memoChanged: initial || previous.memoId !== next.memoId,
      contributionChanged: initial || previous.contributionId !== next.contributionId,
      statusChanged: initial || previous.status !== next.status,
      feedbackChanged: initial || previous.feedback !== next.feedback,
    };
    if (!Object.values(changes).some(Boolean)) return;
    this.applied = next;
    this.revision++;
    return changes;
  }

  private fields(snapshot: AssistantSnapshot): Revision {
    const state = snapshot.liveV2,
      contribution = state?.contributions.find((item) => item.id === state.activeId);
    return {
      sessionId: snapshot.sessionId,
      memoId: state?.memo?.id ?? null,
      contributionId: contribution?.id ?? null,
      status: contribution?.status ?? null,
      feedback: contribution?.feedback ?? null,
    };
  }
}
