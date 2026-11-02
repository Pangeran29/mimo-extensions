import type { AudioWindow, TranscriptSnapshot } from './types';
export interface PendingWindow extends AudioWindow {
  pendingId: string;
  sessionId: string;
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('listen-transcript', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('latest'))
        request.result.createObjectStore('latest');
      if (!request.result.objectStoreNames.contains('pending'))
        request.result.createObjectStore('pending', { keyPath: 'pendingId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
export async function saveTranscript(snapshot: TranscriptSnapshot): Promise<void> {
  const tx = (await open()).transaction('latest', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
  tx.objectStore('latest').put(snapshot, 'snapshot');
  await done;
}
export async function loadTranscript(): Promise<TranscriptSnapshot | undefined> {
  const tx = (await open()).transaction('latest', 'readonly');
  return new Promise((resolve, reject) => {
    const request = tx.objectStore('latest').get('snapshot');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function pendingWindows(): Promise<PendingWindow[]> {
  const tx = (await open()).transaction('pending', 'readonly');
  return new Promise((resolve, reject) => {
    const request = tx.objectStore('pending').getAll();
    request.onsuccess = () =>
      resolve((request.result as PendingWindow[]).sort((a, b) => a.startSample - b.startSample));
    request.onerror = () => reject(request.error);
  });
}
/** Both stores commit together: a crash cannot duplicate a delivered window. */
export async function persistWindow(
  snapshot: TranscriptSnapshot,
  job: PendingWindow,
  delivered = false,
): Promise<void> {
  const tx = (await open()).transaction(['pending', 'latest'], 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
  tx.objectStore('latest').put(snapshot, 'snapshot');
  if (delivered) tx.objectStore('pending').delete(job.pendingId);
  else tx.objectStore('pending').put(job);
  await done;
}
/** Transcript and acknowledgement of the entire selected batch commit together. */
export async function commitWindows(
  snapshot: TranscriptSnapshot,
  jobs: readonly PendingWindow[],
): Promise<void> {
  if (!jobs.length) throw Error('Cannot acknowledge an empty batch');
  const tx = (await open()).transaction(['pending', 'latest'], 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
  try {
    tx.objectStore('latest').put(snapshot, 'snapshot');
    for (const job of jobs) tx.objectStore('pending').delete(job.pendingId);
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw error;
  }
}
export function recoveredTranscript(snapshot: TranscriptSnapshot): TranscriptSnapshot {
  if (snapshot.phase === 'loading')
    return {
      ...snapshot,
      phase: 'failed',
      modelReady: false,
      lagMs: 0,
      message: 'Transcription setup was interrupted. Saved text is retained.',
    };
  if (['transcribing', 'finishing', 'recovering'].includes(snapshot.phase))
    return {
      ...snapshot,
      phase: 'failed',
      modelReady: false,
      incomplete: true,
      lagMs: 0,
      message:
        'Transcription was interrupted. Completed text is retained; recording audio is recovered separately.',
    };
  return { ...snapshot, modelReady: false };
}
