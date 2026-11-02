import { once } from 'node:events';
export const NOTES_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
export const NOTES_TIMEOUT_MS = 29_000;
export const MOM_TIMEOUT_MS = 60_000;
const MOM_SCHEMAS = ['meeting_minutes_extract_v1', 'meeting_minutes_compose_v1', 'meeting_minutes_review_v1'];
const endpoint = 'https://api.deepinfra.com/v1/openai/chat/completions';
function retryAfterSeconds(value) {
  if (!value) return;
  const delta = Number(value);
  const seconds = Number.isFinite(delta)
    ? delta
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : undefined;
}
/** Fixed-model local notes route. The caller has already checked host, origin and relay token. */
export async function serveNotes(req, res, { apiKey, providerFetch, reply, cors, slots }) {
  // Retry-After is not a CORS-safelisted response header. The permitted caller needs it
  // to honor provider backoff instead of repeatedly sending requests during an outage.
  if (cors?.['Access-Control-Allow-Origin'])
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  if (req.headers['content-type'] !== 'application/json')
    return reply(415, { error: { message: 'Expected JSON' } });
  if (slots.active >= 2)
    return reply(429, { error: { message: 'Notes service busy; retry later' } });
  slots.active++;
  const abort = new AbortController();
  let timer;
  let timedOut = false;
  const disconnect = () => {
    if (!res.writableEnded) abort.abort();
  };
  req.on('aborted', () => abort.abort());
  res.on('close', disconnect);
  try {
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 131072) return reply(413, { error: { message: 'Notes request too large' } });
      parts.push(chunk);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      return reply(400, { error: { message: 'Invalid notes request' } });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return reply(400, { error: { message: 'Invalid notes request' } });
    const max = input.max_tokens ?? input.max_completion_tokens;
    const mom = MOM_SCHEMAS.includes(input.response_format?.json_schema?.name);
    if (
      input.model !== NOTES_MODEL ||
      input.stream !== true ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > (mom ? 3200 : 1800) ||
      !Array.isArray(input.messages) ||
      input.messages.length < 1 ||
      input.messages.length > 4 ||
      input.messages.some(
        (m) =>
          !m ||
          !['system', 'user'].includes(m.role) ||
          typeof m.content !== 'string' ||
          m.content.length > 100000,
      ) ||
      (input.response_format &&
        (input.response_format.type !== 'json_schema' ||
          ![
            'meeting_analysis',
            'live_memo_proposal_v1',
            'live_memo_review_v1',
            'live_memo_proposal_v2',
            'live_memo_review_v2',
            ...MOM_SCHEMAS,
          ].includes(input.response_format.json_schema?.name) ||
          typeof input.response_format.json_schema.schema !== 'object'))
    )
      return reply(400, { error: { message: 'Unsupported notes request' } });
    const body = {
      model: NOTES_MODEL,
      messages: input.messages,
      max_tokens: max,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none',
      ...(input.response_format ? { response_format: input.response_format } : {}),
    };
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, mom ? MOM_TIMEOUT_MS : NOTES_TIMEOUT_MS);
    const response = await providerFetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // An errored error-body stream must not hide its HTTP status or retry delay.
      }
      const retry = retryAfterSeconds(response.headers.get('retry-after'));
      if ((response.status === 429 || response.status === 503) && retry !== undefined)
        res.setHeader('Retry-After', String(retry));
      return reply(response.status >= 400 && response.status < 600 ? response.status : 502, {
        error: { message: 'Managed notes request failed' },
      });
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
      throw Error('Invalid notes transport');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      ...cors,
    });
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > 1048576) throw Error('Notes response too large');
      if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal });
    }
    res.end();
  } catch {
    if (res.headersSent) res.destroy();
    else
      reply(timedOut ? 504 : 503, {
        error: {
          message: timedOut
            ? 'Managed notes request timed out'
            : 'Managed notes service unavailable',
        },
      });
  } finally {
    clearTimeout(timer);
    abort.abort();
    res.off('close', disconnect);
    slots.active--;
  }
}
