import { afterEach, expect, it, vi } from 'vitest';
import { appendDiagnostic, TRACE_KEY } from '../src/diagnostic-store';
afterEach(() => vi.unstubAllGlobals());
it('serializes writes, bounds storage, and strips unexpected payloads', async () => {
  let saved: any = {
    runId: 'run',
    dropped: 0,
    events: Array.from({ length: 10000 }, () => ({ name: 'ai.queued', at: 1, runId: 'run' })),
  };
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async () => ({
          listenDiagnostics: { enabled: true, runId: 'run' },
          [TRACE_KEY]: structuredClone(saved),
        }),
        set: async (value: any) => {
          saved = value[TRACE_KEY];
        },
      },
    },
  });
  await Promise.all([
    appendDiagnostic({ name: 'asr.started', at: 2, runId: 'run', text: 'private' } as any),
    appendDiagnostic({ name: 'asr.complete', at: 3, runId: 'run' }),
  ]);
  expect(saved.events).toHaveLength(10000);
  expect(saved.dropped).toBe(2);
  expect(saved.events.slice(-2).map((e: any) => e.name)).toEqual(['asr.started', 'asr.complete']);
  expect(saved.events.at(-2)).not.toHaveProperty('text');
});
it('ignores disabled, obsolete, and malformed events', async () => {
  const set = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      session: { get: async () => ({ listenDiagnostics: { enabled: false, runId: 'run' } }), set },
    },
  });
  await appendDiagnostic({ name: 'ai.queued', at: 1, runId: 'run' });
  await appendDiagnostic({ name: 'private transcript', at: 1, runId: 'run' });
  expect(set).not.toHaveBeenCalled();
});
