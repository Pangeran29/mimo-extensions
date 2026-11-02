import type { AssistantSnapshot } from './types';
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('listen-assistant', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('latest');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
export async function saveAssistant(snapshot: AssistantSnapshot): Promise<void> {
  const tx = (await open()).transaction('latest', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
  tx.objectStore('latest').put(snapshot, 'snapshot');
  await done;
}
export async function loadAssistant(): Promise<AssistantSnapshot | undefined> {
  const tx = (await open()).transaction('latest');
  return new Promise((resolve, reject) => {
    const r = tx.objectStore('latest').get('snapshot');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export function recoveredAssistant(s: AssistantSnapshot): AssistantSnapshot {
  return {
    ...s,
    // Older snapshots retained only one summary; keep it as an undated revision.
    summaries:
      s.summaries ??
      (s.summary
        ? [
            {
              version: s.version,
              createdAt: 0,
              summary: s.summary,
              memory: structuredClone(s.memory),
              evidenceSegmentIds: [],
            },
          ]
        : []),
    analyzingSince: undefined,
    retryAt: undefined,
    analysisError: undefined,
    phase: s.phase === 'disabled' ? 'disabled' : 'complete',
    deeperBusy: false,
    incomplete: s.incomplete || ['thinking', 'listening', 'finishing'].includes(s.phase),
    message: 'Saved analysis. Start a new recording for live AI.',
  };
}
