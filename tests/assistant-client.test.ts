import {
  ANALYSIS_TIMEOUT_MS,
  LIVE_PROPOSAL_TIMEOUT_MS,
  LIVE_REVIEW_TIMEOUT_MS,
  LIVE_V2_REVIEW_TIMEOUT_MS,
  WORKER_REPLY_GRACE_MS,
} from '../src/assistant/timing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantClient } from '../src/assistant/client';
import type { AnalysisInput } from '../src/assistant/types';
class FakeWorker {
  static latest: FakeWorker;
  messages: any[] = [];
  onmessage?: (e: { data: any }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  constructor() {
    FakeWorker.latest = this;
  }
  postMessage(m: any) {
    this.messages.push(m);
  }
  reply(data: any) {
    this.onmessage?.({ data });
  }
}
const input = { sessionId: 'test', version: 4 } as AnalysisInput;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'chrome-extension://test/offscreen.html' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('ignores mismatched session/version replies and accepts the current result', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const p = c.request('ANALYZE', 'gpt-6-luna', input, new AbortController().signal);
  const w = FakeWorker.latest;
  w.reply({ id: 1, sessionId: 'old', version: 4, value: 'stale' });
  w.reply({ id: 1, sessionId: 'test', version: 3, value: 'old-version' });
  w.reply({ id: 1, sessionId: 'test', version: 4, value: 'accepted' });
  await expect(p).resolves.toBe('accepted');
  c.close();
  expect(w.terminate).toHaveBeenCalledOnce();
});
it('bounds stalled worker responses and cancels on stop', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const abort = new AbortController();
  const p = c.request('ANALYZE', 'gpt-6-luna', input, abort.signal);
  const rejected = expect(p).rejects.toMatchObject({ category: 'timeout' });
  abort.abort();
  await rejected;
  expect(FakeWorker.latest.messages.at(-1).type).toBe('CANCEL');
  const stalled = c.request('ANALYZE', 'gpt-6-luna', input, new AbortController().signal);
  const failure = expect(stalled).rejects.toMatchObject({
    category: 'timeout',
  });
  await vi.advanceTimersByTimeAsync(ANALYSIS_TIMEOUT_MS + WORKER_REPLY_GRACE_MS);
  await failure;
  c.close();
});
it('terminates worker memory and rejects pending calls on replacement', async () => {
  const c = new AssistantClient();
  c.init('old-test-key');
  const old = FakeWorker.latest;
  const p = c.request('DEEPER', 'gpt-6-luna', input, new AbortController().signal);
  const rejection = expect(p).rejects.toBeInstanceOf(Error);
  c.init('new-test-key');
  await rejection;
  expect(old.terminate).toHaveBeenCalled();
  expect(FakeWorker.latest.messages[0]).toEqual({
    type: 'INIT',
    key: 'new-test-key',
    diagnostics: { enabled: false, runId: '', policy: 'baseline' },
  });
  c.close();
});

it('accepts a later memo update beyond the former eight-second cutoff', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const first = c.request('ANALYZE', 'claude-sonnet-5-5', input, new AbortController().signal);
  FakeWorker.latest.reply({ id: 1, sessionId: 'test', version: 4, value: 'Initial notes.' });
  await expect(first).resolves.toBe('Initial notes.');
  const secondInput = { ...input, version: 5, previousSummary: 'Initial notes.' };
  const next = c.request('ANALYZE', 'claude-sonnet-5-5', secondInput, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(12000);
  expect(FakeWorker.latest.messages.some((m) => m.type === 'CANCEL')).toBe(false);
  FakeWorker.latest.reply({ id: 2, sessionId: 'test', version: 5, value: 'Revised notes.' });
  await expect(next).resolves.toBe('Revised notes.');
  c.close();
});

it('preserves the safe failure code across the worker boundary', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const pending = c.request('ANALYZE', 'gpt-6-luna', input, new AbortController().signal);
  FakeWorker.latest.reply({
    id: 1,
    sessionId: 'test',
    version: 4,
    error: { status: 0, category: 'format', reason: 'output_truncated', retryAfterMs: 0 },
  });
  await expect(pending).rejects.toMatchObject({ category: 'format', reason: 'output_truncated' });
  c.close();
});

it('retains safe validation details across worker replies', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const pending = c.request('ANALYZE', 'gpt-6-luna', input, new AbortController().signal);
  FakeWorker.latest.reply({
    id: 1,
    sessionId: 'test',
    version: 4,
    error: {
      status: 0,
      category: 'format',
      reason: 'schema_mismatch',
      validationIssues: [
        { field: 'summary', code: 'too_big', limit: 2400, size: 2800, message: 'private' },
      ],
    },
  });
  await expect(pending).rejects.toMatchObject({
    validationIssues: [{ field: 'summary', code: 'too_big', limit: 2400, size: 2800 }],
  });
  c.close();
});

it.each([
  ['PROPOSE', LIVE_PROPOSAL_TIMEOUT_MS, false],
  ['REVIEW', LIVE_REVIEW_TIMEOUT_MS, false],
  ['REVIEW', LIVE_V2_REVIEW_TIMEOUT_MS, true],
] as const)(
  'bounds a stalled %s worker at %sms without cancelling it early (v2=%s)',
  async (type, budget, v2) => {
    const c = new AssistantClient();
    c.init('test-key');
    const requestInput = v2 ? ({ ...input, liveV2Input: { protocol: 2 } } as AnalysisInput) : input;
    const pending = c.request(type, 'gpt-6-luna', requestInput, new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(budget + WORKER_REPLY_GRACE_MS - 1);
    expect(FakeWorker.latest.messages.some((m) => m.type === 'CANCEL')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(FakeWorker.latest.messages.at(-1)).toMatchObject({ type: 'CANCEL', id: 1 });
    c.close();
  },
);

it('Stop cancels a v2 review immediately even within its extended budget', async () => {
  const c = new AssistantClient();
  c.init('test-key');
  const abort = new AbortController();
  const requestInput = { ...input, liveV2Input: { protocol: 2 } } as AnalysisInput;
  const pending = c.request('REVIEW', 'gpt-6-luna', requestInput, abort.signal);
  const failed = expect(pending).rejects.toMatchObject({ category: 'timeout' });
  await vi.advanceTimersByTimeAsync(11_000);
  expect(FakeWorker.latest.messages.some((m) => m.type === 'CANCEL')).toBe(false);
  abort.abort();
  await failed;
  expect(FakeWorker.latest.messages.at(-1)).toMatchObject({ type: 'CANCEL', id: 1 });
  FakeWorker.latest.reply({ id: 1, sessionId: 'test', version: 4, value: 'must stay ignored' });
  c.close();
});
