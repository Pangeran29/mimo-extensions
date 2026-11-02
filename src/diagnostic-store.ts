import { sanitizeDiagnosticEvent, type DiagnosticEvent } from './diagnostics';
export const TRACE_KEY = 'listenDiagnosticTrace';
let writes = Promise.resolve();
/** A bounded session-only ring, serialized to avoid lost writes across contexts. */
export function appendDiagnostic(event: DiagnosticEvent): Promise<void> {
  const safe = sanitizeDiagnosticEvent(event);
  if (!safe) return Promise.resolve();
  const task = writes.then(async () => {
    const { listenDiagnostics: config, [TRACE_KEY]: saved } = await chrome.storage.session.get([
      'listenDiagnostics',
      TRACE_KEY,
    ]);
    if (!config?.enabled || safe.runId !== config.runId || !Number.isFinite(safe.at)) return;
    const trace =
      saved?.runId === safe.runId ? saved : { runId: safe.runId, dropped: 0, events: [] };
    trace.events.push(safe);
    if (trace.events.length > 10000) {
      trace.events.shift();
      trace.dropped++;
    }
    await chrome.storage.session.set({ [TRACE_KEY]: trace });
  });
  writes = task.catch(() => {});
  return task;
}
