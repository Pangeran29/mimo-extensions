import type { AudioSource, Session } from './types';
let connection: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('listen-audio', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'id' });
      request.result.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Local storage transaction aborted.'));
    tx.onerror = () => {}; // onabort reports the transaction's failure.
  });
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function putSession(session: Session): Promise<void> {
  const tx = (await db()).transaction('sessions', 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('sessions').put(session);
  await done;
}
export async function sessions(): Promise<Session[]> {
  const tx = (await db()).transaction('sessions', 'readonly');
  return (await requestResult<Session[]>(tx.objectStore('sessions').getAll())).sort((a,b) => b.createdAt-a.createdAt);
}
export async function getSession(id: string): Promise<Session | undefined> {
  const tx = (await db()).transaction('sessions', 'readonly');
  return requestResult(tx.objectStore('sessions').get(id));
}
export async function updateSession(id: string, patch: Partial<Session>): Promise<Session> {
  const tx = (await db()).transaction('sessions', 'readwrite');
  const done = transactionDone(tx);
  const request = tx.objectStore('sessions').get(id);
  let value: Session | undefined;
  request.onsuccess = () => {
    if (!request.result) { tx.abort(); return; }
    value = { ...request.result, ...patch };
    tx.objectStore('sessions').put(value);
  };
  await done;
  return value!;
}
export async function appendChunk(id: string, seq: number, data: Blob, source: AudioSource = 'mixed'): Promise<void> {
  const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
  const done = transactionDone(tx);
  const request = tx.objectStore('sessions').get(id);
  request.onsuccess = () => {
    if (!request.result) { tx.abort(); return; }
    const session: Session = request.result;
    tx.objectStore('chunks').add({ id, seq, data, source });
    tx.objectStore('sessions').put({ ...session, bytes: session.bytes+data.size, chunks: session.chunks+1 });
  };
  await done;
}
function range(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}
export async function audioBlob(id: string, type: string, source: AudioSource = 'mixed'): Promise<Blob> {
  const tx = (await db()).transaction('chunks', 'readonly');
  const rows = await requestResult<{ seq: number; data: Blob; source?: AudioSource }[]>(tx.objectStore('chunks').getAll(range(id)));
  const selected = rows.filter(row => (row.source ?? 'mixed') === source);
  if (!selected.length) throw new Error('No audio was committed for this recording. You can discard it.');
  // getAll follows the compound key's sequence ordering. Blobs avoid decoding or base64 copies.
  return new Blob(selected.map(row => row.data), { type });
}
export async function deleteSession(id: string): Promise<void> {
  const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('sessions').delete(id);
  tx.objectStore('chunks').delete(range(id));
  await done;
}

/** Persist each successful file independently; retain the session until every file is saved. */
export async function completeDownload(id: string): Promise<Session | undefined> {
  const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
  const done = transactionDone(tx);
  let remaining: Session | undefined;
  const request = tx.objectStore('sessions').get(id);
  request.onsuccess = () => {
    const session: Session | undefined = request.result;
    if (!session) return;
    const savedSources = [...new Set([...(session.savedSources ?? []), session.downloadingSource ?? 'mixed'])];
    if ((session.sources ?? ['mixed']).every(source => savedSources.includes(source))) {
      tx.objectStore('sessions').delete(id);
      tx.objectStore('chunks').delete(range(id));
    } else {
      remaining = { ...session, savedSources, downloadId: undefined, downloadingSource: undefined };
      tx.objectStore('sessions').put(remaining);
    }
  };
  await done;
  return remaining;
}
