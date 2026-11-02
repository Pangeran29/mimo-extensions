import { trace } from './diagnostics';
import * as db from './db';
import {
  AUDIO_SOURCES,
  MIME,
  errorText,
  filename,
  outputFilename,
  remainingSources,
  type Session,
  type Status,
  type Phase,
} from './types';
import { WriteQueue } from './write-queue';

export class RecorderEngine {
  private phase: Phase = 'idle';
  private current?: Session;
  private error?: string;
  private mic?: MediaStream;
  private tab?: MediaStream;
  private mixed?: MediaStream;
  private context?: AudioContext;
  private recorders: MediaRecorder[] = [];
  private queue?: WriteQueue;
  private startedAt = 0;
  private stopReason?: string;
  private urls = new Map<string, string>();
  private analyzers?: [AnalyserNode, AnalyserNode];
  private buffers?: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
  constructor(
    private changed: () => void,
    private ready: (id: string) => void,
    private transcription?: {
      start: (stream: MediaStream, id: string, context: AudioContext) => Promise<void>;
      stopCapture: () => Promise<void>;
    },
  ) {}
  async status(): Promise<Status> {
    const rows = await db.sessions();
    const live = this.current
      ? (rows.find((row) => row.id === this.current!.id) ?? this.current)
      : undefined;
    return {
      phase: this.phase,
      session: live
        ? {
            ...live,
            durationMs: this.phase === 'recording' ? Date.now() - this.startedAt : live.durationMs,
          }
        : undefined,
      error: this.error,
      retained: rows.filter((row) => row.id !== this.current?.id),
    };
  }
  get busy(): boolean {
    return ['starting', 'recording', 'stopping', 'saving'].includes(this.phase);
  }
  async start(streamId: string, tabId: number, title: string): Promise<void> {
    if (this.busy) throw new Error('A recording is already active.');
    if (!MediaRecorder.isTypeSupported(MIME))
      throw new Error('This Chrome version cannot record WebM/Opus audio. Update Chrome.');
    this.phase = 'starting';
    this.error = undefined;
    this.stopReason = undefined;
    this.current = undefined;
    this.changed();
    let stage = 'tab audio';
    try {
      // Acquire the tab ID immediately: Chrome's single-use stream IDs expire quickly.
      this.tab = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
        } as MediaTrackConstraints,
        video: false,
      });
      // Adapted from TabScribe (MIT); see THIRD_PARTY_NOTICES.md.
      // Restore tab playback before asking for the mic, including on partial startup failures.
      this.context = new AudioContext();
      const tabSource = this.context.createMediaStreamSource(this.tab);
      tabSource.connect(this.context.destination);
      await this.context.resume();
      stage = 'microphone';
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (
        !this.tab.getAudioTracks().some((t) => t.readyState === 'live') ||
        !this.mic.getAudioTracks().some((t) => t.readyState === 'live')
      ) {
        throw new Error(
          'Both the tab and microphone must be available. Reopen the source tab and check microphone access.',
        );
      }
      stage = 'audio setup';
      const micSource = this.context.createMediaStreamSource(this.mic);
      const destination = this.context.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      const tabGain = this.context.createGain();
      tabGain.gain.value = 0.5;
      const micGain = this.context.createGain();
      micGain.gain.value = 0.5;
      tabSource.connect(tabGain).connect(destination);
      micSource.connect(micGain).connect(destination);
      // Only tab audio reaches speakers. Mic monitoring would create feedback.
      this.analyzers = [this.context.createAnalyser(), this.context.createAnalyser()];
      this.analyzers.forEach((a) => (a.fftSize = 256));
      micSource.connect(this.analyzers[0]);
      tabSource.connect(this.analyzers[1]);
      this.buffers = [new Float32Array(256), new Float32Array(256)];
      this.mixed = destination.stream;
      const now = new Date();
      this.current = {
        id: crypto.randomUUID(),
        createdAt: now.getTime(),
        filename: filename(now),
        sourceTitle: title,
        tabId,
        status: 'capturing',
        bytes: 0,
        chunks: 0,
        durationMs: 0,
        partial: false,
        sources: [...AUDIO_SOURCES],
        savedSources: [],
      };
      await db.putSession(this.current);
      const id = this.current.id;
      this.queue = new WriteQueue(
        (seq, data, source) => db.appendChunk(id, seq, data, source),
        (error) => this.stop(error.message),
      );
      // Encode all three live streams directly: no decoding or post-recording transcoding.
      const streams = [this.mixed, this.mic, this.tab];
      let stopped = 0;
      this.recorders = streams.map((stream, index) => {
        const recorder = new MediaRecorder(stream!, { mimeType: MIME, audioBitsPerSecond: 96_000 });
        recorder.ondataavailable = (event) => {
          this.queue?.enqueue(event.data, AUDIO_SOURCES[index]);
        };
        recorder.onstop = () => {
          if (++stopped === streams.length) void this.finalize();
        };
        recorder.onerror = () =>
          this.stop('An audio encoder failed. The retained recording may be incomplete.');
        return recorder;
      });
      for (const track of [...this.tab.getTracks(), ...this.mic.getTracks()]) {
        track.onended = () =>
          this.stop('An audio source disconnected. The recording was stopped and saved.');
      }
      await this.transcription?.start(this.mixed, id, this.context);
      this.recorders.forEach((recorder) => recorder.start(1000));
      this.startedAt = Date.now();
      this.phase = 'recording';
      trace('capture.started', { sessionId: id });
      this.changed();
    } catch (error) {
      await this.release();
      if (this.current) await db.deleteSession(this.current.id).catch(() => {});
      this.current = undefined;
      this.phase = 'error';
      this.error = `Recording could not start (${stage}). ${errorText(error)} Check microphone permission in Settings and macOS, then try again.`;
      this.changed();
      throw new Error(this.error);
    }
  }
  stop(reason?: string): void {
    if (this.phase !== 'recording') return;
    trace('capture.stopped', { sessionId: this.current?.id });
    this.stopReason = reason;
    this.phase = 'stopping';
    this.changed();
    this.current!.durationMs = Date.now() - this.startedAt;
    this.recorders.forEach((recorder) => {
      if (recorder.state !== 'inactive') recorder.stop();
    });
  }
  private async finalize(): Promise<void> {
    const session = this.current;
    if (!session) return;
    // onstop runs after the final dataavailable event, including its queued write.
    await this.queue?.drain();
    await this.release();
    try {
      this.current = await db.updateSession(session.id, {
        status: 'ready',
        durationMs: session.durationMs,
        partial: !!this.stopReason || !!this.queue?.failure,
        error: this.stopReason ?? this.queue?.failure?.message,
      });
      this.phase = 'saving';
      this.changed();
      this.ready(session.id);
    } catch (error) {
      this.phase = 'save-failed';
      this.error = `Could not finalize local audio: ${errorText(error)}. Retained chunks can be retried.`;
      this.changed();
    }
  }
  async export(id: string): Promise<{ url: string; session: Session }> {
    if (['starting', 'recording', 'stopping'].includes(this.phase))
      throw new Error('Stop the current recording before saving another.');
    if (this.phase === 'saving' && this.current?.id !== id)
      throw new Error('Wait for the current download to finish.');
    const session = await db.getSession(id);
    if (!session) throw new Error('Recording no longer exists.');
    this.current = session;
    this.phase = 'saving';
    this.error = undefined;
    this.changed();
    try {
      if (session.status === 'capturing') {
        this.current = await db.updateSession(id, {
          status: 'ready',
          partial: true,
          error: 'Interrupted recording: the last audio may be missing.',
        });
      }
      const source = remainingSources(this.current)[0];
      if (!source) throw new Error('All recording files have already been saved.');
      this.current = await db.updateSession(id, { downloadingSource: source });
      const blob = await db.audioBlob(id, MIME, source);
      const old = this.urls.get(id);
      if (old) URL.revokeObjectURL(old);
      const url = URL.createObjectURL(blob);
      this.urls.set(id, url);
      return { url, session: { ...this.current, filename: outputFilename(this.current, source) } };
    } catch (error) {
      this.phase = 'save-failed';
      this.error = errorText(error);
      this.changed();
      throw error;
    }
  }
  async downloadDone(
    id: string,
    success: boolean,
    error?: string,
    cancelled = false,
  ): Promise<void> {
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    if (cancelled) {
      // Cancel means skip this recording's remaining exports, including separate sources.
      // Previously downloaded files and the separately stored transcript remain untouched.
      await db.deleteSession(id);
      if (this.current?.id === id) {
        this.current = undefined;
        this.phase = 'idle';
        this.error = undefined;
      }
    } else if (success) {
      const remaining = await db.completeDownload(id);
      if (this.current?.id === id) {
        this.current = remaining;
        this.phase = remaining ? 'saving' : 'idle';
        this.error = undefined;
        if (remaining) this.ready(id);
      }
    } else {
      if (await db.getSession(id))
        await db.updateSession(id, { downloadId: undefined, downloadingSource: undefined });
      if (this.current?.id === id) {
        this.phase = 'save-failed';
        this.error = error ?? 'Download interrupted. Retry Save or discard the retained audio.';
      }
    }
    this.changed();
  }
  async discard(id: string): Promise<void> {
    if (this.current?.id === id && this.busy)
      throw new Error('Stop recording or wait for saving before discarding.');
    await db.deleteSession(id);
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    if (this.current?.id === id) {
      this.current = undefined;
      this.phase = 'idle';
      this.error = undefined;
    }
    this.changed();
  }
  levels(): { mic: number; tab: number } {
    if (!this.analyzers || !this.buffers || this.phase !== 'recording') return { mic: 0, tab: 0 };
    const values = this.analyzers.map((a, i) => {
      a.getFloatTimeDomainData(this.buffers![i]);
      const rms = Math.sqrt(
        this.buffers![i].reduce((sum, n) => sum + n * n, 0) / this.buffers![i].length,
      );
      return Math.min(1, rms * 4);
    });
    return { mic: values[0], tab: values[1] };
  }
  private async release(): Promise<void> {
    await this.transcription
      ?.stopCapture()
      .catch((error) => console.error('Transcript detach failed', error));
    for (const recorder of this.recorders) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.recorders = [];
    for (const stream of [this.tab, this.mic, this.mixed])
      stream?.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    this.tab = this.mic = this.mixed = undefined;
    this.analyzers = undefined;
    this.buffers = undefined;
    await this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
