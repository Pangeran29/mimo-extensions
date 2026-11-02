import { emptyAssistant } from './controller';
import {
  DEFAULT_SETTINGS,
  type AssistantSettings,
  type AssistantSnapshot,
  type AnalysisInput,
  type MemoPolicy,
} from './types';
import type { TranscriptSnapshot, TranscriptSegment } from '../transcription/types';
import {
  emptyLive,
  type LiveProposal,
  type LiveReview,
  type LiveResult,
  type Contribution,
} from './live-types';
import { liveContext } from './live-context';
import { validateLive } from './live-schema';
import { AssistantAPIError, retryable } from './errors';
import type { PipelineProgress } from '../live-progress';
interface Runner {
  request<T>(
    type: 'PROPOSE' | 'REVIEW' | 'DEEPER',
    model: AssistantSettings['model'],
    input: AnalysisInput,
    signal: AbortSignal,
  ): Promise<T>;
  close(): void;
}
export class LiveMemoController {
  snapshot: AssistantSnapshot = { ...emptyAssistant(), live: emptyLive() };
  private settings = DEFAULT_SETTINGS;
  private segments: TranscriptSegment[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private deep?: AbortController;
  private epoch = 0;
  private revision = 0;
  private lastStart = -Infinity;
  private failures = 0;
  private notBefore = 0;
  private persistence = Promise.resolve();
  private saving = 0;
  private finishingPersistence = false;
  constructor(
    private runner: Runner,
    private changed: (s: AssistantSnapshot) => void,
    private save: (s: AssistantSnapshot) => Promise<void>,
    private settled: () => void = () => {},
  ) {}
  get busy() {
    return !!this.active || !!this.deep || (this.finishingPersistence && this.saving > 0);
  }
  setMemoPolicy(_policy: MemoPolicy) {} // Baseline policies never change live semantics.
  liveProgress(): PipelineProgress['llm'] {
    return {
      elapsedMs: this.snapshot.analyzingSince
        ? Math.max(0, Date.now() - this.snapshot.analyzingSince)
        : 0,
      state: this.active ? 'running' : 'idle',
      queued: !!this.timer,
      paused: this.snapshot.phase === 'paused',
    };
  }
  private emit(persist = true) {
    const live = this.snapshot.live!;
    const current = live.contributions.find((c) => c.id === live.activeId);
    this.snapshot.summary = current?.body ?? '';
    this.snapshot.question = null;
    this.changed(structuredClone(this.snapshot));
    if (persist) {
      const s = structuredClone(this.snapshot);
      this.saving++;
      this.persistence = this.persistence
        .then(() => this.save(s))
        .catch(() => {
          this.snapshot.analysisError =
            'Live memo could not be saved. Recording and transcription continue.';
          this.changed(structuredClone(this.snapshot));
        })
        .finally(() => {
          this.saving--;
          if (!this.saving) this.finishingPersistence = false;
          if (!this.busy && live.closed) this.settled();
        });
    }
  }
  restore(s: AssistantSnapshot) {
    this.cancel();
    this.snapshot = structuredClone(s);
    this.snapshot.live ??= { ...emptyLive(), legacyNote: s.summary || undefined };
    this.snapshot.live.closed = true;
    this.snapshot.live.stage = undefined;
    if (!s.live) {
      this.snapshot.summary = '';
      this.snapshot.summaries = [];
    }
    this.snapshot.phase = this.settings.enabled ? 'complete' : 'disabled';
    this.snapshot.deeperBusy = false;
    this.snapshot.analyzingSince = undefined;
    this.emit(false);
  }
  configure(settings: AssistantSettings) {
    this.settings = structuredClone(settings);
    this.snapshot.model = settings.model;
    this.snapshot.provider = settings.provider;
    if (!settings.enabled) {
      this.cancel();
      this.snapshot.phase = 'disabled';
    } else if (!this.snapshot.sessionId) this.snapshot.phase = 'ready';
    this.emit();
    this.schedule();
  }
  observe(t: TranscriptSnapshot, recovery = false) {
    if (!t.sessionId) return;
    if (t.sessionId !== this.snapshot.sessionId) {
      if (recovery || t.phase !== 'transcribing') return;
      this.cancel();
      this.snapshot = {
        ...emptyAssistant(this.settings),
        live: emptyLive(),
        sessionId: t.sessionId,
        phase: 'listening',
      };
      this.segments = [];
      this.lastStart = -Infinity;
      this.failures = 0;
      this.notBefore = 0;
    }
    if (
      t.segments.length !== this.segments.length ||
      t.segments.some((s, i) => s.text !== this.segments[i]?.text)
    ) {
      this.revision++;
      // Debounce from the most recent arrival, while preserving the start-rate limit.
      if (!this.active) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    }
    this.segments = structuredClone(t.segments);
    if (this.snapshot.live!.closed || recovery) return;
    this.schedule();
  }
  private schedule() {
    if (
      this.timer ||
      this.active ||
      !this.settings.enabled ||
      this.snapshot.live!.closed ||
      this.snapshot.phase === 'paused' ||
      !this.segments.some((s) => s.id > this.snapshot.lastSegmentId)
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.run();
      },
      Math.max(1000, this.lastStart + 10000 - Date.now(), this.notBefore - Date.now()),
    );
  }
  private cancel() {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
    this.deep?.abort();
    this.deep = undefined;
  }
  private archive(reason: Contribution['archivedReason']) {
    const live = this.snapshot.live!;
    const c = live.contributions.find((c) => c.id === live.activeId);
    if (c) {
      c.archivedAt = Date.now();
      c.archivedReason = reason;
    }
    live.activeId = null;
  }
  async run() {
    if (this.active || this.snapshot.live!.closed || !this.settings.enabled) return;
    const epoch = this.epoch,
      live = this.snapshot.live!,
      session = this.snapshot.sessionId;
    const abort = new AbortController();
    this.active = abort;
    const valid = () =>
      this.epoch === epoch &&
      !abort.signal.aborted &&
      !live.closed &&
      this.snapshot.sessionId === session;
    this.lastStart = Date.now();
    this.snapshot.phase = 'thinking';
    this.snapshot.analyzingSince = Date.now();
    live.stage = 'proposal';
    this.emit(false);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const input = liveContext(this.snapshot, this.segments, this.settings.goal);
      if (!input.newSegmentIds?.length) return;
      deadline = setTimeout(() => abort.abort(), 20000);
      const proposalResult = await this.runner.request<LiveResult<LiveProposal>>(
        'PROPOSE',
        this.settings.model,
        input,
        abort.signal,
      );
      clearTimeout(deadline);
      if (!valid()) return;
      const proposal = validateLive(proposalResult.value, input) as LiveProposal;
      // Commit only the source range passed to stage one, regardless of reviewer context.
      for (const update of proposal.updates) {
        live.memory = live.memory.filter((m) => m.key !== update.key && m.key !== update.replaces);
        live.memory.push({
          ...update,
          topic: update.topic === proposal.topic?.label ? proposal.topic.key : update.topic,
        });
      }
      if (
        proposal.topicChanged ||
        (live.topic && proposal.topic && live.topic.key !== proposal.topic.key)
      )
        this.archive('topic');
      live.topic = proposal.topic;
      live.decision = proposal.decision;
      this.snapshot.lastSegmentId = Math.max(...input.newSegmentIds);
      this.snapshot.version++;
      this.snapshot.updatedAt = Date.now();
      this.snapshot.analysisError = undefined;
      this.failures = 0;
      this.notBefore = 0;
      this.snapshot.retryAt = undefined;
      this.emit();
      if (proposal.candidate) {
        live.stage = 'review';
        this.emit(false);
        const reviewRevision = this.revision,
          feedbackVersion = live.feedbackVersion;
        const reviewInput = liveContext(
          this.snapshot,
          this.segments,
          this.settings.goal,
          proposal.candidate,
        );
        deadline = setTimeout(() => abort.abort(), 10000);
        const result = await this.runner.request<LiveResult<LiveReview>>(
          'REVIEW',
          this.settings.model,
          reviewInput,
          abort.signal,
        );
        clearTimeout(deadline);
        if (
          !valid() ||
          reviewRevision !== this.revision ||
          feedbackVersion !== live.feedbackVersion
        )
          return;
        const review = validateLive(result.value, reviewInput, true) as LiveReview;
        if (review.accept) {
          this.archive('replaced');
          const contribution: Contribution = {
            ...proposal.candidate,
            id: input.requestId!,
            topic: live.topic?.key ?? '',
            createdAt: Date.now(),
          };
          live.contributions.push(contribution);
          live.activeId = contribution.id;
          this.snapshot.lastAnalysis = {
            requestId: input.requestId!,
            version: this.snapshot.version,
            at: Date.now(),
            summaryCharacters: contribution.body.length,
            memoCharacters: contribution.body.length,
            outcome: 'updated',
            model: this.settings.model,
            provider: this.settings.provider,
          };
        }
      }
    } catch (error) {
      if (this.epoch !== epoch || live.closed) return;
      const e =
        error instanceof AssistantAPIError
          ? error
          : new AssistantAPIError(0, 0, abort.signal.aborted ? 'timeout' : 'format');
      this.snapshot.analysisError = e.message;
      // Retry transport/format failures at most twice. A rejected review is never retried.
      if (++this.failures <= 2 && retryable(e)) {
        this.notBefore = Date.now() + Math.max(e.retryAfterMs, 2000 * 2 ** this.failures);
        this.snapshot.retryAt = this.notBefore;
      } else this.snapshot.phase = 'paused';
    } finally {
      clearTimeout(deadline);
      if (this.epoch === epoch) {
        this.active = undefined;
        live.stage = undefined;
        this.snapshot.analyzingSince = undefined;
        if (!live.closed && this.snapshot.phase !== 'paused') this.snapshot.phase = 'listening';
        this.snapshot.message = live.closed
          ? 'Session saved.'
          : live.decision === 'wait'
            ? 'Waiting for enough context.'
            : 'Listening.';
        this.emit();
        this.schedule();
      }
    }
  }
  feedback(sessionId: string, id: string, value: 'useful' | 'not-helpful' | 'dismissed') {
    if (sessionId !== this.snapshot.sessionId) return;
    const live = this.snapshot.live!,
      item = live.contributions.find((c) => c.id === id);
    if (!item) return;
    item.feedback = value;
    live.feedbackVersion++;
    if (value === 'dismissed' && live.activeId === id) this.archive('dismissed');
    this.emit();
  }
  resume() {
    if (!this.snapshot.live!.closed) {
      this.failures = 0;
      this.snapshot.phase = 'listening';
      this.schedule();
    }
  }
  stopCapture() {
    this.finishingPersistence = true;
    this.cancel();
    this.snapshot.live!.closed = true;
    this.snapshot.live!.stage = undefined;
    this.snapshot.deeperBusy = false;
    this.snapshot.analyzingSince = undefined;
    this.snapshot.phase = this.settings.enabled ? 'complete' : 'disabled';
    this.snapshot.message = 'Session saved.';
    this.emit();
  }
  finish() {
    if (!this.snapshot.live!.closed) this.stopCapture();
    else if (!this.busy) this.settled();
  }
  async deeper(sessionId: string) {
    if (sessionId !== this.snapshot.sessionId || this.deep || !this.settings.enabled) return;
    const epoch = this.epoch,
      abort = new AbortController();
    this.deep = abort;
    this.snapshot.deeperBusy = true;
    this.snapshot.deeperError = undefined;
    this.emit(false);
    try {
      const input = liveContext(this.snapshot, this.segments, this.settings.goal);
      const result = await this.runner.request<string>(
        'DEEPER',
        this.settings.model,
        input,
        abort.signal,
      );
      if (epoch === this.epoch && !abort.signal.aborted) this.snapshot.deeper = result;
    } catch {
      if (epoch === this.epoch)
        this.snapshot.deeperError = 'Could not analyze the current context. Try again.';
    } finally {
      if (epoch === this.epoch) {
        this.deep = undefined;
        this.snapshot.deeperBusy = false;
        this.emit();
      }
    }
  }
}
