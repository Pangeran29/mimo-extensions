import { openPanel, panelViewKey, setupWarningKey } from './panel';
import { AGENT_DIAGNOSTICS_KEY } from './agent-diagnostics';
import { supportReport, type MemoPresentation } from './support-report';
import { loadAssistant } from './assistant/store';
import type { AssistantSnapshot } from './assistant/types';
import type { Reply } from './types';
import type { TranscriptSnapshot } from './transcription/types';
import { DEFAULT_SETTINGS, type AssistantSettings } from './assistant/types';
import { normalizeSettings, providerOf, modelFor } from './assistant/providers';
import { assistantSurface, surfaceAtTime, surfaceKey, type AssistantSurface } from './appearance';
import { MimoMascot, type MimoPose } from './mimo/mascot';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsMascot = new MimoMascot($('settings-mimo-greeting'), { interactive: true, size: 60 });
let readinessPose: MimoPose | undefined;
let previousReady: boolean | undefined;
let helloTimer: ReturnType<typeof setTimeout> | undefined;
$('settings-mimo-greeting').onclick = () => {
  clearTimeout(helloTimer);
  $('settings-mimo-message').textContent = 'Hi. I’m right here.';
  if ($('overview').hidden) $('settings-mimo-announcement').textContent = 'Hi. I’m right here.';
  helloTimer = setTimeout(() => {
    $('settings-mimo-message').textContent = 'Make Mimo ready for your next conversation.';
    $('settings-mimo-announcement').textContent = '';
  }, 1800);
};
window.addEventListener('pagehide', () => {
  clearTimeout(helloTimer);
  settingsMascot.dispose();
});
const agentToggle = $<HTMLInputElement>('agent-diagnostics-enabled');
void chrome.storage.local
  .get(AGENT_DIAGNOSTICS_KEY)
  .then((saved) => {
    agentToggle.checked = saved[AGENT_DIAGNOSTICS_KEY] === true;
    agentToggle.disabled = false;
  })
  .catch(() =>
    feedback(
      'agent-diagnostics-result',
      'Could not load agent diagnostics. Reopen Settings to retry.',
      'error',
    ),
  );
agentToggle.onchange = async () => {
  agentToggle.disabled = true;
  try {
    await chrome.storage.local.set({ [AGENT_DIAGNOSTICS_KEY]: agentToggle.checked });
    feedback(
      'agent-diagnostics-result',
      agentToggle.checked
        ? 'Enabled for the next meeting. The report contains meeting text and notes.'
        : 'Disabled for future meetings. Existing reports are kept locally.',
      'success',
    );
  } catch {
    agentToggle.checked = !agentToggle.checked;
    feedback('agent-diagnostics-result', 'Could not save. Try again.', 'error');
  } finally {
    agentToggle.disabled = false;
  }
};
$('download-agent-report').onclick = async () => {
  const button = $<HTMLButtonElement>('download-agent-report');
  button.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'AGENT_REPORT_EXPORT',
    });
    if (!reply?.ok) throw Error();
    feedback(
      'agent-diagnostics-result',
      'Report download started. An unfinished meeting report may be incomplete.',
      'success',
    );
  } catch {
    feedback(
      'agent-diagnostics-result',
      'No report downloaded. Enable diagnostics before a meeting, or retry if a report is already saved.',
      'error',
    );
  } finally {
    button.disabled = false;
  }
};
const inPanel = new URLSearchParams(location.search).get('panel') === '1';
if (inPanel) document.body.classList.add('panel-settings');
let hostCanReturn = false;
let hostHasHistory = false;
$('settings-return').onclick = () => {
  if (hostCanReturn) window.parent.postMessage({ type: 'MIMO_SETTINGS_RETURN' }, location.origin);
};
$('settings-history').onclick = () => {
  if (hostHasHistory)
    window.parent.postMessage({ type: 'MIMO_SETTINGS_OPEN_HISTORY' }, location.origin);
};
function setHostCompanion(visible: boolean): void {
  const hosted = inPanel && window.parent !== window && visible;
  document.body.classList.toggle('host-companion', hosted);
  settingsMascot.setVisible(!hosted);
  if (hosted) {
    clearTimeout(helloTimer);
    $('settings-mimo-message').textContent = 'Make Mimo ready for your next conversation.';
    $('settings-mimo-announcement').textContent = '';
  }
}
setHostCompanion(new URLSearchParams(location.search).get('companion') === 'host');
type Screen =
  | 'overview'
  | 'microphone'
  | 'transcription'
  | 'ai'
  | 'defaults'
  | 'privacy'
  | 'appearance';
let screen: Screen = 'overview';
let micAllowed: boolean | undefined;
let modelReady: boolean | undefined;
let modelBusy = false;
let preparing = false;
let aiLoaded = false;
let aiLoadFailed = false;
let hasKey = false;
let hasHpopKey = false;
let hasAccess = false;
let saving = false;
let connectionDirty = false;
let defaultsDirty = false;
let deferredRefresh = false;
let savedSettings: AssistantSettings = { ...DEFAULT_SETTINGS };
let windowId: number | undefined;
const fields = $<HTMLFieldSetElement>('ai-fields');
const defaultFields = $<HTMLFieldSetElement>('defaults-fields');
const key = $<HTMLInputElement>('ai-key');
const providerSelect = $<HTMLSelectElement>('ai-provider');
function selectedProvider() {
  return providerSelect.value === 'deepinfra' ? ('deepinfra' as const) : ('hpop' as const);
}
function updateProviderFields() {
  const managed = selectedProvider() === 'deepinfra';
  $('hpop-connection').hidden = managed;
  $('managed-notes-info').hidden = !managed;
  key.required = !managed && !hasHpopKey;
  $('key-management').hidden = managed || !hasHpopKey;
}
providerSelect.onchange = () => {
  connectionDirty = true;
  updateProviderFields();
  updateDrafts();
};
const goal = $<HTMLTextAreaElement>('ai-goal');
const prepare = $<HTMLButtonElement>('prepare-transcription');
const grant = $<HTMLButtonElement>('grant');

function feedback(id: string, text: string, kind = ''): void {
  $(id).textContent = text;
  $(id).dataset.state = kind;
  $(id).hidden = !text;
  if (text && kind === 'error') settingsMascot.react('reassure');
  else if (
    text &&
    kind === 'success' &&
    ['ai-result', 'defaults-result', 'appearance-result'].includes(id)
  )
    settingsMascot.react('useful');
}
function fieldError(id: string, message = ''): void {
  $(id).setAttribute('aria-invalid', String(!!message));
  feedback(id + '-error', message);
}
type StatusTone = 'success' | 'warning' | 'busy' | 'error';
function row(
  id: string,
  text: string,
  ready: boolean,
  tone: StatusTone = ready ? 'success' : 'warning',
): void {
  $(id + '-state').textContent = text;
  $(id + '-state').dataset.state = tone;
  const button = $('open-' + (id === 'mic' ? 'microphone' : id === 'model' ? 'transcription' : id));
  button.dataset.ready = String(ready);
  button.dataset.needed = String(!ready);
}
function updateReadiness(): void {
  const aiReady = aiLoaded && savedSettings.enabled && hasKey && hasAccess;
  row(
    'ai',
    !aiLoaded
      ? aiLoadFailed
        ? 'Unavailable'
        : 'Checking…'
      : !hasKey
        ? 'Add key'
        : !hasAccess
          ? 'Allow access'
          : !savedSettings.enabled
            ? 'Set up'
            : 'Configured',
    aiReady,
    !aiLoaded ? (aiLoadFailed ? 'error' : 'busy') : aiReady ? 'success' : 'warning',
  );
  const missing = [
    micAllowed === false && 'microphone',
    modelReady === false && 'transcription',
    !aiReady && 'AI connection',
  ].filter(Boolean);
  const checking =
    micAllowed === undefined || modelReady === undefined || (!aiLoaded && !aiLoadFailed);
  $('readiness').dataset.state = checking ? 'busy' : missing.length ? 'warning' : 'success';
  $('readiness').textContent = checking
    ? 'Checking setup…'
    : !missing.length
      ? 'Ready to listen'
      : missing.length === 1
        ? `${missing[0] === 'AI connection' ? 'AI connection' : missing[0] === 'microphone' ? 'Microphone access' : 'Transcription setup'} needed to start.`
        : 'Complete microphone, transcription, and AI setup to start.';
  const ready = !checking && !missing.length;
  const pose: MimoPose = aiLoadFailed
    ? 'reassure'
    : checking || modelBusy || saving
      ? 'thinking'
      : ready
        ? 'idle'
        : 'curious';
  if (pose !== readinessPose) {
    settingsMascot.setPose(pose);
    readinessPose = pose;
  }
  if (!checking) {
    if (previousReady === false && ready) settingsMascot.react('useful');
    previousReady = ready;
  }
}
function showScreen(next: Screen, focus = true): void {
  screen = next;
  $('overview').hidden = next !== 'overview';
  $('detail').hidden = next === 'overview';
  const portraitHost = document.querySelector(
    next === 'overview' ? '.settings-hero' : '.settings-detail-heading',
  )!;
  if ($('settings-mimo-brand').parentElement !== portraitHost)
    portraitHost.append($('settings-mimo-brand'));
  for (const name of ['microphone', 'transcription', 'ai', 'defaults', 'privacy', 'appearance'])
    $('screen-' + name).hidden = name !== next;
  const titles: Record<Screen, string> = {
    overview: 'Settings',
    appearance: 'Appearance',
    microphone: 'Microphone',
    transcription: 'Transcription',
    ai: 'AI connection',
    defaults: 'Session defaults',
    privacy: 'Privacy & help',
  };
  $('detail-title').textContent = titles[next];
  document.title = `${titles[next]} · Mimo`;
  window.scrollTo({ top: 0 });
  if (focus) $(next === 'overview' ? 'overview-title' : 'detail-title').focus();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-screen]'))
  button.onclick = () => showScreen(button.dataset.screen as Screen);
$('back').onclick = () => {
  const previous = screen;
  showScreen('overview', false);
  $('open-' + previous).focus();
};
function micReady(ready: boolean): void {
  micAllowed = ready;
  row('mic', ready ? 'Allowed' : 'Allow access', ready);
  grant.textContent = ready ? 'Test microphone' : 'Allow microphone';
  grant.setAttribute('aria-label', grant.textContent);
  updateReadiness();
}
grant.onclick = async () => {
  grant.disabled = true;
  grant.textContent = 'Checking…';
  row('mic', 'Checking…', false, 'busy');
  grant.setAttribute('aria-busy', 'true');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.storage.local.set({ microphoneReady: true });
    micReady(true);
    feedback('result', 'Microphone is available.', 'success');
    $('mic-help').removeAttribute('open');
    await clearOldWarning();
  } catch (error) {
    await chrome.storage.local.set({ microphoneReady: false }).catch(() => {});
    micReady(false);
    row('mic', 'Check access', false, 'error');
    const name = error instanceof DOMException ? error.name : '';
    feedback(
      'result',
      name === 'NotFoundError'
        ? 'No microphone found. Connect one and try again.'
        : name === 'NotReadableError'
          ? 'Microphone unavailable. Check other apps and system permissions, then try again.'
          : 'Microphone blocked. Allow access in Chrome and system settings, then try again.',
      'error',
    );
    $('mic-help').setAttribute('open', '');
  } finally {
    grant.disabled = false;
    grant.setAttribute('aria-busy', 'false');
  }
};
void (async () => {
  const stored = await chrome.storage.local
    .get('microphoneReady')
    .catch(() => ({ microphoneReady: false }));
  if (!grant.disabled) micReady(!!stored.microphoneReady);
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    const refresh = () => {
      if (grant.disabled) return;
      micReady(permission.state === 'granted');
      void chrome.storage.local
        .set({ microphoneReady: permission.state === 'granted' })
        .catch(() => {});
    };
    refresh();
    permission.onchange = refresh;
  } catch {
    /* The explicit microphone test remains available. */
  }
})();
function showTranscription(snapshot: TranscriptSnapshot): void {
  const loading = snapshot.phase === 'loading';
  const failed = snapshot.phase === 'failed';
  modelBusy = ['loading', 'transcribing', 'finishing', 'recovering'].includes(snapshot.phase);
  providerSelect.disabled = modelBusy;
  modelReady = !failed;
  row(
    'model',
    snapshot.phase === 'recovering'
      ? 'Retrying'
      : failed
        ? 'Retry setup'
        : loading
          ? 'Preparing…'
          : modelReady
            ? 'Ready'
            : 'Set up',
    !!modelReady,
    failed ? 'error' : loading ? 'busy' : modelReady ? 'success' : 'warning',
  );
  prepare.disabled = preparing || modelBusy;
  prepare.classList.toggle('model-ready', !!modelReady && !loading);
  $('model-first-setup').hidden = !!modelReady;
  $('prepare-label').textContent = loading
    ? 'Preparing transcription…'
    : modelBusy
      ? 'Transcription in use'
      : modelReady
        ? 'Check transcription'
        : failed
          ? 'Retry transcription'
          : 'Check transcription';
  prepare.setAttribute('aria-label', $('prepare-label').textContent ?? 'Check transcription');
  prepare.title = modelReady ? 'Check transcription again' : '';
  prepare.setAttribute('aria-busy', String(loading));
  const progress = $<HTMLProgressElement>('model-progress');
  progress.hidden = !loading;
  // Backend percentages describe an individual file, not the whole installation.
  const message = snapshot.message ?? '';
  const percentage =
    loading && message.startsWith('Downloading model:') ? message.match(/(\d+)%$/) : null;
  if (percentage) {
    progress.max = 100;
    progress.value = Number(percentage[1]);
  } else progress.removeAttribute('value');
  feedback(
    'transcription-result',
    failed
      ? message || 'Transcription setup failed. Try again.'
      : loading
        ? message || 'Preparing transcription. Keep Chrome open.'
        : modelReady
          ? 'Cloud transcription is configured. Speech is sent to DeepInfra while listening.'
          : '',
    failed ? 'error' : loading ? 'busy' : modelReady ? 'success' : '',
  );
  updateReadiness();
}
prepare.onclick = async () => {
  preparing = true;
  showTranscription({
    phase: 'loading',
    modelReady: false,
    segments: [],
    incomplete: false,
    lagMs: 0,
  });
  try {
    const reply: Reply<TranscriptSnapshot> = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'PREPARE_TRANSCRIPTION',
    });
    if (!reply?.ok) throw new Error(reply?.error ?? 'Transcription setup unavailable. Try again.');
    showTranscription(reply.value);
    if (reply.value.modelReady) await clearOldWarning();
  } catch (error) {
    showTranscription({
      phase: 'failed',
      modelReady: false,
      segments: [],
      incomplete: false,
      lagMs: 0,
      message: error instanceof Error ? error.message : 'Transcription setup failed. Try again.',
    });
  } finally {
    preparing = false;
    prepare.disabled = modelBusy;
  }
};
chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    sender.id === chrome.runtime.id &&
    message.target === 'ui' &&
    message.type === 'TRANSCRIPT_STATE'
  )
    showTranscription(message.snapshot);
});
void chrome.runtime
  .sendMessage({ target: 'worker', type: 'TRANSCRIPT_STATUS' })
  .then((r: Reply<TranscriptSnapshot>) => {
    if (!r?.ok) throw new Error('Status unavailable');
    if (!preparing) showTranscription(r.value);
  })
  .catch(() => {
    modelReady = false;
    row('model', 'Check setup', false, 'error');
    feedback('transcription-result', 'Could not check transcription. Retry setup.', 'error');
    updateReadiness();
  });
function resetKeyVisibility(): void {
  key.type = 'password';
  $('ai-key-toggle').title = 'Show API key';
  $('ai-key-toggle').setAttribute('aria-label', 'Show API key');
  $('ai-key-toggle').setAttribute('aria-pressed', 'false');
}
function countGoal(): void {
  $('goal-count').textContent = `${goal.value.length} / 500`;
}
function updateDrafts(): void {
  $('ai-reset').hidden = !connectionDirty;
  $('defaults-reset').hidden = !defaultsDirty;
}
function applySettings(
  settings: AssistantSettings,
  savedKey: boolean,
  access: boolean,
  savedHpopKey?: boolean,
): void {
  savedSettings = normalizeSettings(settings);
  if (savedHpopKey !== undefined) hasHpopKey = savedHpopKey;
  else if (providerOf(savedSettings) === 'hpop') hasHpopKey = savedKey;
  if (!connectionDirty) providerSelect.value = providerOf(savedSettings);
  providerSelect.disabled = modelBusy;
  $('ai-provider-help').textContent = !modelBusy
    ? 'Choose between meetings. Your saved HPOP connection is retained.'
    : 'Stop and save the current meeting before changing notes provider.';
  aiLoaded = true;
  hasKey = savedKey;
  hasAccess = access;
  if (!connectionDirty) {
    key.placeholder = hasKey ? 'Replace saved key' : 'Paste your key';
    key.required = !hasKey;
    $('ai-key-state').textContent = hasKey
      ? 'Key saved on this device. Leave blank to keep it.'
      : 'Saved on this device until you remove it.';
  }
  if (!defaultsDirty) {
    goal.value = settings.goal;
    countGoal();
  }
  updateProviderFields();
  updateReadiness();
}
async function loadAI(preserveFeedback = false): Promise<void> {
  fields.disabled = true;
  defaultFields.disabled = true;
  $('ai-reload').hidden = true;
  $('defaults-reload').hidden = true;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_SETTINGS' });
    if (!r?.ok) throw new Error('Settings unavailable');
    aiLoadFailed = false;
    applySettings(r.value.settings, r.value.hasKey, r.value.hasAccess, r.value.hasHpopKey);
    fields.disabled = false;
    defaultFields.disabled = false;
    if (!preserveFeedback) {
      feedback('ai-result', '');
      feedback('defaults-result', '');
    }
  } catch {
    aiLoaded = false;
    aiLoadFailed = true;
    updateReadiness();
    feedback('ai-result', 'Could not load settings. Retry to continue.', 'error');
    feedback('defaults-result', 'Could not load settings. Retry to continue.', 'error');
    $('ai-reload').hidden = false;
    $('defaults-reload').hidden = false;
  }
}
$('ai-reload').onclick = $('defaults-reload').onclick = () => {
  void loadAI();
};
$('ai-key-toggle').onclick = () => {
  const visible = key.type === 'password';
  key.type = visible ? 'text' : 'password';
  $('ai-key-toggle').title = visible ? 'Hide API key' : 'Show API key';
  $('ai-key-toggle').setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
  $('ai-key-toggle').setAttribute('aria-pressed', String(visible));
};
$('ai-form').addEventListener('input', (event) => {
  connectionDirty = true;
  if (event.target === key && key.value.trim()) fieldError('ai-key');
  feedback('ai-result', '');
  updateDrafts();
});
goal.oninput = () => {
  defaultsDirty = true;
  countGoal();
  updateDrafts();
  feedback('defaults-result', '');
};
$('ai-reset').onclick = () => {
  connectionDirty = false;
  providerSelect.value = providerOf(savedSettings);
  updateProviderFields();
  key.value = '';
  resetKeyVisibility();
  fieldError('ai-key');
  updateDrafts();
  if (deferredRefresh) {
    deferredRefresh = false;
    void loadAI();
  }
};
$('defaults-reset').onclick = () => {
  defaultsDirty = false;
  goal.value = savedSettings.goal;
  countGoal();
  updateDrafts();
  if (deferredRefresh) {
    deferredRefresh = false;
    void loadAI();
  }
};
async function saveSettings(kind: 'connection' | 'defaults' | 'remove'): Promise<void> {
  if (saving || !aiLoaded) return;
  const connection = kind === 'connection';
  if (connection) {
    fieldError('ai-key');
    if (selectedProvider() === 'hpop' && !hasHpopKey && !key.value.trim()) {
      fieldError('ai-key', 'Enter your HPOP API key.');
      key.focus();
      return;
    }
  }
  saving = true;
  fields.disabled = true;
  defaultFields.disabled = true;
  $<HTMLButtonElement>('ai-clear').disabled = true;
  $<HTMLButtonElement>('confirm-remove').disabled = true;
  const button = $(kind === 'defaults' ? 'defaults-save' : 'ai-save');
  button.textContent = 'Saving…';
  button.setAttribute('aria-busy', 'true');
  const resultId = kind === 'defaults' ? 'defaults-result' : 'ai-result';
  feedback(resultId, '');
  try {
    // Keep provider permission in this user gesture, before awaiting anything else.
    if (
      connection &&
      selectedProvider() === 'hpop' &&
      !(await chrome.permissions.request({ origins: ['https://hpop.ai/*'] }))
    )
      throw new Error('HPOP access was not allowed. Save again to grant access.');
    const action =
      kind === 'defaults'
        ? { type: 'ASSISTANT_DEFAULTS', goal: goal.value }
        : {
            type: 'ASSISTANT_CONFIGURE',
            settings: {
              ...savedSettings,
              enabled: connection,
              provider: selectedProvider(),
              model: modelFor(selectedProvider()),
              benchmarkPassed: false,
            },
            apiKey:
              connection && selectedProvider() === 'hpop'
                ? key.value.trim() || undefined
                : undefined,
            clearKey: kind === 'remove',
          };
    const r = await chrome.runtime.sendMessage({ target: 'worker', ...action });
    if (!r?.ok) throw new Error(r?.error ?? 'Could not save. Your input is kept; try again.');
    if (kind === 'defaults') defaultsDirty = false;
    else {
      connectionDirty = false;
      key.value = '';
      resetKeyVisibility();
    }
    applySettings(r.value.settings, r.value.hasKey, r.value.hasAccess, r.value.hasHpopKey);
    updateDrafts();
    feedback(
      resultId,
      r.value.activationWarning ||
        (kind === 'defaults'
          ? 'Defaults saved.'
          : kind === 'remove'
            ? 'Key removed. Add a key before listening.'
            : providerOf(savedSettings) === 'deepinfra'
              ? 'DeepInfra selected. Notes will use DeepSeek V4.1 Flash.'
              : 'Connection saved. Key validity is checked when AI runs.'),
      r.value.activationWarning ? 'error' : kind === 'remove' ? 'warning' : 'success',
    );
    $('remove-confirm').hidden = true;
    $('ai-clear').hidden = false;
    await clearOldWarning();
  } catch (error) {
    feedback(
      resultId,
      error instanceof Error ? error.message : 'Could not save. Try again.',
      'error',
    );
  } finally {
    fields.disabled = false;
    defaultFields.disabled = false;
    $<HTMLButtonElement>('ai-clear').disabled = false;
    $<HTMLButtonElement>('confirm-remove').disabled = false;
    button.textContent = kind === 'defaults' ? 'Save defaults' : 'Save connection';
    button.setAttribute('aria-busy', 'false');
    saving = false;
    if (deferredRefresh && !connectionDirty && !defaultsDirty) {
      deferredRefresh = false;
      void loadAI(true);
    }
  }
}
$('ai-form').onsubmit = (event) => {
  event.preventDefault();
  void saveSettings('connection');
};
$('defaults-form').onsubmit = (event) => {
  event.preventDefault();
  void saveSettings('defaults');
};
$('ai-clear').onclick = () => {
  $('remove-confirm').hidden = false;
  $('ai-clear').hidden = true;
  $('cancel-remove').focus();
};
$('cancel-remove').onclick = () => {
  $('remove-confirm').hidden = true;
  $('ai-clear').hidden = false;
  $('ai-clear').focus();
};
$('confirm-remove').onclick = () => {
  void saveSettings('remove');
};
window.addEventListener('beforeunload', (event) => {
  if (connectionDirty || defaultsDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
void loadAI();

async function clearOldWarning(): Promise<void> {
  feedback('overview-feedback', '');
  if (windowId !== undefined)
    await chrome.storage.session.remove(setupWarningKey(windowId)).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === 'local' && (changes.assistantSettings || changes.assistantKey)) ||
    (area === 'session' && changes.assistantKey)
  ) {
    if (saving || connectionDirty || defaultsDirty) {
      deferredRefresh = true;
      if (!saving)
        feedback(
          'overview-feedback',
          'Settings changed elsewhere. Save or discard your edits to refresh.',
        );
    } else void loadAI();
  }
  if (area === 'session' && windowId !== undefined && changes[setupWarningKey(windowId)]) {
    const message = changes[setupWarningKey(windowId)].newValue;
    feedback('overview-feedback', message ?? '', 'error');
    if (message) showScreen('overview');
  }
});
chrome.permissions.onRemoved?.addListener((permissions) => {
  if (permissions.origins?.includes('https://hpop.ai/*')) {
    hasAccess = false;
    updateReadiness();
  }
});
void chrome.windows
  .getCurrent()
  .then(async (current) => {
    windowId = current.id;
    $('finish').hidden = windowId === undefined;
    if (windowId !== undefined) {
      const values = await chrome.storage.session.get(setupWarningKey(windowId));
      feedback('overview-feedback', values[setupWarningKey(windowId)] ?? '', 'error');
    }
  })
  .catch(() => {});
$('finish').onclick = () => {
  if (windowId === undefined) return;
  void (
    inPanel
      ? chrome.storage.session.set({ [panelViewKey(windowId)]: 'assistant' })
      : openPanel(windowId, 'assistant')
  ).catch(() =>
    feedback('overview-feedback', 'Could not open the live memo. Use the Mimo popup.', 'error'),
  );
};
// Host requests a focus target after revealing an already-loaded settings frame.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  if (event.data?.type === 'LISTEN_SETTINGS_FOCUS') {
    if (event.data.target === 'history' && screen === 'overview' && !$('settings-history').hidden)
      $('settings-history').focus();
    else $(screen === 'overview' ? 'overview-title' : 'detail-title').focus();
  } else if (
    inPanel &&
    window.parent !== window &&
    event.data?.type === 'MIMO_SETTINGS_HOST' &&
    typeof event.data.canReturn === 'boolean' &&
    typeof event.data.hasHistory === 'boolean'
  ) {
    hostCanReturn = event.data.canReturn;
    hostHasHistory = event.data.hasHistory;
    $('settings-return').hidden = !hostCanReturn;
    $('settings-history').hidden = !hostHasHistory;
  } else if (event.data?.type === 'MIMO_HOST_COMPANION' && typeof event.data.visible === 'boolean')
    setHostCompanion(event.data.visible);
});

const surface = $<HTMLSelectElement>('assistant-surface');
let savedSurface: AssistantSurface = 'Automatic';
function applyAppearance(): void {
  $('appearance-state').textContent = savedSurface;
  document.documentElement.dataset.surface = surfaceAtTime(savedSurface);
}
applyAppearance();
document.addEventListener('visibilitychange', applyAppearance);
setInterval(() => {
  if (!document.hidden) applyAppearance();
}, 1000);
void chrome.storage.local
  .get(surfaceKey)
  .then((saved) => {
    savedSurface = assistantSurface(saved[surfaceKey]);
    applyAppearance();
    surface.value = savedSurface;
    surface.disabled = false;
  })
  .catch(() => {
    surface.disabled = false;
    feedback(
      'appearance-result',
      'Could not load appearance. Choose a surface to try saving again.',
      'error',
    );
  });
surface.onchange = async () => {
  surface.disabled = true;
  try {
    const next = assistantSurface(surface.value);
    await chrome.storage.local.set({ [surfaceKey]: next });
    savedSurface = next;
    applyAppearance();
    feedback('appearance-result', 'Appearance saved.', 'success');
  } catch {
    surface.value = savedSurface;
    feedback('appearance-result', 'Could not save appearance. Try again.', 'error');
  } finally {
    surface.disabled = false;
  }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[surfaceKey]) {
    savedSurface = assistantSurface(changes[surfaceKey].newValue);
    applyAppearance();
    surface.value = savedSurface;
  }
});

$('download-diagnostics').onclick = async () => {
  const button = $<HTMLButtonElement>('download-diagnostics');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const response: Reply<AssistantSnapshot> = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'ASSISTANT_STATUS',
    });
    if (!response?.ok || !response.value)
      throw new Error('Diagnostic status unavailable. Reopen Settings and try again.');
    const [stored, panelResponse] = await Promise.all([
      loadAssistant().catch(() => undefined),
      chrome.runtime
        .sendMessage({ target: 'ui', type: 'MEMO_PRESENTATION_STATUS', windowId })
        .catch(() => undefined),
    ]);
    const report = supportReport(
      response.value,
      chrome.runtime.getManifest().version,
      stored,
      panelResponse?.ok ? (panelResponse.value as MemoPresentation) : undefined,
    );
    const json = JSON.stringify(report, null, 2);
    $('diagnostics-preview').textContent = json;
    $('diagnostics-preview').hidden = false;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'memo-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    feedback(
      'diagnostics-result',
      report.assistant.lastFailure
        ? 'Report downloaded. The latest failure is shown below.'
        : 'Report downloaded. No saved failure was found.',
      'success',
    );
  } catch {
    feedback(
      'diagnostics-result',
      'Could not read diagnostic status. Keep this session saved and retry.',
      'error',
    );
  } finally {
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
};
