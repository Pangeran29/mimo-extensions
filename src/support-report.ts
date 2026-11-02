import { BUILD_ID } from './build-info';
import { FAILURE_REASONS, safeValidationIssues } from './assistant/errors';
import { CANDIDATES, type AssistantSnapshot } from './assistant/types';
export interface MemoPresentation {
  sessionId?: string;
  requestId?: string;
  version?: number;
  memoCharacters: number;
  domCharacters: number;
  view: string;
  emptyOutcomeMessage: boolean;
}
export function memoVerification(
  snapshot: AssistantSnapshot,
  stored?: AssistantSnapshot,
  panel?: MemoPresentation,
) {
  const response = snapshot.lastAnalysis;
  const sameStored =
    !!response &&
    snapshot.sessionId === stored?.sessionId &&
    response.requestId === stored?.lastAnalysis?.requestId &&
    response.version === stored?.lastAnalysis?.version;
  const samePanel =
    !!response &&
    snapshot.sessionId === panel?.sessionId &&
    response.requestId === panel?.requestId &&
    response.version === panel?.version;
  const memoCharacters = snapshot.summary?.length ?? 0;
  const newerFailure =
    !!response && !!snapshot.lastFailure && snapshot.lastFailure.at >= response.at;
  let finding = 'not_enough_correlated_data';
  if (response && sameStored && samePanel) {
    if (
      response.summaryCharacters === 0 &&
      memoCharacters === 0 &&
      stored?.summary.length === 0 &&
      panel?.domCharacters === 0
    )
      finding = 'confirmed_empty_summary';
    else if (response.summaryCharacters > 0 && memoCharacters === 0)
      finding = 'response_not_committed';
    else if (memoCharacters > 0 && stored?.summary.length === 0) finding = 'memo_not_saved';
    else if (memoCharacters > 0 && panel?.domCharacters === 0) finding = 'memo_not_rendered';
    else if (memoCharacters > 0 && (panel?.domCharacters ?? 0) > 0)
      finding = response.summaryCharacters === 0 ? 'empty_update_preserved_memo' : 'memo_rendered';
  }
  if (snapshot.analysisError || newerFailure)
    finding = response
      ? 'validated_result_followed_by_failure'
      : 'failed_request_no_validated_response';
  return {
    scope: 'latest_validated_response',
    finding,
    response: response
      ? {
          requestId: response.requestId,
          provider: response.provider ?? 'unknown',
          model: response.model ?? 'unknown',
          version: response.version,
          summaryCharacters: response.summaryCharacters,
          outcome: response.outcome,
        }
      : null,
    currentMemoCharacters: memoCharacters,
    savedMemo: {
      correlated: sameStored,
      characters: stored ? (stored.summary?.length ?? 0) : null,
    },
    panel: panel
      ? {
          correlated: samePanel,
          memoCharacters: panel.memoCharacters,
          domCharacters: panel.domCharacters,
          view: panel.view,
          emptyOutcomeMessage: panel.emptyOutcomeMessage,
        }
      : null,
  };
}
/** Explicit export of selected metadata; never serialize the original snapshot. */
export function supportReport(
  snapshot: AssistantSnapshot,
  version: string,
  stored?: AssistantSnapshot,
  panel?: MemoPresentation,
) {
  const failure = snapshot.lastFailure;
  const finite = (value: number | undefined) => (Number.isFinite(value) ? value : undefined);
  return {
    format: 'listen-support-v1',
    exportedAt: new Date().toISOString(),
    version,
    loadedBuild: BUILD_ID,
    notesVerification: memoVerification(snapshot, stored, panel),
    assistant: {
      phase: snapshot.phase,
      provider: snapshot.provider ?? 'hpop',
      model: CANDIDATES.includes(snapshot.model) ? snapshot.model : 'unknown',
      version: finite(snapshot.version),
      memoCharacters: snapshot.summary?.length ?? 0,
      incomplete: snapshot.incomplete,
      contextGap: snapshot.contextGap,
      lastFailure: failure
        ? {
            at: finite(failure.at),
            build: failure.buildId ?? 'unavailable (older build)',
            status: finite(failure.status),
            category: ['format', 'request', 'network', 'timeout'].includes(failure.category)
              ? failure.category
              : 'unknown',
            reason: FAILURE_REASONS.includes(failure.reason) ? failure.reason : 'unknown',
            count: finite(failure.count),
            validationIssues: safeValidationIssues(failure.validationIssues),
          }
        : null,
    },
  };
}
