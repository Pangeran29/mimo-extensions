// Complete living memos need more time than the former short incremental notes.
// One request remains in flight; newer transcript passages are coalesced behind it.
export const ANALYSIS_TIMEOUT_MS = 30_000;
export const DEEPER_TIMEOUT_MS = 30_000;
// Experimental live-stage budgets: shared by controller, worker and provider transport.
export const LIVE_PROPOSAL_TIMEOUT_MS = 20_000;
export const LIVE_REVIEW_TIMEOUT_MS = 10_000;
// Actual v2 reports showed valid review streams cut off at ten seconds.
// Give only v2's three-component review a bounded five-second extension.
export const LIVE_V2_REVIEW_TIMEOUT_MS = 15_000;
export function assistantRequestTimeout(type: string, liveV2 = false): number {
  if (type === 'PROPOSE') return LIVE_PROPOSAL_TIMEOUT_MS;
  if (type === 'REVIEW') return liveV2 ? LIVE_V2_REVIEW_TIMEOUT_MS : LIVE_REVIEW_TIMEOUT_MS;
  return type === 'DEEPER' ? DEEPER_TIMEOUT_MS : ANALYSIS_TIMEOUT_MS;
}
export const WORKER_REPLY_GRACE_MS = 250;
export const FINAL_ANALYSIS_TIMEOUT_MS = ANALYSIS_TIMEOUT_MS;
