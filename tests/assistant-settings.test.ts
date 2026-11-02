import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assistantControl, initializeAssistant, initializeEndConnection } from '../src/assistant/settings';
import { DEFAULT_SETTINGS } from '../src/assistant/types';
let local: Record<string, unknown>,
  session: Record<string, unknown>,
  send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  local = {};
  session = {};
  send = vi.fn().mockResolvedValue({ ok: true, value: { phase: 'listening' } });
  vi.stubGlobal('chrome', {
    runtime: {
      getContexts: async () => [{}],
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      sendMessage: send,
    },
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async (k: string) => ({ [k]: local[k] }),
        set: async (v: object) => Object.assign(local, v),
        remove: async (k: string) => {
          delete local[k];
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: async (k: string) => ({ [k]: session[k] }),
        set: async (v: object) => Object.assign(session, v),
        remove: async (k: string) => {
          delete session[k];
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});
it('forces the recorder destination when forwarding a UI action', async () => {
  await assistantControl({ target: 'worker', type: 'ASSISTANT_STATUS' } as any);
  expect(send.mock.calls[0][0].target).toBe('recorder');
});
it('restores a saved meeting provider without replacing the current live connection settings', async () => {
  const current={...DEFAULT_SETTINGS,provider:'deepinfra' as const,enabled:true};
  local.assistantSettings=current;
  local.assistantKey='saved-hpop-test-key';
  await initializeEndConnection({...DEFAULT_SETTINGS,provider:'hpop',enabled:true});
  expect(local.assistantSettings).toBe(current);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    target:'recorder',type:'END_CONFIGURE',apiKey:'saved-hpop-test-key',settings:expect.objectContaining({provider:'hpop'}),
  }));
  expect(send.mock.calls.some(([message])=>message.type==='ASSISTANT_INIT')).toBe(false);
});
it('keeps keys in trusted local storage across reloads and out of returned settings', async () => {
  const r = await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: { ...DEFAULT_SETTINGS, enabled: true },
    apiKey: 'test-only-secret',
  });
  expect(local.assistantKey).toBe('test-only-secret');
  expect(session.assistantKey).toBeUndefined();
  expect(JSON.stringify(r)).not.toContain('test-only-secret');
  expect(chrome.storage.local.setAccessLevel as any).toHaveBeenCalledWith({
    accessLevel: 'TRUSTED_CONTEXTS',
  });
  expect(send.mock.calls[0][0].type).toBe('ASSISTANT_INIT');
});
it('disables AI on initialization when no credentials have been saved', async () => {
  local.assistantSettings = { ...DEFAULT_SETTINGS, enabled: true };
  await initializeAssistant();
  expect(send.mock.calls[0][0].settings.enabled).toBe(false);
  expect(send.mock.calls[0][0].apiKey).toBe('');
});
it('removes credentials and disables live AI on explicit clear', async () => {
  local.assistantKey = 'test-key';
  session.assistantKey = 'legacy-test-key';
  await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: DEFAULT_SETTINGS,
    clearKey: true,
  });
  expect(session.assistantKey).toBeUndefined();
  expect(local.assistantKey).toBeUndefined();
  expect(send.mock.calls[0][0].settings.enabled).toBe(false);
});
it('saves future meeting defaults without requiring or enabling AI', async () => {
  local.assistantSettings = { ...DEFAULT_SETTINGS, model: 'qwen3.7-plus' };
  const r = (await assistantControl({
    type: 'ASSISTANT_DEFAULTS',
    goal: '  Decide an owner.  ',
  })) as any;
  expect(r.settings).toMatchObject({
    enabled: false,
    model: 'claude-sonnet-5-5',
    goal: 'Decide an owner.',
  });
  expect(send).not.toHaveBeenCalled();
  expect(session.assistantKey).toBeUndefined();
});
it('reports persisted settings separately from live activation failure', async () => {
  send.mockResolvedValue({ ok: false, error: 'Recorder unavailable' });
  const r = (await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: { ...DEFAULT_SETTINGS, enabled: true },
    apiKey: 'test-only-key',
  })) as any;
  expect(local.assistantSettings).toMatchObject({ enabled: true });
  expect(r.activationWarning).toContain('Connection saved');
  expect(r.hasAccess).toBe(true);
});
it('reports revoked provider permission without exposing the saved key', async () => {
  session.assistantKey = 'test-only-key';
  (chrome.permissions.contains as any) = async () => false;
  const r = (await assistantControl({ type: 'ASSISTANT_SETTINGS' })) as any;
  expect(r.hasAccess).toBe(false);
  expect(r.hasKey).toBe(true);
  expect(JSON.stringify(r)).not.toContain('test-only-key');
});

it('uses Sonnet for legacy saved model selections without asking the user to choose again', async () => {
  local.assistantSettings = { ...DEFAULT_SETTINGS, enabled: true, model: 'qwen3.7-plus' };
  session.assistantKey = 'test-key';
  const result = (await assistantControl({ type: 'ASSISTANT_SETTINGS' })) as any;
  expect(result.settings.model).toBe('claude-sonnet-5-5');
  await initializeAssistant(true);
  expect(send.mock.calls[0][0].settings.model).toBe('claude-sonnet-5-5');
});
it('keeps the model controlled internally when saving a connection', async () => {
  await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: { ...DEFAULT_SETTINGS, enabled: true, model: 'gpt-6-luna' },
    apiKey: 'test-key',
  });
  expect(local.assistantSettings).toMatchObject({ model: 'claude-sonnet-5-5' });
  expect(send.mock.calls[0][0].settings.model).toBe('claude-sonnet-5-5');
});

it('restores a saved AI connection after session storage is cleared by reload', async () => {
  await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: { ...DEFAULT_SETTINGS, enabled: true },
    apiKey: 'persistent-test-key',
  });
  session = {};
  send.mockClear();
  await initializeAssistant(true);
  expect(send.mock.calls[0][0]).toMatchObject({
    apiKey: 'persistent-test-key',
    settings: { enabled: true },
  });
  const returned = await assistantControl({ type: 'ASSISTANT_SETTINGS' });
  expect(returned).toMatchObject({ hasKey: true });
  expect(JSON.stringify(returned)).not.toContain('persistent-test-key');
});
it('migrates an available legacy session key once without returning its value', async () => {
  session.assistantKey = 'legacy-test-key';
  const returned = await assistantControl({ type: 'ASSISTANT_SETTINGS' });
  expect(local.assistantKey).toBe('legacy-test-key');
  expect(session.assistantKey).toBeUndefined();
  expect(JSON.stringify(returned)).not.toContain('legacy-test-key');
});

afterEach(() => vi.unstubAllGlobals());

it('selects managed DeepInfra without an HPOP key and does not forward the provider key', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            notes: {
              configured: true,
              liveMemoProtocol: 1,
              supportedLiveMemoProtocols: [1, 2],
              model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
            },
          }),
        ),
    ),
  );
  local.assistantSettings = { ...DEFAULT_SETTINGS, enabled: true };
  send.mockImplementation(async (m: any) => ({
    ok: true,
    value: m.type === 'STATUS' ? { phase: 'idle', retained: [] } : { phase: 'ready' },
  }));
  const result = (await assistantControl({
    type: 'ASSISTANT_CONFIGURE',
    settings: { ...DEFAULT_SETTINGS, enabled: true, provider: 'deepinfra' },
  })) as any;
  expect(result.settings.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash-1017');
  expect(result.hasKey).toBe(true);
  expect(local.assistantKey).toBeUndefined();
  const initialized = send.mock.calls.find(([m]) => m.type === 'ASSISTANT_INIT')![0];
  expect(initialized.settings.provider).toBe('deepinfra');
  expect(initialized.apiKey).toBeUndefined();
});
it('blocks provider switching during a live meeting before changing settings or the saved HPOP key', async () => {
  local.assistantKey = 'existing-hpop';
  local.assistantSettings = { ...DEFAULT_SETTINGS, enabled: true };
  send.mockResolvedValue({ ok: true, value: { phase: 'recording' } });
  await expect(
    assistantControl({
      type: 'ASSISTANT_CONFIGURE',
      settings: { ...DEFAULT_SETTINGS, enabled: true, provider: 'deepinfra' },
    }),
  ).rejects.toThrow('Stop and save');
  expect(local.assistantKey).toBe('existing-hpop');
  expect((local.assistantSettings as any).provider).toBe('hpop');
});
it('detects an old running relay and tells the user to restart outside recording', async () => {
  local.assistantSettings = { ...DEFAULT_SETTINGS, provider: 'deepinfra' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ notes: { configured: true, model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' } }),
    ),
  );
  await expect(
    assistantControl({
      type: 'ASSISTANT_CONFIGURE',
      settings: { ...DEFAULT_SETTINGS, enabled: true, provider: 'deepinfra' },
    }),
  ).rejects.toThrow('previous memo protocol');
});
