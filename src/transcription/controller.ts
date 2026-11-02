import { trace } from '../diagnostics';
import { selectBatch, BATCH_SECONDS, type AudioBatch } from './batch';
import { LiveStageTimer, type PipelineProgress } from '../live-progress';
import type { Model } from '@ricky0123/vad-web/dist/models/common';
import { SileroV5 } from '@ricky0123/vad-web/dist/models/v5';
import { ort } from '@ricky0123/vad-web/dist/real-time-vad';
import { ModelClient } from './client';
import { SpeechSegmenter, removeOverlap } from './segmenter';
import {
  loadTranscript,
  recoveredTranscript,
  saveTranscript,
  pendingWindows,
  persistWindow,
  commitWindows,
  type PendingWindow,
} from './store';
import { SAMPLE_RATE, type AudioWindow, type TranscriptSnapshot } from './types';
import { errorText } from '../types';

const MAX_AUDIO = 30 * SAMPLE_RATE;
export class Transcriber {
  snapshot: TranscriptSnapshot = {
    phase: 'unavailable',
    segments: [],
    incomplete: false,
    lagMs: 0,
    modelReady: false,
    message: 'Cloud transcription starts when you listen.',
  };
  private client?: ModelClient;
  private preparing?: Promise<void>;
  private vad?: Model;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private sink?: GainNode;
  private frames: Float32Array[] = [];
  private framesSamples = 0;
  private processingFrames = false;
  private frameDrain?: Promise<void>;
  private segmenter?: SpeechSegmenter;
  private windows: PendingWindow[] = [];
  private pendingWrites: Promise<void> = Promise.resolve();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private wakeRetry?: () => void;
  private retryCount = 0;
  private queuedSamples = 0;
  private stagedSamples = 0;
  private inFlightSamples = 0;
  private inFlightWindowCount = 0;
  private recognizing = false;
  private inferenceDrain?: Promise<void>;
  private accepting = false;
  private persisted: Promise<void> = Promise.resolve();
  private clock?: ReturnType<typeof setInterval>;
  private inferenceStartedAt = 0;
  private identity = 0;
  private firstSpeech = false;
  private requestTimer = new LiveStageTimer();
  private lastWindowMs = 0;
  liveProgress(): Pick<PipelineProgress, 'sessionId' | 'audio' | 'asr'> {
    const request = this.requestTimer.read();
    return {
      sessionId: this.snapshot.sessionId,
      audio: {
        state: !this.accepting ? 'stopped' : this.segmenter?.hasSpeech ? 'collecting' : 'waiting',
        bufferedMs: ((this.segmenter?.bufferedSamples ?? 0) / SAMPLE_RATE) * 1000,
        lastWindowMs: this.lastWindowMs,
      },
      asr: {
        ...request,
        queued: Math.max(
          0,
          this.windows.length - (request.state === 'running' ? this.inFlightWindowCount : 0),
        ),
        retryInMs:
          request.state === 'failed' && this.snapshot.retryAt !== undefined
            ? Math.max(0, this.snapshot.retryAt - Date.now())
            : undefined,
      },
    };
  }
  private initialized: Promise<void>;
  private cleanup: Promise<void> = Promise.resolve();
  private finishing?: Promise<void>;
  constructor(
    private changed: (snapshot: TranscriptSnapshot, ephemeral?: boolean) => void,
    private settled: () => void,
    private batchSeconds = BATCH_SECONDS,
  ) {
    this.initialized = loadTranscript()
      .then(async (stored) => {
        if (stored) this.snapshot = recoveredTranscript(stored);
        const jobs = await pendingWindows();
        if (jobs.length) {
          this.windows = jobs;
          this.queuedSamples = jobs.reduce((n, j) => n + j.audio.length, 0);
          this.snapshot = {
            ...this.snapshot,
            sessionId: jobs[0].sessionId,
            phase: 'recovering',
            pendingWindows: jobs.length,
            message: 'Recovering queued speech automatically…',
          };
          this.client = new ModelClient();
          await this.client.prepare();
          this.pumpInference();
          this.finishing = this.finish().finally(() => {
            this.finishing = undefined;
          });
        }
      })
      .catch(() => {});
  }
  async status(): Promise<TranscriptSnapshot> {
    await this.initialized;
    return { ...this.snapshot, audioQueueMs: (this.buffered() / SAMPLE_RATE) * 1000 };
  }
  get busy(): boolean {
    return (
      !!this.finishing ||
      this.accepting ||
      this.recognizing ||
      ['loading', 'finishing', 'recovering'].includes(this.snapshot.phase) ||
      this.windows.length > 0
    );
  }
  async prepare(): Promise<void> {
    await this.initialized;
    if (this.preparing) return this.preparing;
    if (this.client?.ready && this.vad) {
      trace('model.prepared', { cached: true });
      return;
    }
    if (this.busy) throw new Error('Wait until transcription has finished.');
    trace('model.preparing', { cached: false });
    this.preparing = this.load().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }
  private async load(): Promise<void> {
    this.publish({
      phase: 'loading',
      message: 'Preparing cloud transcription…',
      modelReady: false,
    });
    try {
      this.requestTimer.finish('cancelled');
      this.client?.terminate();
      this.client = new ModelClient();
      await this.client.prepare();
      await this.cleanup;
      ort.env.wasm.wasmPaths = new URL('vad-ort/', location.href).href;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      this.vad = await SileroV5.new(ort, async () => {
        const response = await fetch(new URL('vad/silero_vad_v5.onnx', location.href));
        if (!response.ok) throw new Error('The packaged speech detector could not be loaded.');
        return response.arrayBuffer();
      });
      trace('model.prepared', { cached: false });
      this.publish({ phase: 'ready', message: 'Cloud transcription ready.', modelReady: true });
    } catch (error) {
      this.fail(errorText(error));
      throw error;
    }
  }
  async start(stream: MediaStream, sessionId: string, context: AudioContext): Promise<void> {
    await this.initialized;
    if ((await pendingWindows()).length || this.busy)
      throw new Error('Wait for queued speech to recover before starting another session.');
    const identity = ++this.identity;
    const preparationError = this.snapshot.phase === 'failed' ? this.snapshot.message : undefined;
    this.snapshot = {
      phase: 'unavailable',
      message: preparationError,
      sessionId,
      segments: [],
      incomplete: false,
      lagMs: 0,
      modelReady: !!this.client?.ready,
    };
    this.firstSpeech = false;
    this.requestTimer.reset();
    this.lastWindowMs = 0;
    this.windows = [];
    this.queuedSamples = 0;
    this.inFlightSamples = 0;
    this.frames = [];
    this.framesSamples = 0;
    if (!this.client?.ready || !this.vad) {
      this.publish({
        message: this.snapshot.message ?? 'Recording only. Cloud transcription could not start.',
      });
      return;
    }
    try {
      this.vad.reset_state();
      let nextWindowId = 0;
      this.segmenter = new SpeechSegmenter((window) => {
        window.traceId = nextWindowId++;
        this.lastWindowMs = (window.audio.length / SAMPLE_RATE) * 1000;
        trace('vad.window', {
          sessionId,
          windowId: window.traceId,
          startMs: (window.startSample / SAMPLE_RATE) * 1000,
          endMs: (window.endSample / SAMPLE_RATE) * 1000,
        });
        const job: PendingWindow = {
          ...window,
          pendingId: `${sessionId}:${window.startSample}`,
          sessionId,
        };
        if ((this.queuedSamples + this.stagedSamples + job.audio.length) * 4 > 128 * 1024 * 1024) {
          this.fail(
            'Transcription recovery storage is full. Recording continues; unqueued speech remains only in the recording.',
          );
          return;
        }
        this.stagedSamples += job.audio.length;
        this.pendingWrites = this.pendingWrites
          .then(async () => {
            if (identity !== this.identity) return;
            const persisted = this.persisted.then(() =>
              persistWindow(structuredClone(this.snapshot), job),
            );
            this.persisted = persisted;
            await persisted;
            if (identity !== this.identity) return;
            this.stagedSamples -= job.audio.length;
            this.windows.push(job);
            this.queuedSamples += job.audio.length;
            this.publish({ pendingWindows: this.windows.length }, false);
            this.pumpInference();
          })
          .catch(() =>
            this.fail(
              'Speech could not be queued locally. Recording continues; the transcript is incomplete.',
            ),
          );
      });
      await context.audioWorklet.addModule(new URL('vad/vad.worklet.bundle.min.js', location.href));
      if (identity !== this.identity) return;
      this.node = new AudioWorkletNode(context, 'vad-helper-worklet', {
        processorOptions: { frameSamples: 512 },
      });
      this.source = context.createMediaStreamSource(stream);
      this.sink = context.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node).connect(this.sink).connect(context.destination);
      this.accepting = true;
      this.node.port.onmessage = ({ data }) => {
        if (!this.accepting || identity !== this.identity || data.message !== 'AUDIO_FRAME') return;
        const frame = new Float32Array(data.data);
        this.frames.push(frame);
        this.framesSamples += frame.length;
        if (this.framesSamples > MAX_AUDIO) {
          this.fail(
            'Transcription audio queue is full. Recording continues; the transcript is incomplete.',
          );
          return;
        }
        this.pumpFrames(identity);
      };
      this.publish({
        phase: 'transcribing',
        modelReady: true,
        activity: 'waiting',
        message: 'Listening for speech…',
      });
      this.clock = setInterval(() => {
        if (!this.busy) return;
        if (this.snapshot.phase === 'recovering') {
          this.publish({ lagMs: (this.buffered() / SAMPLE_RATE) * 1000 }, false, true);
          return;
        }
        // Queue lag excludes silence and includes time spent inside an in-flight model call.
        const lagMs = (this.buffered() / SAMPLE_RATE) * 1000;
        const slow =
          lagMs > 10000 || (this.recognizing && Date.now() - this.inferenceStartedAt > 10000);
        this.publish(
          {
            lagMs,
            activity: this.recognizing
              ? 'recognizing'
              : this.segmenter?.hasSpeech
                ? 'speech'
                : 'waiting',
            message: slow
              ? `Transcription is about ${Math.ceil(lagMs / 1000)} seconds behind.`
              : this.recognizing
                ? 'Transcribing speech…'
                : 'Listening for speech…',
          },
          false,
          true,
        );
      }, 1000);
    } catch (error) {
      this.fail(`Speech processing could not start: ${errorText(error)}. Recording continues.`);
    }
  }
  private buffered(): number {
    return (
      this.framesSamples +
      this.queuedSamples +
      this.stagedSamples +
      (this.segmenter?.bufferedSamples ?? 0)
    );
  }
  private pumpFrames(identity: number): void {
    if (this.processingFrames) return;
    this.processingFrames = true;
    this.frameDrain = (async () => {
      while (this.frames.length && identity === this.identity) {
        const frame = this.frames.shift()!;
        this.framesSamples -= frame.length;
        const probabilities = await this.vad!.process(frame);
        if (identity !== this.identity) break;
        if (!this.firstSpeech && probabilities.isSpeech >= 0.3) {
          this.firstSpeech = true;
          trace('vad.first_speech', { sessionId: this.snapshot.sessionId });
        }
        this.segmenter?.push(frame, probabilities.isSpeech);
        // Emit activity changes, not every audio frame. ASR and AI run independently.
        const activity = this.recognizing
          ? 'recognizing'
          : this.segmenter?.hasSpeech
            ? 'speech'
            : 'waiting';
        if (activity !== this.snapshot.activity) this.publish({ activity }, false, true);
      }
    })()
      .catch((error) =>
        this.fail(`Speech detection failed: ${errorText(error)}. Recording continues.`),
      )
      .finally(() => {
        this.processingFrames = false;
      });
  }
  private pumpInference(): void {
    if (this.recognizing || !this.windows.length || !this.client?.ready) return;
    const identity = this.identity;
    this.recognizing = true;
    this.inferenceDrain = (async () => {
      let batch: AudioBatch | undefined;
      while (this.windows.length && identity === this.identity) {
        batch ??= selectBatch(this.windows, this.batchSeconds);
        if (!batch) break;
        const window = batch.jobs[0];
        this.inFlightSamples = batch.audio.length;
        this.inFlightWindowCount = batch.jobs.length;

        this.inferenceStartedAt = Date.now();
        this.requestTimer.start();
        this.publish({ activity: 'recognizing' }, false, true);
        trace('asr.started', { sessionId: this.snapshot.sessionId, windowId: window.traceId });
        let result;
        try {
          result = await this.client!.transcribe(batch.audio, batch.sessionId);
          this.requestTimer.finish('done');
        } catch {
          this.requestTimer.finish('failed');
          if (identity !== this.identity) break;
          const delay = Math.min(30000, 2000 * 2 ** Math.min(this.retryCount++, 4));
          this.publish({
            phase: 'recovering',
            retryAt: Date.now() + delay,
            pendingWindows: this.windows.length,
            message: this.accepting
              ? 'Cloud transcription is unavailable. Recording continues; queued speech will retry automatically.'
              : 'Cloud transcription is unavailable. Your audio is retained; queued speech will retry automatically.',
          });
          trace('asr.retry', {
            sessionId: window.sessionId,
            windowId: window.traceId,
            durationMs: delay,
          });
          await new Promise<void>((resolve) => {
            this.wakeRetry = resolve;
            this.retryTimer = setTimeout(resolve, delay);
          });
          this.wakeRetry = undefined;
          this.retryTimer = undefined;
          continue;
        }
        this.retryCount = 0;
        trace('asr.complete', {
          sessionId: this.snapshot.sessionId,
          windowId: window.traceId,
          durationMs: result.inferenceMs,
          empty: !result.text.trim(),
        });
        this.inFlightSamples = 0;
        if (identity !== this.identity) break;
        const previous = this.snapshot.segments.slice(-1)[0]?.text ?? '';
        const text = removeOverlap(previous, result.text, window.overlap);
        const commit = this.persisted.then(async () => {
          const segments = [...this.snapshot.segments];
          if (text)
            segments.push({
              id: segments.length,
              sessionId: window.sessionId,
              startMs: (batch!.startSample / SAMPLE_RATE) * 1000,
              endMs: (batch!.endSample / SAMPLE_RATE) * 1000,
              text,
            });
          await commitWindows({ ...structuredClone(this.snapshot), segments }, batch!.jobs);
          this.snapshot = { ...this.snapshot, segments };
        });
        this.persisted = commit;
        await commit;
        this.windows.splice(0, batch.jobs.length);
        this.queuedSamples -= batch.jobs.reduce((n, job) => n + job.audio.length, 0);
        this.inFlightWindowCount = 0;
        batch = undefined;
        trace('transcript.delivered', {
          sessionId: this.snapshot.sessionId,
          segmentId: text ? this.snapshot.segments.at(-1)?.id : undefined,
          windowId: window.traceId,
          count: text.length,
          empty: !text,
        });
        this.publish({
          phase: this.accepting ? 'transcribing' : 'finishing',
          retryAt: undefined,
          pendingWindows: this.windows.length,
          message: this.accepting ? 'Listening for speech…' : 'Finishing queued speech…',
          lastInferenceMs: result.inferenceMs,
        });
      }
    })()
      .catch((error) => {
        if (identity === this.identity)
          this.fail(
            `Cloud recognition could not be saved: ${errorText(error)}. Recording continues.`,
          );
      })
      .finally(() => {
        if (identity === this.identity) {
          this.recognizing = false;
          this.inFlightWindowCount = 0;
          this.inFlightSamples = 0;
          this.publish({ activity: this.segmenter?.hasSpeech ? 'speech' : 'waiting' }, false, true);
          if (this.windows.length) this.pumpInference();
        }
      });
  }
  /** Detach our audio nodes only; never stop shared stream tracks or close the recorder's context. */
  async stopCapture(): Promise<void> {
    this.accepting = false;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.postMessage('SPEECH_STOP');
      this.node.disconnect();
      this.node = undefined;
    }
    this.source?.disconnect();
    this.source = undefined;
    this.sink?.disconnect();
    this.sink = undefined;
    await this.frameDrain;
    this.segmenter?.flush();
    await this.pendingWrites;
    if (['transcribing', 'finishing', 'recovering'].includes(this.snapshot.phase)) {
      if (this.snapshot.phase !== 'recovering')
        this.publish({ phase: 'finishing', message: 'Finishing the last speech…' });
      this.finishing ??= this.finish().finally(() => {
        this.finishing = undefined;
      });
    }
  }
  private async finish(): Promise<void> {
    try {
      await this.pendingWrites;
      while (this.windows.length || this.recognizing) {
        this.pumpInference();
        await this.inferenceDrain;
      }
      if (['finishing', 'recovering'].includes(this.snapshot.phase) && !this.windows.length)
        this.publish({
          phase: 'complete',
          activity: 'waiting',
          message: 'Transcription complete.',
          lagMs: 0,
        });
    } catch (error) {
      this.fail(errorText(error));
    } finally {
      if (this.clock) clearInterval(this.clock);
      this.clock = undefined;
      this.requestTimer.finish('cancelled');
      this.client?.terminate();
      this.client = undefined;
      this.snapshot.modelReady = false;
      await this.vad?.release().catch(() => {});
      this.vad = undefined;
      this.publish({ modelReady: false });
      await this.persisted;
      this.finishing = undefined;
      this.settled();
    }
  }
  /** Release resources on document teardown; durable windows remain recoverable. */
  async dispose(): Promise<void> {
    this.fail('Transcription interrupted. Queued speech will recover when Listen reopens.');
    await Promise.allSettled([
      this.pendingWrites,
      this.inferenceDrain,
      this.frameDrain,
      this.finishing,
      this.persisted,
    ]);
  }
  private fail(message: string): void {
    trace('asr.error', { sessionId: this.snapshot.sessionId, category: 'recognition' });
    ++this.identity;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.wakeRetry?.();
    this.wakeRetry = undefined;
    this.accepting = false;
    this.recognizing = false;
    this.inFlightWindowCount = 0;
    this.frames = [];
    this.windows = [];
    this.framesSamples = this.queuedSamples = this.inFlightSamples = this.stagedSamples = 0;
    this.segmenter?.clear();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.postMessage('SPEECH_STOP');
      this.node.disconnect();
      this.node = undefined;
    }
    this.source?.disconnect();
    this.source = undefined;
    this.sink?.disconnect();
    this.sink = undefined;
    this.requestTimer.finish('cancelled');
    this.client?.terminate();
    this.client = undefined;
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    this.publish({
      phase: 'failed',
      message,
      incomplete: !!this.snapshot.sessionId,
      modelReady: false,
      activity: 'waiting',
    });
    const vad = this.vad;
    this.vad = undefined;
    this.cleanup = (this.frameDrain ?? Promise.resolve())
      .then(() => vad?.release())
      .catch(() => {});
  }
  private publish(patch: Partial<TranscriptSnapshot>, persist = true, ephemeral = false): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed(this.snapshot, ephemeral);
    if (persist) {
      this.persisted = this.persisted
        .then(() => saveTranscript(structuredClone(this.snapshot)))
        .catch(() => {
          this.snapshot = {
            ...this.snapshot,
            incomplete: true,
            message:
              'Transcript could not be saved locally. Copy the visible text before closing Chrome.',
          };
          this.changed(this.snapshot);
        });
    }
  }
}
