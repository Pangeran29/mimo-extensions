import { diagnosticConfig, diagnosticsReady } from '../diagnostics';
import { managedNotesStatus } from '../relay';
import { providerOf, normalizeSettings } from './providers';
import {
  DEFAULT_SETTINGS,
  type AssistantSettings,
  type AssistantAction,
  type AssistantSnapshot,
} from './types';
import { emptyAssistant } from './controller';
import { loadAssistant, recoveredAssistant } from './v2/store';
const origin = 'https://hpop.ai/*';
async function hasRecorder(): Promise<boolean> {
  return (
    (
      await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      })
    ).length > 0
  );
}
async function forward<T>(action: object): Promise<T> {
  await diagnosticsReady;
  const r = await chrome.runtime.sendMessage({
    ...action,
    target: 'recorder',
    diagnostics: diagnosticConfig(),
  });
  if (!r?.ok) throw new Error('Assistant unavailable.');
  return r.value;
}
async function settings(): Promise<AssistantSettings> {
  const { assistantSettings: s } = await chrome.storage.local.get('assistantSettings');
  return normalizeSettings(s);
}
async function trustedKeyStorage(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
}
async function key(): Promise<string> {
  await trustedKeyStorage();
  const saved = (await chrome.storage.local.get('assistantKey')).assistantKey;
  if (typeof saved === 'string' && saved.trim()) return saved;
  // Migrate an existing session key when updating without losing its connection.
  const legacy = (await chrome.storage.session.get('assistantKey')).assistantKey;
  if (typeof legacy !== 'string' || !legacy.trim()) return '';
  await chrome.storage.local.set({ assistantKey: legacy });
  await chrome.storage.session.remove('assistantKey');
  return legacy;
}
async function readiness(s: AssistantSettings): Promise<{
  hasKey: boolean;
  hasAccess: boolean;
  relayStatus?: 'ready' | 'outdated' | 'unavailable';
}> {
  if (providerOf(s) === 'deepinfra') {
    const relayStatus = await managedNotesStatus();
    return { hasKey: relayStatus === 'ready', hasAccess: relayStatus === 'ready', relayStatus };
  }
  return {
    hasKey: !!(await key()),
    hasAccess: await chrome.permissions.contains({ origins: [origin] }),
  };
}
/** Configuration checks only; no paid request or transcript is sent. */
export async function assistantReadiness(): Promise<string[]> {
  const s = await settings();
  const ready = await readiness(s);
  const issues: string[] = [];
  if (!s.enabled) issues.push('Enable AI analysis');
  if (providerOf(s) === 'deepinfra') {
    if (!ready.hasAccess)
      issues.push(
        ready.relayStatus === 'outdated'
          ? 'Restart the managed DeepInfra service with the current server code after recording has stopped'
          : 'Start the managed DeepInfra service',
      );
  } else {
    if (!ready.hasKey) issues.push('Add your HPOP API key');
    if (!ready.hasAccess) issues.push('Grant HPOP access by saving AI settings');
  }
  return issues;
}
export async function initializeAssistant(required = false): Promise<void> {
  const s = await settings();
  const ready = await readiness(s);
  if (required && (!s.enabled || !ready.hasKey || !ready.hasAccess))
    throw Error('AI setup is incomplete.');
  await forward({
    type: 'ASSISTANT_INIT',
    settings: { ...s, enabled: s.enabled && ready.hasKey && ready.hasAccess },
    apiKey: providerOf(s) === 'hpop' && s.enabled && ready.hasAccess ? await key() : undefined,
  });
}
async function connectionStatus(s: AssistantSettings) {
  return {
    settings: s,
    ...(await readiness(s)),
    configured: true,
    hasHpopKey: !!(await key()),
  };
}
let configuring = Promise.resolve<unknown>(undefined);
export async function assistantControl(action: AssistantAction): Promise<unknown> {
  if (action.type === 'ASSISTANT_SETTINGS')
    return {
      ...(await connectionStatus(await settings())),
      configured: !!(await chrome.storage.local.get('assistantSettings')).assistantSettings,
    };
  if (action.type === 'ASSISTANT_DEFAULTS') {
    const task = configuring.then(async () => {
      if (typeof action.goal !== 'string' || action.goal.length > 500)
        throw new Error('Keep the objective within 500 characters.');
      const safe = { ...(await settings()), goal: action.goal.trim() };
      await chrome.storage.local.set({ assistantSettings: safe });
      return connectionStatus(safe);
    });
    configuring = task.catch(() => {});
    return task;
  }
  if (action.type === 'ASSISTANT_CONFIGURE') {
    const task = configuring.then(async () => {
      if (
        action.settings.provider !== undefined &&
        !['hpop', 'deepinfra'].includes(action.settings.provider)
      )
        throw Error('Unknown notes provider.');
      const s = normalizeSettings({
        ...action.settings,
        enabled: action.clearKey ? false : action.settings.enabled,
      });
      if (providerOf(s) !== providerOf(await settings()) && (await hasRecorder())) {
        const live = await forward<{
          phase: string;
          assistantBusy?: boolean;
          transcriptionBusy?: boolean;
        }>({ type: 'STATUS' });
        if (live.phase !== 'idle' || live.assistantBusy || live.transcriptionBusy)
          throw Error('Stop and save the current meeting before changing notes provider.');
      }
      if (typeof s.enabled !== 'boolean' || typeof s.goal !== 'string' || s.goal.length > 500)
        throw new Error('Invalid settings.');
      if (
        action.apiKey !== undefined &&
        (typeof action.apiKey !== 'string' || action.apiKey.length > 512)
      )
        throw new Error('Invalid key.');
      await trustedKeyStorage();
      if (providerOf(s) === 'deepinfra' && (action.clearKey || action.apiKey))
        throw Error('DeepInfra is service-managed; no key entry is needed.');
      if (action.clearKey) {
        await chrome.storage.local.remove('assistantKey');
        await chrome.storage.session.remove('assistantKey');
      } else if (action.apiKey?.trim()) {
        await chrome.storage.local.set({ assistantKey: action.apiKey.trim() });
        await chrome.storage.session.remove('assistantKey');
      }
      const ready = await readiness(s);
      if (s.enabled && (!ready.hasKey || !ready.hasAccess))
        throw Error(
          providerOf(s) === 'deepinfra'
            ? ready.relayStatus === 'outdated'
              ? 'The running DeepInfra relay uses the previous memo protocol. After recording has stopped, restart it with the current server code, then save again.'
              : 'The managed DeepInfra service is unavailable. Start it and save again.'
            : 'Grant HPOP access and supply an API key.',
        );
      const safe: AssistantSettings = {
        provider: providerOf(s),
        enabled: s.enabled,
        model: s.model,
        goal: s.goal.trim(),
        benchmarkPassed: false,
      };
      await chrome.storage.local.set({ assistantSettings: safe });
      let activationWarning: string | undefined;
      try {
        if (await hasRecorder()) await initializeAssistant();
      } catch {
        activationWarning = 'Connection saved. Live AI could not update; retry from the Assistant.';
      }
      return { ...(await connectionStatus(safe)), activationWarning };
    });
    configuring = task.catch(() => {});
    return task;
  }
  if (action.type === 'ASSISTANT_STATUS') {
    if (await hasRecorder()) return forward<AssistantSnapshot>(action);
    const stored = await loadAssistant();
    return stored ? recoveredAssistant(stored) : emptyAssistant(await settings());
  }
  if (await hasRecorder()) {
    if (action.type === 'ASSISTANT_RESUME') await initializeAssistant();
    return forward(action);
  }
  throw new Error('Start a recording to use live AI.');
}
