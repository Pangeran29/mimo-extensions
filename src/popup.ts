import { trace, diagnosticsReady } from './diagnostics';
void diagnosticsReady;
import { assistantSurface, surfaceAtTime, surfaceKey, type AssistantSurface } from './appearance';
import type { TranscriptSnapshot } from './transcription/types';
import { openPanel, type PanelView } from './panel';
import { MimoMascot, type MimoPose } from './mimo/mascot';
import {
  duration,
  errorText,
  type Reply,
  type Status,
  type UIMessage,
  type Session,
} from './types';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $<HTMLButtonElement>('main-action');
const error = $<HTMLParagraphElement>('error');
const greeting = $('memo-greeting');
const mascot = new MimoMascot(greeting, { interactive: true, size: 136 });
let current: Status = { phase: 'idle', retained: [] };
let activeTab: chrome.tabs.Tab | undefined;
let micReady = false;
let pending = false;
let statusAt = Date.now();
let loaded = false;
let modelLoading = false;
let preference: AssistantSurface = 'Automatic';
let lastRecovery = '';
let mascotPose: MimoPose | undefined;
let previousPhase: Status['phase'] | undefined;
const labels: Record<Status['phase'], string> = {
  idle: 'Ready to listen',
  starting: 'Connecting audio…',
  recording: 'Recording both sources',
  stopping: 'Finishing recording…',
  saving: 'Saving audio…',
  'save-failed': 'Audio needs saving',
  error: 'Recording stopped',
};
async function send(message: UIMessage): Promise<Status> {
  const reply: Reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok)
    throw new Error(reply?.error ?? 'Recorder unavailable. Reopen Mimo and try again.');
  return reply.value;
}
function showError(text?: string): void {
  const changed = error.textContent !== (text ?? '');
  error.textContent = text ?? '';
  error.hidden = !text;
  if (text && changed) mascot.react('reassure');
}
function mimoState(status: Status): void {
  const pose: MimoPose =
    status.error || status.phase === 'save-failed' || status.phase === 'error'
      ? 'reassure'
      : modelLoading ||
          status.phase === 'starting' ||
          status.phase === 'saving' ||
          (pending && status.phase === 'idle')
        ? 'thinking'
        : status.phase === 'recording'
          ? 'listening'
          : status.phase === 'stopping'
            ? 'rest'
            : !micReady
              ? 'curious'
              : 'idle';
  if (pose !== mascotPose) {
    mascot.setPose(pose);
    mascotPose = pose;
  }
  if (previousPhase === 'recording' && status.phase !== 'recording') mascot.react('stop');
  else if (
    previousPhase !== undefined &&
    previousPhase !== 'recording' &&
    status.phase === 'recording'
  )
    mascot.react('listen');
  previousPhase = status.phase;
  if (!greeting.classList.contains('greeting'))
    $('memo-message').textContent = modelLoading
      ? 'Getting transcription ready.'
      : status.phase === 'starting'
        ? 'Connecting to your conversation.'
        : status.phase === 'recording'
          ? 'I’m listening with you.'
          : status.phase === 'stopping'
            ? 'Finishing up.'
            : status.phase === 'saving'
              ? 'Saving your recording.'
              : status.phase === 'save-failed'
                ? 'Your recording is here. Let’s retry saving.'
                : status.phase === 'error'
                  ? 'I’m here. Let’s get this working.'
                  : 'Ready when you are.';
}
function render(status: Status): void {
  current = status;
  statusAt = Date.now();
  document.body.dataset.phase = status.phase;
  $('state').textContent =
    status.phase === 'recording'
      ? 'Listening'
      : modelLoading
        ? 'Preparing transcription…'
        : labels[status.phase];
  $('dot').classList.toggle('active', status.phase === 'recording');
  $('source').textContent = status.session?.sourceTitle ?? activeTab?.title ?? 'Open a website tab';
  $('timer').textContent = duration(status.session?.durationMs ?? 0);
  const busy = ['starting', 'stopping', 'saving'].includes(status.phase);
  mimoState(status);
  const canRecord = /^https?:\/\//.test(activeTab?.url ?? '');
  main.disabled =
    !loaded ||
    pending ||
    modelLoading ||
    busy ||
    ((status.transcriptionBusy || status.assistantBusy) && status.phase !== 'recording') ||
    (!canRecord && status.phase !== 'recording');
  main.hidden = ['recording', 'stopping', 'saving'].includes(status.phase);
  $<HTMLButtonElement>('stop').hidden = status.phase !== 'recording';
  $<HTMLButtonElement>('stop').disabled = pending;
  $('action-label').textContent =
    status.phase === 'recording'
      ? 'Stop & Save'
      : busy
        ? labels[status.phase]
        : !micReady
          ? 'Set up'
          : 'Start listening';
  main.setAttribute(
    'aria-label',
    modelLoading
      ? 'Preparing transcription'
      : busy
        ? labels[status.phase]
        : status.phase === 'recording'
          ? 'Stop & save recording'
          : !micReady
            ? 'Set up microphone'
            : 'Start listening to this tab and microphone',
  );
  $('capture-status').hidden = false;
  $('timer').hidden = !['recording', 'stopping', 'saving'].includes(status.phase);
  $('open-assistant').hidden = !['recording', 'stopping', 'saving'].includes(status.phase);
  $('notice').textContent =
    !canRecord && status.phase !== 'recording'
      ? 'Open a website tab to listen.'
      : status.phase === 'saving'
        ? 'Keep Chrome open until saving finishes.'
        : status.phase === 'recording'
          ? 'Tab audio + microphone'
          : status.transcriptionBusy || status.assistantBusy
            ? modelLoading
              ? 'Preparing transcription…'
              : 'Finishing the last analysis…'
            : !micReady
              ? 'Allow your microphone to get started.'
              : 'Tab audio + microphone';
  showError(status.error ?? (status.session?.partial ? status.session.error : undefined));
  const retained = [
    ...(status.phase === 'save-failed' && status.session ? [status.session] : []),
    ...status.retained,
  ];
  $('recovery').hidden = retained.length === 0;
  const signature = JSON.stringify(retained) + busy + status.phase;
  if (signature !== lastRecovery) {
    lastRecovery = signature;
    const parent = $('retained');
    parent.replaceChildren();
    retained.forEach((session) =>
      renderRetained(parent, session, busy || status.phase === 'recording'),
    );
  }
}

function renderRetained(parent: HTMLElement, session: Session, disabled: boolean): void {
  const item = document.createElement('div');
  item.className = 'retained-item';
  const title = document.createElement('p');
  title.textContent = session.sourceTitle;
  const detail = document.createElement('p');
  detail.textContent = `${new Date(session.createdAt).toLocaleString()} · ${(session.bytes / 1024 / 1024).toFixed(1)} MB`;
  item.append(title, detail);
  if (session.partial || session.status === 'capturing' || session.error) {
    const note = document.createElement('p');
    note.textContent = session.error ?? 'Interrupted recording. The last audio may be missing.';
    item.append(note);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [label, type] of [
    ['Retry Save', 'RETRY'],
    ['Discard', 'DISCARD'],
  ] as const) {
    const button = document.createElement('button');
    button.textContent = label;
    button.className = 'text-button' + (type === 'DISCARD' ? ' discard' : '');
    button.disabled = disabled;
    button.addEventListener('click', () => {
      if (type === 'DISCARD' && !confirm('Discard this retained recording? This cannot be undone.'))
        return;
      void act(() => send({ target: 'worker', type, id: session.id }));
    });
    actions.append(button);
  }
  item.append(actions);
  parent.append(item);
}
async function act(task: () => Promise<Status>): Promise<void> {
  if (pending) return;
  pending = true;
  render(current);
  showError();
  let failure: string | undefined;
  try {
    render(await task());
  } catch (e) {
    failure = errorText(e);
  } finally {
    pending = false;
    render(current);
    if (failure) showError(failure);
  }
}
$('settings').addEventListener('click', () => {
  openDockedView('settings');
});
let greetingTimer: ReturnType<typeof setTimeout> | undefined;
let greetings = 0;
greeting.addEventListener('click', () => {
  clearTimeout(greetingTimer);
  const messages =
    current.phase === 'recording'
      ? ['I’m with you.', 'A little thought, when it helps.', 'Keep going. I’m listening.']
      : ['Hi, I’m Mimo.', 'Good to see you.', 'Ready when you are.'];
  $('memo-message').textContent = messages[greetings++ % messages.length];
  greeting.classList.add('greeting');
  greetingTimer = setTimeout(() => {
    greeting.classList.remove('greeting');
    mimoState(current);
  }, 1800);
});
window.addEventListener('pagehide', () => {
  clearTimeout(greetingTimer);
  mascot.dispose();
});
$('stop').addEventListener('click', () => {
  if (current.phase === 'recording' && !pending)
    void act(() => send({ target: 'worker', type: 'STOP' }));
});
main.addEventListener('click', () => {
  if (current.phase === 'recording') {
    void act(() => send({ target: 'worker', type: 'STOP' }));
    return;
  }
  if (!activeTab?.id) return;
  trace('listen.clicked');
  // Dispatch recording before opening the panel: Chrome may close the toolbar
  // popup as soon as the panel opens. The worker owns the recording task.
  void act(() =>
    send({
      target: 'worker',
      type: 'START',
      tabId: activeTab!.id!,
      title: activeTab!.title ?? 'Current tab',
    }),
  );
  if (activeTab.windowId !== undefined) {
    void openPanel(activeTab.windowId, 'assistant').catch(() =>
      showError('Could not open Mimo. Choose Join Mimo once recording begins.'),
    );
  }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.target === 'ui' && message.type === 'STATE') render(message.status);
  if (message.target === 'ui' && message.type === 'TRANSCRIPT_STATE') updateModel(message.snapshot);
});
setInterval(() => {
  if (current.phase === 'recording')
    $('timer').textContent = duration((current.session?.durationMs ?? 0) + Date.now() - statusAt);
}, 500);
void (async () => {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  micReady = !!(await chrome.storage.local.get('microphoneReady')).microphoneReady;
  const status = await send({ target: 'worker', type: 'STATUS' });
  loaded = true;
  render(status);
})().catch((e) => showError(errorText(e)));

function openDockedView(view: PanelView): void {
  if (activeTab?.windowId === undefined) {
    showError('The browser tab is not ready. Reopen Mimo and try again.');
    return;
  }
  void openPanel(activeTab.windowId, view)
    .then(() => window.close())
    .catch(() =>
      showError(
        'Could not open the Mimo side panel. Reload Mimo in chrome://extensions and try again.',
      ),
    );
}
$('open-assistant').addEventListener('click', () => openDockedView('assistant'));

function updateAppearance(): void {
  document.body.dataset.surface = surfaceAtTime(preference);
}
updateAppearance();
void chrome.storage.local
  .get(surfaceKey)
  .then((saved) => {
    preference = assistantSurface(saved[surfaceKey]);
    updateAppearance();
  })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[surfaceKey]) {
    preference = assistantSurface(changes[surfaceKey].newValue);
    updateAppearance();
  }
});
document.addEventListener('visibilitychange', updateAppearance);
setInterval(() => {
  if (!document.hidden) updateAppearance();
}, 1000);
function updateModel(model: TranscriptSnapshot): void {
  const wasLoading = modelLoading;
  const nextLoading = model.phase === 'loading';
  if (nextLoading === wasLoading) return;
  modelLoading = nextLoading;
  // Recognition updates must not reset the recording timer's elapsed baseline.
  const recordingStatusAt = statusAt;
  render(current);
  statusAt = recordingStatusAt;
  if (wasLoading && !modelLoading)
    void send({ target: 'worker', type: 'STATUS' })
      .then(render)
      .catch((e) => showError(errorText(e)));
}
// Reuse the same automatic restore/check as Settings; never download on a fresh install.
void chrome.runtime
  .sendMessage({ target: 'worker', type: 'TRANSCRIPT_STATUS' })
  .then((reply: Reply<TranscriptSnapshot>) => {
    if (reply?.ok) updateModel(reply.value);
  })
  .catch(() => {});
