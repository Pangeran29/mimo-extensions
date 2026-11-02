import type { AudioSource } from './types';
export const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Ordered, bounded writes. Failures stop new writes while preserving committed chunks. */
export class WriteQueue {
  pendingBytes = 0;
  failure: Error | undefined;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  constructor(private write: (seq: number, data: Blob, source: AudioSource) => Promise<void>, private failed: (error: Error) => void) {}
  enqueue(data: Blob, source: AudioSource = 'mixed'): boolean {
    if (!data.size || this.failure) return false;
    if (this.pendingBytes + data.size > MAX_PENDING_BYTES) {
      this.fail(new Error('Local storage could not keep up. Recording stopped; committed audio is retained.'));
      return false;
    }
    const seq = this.sequence++;
    this.pendingBytes += data.size;
    this.tail = this.tail.then(async () => {
      try { if (!this.failure) await this.write(seq, data, source); }
      catch { this.fail(new Error('Could not write audio to local storage. Free disk space and save the retained recording.')); }
      finally { this.pendingBytes -= data.size; }
    });
    return true;
  }
  async drain(): Promise<void> { await this.tail; }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.failed(error);
  }
}
