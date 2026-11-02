import { encodeWav } from './wav';
declare const LISTEN_TRANSCRIPTION_URL: string;
declare const LISTEN_RELAY_TOKEN: string;
export interface RecognitionResult {
  text: string;
  language: string;
  inferenceMs: number;
}
export class ModelClient {
  ready = false;
  private active = new Set<AbortController>();
  constructor(private progress: (message: string) => void = () => {}) {}
  async prepare(): Promise<void> {
    // Service availability must not prevent recording. Failures enter the outbox.
    this.ready = true;
    this.progress('Cloud transcription configured.');
  }
  async transcribe(audio: Float32Array, sessionId: string): Promise<RecognitionResult> {
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 50000);
    const start = performance.now();
    try {
      const response = await fetch(
        typeof LISTEN_TRANSCRIPTION_URL === 'undefined'
          ? 'http://127.0.0.1:8787/transcribe'
          : LISTEN_TRANSCRIPTION_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'audio/wav',
            'X-Listen-Session': sessionId,
            ...(typeof LISTEN_RELAY_TOKEN === 'undefined'
              ? {}
              : { Authorization: `Bearer ${LISTEN_RELAY_TOKEN}` }),
          },
          body: encodeWav(audio),
          signal: controller.signal,
          credentials: 'omit',
        },
      );
      if (!response.ok) throw new Error('Cloud transcription is unavailable.');
      const result = await response.json();
      if (typeof result.text !== 'string' || result.text.length > 20000)
        throw new Error('Invalid response');
      return {
        text: result.text,
        language: typeof result.language === 'string' ? result.language : 'auto',
        inferenceMs: performance.now() - start,
      };
    } catch {
      throw new Error('Cloud transcription is unavailable. Audio is queued for automatic retry.');
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }
  terminate(): void {
    this.ready = false;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
