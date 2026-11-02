import { emptyAssistant } from '../controller';
import {
  DEFAULT_SETTINGS,
  type AssistantSettings,
  type AssistantSnapshot,
  type AnalysisInput,
  type MemoPolicy,
} from '../types';
import type { TranscriptSnapshot, TranscriptSegment } from '../../transcription/types';
import { emptyState, type Proposal, type Review, type Result, type ContributionV2 } from './types';
import { context, migration } from './context';
import { validateV2 } from './schema';
import { AssistantAPIError, retryable } from '../errors';
import type { PipelineProgress } from '../../live-progress';
import { BUILD_ID } from '../../build-info';
import { agentEvent } from '../../agent-diagnostics';
import { trace } from '../../diagnostics';
import { LIVE_PROPOSAL_TIMEOUT_MS, LIVE_V2_REVIEW_TIMEOUT_MS } from '../timing';
interface Runner {
  request<T>(
    type: 'PROPOSE' | 'REVIEW' | 'DEEPER',
    model: AssistantSettings['model'],
    input: AnalysisInput,
    signal: AbortSignal,
  ): Promise<T>;
  close(): void;
}
interface PendingReview {
  proposal: Proposal;
  input: AnalysisInput;
  revision: number;
  feedbackVersion: number;
}
export class LiveMemoController {
  snapshot: AssistantSnapshot = { ...emptyAssistant(), liveV2: emptyState() };
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
  private pendingReview?: PendingReview;
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
    return (
      !!this.active ||
      !!this.deep ||
      !!this.pendingReview ||
      (this.finishingPersistence && this.saving > 0)
    );
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
    const live = this.snapshot.liveV2!;
    const current = live.contributions.find((c) => c.id === live.activeId);
    this.snapshot.summary = live.memo?.text ?? '';
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
    this.snapshot = migration(structuredClone(s));
    this.snapshot.liveV2!.closed = true;
    this.snapshot.liveV2!.stage = undefined;
    this.snapshot.phase = s.phase === 'disabled' ? 'disabled' : 'complete';
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
    } else if (this.snapshot.liveV2!.closed) this.snapshot.phase = 'complete';
    else if (!this.snapshot.sessionId) this.snapshot.phase = 'ready';
    else if (this.snapshot.phase === 'disabled') this.snapshot.phase = 'listening';
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
        liveV2: emptyState(),
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
      this.pendingReview = undefined;
      // Debounce from the most recent arrival, while preserving the start-rate limit.
      if (!this.active) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    }
    this.segments = structuredClone(t.segments);
    if (this.snapshot.liveV2!.closed || recovery) return;
    this.schedule();
  }
  private schedule() {
    if (
      this.timer ||
      this.active ||
      !this.settings.enabled ||
      this.snapshot.liveV2!.closed ||
      this.snapshot.phase === 'paused' ||
      (!this.pendingReview && !this.segments.some((s) => s.id > this.snapshot.lastSegmentId))
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.run();
      },
      Math.max(
        1000,
        this.pendingReview ? 0 : this.lastStart + 10000 - Date.now(),
        this.notBefore - Date.now(),
      ),
    );
  }
  private cancel() {
    this.epoch++;
    this.pendingReview = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
    this.deep?.abort();
    this.deep = undefined;
  }
  private archive(reason: ContributionV2['archivedReason']) {
    const live = this.snapshot.liveV2!;
    const c = live.contributions.find((c) => c.id === live.activeId);
    if (c) {
      c.archivedAt = Date.now();
      c.archivedReason = reason;
    }
    live.activeId = null;
  }
  async run() {
    if (this.active || this.snapshot.liveV2!.closed || !this.settings.enabled) return;
    let pending = this.pendingReview;
    if (
      pending &&
      (pending.revision !== this.revision ||
        pending.feedbackVersion !== this.snapshot.liveV2!.feedbackVersion)
    )
      this.pendingReview = pending = undefined;
    if (!pending && !this.segments.some((s) => s.id > this.snapshot.lastSegmentId)) return;
    const epoch = this.epoch,
      live = this.snapshot.liveV2!,
      session = this.snapshot.sessionId;
    const abort = new AbortController();
    this.active = abort;
    const valid = () =>
      this.epoch === epoch &&
      !abort.signal.aborted &&
      !live.closed &&
      this.snapshot.sessionId === session;
    if (!pending) this.lastStart = Date.now();
    this.snapshot.phase = 'thinking';
    this.snapshot.analyzingSince = Date.now();
    live.stage = pending ? 'review' : 'proposal';
    this.emit(false);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let failureInput: AnalysisInput | undefined;
    let failureStage = live.stage;
    try {
      let input: AnalysisInput;
      let proposal: Proposal;
      if (pending) {
        input = pending.input;
        proposal = pending.proposal;
      } else {
        input = context(this.snapshot, this.segments, this.settings.goal);
        if (!input.newSegmentIds?.length) return;
        failureInput = input;
        trace('ai.proposal_sent', {
          sessionId: session,
          requestId: input.requestId,
          version: input.version,
        });
        deadline = setTimeout(() => abort.abort(), LIVE_PROPOSAL_TIMEOUT_MS);
        const proposalResult = await this.runner.request<Result<Proposal>>(
          'PROPOSE',
          this.settings.model,
          input,
          abort.signal,
        );
        clearTimeout(deadline);
        if (!valid()) return;
        proposal = validateV2(proposalResult.value, input).value as Proposal;
        const normalized = (t: string) => t.replace(/\s+/g, ' ').trim();
        if (
          proposal.memoUpdate.action === 'replace' &&
          live.memo &&
          proposal.topic?.key === live.memo.topic?.key &&
          normalized(proposal.memoUpdate.text!) === normalized(live.memo.text)
        )
          proposal.memoUpdate = { action: 'keep', text: null, sources: [] };
        const current = live.contributions.find((c) => c.id === live.activeId);
        if (
          !proposal.statusUpdate &&
          current?.status === 'relevant' &&
          proposal.topic &&
          proposal.topic.key !== current.topic
        )
          proposal.statusUpdate = {
            contributionId: current.id,
            status: 'previous_topic',
            sources: proposal.topic.sources,
          };
        if (proposal.statusUpdate && current?.status === proposal.statusUpdate.status)
          proposal.statusUpdate = null;
        if (
          proposal.candidate &&
          live.contributions.some(
            (c) => normalized(c.body) === normalized(proposal.candidate!.body),
          )
        ) {
          proposal.candidate = null;
          proposal.decision = 'silent';
        }
        // Commit only the source range passed to stage one, regardless of reviewer context.
        for (const update of proposal.updates) {
          live.memory = live.memory.filter(
            (m) => m.key !== update.key && m.key !== update.replaces,
          );
          live.memory.push({
            ...update,
            topic: update.topic === proposal.topic?.label ? proposal.topic.key : update.topic,
          });
        }
        live.topic = proposal.topic;
        live.decision = proposal.decision;
        this.snapshot.lastSegmentId = Math.max(...input.newSegmentIds);
        this.snapshot.version++;
        this.snapshot.updatedAt = Date.now();
        this.emit();
        if (
          proposal.memoUpdate.action === 'replace' ||
          proposal.candidate ||
          proposal.statusUpdate
        ) {
          pending = {
            proposal,
            input,
            revision: this.revision,
            feedbackVersion: live.feedbackVersion,
          };
          this.pendingReview = pending;
        }
      }
      if (pending) {
        live.stage = 'review';
        failureStage = 'review';
        this.emit(false);
        const reviewRevision = this.revision,
          feedbackVersion = live.feedbackVersion;
        const reviewInput = context(this.snapshot, this.segments, this.settings.goal, proposal);
        failureInput = reviewInput;
        trace('ai.review_sent', {
          sessionId: session,
          requestId: reviewInput.requestId,
          version: reviewInput.version,
        });
        deadline = setTimeout(() => abort.abort(), LIVE_V2_REVIEW_TIMEOUT_MS);
        const result = await this.runner.request<Result<Review>>(
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
        ) {
          if (this.pendingReview === pending) this.pendingReview = undefined;
          return;
        }
        const review = validateV2(result.value, reviewInput, true).value as Review;
        if (this.pendingReview === pending) this.pendingReview = undefined;
        if (review.memo.accept && proposal.memoUpdate.action === 'replace') {
          live.memo = {
            id: input.requestId! + ':memo',
            text: proposal.memoUpdate.text!,
            topic: proposal.topic,
            sources: proposal.memoUpdate.sources,
            createdAt: Date.now(),
            throughSegmentId: this.snapshot.lastSegmentId,
          };
        }
        if (review.status.accept && proposal.statusUpdate) {
          const c = live.contributions.find(
            (c) => c.id === proposal.statusUpdate!.contributionId && c.id === live.activeId,
          );
          const rank = { relevant: 0, previous_topic: 1, answered: 2, corrected: 3 };
          if (
            c &&
            (rank[proposal.statusUpdate.status] >= rank[c.status] ||
              (c.status === 'previous_topic' && proposal.statusUpdate.status === 'relevant'))
          ) {
            c.status = proposal.statusUpdate.status;
            c.statusSources = proposal.statusUpdate.sources;
            c.statusUpdatedAt = Date.now();
          }
        }
        if (review.contribution.accept && proposal.candidate) {
          this.archive('replaced');
          const contribution: ContributionV2 = {
            ...proposal.candidate,
            id: input.requestId!,
            topic: live.topic?.key ?? '',
            createdAt: Date.now(),
            status: 'relevant',
            statusSources: proposal.candidate.sources,
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
      this.snapshot.analysisError = undefined;
      this.failures = 0;
      this.notBefore = 0;
      this.snapshot.retryAt = undefined;
      this.snapshot.lastAnalysis = {
        requestId: input.requestId!,
        version: this.snapshot.version,
        at: Date.now(),
        summaryCharacters: live.memo?.text.length ?? 0,
        memoCharacters: live.memo?.text.length ?? 0,
        outcome: live.memo?.id === input.requestId! + ':memo' ? 'updated' : 'unchanged',
        provider: this.settings.provider,
        model: this.settings.model,
      };
    } catch (error) {
      if (this.epoch !== epoch || live.closed) return;
      if (failureStage === 'review' && pending?.feedbackVersion !== live.feedbackVersion) return;
      const e =
        error instanceof AssistantAPIError
          ? error
          : new AssistantAPIError(0, 0, abort.signal.aborted ? 'timeout' : 'format');
      this.failures++;
      this.snapshot.lastFailure = {
        buildId: BUILD_ID,
        at: Date.now(),
        requestId: failureInput?.requestId ?? '',
        status: e.status,
        category: e.category,
        reason: e.reason,
        validationIssues: e.validationIssues,
        count: this.failures,
      };
      const failure = {
        sessionId: session,
        requestId: failureInput?.requestId,
        version: failureInput?.version,
        status: e.status,
        category: e.category,
        reason: e.reason,
        count: this.failures,
      };
      trace('ai.error', failure);
      trace(failureStage === 'review' ? 'ai.review_error' : 'ai.proposal_error', failure);
      agentEvent(
        session,
        'decision',
        {
          accepted: false,
          outcome: 'error',
          stage: failureStage,
          failure: this.snapshot.lastFailure,
        },
        failureInput?.requestId,
      );
      this.snapshot.analysisError = e.message;
      // Retry transport/format failures at most twice. A rejected review is never retried.
      if (this.failures <= 2 && retryable(e)) {
        this.notBefore = Date.now() + Math.max(e.retryAfterMs, 2000 * 2 ** this.failures);
        this.snapshot.retryAt = this.notBefore;
        trace('ai.retry_scheduled', {
          sessionId: session,
          requestId: failureInput?.requestId,
          durationMs: this.notBefore - Date.now(),
        });
      } else {
        this.notBefore = Math.max(this.notBefore, Date.now() + e.retryAfterMs);
        this.snapshot.phase = 'paused';
        this.snapshot.retryAt = undefined;
      }
    } finally {
      clearTimeout(deadline);
      if (this.epoch === epoch) {
        this.active = undefined;
        live.stage = undefined;
        this.snapshot.analyzingSince = undefined;
        if (!live.closed && this.snapshot.phase !== 'paused') this.snapshot.phase = 'listening';
        this.snapshot.message = live.closed
          ? 'Session saved.'
          : live.decision === 'wait' && !live.memo
            ? 'Waiting for enough context.'
            : 'Listening.';
        this.emit();
        this.schedule();
      }
    }
  }
  feedback(sessionId: string, id: string, value: 'useful' | 'not-helpful' | 'dismissed') {
    if (sessionId !== this.snapshot.sessionId) return;
    const live = this.snapshot.liveV2!,
      item = live.contributions.find((c) => c.id === id);
    if (!item) return;
    item.feedback = value;
    live.feedbackVersion++;
    if (this.pendingReview) {
      this.pendingReview = undefined;
      const failure = this.snapshot.lastFailure;
      if (
        failure &&
        this.snapshot.analysisError ===
          new AssistantAPIError(failure.status, 0, failure.category, failure.reason).message
      )
        this.snapshot.analysisError = undefined;
      this.snapshot.retryAt = undefined;
      if (!this.active) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    }
    if (value === 'dismissed' && live.activeId === id) this.archive('dismissed');
    this.emit();
    this.schedule();
  }
  resume() {
    if (!this.snapshot.liveV2!.closed && this.settings.enabled) {
      this.failures = 0;
      this.snapshot.phase = 'listening';
      this.snapshot.retryAt =
        this.pendingReview || this.segments.some((s) => s.id > this.snapshot.lastSegmentId)
          ? Date.now() +
            Math.max(
              1000,
              this.pendingReview ? 0 : this.lastStart + 10000 - Date.now(),
              this.notBefore - Date.now(),
            )
          : undefined;
      this.emit(false);
      this.schedule();
    }
  }
  stopCapture() {
    this.finishingPersistence = true;
    this.cancel();
    this.snapshot.liveV2!.closed = true;
    this.snapshot.liveV2!.stage = undefined;
    this.snapshot.deeperBusy = false;
    this.snapshot.analyzingSince = undefined;
    this.snapshot.phase = this.settings.enabled ? 'complete' : 'disabled';
    this.snapshot.message = 'Session saved.';
    this.emit();
  }
  finish() {
    if (!this.snapshot.liveV2!.closed) this.stopCapture();
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
      const input = context(this.snapshot, this.segments, this.settings.goal);
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
