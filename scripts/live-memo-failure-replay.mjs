// A bounded diagnostic re-run of rejected original inputs; does not resume a production session.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { createRelay } from '../server/relay.mjs';
import { reserveLiveMemoRequest } from './live-memo-budget.mjs';
const root = path.resolve(
  `artifacts/live-memo-v1/failure-probes-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(root, { recursive: true });
const config = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
const relay = createRelay({
  ...config,
  providerFetch: async (...args) => {
    await reserveLiveMemoRequest('failure-probe-LLM');
    return fetch(...args);
  },
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
await build({
  stdin: {
    contents: `export {liveStructured} from './src/assistant/provider';export {liveContext} from './src/assistant/live-context';export {DEEPINFRA_MODEL} from './src/assistant/types';`,
    resolveDir: process.cwd(),
  },
  outfile: root + '/runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: {
    LISTEN_TRANSCRIPTION_URL: JSON.stringify(`http://127.0.0.1:${relay.address().port}/transcribe`),
    LISTEN_RELAY_TOKEN: JSON.stringify(config.relayToken),
  },
});
const { liveStructured, liveContext, DEEPINFRA_MODEL } = await import(root + '/runtime.mjs');
const run = JSON.parse(await readFile(process.argv[2] + '/lemhanas-16-10/run.json', 'utf8'));
const report = {
  scope:
    'Targeted diagnostic probes with current transport; original errors remain in the full report. These are not a resumed live session or a MOM.',
  probes: [],
};
const failed = run.trace.find((t) => t.error?.reason === 'schema_mismatch');
const tailInput = liveContext(run.finalSnapshot, run.transcript, '');
try {
  for (const [label, input] of [
    ['original-schema-rejection', failed.input],
    ['post-cancellation-transcript-tail', tailInput],
  ]) {
    const row = {
      label,
      input,
      originalError: label === 'original-schema-rejection' ? failed.error : undefined,
    };
    report.probes.push(row);
    const start = performance.now();
    try {
      row.result = await liveStructured(
        config.relayToken,
        DEEPINFRA_MODEL,
        input,
        AbortSignal.timeout(20000),
        'deepinfra',
        (kind, data) => {
          if (kind === 'response') row.raw = data;
        },
      );
    } catch (e) {
      row.error = { category: e.category, reason: e.reason, status: e.status };
    }
    row.elapsedMs = performance.now() - start;
    await writeFile(root + '/result.json', JSON.stringify(report, null, 2));
  }
} finally {
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  console.log(root);
}
