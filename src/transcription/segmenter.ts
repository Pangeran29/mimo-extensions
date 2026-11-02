import { SAMPLE_RATE, type AudioWindow } from './types';
/** Bounded segmentation glue around Silero probabilities; no file encoding or decoding. */
export class SpeechSegmenter {
  private position = 0;
  private frames: Float32Array[] = [];
  private samples = 0;
  private speaking = false;
  private speechSamples = 0;
  private silentSamples = 0;
  private overlap = false;
  constructor(private emit: (window: AudioWindow) => void) {}
  get bufferedSamples(): number {
    return this.samples;
  }
  get hasSpeech(): boolean {
    return this.speaking;
  }
  push(frame: Float32Array, probability: number): void {
    this.position += frame.length;
    this.frames.push(frame);
    this.samples += frame.length;
    if (probability >= 0.3) {
      this.speaking = true;
      this.speechSamples += frame.length;
      this.silentSamples = 0;
    } else if (probability < 0.25 && this.speaking) this.silentSamples += frame.length;
    if (this.speaking && this.silentSamples >= SAMPLE_RATE * 0.6) {
      this.flush();
      return;
    }
    if (this.speaking && this.samples >= SAMPLE_RATE * 8) {
      const audio = this.concat();
      // Copy the overlap BEFORE emit: its consumer transfers/detaches audio.buffer.
      const tail = audio.slice(-SAMPLE_RATE);
      if (this.speechSamples >= SAMPLE_RATE * 0.25)
        this.emit({
          audio,
          startSample: this.position - audio.length,
          endSample: this.position,
          overlap: this.overlap,
        });
      this.frames = [tail];
      this.samples = tail.length;
      this.overlap = true;
      // Do not submit overlap-only audio when Stop immediately follows a forced split.
      this.speechSamples = 0;
      return;
    }
    if (!this.speaking) {
      while (this.samples > SAMPLE_RATE * 0.4 && this.frames.length > 1)
        this.samples -= this.frames.shift()!.length;
    }
  }
  flush(): void {
    if (this.speaking && this.speechSamples >= SAMPLE_RATE * 0.25) {
      const audio = this.concat();
      this.emit({
        audio,
        startSample: this.position - audio.length,
        endSample: this.position,
        overlap: this.overlap,
      });
    }
    this.clear();
  }
  clear(): void {
    this.frames = [];
    this.samples = 0;
    this.speaking = false;
    this.speechSamples = 0;
    this.silentSamples = 0;
    this.overlap = false;
  }
  private concat(): Float32Array {
    const output = new Float32Array(this.samples);
    let at = 0;
    for (const frame of this.frames) {
      output.set(frame, at);
      at += frame.length;
    }
    return output;
  }
}
export function cleanText(text: string): string {
  return text.replace(/\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]/gi, '').trim();
}
export function removeOverlap(previous: string, next: string, overlapping: boolean): string {
  next = cleanText(next);
  if (!overlapping || !previous || !next) return next;
  const before = previous.trim().split(/\s+/);
  const words = next.split(/\s+/);
  const normalize = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let count = 0;
  for (let n = 1; n <= Math.min(20, before.length, words.length); n++) {
    const a = before.slice(-n).map(normalize).join(' ');
    if (a && a === words.slice(0, n).map(normalize).join(' ')) count = n;
  }
  return words.slice(count).join(' ');
}
