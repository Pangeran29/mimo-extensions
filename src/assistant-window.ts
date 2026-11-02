import { renderV2 } from './assistant/v2/view';
import { renderLiveMemo } from './assistant/live-view';
import { trace, diagnosticsReady } from './diagnostics';
void diagnosticsReady;
import { panelViewKey, type PanelView } from './panel';
import { assistantSurface, surfaceAtTime, surfaceKey, type AssistantSurface } from './appearance';
import { assistantPresence, showLiveAssistant } from './assistant/presentation';
import { memoCharacter } from './assistant/memo-character';
import { MimoMascot } from './mimo/mascot';
import type { MimoNavigationOptions } from './mimo/presentation';
import type { AssistantAction, AssistantSnapshot } from './assistant/types';
import { meetingMemo, memoBlocks } from './assistant/summaries';
import type { TranscriptSnapshot } from './transcription/types';
import type { Reply, Status } from './types';
import { REPLAY_LAB } from './replay/config';
import {
  presentationEvent,
  setPresentationContext,
  v2PresentationFields,
  V2PresentationTracker,
} from './replay/presentation';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let snapshot: AssistantSnapshot | undefined;
let transcript: TranscriptSnapshot | undefined;
let recording: Status = { phase: 'idle', retained: [] };
let activeSession: string | undefined;
type Detail = 'summary' | 'transcript' | 'insights';
let detail: Detail = 'summary';
let reviewingSaved = false;
let sourceReturnDetail: 'summary' | 'insights' = 'summary';
let sourceNavigation = false;
let historyFromSettings = false;
let historyReturnDetail: Detail = 'summary';
let settingsFocusEpoch = 0;
let panelView: PanelView = 'assistant';
let navigationKey: string | undefined;
let followSummary = true;
let followTranscript = true;
let feedbackBusy = false;
let stopBusy = false;
let startBusy = false;
let recordingLoaded = false;
let activeTab: chrome.tabs.Tab | undefined;
let browserWindowId: number | undefined;
let surfacePreference: AssistantSurface = 'Automatic';
let showingLive = false;
let saveBusy = false;
let resumeBusy = false;
let deepBusy = false;
let liveAI = false;
let liveTranscript = false;
let liveRecording = false;
let uiError = '';
let renderedSession: string | undefined;
let returnFocus: HTMLElement | undefined;
const rows = new Map<number, HTMLElement>();
const memoRows = new Map<string, { element: HTMLElement; signature: string }>();
let renderedMemo = '';
let lastOutcomeRequest: string | undefined;
const analysisPanel = $('analysis-panel');
const transcriptPanel = $('transcript-panel');
const replayView = REPLAY_LAB && new URLSearchParams(location.search).get('replay') === '1';
const presentationTracker = new V2PresentationTracker();
const idleMascot = new MimoMascot($('idle-mimo-greeting'), { interactive: true, size: 180 });
$('idle-mimo-greeting').onclick = () => {
  $('idle-mimo-message').textContent = 'Hi. I’m right here when you’re ready.';
};
$<HTMLIFrameElement>('settings-frame').addEventListener('load', syncEmbeddedCompanion);
memoCharacter.setReturnHandler(() => {
  if (panelView === 'assistant' && detail === 'transcript' && sourceNavigation)
    $('transcript-back').click();
  else {
    if (panelView === 'settings') openSettings();
    selectDetail('summary');
  }
});

function updateNavigation(): void {
  for (const [id, view] of [
    ['open-live', 'summary'],
    ['open-transcript', 'transcript'],
    ['open-insights', 'insights'],
  ] as const)
    $(id).setAttribute('aria-pressed', String(panelView === 'assistant' && detail === view));
  $('settings').setAttribute('aria-pressed', String(panelView === 'settings'));
  $('settings').querySelector('.settings-label')!.textContent = 'Settings';
}

async function send<T>(
  action:
    | AssistantAction
    | { type: 'STATUS' | 'STOP' | 'TRANSCRIPT_STATUS' }
    | { type: 'RETRY'; id: string }
    | { type: 'START'; tabId: number; title: string },
): Promise<T> {
  const r: Reply<T> = await chrome.runtime.sendMessage({ target: 'worker', ...action });
  if (!r?.ok) throw new Error(r?.error ?? 'Assistant unavailable.');
  return r.value;
}
function error(e: unknown): void {
  uiError = e instanceof Error ? e.message : 'Assistant unavailable.';
  $('ai-error').textContent = uiError;
  $('ai-alert').hidden = false;
}
function announce(text: string): void {
  $('announcement').textContent = text;
}
function time(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function selectDetail(
  next: typeof detail,
  focus = true,
  options: MimoNavigationOptions = {},
): void {
  const previousDetail = detail;
  if (!options.source && !options.backFromSource) sourceNavigation = false;
  memoCharacter.navigation(next, options);
  detail = next;
  document.body.dataset.detail = detail;
  for (const name of ['analysis', 'transcript', 'insights'])
    $(name + '-view').hidden = (name === 'analysis' ? 'summary' : name) !== detail;
  $('view-title').textContent =
    next === 'summary' ? 'Live memo' : next === 'transcript' ? 'Transcript' : 'Session history';
  $('view-heading').hidden = next === 'summary';
  if (focus) focusDetail();
  if (next === 'summary' && followSummary) requestAnimationFrame(jumpSummary);
  if (next === 'transcript' && followTranscript)
    requestAnimationFrame(() => {
      transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
    });
  updateNavigation();
  $('transcript-back').hidden = next !== 'transcript' || !sourceNavigation;
  syncCompanion();
  if (previousDetail !== next) presentationEvent('ui.view_changed', { view: next });
}
$('open-live').onclick = () => {
  if (panelView === 'settings') openSettings();
  selectDetail('summary');
};
$('leave-saved').onclick = () => {
  reviewingSaved = false;
  historyFromSettings = false;
  selectDetail('summary', false);
  updateSessionView();
  $('start').focus({ preventScroll: true });
};
function focusDetail(): void {
  $(
    detail === 'summary'
      ? memoCharacter.mode === 'contribution'
        ? 'contribution-view'
        : 'analysis-panel'
      : 'view-title',
  ).focus({ preventScroll: true });
}
function backToSummary(fromSource = false): void {
  selectDetail('summary', false, { backFromSource: fromSource });
  sourceNavigation = false;
  if (returnFocus?.isConnected && returnFocus.getClientRects().length)
    returnFocus.focus({ preventScroll: true });
  else focusDetail();
}
$('open-transcript').onclick = () => {
  if (panelView === 'settings') openSettings();
  sourceReturnDetail = reviewingSaved ? 'insights' : 'summary';
  $('transcript-back-label').textContent = reviewingSaved ? 'Back to history' : 'Back to live memo';
  returnFocus = $('open-transcript');
  selectDetail('transcript');
};
$('transcript-back').onclick = () => {
  if (sourceReturnDetail === 'insights') {
    selectDetail('insights', false, { backFromSource: sourceNavigation });
    sourceNavigation = false;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length)
      returnFocus.focus({ preventScroll: true });
  } else backToSummary(sourceNavigation);
};
$('insights-back').onclick = () => {
  if (historyFromSettings) {
    historyFromSettings = false;
    reviewingSaved = false;
    selectDetail(historyReturnDetail, false);
    if (panelView !== 'settings') openSettings(true, false);
    $<HTMLIFrameElement>('settings-frame').contentWindow?.postMessage(
      { type: 'LISTEN_SETTINGS_FOCUS', target: 'history' },
      location.origin,
    );
    return;
  }
  if (reviewingSaved) {
    reviewingSaved = false;
    updateSessionView();
    $('open-insights').focus({ preventScroll: true });
  } else backToSummary();
};
$('open-insights').onclick = () => {
  historyFromSettings = panelView === 'settings';
  historyReturnDetail = detail;
  $('history-back-label').textContent = historyFromSettings ? 'Settings' : 'Live memo';
  if (panelView === 'settings') openSettings();
  if (!showingLive) {
    reviewingSaved = true;
    updateSessionView();
  }
  returnFocus = $('open-insights');
  selectDetail('insights');
};
$('clear-error').onclick = () => {
  uiError = '';
  $('ai-alert').hidden = true;
};

function jumpSummary(): void {
  if (detail !== 'summary' || panelView !== 'assistant') return;
  analysisPanel.scrollTop = 0;
  followSummary = true;
}
analysisPanel.addEventListener('scroll', () => {
  if (detail !== 'summary' || panelView !== 'assistant') return;
  followSummary = analysisPanel.scrollTop < 24;
});
transcriptPanel.addEventListener('scroll', () => {
  if (detail !== 'transcript' || panelView !== 'assistant') return;
  followTranscript =
    transcriptPanel.scrollHeight - transcriptPanel.scrollTop - transcriptPanel.clientHeight < 40;
  $('jump-latest').hidden = followTranscript || !rows.size;
});
$('jump-latest').onclick = () => {
  followTranscript = true;
  transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  $('jump-latest').hidden = true;
};

function renderSummaries(s: AssistantSnapshot, notify = false): void {
  if (s.liveV2) {
    renderV2(
      s,
      async (id, feedback) => {
        render(
          await send<AssistantSnapshot>({
            type: 'ASSISTANT_FEEDBACK',
            sessionId: s.sessionId!,
            issueKey: id,
            feedback,
          }),
        );
      },
      showEvidence,
      notify,
    );
    $('open-insights').hidden = !s.sessionId;
    updateEvidence();
    return;
  }
  if (s.live) {
    renderLiveMemo(
      s,
      async (id, feedback) => {
        render(
          await send<AssistantSnapshot>({
            type: 'ASSISTANT_FEEDBACK',
            sessionId: s.sessionId!,
            issueKey: id,
            feedback,
          }),
        );
      },
      showEvidence,
    );
    $('open-insights').hidden = !s.sessionId;
    updateEvidence();
    return;
  }
  $('live-history').hidden = true;
  const newSession = renderedSession !== s.sessionId;
  if (newSession) {
    memoRows.clear();
    renderedMemo = '';
    $('summary-feed').replaceChildren();
    analysisPanel.scrollTop = 0;
    followSummary = true;
    renderedSession = s.sessionId;
    lastOutcomeRequest = undefined;
  }
  const memo = meetingMemo(s);
  if (memo !== renderedMemo) {
    const top = analysisPanel.getBoundingClientRect().top;
    const anchor = [...memoRows.entries()].find(
      ([, row]) => row.element.getBoundingClientRect().bottom > top,
    );
    const offset = anchor ? anchor[1].element.getBoundingClientRect().top - top : 0;
    const scroll = analysisPanel.scrollTop;
    const next = new Map<string, { element: HTMLElement; signature: string }>();
    const nodes = memoBlocks(memo).map((block) => {
      const signature = JSON.stringify(block);
      const old = memoRows.get(block.key);
      if (old?.signature === signature) {
        next.set(block.key, old);
        return old.element;
      }
      const element = document.createElement(
        block.type === 'title'
          ? 'h1'
          : block.type === 'heading'
            ? 'h2'
            : block.type === 'list'
              ? 'ul'
              : 'p',
      );
      element.dataset.memoBlock = block.key;
      if (block.type === 'list')
        for (const line of block.lines) {
          const li = document.createElement('li');
          li.textContent = line;
          element.append(li);
        }
      else element.textContent = block.lines.join(' ');
      next.set(block.key, { element, signature });
      return element;
    });
    $('summary-feed').replaceChildren(...nodes);
    memoRows.clear();
    for (const [key, row] of next) memoRows.set(key, row);
    const retained = anchor && next.get(anchor[0]);
    analysisPanel.scrollTop = scroll;
    if (scroll > 0 && retained)
      analysisPanel.scrollTop += retained.element.getBoundingClientRect().top - top - offset;
    renderedMemo = memo;
    if (memo) {
      trace('memo.dom_updated', { sessionId: s.sessionId, version: s.version });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (
            document.visibilityState === 'visible' &&
            panelView === 'assistant' &&
            detail === 'summary' &&
            renderedSession === s.sessionId &&
            renderedMemo === memo &&
            $('summary-feed').getClientRects().length
          )
            trace('memo.presentation_estimate', { sessionId: s.sessionId, version: s.version });
        }),
      );
    }
  }
  $('summary-empty').hidden = !!memo;
  const checkedEmpty = s.lastAnalysis?.outcome === 'empty' && !memo;
  $('summary-empty').querySelector('h2')!.textContent = checkedEmpty
    ? 'No notes yet.'
    : 'Your notes start here.';
  $('summary-empty').querySelector('p')!.textContent = checkedEmpty
    ? 'The last completed AI check returned no notes. You can review the transcript.'
    : 'Keep talking. I’ll build the memo as you go.';
  if (s.lastAnalysis && lastOutcomeRequest !== s.lastAnalysis.requestId) {
    lastOutcomeRequest = s.lastAnalysis.requestId;
    trace('memo.outcome_rendered', {
      sessionId: s.sessionId,
      requestId: s.lastAnalysis.requestId,
      version: s.lastAnalysis.version,
      count: $('summary-feed').textContent?.trim().length ?? 0,
      empty: s.lastAnalysis.outcome === 'empty',
    });
  }
  $('open-insights').hidden = !s.sessionId || !memo;
  $('follow-up').hidden = !s.question;
  $('question').textContent = s.question?.text ?? '';
  $('reason').textContent = s.question?.reason ?? '';
  $('useful').textContent = s.question?.feedback === 'useful' ? 'Marked useful' : 'Useful';
  $<HTMLButtonElement>('useful').disabled =
    !s.question || s.question.feedback === 'useful' || feedbackBusy;
  $<HTMLButtonElement>('dismiss').disabled = !s.question || feedbackBusy;
  updateEvidence();
}
function render(s: AssistantSnapshot, notify = false): void {
  if (activeSession && s.sessionId && s.sessionId !== activeSession) return;
  if (snapshot && snapshot.sessionId === s.sessionId && snapshot.version > s.version) return;
  if (s.liveV2) {
    setPresentationContext(s);
    if (presentationTracker.received(s))
      presentationEvent('ui.state_received', {
        origin: notify ? 'live' : 'initial_or_restored',
        phase: s.phase,
        stage: s.liveV2.stage ?? null,
        decision: s.liveV2.decision,
        closed: s.liveV2.closed,
      });
  }
  snapshot = s;
  renderSummaries(s, notify);
  $<HTMLButtonElement>('deeper').disabled =
    !s.sessionId ||
    s.deeperBusy ||
    deepBusy ||
    ['disabled', 'finishing', 'complete', 'paused'].includes(s.phase);
  $('deeper').textContent = s.deeperBusy || deepBusy ? 'Analyzing…' : 'Analyze deeper';
  $('deep-section').hidden = !s.deeper && !s.deeperBusy && !s.deeperError;
  $('deep-result').textContent =
    s.deeperError ?? s.deeper ?? 'Taking a closer look at the meeting…';
  $('context-warning').hidden = !s.incomplete && !s.contextGap;
  if (s.message.includes('could not be saved locally')) {
    $('context-warning').hidden = false;
    $('context-warning').textContent = s.message;
  } else
    $('context-warning').textContent =
      'Some speech may be missing. Check important details against the recording.';
  updatePresence();
  if (s.liveV2) {
    const changes = presentationTracker.apply(s);
    if (changes) {
      const revision = presentationTracker.revision;
      presentationEvent('ui.dom_applied', {
        ...changes,
        origin: notify ? 'live' : 'initial_or_restored',
        newOutput:
          notify &&
          !changes.initial &&
          !s.liveV2.closed &&
          ((changes.memoChanged && !!s.liveV2.memo) ||
            (changes.contributionChanged && !!s.liveV2.activeId)),
        memoText: s.liveV2.memo?.text ?? null,
        domMemoText: $('summary-feed').querySelector('.live-body')?.textContent ?? null,
        presentationMode: memoCharacter.mode,
        displayedContributionId: memoCharacter.displayedId ?? null,
        pendingContributionId: memoCharacter.pendingId ?? null,
        narrativeVisible: !!$('summary-feed').getClientRects().length,
        contributionVisible: !!$('contribution-view').getClientRects().length,
        view: panelView === 'settings' ? 'settings' : detail,
      });
      if (changes.memoChanged && s.liveV2.memo)
        trace('memo.dom_updated', { sessionId: s.sessionId, version: s.version });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (revision !== presentationTracker.revision || snapshot?.sessionId !== s.sessionId)
            return;
          const surfaceVisible =
            document.visibilityState === 'visible' &&
            panelView !== 'settings' &&
            detail === 'summary';
          const narrativeVisibleEstimate =
            surfaceVisible && !!$('summary-feed').getClientRects().length;
          const contributionVisibleEstimate =
            surfaceVisible && !!$('contribution-view').getClientRects().length;
          const visibleEstimate = narrativeVisibleEstimate || contributionVisibleEstimate;
          presentationEvent('ui.visibility_estimate', {
            ...v2PresentationFields(s),
            visibleEstimate,
            bubbleVisibleEstimate: contributionVisibleEstimate,
            narrativeVisibleEstimate,
            contributionVisibleEstimate,
            presentationMode: memoCharacter.mode,
            displayedContributionId: memoCharacter.displayedId ?? null,
            pendingContributionId: memoCharacter.pendingId ?? null,
            view: panelView === 'settings' ? 'settings' : detail,
            focusedElement: (document.activeElement as HTMLElement | null)?.id ?? '',
            scrollTop: analysisPanel.scrollTop,
            limitation:
              'DOM and next-frame visibility estimate; not proof of visible browser paint.',
          });
          if (visibleEstimate && s.liveV2?.memo)
            trace('memo.presentation_estimate', { sessionId: s.sessionId, version: s.version });
        }),
      );
    }
  }
}
function updateEvidence(): void {
  $('evidence').hidden =
    !snapshot?.question ||
    snapshot.sessionId !== transcript?.sessionId ||
    !snapshot.question.evidenceSegmentIds.some((id) => rows.has(id));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-evidence-ids]'))
    button.hidden =
      (button.dataset.statusSource !== undefined &&
        button.closest<HTMLElement>('[data-status]')?.dataset.status === 'relevant') ||
      snapshot?.sessionId !== transcript?.sessionId ||
      !button.dataset.evidenceIds
        ?.split(',')
        .filter((id) => id.trim() !== '')
        .some((id) => rows.has(Number(id)));
}
function showEvidence(ids: number[], trigger: HTMLElement): void {
  sourceReturnDetail = detail === 'insights' ? 'insights' : 'summary';
  const matches = ids.filter((id) => rows.has(id));
  if (!matches.length) return;
  sourceNavigation = true;
  $('transcript-back-label').textContent =
    sourceReturnDetail === 'insights'
      ? 'Back to history'
      : memoCharacter.mode === 'contribution'
        ? 'Back to Mimo’s thought'
        : 'Back to live memo';
  presentationEvent('ui.sources_opened', { sourceIds: matches, fromView: detail });
  returnFocus = trigger;
  followTranscript = false;
  for (const [id, row] of rows) row.dataset.evidence = String(matches.includes(id));
  selectDetail('transcript', true, { source: true });
  requestAnimationFrame(() => {
    const row = rows.get(matches[0])!;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'start' });
    $('jump-latest').hidden = false;
  });
}
$('evidence').onclick = () =>
  showEvidence(snapshot?.question?.evidenceSegmentIds ?? [], $('evidence'));
function clearTranscript(): void {
  rows.clear();
  $('transcript-feed').replaceChildren();
  followTranscript = true;
}
function renderTranscript(s: TranscriptSnapshot, notify = false): void {
  if (activeSession && s.sessionId && s.sessionId !== activeSession) return;
  const previousCount =
    s.sessionId === transcript?.sessionId ? (transcript?.segments.length ?? 0) : 0;
  if (s.sessionId !== transcript?.sessionId) clearTranscript();
  transcript = s;
  const ids = new Set(s.segments.map((segment) => segment.id));
  for (const [id, row] of rows)
    if (!ids.has(id)) {
      row.remove();
      rows.delete(id);
    }
  for (const segment of s.segments) {
    let row = rows.get(segment.id);
    if (!row) {
      row = document.createElement('article');
      row.className = 'transcript-segment';
      row.tabIndex = -1;
      row.append(document.createElement('time'), document.createElement('p'));
      rows.set(segment.id, row);
      $('transcript-feed').append(row);
    }
    row.querySelector('time')!.textContent = time(segment.startMs);
    row.querySelector('time')!.dateTime = `PT${Math.floor(segment.startMs / 1000)}S`;
    if (row.querySelector('p')!.textContent !== segment.text)
      row.querySelector('p')!.textContent = segment.text;
  }
  $('transcript-empty').hidden = !!s.segments.length;
  $('transcript-empty').textContent =
    s.phase === 'loading'
      ? 'Preparing transcription…'
      : s.phase === 'complete'
        ? 'No speech was transcribed.'
        : 'Your transcript will appear here.';
  $('transcript-warning').hidden =
    s.phase !== 'failed' && s.phase !== 'recovering' && !s.incomplete && s.lagMs <= 10000;
  $('transcript-warning').textContent =
    s.phase === 'recovering'
      ? (s.message ?? 'Queued speech will retry automatically.')
      : s.phase === 'failed'
        ? (s.message ?? 'Transcription stopped. Open Settings to check setup.')
        : s.lagMs > 10000
          ? 'Transcription is catching up. Your latest text may be delayed.'
          : s.message?.includes('could not be saved')
            ? s.message
            : 'The transcript may be incomplete.';
  if (followTranscript && detail === 'transcript')
    requestAnimationFrame(() => {
      transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
    });
  updateEvidence();
  updatePresence();
}
function updatePresence(): void {
  const p = assistantPresence(recording, snapshot, transcript);
  const actionable = !!p.recovery;
  $('memo-recovery').hidden = !actionable;
  $('memo-recovery-text').textContent = actionable ? p.detail : '';
  $('resume').hidden = p.recovery !== 'retry';
  $<HTMLButtonElement>('resume').disabled = resumeBusy;
  $('resume').textContent = resumeBusy ? 'Trying again…' : 'Try again';
  $('presence-settings').hidden = p.recovery !== 'settings';
  memoCharacter.activity(
    actionable
      ? 'reassure'
      : snapshot?.liveV2?.stage
        ? 'thinking'
        : recording.phase === 'recording'
          ? 'listening'
          : 'idle',
  );
  updateRecording();
}
function updateRecording(): void {
  const isRecording = recording.phase === 'recording';
  memoCharacter.recording(recording.phase);
  const labels: Record<Status['phase'], string> = {
    idle: snapshot?.sessionId ? 'Finished' : 'Ready',
    starting: 'Starting…',
    recording: 'Recording',
    stopping: 'Finishing…',
    saving: 'Saving audio…',
    'save-failed': 'Audio retained',
    error: 'Recording stopped',
  };
  $('session-status').textContent = labels[recording.phase];
  $('record-dot').hidden = !isRecording;
  const elapsed = recording.session?.createdAt
    ? isRecording
      ? Date.now() - recording.session.createdAt
      : recording.session.durationMs
    : undefined;
  $('session-time').textContent = elapsed === undefined ? '' : time(elapsed);
  $<HTMLButtonElement>('stop').disabled = !isRecording || stopBusy;
  const recoveringSave = recording.phase === 'save-failed' || saveBusy;
  const recoveryFocused = $('audio-recovery').contains(document.activeElement);
  $('retry-save').hidden = !recoveringSave;
  $('audio-recovery').hidden = !recoveringSave;
  $<HTMLButtonElement>('retry-save').disabled = saveBusy;
  $('retry-save').textContent = saveBusy ? 'Saving…' : 'Retry save';
  updateSessionView();
  if (!recoveringSave && recoveryFocused && !showingLive && panelView === 'assistant')
    $('start').focus({ preventScroll: true });
}
function updateSessionView(): void {
  const live =
    (replayView && !!snapshot?.sessionId) ||
    reviewingSaved ||
    showLiveAssistant(
      recording,
      snapshot?.phase === 'finishing' || transcript?.phase === 'finishing',
    );
  const focus = document.activeElement;
  const movedFromLive =
    showingLive &&
    !live &&
    focus instanceof HTMLElement &&
    ($('mimo-reading-surface').contains(focus) || $('session-controls').contains(focus));
  const movedFromStart = !showingLive && live && focus === $('start');
  showingLive = live;
  $('mimo-reading-surface').hidden = !live && panelView !== 'settings';
  $('assistant-view').hidden = panelView === 'settings' || !live;
  $('idle-view').hidden = panelView === 'settings' || live;
  idleMascot.setVisible(panelView === 'assistant' && !live);
  idleMascot.setPose(
    recording.phase === 'starting'
      ? 'thinking'
      : recording.phase === 'error'
        ? 'reassure'
        : recording.session
          ? 'rest'
          : 'idle',
  );
  $('session-controls').hidden = !live;
  document.body.dataset.live = String(live);
  document.body.dataset.recording = recording.phase;
  $('leave-saved').hidden =
    !reviewingSaved || panelView === 'settings' || recording.phase !== 'idle';
  $('open-live').hidden = !live;
  $('recording-status').hidden = !live && recording.phase !== 'save-failed';
  $('open-transcript').hidden = !live;
  $('open-insights').hidden =
    (!live &&
      !snapshot?.liveV2?.memo &&
      !snapshot?.liveV2?.contributions.length &&
      !snapshot?.liveV2?.legacyNote &&
      !snapshot?.live?.contributions.length &&
      !snapshot?.live?.legacyNote) ||
    (!snapshot?.liveV2 && !snapshot?.live && !snapshot?.summary);
  syncCompanion();
  const canStart = /^https?:\/\//.test(activeTab?.url ?? '') && activeTab?.id !== undefined;
  const connecting = startBusy || recording.phase === 'starting';
  const backgroundBusy = !!recording.transcriptionBusy || !!recording.assistantBusy;
  $<HTMLButtonElement>('start').disabled =
    replayView || !recordingLoaded || connecting || backgroundBusy || !canStart || live;
  $('start-label').textContent = connecting
    ? 'Connecting…'
    : backgroundBusy
      ? transcript?.phase === 'loading'
        ? 'Preparing…'
        : 'Finishing…'
      : 'Start listening';
  $('start').setAttribute(
    'aria-label',
    connecting ? 'Starting recording' : 'Listen to this tab and microphone',
  );
  $('start-source').textContent = activeTab?.title ?? 'Open a website tab';
  $('start-hint').textContent = connecting
    ? 'Connecting tab audio + microphone…'
    : backgroundBusy
      ? transcript?.phase === 'loading'
        ? 'Preparing transcription…'
        : 'Finishing the last meeting…'
      : canStart
        ? 'Tab audio + microphone'
        : 'Open a website tab to listen.';
  if (replayView) {
    $('start-label').textContent = 'Choose audio in Replay Lab';
    $('start-source').textContent = 'The selected recording is the only audio source.';
    $('start-hint').textContent = 'Use Start replay beside this preview.';
    $('start').setAttribute('aria-label', 'Use Start replay in Replay Lab');
    $('stop').setAttribute('aria-label', 'Stop replay');
    $('stop').title = 'Stop replay';
  }
  if (panelView === 'assistant') {
    if (movedFromLive) $('start').focus();
    else if (movedFromStart) focusDetail();
  }
}
function syncCompanion(): void {
  const visible = showingLive && panelView === 'assistant' && detail === 'summary';
  memoCharacter.setVisible(visible);
  memoCharacter.setCompanionVisible(visible);
  syncEmbeddedCompanion();
}
function syncEmbeddedCompanion(): void {
  $<HTMLIFrameElement>('settings-frame').contentWindow?.postMessage(
    {
      type: 'MIMO_HOST_COMPANION',
      visible: showingLive && panelView === 'assistant' && detail === 'summary',
    },
    location.origin,
  );
  $<HTMLIFrameElement>('settings-frame').contentWindow?.postMessage(
    {
      type: 'MIMO_SETTINGS_HOST',
      canReturn: !showingLive && panelView === 'settings',
      hasHistory: !$('open-insights').hidden,
    },
    location.origin,
  );
}
async function refreshActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const query =
    browserWindowId === undefined
      ? { active: true, currentWindow: true }
      : { active: true, windowId: browserWindowId };
  [activeTab] = await chrome.tabs.query(query);
  updateSessionView();
  return activeTab;
}
function updateAppearance(): void {
  document.body.dataset.surface = surfaceAtTime(surfacePreference);
}
function recorder(s: Status): void {
  recordingLoaded = true;
  recording = s;
  if (['starting', 'recording'].includes(s.phase) && s.session && s.session.id !== activeSession) {
    reviewingSaved = false;
    activeSession = s.session.id;
    uiError = '';
    $('ai-alert').hidden = true;
    if (transcript?.sessionId !== activeSession) {
      clearTranscript();
      transcript = undefined;
    }
    if (snapshot?.sessionId !== activeSession) {
      snapshot = undefined;
      memoRows.clear();
      renderedMemo = '';
      $('summary-feed').replaceChildren();
      renderedSession = undefined;
      $('follow-up').hidden = true;
      $('summary-empty').hidden = false;
      $('open-insights').hidden = true;
      $('deep-section').hidden = true;
      $('context-warning').hidden = true;
      $('transcript-warning').hidden = true;
    }
    followSummary = true;
    followTranscript = true;
    memoCharacter.reset(activeSession);
    selectDetail('summary', false);
  }
  updatePresence();
  if (s.error) error(new Error(s.error));
}
function showView(view: PanelView, moveFocus = true): void {
  const changed = panelView !== view;
  if (changed) settingsFocusEpoch++;
  const focusEpoch = settingsFocusEpoch;
  panelView = view;
  if (changed) {
    sourceNavigation = false;
    memoCharacter.navigation(view === 'settings' ? 'settings' : detail);
  }
  const settings = view === 'settings';
  document.body.classList.toggle('settings-open', settings);
  updateNavigation();
  updateSessionView();
  const frame = $<HTMLIFrameElement>('settings-frame');
  frame.hidden = !settings;
  const firstLoad = settings && !frame.hasAttribute('src');
  $('settings').title = 'Settings';
  $('settings').setAttribute('aria-label', 'Settings');
  if (changed && settings && moveFocus) {
    const focusSettings = () => {
      if (panelView === 'settings' && focusEpoch === settingsFocusEpoch)
        frame.contentWindow?.postMessage({ type: 'LISTEN_SETTINGS_FOCUS' }, location.origin);
    };
    if (!firstLoad && frame.contentDocument?.readyState === 'complete') focusSettings();
    else frame.addEventListener('load', focusSettings, { once: true });
  } else if (changed && !settings && moveFocus) {
    if (showingLive) focusDetail();
    else $('start').focus();
    if (followSummary) requestAnimationFrame(jumpSummary);
  }
  if (firstLoad) frame.src = 'setup.html?panel=1';
}
function openSettings(open = panelView !== 'settings', moveFocus = true): void {
  const view = open ? 'settings' : 'assistant';
  showView(view, moveFocus);
  if (navigationKey) void chrome.storage.session.set({ [navigationKey]: view }).catch(error);
}
$('settings').onclick = () => openSettings(true);
$('idle-settings').onclick = () => openSettings(true);
window.addEventListener('message', (event) => {
  const frame = $<HTMLIFrameElement>('settings-frame');
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  if (panelView !== 'settings') return;
  if (event.data?.type === 'MIMO_SETTINGS_RETURN' && !showingLive) openSettings(false);
  else if (event.data?.type === 'MIMO_SETTINGS_OPEN_HISTORY' && !$('open-insights').hidden)
    $('open-insights').click();
});
$('presence-settings').onclick = () => {
  if (panelView !== 'settings') openSettings();
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && navigationKey && changes[navigationKey])
    showView(changes[navigationKey].newValue === 'settings' ? 'settings' : 'assistant');
  if (area === 'local' && changes[surfaceKey]) {
    surfacePreference = assistantSurface(changes[surfaceKey].newValue);
    updateAppearance();
  }
});
updateAppearance();
void chrome.storage.local
  .get(surfaceKey)
  .then((saved) => {
    surfacePreference = assistantSurface(saved[surfaceKey]);
    updateAppearance();
  })
  .catch(error);
void chrome.windows
  .getCurrent()
  .then(async (current) => {
    if (current.id === undefined) return;
    browserWindowId = current.id;
    void refreshActiveTab().catch(error);
    navigationKey = panelViewKey(current.id);
    const saved = await chrome.storage.session.get(navigationKey);
    showView(saved[navigationKey] === 'settings' ? 'settings' : 'assistant');
  })
  .catch(error);
chrome.tabs?.onActivated?.addListener(() => {
  void refreshActiveTab().catch(error);
});
chrome.tabs?.onUpdated?.addListener((id, change) => {
  if (id === activeTab?.id && (change.url || change.title || change.status === 'complete'))
    void refreshActiveTab().catch(error);
});
$('start').onclick = async () => {
  if (
    replayView ||
    startBusy ||
    !recordingLoaded ||
    recording.phase === 'starting' ||
    recording.transcriptionBusy ||
    recording.assistantBusy ||
    showLiveAssistant(recording)
  )
    return;
  trace('listen.clicked');
  startBusy = true;
  uiError = '';
  $('ai-alert').hidden = true;
  updateSessionView();
  try {
    // Re-query on the click: the user may have switched tabs since opening the panel.
    const tab = await refreshActiveTab();
    if (tab?.id === undefined || !/^https?:\/\//.test(tab.url ?? ''))
      throw new Error('Open a website tab to listen.');
    recorder(
      await send<Status>({ type: 'START', tabId: tab.id, title: tab.title ?? 'Current tab' }),
    );
  } catch (e) {
    error(e);
  } finally {
    startBusy = false;
    updateSessionView();
  }
};
for (const feedback of ['useful', 'dismissed'] as const)
  $(feedback === 'useful' ? 'useful' : 'dismiss').onclick = async () => {
    if (!snapshot?.question || feedbackBusy) return;
    const sessionId = snapshot.sessionId!,
      issueKey = snapshot.question.issueKey;
    feedbackBusy = true;
    render(snapshot);
    try {
      render(
        await send<AssistantSnapshot>({
          type: 'ASSISTANT_FEEDBACK',
          sessionId,
          issueKey,
          feedback,
        }),
      );
    } catch (e) {
      error(e);
    } finally {
      feedbackBusy = false;
      if (snapshot) render(snapshot);
    }
  };
$('deeper').onclick = async () => {
  if (!snapshot?.sessionId || deepBusy) return;
  deepBusy = true;
  render(snapshot);
  try {
    render(
      await send<AssistantSnapshot>({ type: 'ASSISTANT_DEEPER', sessionId: snapshot.sessionId }),
    );
  } catch (e) {
    error(e);
  } finally {
    deepBusy = false;
    if (snapshot) render(snapshot);
  }
};
$('resume').onclick = async () => {
  if (resumeBusy) return;
  resumeBusy = true;
  updatePresence();
  try {
    render(await send<AssistantSnapshot>({ type: 'ASSISTANT_RESUME' }));
  } catch (e) {
    error(e);
  } finally {
    resumeBusy = false;
    updatePresence();
  }
};
$('stop').onclick = async () => {
  if (stopBusy || recording.phase !== 'recording') return;
  stopBusy = true;
  presentationEvent('ui.stop_clicked');
  updateRecording();
  try {
    recorder(await send<Status>({ type: 'STOP' }));
  } catch (e) {
    error(e);
  } finally {
    stopBusy = false;
    updateRecording();
  }
};
$('retry-save').onclick = async () => {
  const sessionId = recording.session?.id;
  if (saveBusy || !sessionId) return;
  saveBusy = true;
  updateRecording();
  try {
    recorder(await send<Status>({ type: 'RETRY', id: sessionId }));
  } catch (e) {
    error(e);
  } finally {
    saveBusy = false;
    updateRecording();
  }
};
document.addEventListener('visibilitychange', () => {
  updateAppearance();
  if (!document.hidden) void refreshActiveTab().catch(error);
  updatePresence();
});
window.addEventListener('pagehide', () => {
  memoCharacter.dispose();
  idleMascot.dispose();
});
window.addEventListener('focus', () => {
  void refreshActiveTab().catch(error);
});
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (sender.id !== chrome.runtime.id || m.target !== 'ui') return;
  if (m.type === 'MEMO_PRESENTATION_STATUS') {
    if (m.windowId !== undefined && m.windowId !== browserWindowId) return;
    respond({
      ok: true,
      value: {
        sessionId: snapshot?.liveV2 ? snapshot.sessionId : renderedSession,
        requestId: snapshot?.lastAnalysis?.requestId,
        version: snapshot?.version,
        memoCharacters: snapshot?.liveV2
          ? v2PresentationFields(snapshot).memoCharacters
          : renderedMemo.length,
        ...(snapshot?.liveV2
          ? {
              protocol: 2,
              memoId: snapshot.liveV2.memo?.id ?? null,
              contributionId: snapshot.liveV2.activeId,
              contributionStatus:
                snapshot.liveV2.contributions.find((c) => c.id === snapshot?.liveV2?.activeId)
                  ?.status ?? null,
              bubbleOpen: !$('memo-bubble').hidden,
              presentationMode: memoCharacter.mode,
              displayedContributionId: memoCharacter.displayedId ?? null,
              pendingContributionId: memoCharacter.pendingId ?? null,
              narrativeVisible: !!$('summary-feed').getClientRects().length,
              contributionVisible: !!$('contribution-view').getClientRects().length,
            }
          : {}),
        domCharacters:
          $(
            memoCharacter.mode === 'contribution' ? 'memo-bubble-content' : 'summary-feed',
          ).textContent?.trim().length ?? 0,
        view: panelView === 'settings' ? 'settings' : detail,
        emptyOutcomeMessage:
          !(snapshot?.liveV2 ? snapshot.liveV2.memo : renderedMemo) &&
          snapshot?.lastAnalysis?.outcome === 'empty',
        ...(m.includeMemoText === true
          ? {
              domText:
                $(memoCharacter.mode === 'contribution' ? 'memo-bubble-content' : 'summary-feed')
                  .textContent ?? '',
              domMemoText: $('summary-feed').textContent ?? '',
              windowId: browserWindowId,
              visibleEstimate:
                document.visibilityState === 'visible' &&
                panelView !== 'settings' &&
                detail === 'summary' &&
                (!!$('summary-feed').getClientRects().length ||
                  !!$('contribution-view').getClientRects().length),
            }
          : {}),
      },
    });
    return;
  }
  if (m.type === 'ASSISTANT_STATE') {
    liveAI = true;
    render(m.snapshot, true);
  }
  if (m.type === 'TRANSCRIPT_STATE') {
    liveTranscript = true;
    renderTranscript(m.snapshot, true);
  }
  if (m.type === 'STATE') {
    liveRecording = true;
    recorder(m.status);
  }
  if (m.type === 'RECORDING_START_FAILED') error(new Error(m.error));
});
void send<AssistantSnapshot>({ type: 'ASSISTANT_STATUS' })
  .then((s) => {
    if (!liveAI) render(s);
  })
  .catch(error);
void send<TranscriptSnapshot>({ type: 'TRANSCRIPT_STATUS' })
  .then((s) => {
    if (!liveTranscript) renderTranscript(s);
  })
  .catch(error);
void send<Status>({ type: 'STATUS' })
  .then((s) => {
    if (!liveRecording) recorder(s);
  })
  .catch(error);
setInterval(() => {
  if (!document.hidden) {
    updateAppearance();
    updatePresence();
  }
}, 1000);
new ResizeObserver(() => {
  if (panelView !== 'assistant') return;
  if (detail === 'summary' && followSummary) requestAnimationFrame(jumpSummary);
  else if (detail === 'transcript' && followTranscript)
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
}).observe(analysisPanel);
