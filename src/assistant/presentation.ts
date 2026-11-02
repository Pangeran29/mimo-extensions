import type { Status } from '../types';
import type { TranscriptSnapshot } from '../transcription/types';
import type { AssistantSnapshot } from './types';

export interface Presence {
  key: string;
  label: string;
  detail: string;
  tone: 'quiet' | 'active' | 'success' | 'warning';
  working?: boolean;
  seconds?: number;
  recovery?: 'retry' | 'settings';
}
export function showLiveAssistant(recording: Status, finishingMeeting = false): boolean {
  if (recording.phase === 'starting') return false;
  return (
    ['recording', 'stopping', 'saving'].includes(recording.phase) ||
    (finishingMeeting && (!!recording.transcriptionBusy || !!recording.assistantBusy))
  );
}
export function assistantPresence(
  recording: Status,
  ai?: AssistantSnapshot,
  transcript?: TranscriptSnapshot,
  now = Date.now(),
): Presence {
  const state = (
    key: string,
    label: string,
    detail: string,
    tone: Presence['tone'] = 'quiet',
  ): Presence => ({ key, label, detail, tone });
  if (recording.phase === 'save-failed')
    return state(
      'save-failed',
      'Your audio needs saving.',
      'Your recording is retained. Use Retry save below.',
      'warning',
    );
  if (recording.phase === 'error')
    return state(
      'recording-error',
      'The recording stopped.',
      recording.error || 'Check Settings before starting again.',
      'warning',
    );
  if (recording.phase === 'starting')
    return {
      ...state('starting', 'Getting ready…', 'Opening your microphone and tab audio.', 'active'),
      working: true,
    };
  if (
    (ai?.liveV2 || ai?.live) &&
    !['paused', 'error', 'disabled'].includes(ai.phase) &&
    !['failed', 'recovering', 'finishing'].includes(transcript?.phase ?? '')
  ) {
    if ((ai.liveV2 || ai.live)!.closed)
      return state(
        'live-closed',
        'Session saved.',
        'Your audio and queued transcription can finish saving.',
      );
    if ((ai.liveV2 || ai.live)!.stage)
      return {
        ...state(
          'live-working',
          (ai.liveV2 || ai.live)!.stage === 'review'
            ? ai.liveV2
              ? 'Checking understanding…'
              : 'Checking a contribution…'
            : 'Thinking it through…',
          'Listening to the current conversation.',
          'active',
        ),
        working: true,
      };
    if (ai.analysisError && ai.retryAt !== undefined) {
      const seconds = Math.max(0, Math.ceil((ai.retryAt - now) / 1000));
      return {
        ...state(
          'live-retrying',
          'Reconnecting to AI…',
          seconds
            ? `${ai.analysisError} Retrying automatically in ${seconds}s.`
            : `${ai.analysisError} Waiting for the automatic retry.`,
          'warning',
        ),
        seconds,
      };
    }
    if (ai.analysisError)
      return {
        ...state('live-error', 'Live memo needs attention.', ai.analysisError, 'warning'),
        recovery: 'retry',
      };
    return state(
      'live-listening',
      (ai.liveV2 || ai.live)!.decision === 'wait' && !ai.liveV2?.memo
        ? 'Listening for context…'
        : 'Listening…',
      'I’ll contribute when there’s something useful to add.',
    );
  }
  if (ai?.phase === 'paused' || ai?.phase === 'error')
    return {
      ...state(
        'paused',
        'I couldn’t update that.',
        ai.analysisError || ai.message || 'Your previous summaries are still here.',
        'warning',
      ),
      recovery: 'retry',
    };
  if (transcript?.phase === 'recovering')
    return state(
      'transcription-recovering',
      'Transcription will retry.',
      transcript.message || 'Queued speech will recover automatically. Your audio is retained.',
      'warning',
    );
  if (transcript?.phase === 'failed' && recording.phase === 'recording')
    return {
      ...state(
        'transcription-failed',
        'I can’t hear new speech.',
        'Transcription stopped. Audio is still recording.',
        'warning',
      ),
      recovery: 'settings',
    };
  if (ai?.phase === 'disabled')
    return {
      ...state(
        'disabled',
        'Let’s get connected.',
        'Add your AI connection in Settings to start.',
        'warning',
      ),
      recovery: 'settings',
    };
  if (ai?.analyzingSince || ai?.phase === 'thinking') {
    const seconds = ai.analyzingSince
      ? Math.max(0, Math.floor((now - ai.analyzingSince) / 1000))
      : undefined;
    return {
      ...state(
        'thinking',
        'Thinking it through…',
        seconds !== undefined && seconds >= 8
          ? 'Still working. This is taking longer than usual.'
          : ai.summaries?.length || ai.summary
            ? 'Your last summary stays right here.'
            : 'Making sense of the conversation so far.',
        'active',
      ),
      seconds,
      working: true,
    };
  }
  if (
    ['stopping', 'saving'].includes(recording.phase) ||
    ai?.phase === 'finishing' ||
    transcript?.phase === 'finishing'
  )
    return {
      ...state(
        'finishing',
        'Wrapping things up…',
        recording.phase === 'saving'
          ? 'Saving your audio. Your summaries stay here.'
          : 'Finishing the last speech and summary.',
        'active',
      ),
      working: true,
    };
  if (ai?.analysisError && ai.retryAt) {
    const seconds = Math.max(0, Math.ceil((ai.retryAt - now) / 1000));
    const issue = ai.lastFailure?.validationIssues?.[0];
    const explanation =
      issue?.field === 'summary' && issue.code === 'too_big'
        ? `Notes exceeded ${issue.limit ?? 2400} characters${issue.size ? ` (received ${issue.size})` : ''}. `
        : issue
          ? `Validation failed: ${issue.field} (${issue.code}). `
          : '';
    return state(
      'retrying',
      'I’ll try that again.',
      seconds
        ? `${explanation}Retrying in ${seconds}s. Your last summary is safe.`
        : `${explanation}Waiting to retry your summary.`,
      'warning',
    );
  }
  if (recording.phase !== 'recording') {
    if (ai?.sessionId || transcript?.sessionId)
      return state(
        'complete',
        'Your meeting is here.',
        'Review your summaries or open the transcript.',
        'success',
      );
    return state(
      'idle',
      'Ready when you are.',
      'Open a website, then start Listen from the extension popup.',
    );
  }
  if (transcript?.activity === 'recognizing')
    return {
      ...state(
        'catching',
        'Catching that…',
        transcript.lagMs > 10000
          ? 'Speech is taking a little longer. Audio is still recording.'
          : 'Turning your latest speech into text.',
        'active',
      ),
      working: true,
    };
  if (transcript?.activity === 'speech')
    return {
      ...state('speech', 'I hear you.', 'Keep going. I’m following the conversation.', 'active'),
      working: true,
    };
  if (transcript?.segments.some((segment) => segment.id > (ai?.lastSegmentId ?? -1)))
    return state(
      'queued',
      'I’m on it.',
      'Your latest speech is ready for the next update.',
      'active',
    );
  if (ai?.updatedAt && now - ai.updatedAt < 4500) {
    if (ai.lastAnalysis?.outcome === 'empty')
      return state(
        'no-new-notes',
        'No new notes from this passage.',
        ai.summary
          ? 'The AI returned no new notes. Your existing memo is unchanged.'
          : 'The AI checked the latest passage and returned no notes. You can review the transcript.',
      );
    const latest = ai.summaries?.at(-1);
    if (latest && latest.createdAt === ai.updatedAt)
      return state('updated', 'Here’s the latest.', 'A new takeaway is ready below.', 'success');
    return state('unchanged', 'Still with you.', 'No new takeaways yet.');
  }
  if (ai?.summary)
    return state('quiet', 'Still with you.', 'I’ll update this when something changes.');
  return state('wait', 'Wait…', 'I’m ready when you speak.');
}

/** Highlight changed sentences in a complete validated response, never simulated streaming. */
export function summaryChanges(
  previous: string,
  next: string,
): Array<{ text: string; added: boolean }> {
  const words = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(next),
    (item) => item.segment,
  );
  if (!previous) return [{ text: next, added: false }];
  const old = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(previous),
    (item) => item.segment,
  );
  const equal = (a: string, b: string) => a.trim() === b.trim();
  const lcs = Array.from({ length: old.length + 1 }, () => new Uint16Array(words.length + 1));
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = words.length - 1; j >= 0; j--)
      lcs[i][j] = equal(old[i], words[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const unchanged = new Set<number>();
  let i = 0,
    j = 0;
  while (i < old.length && j < words.length) {
    if (equal(old[i], words[j])) {
      unchanged.add(j);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const parts: Array<{ text: string; added: boolean }> = [];
  words.forEach((text, index) => {
    const added = !unchanged.has(index),
      last = parts.at(-1);
    if (last?.added === added) last.text += text;
    else parts.push({ text, added });
  });
  return parts;
}
