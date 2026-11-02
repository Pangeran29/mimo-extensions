const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' ? (value as Record<string, any>) : {};
export type ReplayStage = 'audio' | 'transcript' | 'ai' | 'display' | 'error';
export function replayEventDescriptor(
  kind: string,
  data: unknown,
): {
  stage: ReplayStage;
  title: string;
  description?: string;
} {
  const value = object(data);
  const name = kind === 'pipeline-diagnostic' && typeof value.name === 'string' ? value.name : kind;
  const failureReason = ['source-error', 'drain-timeout', 'interrupted'].includes(value.reason);
  const failed =
    /(?:^|[._-])(?:error|failed|failure|timeout|interrupted)(?:$|[._-])/i.test(name) ||
    !!value.analysisError ||
    (typeof value.error === 'string' && !!value.error) ||
    ['error', 'failed'].includes(value.phase) ||
    failureReason ||
    (kind === 'pipeline-diagnostic' && typeof value.status === 'number' && value.status >= 400);
  let stage: ReplayStage;
  if (failed) stage = 'error';
  else if (/^ui[.:_-]|presentation|bubble|reaction|display|feedback/.test(name)) stage = 'display';
  else if (/transcript|vad|window|asr/i.test(name)) stage = 'transcript';
  else if (/^(?:source|run|stop)[._-]/.test(name)) stage = 'audio';
  else if (/request|response|input|decision|proposal|review|memo|assistant|saved|llm/i.test(name))
    stage = 'ai';
  else stage = 'audio';
  const titles: Record<string, string> = {
    input: 'Context supplied to AI',
    request: 'Request sent to AI',
    response: 'AI response received',
    decision: 'Validation and publication decision',
    'saved-memo': 'Accepted state saved',
    'ui.state_received': 'State received by Memo',
    'ui.dom_applied': 'Memo DOM updated',
    'ui.visibility_estimate': 'Display visibility estimate',
    'asr.error': 'ASR request failed',
    'source-ended': 'Recording reached its end',
    'run-started': 'Replay started',
    'run-finished': failed ? 'Replay ended with an error' : 'Replay finished',
    'stop-requested': failureReason ? 'Replay stopped after a failure' : 'Replay stop requested',
  };
  let description = describeReplayEvent(kind, data);
  if (failureReason)
    description =
      value.reason === 'source-error'
        ? 'Chrome could not play the selected recording. Inspect the run error, then choose a supported audio file.'
        : value.reason === 'drain-timeout'
          ? 'The EOF processing deadline was reached. Live publication stopped; queued transcription may still be recovering.'
          : 'The research session was interrupted. It will not autoplay; start a fresh run when recovery has settled.';
  else if (kind === 'transcript-state' && failed)
    description =
      typeof value.message === 'string'
        ? value.message
        : 'Transcription failed. Inspect its complete evidence.';
  else if (kind === 'pipeline-diagnostic')
    description = failed
      ? `The ${/asr/i.test(name) ? 'ASR' : /vad/i.test(name) ? 'speech detection' : /memo|llm|assistant/i.test(name) ? 'AI' : 'pipeline'} stage reported a failure${typeof value.status === 'number' ? ` (HTTP ${value.status})` : ''}. Inspect the failure category and timing in the complete evidence.`
      : undefined;
  return {
    stage,
    title: titles[name] ?? name.replace(/^ui[.:_-]/, '').replace(/[._-]+/g, ' '),
    description,
  };
}
/** A short reading aid. Complete evidence remains available separately. */
export function describeReplayEvent(kind: string, data: unknown): string | undefined {
  const value = object(data);
  if (kind === 'transcript-state') {
    const segments = Array.isArray(value.segments) ? value.segments : [];
    const last = segments.at(-1);
    return last ? `Latest transcript [${last.id}]: ${last.text}` : 'No transcript has arrived yet.';
  }
  if (kind === 'assistant-state') {
    const state = object(value.liveV2);
    if (value.analysisError) return String(value.analysisError);
    if (state.stage)
      return state.stage === 'review'
        ? 'Checking a proposed update. The accepted memo stays visible.'
        : 'Understanding the latest conversation.';
    if (state.memo?.text) return `Accepted understanding: ${state.memo.text}`;
    return state.decision === 'wait'
      ? 'Waiting for enough context. No text was invented.'
      : 'No new accepted understanding in this state.';
  }
  if (kind === 'ui.dom_applied')
    return typeof value.memoText === 'string' ? value.memoText : undefined;
  if (kind === 'request') {
    const name = value.response_format?.json_schema?.name ?? value.tools?.[0]?.name;
    return /review/.test(String(name))
      ? 'Reviewer input: candidate, supporting transcript, current memo, and contribution history.'
      : 'Understanding input: newly arrived transcript and relevant previous context.';
  }
  if (kind === 'response' && typeof value.text === 'string') {
    try {
      const response = JSON.parse(value.text);
      if (response.memo && 'accept' in response.memo)
        return `Reviewer: understanding ${response.memo.accept ? 'accepted' : 'rejected'}; contribution ${response.contribution?.accept ? 'accepted' : 'rejected'}. ${response.memo.reason ?? ''}`;
      const memo = response.memoUpdate?.action;
      return `Proposal: ${memo === 'replace' ? 'update' : 'keep'} understanding; ${response.decision === 'candidate' ? 'suggest an additional contribution' : response.decision === 'wait' ? 'wait for context' : 'no additional contribution'}. ${response.reason ?? ''}`;
    } catch {
      return 'Response could not be read as JSON. Inspect the complete evidence.';
    }
  }
  return undefined;
}
