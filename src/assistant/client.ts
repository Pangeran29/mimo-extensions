import { diagnosticConfig } from '../diagnostics';
import { agentDiagnosticsActive, agentEvent } from '../agent-diagnostics';
import { assistantRequestTimeout, WORKER_REPLY_GRACE_MS } from './timing';
import type { AnalysisInput, AnalysisResult, AssistantModel, AssistantProvider } from './types';
import { AssistantAPIError } from './errors';
export class AssistantClient {
  private worker?: Worker;
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      sessionId: string;
      version: number;
    }
  >();
  init(key: string, provider: AssistantProvider = 'hpop'): void {
    this.close();
    this.worker = new Worker(new URL('assistant/network-worker.js', location.href), {
      type: 'module',
    });
    this.worker.postMessage({
      type: 'INIT',
      key,
      ...(provider === 'deepinfra' ? { provider } : {}),
      diagnostics: diagnosticConfig(),
    });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'AGENT_CAPTURE') {
        if (agentDiagnosticsActive(data.sessionId) && ['request', 'response'].includes(data.kind))
          agentEvent(data.sessionId, data.kind, data.data, data.requestId);
        return;
      }
      if (data.type === 'DIAGNOSTIC_EVENT') {
        void chrome.runtime.sendMessage(data).catch(() => {});
        return;
      }
      const p = this.pending.get(data.id);
      if (!p || p.sessionId !== data.sessionId || p.version !== data.version) return;
      clearTimeout(p.timer);
      this.pending.delete(data.id);
      if (data.error)
        p.reject(
          new AssistantAPIError(
            data.error.status,
            data.error.retryAfterMs,
            data.error.category,
            data.error.reason,
            data.error.validationIssues,
          ),
        );
      else p.resolve(data.value);
    };
    this.worker.onerror = () => this.close();
  }
  request<T = AnalysisResult>(
    type: 'ANALYZE' | 'DEEPER' | 'PROPOSE' | 'REVIEW',
    model: AssistantModel,
    input: AnalysisInput,
    signal: AbortSignal,
  ): Promise<T> {
    if (!this.worker) return Promise.reject(new AssistantAPIError(401));
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const cancel = () => {
        this.worker?.postMessage({ type: 'CANCEL', id });
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new AssistantAPIError(0, 0, 'timeout'));
        }
      };
      const timer = setTimeout(
        cancel,
        assistantRequestTimeout(type, !!input.liveV2Input) + WORKER_REPLY_GRACE_MS,
      );
      this.pending.set(id, {
        sessionId: input.sessionId,
        version: input.version,
        resolve: (v) => {
          signal.removeEventListener('abort', cancel);
          resolve(v);
        },
        reject: (e) => {
          signal.removeEventListener('abort', cancel);
          reject(e);
        },
        timer,
      });
      signal.addEventListener('abort', cancel, { once: true });
      this.worker!.postMessage({
        type,
        id,
        model,
        input,
        ...(agentDiagnosticsActive(input.sessionId) ? { captureAgent: true } : {}),
      });
      if (signal.aborted) cancel();
    });
  }
  close(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AssistantAPIError(0, 0, 'timeout'));
    }
    this.pending.clear();
  }
}
