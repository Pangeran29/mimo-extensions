import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DEEPINFRA_MODEL } from '../src/assistant/types';
import { EndConnectionError, requestMinutes } from '../src/end-meeting/provider';
const request = { stage: 'compose' as const, messages: [{ role: 'system' as const, content: 'Prepare notes.' }, { role: 'user' as const, content: 'Transcript' }], schema: { type: 'object', properties: {} } };
const health = () => new Response(JSON.stringify({ notes: { supportedEndMeetingProtocols: [1] } }), { headers: { 'Content-Type': 'application/json' } });
const sse = (value: unknown, finish = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
afterEach(() => vi.unstubAllGlobals());
it('uses the managed adapter with fixed model controls and MoM schema after a protocol health check', async () => {
  const calls: { url: string; options: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url: String(url), options }); return String(url).endsWith('/health') ? health() : sse({ protocol: 1 });
  }));
  const result = await requestMinutes(request, { ...DEFAULT_SETTINGS, provider: 'deepinfra', model: DEEPINFRA_MODEL }, 'relay-test-token', new AbortController().signal);
  expect(result.value).toEqual({ protocol: 1 }); expect(result.usage).toEqual({ input: 12, output: 6 });
  const body = JSON.parse(calls[1].options.body);
  expect(body.model).toBe(DEEPINFRA_MODEL); expect(body.reasoning_effort).toBe('none');
  expect(body.response_format.json_schema.name).toBe('meeting_minutes_compose_v1'); expect(body.max_tokens).toBe(3200);
});
it('gives an actionable outdated-relay error without starting inference', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ notes: { supportedLiveMemoProtocols: [1, 2] } }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestMinutes(request, { ...DEFAULT_SETTINGS, provider: 'deepinfra', model: DEEPINFRA_MODEL }, 'relay-test-token', new AbortController().signal)).rejects.toBeInstanceOf(EndConnectionError);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves 503 Retry-After and excludes upstream error bodies from captures', async () => {
  const events: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/health') ? health() : new Response('private-provider-detail', { status: 503, headers: { 'retry-after': '11' } })));
  await expect(requestMinutes(request, { ...DEFAULT_SETTINGS, provider: 'deepinfra', model: DEEPINFRA_MODEL }, 'relay-test-token', new AbortController().signal, (_kind, data) => events.push(data))).rejects.toMatchObject({ status: 503, retryAfterMs: 11_000 });
  expect(JSON.stringify(events)).not.toContain('private-provider-detail'); expect(JSON.stringify(events)).not.toContain('relay-test-token');
});
it('rejects truncated output instead of parsing and displaying its partial JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse({ protocol: 1 }, 'length')));
  await expect(requestMinutes(request, { ...DEFAULT_SETTINGS, model: 'gpt-6-luna', provider: 'hpop' }, 'test-key', new AbortController().signal)).rejects.toMatchObject({ reason: 'output_truncated' });
});
it('supports the existing HPOP native-Claude tool transport with a mocked response', async () => {
  let sent: any;
  const chunks = [
    { type: 'message_start', message: { usage: { input_tokens: 9 } } },
    { type: 'content_block_start', content_block: { type: 'tool_use', name: 'meeting_minutes_compose_v1' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"protocol":1}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  ];
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(chunks.map(c => `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  const result = await requestMinutes(request, { ...DEFAULT_SETTINGS, provider: 'hpop' }, 'test-key', new AbortController().signal);
  expect(result.value).toEqual({ protocol: 1 }); expect(sent.tool_choice.name).toBe('meeting_minutes_compose_v1');
  expect(sent.thinking.type).toBe('adaptive');
});
