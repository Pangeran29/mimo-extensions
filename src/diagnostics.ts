/** Opt-in local timings. Never accepts transcript, memo, key, URL, or arbitrary error text. */
import { DEFAULT_MEMO_POLICY, type MemoPolicy } from './assistant/types';
import { FAILURE_REASONS, type FailureReason } from './assistant/errors';
export interface DiagnosticConfig {
  enabled: boolean;
  runId: string;
  policy: MemoPolicy;
}
export interface DiagnosticEvent {
  name: string;
  at: number;
  runId: string;
  sessionId?: string;
  segmentId?: number;
  windowId?: number;
  requestId?: string;
  version?: number;
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  count?: number;
  empty?: boolean;
  cached?: boolean;
  policy?: MemoPolicy;
  model?: string;
  status?: number;
  category?: string;
  reason?: FailureReason;
  inputTokens?: number;
  outputTokens?: number;
}
export const DIAGNOSTIC_CONFIG_KEY = 'listenDiagnostics';
const defaults: DiagnosticConfig = { enabled: false, runId: '', policy: DEFAULT_MEMO_POLICY };
let config = { ...defaults };
let sink: ((event: DiagnosticEvent) => void) | undefined;
const hasChrome = () => typeof chrome !== 'undefined' && !!chrome.storage?.session;
export function configureDiagnostics(value?: Partial<DiagnosticConfig>): DiagnosticConfig {
  config = {
    enabled: value?.enabled === true,
    runId: typeof value?.runId === 'string' ? value.runId.slice(0, 100) : '',
    policy:
      value?.enabled && value.policy === 'short-first-note'
        ? 'short-first-note'
        : value?.enabled && value.policy === 'baseline'
          ? 'baseline'
          : DEFAULT_MEMO_POLICY,
  };
  return { ...config };
}
export const diagnosticsReady: Promise<void> = hasChrome()
  ? chrome.storage.session
      .get(DIAGNOSTIC_CONFIG_KEY)
      .then((s) => {
        configureDiagnostics(s[DIAGNOSTIC_CONFIG_KEY]);
      })
      .catch(() => {})
  : Promise.resolve();
if (hasChrome() && chrome.storage.onChanged)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[DIAGNOSTIC_CONFIG_KEY])
      configureDiagnostics(changes[DIAGNOSTIC_CONFIG_KEY].newValue);
  });
export function diagnosticConfig(): DiagnosticConfig {
  return { ...config };
}
export function setDiagnosticSink(next: (event: DiagnosticEvent) => void): void {
  sink = next;
}
export function diagnosticNow(): number {
  return performance.timeOrigin + performance.now();
}
const fieldNames = [
  'sessionId',
  'segmentId',
  'windowId',
  'requestId',
  'version',
  'startMs',
  'endMs',
  'durationMs',
  'count',
  'empty',
  'cached',
  'policy',
  'model',
  'status',
  'category',
  'inputTokens',
  'outputTokens',
] as const;
export function sanitizeDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (
    typeof input.name !== 'string' ||
    input.name.length > 64 ||
    !/^(listen|startup|model|capture|vad|asr|transcript|ai|provider|memo)\.[a-z_]+$/.test(
      input.name,
    ) ||
    typeof input.at !== 'number' ||
    !Number.isFinite(input.at) ||
    typeof input.runId !== 'string'
  )
    return;
  const event: DiagnosticEvent = {
    name: input.name,
    at: input.at,
    runId: input.runId.slice(0, 100),
  };
  for (const key of fieldNames) {
    const field = input[key];
    if (
      (typeof field === 'number' && Number.isFinite(field)) ||
      typeof field === 'boolean' ||
      typeof field === 'string'
    )
      Object.assign(event, { [key]: typeof field === 'string' ? field.slice(0, 120) : field });
  }
  if (FAILURE_REASONS.includes(input.reason as FailureReason))
    event.reason = input.reason as FailureReason;
  return event;
}
export function trace(
  name: string,
  fields: Omit<Partial<DiagnosticEvent>, 'name' | 'at' | 'runId'> = {},
): void {
  if (!config.enabled) return;
  const event = sanitizeDiagnosticEvent({
    ...fields,
    name,
    at: diagnosticNow(),
    runId: config.runId,
  });
  if (!event) return;
  try {
    performance.mark(`listen:${name}`, {
      detail: { runId: config.runId, sessionId: fields.sessionId, version: fields.version },
    });
    performance.clearMarks(`listen:${name}`);
    if (sink) sink(event);
    else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
      void chrome.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', event }).catch(() => {});
  } catch {
    /* Diagnostics must never interfere with capture. */
  }
}
