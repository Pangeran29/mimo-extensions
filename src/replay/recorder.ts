import * as db from '../db';
import { MIME, errorText, type Session } from '../types';
import { WriteQueue } from '../write-queue';

/** Records the played stream, not the imported file: Stop exports only its prefix. */
export class ReplayRecorder {
  private recorder?: MediaRecorder;
  private queue?: WriteQueue;
  private session?: Session;
  private completion?: Promise<Session>;
  private failure?: string;
  private stopped?: Promise<void>;

  async start(stream: MediaStream, id: string, createdAt: number, title: string): Promise<void> {
    if (this.recorder) throw new Error('Replay recording is already active.');
    if (!MediaRecorder.isTypeSupported(MIME)) throw new Error('WebM/Opus recording is unavailable.');
    this.session = {
      exportKind: 'meeting-bundle-v1', id, createdAt, sourceTitle: title, tabId: -1,
      filename: `audio-${id}.webm`, status: 'capturing', bytes: 0, chunks: 0,
      durationMs: 0, partial: false, sources: ['mixed'], savedSources: [],
    };
    await db.putSession(this.session);
    this.failure = undefined;
    this.completion = undefined;
    this.queue = new WriteQueue(
      (seq, data) => db.appendChunk(id, seq, data, 'mixed'),
      (error) => { this.failure = errorText(error); },
    );
    this.recorder = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 96_000 });
    this.stopped = new Promise<void>((resolve) => { this.recorder!.onstop = () => resolve(); });
    this.recorder.ondataavailable = (event) => this.queue?.enqueue(event.data, 'mixed');
    this.recorder.onerror = () => { this.failure = 'Replay audio encoder failed.'; };
    this.recorder.start(1000);
  }

  stop(durationMs: number, partial = false): Promise<Session> {
    if (this.completion) return this.completion;
    const recorder = this.recorder;
    const session = this.session;
    if (!recorder || !session) return Promise.reject(new Error('Replay audio was not started.'));
    this.completion = (async () => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      // Encoder errors can make state inactive before final dataavailable/onstop.
      // Keep the original completion listener so that final frame is retained.
      await this.stopped;
      await this.queue?.drain();
      this.recorder = undefined;
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      return db.updateSession(session.id, {
        status: 'ready', durationMs, partial: partial || !!this.failure,
        error: this.failure,
      });
    })();
    return this.completion;
  }
}
