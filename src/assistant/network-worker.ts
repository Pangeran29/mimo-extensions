import { configureDiagnostics, setDiagnosticSink, type DiagnosticConfig } from '../diagnostics';
setDiagnosticSink((event) => self.postMessage({ type: 'DIAGNOSTIC_EVENT', event }));
import { assistantRequestTimeout } from './timing';
import { analyze, analyzeNativeClaude, deeper, safeError, liveStructured } from './provider';
import {
  DEEPINFRA_MODEL,
  type AnalysisInput,
  type AssistantModel,
  type AssistantProvider,
} from './types';
import { RELAY_TOKEN } from '../relay';
import { AssistantAPIError } from './errors';
let key = '';
let provider: AssistantProvider = 'hpop';
const requests = new Map<number, AbortController>();
self.onmessage = async (
  event: MessageEvent<{
    type: string;
    id: number;
    key?: string;
    provider?: AssistantProvider;
    diagnostics?: DiagnosticConfig;
    model: AssistantModel;
    input: AnalysisInput;
    captureAgent?: boolean;
  }>,
) => {
  const m = event.data;
  if (m.type === 'INIT') {
    provider = m.provider === 'deepinfra' ? 'deepinfra' : 'hpop';
    key = provider === 'deepinfra' ? RELAY_TOKEN : (m.key ?? '');
    configureDiagnostics(m.diagnostics);
    return;
  }
  if (m.type === 'CANCEL') {
    requests.get(m.id)?.abort();
    return;
  }
  const abort = new AbortController();
  requests.set(m.id, abort);
  const timer = setTimeout(
    () => abort.abort(),
    assistantRequestTimeout(m.type, !!m.input?.liveV2Input),
  );
  try {
    const capture = m.captureAgent
      ? (kind: 'request' | 'response', data: unknown) => {
          self.postMessage({
            type: 'AGENT_CAPTURE',
            id: m.id,
            sessionId: m.input.sessionId,
            requestId: m.input.requestId,
            kind,
            data,
          });
        }
      : undefined;
    if (provider === 'deepinfra' && m.model !== DEEPINFRA_MODEL) throw new AssistantAPIError(400);
    const value =
      m.type === 'PROPOSE' || m.type === 'REVIEW'
        ? await liveStructured(
            key,
            m.model,
            m.input,
            abort.signal,
            provider,
            capture,
            m.type === 'REVIEW',
          )
        : m.type === 'DEEPER'
          ? await deeper(key, m.input, abort.signal, () => {}, provider, capture)
          : await (
              provider === 'hpop' && m.model.startsWith('claude-') ? analyzeNativeClaude : analyze
            )(key, m.model, m.input, abort.signal, provider, capture);
    self.postMessage({
      id: m.id,
      sessionId: m.input.sessionId,
      version: m.input.version,
      value,
    });
  } catch (error) {
    const e = safeError(error);
    self.postMessage({
      id: m.id,
      sessionId: m.input.sessionId,
      version: m.input.version,
      error: {
        status: e.status,
        retryAfterMs: e.retryAfterMs,
        category: e.category,
        reason: e.reason,
        validationIssues: e.validationIssues,
      },
    });
  } finally {
    clearTimeout(timer);
    requests.delete(m.id);
  }
};
