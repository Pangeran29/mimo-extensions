import 'fake-indexeddb/auto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { LiveMemoController } from '../src/assistant/v2/controller';
import { DEFAULT_SETTINGS, type AnalysisInput } from '../src/assistant/types';
import type { Proposal } from '../src/assistant/v2/types';
import { validateV2 } from '../src/assistant/v2/schema';
import { context, migration } from '../src/assistant/v2/context';
import { saveAssistant, loadAssistant } from '../src/assistant/v2/store';
import { AssistantAPIError } from '../src/assistant/errors';
const topic = { key: 'launch', label: 'Launch proposal', sources: [0] };
const contribution = {
  kind: 'question' as const,
  title: null,
  body: 'Usulan: apakah kapasitas dukungan sudah ditentukan untuk rencana peluncuran ini?',
  sources: [0],
  interpretation: false,
  generalKnowledge: false,
  proposal: true,
};
const proposal = (candidate = false): Proposal => ({
  protocol: 2,
  topic,
  topicChanged: false,
  updates: [
    {
      key: 'date',
      kind: 'proposal',
      topic: 'launch',
      text: 'Peluncuran 23 November diusulkan.',
      sources: [0],
      replaces: null,
    },
  ],
  decision: candidate ? 'candidate' : 'silent',
  reason: 'New proposal.',
  memoUpdate: {
    action: 'replace',
    text: 'Peserta mengusulkan peluncuran pada 23 November.',
    sources: [0],
  },
  candidate: candidate ? contribution : null,
  statusUpdate: null,
});
const verdict = (memo = true, contribution = true, status = true) => ({
  protocol: 2,
  memo: { accept: memo, reason: 'Checked sources.' },
  contribution: { accept: contribution, reason: 'Checked novelty.' },
  status: { accept: status, reason: 'Checked answer evidence.' },
});
const response = (value: unknown) => ({ value, latencyMs: 100, firstTokenMs: 20 });
const transcript = (n: number, sessionId = 's') => ({
  phase: 'transcribing' as const,
  sessionId,
  segments: Array.from({ length: n }, (_, id) => ({
    id,
    sessionId,
    startMs: id * 10000,
    endMs: id * 10000 + 8000,
    text: id ? 'Usulan itu belum diputuskan.' : 'Peluncuran 23 November diusulkan.',
  })),
  incomplete: false,
  lagMs: 0,
  modelReady: true,
});
let run: ReturnType<typeof vi.fn>, c: LiveMemoController;
beforeEach(() => {
  vi.useFakeTimers();
  run = vi.fn(async (type) => response(type === 'PROPOSE' ? proposal() : verdict()));
  c = new LiveMemoController(
    { request: run, close: () => {} },
    () => {},
    async () => {},
  );
  c.configure({ ...DEFAULT_SETTINGS, enabled: true });
});
afterEach(() => {
  c.stopCapture();
  vi.useRealTimers();
});
it('publishes memo without a contribution, keeping provenance and cursor', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo!.text).toContain('mengusulkan');
  expect(c.snapshot.liveV2!.memo!.throughSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.contributions).toHaveLength(0);
  expect(run).toHaveBeenCalledTimes(2);
});
it('can accept a contribution independently of a rejected memo', async () => {
  run.mockImplementation(async (type) =>
    response(type === 'PROPOSE' ? proposal(true) : verdict(false, true, false)),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.liveV2!.contributions).toHaveLength(1);
});
it('retains accepted memo and memory when contribution is rejected', async () => {
  run.mockImplementation(async (type) =>
    response(type === 'PROPOSE' ? proposal(true) : verdict(true, false, false)),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
  expect(c.snapshot.liveV2!.contributions).toHaveLength(0);
  expect(c.snapshot.liveV2!.memory[0].kind).toBe('proposal');
});
it('ambiguous opening waits without guessing a narrative', async () => {
  run.mockResolvedValueOnce(
    response({
      ...proposal(),
      topic: null,
      updates: [],
      decision: 'wait',
      memoUpdate: { action: 'keep', text: null, sources: [] },
    }),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(c.snapshot.summary).toBe('');
});
it('identical memo is a keep, does not re-review or create another revision', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.liveV2!.memo!.id;
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(3);
  expect(c.snapshot.liveV2!.memo!.id).toBe(id);
});
it('topic change retains the active contribution with checked previous-topic status', async () => {
  run.mockImplementation(async (type) => response(type === 'PROPOSE' ? proposal(true) : verdict()));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.liveV2!.activeId;
  run.mockImplementation(async (type) =>
    response(
      type === 'PROPOSE'
        ? {
            ...proposal(),
            topic: { key: 'server', label: 'Server requirements', sources: [1] },
            topicChanged: true,
            memoUpdate: {
              action: 'replace',
              text: 'Peserta membahas kebutuhan server.',
              sources: [1],
            },
          }
        : verdict(),
    ),
  );
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  expect(c.snapshot.liveV2!.activeId).toBe(id);
  expect(c.snapshot.liveV2!.contributions[0].status).toBe('previous_topic');
  expect(c.snapshot.liveV2!.contributions[0].archivedAt).toBeUndefined();
});
it('checked answered/corrected status cannot be downgraded by a later focus change', async () => {
  run.mockImplementation(async (type) => response(type === 'PROPOSE' ? proposal(true) : verdict()));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.liveV2!.activeId!;
  for (const [i, status] of ['answered', 'corrected', 'previous_topic'].entries()) {
    run.mockImplementation(async (type) =>
      response(
        type === 'PROPOSE'
          ? {
              ...proposal(),
              memoUpdate: { action: 'keep', text: null, sources: [] },
              statusUpdate: { contributionId: id, status, sources: [0] },
            }
          : verdict(),
      ),
    );
    c.observe(transcript(i + 2));
    await vi.advanceTimersByTimeAsync(10000);
  }
  expect(c.snapshot.liveV2!.contributions[0].status).toBe('corrected');
});
it('rejecting status preserves its prior label independently of memo acceptance', async () => {
  run.mockImplementation(async (type) => response(type === 'PROPOSE' ? proposal(true) : verdict()));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.liveV2!.activeId!;
  run.mockImplementation(async (type) =>
    response(
      type === 'PROPOSE'
        ? { ...proposal(), statusUpdate: { contributionId: id, status: 'answered', sources: [1] } }
        : verdict(true, false, false),
    ),
  );
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  expect(c.snapshot.liveV2!.contributions[0].status).toBe('relevant');
});
it('component validation rejects oversize/unknown sources without losing valid siblings', () => {
  c.observe(transcript(1));
  const input = context(c.snapshot, transcript(1).segments, '');
  const parsed = validateV2(
    { ...proposal(true), memoUpdate: { action: 'replace', text: 'x'.repeat(601), sources: [0] } },
    input,
  );
  expect(parsed.componentErrors).toEqual(['memo']);
  expect((parsed.value as Proposal).candidate).not.toBeNull();
  const other = validateV2(
    { ...proposal(true), candidate: { ...contribution, sources: [999] } },
    input,
  );
  expect((other.value as Proposal).memoUpdate.action).toBe('replace');
  expect((other.value as Proposal).candidate).toBeNull();
  expect(() => validateV2({ ...proposal(), protocol: 9 }, input)).toThrow();
});
it('new ASR during review fences all public changes while retaining stage-one memory', async () => {
  let resolve!: (v: any) => void;
  run.mockImplementation(async (type) =>
    type === 'PROPOSE' ? response(proposal(true)) : new Promise((r) => (resolve = r)),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  resolve(response(verdict()));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.liveV2!.contributions).toHaveLength(0);
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.memory).toHaveLength(1);
});
it('in-flight feedback and Stop fence output; recovery cannot resume it', async () => {
  run.mockImplementation(async (type) => response(type === 'PROPOSE' ? proposal(true) : verdict()));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const oldMemo = c.snapshot.liveV2!.memo!.id,
    id = c.snapshot.liveV2!.activeId!;
  let resolve!: (v: any) => void;
  run.mockImplementation(async (type) =>
    type === 'PROPOSE'
      ? response({
          ...proposal(),
          memoUpdate: { action: 'replace', text: 'Peserta masih menimbang usulan.', sources: [1] },
        })
      : new Promise((r) => (resolve = r)),
  );
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  c.feedback('s', id, 'dismissed');
  resolve(response(verdict()));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.liveV2!.activeId).toBeNull();
  expect(c.snapshot.liveV2!.memo!.id).toBe(oldMemo);
  c.stopCapture();
  c.observe(transcript(3), true);
  c.resume();
  await vi.advanceTimersByTimeAsync(50000);
  expect(run).toHaveBeenCalledTimes(4);
});
it('fresh session clears both outputs; late old proposal does not reappear', async () => {
  let resolve!: (v: any) => void;
  run.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.stopCapture();
  c.observe(transcript(0, 'next'));
  resolve(response(proposal(true)));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.sessionId).toBe('next');
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.liveV2!.contributions).toHaveLength(0);
});
it('migration copies v1 contributions, never uses their body as a narrative', () => {
  const base = {
    ...c.snapshot,
    liveV2: undefined,
    summary: contribution.body,
    live: {
      protocol: 1 as const,
      topic,
      memory: [],
      contributions: [{ ...contribution, id: 'old', topic: 'launch', createdAt: 1 }],
      activeId: 'old',
      decision: 'candidate' as const,
      closed: false,
      feedbackVersion: 0,
    },
  };
  const migrated = migration(base);
  expect(migrated.liveV2!.memo).toBeNull();
  expect(migrated.liveV2!.contributions[0].body).toBe(contribution.body);
  expect(migrated.liveV2!.closed).toBe(true);
  expect(base.live.contributions[0]).not.toHaveProperty('status');
});
it('loads v1 through copy migration without writing its database', async () => {
  vi.useRealTimers();
  const old = await import('../src/assistant/live-store');
  const v1 = {
    ...c.snapshot,
    liveV2: undefined,
    live: {
      protocol: 1 as const,
      topic,
      memory: [],
      contributions: [{ ...contribution, id: 'saved-v1', topic: 'launch', createdAt: 1 }],
      activeId: 'saved-v1',
      decision: 'candidate' as const,
      closed: true,
      feedbackVersion: 0,
    },
  };
  await old.saveAssistant(v1);
  const loaded = await loadAssistant();
  expect(loaded!.liveV2!.memo).toBeNull();
  expect(loaded!.liveV2!.contributions[0].id).toBe('saved-v1');
  expect((await old.loadAssistant())!.live!.protocol).toBe(1);
});
it('v2 storage persists the independent state in its own database', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
  await saveAssistant(c.snapshot);
  const saved = await loadAssistant();
  expect(saved!.liveV2!.memo!.text).toContain('November');
  expect(saved!.liveV2!.protocol).toBe(2);
});
it('storage failure leaves recording-independent controller usable and stoppable', async () => {
  c = new LiveMemoController(
    { request: run, close: () => {} },
    () => {},
    async () => {
      throw Error('quota');
    },
  );
  c.configure({ ...DEFAULT_SETTINGS, enabled: true });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
  c.stopCapture();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.liveV2!.closed).toBe(true);
  expect(c.snapshot.analysisError).toContain('could not be saved');
});

it('v2 keeps bounded deadline retries and ignores results after timeout', async () => {
  run.mockImplementation(
    (_t, _m, _i, signal) =>
      new Promise((_r, reject) =>
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
      ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(100000);
  expect(run).toHaveBeenCalledTimes(3);
  expect(c.snapshot.phase).toBe('paused');
  expect(c.snapshot.liveV2!.memo).toBeNull();
});

it('retries a failed review in silence without replaying stage one or its memory commit', async () => {
  let reviews = 0;
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    if (++reviews === 1) throw new AssistantAPIError(503);
    return response(verdict());
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.memory).toHaveLength(1);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.busy).toBe(true);
  expect(c.snapshot.lastFailure).toMatchObject({
    requestId: run.mock.calls[1][2].requestId,
    status: 503,
    category: 'request',
    count: 1,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW', 'REVIEW']);
  expect(c.snapshot.liveV2!.memo!.id).toBe(run.mock.calls[0][2].requestId + ':memo');
  expect(c.snapshot.liveV2!.memory).toHaveLength(1);
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.version).toBe(1);
  expect(c.snapshot.analysisError).toBeUndefined();
});

it('bounds repeated review failures across fresh proposals and resumes the pending review', async () => {
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    throw new AssistantAPIError(503);
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  c.observe(transcript(3));
  await vi.advanceTimersByTimeAsync(10000);
  expect(c.snapshot.phase).toBe('paused');
  expect(c.snapshot.lastFailure).toMatchObject({ status: 503, count: 3 });
  expect(c.snapshot.retryAt).toBeUndefined();
  expect(run.mock.calls.map(([type]) => type)).toEqual([
    'PROPOSE',
    'REVIEW',
    'PROPOSE',
    'REVIEW',
    'PROPOSE',
    'REVIEW',
  ]);
  run.mockResolvedValue(response(verdict()));
  c.resume();
  await vi.advanceTimersByTimeAsync(10000);
  expect(run.mock.calls.at(-1)![0]).toBe('REVIEW');
  expect(run.mock.calls.filter(([type]) => type === 'PROPOSE')).toHaveLength(3);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
});

it('honors Retry-After before retrying a review whose memory cursor is already committed', async () => {
  let reviews = 0;
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    if (++reviews === 1) throw new AssistantAPIError(503, 45000);
    return response(verdict());
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(44999);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW', 'REVIEW']);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
});

it('manual resume still honors Retry-After returned by the final automatic review attempt', async () => {
  let reviews = 0;
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    if (++reviews <= 3) throw new AssistantAPIError(503, reviews === 3 ? 60000 : 0);
    return response(verdict());
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(13000);
  expect(c.snapshot.phase).toBe('paused');
  expect(run).toHaveBeenCalledTimes(4);
  c.resume();
  await vi.advanceTimersByTimeAsync(59999);
  expect(run).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.mock.calls.map(([type]) => type)).toEqual([
    'PROPOSE',
    'REVIEW',
    'REVIEW',
    'REVIEW',
    'REVIEW',
  ]);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
});

it('bounds review timeout retries without repeating stage-one work', async () => {
  run.mockImplementation((type, _model, _input, signal) =>
    type === 'PROPOSE'
      ? Promise.resolve(response(proposal()))
      : new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
        ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(60000);
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW', 'REVIEW', 'REVIEW']);
  expect(c.snapshot.phase).toBe('paused');
  expect(c.snapshot.lastFailure).toMatchObject({ category: 'timeout', count: 3 });
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.memo).toBeNull();
});

it('accepts a valid v2 review that completes at twelve seconds without replaying stage one', async () => {
  run.mockImplementation((type, _model, _input, signal) =>
    type === 'PROPOSE'
      ? Promise.resolve(response(proposal()))
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(response(verdict())), 12000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('timeout'));
            },
            { once: true },
          );
        }),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(11999);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(run.mock.calls[1][3].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
  expect(c.snapshot.analysisError).toBeUndefined();
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW']);
});

it('aborts an unfinished v2 review at fifteen seconds and backs off without losing memory', async () => {
  run.mockImplementation((type, _model, _input, signal) =>
    type === 'PROPOSE'
      ? Promise.resolve(response(proposal()))
      : new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
        ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const signal = run.mock.calls[1][3];
  await vi.advanceTimersByTimeAsync(14999);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  expect(c.snapshot.lastFailure).toMatchObject({ category: 'timeout', count: 1 });
  expect(c.snapshot.retryAt).toBe(Date.now() + 4000);
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.memory).toHaveLength(1);
  c.stopCapture();
  await vi.advanceTimersByTimeAsync(4000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(c.snapshot.liveV2!.memo).toBeNull();
});

it('Stop aborts a v2 review immediately without waiting for its fifteen-second deadline', async () => {
  run.mockImplementation((type, _model, _input, signal) =>
    type === 'PROPOSE'
      ? Promise.resolve(response(proposal()))
      : new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
        ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const signal = run.mock.calls[1][3];
  await vi.advanceTimersByTimeAsync(2000);
  c.stopCapture();
  expect(signal.aborted).toBe(true);
  expect(c.snapshot.liveV2!.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(15000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.analysisError).toBeUndefined();
});

it('retains a pending review after an invalid review envelope, but never publishes it unchecked', async () => {
  let reviews = 0;
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    return response(++reviews === 1 ? { ...verdict(), protocol: 99 } : verdict());
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.lastSegmentId).toBe(0);
  await vi.advanceTimersByTimeAsync(4000);
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW', 'REVIEW']);
  expect(c.snapshot.liveV2!.memo).not.toBeNull();
});

it('new ASR fences an in-flight review retry and starts a fresh proposal from the memory cursor', async () => {
  let reviews = 0;
  let resolve!: (v: any) => void;
  run.mockImplementation(async (type, _model, input) => {
    if (type === 'PROPOSE')
      return response(
        input.newSegmentIds.includes(1)
          ? {
              ...proposal(),
              memoUpdate: { action: 'replace', text: 'Usulan baru masih dibahas.', sources: [1] },
            }
          : proposal(),
      );
    if (++reviews === 1) throw new AssistantAPIError(503);
    if (reviews === 2) return new Promise((r) => (resolve = r));
    return response(verdict());
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(4000);
  expect(run.mock.calls.map(([type]) => type)).toEqual(['PROPOSE', 'REVIEW', 'REVIEW']);
  c.observe(transcript(2));
  resolve(response(verdict()));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.snapshot.lastSegmentId).toBe(0);
  await vi.advanceTimersByTimeAsync(6000);
  expect(run.mock.calls.map(([type]) => type)).toEqual([
    'PROPOSE',
    'REVIEW',
    'REVIEW',
    'PROPOSE',
    'REVIEW',
  ]);
  expect(run.mock.calls[3][2].newSegmentIds).toEqual([1]);
  expect(c.snapshot.liveV2!.memo!.text).toBe('Usulan baru masih dibahas.');
});

it('feedback invalidates a queued review retry without reviving the dismissed contribution', async () => {
  run.mockImplementation(async (type) => response(type === 'PROPOSE' ? proposal(true) : verdict()));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.liveV2!.activeId!;
  const memo = c.snapshot.liveV2!.memo!.id;
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE')
      return response({
        ...proposal(),
        memoUpdate: { action: 'replace', text: 'Peserta masih menimbang usulan.', sources: [1] },
      });
    throw new AssistantAPIError(503);
  });
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  expect(c.snapshot.retryAt).toBeGreaterThan(Date.now());
  c.feedback('s', id, 'dismissed');
  await vi.advanceTimersByTimeAsync(60000);
  expect(run).toHaveBeenCalledTimes(4);
  expect(c.snapshot.liveV2!.activeId).toBeNull();
  expect(c.snapshot.liveV2!.memo!.id).toBe(memo);
  expect(c.snapshot.lastSegmentId).toBe(1);
  expect(c.snapshot.retryAt).toBeUndefined();
  expect(c.busy).toBe(false);
});

it('Stop cancels a queued review retry while keeping the validated memory commit', async () => {
  run.mockImplementation(async (type) => {
    if (type === 'PROPOSE') return response(proposal());
    throw new AssistantAPIError(503);
  });
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.busy).toBe(true);
  c.stopCapture();
  c.resume();
  await vi.advanceTimersByTimeAsync(60000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(c.snapshot.liveV2!.memory).toHaveLength(1);
  expect(c.snapshot.lastSegmentId).toBe(0);
  expect(c.snapshot.liveV2!.memo).toBeNull();
  expect(c.busy).toBe(false);
});

it('grounded memo may be published before a canonical topic key is established', async () => {
  run.mockImplementation(async (type) =>
    response(type === 'PROPOSE' ? { ...proposal(), topic: null } : verdict(true, false, false)),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.liveV2!.memo!.text).toContain('November');
  expect(c.snapshot.liveV2!.memo!.topic).toBeNull();
});
it('rejects participant-selection claims inferred from an ambiguous no-decision statement', () => {
  c.observe(transcript(2));
  const all = transcript(2).segments;
  all[1].text = 'Belum ada keputusan peserta.';
  const input = context(c.snapshot, all, '');
  const parsed = validateV2(
    {
      ...proposal(true),
      memoUpdate: {
        action: 'replace',
        text: 'Acara diusulkan pada 23 November. Keputusan mengenai peserta belum dibuat.',
        sources: [0, 1],
      },
    },
    input,
  );
  expect(parsed.componentErrors).toContain('memo');
  expect((parsed.value as Proposal).candidate).not.toBeNull();
});
it('an explanation cannot be marked answered by a new participant question', () => {
  c.observe(transcript(1));
  c.snapshot.liveV2!.contributions = [
    {
      ...contribution,
      kind: 'explanation',
      id: 'explain',
      topic: 'launch',
      createdAt: 1,
      status: 'relevant',
      statusSources: [0],
    },
  ];
  c.snapshot.liveV2!.activeId = 'explain';
  const input = context(c.snapshot, transcript(1).segments, '');
  const parsed = validateV2(
    {
      ...proposal(),
      statusUpdate: { contributionId: 'explain', status: 'answered', sources: [0] },
    },
    input,
  );
  expect(parsed.componentErrors).toContain('status');
});
