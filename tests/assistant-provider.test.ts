import { afterEach, expect, it, vi } from 'vitest';
import {
  analyze,
  analyzeNativeClaude,
  deeper,
  safeError,
  AssistantAPIError,
} from '../src/assistant/provider';
import { DEEPINFRA_MODEL, type AnalysisInput } from '../src/assistant/types';
import { normalizeSettings } from '../src/assistant/providers';
const input: AnalysisInput = {
  sessionId: 'test',
  version: 1,
  goal: '',
  segments: [
    {
      id: 0,
      sessionId: 'test',
      startMs: 0,
      endMs: 100,
      text: 'Who owns launch?',
    },
  ],
  memory: [],
  history: [],
  contextGap: false,
};
const analysis = { summary: 'Owner unspecified.', updates: [], question: null };
function stream(events: unknown[], native = false): Response {
  return new Response(
    events
      .map(
        (e) => `${native ? 'event: ' + (e as any).type + '\n' : ''}data: ${JSON.stringify(e)}\n\n`,
      )
      .join('') + (native ? '' : 'data: [DONE]\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  [503, false, 'request', 'temporarily unavailable'],
  [504, true, 'timeout', 'took too long'],
] as const)(
  'retains safe live transport failure metadata for HTTP %s without an SDK retry',
  async (status, review, category, message) => {
    const { liveStructured } = await import('../src/assistant/provider');
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'private-provider-detail' } }), {
          status,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const captured: any[] = [];
    let failure: unknown;
    try {
      await liveStructured(
        'test',
        DEEPINFRA_MODEL,
        input,
        new AbortController().signal,
        'deepinfra',
        (kind, data) => {
          if (kind === 'response') captured.push(data);
        },
        review,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status, category, retryAfterMs: 7000 });
    expect((failure as Error).message).toContain(message);
    expect(fetch).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      stage: review ? 'review' : 'proposal',
      error: { status, category, reason: 'unknown', retryAfterMs: 7000 },
    });
    expect(JSON.stringify(captured)).not.toContain('private-provider-detail');
  },
);

it('classifies a provider request timeout while preserving an HTTP-date Retry-After', async () => {
  const { liveStructured } = await import('../src/assistant/provider');
  const future = new Date(Date.now() + 10_000).toUTCString();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', {
          status: 408,
          headers: { 'content-type': 'application/json', 'retry-after': future },
        }),
    ),
  );
  const result = liveStructured(
    'test',
    DEEPINFRA_MODEL,
    input,
    new AbortController().signal,
    'deepinfra',
  );
  let failure: any;
  try {
    await result;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ status: 408, category: 'timeout' });
  expect(failure.retryAfterMs).toBeGreaterThan(8000);
  expect(failure.retryAfterMs).toBeLessThanOrEqual(10_000);
});
it('migrates legacy settings to HPOP and rejects unknown stored providers', () => {
  expect(normalizeSettings().provider).toBe('hpop');
  expect(normalizeSettings({ provider: 'deepinfra' }).model).toBe(DEEPINFRA_MODEL);
  expect(() => normalizeSettings({ provider: 'unknown' as any })).toThrow('Unknown notes provider');
});
it('routes DeepInfra automatic and deeper requests through the relay with unchanged validation', async () => {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      expect(String(url)).toContain('/v1/openai/chat/completions');
      const body = JSON.parse(options.body);
      bodies.push(body);
      return stream([
        {
          choices: [
            {
              delta: {
                content: body.response_format ? JSON.stringify(analysis) : 'Check ownership [0].',
              },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
    }),
  );
  const result = await analyze(
    'relay-token',
    DEEPINFRA_MODEL,
    input,
    new AbortController().signal,
    'deepinfra',
  );
  expect(result.analysis).toEqual(analysis);
  expect(
    await deeper('relay-token', input, new AbortController().signal, () => {}, 'deepinfra'),
  ).toContain('[0]');
  expect(bodies.map((b) => b.model)).toEqual([DEEPINFRA_MODEL, DEEPINFRA_MODEL]);
  expect(bodies.map((b) => b.max_tokens)).toEqual([1600, 1800]);
  expect(bodies.every((b) => b.reasoning_effort === 'none')).toBe(true);
  expect(bodies[0].response_format.json_schema.strict).toBe(true);
  expect(bodies[1].response_format).toBeUndefined();
});
it('validates only the complete streamed result and sends explicit GPT controls', async () => {
  let body: any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      expect(options.redirect).toBe('error');
      body = JSON.parse(options.body);
      return stream([
        {
          choices: [
            {
              delta: { content: JSON.stringify(analysis).slice(0, 12) },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { content: JSON.stringify(analysis).slice(12) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
      ]);
    }),
  );
  const r = await analyze('test-key', 'gpt-6-luna', input, new AbortController().signal);
  expect(r.analysis).toEqual(analysis);
  expect(body.reasoning_effort).toBe('none');
  expect(body.response_format.json_schema.strict).toBe(true);
});
it('rejects fenced JSON rather than claiming structured support', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        {
          choices: [
            {
              delta: {
                content: '```json\n' + JSON.stringify(analysis) + '\n```',
              },
              finish_reason: 'stop',
            },
          ],
        },
      ]),
    ),
  );
  await expect(
    analyze('test-key', 'gpt-6-luna', input, new AbortController().signal),
  ).rejects.toMatchObject({ category: 'format' });
});
it('rejects truncated completions and unknown source IDs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        {
          choices: [
            {
              delta: { content: JSON.stringify(analysis) },
              finish_reason: 'length',
            },
          ],
        },
      ]),
    ),
  );
  await expect(
    analyze('test-key', 'gpt-6-luna', input, new AbortController().signal),
  ).rejects.toMatchObject({ category: 'format' });
});
it('uses native Claude tool schema and rejects a route ignoring forced tools', async () => {
  let body: any;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      expect(String(url)).toContain('/v1/messages');
      body = JSON.parse(options.body);
      return stream(
        [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', name: 'meeting_analysis' },
          },
          {
            type: 'content_block_delta',
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(analysis),
            },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 20 },
          },
        ],
        true,
      );
    }),
  );
  expect(
    (
      await analyzeNativeClaude(
        'test-key',
        'claude-haiku-4-5-20251001',
        input,
        new AbortController().signal,
      )
    ).analysis,
  ).toEqual(analysis);
  expect(body.thinking).toEqual({ type: 'disabled' });
  expect(body.tool_choice.type).toBe('tool');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }], true),
    ),
  );
  await expect(
    analyzeNativeClaude(
      'test-key',
      'claude-haiku-4-5-20251001',
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ category: 'format' });
});
it('keeps auth failures safe and honors Retry-After', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'do not expose test-key', type: 'auth' },
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json', 'retry-after': '7' },
          },
        ),
    ),
  );
  await expect(
    analyze('test-key', 'gpt-6-luna', input, new AbortController().signal),
  ).rejects.toMatchObject({ status: 401, retryAfterMs: 7000 });
  try {
    await analyze('test-key', 'gpt-6-luna', input, new AbortController().signal);
  } catch (e) {
    expect((e as Error).message).not.toContain('test-key');
  }
  expect(safeError(new DOMException('aborted', 'AbortError'))).toBeInstanceOf(AssistantAPIError);
});
it('uses Opus for separate deeper analysis and rejects partial output', async () => {
  let model = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      model = JSON.parse(options.body).model;
      return stream([
        {
          choices: [
            {
              delta: { content: 'Check ownership [0].' },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
    }),
  );
  expect(await deeper('test-key', input, new AbortController().signal, () => {})).toContain('[0]');
  expect(model).toBe('claude-opus-5-5');
});
it('does not retry before a Retry-After value longer than one minute', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        }),
    ),
  );
  await expect(
    analyze('test-key', 'gpt-6-luna', input, new AbortController().signal),
  ).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
});

it('classifies SDK timeout and streaming abort errors before their APIError superclass', async () => {
  const { default: OpenAI } = await import('openai');
  expect(safeError(new OpenAI.APIConnectionTimeoutError())).toMatchObject({ category: 'timeout' });
  expect(safeError(new OpenAI.APIUserAbortError())).toMatchObject({ category: 'timeout' });
  expect(safeError(new OpenAI.APIConnectionError({ message: 'synthetic failure' }))).toMatchObject({
    category: 'network',
  });
  expect(new AssistantAPIError(503).message).toContain('temporarily unavailable');
});

it.each(['chat', 'native'] as const)(
  'accepts a complete %s memo after twelve seconds',
  async (route) => {
    // Advance the elapsed-time clock without sending a real request or delaying the test.
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        elapsed = 12000;
        return route === 'chat'
          ? stream([
              {
                choices: [{ delta: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }],
              },
            ])
          : stream(
              [
                {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', name: 'meeting_analysis' },
                },
                {
                  type: 'content_block_delta',
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(analysis) },
                },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ],
              true,
            );
      }),
    );
    try {
      const result =
        route === 'chat'
          ? await analyze('test-key', 'gpt-6-luna', input, new AbortController().signal)
          : await analyzeNativeClaude(
              'test-key',
              'claude-sonnet-5-5',
              input,
              new AbortController().signal,
            );
      expect(result.analysis.summary).toBe(analysis.summary);
      expect(result.latencyMs).toBe(12000);
    } finally {
      clock.mockRestore();
    }
  },
);
it('uses the same short-first-memo guidance in native Claude and Chat Completions, then returns to normal', async () => {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return String(url).endsWith('/messages')
        ? stream(
            [
              {
                type: 'content_block_start',
                content_block: { type: 'tool_use', name: 'meeting_analysis' },
              },
              {
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(analysis) },
              },
              { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
            ],
            true,
          )
        : stream([
            { choices: [{ delta: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }] },
          ]);
    }),
  );
  const candidate = { ...input, memoPolicy: 'short-first-note' as const };
  await analyze('test', 'gpt-6-luna', candidate, new AbortController().signal);
  await analyzeNativeClaude('test', 'claude-sonnet-5-5', candidate, new AbortController().signal);
  expect(bodies[0].messages[0].content).toContain('At most 50 words');
  expect(bodies[1].system).toContain(bodies[0].messages[0].content);
  await analyzeNativeClaude(
    'test',
    'claude-sonnet-5-5',
    { ...candidate, previousSummary: analysis.summary },
    new AbortController().signal,
  );
  expect(bodies[2].system).not.toContain('At most 50 words');
  expect(bodies[2].max_tokens).toBe(bodies[1].max_tokens);
  expect(bodies[2].tool_choice).toEqual(bodies[1].tool_choice);
});

it.each(['chat', 'native'] as const)(
  'diagnoses %s failures without retaining model text',
  async (route) => {
    for (const [payload, finish, reason] of [
      ['{private malformed output', 'stop', 'json_syntax'],
      [JSON.stringify({ ...analysis, summary: 'x'.repeat(2401) }), 'stop', 'schema_mismatch'],
      [
        JSON.stringify({
          ...analysis,
          updates: [
            { kind: 'fact', key: 'test-key', text: 'unsupported', evidenceSegmentIds: [999] },
          ],
        }),
        'stop',
        'unknown_evidence',
      ],
      [JSON.stringify(analysis), 'length', 'output_truncated'],
      ['x'.repeat(16001), 'stop', 'response_too_large'],
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          route === 'chat'
            ? stream([{ choices: [{ delta: { content: payload }, finish_reason: finish }] }])
            : stream(
                [
                  {
                    type: 'content_block_start',
                    content_block: { type: 'tool_use', name: 'meeting_analysis' },
                  },
                  {
                    type: 'content_block_delta',
                    delta: { type: 'input_json_delta', partial_json: payload },
                  },
                  {
                    type: 'message_delta',
                    delta: { stop_reason: finish === 'length' ? 'max_tokens' : 'tool_use' },
                  },
                ],
                true,
              ),
        ),
      );
      const call = route === 'chat' ? analyze : analyzeNativeClaude;
      await expect(
        call('test-key', 'claude-sonnet-5-5', input, new AbortController().signal),
      ).rejects.toMatchObject({ category: 'format', reason });
      try {
        await call('test-key', 'claude-sonnet-5-5', input, new AbortController().signal);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('private malformed output');
      }
    }
  },
);

it.each(['chat', 'native'] as const)(
  'preserves safe %s validation field and size without response text',
  async (route) => {
    const payload = JSON.stringify({ ...analysis, summary: 'private'.repeat(400) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        route === 'chat'
          ? stream([{ choices: [{ delta: { content: payload }, finish_reason: 'stop' }] }])
          : stream(
              [
                {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', name: 'meeting_analysis' },
                },
                {
                  type: 'content_block_delta',
                  delta: { type: 'input_json_delta', partial_json: payload },
                },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ],
              true,
            ),
      ),
    );
    const call = route === 'chat' ? analyze : analyzeNativeClaude;
    await expect(
      call('test-key', 'claude-sonnet-5-5', input, new AbortController().signal),
    ).rejects.toMatchObject({
      reason: 'schema_mismatch',
      validationIssues: [{ field: 'summary', code: 'too_big', limit: 2400, size: 2800 }],
    });
  },
);

it.each(['chat', 'native'] as const)(
  'accepts a complete empty-summary %s response without treating it as a provider failure',
  async (route) => {
    const empty = { summary: '', updates: [], question: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        route === 'chat'
          ? stream([
              { choices: [{ delta: { content: JSON.stringify(empty) }, finish_reason: 'stop' }] },
            ])
          : stream(
              [
                {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', name: 'meeting_analysis' },
                },
                {
                  type: 'content_block_delta',
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(empty) },
                },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ],
              true,
            ),
      ),
    );
    const call = route === 'chat' ? analyze : analyzeNativeClaude;
    const result = await call('test-key', 'claude-sonnet-5-5', input, new AbortController().signal);
    expect(result.analysis).toEqual(empty);
  },
);

it.each(['chat', 'native'] as const)(
  'captures exact %s request body and rejected response without account headers',
  async (route) => {
    const records: Array<{ kind: string; data: any }> = [];
    const payload = '{"summary":"' + 'x'.repeat(2401) + '","updates":[],"question":null}';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        route === 'chat'
          ? stream([{ choices: [{ delta: { content: payload }, finish_reason: 'stop' }] }])
          : stream(
              [
                {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', name: 'meeting_analysis' },
                },
                {
                  type: 'content_block_delta',
                  delta: { type: 'input_json_delta', partial_json: payload },
                },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ],
              true,
            ),
      ),
    );
    const call = route === 'chat' ? analyze : analyzeNativeClaude;
    await expect(
      call(
        'never-export-this-credential',
        'claude-sonnet-5-5',
        input,
        new AbortController().signal,
        'hpop',
        (kind, data) => records.push({ kind, data }),
      ),
    ).rejects.toMatchObject({ reason: 'schema_mismatch' });
    expect(records.map((r) => r.kind)).toEqual(['request', 'response']);
    expect(records[0].data.messages[0].content).toBeDefined();
    expect(records[1].data.text).toBe(payload);
    expect(JSON.stringify(records)).not.toContain('never-export-this-credential');
    expect(JSON.stringify(records)).not.toContain('Authorization');
  },
);

it('does not let a diagnostic callback failure change an accepted model result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        { choices: [{ delta: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }] },
      ]),
    ),
  );
  const result = await analyze(
    'test-key',
    'gpt-6-luna',
    input,
    new AbortController().signal,
    'hpop',
    () => {
      throw Error('Diagnostic storage unavailable');
    },
  );
  expect(result.analysis).toEqual(analysis);
});
it('live memo uses the HPOP forced-tool adapter for proposal and review', async () => {
  const { liveStructured } = await import('../src/assistant/provider');
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const name = body.tool_choice.name;
      const value =
        name === 'live_memo_review_v1'
          ? { protocol: 1, accept: false, reason: 'Already answered.' }
          : {
              protocol: 1,
              topic: null,
              topicChanged: false,
              updates: [],
              decision: 'wait',
              reason: 'Insufficient evidence.',
              candidate: null,
            };
      return stream(
        [
          { type: 'message_start', message: { usage: { input_tokens: 12 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(value) },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 20 },
          },
        ],
        true,
      );
    }),
  );
  for (const review of [false, true]) {
    const result = await liveStructured(
      'test',
      'claude-sonnet-5-5',
      input,
      new AbortController().signal,
      'hpop',
      undefined,
      review,
    );
    expect(result.usage).toEqual({ input: 12, output: 20 });
  }
  expect(bodies.map((b) => b.tool_choice.name)).toEqual([
    'live_memo_proposal_v1',
    'live_memo_review_v1',
  ]);
});
it('classifies an incomplete stream past the live deadline as timeout before format validation', async () => {
  const { liveStructured } = await import('../src/assistant/provider');
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(21000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([{ choices: [{ delta: { content: '{"protocol":' }, finish_reason: null }] }]),
    ),
  );
  try {
    await expect(
      liveStructured('test', DEEPINFRA_MODEL, input, new AbortController().signal, 'deepinfra'),
    ).rejects.toMatchObject({ category: 'timeout' });
  } finally {
    clock.mockRestore();
  }
});

it.each([
  [true, 12_000, false],
  [true, 15_001, true],
  [false, 12_000, true],
] as const)(
  'applies the targeted review budget without changing v1 (v2=%s, elapsed=%s)',
  async (v2, elapsed, timedOut) => {
    const { liveStructured } = await import('../src/assistant/provider');
    const reviewInput: AnalysisInput = v2
      ? {
          ...input,
          liveV2Input: {
            protocol: 2,
            topic: null,
            memo: null,
            activeContribution: null,
            newTranscript: input.segments,
            recentTranscript: input.segments,
            recalled: [],
            contributions: [],
            evidence: [],
          },
        }
      : input;
    const value = v2
      ? {
          protocol: 2,
          memo: { accept: false, reason: 'No update requested' },
          contribution: { accept: false, reason: 'No contribution requested' },
          status: { accept: false, reason: 'No status update requested' },
        }
      : { protocol: 1, accept: false, reason: 'Already understood.' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        stream([
          { choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] },
        ]),
      ),
    );
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(elapsed);
    try {
      const result = liveStructured(
        'test',
        DEEPINFRA_MODEL,
        reviewInput,
        new AbortController().signal,
        'deepinfra',
        undefined,
        true,
      );
      if (timedOut) await expect(result).rejects.toMatchObject({ category: 'timeout' });
      else
        await expect(result).resolves.toMatchObject({ value: { protocol: 2 }, latencyMs: 12_000 });
    } finally {
      clock.mockRestore();
    }
  },
);
it('v2 uses the HPOP forced-tool schemas and independent reviewer verdicts', async () => {
  const { liveStructured } = await import('../src/assistant/provider');
  const names: string[] = [];
  const v2Input = {
    ...input,
    liveV2Input: {
      protocol: 2 as const,
      topic: null,
      memo: null,
      activeContribution: null,
      newTranscript: input.segments,
      recentTranscript: input.segments,
      recalled: [],
      contributions: [],
      evidence: [],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      const name = body.tool_choice.name;
      names.push(name);
      const value = name.endsWith('review_v2')
        ? {
            protocol: 2,
            memo: { accept: true, reason: 'Grounded' },
            contribution: { accept: false, reason: 'Not requested' },
            status: { accept: false, reason: 'Not requested' },
          }
        : {
            protocol: 2,
            topic: { key: 'launch', label: 'Launch', sources: [0] },
            topicChanged: false,
            updates: [],
            decision: 'silent',
            reason: 'Current topic',
            memoUpdate: {
              action: 'replace',
              text: 'A participant asks who owns launch.',
              sources: [0],
            },
            candidate: null,
            statusUpdate: null,
          };
      return stream(
        [
          { type: 'content_block_start', content_block: { type: 'tool_use', name } },
          {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(value) },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { input_tokens: 20, output_tokens: 30 },
          },
        ],
        true,
      );
    }),
  );
  for (const review of [false, true]) {
    const r = await liveStructured(
      'test',
      'claude-sonnet-5-5',
      v2Input,
      new AbortController().signal,
      'hpop',
      undefined,
      review,
    );
    expect(r.value.protocol).toBe(2);
  }
  expect(names).toEqual(['live_memo_proposal_v2', 'live_memo_review_v2']);
});
