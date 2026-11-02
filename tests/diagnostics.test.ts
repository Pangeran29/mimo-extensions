import { afterEach, expect, it, vi } from 'vitest';
import {
  configureDiagnostics,
  diagnosticConfig,
  diagnosticNow,
  setDiagnosticSink,
  trace,
} from '../src/diagnostics';
afterEach(() => {
  configureDiagnostics();
  vi.unstubAllGlobals();
});
it('is disabled by default, and disabled evaluation cannot change the policy', () => {
  const sink = vi.fn();
  setDiagnosticSink(sink);
  configureDiagnostics({ enabled: false, policy: 'short-first-note' });
  trace('listen.clicked');
  expect(sink).not.toHaveBeenCalled();
  expect(diagnosticConfig().policy).toBe('baseline');
});
it('emits correlated monotonic timestamps and strips accidental arbitrary fields', () => {
  const sink = vi.fn();
  setDiagnosticSink(sink);
  configureDiagnostics({ enabled: true, runId: 'run', policy: 'short-first-note' });
  const before = diagnosticNow();
  trace('ai.attempt', {
    sessionId: 'session',
    requestId: 'attempt',
    windowId: 2,
    text: 'private',
    key: 'secret',
  } as any);
  const event = sink.mock.calls[0][0];
  expect(event).toMatchObject({
    runId: 'run',
    sessionId: 'session',
    requestId: 'attempt',
    windowId: 2,
  });
  expect(event.at).toBeGreaterThanOrEqual(before);
  expect(event.at).toBeLessThanOrEqual(diagnosticNow());
  expect(event).not.toHaveProperty('text');
  expect(event).not.toHaveProperty('key');
});
it('isolates sink failures from recording and analysis', () => {
  configureDiagnostics({ enabled: true });
  setDiagnosticSink(() => {
    throw Error('Disk full');
  });
  expect(() => trace('capture.started')).not.toThrow();
});

it('allows fixed failure codes and discards arbitrary failure text', () => {
  const sink = vi.fn();
  setDiagnosticSink(sink);
  configureDiagnostics({ enabled: true, runId: 'failure-test' });
  trace('ai.error', { reason: 'output_truncated' });
  trace('ai.error', { reason: 'private response text' } as any);
  expect(sink.mock.calls[0][0].reason).toBe('output_truncated');
  expect(sink.mock.calls[1][0]).not.toHaveProperty('reason');
});
