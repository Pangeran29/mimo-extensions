import { trace } from '../diagnostics';
import { agentEvent } from '../agent-diagnostics';
import { BUILD_ID } from '../build-info';
import { LiveStageTimer, type PipelineProgress } from '../live-progress';
import { FINAL_ANALYSIS_TIMEOUT_MS } from './timing';
import {
  DEFAULT_SETTINGS,
  DEFAULT_MEMO_POLICY,
  type MemoPolicy,
  type AnalysisInput,
  type AnalysisResult,
  type AssistantSettings,
  type AssistantSnapshot,
  type EvidenceItem,
} from './types';
import type { TranscriptSnapshot, TranscriptSegment } from '../transcription/types';
import { duplicateQuestion, validateAnalysis, normalize } from './schema';
import { AssistantAPIError, formatError, retryable } from './errors';
import { meetingMemo } from './summaries';
export function emptyAssistant(settings = DEFAULT_SETTINGS): AssistantSnapshot {
  return {
    phase: settings.enabled ? 'ready' : 'disabled',
    version: 0,
    summary: '',
    summaries: [],
    question: null,
    memory: [],
    history: [],
    message: settings.enabled
      ? 'AI ready. Waiting for finalized speech.'
      : 'AI is off. Enable it in Settings.',
    model: settings.model,
    provider: settings.provider ?? 'hpop',
    lastSegmentId: -1,
    incomplete: false,
    deeperBusy: false,
    contextGap: false,
  };
}
export function tokenEstimate(value: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3);
}
export function boundMemory(items: EvidenceItem[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const item of [...items].reverse()) {
    if (tokenEstimate([...out, item]) <= 1000) out.unshift(item);
  }
  return out;
}
interface Runner {
  request<T = AnalysisResult>(
    type: 'ANALYZE' | 'DEEPER',
    model: AssistantSettings['model'],
    input: AnalysisInput,
    signal: AbortSignal,
  ): Promise<T>;
  close(): void;
}
export class AssistantController {
  snapshot = emptyAssistant();
  private settings = DEFAULT_SETTINGS;
  private memoPolicy: MemoPolicy = DEFAULT_MEMO_POLICY;
  private attempt = 0;
  private requestTimer = new LiveStageTimer();
  liveProgress(): PipelineProgress['llm'] {
    const request = this.requestTimer.read();
    return {
      ...request,
      queued: !!this.timer,
      paused: this.snapshot.phase === 'paused',
      outcome: request.state === 'done' ? this.snapshot.lastAnalysis?.outcome : undefined,
      retryInMs:
        request.state !== 'running' && this.snapshot.retryAt !== undefined
          ? Math.max(0, this.snapshot.retryAt - Date.now())
          : undefined,
    };
  }
  setMemoPolicy(policy: MemoPolicy): void {
    this.memoPolicy = policy;
  }
  private segments: TranscriptSegment[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private deep?: AbortController;
  private arrivals = new Map<number, number>();
  private requestEpoch = crypto.randomUUID();
  private lastStart = -Infinity;
  private notBefore = 0;
  private failures = 0;
  private closedSession = false;
  private generation = 0;
  private stopping = false;
  private finalDeadline = 0;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private persistence = Promise.resolve();
  private finishingPersistence = false;
  private pendingSave?: AssistantSnapshot;
  private saving = false;
  constructor(
    private runner: Runner,
    private changed: (s: AssistantSnapshot) => void,
    private save: (s: AssistantSnapshot) => Promise<void>,
    private settled: () => void,
  ) {}
  restore(snapshot: AssistantSnapshot): void {
    if (!this.snapshot.sessionId) {
      this.snapshot = structuredClone(snapshot);
      this.closedSession = !!snapshot.sessionId;
    }
  }
  get busy(): boolean {
    return !!(this.active || this.deep || this.timer || this.stopping || this.finishingPersistence);
  }
  configure(settings: AssistantSettings): void {
    this.cancel();
    this.settings = { ...settings };
    this.snapshot = {
      ...this.snapshot,
      phase: settings.enabled
        ? this.closedSession
          ? 'complete'
          : this.snapshot.sessionId
            ? 'listening'
            : 'ready'
        : 'disabled',
      model: settings.model,
      provider: settings.provider ?? 'hpop',
      message: settings.enabled
        ? `AI enabled. Transcript text is sent to ${settings.provider === 'deepinfra' ? 'DeepInfra' : 'HPOP'}.`
        : 'AI is off.',
      deeperBusy: false,
      analyzingSince: undefined,
      retryAt: undefined,
      analysisError: undefined,
    };
    this.emit();
    if (settings.enabled) this.schedule();
    else void this.persistence.finally(() => this.settled());
  }
  private emit(): void {
    const s = structuredClone(this.snapshot);
    this.changed(s);
    this.pendingSave = s;
    this.persist();
  }
  private persist(): void {
    if (this.saving) return;
    this.saving = true;
    this.persistence = (async () => {
      while (this.pendingSave) {
        const s = this.pendingSave;
        this.pendingSave = undefined;
        try {
          await this.save(s);
          agentEvent(
            s.sessionId,
            'saved-memo',
            {
              version: s.version,
              summary: s.summary,
              lastAnalysis: s.lastAnalysis,
              phase: s.phase,
            },
            s.lastAnalysis?.requestId,
          );
        } catch {
          agentEvent(s.sessionId, 'save-failed', { version: s.version }, s.lastAnalysis?.requestId);
          this.snapshot.message = 'Analysis is live but could not be saved locally.';
          this.changed(structuredClone(this.snapshot));
        }
      }
    })().finally(() => {
      this.saving = false;
      if (this.pendingSave) this.persist();
    });
  }

  observe(t: TranscriptSnapshot, resumeRecovered = false): void {
    if (!t.sessionId) return;
    if (t.sessionId !== this.snapshot.sessionId) {
      this.cancel();
      this.closedSession = false;
      this.segments = [];
      this.arrivals.clear();
      this.requestTimer.reset();
      this.lastStart = -Infinity;
      this.failures = 0;
      this.notBefore = 0;
      this.snapshot = {
        ...emptyAssistant(this.settings),
        sessionId: t.sessionId,
        phase: this.settings.enabled ? 'listening' : 'disabled',
      };
      this.emit();
    }
    if (this.closedSession) {
      // Saved transcripts are history. Only the durable transcription recovery
      // path may explicitly reopen the same session for newly recovered audio.
      if (!resumeRecovered) return;
      this.closedSession = false;
      this.snapshot.phase = this.settings.enabled ? 'listening' : 'disabled';
    }
    this.snapshot.incomplete ||= t.incomplete;
    this.segments = t.segments.filter((s) => s.text.trim());
    for (const s of this.segments) {
      if (s.id > this.snapshot.lastSegmentId && !this.arrivals.has(s.id))
        this.arrivals.set(s.id, Date.now());
    }
    while (this.arrivals.size > 256) {
      this.arrivals.delete(this.arrivals.keys().next().value!);
      this.snapshot.contextGap = true;
    }

    if (this.settings.enabled && this.snapshot.phase !== 'paused') this.schedule();
  }
  private input(): AnalysisInput {
    const end = this.segments.at(-1)?.endMs ?? 0;
    let recent = this.segments.filter((s) => end - s.endMs <= 90000);
    let omitted = this.segments.some(
      (s) => s.id > this.snapshot.lastSegmentId && !recent.some((r) => r.id === s.id),
    );
    while (recent.length > 1 && tokenEstimate(recent) > 2500) {
      recent.shift();
      omitted = true;
    }
    if (recent.length && tokenEstimate(recent) > 2500) {
      recent = [{ ...recent[0] }];
      while (tokenEstimate(recent) > 2500 && recent[0].text.length) {
        const chars = Array.from(recent[0].text);
        recent[0].text = chars.slice(-Math.floor(chars.length * 0.75)).join('');
      }
      omitted = true;
    }
    const recentSummaries: string[] = [];
    for (const revision of this.snapshot.summaries
      .filter((item) => item.format !== 'memo')
      .slice(-8)
      .reverse()) {
      if (tokenEstimate([...recentSummaries, revision.summary]) <= 700)
        recentSummaries.unshift(revision.summary);
    }
    return {
      sessionId: this.snapshot.sessionId!,
      version: this.snapshot.version + 1,
      goal: this.settings.goal,
      memoPolicy: this.memoPolicy,
      validationFeedback: this.failures ? this.snapshot.lastFailure?.validationIssues : undefined,
      segments: recent,
      memory: this.snapshot.memory,
      history: this.snapshot.history.slice(-10),
      contextGap: this.snapshot.contextGap || omitted,
      previousSummary: meetingMemo(this.snapshot),
      newSegmentIds: recent.filter((s) => s.id > this.snapshot.lastSegmentId).map((s) => s.id),
      recentSummaries,
    };
  }
  private schedule(): void {
    if (
      !this.settings.enabled ||
      !this.snapshot.sessionId ||
      this.active ||
      this.timer ||
      this.snapshot.phase === 'paused' ||
      this.snapshot.phase === 'complete' ||
      !this.segments.some((s) => s.id > this.snapshot.lastSegmentId)
    )
      return;
    const wait = Math.max(150, this.lastStart + 2000 - Date.now(), this.notBefore - Date.now());
    if (this.stopping && Date.now() + wait >= this.finalDeadline) {
      this.complete();
      return;
    }
    trace('ai.queued', {
      sessionId: this.snapshot.sessionId,
      version: this.snapshot.version + 1,
      durationMs: wait,
    });
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.run();
      },
      Math.min(wait, 2147483647),
    );
  }
  private async run(): Promise<void> {
    const generation = this.generation;
    const input = this.input();
    input.requestId = `${input.sessionId}:${this.requestEpoch}:${++this.attempt}`;
    agentEvent(
      input.sessionId,
      'input',
      {
        type: 'automatic',
        provider: this.settings.provider ?? 'hpop',
        model: this.settings.model,
        input,
        availableSegmentIds: this.segments.map((s) => s.id),
        omittedSegmentIds: this.segments
          .filter((s) => !input.segments.some((i) => i.id === s.id))
          .map((s) => s.id),
        shortenedSegmentIds: input.segments
          .filter((s) => this.segments.find((i) => i.id === s.id)?.text !== s.text)
          .map((s) => s.id),
      },
      input.requestId,
    );
    trace('ai.attempt', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      policy: this.memoPolicy,
      model: this.settings.model,
      count: input.segments.length,
    });
    const latest = this.segments.at(-1)?.id ?? -1;
    const availableAt = Math.min(Date.now(), ...this.arrivals.values());
    const abort = new AbortController();
    this.active = abort;
    this.lastStart = Date.now();
    this.requestTimer.start();
    this.snapshot.phase = this.stopping ? 'finishing' : 'thinking';
    this.snapshot.analyzingSince = this.lastStart;
    this.snapshot.retryAt = undefined;
    this.emit();
    try {
      const result = await this.runner.request('ANALYZE', this.settings.model, input, abort.signal);
      if (generation !== this.generation || abort.signal.aborted) {
        agentEvent(
          input.sessionId,
          'decision',
          { accepted: false, outcome: 'stale-or-cancelled' },
          input.requestId,
        );
        return;
      }
      const analysis = validateAnalysis(result.analysis, input);
      this.requestTimer.finish('done');
      trace('ai.validated', {
        sessionId: input.sessionId,
        requestId: input.requestId,
        version: input.version,
        empty: !analysis.summary.trim(),
        count: analysis.summary.trim().length,
        inputTokens: result.usage?.input,
        outputTokens: result.usage?.output,
      });
      this.snapshot.version = input.version;
      this.snapshot.lastSegmentId = latest;
      const previousSummary = meetingMemo(this.snapshot);
      const summary = analysis.summary.trim();
      const changed = !!summary && normalize(summary) !== normalize(previousSummary);
      this.snapshot.summary = summary || previousSummary;
      this.snapshot.updatedAt = Date.now();
      this.snapshot.lastAnalysis = {
        requestId: input.requestId!,
        version: input.version,
        provider: this.settings.provider ?? 'hpop',
        model: this.settings.model,
        at: this.snapshot.updatedAt,
        summaryCharacters: summary.length,
        memoCharacters: this.snapshot.summary.length,
        outcome: !summary ? 'empty' : changed ? 'updated' : 'unchanged',
      };
      agentEvent(
        input.sessionId,
        'decision',
        {
          accepted: true,
          analysis,
          outcome: this.snapshot.lastAnalysis.outcome,
          memo: this.snapshot.summary,
          usage: result.usage,
          latencyMs: result.latencyMs,
          firstTokenMs: result.firstTokenMs,
        },
        input.requestId,
      );
      this.snapshot.analysisError = undefined;
      this.snapshot.latencyMs = Date.now() - availableAt;
      for (const id of this.arrivals.keys()) if (id <= latest) this.arrivals.delete(id);
      this.snapshot.contextGap = input.contextGap;
      this.failures = 0;
      this.notBefore = 0;
      const memory = new Map(this.snapshot.memory.map((i) => [normalize(i.key), i]));
      for (const update of analysis.updates) {
        memory.set(normalize(update.key), update);
        if (update.kind === 'resolved') {
          for (const h of this.snapshot.history)
            if (normalize(h.issueKey) === normalize(update.key)) h.feedback = 'resolved';
          if (
            this.snapshot.question &&
            normalize(this.snapshot.question.issueKey) === normalize(update.key)
          )
            this.snapshot.question = null;
        }
      }
      this.snapshot.memory = boundMemory([...memory.values()]);
      if (changed) {
        trace('memo.committed', {
          sessionId: input.sessionId,
          requestId: input.requestId,
          version: input.version,
        });
        // One current document, replaced atomically only after a validated response.
        this.snapshot.summaries = [
          {
            format: 'memo',
            version: input.version,
            createdAt: this.snapshot.updatedAt,
            throughMs: input.segments.at(-1)?.endMs,
            summary,
            memory: structuredClone(this.snapshot.memory),
            evidenceSegmentIds: [
              ...new Set([
                ...this.snapshot.summaries.flatMap((item) => item.evidenceSegmentIds),
                ...(input.newSegmentIds ?? []),
                ...analysis.updates.flatMap((item) => item.evidenceSegmentIds),
              ]),
            ],
          },
        ];
      }
      const q = analysis.question;
      if (
        q &&
        !duplicateQuestion(q, this.snapshot.history) &&
        !this.snapshot.memory.some(
          (i) => normalize(i.key) === normalize(q.issueKey) && i.kind === 'resolved',
        )
      ) {
        const record = {
          ...q,
          feedback: 'shown' as const,
          createdAt: Date.now(),
        };
        this.snapshot.question = record;
        this.snapshot.history = [...this.snapshot.history, record].slice(-10);
      }
      this.snapshot.message = input.contextGap
        ? 'Some discussion fell outside the context window. Suggestions may miss earlier details.'
        : `Connected to ${this.settings.provider === 'deepinfra' ? 'DeepInfra' : 'HPOP'} · complete result validated`;
      this.snapshot.phase = this.stopping ? 'finishing' : 'listening';
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) {
        agentEvent(
          input.sessionId,
          'decision',
          {
            accepted: false,
            outcome: 'cancelled',
            note: 'No memo commit; raw response may be partial or unavailable.',
          },
          input.requestId,
        );
        trace('ai.cancelled', {
          sessionId: input.sessionId,
          requestId: input.requestId,
          version: input.version,
        });
        return;
      }
      this.requestTimer.finish('failed');
      const e = formatError(error);
      this.failures++;
      this.snapshot.lastFailure = {
        buildId: BUILD_ID,
        at: Date.now(),
        requestId: input.requestId!,
        status: e.status,
        category: e.category,
        reason: e.reason,
        validationIssues: e.validationIssues,
        count: this.failures,
      };
      agentEvent(
        input.sessionId,
        'decision',
        {
          accepted: false,
          outcome: 'rejected',
          failure: this.snapshot.lastFailure,
          memoRetained: this.snapshot.summary,
        },
        input.requestId,
      );
      trace('ai.error', {
        sessionId: input.sessionId,
        requestId: input.requestId,
        version: input.version,
        status: e.status,
        category: e.category,
        reason: e.reason,
        count: this.failures,
      });
      this.snapshot.message = e.message;
      this.snapshot.analysisError = e.message;
      this.snapshot.phase = retryable(e) ? 'listening' : 'paused';
      // Keep recovering throughout a live session, but slow persistent failures to
      // at most one request per minute. Never defeat a provider's Retry-After.
      const backoff =
        this.failures < 3 ? 1000 * 2 ** this.failures : this.failures === 3 ? 30000 : 60000;
      this.notBefore = Date.now() + Math.max(e.retryAfterMs, backoff);
      this.snapshot.retryAt = this.snapshot.phase === 'paused' ? undefined : this.notBefore;
      trace(this.snapshot.phase === 'paused' ? 'ai.paused' : 'ai.retry_scheduled', {
        sessionId: input.sessionId,
        requestId: input.requestId,
        durationMs: this.notBefore - Date.now(),
      });
      if (this.snapshot.phase !== 'paused') {
        this.snapshot.message += ' Notes will retry automatically.';
        this.snapshot.analysisError = this.snapshot.message;
      }
      if (Date.now() - this.lastStart > 6000 || this.failures >= 2) this.snapshot.contextGap = true;
    } finally {
      if (generation === this.generation) {
        this.active = undefined;
        this.snapshot.analyzingSince = undefined;
        this.emit();
        if (this.stopping) this.complete();
        else this.schedule();
      }
    }
  }
  feedback(sessionId: string, issueKey: string, feedback: 'useful' | 'dismissed'): void {
    if (sessionId !== this.snapshot.sessionId) return;
    this.snapshot.history = this.snapshot.history.map((h) =>
      h.issueKey === issueKey ? { ...h, feedback } : h,
    );
    if (this.snapshot.question?.issueKey === issueKey) {
      if (feedback === 'dismissed') this.snapshot.question = null;
      else this.snapshot.question.feedback = feedback;
    }
    this.emit();
  }
  resume(): void {
    if (!this.settings.enabled || this.closedSession) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.failures = 0;
    this.notBefore = 0;
    this.snapshot.phase = this.stopping ? 'finishing' : 'listening';
    this.snapshot.message = 'Retrying AI…';
    this.snapshot.retryAt = undefined;
    this.snapshot.analysisError = undefined;
    this.emit();
    this.schedule();
  }
  async deeper(sessionId: string): Promise<void> {
    if (
      !this.settings.enabled ||
      this.deep ||
      this.snapshot.phase === 'complete' ||
      sessionId !== this.snapshot.sessionId ||
      this.stopping
    )
      return;
    const generation = this.generation;
    const abort = new AbortController();
    this.deep = abort;
    const input = this.input();
    input.requestId = `${input.sessionId}:${this.requestEpoch}:deeper:${++this.attempt}`;
    agentEvent(
      input.sessionId,
      'input',
      {
        type: 'deeper',
        provider: this.settings.provider ?? 'hpop',
        model: this.settings.model,
        input,
      },
      input.requestId,
    );
    this.snapshot.deeperBusy = true;
    this.snapshot.deeperError = undefined;
    this.emit();
    try {
      const text = await this.runner.request<string>(
        'DEEPER',
        this.settings.model,
        input,
        abort.signal,
      );
      if (generation === this.generation && !abort.signal.aborted) {
        this.snapshot.deeper = text;
        agentEvent(
          input.sessionId,
          'decision',
          { accepted: true, type: 'deeper', text },
          input.requestId,
        );
      }
    } catch (error) {
      const failure = formatError(error);
      agentEvent(
        input.sessionId,
        'decision',
        {
          accepted: false,
          type: 'deeper',
          outcome: abort.signal.aborted ? 'cancelled' : 'rejected',
          reason: failure.reason,
          category: failure.category,
          status: failure.status,
        },
        input.requestId,
      );
      if (generation === this.generation && !abort.signal.aborted)
        this.snapshot.deeperError =
          error instanceof AssistantAPIError ? error.message : 'Deeper analysis failed.';
    } finally {
      if (generation === this.generation) {
        this.deep = undefined;
        this.snapshot.deeperBusy = false;
        this.emit();
      }
    }
  }
  stopCapture(): void {
    this.deep?.abort();
    this.snapshot.deeperBusy = false;
  }
  finish(): void {
    if (this.stopping || this.snapshot.phase === 'complete') return;
    this.stopCapture();
    if (this.active) {
      this.generation++;
      this.requestTimer.finish('cancelled');
      this.active.abort();
      this.active = undefined;
    }
    if (!this.settings.enabled || !this.snapshot.sessionId) {
      this.runner.close();
      this.finishPersistence();
      return;
    }
    this.stopping = true;
    this.finalDeadline = Date.now() + FINAL_ANALYSIS_TIMEOUT_MS;
    this.snapshot.phase = 'finishing';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.finishTimer = setTimeout(() => this.complete(), FINAL_ANALYSIS_TIMEOUT_MS);
    if (!this.active && !this.segments.some((s) => s.id > this.snapshot.lastSegmentId))
      this.complete();
    else this.schedule();
  }
  private complete(): void {
    if (this.stopping && this.segments.some((s) => s.id > this.snapshot.lastSegmentId)) {
      this.snapshot.incomplete = true;
      this.snapshot.message =
        'Final AI update did not finish. Saved analysis covers earlier speech.';
    }
    this.cancel();
    this.closedSession = true;
    this.snapshot.phase = this.settings.enabled ? 'complete' : 'disabled';
    this.snapshot.deeperBusy = false;
    this.snapshot.analyzingSince = undefined;
    this.snapshot.retryAt = undefined;
    this.emit();
    this.runner.close();
    this.finishPersistence();
  }
  private finishPersistence(): void {
    this.finishingPersistence = true;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.snapshot.message =
          'Final analysis could not be saved locally. Earlier saved analysis may remain.';
        this.changed(structuredClone(this.snapshot));
        resolve();
      }, 2000);
    });
    void Promise.race([this.persistence, deadline]).finally(() => {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.finishingPersistence = false;
        this.settled();
      }
    });
  }
  private cancel(): void {
    this.generation++;
    this.finishingPersistence = false;
    this.requestTimer.finish('cancelled');
    this.active?.abort();
    this.deep?.abort();
    this.active = undefined;
    this.deep = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.finishTimer);
    this.timer = undefined;
    this.stopping = false;
  }
}
