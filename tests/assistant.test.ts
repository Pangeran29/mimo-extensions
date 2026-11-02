import { FINAL_ANALYSIS_TIMEOUT_MS } from '../src/assistant/timing';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantController, boundMemory, tokenEstimate } from '../src/assistant/controller';
import { DEFAULT_SETTINGS, type AnalysisInput, type AnalysisResult } from '../src/assistant/types';
import { AssistantAPIError } from '../src/assistant/provider';
import { validateAnalysis, duplicateQuestion } from '../src/assistant/schema';
import { saveAssistant, loadAssistant, recoveredAssistant } from '../src/assistant/store';
const question = {
  text: 'Who owns the launch?',
  reason: 'The launch needs an owner.',
  issueKey: 'launch-owner',
  evidenceSegmentIds: [0],
};
const result: AnalysisResult = {
  analysis: {
    summary: 'Launch ownership is undecided.',
    updates: [],
    question,
  },
  latencyMs: 320,
  firstTokenMs: 100,
};
const segment = (id: number, text = 'We need to launch next week, no owner yet.') => ({
  id,
  sessionId: 'session',
  startMs: id * 8000,
  endMs: id * 8000 + 7000,
  text,
});
const transcript = (ids: number[], sessionId = 'session') => ({
  phase: 'transcribing' as const,
  sessionId,
  segments: ids.map((id) => ({ ...segment(id), sessionId })),
  incomplete: false,
  lagMs: 0,
  modelReady: true,
});
let run: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>,
  changed: ReturnType<typeof vi.fn>,
  settled: ReturnType<typeof vi.fn>,
  controller: AssistantController;
beforeEach(() => {
  vi.useFakeTimers();
  run = vi.fn().mockResolvedValue(structuredClone(result));
  close = vi.fn();
  changed = vi.fn();
  settled = vi.fn();
  controller = new AssistantController({ request: run, close }, changed, async () => {}, settled);
  controller.configure({ ...DEFAULT_SETTINGS, enabled: true });
});
afterEach(() => vi.useRealTimers());
it('coalesces final passages for 150ms and skips already processed snapshots', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(100);
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(49);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][2].segments).toHaveLength(2);
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(5000);
  expect(run).toHaveBeenCalledTimes(1);
});
it('keeps one request and coalesced pending update, with a two second start interval', async () => {
  let resolve!: (v: AnalysisResult) => void;
  run.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  controller.observe(transcript([0, 1]));
  controller.observe(transcript([0, 1, 2]));
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  resolve(structuredClone(result));
  await vi.advanceTimersByTimeAsync(999);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][2].segments.map((s: any) => s.id)).toEqual([0, 1, 2]);
});
it('rejects stale responses after a new session', async () => {
  let resolve!: (v: AnalysisResult) => void;
  run.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  controller.observe(transcript([], 'next'));
  resolve(structuredClone(result));
  await vi.advanceTimersByTimeAsync(10);
  expect(controller.snapshot.sessionId).toBe('next');
  expect(controller.snapshot.question).toBeNull();
  expect(controller.snapshot.version).toBe(0);
});
it('suppresses repeated issues and clears resolved questions', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  controller.feedback('session', 'launch-owner', 'dismissed');
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.question).toBeNull();
  run.mockResolvedValueOnce({
    ...result,
    analysis: {
      summary: 'Owner agreed.',
      updates: [
        {
          kind: 'resolved',
          key: 'launch-owner',
          text: 'Ari owns launch.',
          evidenceSegmentIds: [2],
        },
      ],
      question: null,
    },
  });
  controller.observe(transcript([0, 1, 2]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.history[0].feedback).toBe('resolved');
});
it('pauses on authentication errors without retry loops', async () => {
  run.mockRejectedValue(new AssistantAPIError(401));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(controller.snapshot.phase).toBe('paused');
  controller.resume();
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledTimes(2);
});
it('honors rate limits and keeps recovering after three failures', async () => {
  run.mockRejectedValue(new AssistantAPIError(429, 10000));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(10000);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(25000);
  expect(run).toHaveBeenCalledTimes(3);
  expect(controller.snapshot.phase).toBe('listening');
  expect(controller.snapshot.retryAt).toBeGreaterThan(Date.now());
  await vi.advanceTimersByTimeAsync(20000);
  expect(run).toHaveBeenCalledTimes(4);
});
it('continues after malformed output but never displays it', async () => {
  run.mockResolvedValue({
    ...result,
    analysis: {
      ...result.analysis,
      question: { ...question, evidenceSegmentIds: [999] },
    },
  });
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.question).toBeNull();
  expect(controller.snapshot.lastSegmentId).toBe(-1);
});
it('cancels deeper work and bounds the final memo update to its shared deadline', async () => {
  run.mockImplementation(() => new Promise(() => {}));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  void controller.deeper('session');
  const deepSignal = run.mock.calls[1][3];
  controller.finish();
  expect(deepSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(FINAL_ANALYSIS_TIMEOUT_MS);
  expect(controller.busy).toBe(false);
  expect(controller.snapshot.phase).toBe('complete');
  expect(controller.snapshot.incomplete).toBe(true);
  expect(close).toHaveBeenCalled();
});
it('runs a final update including the last finalized passage', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  controller.observe(transcript([0, 1]));
  controller.finish();
  await vi.advanceTimersByTimeAsync(2000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(controller.snapshot.lastSegmentId).toBe(1);
  expect(controller.snapshot.phase).toBe('complete');
});
it('bounds recent context and memory, reporting missed context', async () => {
  const t = transcript(Array.from({ length: 50 }, (_, i) => i));
  t.segments.forEach((s) => (s.text = 'data '.repeat(200)));
  controller.observe(t);
  await vi.advanceTimersByTimeAsync(150);
  const input = run.mock.calls[0][2];
  expect(input.contextGap).toBe(true);
  expect(tokenEstimate(input.segments)).toBeLessThanOrEqual(2500);
  expect(input.segments.at(-1).id).toBe(49);
  const memory = boundMemory(
    Array.from({ length: 100 }, (_, i) => ({
      kind: 'fact',
      key: 'key' + i,
      text: 'x'.repeat(180),
      evidenceSegmentIds: [i],
    })),
  );
  expect(tokenEstimate(memory)).toBeLessThanOrEqual(1000);
});
it('validates source references independently of schema and confidence', () => {
  const input = {
    segments: [segment(0)],
    memory: [],
  } as unknown as AnalysisInput;
  expect(() => validateAnalysis(result.analysis, input)).not.toThrow();
  expect(() =>
    validateAnalysis(
      {
        ...result.analysis,
        question: { ...question, evidenceSegmentIds: [7] },
      },
      input,
    ),
  ).toThrow();
  expect(duplicateQuestion(question, [{ ...question, feedback: 'dismissed', createdAt: 1 }])).toBe(
    true,
  );
});
it('saves analysis independently and recovers without live status', async () => {
  vi.useRealTimers();
  await saveAssistant({
    ...controller.snapshot,
    phase: 'thinking',
    sessionId: 'session',
    summary: 'Retained',
  });
  const saved = (await loadAssistant())!;
  expect(saved.summary).toBe('Retained');
  expect(recoveredAssistant(saved).phase).toBe('complete');
  expect(recoveredAssistant(saved).incomplete).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('apiKey');
});
it('suppresses generic questions locally even with valid references', () => {
  const input = {
    segments: [segment(0)],
    memory: [],
  } as unknown as AnalysisInput;
  expect(
    validateAnalysis(
      { ...result.analysis, question: { ...question, text: 'Any concerns?' } },
      input,
    ).question,
  ).toBeNull();
});
it('measures from finalized availability, including scheduling and pending time', async () => {
  let resolve!: (v: AnalysisResult) => void;
  run.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(1000);
  resolve(structuredClone(result));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot.latencyMs).toBe(1000);
});
it('coalesces persistence when local writes are slow', async () => {
  let release!: () => void;
  const save = vi
    .fn()
    .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    .mockResolvedValue(undefined);
  const c = new AssistantController({ request: run, close }, changed, save, settled);
  c.configure({ ...DEFAULT_SETTINGS, enabled: true });
  c.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  c.feedback('session', 'launch-owner', 'useful');
  c.feedback('session', 'launch-owner', 'dismissed');
  expect(save).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0].question).toBeNull();
});

it('replaces one memo atomically and separates new speech from earlier context', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  const first = structuredClone(controller.snapshot.summaries[0]);
  run.mockResolvedValueOnce({
    ...result,
    analysis: {
      summary: 'Ari owns the launch.',
      updates: [
        {
          kind: 'decision',
          key: 'launch-owner',
          text: 'Ari owns launch.',
          evidenceSegmentIds: [1],
        },
      ],
      question: null,
    },
  });
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls[1][2].previousSummary).toBe(result.analysis.summary);
  expect(run.mock.calls[1][2].newSegmentIds).toEqual([1]);
  expect(run.mock.calls[1][2].recentSummaries).toEqual([]);
  expect(controller.snapshot.summaries[0].evidenceSegmentIds).toEqual([0, 1]);
  expect(controller.snapshot.summaries[0].format).toBe('memo');
  expect(controller.snapshot.summaries).toHaveLength(1);
  expect(first.summary).toBe(result.analysis.summary);
  expect(controller.snapshot.summaries[0].summary).toBe('Ari owns the launch.');
  expect(controller.snapshot.summaries[0].throughMs).toBe(15000);
  expect(controller.snapshot.summaries[0].memory[0].text).toBe('Ari owns launch.');
  expect(controller.snapshot.updatedAt).toBeGreaterThan(first.createdAt);
  expect(controller.snapshot.analyzingSince).toBeUndefined();
});
it('does not append unchanged summary responses, feedback, or deeper analysis as revisions', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  controller.feedback('session', 'launch-owner', 'dismissed');
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.version).toBe(2);
  expect(controller.snapshot.summaries).toHaveLength(1);
  run.mockResolvedValueOnce('More detailed notes.');
  await controller.deeper('session');
  expect(controller.snapshot.summaries).toHaveLength(1);
});
it('retains a nonempty summary when the model returns empty text and resets history for a new meeting', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  run.mockResolvedValueOnce({ ...result, analysis: { summary: '', updates: [], question: null } });
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.summary).toBe(result.analysis.summary);
  expect(controller.snapshot.lastSegmentId).toBe(1);
  expect(controller.snapshot.version).toBe(2);
  expect(controller.snapshot.summaries).toHaveLength(1);
  controller.observe(transcript([], 'another-session'));
  expect(controller.snapshot.summaries).toEqual([]);
  expect(controller.snapshot.updatedAt).toBeUndefined();
});
it('records actionable retry state without creating a summary from failed output', async () => {
  run.mockRejectedValueOnce(new AssistantAPIError(429, 10000));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.retryAt).toBe(Date.now() + 10000);
  expect(controller.snapshot.analysisError).toBeTruthy();
  expect(controller.snapshot.summaries).toEqual([]);
  expect(controller.snapshot.analyzingSince).toBeUndefined();
});
it('persists every summary revision and recovers legacy summaries without invented time coverage', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  vi.useRealTimers();
  await saveAssistant(controller.snapshot);
  expect((await loadAssistant())?.summaries).toEqual(controller.snapshot.summaries);
  const { summaries: _oldMissingField, ...legacy } = controller.snapshot;
  const recovered = recoveredAssistant(legacy as typeof controller.snapshot);
  expect(recovered.summaries).toHaveLength(1);
  expect(recovered.summaries[0].throughMs).toBeUndefined();
  expect(recovered.summaries[0].createdAt).toBe(0);
});
it('keeps short-first-memo mode after empty output, expands once saved, and resets for a new session', async () => {
  controller.setMemoPolicy('short-first-note');
  run.mockResolvedValueOnce({ ...result, analysis: { summary: '', updates: [], question: null } });
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(run.mock.calls[0][2]).toMatchObject({
    memoPolicy: 'short-first-note',
    previousSummary: '',
  });
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls[1][2].previousSummary).toBe('');
  controller.observe(transcript([0, 1, 2]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls[2][2].previousSummary).toBe(result.analysis.summary);
  controller.observe(transcript([0], 'next-session'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls[3][2]).toMatchObject({
    memoPolicy: 'short-first-note',
    previousSummary: '',
    sessionId: 'next-session',
  });
});
it('does not request notes on silence and does not expose future transcript segments', async () => {
  controller.setMemoPolicy('short-first-note');
  controller.observe(transcript([]));
  await vi.advanceTimersByTimeAsync(15000);
  expect(run).not.toHaveBeenCalled();
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(run.mock.calls[0][2].segments.map((s: any) => s.id)).toEqual([0]);
});

it('recovers after repeated invalid updates beyond eight minutes, retaining the memo and pending speech', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  const memo = controller.snapshot.summary;
  const invalid = {
    ...result,
    analysis: { ...result.analysis, question: { ...question, evidenceSegmentIds: [999] } },
  };
  run.mockResolvedValueOnce(invalid).mockResolvedValueOnce(invalid).mockResolvedValueOnce(invalid);
  await vi.advanceTimersByTimeAsync(8 * 60000);
  controller.observe(transcript([0, 60]));
  await vi.advanceTimersByTimeAsync(6150);
  expect(run).toHaveBeenCalledTimes(4); // initial valid + three invalid
  expect(controller.snapshot.phase).toBe('listening');
  expect(controller.snapshot.summary).toBe(memo);
  expect(controller.snapshot.lastSegmentId).toBe(0);
  expect(controller.snapshot.version).toBe(1);
  expect(controller.snapshot.lastFailure).toMatchObject({ reason: 'unknown_evidence', count: 3 });
  expect(controller.snapshot.retryAt! - Date.now()).toBe(30000);
  controller.observe(transcript([0, 60, 61]));
  run.mockResolvedValue({
    ...result,
    analysis: { summary: 'The updated supported memo.', updates: [], question: null },
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(controller.snapshot.summary).toBe('The updated supported memo.');
  expect(controller.snapshot.lastSegmentId).toBe(61);
  expect(controller.snapshot.analysisError).toBeUndefined();
  expect(controller.snapshot.retryAt).toBeUndefined();
  expect(run.mock.calls.at(-1)![2].newSegmentIds).toEqual([60, 61]);
  expect(controller.snapshot.lastFailure?.reason).toBe('unknown_evidence');
});
it('backs off persistent transient failures to one minute and lets manual retry bypass that wait', async () => {
  run.mockRejectedValue(new AssistantAPIError(0, 0, 'timeout'));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(36150); // 150, 2150, 6150, 36150
  expect(run).toHaveBeenCalledTimes(4);
  expect(controller.snapshot.retryAt! - Date.now()).toBe(60000);
  await vi.advanceTimersByTimeAsync(59000);
  expect(run).toHaveBeenCalledTimes(4);
  controller.resume();
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledTimes(5);
  controller.configure({ ...DEFAULT_SETTINGS, enabled: false });
  await vi.advanceTimersByTimeAsync(120000);
  expect(run).toHaveBeenCalledTimes(5);
});
it('does not retry permanent request errors or cross a new session boundary', async () => {
  run.mockRejectedValueOnce(new AssistantAPIError(400));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(120000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(controller.snapshot.phase).toBe('paused');
  controller.observe(transcript([0], 'new-session'));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.lastFailure).toBeUndefined();
  expect(controller.snapshot.lastSegmentId).toBe(0);
});
it('bounds finalization even during persistent format recovery and saves safe failure metadata', async () => {
  run.mockRejectedValue(new AssistantAPIError(0, 0, 'format', 'output_truncated'));
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(6150);
  controller.finish();
  await vi.advanceTimersByTimeAsync(FINAL_ANALYSIS_TIMEOUT_MS + 2000);
  expect(controller.snapshot.phase).toBe('complete');
  expect(controller.snapshot.incomplete).toBe(true);
  expect(controller.busy).toBe(false);
  vi.useRealTimers();
  await saveAssistant(controller.snapshot);
  expect(recoveredAssistant((await loadAssistant())!).lastFailure).toMatchObject({
    reason: 'output_truncated',
    count: 3,
  });
});

it('exposes display-only request progress without saving live readings', async () => {
  let resolve!: (value: AnalysisResult) => void;
  run.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  controller.observe(transcript([0]));
  expect(controller.liveProgress().queued).toBe(true);
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.liveProgress().state).toBe('running');
  const emitted = changed.mock.calls.length;
  controller.liveProgress();
  controller.liveProgress();
  expect(changed).toHaveBeenCalledTimes(emitted);
  expect(JSON.stringify(controller.snapshot)).not.toContain('elapsedMs');
  resolve(structuredClone(result));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.liveProgress().state).toBe('done');
  controller.observe(transcript([], 'new-progress-session'));
  expect(controller.liveProgress().state).toBe('idle');
});

it('retains only bounded structural failure details for an oversized memo', async () => {
  run.mockResolvedValueOnce({
    ...result,
    analysis: { ...result.analysis, summary: 'private'.repeat(400) },
  });
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.lastFailure?.validationIssues).toEqual([
    { field: 'summary', code: 'too_big', limit: 2400, size: 2800 },
  ]);
  expect(JSON.stringify(controller.snapshot)).not.toContain('private');
  expect(controller.snapshot.summary).toBe('');
});

it('feeds back the failed constraint on the existing retry, then clears it after recovery', async () => {
  run.mockResolvedValueOnce({
    ...result,
    analysis: { ...result.analysis, summary: 'x'.repeat(2600) },
  });
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.version).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][2].validationFeedback).toEqual([
    { field: 'summary', code: 'too_big', limit: 2400, size: 2600 },
  ]);
  expect(controller.snapshot.version).toBe(1);
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls[2][2].validationFeedback).toBeUndefined();
});

it('keeps a restored finished meeting closed when startup configures AI and sees its saved transcript', async () => {
  controller.restore({
    ...controller.snapshot,
    sessionId: 'session',
    phase: 'complete',
    summary: 'Saved meeting memo.',
    lastSegmentId: 0,
    version: 1,
  });
  controller.configure({ ...DEFAULT_SETTINGS, enabled: true });
  controller.observe({ ...transcript([0, 1]), phase: 'complete' });
  await vi.advanceTimersByTimeAsync(250);
  expect(run).not.toHaveBeenCalled();
  expect(controller.busy).toBe(false);
  expect(controller.snapshot.phase).toBe('complete');
  expect(controller.snapshot.summary).toBe('Saved meeting memo.');
});

it('does not reopen saved history when AI is disabled and re-enabled, but starts a new meeting', async () => {
  controller.restore({
    ...controller.snapshot,
    sessionId: 'session',
    phase: 'complete',
    lastSegmentId: 0,
  });
  controller.configure({ ...DEFAULT_SETTINGS, enabled: false });
  controller.configure({ ...DEFAULT_SETTINGS, enabled: true });
  controller.observe(transcript([0, 1]));
  controller.resume();
  await vi.advanceTimersByTimeAsync(5000);
  expect(run).not.toHaveBeenCalled();
  controller.observe(transcript([0], 'new-session'));
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][2].sessionId).toBe('new-session');
});
it('allows explicit durable audio recovery to resume a restored closed meeting', async () => {
  controller.restore({
    ...controller.snapshot,
    sessionId: 'session',
    phase: 'complete',
    lastSegmentId: 0,
  });
  controller.configure({ ...DEFAULT_SETTINGS, enabled: true });
  controller.observe(transcript([0, 1]), true);
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledTimes(1);
  expect(controller.snapshot.lastSegmentId).toBe(1);
  controller.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot.phase).toBe('complete');
});

it('identifies a validated empty summary with correlated counts, preserves it in storage and resets for a new session', async () => {
  run.mockResolvedValueOnce({
    ...result,
    analysis: { summary: '  ', updates: [], question: null },
  });
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  expect(controller.snapshot.lastAnalysis).toMatchObject({
    requestId: expect.stringMatching(/^session:[^:]+:1$/),
    version: 1,
    summaryCharacters: 0,
    memoCharacters: 0,
    outcome: 'empty',
  });
  expect(controller.liveProgress()).toMatchObject({ state: 'done', outcome: 'empty' });
  expect(controller.snapshot.lastSegmentId).toBe(0);
  vi.useRealTimers();
  await saveAssistant(controller.snapshot);
  expect((await loadAssistant())?.lastAnalysis).toEqual(controller.snapshot.lastAnalysis);
  controller.observe(transcript([], 'fresh'));
  expect(controller.snapshot.lastAnalysis).toBeUndefined();
});
it('distinguishes an empty update that keeps existing notes from an invalid response', async () => {
  controller.observe(transcript([0]));
  await vi.advanceTimersByTimeAsync(150);
  run.mockResolvedValueOnce({ ...result, analysis: { summary: '', updates: [], question: null } });
  controller.observe(transcript([0, 1]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.lastAnalysis).toMatchObject({
    outcome: 'empty',
    summaryCharacters: 0,
    memoCharacters: result.analysis.summary.length,
  });
  const lastSuccess = structuredClone(controller.snapshot.lastAnalysis);
  run.mockResolvedValueOnce({
    ...result,
    analysis: { summary: 'x'.repeat(2401), updates: [], question: null },
  });
  controller.observe(transcript([0, 1, 2]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.snapshot.lastAnalysis).toEqual(lastSuccess);
  expect(controller.snapshot.lastFailure?.reason).toBe('schema_mismatch');
  expect(controller.liveProgress().outcome).toBeUndefined();
});
