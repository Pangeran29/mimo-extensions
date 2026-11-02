/** Real-time file playback. No microphone, tab capture, whole-file audio decode or provider calls. */
export class ReplayAudioSource {
  readonly audio = new Audio();
  readonly context = new AudioContext();
  readonly destination = this.context.createMediaStreamDestination();
  private element?: MediaElementAudioSourceNode;
  private url?: string;
  private released = false;
  get positionMs(): number {
    return Math.max(0, this.audio.currentTime * 1000 || 0);
  }
  get durationMs(): number | undefined {
    return Number.isFinite(this.audio.duration) && this.audio.duration > 0
      ? this.audio.duration * 1000
      : undefined;
  }
  async prepare(blob: Blob, monitor = false): Promise<void> {
    this.url = URL.createObjectURL(blob);
    this.audio.preload = 'auto';
    this.audio.playbackRate = 1;
    this.audio.src = this.url;
    await this.waitFor('loadeddata', () => this.audio.readyState >= 2);
    if (!this.durationMs) {
      // Chrome's own recorded WebM may omit duration metadata. Seeking to the end
      // discovers it without decoding the complete recording into a PCM buffer.
      this.audio.currentTime = 1e10;
      await this.waitFor('seeked', () => !this.audio.seeking && !!this.durationMs);
      this.audio.currentTime = 0;
      await this.waitFor('seeked', () => !this.audio.seeking && this.audio.currentTime === 0);
    }
    if (!this.durationMs) throw Error('Chrome could not read this audio duration. Try a WAV file.');
    this.element = this.context.createMediaElementSource(this.audio);
    this.destination.channelCount = 1;
    this.destination.channelCountMode = 'explicit';
    this.element.connect(this.destination);
    if (monitor) this.element.connect(this.context.destination);
    await this.context.resume();
  }
  private waitFor(event: string, ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(deadline);
        this.audio.removeEventListener(event, success);
        this.audio.removeEventListener('error', fail);
      };
      const success = () => {
        clean();
        resolve();
      };
      const fail = () => {
        clean();
        reject(Error('Chrome could not decode this audio file. Try WAV or WebM audio.'));
      };
      const deadline = setTimeout(fail, 15000);
      this.audio.addEventListener(event, success, { once: true });
      this.audio.addEventListener('error', fail, { once: true });
    });
  }
  async play(): Promise<void> {
    if (this.released) throw Error('Replay audio was already released. Start a new replay.');
    await this.audio.play();
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.element?.disconnect();
    this.destination.stream.getTracks().forEach((track) => track.stop());
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    await this.context.close().catch(() => {});
  }
}
