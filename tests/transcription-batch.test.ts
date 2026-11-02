import { expect, it } from 'vitest';
import { selectBatch } from '../src/transcription/batch';
import type { PendingWindow } from '../src/transcription/store';
const job = (start: number, end: number, session = 's'): PendingWindow => ({
  pendingId: `${session}:${start}`,
  sessionId: session,
  startSample: start * 16000,
  endSample: end * 16000,
  overlap: start > 0,
  audio: Float32Array.from({ length: (end - start) * 16000 }, (_, i) => start * 16000 + i),
});
it('keeps baseline single-window dispatch and reuses its buffer without waiting', () => {
  const a = job(0, 8),
    b = job(7, 15);
  expect(selectBatch([a, b], 8)?.jobs).toEqual([a]);
  expect(selectBatch([a], 24)?.audio).toBe(a.audio);
  expect(selectBatch([], 24)).toBeUndefined();
});
it('merges the oldest prefix with sample-perfect overlap removal and caps unique audio', () => {
  const queue = [job(0, 8), job(7, 15), job(14, 22), job(21, 29)];
  const a = selectBatch(queue, 16)!;
  expect(a.jobs).toHaveLength(2);
  expect(a.audio.length).toBe(15 * 16000);
  const b = selectBatch(queue, 24)!;
  expect(b.jobs).toHaveLength(3);
  expect(b.audio.length).toBe(22 * 16000);
  expect(b.audio.every((n, i) => n === i)).toBe(true);
  expect(queue[1].audio[0]).toBe(7 * 16000);
});
it('stops at gaps, another session or bad metadata, and keeps first-window overlap', () => {
  const a = job(7, 15);
  expect(selectBatch([a, job(16, 20)], 24)?.jobs).toHaveLength(1);
  expect(selectBatch([a, job(14, 22, 'other')], 24)?.jobs).toHaveLength(1);
  expect(selectBatch([a, { ...job(14, 22), endSample: 0 }], 24)?.jobs).toHaveLength(1);
  expect(selectBatch([a, job(14, 22)], 24)?.overlap).toBe(true);
});
