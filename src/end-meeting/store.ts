import type { EndMeetingJob } from './types';

interface DestinationRecord {
  sessionId: string;
  key: string;
  handle: FileSystemDirectoryHandle;
  bundle?: FileSystemDirectoryHandle;
  cleanupLocked?: boolean;
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('mimo-end-meeting-v1', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('jobs', { keyPath: 'sessionId' });
      r.result.createObjectStore('destinations', { keyPath: 'sessionId' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { database = undefined; reject(r.error); };
  }));
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Meeting storage could not be saved.'));
    tx.onerror = () => {};
  });
}
function result<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function getJob(sessionId: string): Promise<EndMeetingJob | undefined> {
  return result((await open()).transaction('jobs').objectStore('jobs').get(sessionId));
}
export async function listJobs(): Promise<EndMeetingJob[]> {
  const jobs = await result<EndMeetingJob[]>((await open()).transaction('jobs').objectStore('jobs').getAll());
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}
export async function putJob(job: EndMeetingJob): Promise<void> {
  const tx = (await open()).transaction('jobs', 'readwrite');
  const completion = done(tx);
  tx.objectStore('jobs').put(job);
  await completion;
}
export async function setDestination(sessionId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!sessionId || !handle || handle.kind !== 'directory') throw new Error('Choose a meeting folder.');
  const previous = await getDestinationRecord(sessionId);
  // A fresh permission grant to the same folder must resume the existing bundle.
  const same = previous && await handle.isSameEntry(previous.handle).catch(() => false);
  const tx = (await open()).transaction('destinations', 'readwrite');
  const completion = done(tx);
  let failure: Error | undefined;
  const r = tx.objectStore('destinations').get(sessionId);
  r.onsuccess = () => {
    const current = r.result as DestinationRecord | undefined;
    if (current?.key !== previous?.key || (current?.cleanupLocked && !same)) {
      failure = new Error(current?.cleanupLocked
        ? 'This meeting has finished saving. Keep its existing saved folder.'
        : 'The destination changed in another view. Choose the folder again.');
      tx.abort(); return;
    }
    tx.objectStore('destinations').put(same ? { ...current, handle } : { sessionId, key: crypto.randomUUID(), handle });
  };
  try { await completion; } catch (error) { throw failure ?? error; }
}
export async function getDestinationRecord(sessionId: string): Promise<DestinationRecord | undefined> {
  return result((await open()).transaction('destinations').objectStore('destinations').get(sessionId));
}
export async function getDestination(sessionId: string): Promise<FileSystemDirectoryHandle | undefined> {
  return (await getDestinationRecord(sessionId))?.handle;
}
export async function setBundleDirectory(sessionId: string, key: string, bundle: FileSystemDirectoryHandle): Promise<void> {
  const tx = (await open()).transaction('destinations', 'readwrite');
  const completion = done(tx);
  const r = tx.objectStore('destinations').get(sessionId);
  r.onsuccess = () => {
    const value = r.result as DestinationRecord | undefined;
    if (!value || value.key !== key) { tx.abort(); return; }
    tx.objectStore('destinations').put({ ...value, bundle });
  };
  await completion;
}
/** The final local-audio deletion and a new folder choice cannot cross each other. */
export async function claimDestinationCleanup(sessionId: string, key: string): Promise<boolean> {
  const tx = (await open()).transaction('destinations', 'readwrite');
  const completion = done(tx);
  const r = tx.objectStore('destinations').get(sessionId);
  let claimed = false;
  r.onsuccess = () => {
    const value = r.result as DestinationRecord | undefined;
    if (!value || value.key !== key) return;
    tx.objectStore('destinations').put({ ...value, cleanupLocked: true }); claimed = true;
  };
  await completion; return claimed;
}
export async function releaseDestinationCleanup(sessionId: string, key: string): Promise<void> {
  const tx = (await open()).transaction('destinations', 'readwrite');
  const completion = done(tx);
  const r = tx.objectStore('destinations').get(sessionId);
  r.onsuccess = () => {
    const value = r.result as DestinationRecord | undefined;
    if (value?.key === key) tx.objectStore('destinations').put({ ...value, cleanupLocked: false });
  };
  await completion;
}
export async function deleteJob(sessionId: string): Promise<void> {
  const tx = (await open()).transaction(['jobs', 'destinations'], 'readwrite');
  const completion = done(tx);
  tx.objectStore('jobs').delete(sessionId);
  tx.objectStore('destinations').delete(sessionId);
  await completion;
}
