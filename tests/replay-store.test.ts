import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  getRun,
  getSource,
  getSourceBlob,
  listSources,
  putSource,
  readEvents,
  updateRun,
} from '../src/replay/store';
import type { ReplayRun } from '../src/replay/types';

describe('Replay Lab source and run evidence', () => {
  it('keeps immutable source metadata and audio in local research storage', async () => {
    const file = new File(['repeatable audio bytes'], 'meeting.webm', { type: 'audio/webm' });
    const source = await putSource(file);
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.size).toBe(file.size);
    expect(await getSource(source.id)).toEqual(source);
    expect(await (await getSourceBlob(source.id))?.text()).toBe('repeatable audio bytes');
    expect(JSON.stringify(await listSources())).not.toContain('repeatable audio bytes');
  });

  it('rejects empty, unsupported and oversized files before storing them', async () => {
    await expect(putSource(new File([], 'empty.wav'))).rejects.toThrow('contains audio');
    await expect(putSource(new File(['x'], 'notes.txt'))).rejects.toThrow('Choose a WAV');
    const file = new File(['x'], 'large.wav');
    Object.defineProperty(file, 'size', { value: 128 * 1024 * 1024 + 1 });
    await expect(putSource(file)).rejects.toThrow('128 MiB');
  });

  it('retains ordered source-time events and previous-run snapshots on Repeat', async () => {
    const source = await putSource(new File(['same'], 'same.wav', { type: 'audio/wav' }));
    const first: ReplayRun = {
      id: 'replay-first',
      sessionId: 'first-session',
      sourceId: source.id,
      source,
      startedAt: 100,
      phase: 'playing',
      buildId: 'test',
      protocol: 2,
      sourceMs: 0,
    };
    await updateRun(first);
    const data = { memoId: 'first-memo', text: 'original' };
    await appendEvent(first.id, 'memo-dom-applied', data, 12000, 1000);
    data.text = 'mutated';
    await appendEvent(first.id, 'source-ended', {}, 20000, 9000);
    await updateRun({ ...first, phase: 'complete', sourceMs: 20000, endedAt: 9000 });
    await updateRun({ ...first, id: 'replay-second', sessionId: 'second-session', startedAt: 10000 });
    const events = await readEvents(first.id);
    expect(events.map((event) => event.kind)).toEqual(['memo-dom-applied', 'source-ended']);
    expect(events[0].sourceMs).toBe(12000);
    expect(events[0].at).toBe(1000);
    expect(events[0].data).toEqual({ memoId: 'first-memo', text: 'original' });
    expect((await getRun(first.id))?.phase).toBe('complete');
    expect((await getRun('replay-second'))?.sessionId).toBe('second-session');
    expect((await getRun(first.id))?.eventBytes).toBeGreaterThan(0);
  });

  it('marks oversized evidence incomplete instead of silently truncating it', async () => {
    const source = (await listSources())[0];
    const run: ReplayRun = {
      id: 'replay-bounded',
      sessionId: 'bounded-session',
      sourceId: source.id,
      source,
      startedAt: 100,
      phase: 'playing',
      buildId: 'test',
      protocol: 2,
      sourceMs: 0,
    };
    await updateRun(run);
    await appendEvent(run.id, 'response', 'x'.repeat(32 * 1024 * 1024), 0);
    expect((await getRun(run.id))?.limited).toBe(true);
    expect(await readEvents(run.id)).toEqual([]);
    // A status update from a stale in-memory run cannot clear evidence limits.
    await updateRun({ ...run, phase: 'complete' });
    expect((await getRun(run.id))?.limited).toBe(true);
  });
});
