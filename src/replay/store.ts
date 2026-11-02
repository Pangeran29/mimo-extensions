import type { ReplayEvent, ReplayRun, ReplaySource } from './types';

export const MAX_REPLAY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EVENT_BYTES = 32 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('memo-replay-lab', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sources', { keyPath: 'id' });
      request.result.createObjectStore('runs', { keyPath: 'id' });
      request.result
        .createObjectStore('events', { keyPath: 'sequence', autoIncrement: true })
        .createIndex('run', 'runId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(Error('Replay storage is blocked. Close other Replay Lab pages and try again.'));
    };
  }));
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error('Replay storage could not be written.'));
    tx.onerror = () => {};
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function putSource(file: File): Promise<ReplaySource> {
  if (!file.size) throw Error('Choose an audio file that contains audio.');
  if (file.size > MAX_REPLAY_FILE_BYTES) throw Error('Choose an audio file smaller than 128 MiB.');
  if (!/\.(wav|webm|mp3|m4a|mp4|ogg|opus|flac)$/i.test(file.name))
    throw Error('Choose a WAV, WebM, MP3, M4A, MP4, Ogg, Opus or FLAC audio file.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const source: ReplaySource = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    sha256: [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join(''),
    createdAt: Date.now(),
  };
  const tx = (await open()).transaction('sources', 'readwrite');
  const complete = done(tx);
  tx.objectStore('sources').put({ ...source, blob: file });
  await complete;
  return source;
}
export async function getSource(id: string): Promise<ReplaySource | undefined> {
  const row = await result<{ blob: Blob } & ReplaySource | undefined>(
    (await open()).transaction('sources').objectStore('sources').get(id),
  );
  if (!row) return;
  const { blob: _blob, ...source } = row;
  return source;
}
export async function getSourceBlob(id: string): Promise<Blob | undefined> {
  const row = await result<{ blob: Blob } | undefined>(
    (await open()).transaction('sources').objectStore('sources').get(id),
  );
  return row?.blob;
}
export async function listSources(): Promise<ReplaySource[]> {
  const rows = await result<({ blob: Blob } & ReplaySource)[]>(
    (await open()).transaction('sources').objectStore('sources').getAll(),
  );
  return rows.map(({ blob: _blob, ...source }) => source).sort((a, b) => b.createdAt - a.createdAt);
}
export async function deleteSource(id: string): Promise<void> {
  const tx = (await open()).transaction('sources', 'readwrite');
  const complete = done(tx);
  tx.objectStore('sources').delete(id);
  await complete;
}
export async function getRun(id: string): Promise<ReplayRun | undefined> {
  return result((await open()).transaction('runs').objectStore('runs').get(id));
}
export async function listRuns(): Promise<ReplayRun[]> {
  const rows = await result<ReplayRun[]>(
    (await open()).transaction('runs').objectStore('runs').getAll(),
  );
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}
export async function updateRun(run: ReplayRun): Promise<void> {
  const tx = (await open()).transaction('runs', 'readwrite');
  const complete = done(tx);
  const prior = tx.objectStore('runs').get(run.id);
  prior.onsuccess = () => {
    const old = prior.result as ReplayRun | undefined;
    tx.objectStore('runs').put({
      ...run,
      eventBytes: Math.max(run.eventBytes ?? 0, old?.eventBytes ?? 0),
      limited: run.limited || old?.limited || undefined,
    });
  };
  await complete;
}
export async function appendEvent(
  runId: string,
  kind: string,
  data: unknown,
  sourceMs: number,
  at = Date.now(),
): Promise<void> {
  if (!/^[a-z][a-z0-9_.-]{0,79}$/i.test(kind)) throw Error('Invalid replay event.');
  const event: ReplayEvent = {
    runId,
    kind,
    at,
    sourceMs: Math.max(0, Number.isFinite(sourceMs) ? sourceMs : 0),
    data: structuredClone(data),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  const tx = (await open()).transaction(['runs', 'events'], 'readwrite');
  const complete = done(tx);
  const request = tx.objectStore('runs').get(runId);
  request.onsuccess = () => {
    const run = request.result as ReplayRun | undefined;
    if (!run || run.limited) return;
    if ((run.eventBytes ?? 0) + bytes > MAX_EVENT_BYTES) run.limited = true;
    else {
      run.eventBytes = (run.eventBytes ?? 0) + bytes;
      tx.objectStore('events').add(event);
    }
    tx.objectStore('runs').put(run);
  };
  await complete;
}
export async function readEvents(runId: string): Promise<ReplayEvent[]> {
  return result(
    (await open())
      .transaction('events')
      .objectStore('events')
      .index('run')
      .getAll(runId),
  );
}

