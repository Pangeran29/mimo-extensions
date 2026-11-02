import type { AssistantSnapshot } from './types';
import { loadAssistant as loadLegacy } from './store';
import { emptyLive } from './live-types';
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('listen-live-memo-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('latest');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
export async function saveAssistant(s: AssistantSnapshot): Promise<void> {
  if (s.live?.protocol !== 1) throw new Error('Unsupported live memo storage version.');
  const tx = (await open()).transaction('latest', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
  tx.objectStore('latest').put(s, 'snapshot');
  await done;
}
export async function loadAssistant(): Promise<AssistantSnapshot | undefined> {
  const tx = (await open()).transaction('latest');
  const value = await new Promise<AssistantSnapshot | undefined>((resolve, reject) => {
    const r = tx.objectStore('latest').get('snapshot');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (value) {
    if (value.live?.protocol !== 1) throw new Error('Unsupported live memo storage version.');
    return value;
  }
  const legacy = await loadLegacy();
  return legacy
    ? {
        ...legacy,
        summary: '',
        summaries: [],
        question: null,
        live: { ...emptyLive(), closed: true, legacyNote: legacy.summary || undefined },
      }
    : undefined;
}
export function recoveredAssistant(s: AssistantSnapshot): AssistantSnapshot {
  return {
    ...s,
    live: s.live ? { ...s.live, closed: true, stage: undefined } : { ...emptyLive(), closed: true },
    phase: s.phase === 'disabled' ? 'disabled' : 'complete',
    deeperBusy: false,
    analyzingSince: undefined,
    retryAt: undefined,
    message: 'Saved live memo. Start a new recording for live assistance.',
  };
}
