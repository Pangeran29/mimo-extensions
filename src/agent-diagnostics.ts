/** Full-content agent reports. Separate from metadata-only support diagnostics; local and opt-in. */
import { BUILD_ID } from './build-info';
import type { AnalysisInput } from './assistant/types';
export const AGENT_DIAGNOSTICS_KEY = 'listenAgentDiagnosticsEnabled';
export type AgentCapture = (kind: 'request' | 'response', data: unknown) => void;
interface SessionReport {
  sessionId: string;
  startedAt: number;
  buildId: string;
  stoppedAt?: number;
  endedAt?: number;
  bytes: number;
  limited?: boolean;
  storageError?: boolean;
  exportState?: 'started' | 'complete' | 'failed';
}
export interface AgentEvent {
  sessionId: string;
  at: number;
  timeOrigin: number;
  monotonicMs: number;
  kind: string;
  requestId?: string;
  data: unknown;
  sequence?: number;
}
const active = new Map<string, SessionReport>();
let database: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('listen-agent-diagnostics', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('sessions', { keyPath: 'sessionId' });
      r.result
        .createObjectStore('events', { keyPath: 'sequence', autoIncrement: true })
        .createIndex('session', 'sessionId');
    };
    r.onblocked = () => {
      database = undefined;
      reject(Error('Diagnostic storage blocked'));
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => {};
  });
}
function enqueue(work: () => Promise<void>, session?: SessionReport): void {
  writes = writes.then(work).catch(() => {
    if (session) session.storageError = true;
  });
}
export const agentDiagnosticsActive = (sessionId: string) => active.has(sessionId);
export async function beginAgentDiagnostics(sessionId: string, enabled?: boolean): Promise<void> {
  try {
    const optIn =
      enabled ?? (await chrome.storage.local.get(AGENT_DIAGNOSTICS_KEY))[AGENT_DIAGNOSTICS_KEY];
    if (optIn !== true) return;
    const session: SessionReport = {
      sessionId,
      startedAt: Date.now(),
      buildId: BUILD_ID,
      bytes: 0,
    };
    active.set(sessionId, session);
    enqueue(async () => {
      const db = await open();
      const tx = db.transaction(['sessions', 'events'], 'readwrite');
      const complete = done(tx);
      // Keep the newest three previous reports plus the current report. Never touch recordings.
      const all = tx.objectStore('sessions').getAll();
      all.onsuccess = () => {
        const old = (all.result as SessionReport[])
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(3);
        for (const item of old) {
          tx.objectStore('sessions').delete(item.sessionId);
          const cursor = tx
            .objectStore('events')
            .index('session')
            .openCursor(IDBKeyRange.only(item.sessionId));
          cursor.onsuccess = () => {
            if (cursor.result) {
              cursor.result.delete();
              cursor.result.continue();
            }
          };
        }
      };
      tx.objectStore('sessions').put(structuredClone(session));
      await complete;
    }, session);
  } catch {
    /* Diagnostics must never stop capture. */
  }
}
export async function resumeAgentDiagnostics(sessionId: string): Promise<void> {
  try {
    const report = await readAgentReport(sessionId);
    if (report && !report.session.endedAt) active.set(sessionId, report.session);
  } catch {}
}
export function agentEvent(
  sessionId: string | undefined,
  kind: string,
  data: unknown,
  requestId?: string,
): void {
  if (!sessionId) return;
  const session = active.get(sessionId);
  if (!session || session.limited) return;
  try {
    const event: AgentEvent = {
      sessionId,
      kind,
      data: structuredClone(data),
      requestId,
      at: Date.now(),
      timeOrigin: performance.timeOrigin,
      monotonicMs: performance.now(),
    };
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (session.bytes + size > 16 * 1024 * 1024) session.limited = true;
    else session.bytes += size;
    const saved = structuredClone(session);
    enqueue(async () => {
      const tx = (await open()).transaction(['events', 'sessions'], 'readwrite');
      const complete = done(tx);
      if (!saved.limited) tx.objectStore('events').add(event);
      tx.objectStore('sessions').put(saved);
      await complete;
    }, session);
  } catch {
    session.storageError = true;
  }
}
export function stopAgentDiagnostics(sessionId?: string): void {
  const session = sessionId ? active.get(sessionId) : undefined;
  if (session) {
    session.stoppedAt = Date.now();
    agentEvent(sessionId, 'stop-requested', {});
  }
}
export async function finishAgentDiagnostics(
  sessionId: string | undefined,
  data: unknown,
): Promise<boolean> {
  if (!sessionId) return false;
  const session = active.get(sessionId);
  if (!session) return false;
  agentEvent(sessionId, 'session-finished', data);
  session.endedAt = Date.now();
  enqueue(async () => {
    const tx = (await open()).transaction('sessions', 'readwrite');
    const complete = done(tx);
    tx.objectStore('sessions').put(structuredClone(session));
    await complete;
  }, session);
  await writes;
  active.delete(sessionId);
  return !!session.stoppedAt;
}
export async function readAgentReport(
  sessionId?: string,
): Promise<{ session: SessionReport; events: AgentEvent[] } | undefined> {
  await writes;
  const db = await open();
  const sessions = await new Promise<SessionReport[]>((resolve, reject) => {
    const r = db.transaction('sessions').objectStore('sessions').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const session = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : sessions.sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!session) return;
  const events = await new Promise<AgentEvent[]>((resolve, reject) => {
    const r = db
      .transaction('events')
      .objectStore('events')
      .index('session')
      .getAll(session.sessionId);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return { session, events };
}
export async function markAgentExport(
  sessionId: string,
  state: SessionReport['exportState'],
): Promise<void> {
  const report = await readAgentReport(sessionId);
  if (!report) return;
  const tx = (await open()).transaction('sessions', 'readwrite');
  const complete = done(tx);
  tx.objectStore('sessions').put({ ...report.session, exportState: state });
  await complete;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function renderAgentReport(
  report: NonNullable<Awaited<ReturnType<typeof readAgentReport>>>,
): string {
  const pretty = (data: unknown) => escape(JSON.stringify(data, null, 2));
  const requests = new Map<string, AgentEvent[]>();
  const lifecycle: AgentEvent[] = [];
  const labels: Record<string, string> = {
    input: 'Transcript and context',
    request: 'Exact request sent',
    response: 'Model response',
    decision: 'Validation and memo outcome',
    'saved-memo': 'Memo saved locally',
    'save-failed': 'Local save failed',
  };
  const overview = (events: AgentEvent[]): string => {
    const source = events.find((e) => e.kind === 'input')?.data as
      | { input?: AnalysisInput }
      | undefined;
    const decision = events.find((e) => e.kind === 'decision')?.data as
      | {
          memo?: string;
          memoRetained?: string;
          text?: string;
          outcome?: string;
          accepted?: boolean;
        }
      | undefined;
    const input = source?.input;
    if (!input?.segments) return '';
    const newIds = new Set(input.newSegmentIds ?? input.segments.map((s) => s.id));
    const passages = input.segments
      .filter((s) => newIds.has(s.id))
      .map((s) => `[${s.id}] ${s.startMs / 1000}–${s.endMs / 1000}s: ${s.text}`)
      .join('\n\n');
    const memo = decision?.memo ?? decision?.memoRetained ?? decision?.text;
    return `<h3>New transcript supplied</h3><pre>${escape(passages || 'No new passages in this request.')}</pre><details><summary>Previous memo supplied</summary><pre>${escape(input.previousSummary || '(No previous memo)')}</pre></details><h3>Notes after this attempt</h3><p>${escape(decision?.outcome ?? (decision?.accepted ? 'accepted' : 'No application decision recorded; attempt may have been interrupted.'))}</p><pre>${escape(memo ?? 'No memo update recorded. Inspect the response and validation details below.')}</pre>`;
  };
  for (const e of report.events) {
    if (e.requestId) {
      const rows = requests.get(e.requestId) ?? [];
      rows.push(e);
      requests.set(e.requestId, rows);
    } else lifecycle.push(e);
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Listen agent diagnostics</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#202830;background:#f5f3ec}h1,h2{line-height:1.25}section{border-top:1px solid #b8bcb8;padding:24px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace;background:#fff;padding:16px;border:1px solid #d1d3cc}summary{cursor:pointer;padding:8px 0}small{color:#48534d}</style><h1>How your notes evolved</h1><p>This local report contains transcript text, exact request bodies, model output and saved memo evidence. It contains no request headers, account keys, audio or private model reasoning. Do not publish it without reviewing its contents.</p><p>${report.session.endedAt ? 'Session ended' : 'Session incomplete or still active'} · ${requests.size} request attempts · ${escape(report.session.sessionId)}</p>${report.session.limited || report.session.storageError ? '<p><strong>Report incomplete: diagnostic storage failed or the 16 MiB session limit was reached. Some events are missing.</strong></p>' : ''}<details><summary>Session metadata</summary><pre>${pretty(report.session)}</pre></details>${[...requests.entries()].map(([id, events], i) => `<section><h2>Request ${i + 1}</h2><small>${escape(id)}</small>${overview(events)}${events.map((e) => `<details ${e.kind === 'decision' ? 'open' : ''}><summary>${escape(labels[e.kind] ?? e.kind)} · ${new Date(e.at).toISOString()}</summary><pre>${pretty(e.data)}</pre></details>`).join('')}</section>`).join('')}<section><h2>Session timeline and final saved state</h2><pre>${pretty(lifecycle)}</pre></section><details><summary>Complete machine-readable report (JSON)</summary><pre>${pretty(report)}</pre></details></html>`;
}
