// Isolated Chrome integration: real controller/client/worker/provider/presence code,
// synthetic transcript and SSE only. No credentials, audio uploads or paid requests.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve('artifacts/notes-recovery');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'runtime-'));
let browser;
const server = createServer(async (req, res) => {
  const files = {
    '/': 'index.html',
    '/app.js': 'app.js',
    '/assistant/network-worker.js': 'assistant/network-worker.js',
  };
  const file = files[req.url];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(await readFile(path.join(directory, file)));
});
try {
  await build({
    stdin: {
      contents: `
    import { AssistantController } from './src/assistant/controller';
    import { AssistantClient } from './src/assistant/client';
    import { assistantPresence } from './src/assistant/presentation';
    import { DEFAULT_SETTINGS } from './src/assistant/types';
    const client = new AssistantClient(); client.init('synthetic-unused');
    const controller = new AssistantController(client, snapshot => {
      window.latest = snapshot;
      document.querySelector('main').textContent = snapshot.summary;
      window.presence = assistantPresence({phase:'recording',retained:[]}, snapshot);
    }, async () => {}, () => {});
    controller.configure({...DEFAULT_SETTINGS, enabled:true});
    window.observe = ids => controller.observe({phase:'transcribing', sessionId:'check',
      segments: ids.map(id => ({id,sessionId:'check',startMs:id*8000,endMs:id*8000+7000,text:'Supported discussion point.'})),
      incomplete:false,lagMs:0,modelReady:true});
    window.stop = () => controller.finish();
  `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    outfile: path.join(directory, 'app.js'),
  });
  const gate = `let calls=0;globalThis.fetch=async(_url,options)=>{
    calls++;const bad=calls>=2&&calls<=4;
    if(calls>=3&&!JSON.parse(options.body).system.includes('APPLICATION VALIDATION FEEDBACK'))throw Error('Missing constraint feedback');
    const value={summary:bad?'invalid':calls===1?'Initial memo.':'Recovered memo.',updates:[],question:null};
    if(bad)value.summary='x'.repeat(2401);
    const events=[{type:'content_block_start',content_block:{type:'tool_use',name:'meeting_analysis'}},
      {type:'content_block_delta',delta:{type:'input_json_delta',partial_json:JSON.stringify(value)}},
      {type:'message_delta',delta:{stop_reason:'tool_use'}}];
    return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
  };`;
  await build({
    entryPoints: ['src/assistant/network-worker.ts'],
    bundle: true,
    format: 'esm',
    banner: { js: gate },
    outfile: path.join(directory, 'assistant/network-worker.js'),
  });
  await writeFile(
    path.join(directory, 'index.html'),
    '<main></main><script type="module" src="/app.js"></script>',
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.observe);
  await page.evaluate(() => window.observe([0]));
  await page.clock.runFor(150);
  await page.waitForFunction(() => window.latest.version === 1);
  console.log('Initial synthetic memo accepted.');
  await page.clock.fastForward(8 * 60000);
  await page.evaluate(() => window.observe([0, 60]));
  for (const [index, delay] of [150, 2100, 4100].entries()) {
    await page.clock.runFor(delay);
    await page.waitForFunction((count) => window.latest.lastFailure?.count === count, index + 1);
    console.log('Synthetic invalid response observed:', index + 1);
    const snapshot = await page.evaluate(() => ({
      summary: window.latest.summary,
      phase: window.latest.phase,
      presence: window.presence.key,
    }));
    assert.equal(snapshot.summary, 'Initial memo.');
    assert.equal(snapshot.phase, 'listening');
    assert.equal(snapshot.presence, 'retrying');
  }
  await page.evaluate(() => window.observe([0, 60, 61]));
  await page.clock.runFor(30100);
  await page.waitForFunction(() => window.latest.lastSegmentId === 61);
  const result = await page.evaluate(() => ({
    summary: document.querySelector('main').textContent,
    phase: window.latest.phase,
    version: window.latest.version,
    lastFailure: window.latest.lastFailure,
    analysisError: window.latest.analysisError ?? null,
  }));
  assert.equal(result.summary, 'Recovered memo.');
  assert.equal(result.version, 2);
  assert.equal(result.lastFailure.reason, 'schema_mismatch');
  assert.equal(result.analysisError, null);
  await page.evaluate(() => window.stop());
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ success: true, synthetic: true, paidCalls: 0, ...result, errors }, null, 2),
  );
  console.log(
    'Chrome notes recovery passed: three invalid updates after eight minutes, memo retained, worker failure code delivered, automatic recovery rendered. No paid calls.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
