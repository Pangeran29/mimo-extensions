import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/assistant/types';
import { panelViewKey, setupWarningKey } from '../src/panel';
let handler: any;
let local: Record<string, any>;
let session: Record<string, any>;
let permission: boolean;
let microphone: boolean;
let model: boolean;
let busy: boolean;
let send: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  local = {
    microphoneReady: true,
    transcriptionEnabled: true,
    assistantSettings: { ...DEFAULT_SETTINGS, enabled: true },
  };
  session = { assistantKey: 'test-key' };
  permission = true;
  microphone = true;
  model = true;
  busy = false;
  send = vi.fn(async (msg: any) => {
    if (msg.target === 'ui') return;
    if (msg.type === 'CHECK_MICROPHONE')
      return microphone
        ? { ok: true, value: { ready: true } }
        : { ok: false, error: 'No microphone' };
    if (msg.type === 'PREPARE_TRANSCRIPTION')
      return { ok: true, value: { modelReady: model, phase: model ? 'ready' : 'failed' } };
    if (msg.type === 'START') return { ok: true, value: { phase: 'recording', retained: [] } };
    return { ok: true, value: { phase: 'idle', retained: [], transcriptionBusy: busy } };
  });
  capture = vi.fn((_opts, callback) => callback('capture-token'));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      ContextType: { OFFSCREEN_DOCUMENT: 'offscreen' },
      getContexts: async () => [{}],
      sendMessage: send,
      onMessage: {
        addListener: (fn: any) => {
          handler = fn;
        },
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: async () => local,
        set: async (v: any) => Object.assign(local, v),
        remove: async (k: string) => {
          delete local[k];
        },
        setAccessLevel: async () => {},
      },
      session: {
        get: async () => session,
        set: async (v: any) => Object.assign(session, v),
        setAccessLevel: async () => {},
        remove: async (k: string) => {
          delete session[k];
        },
      },
    },
    permissions: { contains: async () => permission },
    tabs: {
      get: async () => ({
        id: 1,
        windowId: 7,
        active: true,
        url: 'https://example.com',
        title: 'Meeting',
      }),
    },
    tabCapture: { getMediaStreamId: capture },
    downloads: { onChanged: { addListener: vi.fn() } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  });
  vi.resetModules();
  await import('../src/worker');
});
afterEach(() => vi.unstubAllGlobals());
const start = () =>
  new Promise<any>((resolve) =>
    handler(
      { target: 'worker', type: 'START', tabId: 1, title: 'Meeting' },
      { id: 'test' },
      resolve,
    ),
  );
async function blocked(expected: string) {
  const r = await start();
  expect(r.ok).toBe(false);
  expect(r.error).toContain(expected);
  expect(session[panelViewKey(7)]).toBe('settings');
  expect(session[setupWarningKey(7)]).toContain(expected);
  expect(capture).not.toHaveBeenCalled();
  expect(send.mock.calls.some(([msg]) => msg.type === 'START')).toBe(false);
}
it('starts only after all checks and clears the previous warning', async () => {
  session[setupWarningKey(7)] = 'Old failure';
  expect((await start()).ok).toBe(true);
  expect(
    send.mock.calls.filter(([msg]) => msg.target === 'recorder').map(([msg]) => msg.type),
  ).toEqual(['STATUS', 'CHECK_MICROPHONE', 'PREPARE_TRANSCRIPTION', 'ASSISTANT_INIT', 'START']);
  expect(capture).toHaveBeenCalledOnce();
  expect(session[setupWarningKey(7)]).toBeUndefined();
});
it('lists missing setup and does not start any microphone/model work', async () => {
  local.microphoneReady = false;
  local.transcriptionEnabled = false;
  local.assistantSettings.enabled = false;
  delete session.assistantKey;
  await blocked('Allow microphone');
  expect(session[setupWarningKey(7)]).toContain('Enable AI');
  expect(session[setupWarningKey(7)]).not.toContain('Prepare local transcription');
  expect(send.mock.calls.some(([msg]) => msg.type === 'CHECK_MICROPHONE')).toBe(false);
});
it('blocks when no key was ever saved', async () => {
  delete session.assistantKey;
  await blocked('API key');
});
it('requires AI to be enabled', async () => {
  local.assistantSettings.enabled = false;
  await blocked('Enable AI');
});
it('uses the internal default instead of blocking on an obsolete saved model', async () => {
  local.assistantSettings.model = 'unknown';
  const reply = await start();
  expect(reply.ok).toBe(true);
  expect(
    send.mock.calls.find(([message]) => message.type === 'ASSISTANT_INIT')?.[0].settings.model,
  ).toBe('claude-sonnet-5-5');
});
it('requires HPOP host permission', async () => {
  permission = false;
  await blocked('Grant HPOP');
});
it('detects hardware loss even with a persisted microphone permission', async () => {
  microphone = false;
  await blocked('Microphone unavailable');
  expect(local.microphoneReady).toBe(false);
});
it('rejects a speech model that cannot prepare', async () => {
  model = false;
  await blocked('Speech detection could not start');
});
it('does not trust cached readiness when preparing the model throws', async () => {
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (msg: any) => {
    if (msg.type === 'PREPARE_TRANSCRIPTION') throw Error('Cache evicted');
    return original(msg);
  });
  await blocked('Speech detection could not start');
});
it('does not interfere with finishing an existing session', async () => {
  busy = true;
  const r = await start();
  expect(r.ok).toBe(false);
  expect(session[panelViewKey(7)]).toBeUndefined();
  expect(capture).not.toHaveBeenCalled();
});

it('rechecks AI when settings change during model preparation', async () => {
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (msg: any) => {
    if (msg.type === 'PREPARE_TRANSCRIPTION') local.assistantSettings.enabled = false;
    return original(msg);
  });
  await blocked('AI could not initialize');
});

it('preserves the recorder failure instead of blaming completed settings', async () => {
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (msg: any) =>
    msg.type === 'START' ? { ok: false, error: 'Wait until AI has finished.' } : original(msg),
  );
  const reply = await start();
  expect(reply.ok).toBe(false);
  expect(reply.error).toBe('Session could not start. Wait until AI has finished.');
  expect(session[setupWarningKey(7)]).toBe(reply.error);
});
