import type { AgentCapture } from '../agent-diagnostics';
import { trace } from '../diagnostics';
import { RELAY_ORIGIN } from '../relay';
import { ANALYSIS_TIMEOUT_MS, DEEPER_TIMEOUT_MS, assistantRequestTimeout } from './timing';
import OpenAI from 'openai';
import { ANALYSIS_JSON_SCHEMA, validateAnalysis } from './schema';
import { messages, SYSTEM_PROMPT, systemPrompt } from './prompt';
import {
  HPOP_BASE_URL,
  DEEPINFRA_MODEL,
  type AssistantProvider,
  type AssistantModel,
  type AnalysisInput,
  type AnalysisResult,
} from './types';
import { AssistantAPIError, formatError } from './errors';
export { AssistantAPIError } from './errors';
function captureResult(capture: AgentCapture | undefined, data: unknown): void {
  try {
    capture?.('response', data);
  } catch {}
}
function client(
  apiKey: string,
  provider: AssistantProvider = 'hpop',
  capture?: AgentCapture,
): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: provider === 'deepinfra' ? RELAY_ORIGIN + '/v1/openai' : HPOP_BASE_URL,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: ANALYSIS_TIMEOUT_MS,
    fetch: (url, options) => {
      if (capture && typeof options?.body === 'string') {
        try {
          capture('request', JSON.parse(options.body));
        } catch {}
      }
      return fetch(url, { ...options, redirect: 'error' });
    },
  });
}
export function controls(model: AssistantModel): Record<string, unknown> {
  if (model === DEEPINFRA_MODEL) return { reasoning_effort: 'none' };
  if (model === 'gpt-6-luna') return { reasoning_effort: 'none' };
  if (model === 'qwen3.7-plus') return { enable_thinking: false };
  if (model === 'claude-haiku-4-5-20251001') return { thinking: { type: 'disabled' } };
  return { reasoning_effort: 'low' };
}
export function safeError(error: unknown): AssistantAPIError {
  if (error instanceof AssistantAPIError) return error;
  // SDK timeout/abort errors also inherit APIError and have no HTTP status.
  // Classify them first so they cannot fall through as generic connection failures.
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIUserAbortError
  )
    return new AssistantAPIError(0, 0, 'timeout');
  if (error instanceof OpenAI.APIConnectionError) return new AssistantAPIError(0, 0, 'network');
  if (error instanceof OpenAI.APIError) {
    const raw = error.headers?.get('retry-after');
    const seconds = raw === null || raw === undefined ? NaN : Number(raw);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : raw ? Date.parse(raw) - Date.now() : 0;
    const status = error.status ?? 0;
    return new AssistantAPIError(
      status,
      Number.isFinite(wait) ? Math.max(0, wait) : 0,
      status === 408 || status === 504 ? 'timeout' : 'request',
    );
  }
  return new AssistantAPIError(
    0,
    0,
    error instanceof Error && /abort|timeout/i.test(error.name) ? 'timeout' : 'network',
  );
}
export async function analyze(
  apiKey: string,
  model: AssistantModel,
  input: AnalysisInput,
  signal: AbortSignal,
  provider: AssistantProvider = 'hpop',
  capture?: AgentCapture,
): Promise<AnalysisResult> {
  const start = performance.now();
  let firstTokenMs = 0;
  let text = '';
  let finish: string | null = null;
  let usage: AnalysisResult['usage'];
  try {
    trace('provider.sent', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      model,
    });
    const stream = await client(apiKey, provider, capture).chat.completions.create(
      {
        model,
        messages: messages(input),
        stream: true,
        stream_options: { include_usage: true },
        ...(provider === 'deepinfra' ? { max_tokens: 1600 } : { max_completion_tokens: 1600 }),
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'meeting_analysis',
            strict: true,
            schema: ANALYSIS_JSON_SCHEMA,
          },
        },
        ...controls(model),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal },
    );
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta.content;
      if (delta) {
        if (!firstTokenMs) {
          firstTokenMs = performance.now() - start;
          trace('provider.first_json_delta', {
            sessionId: input.sessionId,
            requestId: input.requestId,
            version: input.version,
          });
        }
        text += delta;
        if (text.length > 16000) throw new AssistantAPIError(0, 0, 'format', 'response_too_large');
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage)
        usage = {
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
        };
    }
    trace('provider.complete', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      durationMs: performance.now() - start,
      inputTokens: usage?.input,
      outputTokens: usage?.output,
    });
    if (finish !== 'stop')
      throw new AssistantAPIError(
        0,
        0,
        'format',
        finish === 'length' ? 'output_truncated' : 'unexpected_finish',
      );
    let analysis;
    try {
      analysis = validateAnalysis(JSON.parse(text), input);
    } catch (error) {
      throw formatError(error);
    }
    if (signal.aborted || performance.now() - start > ANALYSIS_TIMEOUT_MS)
      throw new AssistantAPIError(0, 0, 'timeout');
    return {
      analysis,
      latencyMs: performance.now() - start,
      firstTokenMs,
      usage,
    };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError'))
      throw formatError(error);
    throw safeError(error);
  } finally {
    captureResult(capture, {
      text,
      finishReason: finish,
      usage,
      elapsedMs: performance.now() - start,
      complete: finish === 'stop',
      transport: 'chat-completions',
    });
  }
}
export async function deeper(
  apiKey: string,
  input: AnalysisInput,
  signal: AbortSignal,
  onText: (text: string) => void,
  provider: AssistantProvider = 'hpop',
  capture?: AgentCapture,
): Promise<string> {
  const start = performance.now();
  let text = '';
  let finish: string | null = null;
  try {
    const stream = await client(apiKey, provider, capture).chat.completions.create(
      {
        model: provider === 'deepinfra' ? DEEPINFRA_MODEL : 'claude-opus-5-5',
        messages: [
          {
            role: 'system',
            content:
              (input.liveInput || input.liveV2Input
                ? 'Help explain the active conversation using the supplied source-linked context. Distinguish fact, interpretation and suggestion. Do not write minutes or a whole-session recap.'
                : SYSTEM_PROMPT) +
              '\nFor this explicit deeper analysis, review ALL supplied new and earlier transcript context, memory and recent summaries, rather than limiting yourself to newTranscript. Write up to 250 words of plain text, with supported conclusions, unresolved questions and the most useful next step. Cite segment IDs. Do not return JSON.',
          },
          input.liveInput || input.liveV2Input
            ? {
                role: 'user',
                content: JSON.stringify({
                  objective: input.goal,
                  ...(input.liveV2Input || input.liveInput),
                }),
              }
            : messages({ ...input, memoPolicy: 'baseline', validationFeedback: undefined })[1],
        ],
        stream: true,
        ...(provider === 'deepinfra'
          ? { max_tokens: 1800, reasoning_effort: 'none' as const }
          : { max_completion_tokens: 1800, reasoning_effort: 'low' as const }),
      },
      { signal, timeout: DEEPER_TIMEOUT_MS },
    );
    for await (const chunk of stream) {
      const c = chunk.choices[0];
      text += c?.delta.content ?? '';
      if (c?.finish_reason) finish = c.finish_reason;
      if (text.length > 14000) throw new AssistantAPIError(0, 0, 'format');
      onText(text);
    }
    if (finish !== 'stop' || !text.trim()) throw new AssistantAPIError(0, 0, 'format');
    const known = new Set([
      ...input.segments.map((s) => s.id),
      ...input.memory.flatMap((i) => i.evidenceSegmentIds),
    ]);
    const refs = [...text.matchAll(/\[(?:segment\s*)?(\d+)\]/gi)].map((m) => Number(m[1]));
    if ((known.size > 0 && !refs.length) || refs.some((id) => !known.has(id)))
      throw new AssistantAPIError(0, 0, 'format');
    return text;
  } catch (error) {
    throw safeError(error);
  } finally {
    captureResult(capture, {
      text,
      finishReason: finish,
      complete: finish === 'stop',
      elapsedMs: performance.now() - start,
      transport: 'deeper-text',
    });
  }
}
// Compatibility route for Claude when HPOP does not enforce Chat Completions JSON Schema.
// Uses the official SDK's SSE transport; forced tool input supplies the schema explicitly.
export async function analyzeNativeClaude(
  apiKey: string,
  model: AssistantModel,
  input: AnalysisInput,
  signal: AbortSignal,
  _provider: AssistantProvider = 'hpop',
  capture?: AgentCapture,
): Promise<AnalysisResult> {
  const start = performance.now();
  let firstTokenMs = 0;
  let json = '';
  let stop = '';
  let used = 0;
  let output = 0;
  let tool = false;
  try {
    trace('provider.sent', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      model,
    });
    const stream = await client(apiKey, 'hpop', capture).post<any>('/messages', {
      stream: true,
      signal,
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: 1600,
        system:
          systemPrompt(input) +
          '\nRESPONSE TRANSPORT: You MUST call the meeting_analysis tool exactly once, even for small talk or question=null. Put all output in that tool input. Never return a text block or a Markdown code fence.',
        messages: [messages(input)[1]],
        stream: true,
        tools: [
          {
            name: 'meeting_analysis',
            description: 'Return the validated meeting analysis.',
            input_schema: ANALYSIS_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'meeting_analysis' },
        ...(model.includes('haiku')
          ? { thinking: { type: 'disabled' } }
          : {
              thinking: { type: 'adaptive' },
              output_config: { effort: 'low' },
            }),
      },
    });
    for await (const event of stream) {
      if (event.type === 'message_start') used = event.message?.usage?.input_tokens ?? 0;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        if (event.content_block.name !== 'meeting_analysis' || tool)
          throw new AssistantAPIError(0, 0, 'format', 'unexpected_tool');
        tool = true;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        if (!firstTokenMs) {
          firstTokenMs = performance.now() - start;
          trace('provider.first_json_delta', {
            sessionId: input.sessionId,
            requestId: input.requestId,
            version: input.version,
          });
        }
        json += event.delta.partial_json;
        if (json.length > 16000) throw new AssistantAPIError(0, 0, 'format', 'response_too_large');
      }
      if (event.type === 'message_delta') {
        stop = event.delta?.stop_reason ?? stop;
        used = event.usage?.input_tokens ?? used;
        output = event.usage?.output_tokens ?? output;
      }
    }
    trace('provider.complete', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      durationMs: performance.now() - start,
      inputTokens: used,
      outputTokens: output,
    });
    if (stop === 'max_tokens') throw new AssistantAPIError(0, 0, 'format', 'output_truncated');
    if (!tool) throw new AssistantAPIError(0, 0, 'format', 'missing_tool');
    if (stop !== 'tool_use') throw new AssistantAPIError(0, 0, 'format', 'unexpected_finish');
    let analysis;
    try {
      analysis = validateAnalysis(JSON.parse(json), input);
    } catch (error) {
      throw formatError(error);
    }
    if (signal.aborted || performance.now() - start > ANALYSIS_TIMEOUT_MS)
      throw new AssistantAPIError(0, 0, 'timeout');
    return {
      analysis,
      latencyMs: performance.now() - start,
      firstTokenMs,
      usage: { input: used, output },
    };
  } catch (error) {
    throw safeError(error);
  } finally {
    captureResult(capture, {
      text: json,
      finishReason: stop,
      complete: stop === 'tool_use',
      usage: { input: used, output },
      elapsedMs: performance.now() - start,
      transport: 'native-tool-arguments',
    });
  }
}

// Versioned live memo transport. Legacy analysis above remains for baseline replay.
export async function liveStructured(
  apiKey: string,
  model: AssistantModel,
  input: AnalysisInput,
  signal: AbortSignal,
  provider: AssistantProvider = 'hpop',
  capture?: AgentCapture,
  review = false,
): Promise<import('./live-types').LiveResult | import('./v2/types').Result> {
  const { liveMessages } = await import('./live-prompt');
  const { PROPOSAL_JSON_SCHEMA, REVIEW_JSON_SCHEMA, validateLive } = await import('./live-schema');
  const v2 = !!input.liveV2Input;
  const schemas = v2 ? await import('./v2/schema') : null;
  const schema = schemas
    ? review
      ? schemas.REVIEW_JSON_SCHEMA
      : schemas.PROPOSAL_JSON_SCHEMA
    : review
      ? REVIEW_JSON_SCHEMA
      : PROPOSAL_JSON_SCHEMA;
  const name = review
    ? v2
      ? 'live_memo_review_v2'
      : 'live_memo_review_v1'
    : v2
      ? 'live_memo_proposal_v2'
      : 'live_memo_proposal_v1';
  const timeout = assistantRequestTimeout(review ? 'REVIEW' : 'PROPOSE', v2);
  const stage = review ? 'review' : 'proposal';
  const start = performance.now();
  let text = '',
    finish = '',
    firstTokenMs = 0;
  let usage = { input: 0, output: 0 };
  let failure:
    | { status: number; category: string; reason: string; retryAfterMs: number }
    | undefined;
  try {
    trace('provider.sent', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      model,
    });
    const native = provider === 'hpop' && model.startsWith('claude-');
    const sdk = client(apiKey, provider, capture);
    const msgs = v2
      ? (await import('./v2/prompt')).messages(input, review)
      : liveMessages(input, review);
    const stream = native
      ? await sdk.post<any>('/messages', {
          stream: true,
          signal,
          timeout,
          headers: { 'anthropic-version': '2023-06-01' },
          body: {
            model,
            max_tokens: 1800,
            system: msgs[0].content + `\nCall ${name} exactly once. No text blocks.`,
            messages: [msgs[1]],
            stream: true,
            tools: [
              {
                name,
                description: 'Return the structured live memo decision.',
                input_schema: schema,
              },
            ],
            tool_choice: { type: 'tool', name },
            ...(model.includes('haiku')
              ? { thinking: { type: 'disabled' } }
              : { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }),
          },
        })
      : await sdk.chat.completions.create(
          {
            model,
            messages: msgs,
            stream: true,
            stream_options: { include_usage: true },
            ...(provider === 'deepinfra' ? { max_tokens: 1800 } : { max_completion_tokens: 1800 }),
            response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
            ...controls(model),
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal, timeout },
        );
    let toolCount = 0;
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
        delta = chunk.choices[0]?.delta.content ?? '';
        finish = chunk.choices[0]?.finish_reason ?? finish;
        if (chunk.usage)
          usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
      }
      if (delta && !firstTokenMs) {
        firstTokenMs = performance.now() - start;
        trace('provider.first_json_delta', {
          sessionId: input.sessionId,
          requestId: input.requestId,
          version: input.version,
        });
      }
      text += delta;
      if (text.length > 18000) throw new AssistantAPIError(0, 0, 'format', 'response_too_large');
    }
    if (signal.aborted || performance.now() - start > timeout)
      throw new AssistantAPIError(0, 0, 'timeout');
    if (finish !== (native ? 'tool_use' : 'stop') || (native && toolCount !== 1))
      throw new AssistantAPIError(
        0,
        0,
        'format',
        /length|max_tokens/.test(finish) ? 'output_truncated' : 'unexpected_finish',
      );
    const result = {
      ...(schemas
        ? schemas.validateV2(JSON.parse(text), input, review)
        : { value: validateLive(JSON.parse(text), input, review) }),
      latencyMs: performance.now() - start,
      firstTokenMs,
      usage,
    };
    trace('provider.complete', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      durationMs: result.latencyMs,
      inputTokens: usage.input,
      outputTokens: usage.output,
    });
    return result;
  } catch (e) {
    const error = safeError(
      e instanceof SyntaxError || (e instanceof Error && e.name === 'ZodError')
        ? formatError(e)
        : e,
    );
    failure = {
      status: error.status,
      category: error.category,
      reason: error.reason,
      retryAfterMs: error.retryAfterMs,
    };
    trace('provider.failed', {
      sessionId: input.sessionId,
      requestId: input.requestId,
      version: input.version,
      durationMs: performance.now() - start,
      status: error.status,
      category: error.category,
      reason: error.reason,
    });
    throw error;
  } finally {
    captureResult(capture, {
      text,
      finishReason: finish,
      usage,
      elapsedMs: performance.now() - start,
      transport: name,
      stage,
      firstTokenMs,
      deadlineMs: timeout,
      ...(failure ? { error: failure } : {}),
    });
  }
}
