import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { reserveLiveRequest } from './provider-batching-budget.mjs';
await build({
  stdin: {
    contents:
      "export {messages} from './src/assistant/prompt'; export {ANALYSIS_JSON_SCHEMA,validateAnalysis} from './src/assistant/schema';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'artifacts/provider-batching/contracts.mjs',
});
const { messages, ANALYSIS_JSON_SCHEMA, validateAnalysis } = await import(
  '../artifacts/provider-batching/contracts.mjs'
);
const deep = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
const hpop = JSON.parse(await readFile('.local/hpop.json', 'utf8'));
await reserveLiveRequest('hpop', 'models-metadata', 0);
try {
  const r = await fetch('https://hpop.ai/v1/models', {
    headers: { Authorization: `Bearer ${hpop.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  const model = data.data?.find((m) => m.id === 'claude-sonnet-5-5');
  const meta = {
    status: r.status,
    modelFound: !!model,
    modelFields: model ? Object.keys(model) : [],
    pricing: model?.pricing ?? null,
  };
  await writeFile('artifacts/provider-batching/hpop-models.json', JSON.stringify(meta, null, 2));
  console.log('HPOP metadata:', JSON.stringify(meta));
} catch {
  console.log('HPOP metadata unavailable');
}
const ref = JSON.parse(
  await readFile('training:meeting/verified-excerpts-v1-76136748b154/reference.json', 'utf8'),
);
const annotation =
  ref.annotations.find((a) => a.status === 'transcribed' && a.text?.trim()) ??
  ref.annotations.find((a) => a.text?.trim());
if (!annotation) throw Error('Reviewed transcript unavailable');
const input = {
  sessionId: 'deepinfra-contract',
  version: 1,
  goal: '',
  segments: [
    { id: 0, sessionId: 'deepinfra-contract', startMs: 0, endMs: 8000, text: annotation.text },
  ],
  memory: [],
  history: [],
  contextGap: false,
};
const body = {
  model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  messages: messages(input),
  max_tokens: 1600,
  reasoning_effort: 'none',
  stream: false,
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'meeting_analysis', strict: true, schema: ANALYSIS_JSON_SCHEMA },
  },
};
await reserveLiveRequest('deepinfra', 'production-schema-preflight', 0.02);
const start = performance.now();
try {
  const response = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deep.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  const report = {
    status: response.status,
    elapsedMs: performance.now() - start,
    model: data.model,
    usage: data.usage,
    finishReason: data.choices?.[0]?.finish_reason,
    valid: false,
  };
  if (response.ok) {
    try {
      report.analysis = validateAnalysis(JSON.parse(data.choices[0].message.content), input);
      report.valid = true;
    } catch (e) {
      report.reason = e.reason;
      report.issues = e.validationIssues;
      report.content = data.choices?.[0]?.message?.content;
    }
  } else report.error = data.error;
  const serialized = JSON.stringify(report, null, 2)
    .replaceAll(deep.apiKey, '[REDACTED]')
    .replaceAll(hpop.apiKey, '[REDACTED]');
  await writeFile('artifacts/provider-batching/deepinfra-preflight.json', serialized);
  console.log(
    'DeepInfra preflight:',
    JSON.stringify({
      status: report.status,
      valid: report.valid,
      elapsedMs: report.elapsedMs,
      reason: report.reason,
    }),
  );
} catch (e) {
  await writeFile(
    'artifacts/provider-batching/deepinfra-preflight.json',
    JSON.stringify({ status: 0, elapsedMs: performance.now() - start, error: e.name }),
  );
  console.log('DeepInfra preflight did not complete:', e.name);
}
