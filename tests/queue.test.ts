import { describe, it, expect, vi } from 'vitest';
import { WriteQueue, MAX_PENDING_BYTES } from '../src/write-queue';
describe('incremental write queue', () => {
  it('writes chunks in sequence, skips empty chunks, and releases queued bytes', async () => {
    const writes: number[] = [];
    const fail = vi.fn();
    const queue = new WriteQueue(async seq => { await Promise.resolve(); writes.push(seq); }, fail);
    queue.enqueue(new Blob([]));
    for (let i=0;i<5;i++) queue.enqueue(new Blob(['audio']));
    expect(queue.pendingBytes).toBe(25);
    await queue.drain();
    expect(writes).toEqual([0,1,2,3,4]);
    expect(queue.pendingBytes).toBe(0);
    expect(fail).not.toHaveBeenCalled();
  });
  it('rejects an overflow without retaining the oversized chunk', async () => {
    const fail = vi.fn();
    const write = vi.fn(async () => {});
    const queue = new WriteQueue(write, fail);
    expect(queue.enqueue(new Blob([new Uint8Array(MAX_PENDING_BYTES+1)]))).toBe(false);
    expect(queue.pendingBytes).toBe(0);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(queue.enqueue(new Blob(['later']))).toBe(false);
    await queue.drain();
    expect(write).not.toHaveBeenCalled();
  });
  it('retains committed writes and reports storage failure once', async () => {
    const committed: number[] = [];
    const fail = vi.fn();
    const queue = new WriteQueue(async seq => { if(seq===1) throw Error('quota'); committed.push(seq); }, fail);
    queue.enqueue(new Blob(['first'])); queue.enqueue(new Blob(['second'])); queue.enqueue(new Blob(['third']));
    await queue.drain();
    expect(committed).toEqual([0]); expect(fail).toHaveBeenCalledTimes(1);
    expect(queue.failure?.message).toContain('local storage'); expect(queue.pendingBytes).toBe(0);
  });
});
