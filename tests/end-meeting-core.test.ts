import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/assistant/types';
import { AssistantAPIError } from '../src/assistant/errors';
import { EndMeetingController } from '../src/end-meeting/controller';
import { generateMinutes, minutesText, transcriptChunks, transcriptText, validateMinutes } from '../src/end-meeting/mom';
import type { EndMeetingJob, EndMeetingMeta } from '../src/end-meeting/types';
import type { TranscriptSnapshot } from '../src/transcription/types';
import type { MomRequester } from '../src/end-meeting/provider';

const storage = vi.hoisted(() => ({ jobs: new Map<string, any>(), destinations: new Map<string, any>(), fail: false, failReleasedOnce: false }));
vi.mock('../src/end-meeting/store', () => ({
  getJob: async (id: string) => storage.jobs.has(id) ? structuredClone(storage.jobs.get(id)) : undefined,
  listJobs: async () => [...storage.jobs.values()].map(j => structuredClone(j)).sort((a, b) => b.createdAt - a.createdAt),
  putJob: async (job: any) => { if (storage.fail || storage.failReleasedOnce && job.audioReleased) { storage.failReleasedOnce = false; throw new Error('storage unavailable'); } storage.jobs.set(job.sessionId, structuredClone(job)); },
  getDestinationRecord: async (id: string) => storage.destinations.get(id),
  setBundleDirectory: async (id: string, key: string, bundle: any) => { const d = storage.destinations.get(id); if (d.key !== key) throw new Error('stale destination'); d.bundle = bundle; },
  claimDestinationCleanup: async (id: string, key: string) => { const d = storage.destinations.get(id); if (d?.key !== key) return false; d.cleanupLocked = true; return true; },
  releaseDestinationCleanup: async (id: string, key: string) => { const d = storage.destinations.get(id); if (d?.key === key) d.cleanupLocked = false; },
  deleteJob: async (id: string) => { storage.jobs.delete(id); storage.destinations.delete(id); },
}));
const settings = { ...DEFAULT_SETTINGS, provider: 'hpop' as const, enabled: true };
const meta = (id = 'meeting-a', createdAt = 1000): EndMeetingMeta => ({ sessionId: id, createdAt, sourceTitle: 'Test meeting', durationMs: 20_000, reason: 'manual', settings });
const segment = (id: number, text: string, sessionId = 'meeting-a') => ({ id, sessionId, startMs: id * 10_000, endMs: id * 10_000 + 8000, text });
const transcript = (sessionId = 'meeting-a'): TranscriptSnapshot => ({
  phase: 'complete', sessionId,
  segments: [segment(0, 'Maya mengusulkan tenggat pada 12 Desember.', sessionId), segment(1, 'Ralat, disepakati tenggat pada 15 November. Maya mengirim revisi.', sessionId)],
  incomplete: false, lagMs: 0, modelReady: false,
});
const draft = (source = 1, quote = transcript().segments[1].text) => ({ protocol: 1, language: 'Indonesian', bullets: [{ kind: 'decision', text: 'Disepakati tenggat pada 15 November.', sources: [source], quotes: [{ source, text: quote }] }], emptyReason: null });
const reply = (value: unknown) => ({ value, latencyMs: 5, firstTokenMs: 2, usage: { input: 100, output: 40 } });
let request: ReturnType<typeof vi.fn>, c: EndMeetingController, release: ReturnType<typeof vi.fn>, changes: EndMeetingJob[];
function controller(): EndMeetingController {
  const instance = new EndMeetingController({ changed: j => changes.push(j), settled: () => {}, loadAudio: async () => new Blob(['recorded-audio'], { type: 'audio/webm' }), releaseAudio: release, request });
  instance.configure(settings, 'test-key');
  return instance;
}
function directory(permission = 'granted') {
  const files = new Map<string, string>(), children = new Map<string, any>(), opens = new Map<string, number>();
  let failFile = '';
  const holds = new Map<string, Promise<void>>();
  const build = (name: string): any => ({
    kind: 'directory', name,
    queryPermission: async () => permission,
    getDirectoryHandle: async (child: string, options?: { create: boolean }) => {
      if (!children.has(child)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        children.set(child, build(child));
      }
      return children.get(child);
    },
    getFileHandle: async (name: string) => ({
      createWritable: async () => {
        opens.set(name, (opens.get(name) ?? 0) + 1);
        if (failFile === name) throw new DOMException('No space', 'QuotaExceededError');
        const chunks: Uint8Array[] = [];
        let aborted = false;
        return {
          write: async (data: Uint8Array) => { chunks.push(data); },
          close: async () => { await holds.get(name); if (aborted) throw new DOMException('Aborted', 'AbortError'); files.set(name, await new Blob(chunks as BlobPart[]).text()); },
          abort: async () => { aborted = true; },
        };
      },
    }),
  });
  return { handle: build('chosen'), files, opens, children, fail: (file: string) => { failFile = file; }, allow: () => { permission = 'granted'; }, hold: (file: string) => { let release!: () => void; holds.set(file, new Promise<void>(r => { release = r; })); return release; } };
}
async function choose(d = directory(), id = 'meeting-a') {
  storage.destinations.set(id, { sessionId: id, key: crypto.randomUUID(), handle: d.handle });
  await c.save(id); return d;
}
async function finished(id = 'meeting-a') {
  await vi.waitFor(async () => expect((await c.get(id))?.phase).toMatch(/ready|empty|failed/));
  await vi.waitFor(() => expect(c.busy).toBe(false));
}
beforeEach(() => {
  storage.jobs.clear(); storage.destinations.clear(); storage.fail = false; storage.failReleasedOnce = false; changes = [];
  release = vi.fn(async () => {});
  request = vi.fn(async (r) => reply(r.stage === 'compose' ? draft() : { protocol: 1, accept: true, reason: 'Evidence and correction checked.' }));
  c = controller();
});
afterEach(() => { vi.useRealTimers(); });

it('deduplicates simultaneous Stop/begin and strips connection credentials from metadata', async () => {
  const m = meta(); (m.settings as any).apiKey = 'never-persist';
  const [a, b] = await Promise.all([c.begin(m), c.begin(m)]);
  expect(a.sessionId).toBe(b.sessionId); expect(storage.jobs.size).toBe(1);
  expect(JSON.stringify(storage.jobs.get(m.sessionId))).not.toContain('never-persist');
  expect(changes).toHaveLength(1);
  delete (settings as any).apiKey;
});
it('waits for final ASR, then publishes verified full-session notes including the corrected date', async () => {
  await c.begin(meta());
  await c.updateTranscript({ ...transcript(), phase: 'finishing', segments: transcript().segments.slice(0, 1) });
  expect(request).not.toHaveBeenCalled();
  await c.updateTranscript(transcript()); await finished();
  const j = (await c.get())!;
  expect(j.minutes?.bullets[0].text).toContain('15 November');
  expect(j.checkpoint?.coverage).toEqual([0, 1]);
  const sent = JSON.parse(request.mock.calls[0][0].messages[1].content);
  expect(sent.transcript).toHaveLength(2);
  expect(request.mock.calls.map(a => a[0].stage)).toEqual(['compose', 'review']);
  expect(release).not.toHaveBeenCalled();
});
it('Cancel/missing folder retains results; one later folder saves exactly the three expected files', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  expect((await c.get())?.destination).toBe('missing');
  const d = await choose();
  const j = (await c.get())!;
  expect([...d.files.keys()].sort()).toEqual([j.audioFilename, 'mom.txt', 'transcript.txt'].sort());
  expect(d.files.get('mom.txt')).toBe('- Disepakati tenggat pada 15 November.\n');
  expect(d.files.get('transcript.txt')).toContain('[00:00:10–00:00:18] Ralat');
  expect(d.files.get(j.audioFilename)).toBe('recorded-audio');
  expect(release).toHaveBeenCalledTimes(1);
  expect(j.audioReleased).toBe(true);
});
it('deduplicates concurrent destination/audio/final-transcript exports without duplicate writes', async () => {
  await c.begin(meta()); const d = directory();
  storage.destinations.set('meeting-a', { sessionId: 'meeting-a', key: 'selected', handle: d.handle });
  await Promise.all([c.audioReady('meeting-a'), c.save('meeting-a'), c.updateTranscript(transcript()), c.save('meeting-a')]);
  await finished();
  await vi.waitFor(() => expect(d.files.size).toBe(3));
  expect([...d.opens.values()]).toEqual([1, 1, 1]);
  expect(release).toHaveBeenCalledTimes(1);
});
it('a changed destination fences a held old write and releases audio only after the new bundle saves', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  const filename = (await c.get())!.audioFilename;
  const old = directory(), fresh = directory();
  const unblock = old.hold(filename);
  storage.destinations.set('meeting-a', { sessionId: 'meeting-a', key: 'old', handle: old.handle });
  const writing = c.save('meeting-a');
  await vi.waitFor(() => expect(old.opens.get(filename)).toBe(1));
  storage.destinations.set('meeting-a', { sessionId: 'meeting-a', key: 'fresh', handle: fresh.handle });
  const switched = c.save('meeting-a');
  expect(release).not.toHaveBeenCalled();
  unblock(); await Promise.all([writing, switched]);
  await vi.waitFor(() => expect(fresh.files.size).toBe(3));
  await vi.waitFor(() => expect(c.busy).toBe(false));
  expect(old.files.size).toBe(0); expect(release).toHaveBeenCalledTimes(1);
  const j = (await c.get())!;
  expect(j.destinationKey).toBe('fresh'); expect(j.audioReleased).toBe(true);
  expect(Object.values(j.files).every(f => f.phase === 'saved')).toBe(true);
});
it('restore retries failed local cleanup without model calls or filesystem writes', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  release.mockRejectedValueOnce(new Error('local DB unavailable'));
  const d = await choose();
  expect((await c.get())?.cleanupError).toContain('cleanup'); expect((await c.get())?.audioReleased).not.toBe(true);
  const providerCalls = request.mock.calls.length, fileOpens = [...d.opens.entries()];
  const recovered = controller(); await recovered.restore();
  expect((await recovered.get())?.audioReleased).toBe(true); expect((await recovered.get())?.cleanupError).toBeUndefined();
  expect(release).toHaveBeenCalledTimes(2); expect(request).toHaveBeenCalledTimes(providerCalls);
  expect([...d.opens.entries()]).toEqual(fileOpens);
});
it('retries only the acknowledgement if metadata storage fails after local audio was deleted', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  storage.failReleasedOnce = true;
  await choose();
  const result = (await c.get())!;
  expect(result.audioReleased).toBe(true); expect(result.cleanupError).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
  await c.save(result.sessionId);
  expect((await c.get())?.cleanupError).toBeUndefined(); expect(release).toHaveBeenCalledOnce();
  storage.jobs.set(result.sessionId, { ...result, cleanupError: 'An older acknowledgement failed.' });
  const recovered=controller(); await recovered.restore(); await recovered.save(result.sessionId);
  expect((await recovered.get())?.cleanupError).toBeUndefined(); expect(release).toHaveBeenCalledOnce();
});
it('automatic cleanup is bounded and explicit Retry saving needs no renewed folder permission', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  release.mockRejectedValue(new Error('local DB unavailable'));
  const d = await choose(directory('granted'));
  for (let i = 0; i < 4; i++) { const recovered = controller(); await recovered.restore(); }
  expect(release).toHaveBeenCalledTimes(3);
  const j = storage.jobs.get('meeting-a'); j.destination = 'permission_required';
  const recovered = controller(); await recovered.restore();
  release.mockResolvedValue(undefined);
  d.handle.queryPermission = async () => { throw new Error('FSA permission must not be queried for local cleanup'); };
  await recovered.save('meeting-a');
  expect(release).toHaveBeenCalledTimes(4); expect((await recovered.get())?.audioReleased).toBe(true);
  expect(d.opens.get('transcript.txt')).toBe(1); expect(d.opens.get('mom.txt')).toBe(1);
});
it('restore reconciles an already-selected newer folder without deleting audio or writing files', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  release.mockRejectedValueOnce(new Error('local DB unavailable'));
  await choose();
  const fresh = directory();
  storage.destinations.set('meeting-a', { sessionId: 'meeting-a', key: 'new-before-restart', handle: fresh.handle });
  const recovered = controller(); await recovered.restore();
  expect(release).toHaveBeenCalledTimes(1); expect(fresh.files.size).toBe(0);
  const j = (await recovered.get())!;
  expect(j.destinationKey).toBe('new-before-restart');
  expect(Object.values(j.files).every(f => f.phase === 'failed')).toBe(true);
  await recovered.save('meeting-a');
  expect(fresh.files.size).toBe(3); expect(release).toHaveBeenCalledTimes(2);
});
it('retains audio and transcript exports when verification rejects a fabricated decision', async () => {
  request.mockImplementation(async r => reply(r.stage === 'compose' ? draft() : { protocol: 1, accept: false, reason: 'A proposal was treated as a decision.' }));
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  const d = await choose();
  expect((await c.get())?.phase).toBe('failed');
  expect((await c.get())?.minutes).toBeUndefined();
  expect(d.files.has('transcript.txt')).toBe(true); expect(d.files.has('mom.txt')).toBe(false);
  expect(release).not.toHaveBeenCalled();
  request.mockImplementation(async r => reply(r.stage === 'compose' ? draft() : { protocol: 1, accept: true, reason: 'Checked.' }));
  await c.retry('meeting-a'); await finished();
  expect(d.files.has('mom.txt')).toBe(true); expect(d.opens.get('transcript.txt')).toBe(1);
});
it('retries only the failed file and retains successfully closed outputs', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  const d = directory(); d.fail('mom.txt'); await choose(d);
  expect((await c.get())?.files.mom.phase).toBe('failed'); expect(release).not.toHaveBeenCalled();
  d.fail(''); await c.save('meeting-a');
  expect(d.opens.get('transcript.txt')).toBe(1); expect(d.opens.get('mom.txt')).toBe(2);
  expect(release).toHaveBeenCalledTimes(1);
});
it('handles revoked permission without deleting audio and can save after a new folder selection', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a');
  const d = directory('prompt'); await choose(d);
  expect((await c.get())?.destination).toBe('permission_required'); expect(d.files.size).toBe(0);
  d.allow(); await c.save('meeting-a');
  expect((await c.get())?.files.audio.phase).toBe('saved'); expect(release).not.toHaveBeenCalled();
});
it('does not overwrite another existing session folder', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a');
  const j = (await c.get())!, d = directory();
  await d.handle.getDirectoryHandle(j.folderName, { create: true });
  await choose(d);
  expect((await c.get())?.folderName).toBe(j.folderName + '-2');
});
it('supersedes an in-flight old transcript generation and publishes only the latest revision', async () => {
  let resolveOld!: (v: any) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await c.begin(meta()); await c.updateTranscript(transcript());
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const next = { ...transcript(), segments: [...transcript().segments, segment(2, 'Koreksi akhir: tenggat disepakati pada 20 November.')] };
  const corrected = { ...draft(2, next.segments[2].text), bullets: [{ kind: 'decision', text: 'Disepakati tenggat pada 20 November.', sources: [2], quotes: [{ source: 2, text: next.segments[2].text }] }] };
  request.mockImplementation(async r => reply(r.stage === 'compose' ? corrected : { protocol: 1, accept: true, reason: 'Final correction checked.' }));
  await c.updateTranscript(next); resolveOld(reply(draft())); await finished();
  expect((await c.get())?.minutes?.bullets[0].text).toContain('20 November');
  expect(changes.filter(j => j.minutes).every(j => j.minutes!.bullets[0].text.includes('20 November'))).toBe(true);
});
it('does not publish a late result after Discard', async () => {
  let resolve!: (v: any) => void;
  request.mockImplementation(() => new Promise(r => { resolve = r; }));
  await c.begin(meta()); await c.updateTranscript(transcript());
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const discarding = c.discard('meeting-a'); resolve(reply(draft())); await discarding;
  expect(await c.get('meeting-a')).toBeUndefined(); expect(storage.jobs.size).toBe(0);
  expect(release).toHaveBeenCalledTimes(1);
  await expect(c.begin(meta())).rejects.toThrow('discarded');
});
it('restores interrupted work without provider calls and offers recovery for pending writes', async () => {
  await c.begin(meta()); const j = storage.jobs.get('meeting-a');
  j.phase = 'generating'; j.destination = 'selected'; j.audio = 'ready'; j.files.audio.phase = 'writing';
  const recovered = controller(); await recovered.restore();
  expect(request).not.toHaveBeenCalled();
  expect((await recovered.get())?.phase).toBe('failed');
  expect((await recovered.get())?.files.audio.phase).toBe('failed');
});
it('separates simultaneous sessions and keeps the latest reader on the newer session', async () => {
  await c.begin(meta('meeting-a', 1000)); await c.begin(meta('meeting-b', 2000));
  await c.updateTranscript(transcript('meeting-a')); await finished('meeting-a');
  expect((await c.get())?.sessionId).toBe('meeting-b');
  expect((await c.get('meeting-b'))?.minutes).toBeUndefined();
});
it('retains only the latest completed reader and all pending unsaved sessions', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a'); await c.updateTranscript(transcript()); await finished();
  await choose();
  await c.begin(meta('pending', 1500));
  await c.begin(meta('meeting-b', 2000)); await c.audioReady('meeting-b'); await c.updateTranscript(transcript('meeting-b')); await finished('meeting-b');
  await choose(directory(), 'meeting-b');
  await vi.waitFor(async () => expect(await c.get('meeting-a')).toBeUndefined());
  expect(await c.get('pending')).toBeDefined(); expect(await c.get('meeting-b')).toBeDefined();
  expect(storage.destinations.has('meeting-a')).toBe(false);
  expect((await c.get())?.sessionId).toBe('meeting-b');
});
it('empty captured audio produces an honest empty result without a provider call', async () => {
  await c.begin(meta()); await c.audioReady('meeting-a');
  await c.updateTranscript({ ...transcript(), segments: [] }); await finished();
  const d = await choose();
  expect((await c.get())?.phase).toBe('empty'); expect(request).not.toHaveBeenCalled();
  expect(d.files.get('mom.txt')).toContain('No conversation was captured');
});
it('a storage failure rejects begin without affecting or deleting recorded audio', async () => {
  storage.fail = true; await expect(c.begin(meta())).rejects.toThrow('storage unavailable');
  expect(release).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
it('rejects unknown evidence, invalid schema and oversized bullet text without clipping', () => {
  expect(() => validateMinutes(draft(99, 'not in transcript'), transcript().segments)).toThrow();
  expect(() => validateMinutes({ ...draft(), extra: 'invalid' }, transcript().segments)).toThrow();
  const long = draft(); long.bullets[0].text = 'a'.repeat(601);
  expect(() => validateMinutes(long, transcript().segments)).toThrow();
  expect(() => validateMinutes({ ...draft(), bullets: [...draft().bullets, ...draft().bullets] }, transcript().segments)).toThrow();
});
it('processes every part of a long transcript and carries corrections into final consolidation', async () => {
  const segments = Array.from({ length: 26 }, (_, id) => segment(id, `${id}: discussion ${'context '.repeat(450)}`));
  segments.push(segment(26, 'Final correction: deadline is 15 November, not December.'));
  const coverage = new Set<number>();
  const model: MomRequester = async r => {
    const input = JSON.parse(r.messages[1].content);
    if (r.stage === 'extract') {
      const source = input.transcript;
      if (source) for (const s of source) coverage.add(s.id);
      const facts = source ? source.slice(-2).map((s: any) => ({ kind: 'discussion', text: s.text.slice(0, 100), sources: [s.id], quotes: [{ source: s.id, text: s.text.slice(0, 60) }] })) : input.chronologicalLedgers.flatMap((l: any) => l.facts).slice(-12);
      return reply({ language: 'English', facts });
    }
    if (r.stage === 'compose') {
      expect(JSON.stringify(input)).toContain('15 November');
      return reply({ protocol: 1, language: 'English', bullets: [{ kind: 'discussion', text: 'The deadline was corrected to 15 November.', sources: [26], quotes: [{ source: 26, text: segments[26].text }] }], emptyReason: null });
    }
    return reply({ protocol: 1, accept: true, reason: 'Correction and evidence checked.' });
  };
  const result = await generateMinutes({ segments, settings, key: 'test', signal: new AbortController().signal, request: model, save: async () => {} });
  expect([...coverage].sort((a, b) => a - b)).toEqual(segments.map(s => s.id));
  expect(result.checkpoint.coverage).toHaveLength(27);
  expect(result.minutes.bullets[0].text).toContain('15 November');
});
it('every actual review batch receives the complete candidate inventory and explicit focus indexes', async () => {
  const segments = Array.from({ length: 8 }, (_, id) => segment(id, `${id}: ${'spoken context '.repeat(100)}`));
  const bullets = segments.map(s => ({ kind: 'discussion', text: `Point ${s.id}: ${'important detail '.repeat(23)}`, sources: [s.id], quotes: [{ source: s.id, text: s.text.slice(0, 600) }] }));
  const reviews: any[] = [];
  const model: MomRequester = async r => {
    if (r.stage === 'compose') return reply({ protocol: 1, language: 'English', bullets, emptyReason: null });
    if (r.stage === 'extract') throw new Error('This fixture must fit the direct-composition path.');
    const input = JSON.parse(r.messages[1].content); reviews.push(input);
    expect(r.messages[0].content).toContain('ONLY for focusIndexes');
    return reply({ protocol: 1, accept: true, reason: 'Complete inventory and focused evidence checked.' });
  };
  await generateMinutes({ segments, settings, key: 'test', signal: new AbortController().signal, request: model, save: async () => {} });
  expect(reviews.length).toBeGreaterThan(1);
  for (const review of reviews) {
    expect(review.candidateInventory).toHaveLength(8);
    expect(review.candidateInventory.map((b: any) => b.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(review.focusIndexes).toEqual(review.candidate.bullets.map((b: any) => b.index));
    expect(review.focusIndexes.length).toBeLessThan(8);
  }
  expect(reviews.flatMap(r => r.focusIndexes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});
it('splits oversized passages without discarding any Unicode text', () => {
  const source = segment(0, '音声🙂 '.repeat(7000));
  const chunks = transcriptChunks([source]);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flat().map(s => s.text).join('')).toBe(source.text);
  expect(chunks.flat().every(s => s.id === 0)).toBe(true);
});
it('honors backoff and bounds provider attempts to three', async () => {
  const attempts: number[] = [];
  let retries!: Promise<any>;
  let firstAttempt!: () => void;
  const started = new Promise<void>(resolve => { firstAttempt = resolve; });
  const model: MomRequester = async () => { attempts.push(Date.now()); firstAttempt(); throw new AssistantAPIError(503, 20); };
  const cp = { segments: transcript().segments, settings, key: 'test', signal: new AbortController().signal, request: model, save: async () => {} };
  vi.useFakeTimers();
  retries = generateMinutes(cp).catch(e => e);
  // Wait for this request, not a different native-crypto job whose completion can
  // race checkpoint persistence and fake-timer advancement.
  await started;
  await vi.advanceTimersByTimeAsync(10_000);
  await retries;
  expect(attempts).toHaveLength(3);
  expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(2000);
  expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(4000);
});
it('a manual retry preserves the final provider waiting period', async () => {
  vi.useFakeTimers();
  await c.begin(meta());
  const job = storage.jobs.get('meeting-a');
  job.phase = 'failed'; job.transcript = transcript(); job.retryAt = Date.now() + 5000;
  const deadline = job.retryAt;
  const recovered = controller(); await recovered.restore();
  let firstAttempt!: () => void;
  const started = new Promise<void>(resolve => { firstAttempt = resolve; });
  const respond = request.getMockImplementation()!;
  request.mockImplementation(async (...args) => { firstAttempt(); return respond(...args); });
  await recovered.retry('meeting-a');
  await vi.advanceTimersByTimeAsync(4999); expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await started;
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalled(); expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  await vi.waitFor(() => expect(recovered.busy).toBe(false));
});
it('concurrent stale transcript observations cannot move final coverage backwards', async () => {
  await c.begin(meta());
  await Promise.all([
    c.updateTranscript(transcript()),
    c.updateTranscript({ ...transcript(), segments: transcript().segments.slice(0, 1) }),
  ]);
  await finished();
  expect((await c.get())?.transcript?.segments).toHaveLength(2);
  expect((await c.get())?.checkpoint?.coverage).toEqual([0, 1]);
});
it('serializes plain-text exports with factual bullets and approximate passage timestamps', () => {
  expect(minutesText(draft() as any)).toBe('- Disepakati tenggat pada 15 November.\n');
  expect(transcriptText(transcript().segments)).toContain('[00:00:00–00:00:08] Maya');
});
