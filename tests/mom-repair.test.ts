import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/assistant/types';
import { EndMeetingController } from '../src/end-meeting/controller';
import { generateMinutes, MomValidationError, transcriptChunks, transcriptHash, type MomCheckpoint, type MomRejection } from '../src/end-meeting/mom';
import type { MomRequest, MomRequester } from '../src/end-meeting/provider';
import type { EndMeetingJob, Minutes } from '../src/end-meeting/types';
import type { TranscriptSegment } from '../src/transcription/types';

const storage = vi.hoisted(() => ({ jobs: new Map<string, EndMeetingJob>() }));
vi.mock('../src/end-meeting/store', () => ({
  getJob: async (id: string) => storage.jobs.has(id) ? structuredClone(storage.jobs.get(id)) : undefined,
  listJobs: async () => [...storage.jobs.values()].map(job => structuredClone(job)),
  putJob: async (job: EndMeetingJob) => { storage.jobs.set(job.sessionId, structuredClone(job)); },
  getDestinationRecord: async () => undefined,
  claimDestinationCleanup: async () => false,
  releaseDestinationCleanup: async () => {},
  setBundleDirectory: async () => {},
  deleteJob: async (id: string) => { storage.jobs.delete(id); },
}));
beforeEach(() => storage.jobs.clear());

const settings = { ...DEFAULT_SETTINGS, provider: 'hpop' as const, enabled: true };
const segments: TranscriptSegment[] = [
  { id: 0, sessionId: 'repair-session', startMs: 0, endMs: 7000, text: 'Untuk hosting, servernya di kita. Pihak mitra hanya memakai API yang disediakan.' },
  { id: 1, sessionId: 'repair-session', startMs: 7000, endMs: 13000, text: 'Disepakati integrasi melalui API. Maya mengirim dokumentasinya hari Jumat.' },
];
const reason = 'Kepemilikan server terbalik: sumber menyebut servernya di kita, bukan di pihak mitra.';
function candidate(correct: boolean) {
  return {
    protocol: 1 as const, language: 'Indonesian', emptyReason: null,
    bullets: [
      { kind: 'discussion' as const, text: correct ? 'Server dikelola oleh tim sendiri; mitra menggunakan API yang disediakan.' : 'Server dikelola oleh pihak mitra.', sources: [0], quotes: [{ source: 0, text: 'Untuk hosting, servernya di kita.' }] },
      { kind: 'action' as const, text: 'Maya mengirim dokumentasi integrasi API hari Jumat.', sources: [1], quotes: [{ source: 1, text: segments[1].text }] },
    ],
  };
}
const response = (value: unknown) => ({ value, latencyMs: 1, firstTokenMs: 1, usage: { input: 50, output: 30 } });
const verdict = (accept: boolean) => ({ protocol: 1, accept, reason: accept ? 'Semua poin didukung sumber.' : reason });
const input = (request: MomRequester, save: (checkpoint: MomCheckpoint) => Promise<void> = async () => {}, checkpoint?: MomCheckpoint) => ({
  segments, settings, key: 'synthetic-test-key', signal: new AbortController().signal, request, save, checkpoint,
});
async function legacyJob(): Promise<EndMeetingJob> {
  const hash = await transcriptHash(segments);
  return {
    protocol: 1, sessionId: 'repair-session', createdAt: 1000, updatedAt: 1000, revision: 1,
    sourceTitle: 'Synthetic legacy session', durationMs: 13_000, reason: 'manual', settings,
    phase: 'failed', audio: 'ready', destination: 'missing', folderName: 'synthetic', audioFilename: 'audio.webm',
    files: { audio: { phase: 'pending' }, transcript: { phase: 'pending' }, mom: { phase: 'pending' } },
    transcriptHash: hash, checkpoint: { sourceHash: hash, coverage: [0, 1], extracts: {}, reductions: {}, reviewed: [] },
    transcript: { phase: 'complete', sessionId: 'repair-session', segments, incomplete: false, lagMs: 0, modelReady: false },
  };
}

it('repairs server ownership from the same evidence, retains other points, then rechecks the complete revised draft', async () => {
  const calls: MomRequest[] = [], saved: MomCheckpoint[] = [], events: { kind: string; data: any }[] = [];
  let compositions = 0, reviews = 0;
  const request: MomRequester = async r => {
    calls.push(r);
    if (r.stage === 'compose') {
      compositions++;
      const payload = JSON.parse(r.messages[1].content);
      if (compositions === 1) expect(payload.repairFeedback).toBeUndefined();
      else {
        expect(payload.repairFeedback.reviewerReason).toBe(reason);
        expect(payload.repairFeedback.rejectedCandidate.bullets).toHaveLength(2);
        expect(payload.repairFeedback.rejectedCandidate.bullets[0].text).toContain('pihak mitra');
        expect(payload.repairFeedback.focusIndexes).toEqual([0, 1]);
        expect(payload.repairFeedback.evidence.some((e: any) => e.id === 0 && e.excerpt.includes('servernya di kita'))).toBe(true);
        expect(payload.transcript).toEqual(segments);
      }
      return response(candidate(compositions > 1));
    }
    reviews++;
    const payload = JSON.parse(r.messages[1].content);
    expect(payload.candidateInventory).toHaveLength(2);
    expect(payload.focusIndexes).toEqual([0, 1]);
    return response(verdict(reviews > 1));
  };
  const result = await generateMinutes({ ...input(request, async cp => { saved.push(cp); }), event: (kind, data) => events.push({ kind, data }) });
  expect(calls.map(r => r.stage)).toEqual(['compose', 'review', 'compose', 'review']);
  expect(result.minutes.bullets).toHaveLength(2);
  expect(result.minutes.bullets[0].text).toContain('tim sendiri');
  expect(result.checkpoint.coverage).toEqual([0, 1]);
  expect(result.checkpoint.reviewed).toEqual(['review-0']);
  expect(result.checkpoint.repairing).toBe(false);
  expect(saved.some(cp => cp.lastRejection?.reason === reason && !cp.draft && cp.repairing)).toBe(true);
  const safeEvents = events.filter(e => ['review-rejected', 'repair-started'].includes(e.kind));
  expect(safeEvents.map(e => e.data.code)).toEqual(['review_rejected', 'review_repair']);
  expect(JSON.stringify(safeEvents)).not.toContain(reason);
});

it('stops after a second rejection, keeping feedback for an explicit retry rather than publishing either draft', async () => {
  const calls: MomRequest[] = [], saved: MomCheckpoint[] = [];
  const request: MomRequester = async r => { calls.push(r); return response(r.stage === 'compose' ? candidate(false) : verdict(false)); };
  await expect(generateMinutes(input(request, async cp => { saved.push(cp); }))).rejects.toMatchObject({
    code: 'review_rejected_after_repair', stage: 'review',
  });
  expect(calls.map(r => r.stage)).toEqual(['compose', 'review', 'compose', 'review']);
  const checkpoint = saved.at(-1)!;
  expect(checkpoint.draft).toBeUndefined(); expect(checkpoint.reviewed).toEqual([]);
  expect(checkpoint.lastRejection?.reason).toBe(reason); expect(checkpoint.repairing).toBe(false);
  const retryCalls: MomRequest[] = [];
  const retry: MomRequester = async r => {
    retryCalls.push(r);
    if (r.stage === 'compose') {
      expect(JSON.parse(r.messages[1].content).repairFeedback.reviewerReason).toBe(reason);
      return response(candidate(true));
    }
    return response(verdict(true));
  };
  const result = await generateMinutes(input(retry, async () => {}, checkpoint));
  expect(result.minutes.bullets[0].text).toContain('tim sendiri');
  expect(retryCalls.map(r => r.stage)).toEqual(['compose', 'review']);
});

it('does not weaken exact-quote validation for a revised candidate', async () => {
  let count = 0;
  const request: MomRequester = async r => {
    if (r.stage === 'review') return response(verdict(false));
    const value = candidate(++count > 1);
    if (count > 1) value.bullets[0].quotes = [{ source: 0, text: 'This evidence does not exist.' }];
    return response(value);
  };
  await expect(generateMinutes(input(request))).rejects.toBeInstanceOf(MomValidationError);
  // The invalid semantic repair earns one bounded structural correction;
  // neither invalid response is allowed through the evidence gate.
  expect(count).toBe(3);
});

it('reuses long-transcript extraction coverage and restarts every review batch after a later batch rejects', async () => {
  const source = Array.from({ length: 26 }, (_, id) => ({
    id, sessionId: 'long-repair', startMs: id * 10_000, endMs: id * 10_000 + 8000,
    text: `${id}: ${'spoken background context '.repeat(90)}`,
  }));
  let compositions = 0, extracts = 0;
  const reviews: { draft: number; indexes: number[] }[] = [];
  const model: MomRequester = async r => {
    const payload = JSON.parse(r.messages[1].content);
    if (r.stage === 'extract') {
      extracts++;
      return response({ language: 'English', facts: payload.transcript.map((s: TranscriptSegment) => ({
        kind: 'discussion', text: s.text.slice(0, 200), sources: [s.id], quotes: [{ source: s.id, text: s.text.slice(0, 100) }],
      })) });
    }
    if (r.stage === 'compose') {
      compositions++;
      if (compositions === 2) expect(payload.repairFeedback.focusIndexes).toContain(7);
      return response({ protocol: 1, language: 'English', emptyReason: null, bullets: source.slice(0, 8).map(s => ({
        kind: 'discussion', text: `Point ${s.id}, revision ${compositions}: ${'important detail '.repeat(22)}`,
        sources: [s.id], quotes: [{ source: s.id, text: s.text.slice(0, 600) }],
      })) });
    }
    reviews.push({ draft: compositions, indexes: payload.focusIndexes });
    return response(verdict(compositions > 1 || !payload.focusIndexes.includes(7)));
  };
  const result = await generateMinutes({ ...input(model), segments: source });
  expect(extracts).toBe(transcriptChunks(source).length);
  expect(compositions).toBe(2);
  expect(result.checkpoint.coverage).toEqual(source.map(s => s.id));
  expect(reviews.filter(r => r.draft === 1).length).toBeGreaterThan(1);
  expect(reviews.filter(r => r.draft === 2).flatMap(r => r.indexes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(result.checkpoint.reviewed.length).toBe(reviews.filter(r => r.draft === 2).length);
});

it('an abort during the repaired compose cannot return a late corrected result', async () => {
  const abort = new AbortController(); let compositions = 0;
  const request: MomRequester = async r => {
    if (r.stage === 'review') return response(verdict(false));
    if (++compositions > 1) abort.abort();
    return response(candidate(compositions > 1));
  };
  await expect(generateMinutes({ ...input(request), signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(compositions).toBe(2);
});

it('Discard fences a late repaired response and never publishes the rejected or corrected draft', async () => {
  let compositions = 0, resolveRepair!: (value: ReturnType<typeof response>) => void;
  const request: MomRequester = async r => {
    if (r.stage === 'review') return response(verdict(false));
    if (++compositions === 1) return response(candidate(false));
    return new Promise(resolve => { resolveRepair = resolve; });
  };
  const changes: EndMeetingJob[] = [], release = vi.fn(async () => {});
  const controller = new EndMeetingController({ changed: job => changes.push(job), settled: () => {}, loadAudio: async () => new Blob(), releaseAudio: release, request });
  controller.configure(settings, 'synthetic-test-key');
  await controller.begin({ sessionId: 'repair-session', createdAt: 1000, sourceTitle: 'Synthetic ownership discussion', durationMs: 13_000, reason: 'manual', settings });
  await controller.updateTranscript({ phase: 'complete', sessionId: 'repair-session', segments, incomplete: false, lagMs: 0, modelReady: false });
  await vi.waitFor(() => expect(compositions).toBe(2));
  const discarding = controller.discard('repair-session');
  resolveRepair(response(candidate(true))); await discarding;
  expect(await controller.get('repair-session')).toBeUndefined();
  expect(changes.every(job => !job.minutes)).toBe(true); expect(release).toHaveBeenCalledOnce();
});

it('explicit retry safely seeds captured legacy rejection only for its complete matching transcript checkpoint', async () => {
  const stored = await legacyJob(), previous: MomRejection = { candidate: candidate(false), reason, focusIndexes: [0] };
  storage.jobs.set(stored.sessionId, stored);
  const request = vi.fn<MomRequester>(async r => {
    if (r.stage === 'compose') {
      expect(JSON.parse(r.messages[1].content).repairFeedback.reviewerReason).toBe(reason);
      return response(candidate(true));
    }
    return response(verdict(true));
  });
  const controller = new EndMeetingController({ changed: () => {}, settled: () => {}, loadAudio: async () => new Blob(), releaseAudio: async () => {}, request });
  controller.configure(settings, 'synthetic-test-key'); await controller.restore();
  expect(request).not.toHaveBeenCalled();
  await controller.retry(stored.sessionId, previous);
  await vi.waitFor(async () => expect((await controller.get(stored.sessionId))?.phase).toBe('ready'));
  expect((await controller.get(stored.sessionId))?.checkpoint?.lastRejection?.reason).toBe(reason);
});

it('does not seed captured feedback without a matching checkpoint/hash, or while a generation is active', async () => {
  const previous: MomRejection = { candidate: candidate(false), reason, focusIndexes: [0] };
  for (const missing of ['checkpoint', 'hash', 'different-checkpoint']) {
    const stored = await legacyJob();
    if (missing === 'checkpoint') delete stored.checkpoint;
    else if (missing === 'hash') delete stored.transcriptHash;
    else stored.checkpoint!.sourceHash = 'another-transcript';
    storage.jobs.set(stored.sessionId, stored);
    const request: MomRequester = async r => {
      if (r.stage === 'compose') expect(JSON.parse(r.messages[1].content).repairFeedback).toBeUndefined();
      return response(r.stage === 'compose' ? candidate(true) : verdict(true));
    };
    const c = new EndMeetingController({ changed: () => {}, settled: () => {}, loadAudio: async () => new Blob(), releaseAudio: async () => {}, request });
    c.configure(settings, 'synthetic-test-key'); await c.restore(); await c.retry(stored.sessionId, previous);
    await vi.waitFor(() => expect(c.busy).toBe(false));
    expect((await c.get(stored.sessionId))?.checkpoint?.lastRejection).toBeUndefined();
  }
  const stored = await legacyJob(); storage.jobs.set(stored.sessionId, stored);
  let resolve!: (result: ReturnType<typeof response>) => void;
  const request = vi.fn<MomRequester>(async r => r.stage === 'compose' ? new Promise(r => { resolve = r; }) : response(verdict(true)));
  const c = new EndMeetingController({ changed: () => {}, settled: () => {}, loadAudio: async () => new Blob(), releaseAudio: async () => {}, request });
  c.configure(settings, 'synthetic-test-key'); await c.restore(); await c.retry(stored.sessionId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await c.retry(stored.sessionId, previous);
  expect((await c.get(stored.sessionId))?.checkpoint?.lastRejection).toBeUndefined();
  resolve(response(candidate(true))); await vi.waitFor(() => expect(c.busy).toBe(false));
});

it('rejects captured legacy feedback with nonexistent source evidence before making a request', async () => {
  const stored = await legacyJob(); storage.jobs.set(stored.sessionId, stored);
  const request = vi.fn<MomRequester>();
  const c = new EndMeetingController({ changed: () => {}, settled: () => {}, loadAudio: async () => new Blob(), releaseAudio: async () => {}, request });
  c.configure(settings, 'synthetic-test-key'); await c.restore();
  const invalid = candidate(false); invalid.bullets[0].sources = [99];
  await expect(c.retry(stored.sessionId, { candidate: invalid, reason, focusIndexes: [0] })).rejects.toBeInstanceOf(MomValidationError);
  expect(request).not.toHaveBeenCalled(); expect((await c.get(stored.sessionId))?.checkpoint?.lastRejection).toBeUndefined();
});
