import OpenAI from 'openai';
import { controls, safeError } from '../assistant/provider';
import { AssistantAPIError, formatError } from '../assistant/errors';
import { HPOP_BASE_URL, type AssistantSettings } from '../assistant/types';
import { RELAY_ORIGIN, RELAY_TOKEN } from '../relay';

export const MOM_CLIENT_TIMEOUT_MS = 65_000;
export type MomStage = 'extract' | 'compose' | 'review';
export class EndConnectionError extends Error {
  constructor() { super('The managed relay needs an update for meeting notes. Restart the relay, then retry meeting notes.'); }
}
export interface MomRequest {
  stage: MomStage;
  messages: { role: 'system' | 'user'; content: string }[];
  schema: Record<string, unknown>;
}
export interface MomResponse {
  value: unknown;
  latencyMs: number;
  firstTokenMs: number;
  usage: { input: number; output: number };
}
export type MomRequester = (
  request: MomRequest,
  settings: AssistantSettings,
  key: string,
  signal: AbortSignal,
  capture?: (kind: string, data: unknown) => void,
) => Promise<MomResponse>;

/** The MoM transport is independent of the live client and never persists credentials. */
export const requestMinutes: MomRequester = async (request, settings, key, outerSignal, capture) => {
  const provider = settings.provider === 'deepinfra' ? 'deepinfra' : 'hpop';
  const native = provider === 'hpop' && settings.model.startsWith('claude-');
  const name = `meeting_minutes_${request.stage}_v1`;
  const start = performance.now();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  outerSignal.addEventListener('abort', cancel, { once: true });
  if (outerSignal.aborted) abort.abort();
  const timer = setTimeout(cancel, MOM_CLIENT_TIMEOUT_MS);
  let text = '', finish = '', firstTokenMs = 0, toolCount = 0;
  const usage = { input: 0, output: 0 };
  const sdk = new OpenAI({
    apiKey: provider === 'deepinfra' ? RELAY_TOKEN || key : key,
    baseURL: provider === 'deepinfra' ? RELAY_ORIGIN + '/v1/openai' : HPOP_BASE_URL,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: MOM_CLIENT_TIMEOUT_MS,
    fetch: (url, options) => fetch(url, { ...options, redirect: 'error' }),
  });
  try {
    if (provider === 'deepinfra') {
      const health = await fetch(RELAY_ORIGIN + '/health', {
        headers: { Authorization: `Bearer ${RELAY_TOKEN || key}` }, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      });
      if (!health.ok) throw new AssistantAPIError(health.status);
      const status = await health.json();
      if (!Array.isArray(status.notes?.supportedEndMeetingProtocols) || !status.notes.supportedEndMeetingProtocols.includes(1))
        throw new EndConnectionError();
    }
    capture?.('request', { stage: request.stage, model: settings.model, messages: request.messages, schema: name });
    const stream = native
      ? await sdk.post<any>('/messages', {
          stream: true,
          signal: abort.signal,
          timeout: MOM_CLIENT_TIMEOUT_MS,
          headers: { 'anthropic-version': '2023-06-01' },
          body: {
            model: settings.model,
            max_tokens: 3200,
            system: request.messages[0].content + `\nCall ${name} exactly once. No text blocks.`,
            messages: request.messages.slice(1),
            tools: [{ name, description: 'Return the structured meeting-minutes result.', input_schema: request.schema }],
            tool_choice: { type: 'tool', name },
            stream: true,
            ...(settings.model.includes('haiku')
              ? { thinking: { type: 'disabled' } }
              : { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }),
          },
        })
      : await sdk.chat.completions.create({
          model: settings.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(provider === 'deepinfra' ? { max_tokens: 3200 } : { max_completion_tokens: 3200 }),
          response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: request.schema } },
          ...controls(settings.model),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, {
          signal: abort.signal, timeout: MOM_CLIENT_TIMEOUT_MS,
        });
    for await (const chunk of stream as any) {
      let delta = '';
      if (native) {
        if (chunk.type === 'message_start') usage.input = chunk.message?.usage?.input_tokens ?? 0;
        if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
          if (chunk.content_block.name !== name || ++toolCount !== 1)
            throw new AssistantAPIError(0, 0, 'format', 'unexpected_tool');
        }
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta')
          delta = chunk.delta.partial_json;
        if (chunk.type === 'message_delta') {
          finish = chunk.delta?.stop_reason ?? finish;
          usage.output = chunk.usage?.output_tokens ?? usage.output;
        }
      } else {
        delta = chunk.choices?.[0]?.delta?.content ?? '';
        finish = chunk.choices?.[0]?.finish_reason ?? finish;
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens;
          usage.output = chunk.usage.completion_tokens;
        }
      }
      if (delta && !firstTokenMs) firstTokenMs = performance.now() - start;
      text += delta;
      if (text.length > 48_000) throw new AssistantAPIError(0, 0, 'format', 'response_too_large');
    }
    if (abort.signal.aborted) throw new AssistantAPIError(0, 0, 'timeout');
    if (finish !== (native ? 'tool_use' : 'stop') || (native && toolCount !== 1))
      throw new AssistantAPIError(0, 0, 'format', /length|max_tokens/.test(finish) ? 'output_truncated' : 'unexpected_finish');
    const response = { value: JSON.parse(text), latencyMs: performance.now() - start, firstTokenMs, usage };
    capture?.('response', { stage: request.stage, ...response, finishReason: finish });
    return response;
  } catch (e) {
    if (e instanceof EndConnectionError) { capture?.('error', { stage: request.stage, category: 'outdated-relay' }); throw e; }
    const failure = safeError(e instanceof SyntaxError ? formatError(e) : e);
    capture?.('error', { stage: request.stage, status: failure.status, category: failure.category, reason: failure.reason, elapsedMs: performance.now() - start, firstTokenMs });
    throw failure;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', cancel);
  }
};
