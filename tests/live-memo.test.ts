import 'fake-indexeddb/auto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { LiveMemoController } from '../src/assistant/live-controller';
import { DEFAULT_SETTINGS, type AnalysisInput } from '../src/assistant/types';
import { AssistantAPIError } from '../src/assistant/errors';
import { validateLive } from '../src/assistant/live-schema';
import { liveContext, estimateTokens } from '../src/assistant/live-context';
import { saveAssistant as saveLegacy, loadAssistant as loadLegacy } from '../src/assistant/store';
import { saveAssistant, loadAssistant, recoveredAssistant } from '../src/assistant/live-store';
import type { LiveProposal } from '../src/assistant/live-types';
const segment = (id: number, text = 'Peserta mengusulkan peluncuran pada 23 November.') => ({
  id,
  sessionId: 's',
  startMs: id * 10000,
  endMs: id * 10000 + 8000,
  text,
});
const transcript = (n: number, sessionId = 's') => ({
  phase: 'transcribing' as const,
  sessionId,
  segments: Array.from({ length: n }, (_, i) => ({ ...segment(i), sessionId })),
  incomplete: false,
  lagMs: 0,
  modelReady: true,
});
const candidate = {
  kind: 'question' as const,
  title: null,
  body: 'Usulan: apakah kapasitas dukungan sudah cukup untuk peluncuran pada tanggal yang dibahas?',
  sources: [0],
  interpretation: false,
  generalKnowledge: false,
  proposal: true,
};
const proposal = (decision: LiveProposal['decision'] = 'candidate'): LiveProposal => ({
  protocol: 1,
  topic: { key: 'launch', label: 'Peluncuran', sources: [0] },
  topicChanged: false,
  updates: [
    {
      key: 'date',
      kind: 'proposal',
      topic: 'launch',
      text: '23 November diusulkan.',
      sources: [0],
      replaces: null,
    },
  ],
  decision,
  reason: 'An unresolved support constraint affects the plan.',
  candidate: decision === 'candidate' ? candidate : null,
});
const result = (value: unknown) => ({ value, latencyMs: 100, firstTokenMs: 20 });
let run: ReturnType<typeof vi.fn>, c: LiveMemoController;
beforeEach(() => {
  vi.useFakeTimers();
  run = vi.fn(async (type) =>
    result(
      type === 'PROPOSE'
        ? proposal()
        : { protocol: 1, accept: true, reason: 'Relevant unanswered question.' },
    ),
  );
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
it('wait and silent advance context with no visible output or second request', async () => {
  for (const decision of ['wait', 'silent'] as const) {
    run.mockResolvedValueOnce(
      result({ ...proposal(decision), topic: decision === 'wait' ? null : proposal().topic }),
    );
    c.observe(transcript(decision === 'wait' ? 1 : 2));
    await vi.advanceTimersByTimeAsync(decision === 'wait' ? 1000 : 10000);
    expect(c.snapshot.summary).toBe('');
    expect(c.snapshot.live!.decision).toBe(decision);
  }
  expect(run.mock.calls.map((a) => a[0])).toEqual(['PROPOSE', 'PROPOSE']);
  expect(c.snapshot.lastSegmentId).toBe(1);
});
it('displays only an accepted candidate; rejection still saves source-linked memory', async () => {
  run.mockImplementation(async (type) =>
    result(
      type === 'PROPOSE' ? proposal() : { protocol: 1, accept: false, reason: 'Already asked.' },
    ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.snapshot.summary).toBe('');
  expect(c.snapshot.live!.memory[0].text).toContain('November');
  expect(c.snapshot.lastSegmentId).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(run).toHaveBeenCalledTimes(2);
});
it('one chain coalesces arrivals and enforces minimum ten second start interval', async () => {
  let done!: (v: any) => void;
  run.mockImplementationOnce(() => new Promise((r) => (done = r)));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run).toHaveBeenCalledTimes(1);
  done(result(proposal('silent')));
  await vi.advanceTimersByTimeAsync(7999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.mock.calls[1][0]).toBe('PROPOSE');
});
it('A to B to C archives old contributions and does not resurrect them on returning to A', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const first = c.snapshot.live!.activeId;
  expect(first).toBeTruthy();
  for (const topic of ['B', 'C', 'launch']) {
    run.mockResolvedValueOnce(
      result({
        ...proposal('silent'),
        topic: { key: topic, label: topic, sources: [0] },
        topicChanged: true,
      }),
    );
    c.observe(transcript(c.snapshot.lastSegmentId + 2));
    await vi.advanceTimersByTimeAsync(10000);
    expect(c.snapshot.live!.activeId).toBeNull();
  }
  expect(c.snapshot.live!.contributions[0].archivedReason).toBe('topic');
});
it('new transcript during review discards candidate without advancing memory cursor past stage one', async () => {
  let done!: (v: any) => void;
  run.mockImplementation(async (type) =>
    type === 'PROPOSE' ? result(proposal()) : new Promise((r) => (done = r)),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  done(result({ protocol: 1, accept: true, reason: 'Accept' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.summary).toBe('');
  expect(c.snapshot.lastSegmentId).toBe(0);
});
it('feedback during review fences its result, including dismissal of the prior active item', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const id = c.snapshot.live!.activeId!;
  let done!: (v: any) => void;
  run.mockImplementation(async (type) =>
    type === 'PROPOSE' ? result(proposal()) : new Promise((r) => (done = r)),
  );
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  c.feedback('s', id, 'dismissed');
  done(result({ protocol: 1, accept: true, reason: 'Accept' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.summary).toBe('');
  expect(c.snapshot.live!.contributions).toHaveLength(1);
});
it('Stop, recovery and a new session fence late output', async () => {
  let done!: (v: any) => void;
  run.mockImplementationOnce(() => new Promise((r) => (done = r)));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.stopCapture();
  done(result(proposal()));
  await vi.advanceTimersByTimeAsync(0);
  c.observe(transcript(2), true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(c.snapshot.summary).toBe('');
  c.observe(transcript(0, 'new'));
  expect(c.snapshot.sessionId).toBe('new');
  expect(c.snapshot.live!.memory).toHaveLength(0);
});
it('restored closed state never resumes automatic work', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  const saved = structuredClone(c.snapshot);
  c.restore(saved);
  c.observe(transcript(2), true);
  c.resume();
  await vi.advanceTimersByTimeAsync(30000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(c.snapshot.live!.closed).toBe(true);
});
it('rejects invalid schema, unknown evidence and oversized output without truncation', () => {
  c.observe(transcript(1));
  const input = liveContext(c.snapshot, [segment(0)], '');
  for (const value of [
    { ...proposal(), candidate: { ...candidate, body: 'x'.repeat(1201) } },
    { ...proposal(), candidate: { ...candidate, sources: [999] } },
    { ...proposal(), decision: 'silent' },
  ])
    expect(() => validateLive(value, input)).toThrow();
  expect(() =>
    validateLive({ protocol: 1, accept: true, reason: 'ok', candidate }, input, true),
  ).toThrow();
});
it('recalls old constraints only with source quotes and stays within the recall budget', () => {
  c.observe(transcript(1));
  c.snapshot.live!.topic = proposal().topic;
  c.snapshot.live!.memory = [
    {
      ...proposal().updates[0],
      kind: 'constraint',
      text: 'Peluncuran dibatasi kapasitas dukungan.',
    },
  ];
  const input = liveContext(
    c.snapshot,
    [segment(0), segment(20, 'Kapasitas dukungan berdampak pada peluncuran ini.')],
    'Help',
  );
  expect(input.liveInput!.recalled[0].quotes[0].id).toBe(0);
  expect(estimateTokens(input.liveInput!.recalled)).toBeLessThanOrEqual(1500);
});
it('correction replaces the older interpretation, preserves November and proposal provenance', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  run.mockResolvedValueOnce(
    result({
      ...proposal('silent'),
      updates: [
        {
          ...proposal().updates[0],
          key: 'correct-date',
          kind: 'correction',
          replaces: 'date',
          text: 'Tetap 23 November, bukan Desember.',
        },
      ],
    }),
  );
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(10000);
  expect(c.snapshot.live!.memory).toHaveLength(1);
  expect(c.snapshot.live!.memory[0].text).toContain('23 November');
});
it('storage failure does not prevent observing or stopping; accepted state remains in memory', async () => {
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
  expect(c.snapshot.live!.contributions).toHaveLength(1);
  c.stopCapture();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.snapshot.analysisError).toContain('could not be saved');
  expect(c.snapshot.live!.closed).toBe(true);
});
it('migrates legacy notes read-only without turning them into a live contribution', async () => {
  vi.useRealTimers();
  const legacy = { ...c.snapshot, summary: 'Historical cumulative minutes.', live: undefined };
  await saveLegacy(legacy);
  const migrated = await loadAssistant();
  expect(migrated!.summary).toBe('');
  expect(migrated!.live!.legacyNote).toBe(legacy.summary);
  expect(migrated!.live!.contributions).toHaveLength(0);
  expect((await loadLegacy())!.summary).toBe(legacy.summary);
});
it('bounds transport retries and aborts a timed-out request without publishing', async () => {
  run.mockImplementation(
    (_type, _model, _input, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
      ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(100000);
  expect(run).toHaveBeenCalledTimes(3);
  expect(c.snapshot.phase).toBe('paused');
  expect(c.snapshot.summary).toBe('');
});
it('separate versioned store preserves accepted history and restores without live jobs', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
  await saveAssistant(c.snapshot);
  const saved = await loadAssistant();
  expect(saved!.live!.contributions).toHaveLength(1);
  expect(recoveredAssistant(saved!).live!.closed).toBe(true);
});

it('a settled Stop does not make saving configuration block the next Start', async () => {
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.stopCapture();
  await vi.advanceTimersByTimeAsync(0);
  expect(c.busy).toBe(false);
  c.configure({ ...DEFAULT_SETTINGS, enabled: true });
  expect(c.busy).toBe(false);
  c.observe(transcript(0, 'next'));
  expect(c.snapshot.live!.closed).toBe(false);
});
it('bounds long transcript backlogs and rejects one oversized segment without truncation', () => {
  c.observe(transcript(0));
  const all = Array.from({ length: 200 }, (_, i) =>
    segment(
      i,
      'A source-linked explanation of deployment ownership and the server constraint. '.repeat(20),
    ),
  );
  const input = liveContext(c.snapshot, all, '');
  expect(input.liveInput!.newTranscript.length).toBeLessThan(200);
  expect(estimateTokens(input.liveInput!.newTranscript)).toBeLessThanOrEqual(2500);
  expect(estimateTokens(input.liveInput!.recentTranscript)).toBeLessThanOrEqual(2500);
  expect(() => liveContext(c.snapshot, [segment(0, 'x'.repeat(10000))], '')).toThrow(
    'exceeds the context budget',
  );
});
it('review reads arrivals after proposal start and has a ten second abort deadline', async () => {
  let resolve!: (v: any) => void;
  run.mockImplementation((type, _model, _input, signal) =>
    type === 'PROPOSE'
      ? new Promise((r) => (resolve = r))
      : new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
        ),
  );
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  resolve(result(proposal()));
  await vi.advanceTimersByTimeAsync(0);
  const input = run.mock.calls[1][2] as AnalysisInput;
  expect(input.liveInput!.recentTranscript.map((s) => s.id)).toContain(1);
  expect(c.snapshot.lastSegmentId).toBe(0);
  await vi.advanceTimersByTimeAsync(9999);
  expect(run.mock.calls[1][3].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.mock.calls[1][3].aborted).toBe(true);
  expect(c.snapshot.live!.memory).toHaveLength(1);
  expect(c.snapshot.summary).toBe('');
});

it('honors Retry-After even when new ASR arrives during backoff', async () => {
  run.mockRejectedValueOnce(new AssistantAPIError(429, 60000));
  c.observe(transcript(1));
  await vi.advanceTimersByTimeAsync(1000);
  c.observe(transcript(2));
  await vi.advanceTimersByTimeAsync(59999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.mock.calls[1][0]).toBe('PROPOSE');
});
