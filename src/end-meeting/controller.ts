import type { AssistantSettings } from '../assistant/types';
import { normalizeSettings, providerOf } from '../assistant/providers';
import { AssistantAPIError } from '../assistant/errors';
import type { TranscriptSnapshot } from '../transcription/types';
import type { EndMeetingJob, EndMeetingMeta, ExportFile } from './types';
import { claimDestinationCleanup, deleteJob, getDestinationRecord, getJob, listJobs, putJob, releaseDestinationCleanup, setBundleDirectory } from './store';
import { generateMinutes, minutesText, MomValidationError, transcriptHash, transcriptText } from './mom';
import { EndConnectionError, type MomRequester } from './provider';

interface Hooks {
  changed: (job: EndMeetingJob) => void;
  settled: () => void;
  loadAudio: (sessionId: string) => Promise<Blob>;
  releaseAudio: (sessionId: string) => Promise<void>;
  event?: (sessionId: string, kind: string, data: unknown) => void;
  request?: MomRequester;
}
function fileStates(): EndMeetingJob['files'] {
  return { audio: { phase: 'pending' }, transcript: { phase: 'pending' }, mom: { phase: 'pending' } };
}
function stem(meta: EndMeetingMeta): string {
  const d = new Date(meta.createdAt), pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${meta.sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'session'}`;
}
function aborted(): never { throw new DOMException('Cancelled', 'AbortError'); }
function safeFailure(error: unknown): string {
  if (error instanceof AssistantAPIError) {
    if (error.status === 401 || error.status === 403) return 'The AI connection was rejected. Check Settings, then retry meeting notes.';
    if (error.category === 'timeout') return 'Preparing meeting notes took too long. Audio and transcript are retained; retry the notes.';
    if (error.status === 429) return 'The AI service is busy. Audio and transcript are retained; retry after the waiting period.';
    if (error.category === 'format') return 'The model returned invalid meeting notes. Audio and transcript are retained; retry the notes.';
    return 'The AI service is unavailable. Audio and transcript are retained; retry meeting notes.';
  }
  if (error instanceof MomValidationError || error instanceof EndConnectionError) return error.message;
  return 'Meeting notes could not be completed. Your session is retained; try again.';
}
function exportFailure(error: unknown): string {
  if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Folder access is needed. Choose the meeting folder again.';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'The destination has no space. Free space or choose another folder, then retry.';
  return 'This file could not be saved. The local session is retained; retry saving.';
}

/** Session-keyed post-capture work. It never reopens or mutates live-v2 state. */
export class EndMeetingController {
  private jobs = new Map<string, EndMeetingJob>();
  private connections = new Map<string, string>();
  private generations = new Map<string, AbortController>();
  private generationTasks = new Map<string, Promise<void>>();
  private exportTasks = new Map<string, Promise<void>>();
  private exportSignals = new Map<string, AbortController>();
  private writes = new Map<string, Promise<void>>();
  private discarded = new Set<string>();
  private beginnings = new Map<string, Promise<EndMeetingJob>>();
  private rerun = new Set<string>();
  private transcriptTasks = new Map<string, Promise<void>>();
  private resave = new Set<string>();
  private serial: Promise<void> = Promise.resolve();
  private maintenance = 0;
  constructor(private hooks: Hooks) {}
  get busy(): boolean { return this.generationTasks.size > 0 || this.exportTasks.size > 0 || this.maintenance > 0; }
  configure(settings: AssistantSettings, key = ''): void {
    this.connections.set(providerOf(settings), key);
  }
  private current(job: EndMeetingJob): boolean { return this.jobs.get(job.sessionId) === job && !this.discarded.has(job.sessionId); }
  private event(job: EndMeetingJob, kind: string, data: unknown = {}): void {
    if (!this.current(job)) return;
    try { this.hooks.event?.(job.sessionId, kind, data); } catch {}
  }
  private async publish(job: EndMeetingJob): Promise<void> {
    if (!this.current(job)) aborted();
    job.updatedAt = Date.now(); job.revision++;
    const snapshot = structuredClone(job);
    const task = (this.writes.get(job.sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.current(job)) aborted();
      await putJob(snapshot);
    });
    this.writes.set(job.sessionId, task);
    await task;
    if (this.current(job)) { try { this.hooks.changed(snapshot); } catch {} }
  }
  private async pruneCompleted(): Promise<void> {
    this.maintenance++;
    try {
      const completed = (await listJobs()).filter(job => job.audioReleased && ['ready', 'empty'].includes(job.phase) && Object.values(job.files).every(f => f.phase === 'saved'));
      // Research replay history is retained separately; production stores only the latest completed reader plus unfinished jobs.
      for (const job of completed.slice(1)) {
        if (this.generationTasks.has(job.sessionId) || this.exportTasks.has(job.sessionId)) continue;
        await deleteJob(job.sessionId);
        this.jobs.delete(job.sessionId);
      }
    } finally { this.maintenance--; }
  }
  async get(id?: string): Promise<EndMeetingJob | undefined> {
    if (id) return getJob(id);
    const stored = await listJobs();
    return stored[0];
  }
  async restore(): Promise<void> {
    for (const job of await listJobs()) {
      this.jobs.set(job.sessionId, job);
      let changed = false;
      const destination = await getDestinationRecord(job.sessionId);
      if (destination && destination.key !== job.destinationKey && !job.audioReleased) {
        job.destinationKey = destination.key; job.directoryName = destination.handle.name;
        job.destination = 'selected'; job.files = fileStates(); job.cleanupAttempts = 0; job.cleanupError = undefined; changed = true;
      }
      if (job.phase === 'generating') {
        job.phase = 'failed'; job.error = 'Preparing meeting notes was interrupted. Retry to continue the saved work.'; changed = true;
      }
      for (const file of Object.values(job.files)) if (file.phase === 'writing') {
        file.phase = 'failed'; file.error = 'Saving was interrupted. Retry saving the retained session.'; changed = true;
      }
      for (const kind of ['audio', 'transcript', 'mom'] as ExportFile[]) {
        const eligible = kind === 'audio' ? job.audio === 'ready' : kind === 'transcript'
          ? job.transcript?.phase === 'complete' && !job.transcript.incomplete : !!job.minutes;
        if (job.destination === 'selected' && eligible && job.files[kind].phase === 'pending') {
          job.files[kind] = { phase: 'failed', error: 'Saving is pending. Retry saving the retained session.' }; changed = true;
        }
      }
      // Opening either extension is read-only: model requests and writes resume on an explicit action.
      if (changed) await this.publish(job);
      // Local cleanup is safe to retry without provider requests or filesystem writes.
      if (!job.audioReleased && Object.values(job.files).every(f => f.phase === 'saved') && (job.cleanupAttempts ?? 0) < 3)
        await this.cleanupAudio(job);
    }
    await this.pruneCompleted().catch(() => {});
    try { this.hooks.settled(); } catch {}
  }
  begin(meta: EndMeetingMeta): Promise<EndMeetingJob> {
    const pending = this.beginnings.get(meta.sessionId); if (pending) return pending;
    const work = this.initialize(meta).finally(() => this.beginnings.delete(meta.sessionId));
    this.beginnings.set(meta.sessionId, work); return work;
  }
  private async initialize(meta: EndMeetingMeta): Promise<EndMeetingJob> {
    if (this.discarded.has(meta.sessionId)) throw new Error('This session was discarded.');
    const existing = this.jobs.get(meta.sessionId) ?? await getJob(meta.sessionId);
    if (existing) { this.jobs.set(meta.sessionId, existing); return structuredClone(existing); }
    const name = stem(meta);
    const destination = await getDestinationRecord(meta.sessionId);
    const normalized = normalizeSettings(meta.settings);
    const job: EndMeetingJob = {
      sessionId: meta.sessionId, createdAt: meta.createdAt, sourceTitle: meta.sourceTitle,
      durationMs: Math.max(0, meta.durationMs), reason: meta.reason,
      settings: { enabled: normalized.enabled, provider: normalized.provider, model: normalized.model, goal: normalized.goal, benchmarkPassed: false }, ...(meta.replayRunId ? { replayRunId: meta.replayRunId } : {}),
      protocol: 1, updatedAt: Date.now(), revision: 0, phase: 'waiting_transcript', audio: 'pending',
      destination: destination ? 'selected' : 'missing', directoryName: destination?.handle.name,
      destinationKey: destination?.key, folderName: `Mimo-${name}`, audioFilename: `audio-${name}.webm`, files: fileStates(),
    };
    this.jobs.set(meta.sessionId, job);
    await this.publish(job);
    this.event(job, 'started', { reason: job.reason, durationMs: job.durationMs });
    return structuredClone(job);
  }
  private async ensure(id: string): Promise<EndMeetingJob | undefined> {
    if (this.discarded.has(id)) return;
    let job = this.jobs.get(id);
    if (!job) { job = await getJob(id); if (job) this.jobs.set(id, job); }
    return job;
  }
  async audioReady(id: string, error?: string): Promise<void> {
    const job = await this.ensure(id); if (!job) return;
    job.audio = error ? 'failed' : 'ready';
    job.audioError = error ? 'Audio finalization failed. Retained recording data can be recovered.' : undefined;
    if (error) job.files.audio = { phase: 'failed', error: job.audioError };
    await this.publish(job);
    this.event(job, 'audio-final', { available: !error });
    await this.save(id);
  }
  updateTranscript(snapshot: TranscriptSnapshot): Promise<void> {
    if (!snapshot.sessionId) return Promise.resolve();
    const copy = structuredClone(snapshot), id = snapshot.sessionId;
    const work = (this.transcriptTasks.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.observeTranscript(copy));
    this.transcriptTasks.set(id, work);
    return work;
  }
  private async observeTranscript(snapshot: TranscriptSnapshot): Promise<void> {
    if (!snapshot.sessionId) return;
    const job = await this.ensure(snapshot.sessionId); if (!job) return;
    if (job.transcript && snapshot.segments.length < job.transcript.segments.length) return;
    if (job.transcript && JSON.stringify(job.transcript) === JSON.stringify(snapshot)) return;
    const final = snapshot.phase === 'complete' && !snapshot.incomplete;
    const hash = final ? await transcriptHash(snapshot.segments.filter(s => s.text.trim())) : undefined;
    if (hash && hash === job.transcriptHash && job.transcript?.phase === 'complete') return;
    if (job.minutes || job.phase === 'generating') {
      if (!final || hash === job.transcriptHash) return;
      this.generations.get(job.sessionId)?.abort();
      if (this.generationTasks.has(job.sessionId)) this.rerun.add(job.sessionId);
      delete job.minutes; delete job.checkpoint;
      job.files.transcript = { phase: 'pending' }; job.files.mom = { phase: 'pending' };
    }
    job.transcript = structuredClone(snapshot);
    job.transcriptHash = hash;
    job.phase = final ? 'generating' : 'waiting_transcript';
    job.error = snapshot.incomplete || snapshot.phase === 'failed' ? 'The transcript is incomplete. Meeting notes will wait for transcription recovery.' : undefined;
    await this.publish(job);
    if (final) {
      this.event(job, 'transcript-final', { segments: snapshot.segments.length, throughSegmentId: snapshot.segments.at(-1)?.id, hash });
      void this.startGeneration(job).catch(() => {});
      void this.save(job.sessionId).catch(() => {});
    }
  }
  private startGeneration(job: EndMeetingJob): Promise<void> {
    const existing = this.generationTasks.get(job.sessionId);
    if (existing) return existing;
    const abort = new AbortController();
    this.generations.set(job.sessionId, abort);
    const work = this.serial.catch(() => {}).then(async () => {
      if (!this.current(job) || abort.signal.aborted) return;
      try {
        const wait = Math.max(0, (job.retryAt ?? 0) - Date.now());
        if (wait) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
        });
        if (!this.current(job) || abort.signal.aborted) return;
        const provider = providerOf(job.settings);
        const key = this.connections.get(provider);
        if (job.transcript!.segments.some(s => s.text.trim()) && (key === undefined || (provider === 'hpop' && !key))) throw new AssistantAPIError(401);
        const inputHash = job.transcriptHash;
        job.phase = 'generating'; job.error = undefined; job.retryAt = undefined;
        await this.publish(job);
        const result = await generateMinutes({
          segments: job.transcript!.segments, settings: job.settings, key: key ?? '', signal: abort.signal,
          checkpoint: job.checkpoint, request: this.hooks.request,
          save: async checkpoint => {
            if (!this.current(job) || abort.signal.aborted || inputHash !== job.transcriptHash) aborted();
            job.checkpoint = checkpoint; await this.publish(job);
          },
          event: (kind, data) => this.event(job, `mom-${kind}`, data),
          backoff: async retryAt => {
            if (!this.current(job) || abort.signal.aborted) aborted();
            job.retryAt = retryAt; await this.publish(job);
          },
        });
        if (!this.current(job) || abort.signal.aborted || inputHash !== job.transcriptHash) return;
        job.minutes = result.minutes; job.checkpoint = result.checkpoint;
        job.phase = result.minutes.bullets.length ? 'ready' : 'empty'; job.error = undefined; job.retryAt = undefined;
        await this.publish(job);
        this.event(job, 'mom-ready', { bullets: result.minutes.bullets.length, language: result.minutes.language, coveredSegmentCount: result.checkpoint.coverage.length });
        await this.save(job.sessionId);
      } catch (error) {
        if (!this.current(job) || abort.signal.aborted) return;
        job.phase = 'failed'; job.error = safeFailure(error);
        await this.publish(job);
        this.event(job, 'mom-failed', { status: error instanceof AssistantAPIError ? error.status : 0 });
      }
    }).finally(async () => {
      if (this.generations.get(job.sessionId) === abort) this.generations.delete(job.sessionId);
      this.generationTasks.delete(job.sessionId);
      if (this.rerun.delete(job.sessionId) && this.current(job) && job.phase === 'generating')
        void this.startGeneration(job).catch(() => {});
      await this.pruneCompleted().catch(() => {});
      try { this.hooks.settled(); } catch {}
    });
    this.generationTasks.set(job.sessionId, work);
    this.serial = work;
    return work;
  }
  async retry(id: string): Promise<void> {
    const job = await this.ensure(id); if (!job) return;
    if (job.transcript?.phase === 'complete' && !job.transcript.incomplete && ['failed', 'generating'].includes(job.phase)) {
      void this.startGeneration(job).catch(() => {});
    } else await this.save(id);
  }
  async save(id: string): Promise<void> {
    const existing = this.exportTasks.get(id);
    if (existing) {
      this.resave.add(id);
      const latest = await getDestinationRecord(id);
      if (latest && latest.key !== this.jobs.get(id)?.destinationKey) this.exportSignals.get(id)?.abort();
      return existing;
    }
    const abort = new AbortController(); this.exportSignals.set(id, abort);
    const work = Promise.resolve().then(async () => {
      const job = await this.ensure(id); if (job) await this.exportJob(job, abort.signal);
    }).finally(async () => {
      this.exportTasks.delete(id); this.exportSignals.delete(id);
      if (this.resave.delete(id) && !this.discarded.has(id)) void this.save(id).catch(() => {});
      await this.pruneCompleted().catch(() => {});
      try { this.hooks.settled(); } catch {}
    });
    this.exportTasks.set(id, work);
    return work;
  }
  private async destinationCurrent(job: EndMeetingJob, key: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.current(job) || signal?.aborted) return false;
    const latest = await getDestinationRecord(job.sessionId);
    if (latest?.key === key) return true;
    this.resave.add(job.sessionId);
    return false;
  }
  private async cleanupAudio(job: EndMeetingJob): Promise<void> {
    if (!this.current(job)) return;
    if (job.audioReleased) {
      if (job.cleanupError) { job.cleanupError = undefined; await this.publish(job); }
      return;
    }
    if (!job.destinationKey || !Object.values(job.files).every(f => f.phase === 'saved')) return;
    const key = job.destinationKey;
    let claimed = false;
    this.maintenance++;
    try {
      if (!await this.destinationCurrent(job, key) || !await claimDestinationCleanup(job.sessionId, key)) return;
      claimed = true;
      job.cleanupAttempts = (job.cleanupAttempts ?? 0) + 1;
      await this.publish(job);
      await this.hooks.releaseAudio(job.sessionId);
      if (!this.current(job)) return;
      job.audioReleased = true; job.cleanupError = undefined; await this.publish(job);
    } catch {
      // Deleting audio and recording its acknowledgement use different stores.
      // A transient metadata failure after a successful deletion is not another
      // cleanup failure; retry only the acknowledgement, never retain a false warning.
      if (this.current(job) && job.audioReleased) {
        job.cleanupError = undefined;
        await this.publish(job);
        return;
      }
      if (claimed && !job.audioReleased) await releaseDestinationCleanup(job.sessionId, key).catch(() => {});
      if (!this.current(job)) return;
      job.cleanupError = 'All three files are saved. Local audio cleanup needs a retry; use Retry saving.';
      await this.publish(job);
    } finally { this.maintenance--; }
  }
  private async exportJob(job: EndMeetingJob, signal: AbortSignal): Promise<void> {
    const id = job.sessionId;
    const destination = await getDestinationRecord(id);
    if (!destination || !this.current(job) || signal.aborted) return;
    if (job.destinationKey !== destination.key) {
      if (job.audioReleased) return;
      job.destinationKey = destination.key; job.files = fileStates(); job.cleanupAttempts = 0; job.cleanupError = undefined;
    }
    // Already-confirmed files need only local DB cleanup, even if folder write permission expired.
    if (Object.values(job.files).every(f => f.phase === 'saved') && job.cleanupError) {
      await this.cleanupAudio(job); return;
    }
    job.directoryName = destination.handle.name; job.destination = 'selected';
    const handle = destination.handle as FileSystemDirectoryHandle & { queryPermission?: (options: { mode: 'readwrite' }) => Promise<string> };
    if (handle.queryPermission && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      job.destination = 'permission_required'; await this.publish(job); return;
    }
    await this.publish(job);
    let directory = destination.bundle;
    try {
      if (!directory) {
        const base = job.folderName;
        let candidate = base;
        for (let n = 1; ; n++) {
          try { await handle.getDirectoryHandle(candidate); candidate = `${base}-${n + 1}`; }
          catch (e) { if (e instanceof DOMException && e.name === 'NotFoundError') break; throw e; }
          if (n > 1000) throw new Error('No unused session folder name.');
        }
        if (!this.current(job) || signal.aborted) return;
        directory = await handle.getDirectoryHandle(candidate, { create: true });
        job.folderName = candidate;
        await setBundleDirectory(id, destination.key, directory);
        await this.publish(job);
      }
    } catch (error) {
      if (!await this.destinationCurrent(job, destination.key, signal)) return;
      if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) job.destination = 'permission_required';
      for (const file of Object.values(job.files)) if (file.phase !== 'saved') { file.phase = 'failed'; file.error = exportFailure(error); }
      await this.publish(job); return;
    }
    for (const kind of ['audio', 'transcript', 'mom'] as ExportFile[]) {
      if (!await this.destinationCurrent(job, destination.key, signal)) return;
      if (job.files[kind].phase === 'saved') continue;
      if (kind === 'audio' && job.audio !== 'ready') continue;
      if (kind === 'transcript' && (job.transcript?.phase !== 'complete' || job.transcript.incomplete)) continue;
      if (kind === 'mom' && !job.minutes) continue;
      let writable: FileSystemWritableFileStream | undefined;
      const sourceHash = job.transcriptHash;
      const minutes = job.minutes;
      const cancel = () => { void writable?.abort().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        job.files[kind] = { phase: 'writing' }; await this.publish(job);
        const blob = kind === 'audio' ? await this.hooks.loadAudio(id) : new Blob([kind === 'transcript' ? transcriptText(job.transcript!.segments) : minutesText(job.minutes!)], { type: 'text/plain;charset=utf-8' });
        if (!this.current(job) || signal.aborted) return;
        const filename = kind === 'audio' ? job.audioFilename : `${kind}.txt`;
        const file = await directory.getFileHandle(filename, { create: true });
        writable = await file.createWritable();
        if (!this.current(job) || signal.aborted) { await writable.abort(); return; }
        // Blob-backed chunks stream to disk; no whole-recording ArrayBuffer/base64 allocation.
        const reader = blob.stream().getReader();
        try {
          for (;;) {
            if (!this.current(job) || signal.aborted) aborted();
            const { value, done } = await reader.read(); if (done) break;
            await writable.write(value as Uint8Array<ArrayBuffer>);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (kind !== 'audio' && (sourceHash !== job.transcriptHash || (kind === 'mom' && minutes !== job.minutes))) {
          await writable.abort(); writable = undefined;
          job.files[kind] = { phase: 'pending' }; this.resave.add(id); await this.publish(job); return;
        }
        if (!await this.destinationCurrent(job, destination.key, signal)) { await writable.abort(); writable = undefined; return; }
        await writable.close(); writable = undefined;
        if (!this.current(job) || signal.aborted) return;
        if (!await this.destinationCurrent(job, destination.key, signal)) return;
        if (kind !== 'audio' && (sourceHash !== job.transcriptHash || (kind === 'mom' && minutes !== job.minutes))) {
          job.files[kind] = { phase: 'pending' }; this.resave.add(id); await this.publish(job); return;
        }
        job.files[kind] = { phase: 'saved', bytes: blob.size }; await this.publish(job);
        this.event(job, 'file-saved', { file: kind, bytes: blob.size });
      } catch (error) {
        await writable?.abort().catch(() => {});
        if (!await this.destinationCurrent(job, destination.key, signal)) return;
        job.files[kind] = { phase: 'failed', error: exportFailure(error) };
        if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) job.destination = 'permission_required';
        await this.publish(job);
        this.event(job, 'file-failed', { file: kind });
      } finally { signal.removeEventListener('abort', cancel); }
    }
    if (await this.destinationCurrent(job, destination.key, signal)) await this.cleanupAudio(job);
  }
  async discard(id: string): Promise<void> {
    this.discarded.add(id);
    this.generations.get(id)?.abort(); this.exportSignals.get(id)?.abort();
    await this.generationTasks.get(id)?.catch(() => {});
    await this.exportTasks.get(id)?.catch(() => {});
    await this.writes.get(id)?.catch(() => {});
    await this.transcriptTasks.get(id)?.catch(() => {});
    await this.hooks.releaseAudio(id);
    await deleteJob(id); this.jobs.delete(id);
    try { this.hooks.settled(); } catch {}
  }
}
