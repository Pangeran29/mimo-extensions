import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import * as db from '../src/db';
import { type Session, MIME } from '../src/types';
const session = (id: string): Session => ({ id, createdAt: Date.now(), sourceTitle:'Test tab', tabId:1, filename:'test.webm', status:'capturing', bytes:0, chunks:0, durationMs:0, partial:false });
afterEach(async () => { for (const row of await db.sessions()) await db.deleteSession(row.id); });
describe('durable recording data', () => {
  it('exports legacy combined chunks when source metadata is absent', async () => {
    await db.putSession(session('legacy'));
    await db.appendChunk('legacy',0,new Blob(['old audio']));
    expect(await (await db.audioBlob('legacy',MIME)).text()).toBe('old audio');
    await db.completeDownload('legacy');
    expect(await db.getSession('legacy')).toBeUndefined();
  });
  it('exports in sequence order and atomically tracks committed chunks', async () => {
    await db.putSession(session('a'));
    await db.appendChunk('a',2,new Blob(['C']));
    await db.appendChunk('a',0,new Blob(['A']));
    await db.appendChunk('a',1,new Blob(['B']));
    expect(await (await db.audioBlob('a', MIME)).text()).toBe('ABC');
    expect(await db.getSession('a')).toMatchObject({bytes:3,chunks:3});
  });
  it('rolls back metadata if a chunk write fails', async () => {
    await db.putSession(session('a')); await db.appendChunk('a',0,new Blob(['A']));
    await expect(db.appendChunk('a',0,new Blob(['duplicate']))).rejects.toThrow();
    expect(await db.getSession('a')).toMatchObject({bytes:1,chunks:1});
  });
  it('deletes only the requested recording and keeps other audio intact', async () => {
    await db.putSession(session('a')); await db.putSession(session('b'));
    await db.appendChunk('a',0,new Blob(['A'])); await db.appendChunk('b',0,new Blob(['B']));
    await db.deleteSession('a');
    expect(await db.getSession('a')).toBeUndefined();
    await expect(db.audioBlob('a',MIME)).rejects.toThrow('No audio');
    expect(await (await db.audioBlob('b',MIME)).text()).toBe('B');
  });
});
