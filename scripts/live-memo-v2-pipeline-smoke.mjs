// Real Chrome capture/VAD -> managed relay -> DeepInfra ASR and DeepSeek notes. Isolated profile.
// Isolated browser profile; existing reviewed audio only. At most four live ASR calls.
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { reserveLiveMemoRequest } from './live-memo-budget.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const config = JSON.parse(await readFile('.local/deepinfra.json', 'utf8'));
let attempts = 0,
  liveCalls = 0,
  llmCalls = 0;
const upstreamChecks = [];
const relay = createRelay({
  ...config,
  providerFetch: async (...args) => {
    const asr = String(args[0]).includes('/v1/inference/');
    if (asr) {
      attempts++;
      if (attempts === 1) return new Response('simulated ASR outage', { status: 503 });
      if (liveCalls >= 4) return new Response('evaluation cap', { status: 503 });
      liveCalls++;
    } else {
      if (llmCalls >= 6) return new Response('evaluation cap', { status: 503 });
      llmCalls++;
    }
    await reserveLiveMemoRequest(asr ? 'v2-browser-ASR' : 'v2-browser-LLM');
    const started = performance.now();
    try {
      const response = await fetch(...args);
      upstreamChecks.push({
        asr,
        status: response.status,
        contentType: response.headers.get('content-type'),
        elapsedMs: performance.now() - started,
      });
      return response;
    } catch (error) {
      upstreamChecks.push({
        asr,
        error: error.name,
        causeCode: error.cause?.code,
        elapsedMs: performance.now() - started,
      });
      throw error;
    }
  },
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
const audio = await readFile(
  'training:meeting/verified-excerpts-v1-76136748b154/clips/0792-combined.wav',
);
const source = createServer((req, res) => {
  if (req.url === '/speech.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(audio);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<title>Cloud transcription check</title><audio id="audio" src="/speech.wav" controls></audio>',
    );
  }
});
await new Promise((r) => source.listen(0, '127.0.0.1', r));
await mkdir('artifacts/live-memo-v2/browser-pipeline', { recursive: true });
const profile = await mkdtemp(path.resolve('artifacts/live-memo-v2/browser-pipeline/profile-'));
const errors = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  const evaluationBuild = path.resolve('artifacts/live-memo-v2/browser-pipeline/evaluation-build');
  await cp('artifacts/live-memo-v2/candidate-build', evaluationBuild, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(evaluationBuild, 'manifest.json'), 'utf8'));
  manifest.host_permissions = manifest.host_permissions.map((x) =>
    x === 'http://127.0.0.1:8787/*' ? relayOrigin + '/*' : x,
  );
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages.replace('http://127.0.0.1:8787', relayOrigin);
  await writeFile(path.join(evaluationBuild, 'manifest.json'), JSON.stringify(manifest));
  await build({
    entryPoints: [
      'src/worker.ts',
      'src/offscreen.ts',
      'src/popup.ts',
      'src/setup.ts',
      'src/assistant-window.ts',
      'src/assistant/network-worker.ts',
    ],
    outdir: evaluationBuild,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    define: {
      LISTEN_BUILD_ID: JSON.stringify('isolated-live-provider-check'),
      LISTEN_ASR_BATCH_SECONDS: '8',
      LISTEN_TRANSCRIPTION_URL: JSON.stringify(relayOrigin + '/transcribe'),
      LISTEN_RELAY_TOKEN: JSON.stringify(config.relayToken),
    },
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: evaluationBuild });
  const setup = await context.newPage();
  setup.on('pageerror', (e) => errors.push(e.message));
  await setup.goto(`chrome-extension://${id}/setup.html`);
  await setup.evaluate(async () => {
    globalThis.checkStates = [];
    globalThis.checkAIStates = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'ASSISTANT_STATE')
        checkAIStates.push({
          phase: m.snapshot.phase,
          lastSegmentId: m.snapshot.lastSegmentId,
          summaryLength: m.snapshot.summary?.length,
          message: m.snapshot.message,
          analysisError: m.snapshot.analysisError,
        });
      if (m.type === 'TRANSCRIPT_STATE')
        checkStates.push({ phase: m.snapshot.phase, count: m.snapshot.segments.length });
    });
    await chrome.storage.local.set({
      microphoneReady: true,
      transcriptionEnabled: true,

      assistantSettings: {
        enabled: true,
        provider: 'deepinfra',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        goal: '',
        benchmarkPassed: false,
      },
    });
    if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Cloud transcription integration check',
      });
  });
  const { targetInfos } = await root.send('Target.getTargets');
  const offscreen = targetInfos.find((t) => t.url === `chrome-extension://${id}/offscreen.html`);
  const { sessionId } = await root.send('Target.attachToTarget', {
    targetId: offscreen.targetId,
    flatten: false,
  });
  async function evaluate(expression) {
    const callId = Math.floor(Math.random() * 1000000000);
    const pending = new Promise((resolve, reject) => {
      const listener = (e) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message);
        if (m.id !== callId) return;
        root.off('Target.receivedMessageFromTarget', listener);
        if (m.error || m.result?.exceptionDetails) reject(Error('Offscreen evaluation failed'));
        else resolve(m.result?.result?.value);
      };
      root.on('Target.receivedMessageFromTarget', listener);
    });
    await root.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: callId,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    });
    return pending;
  }
  await evaluate(
    `(()=>{const query=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=async p=>p.name==='microphone'?{state:'granted'}:query(p);const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{if(constraints.audio?.mandatory?.chromeMediaSource)return native(constraints);const c=new AudioContext(),d=c.createMediaStreamDestination(),o=c.createOscillator(),g=c.createGain();g.gain.value=0;o.connect(g).connect(d);o.start();globalThis.testMic=c;return d.stream;};})()`,
  );
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${source.address().port}`);
  await page.bringToFront();
  const info = await root.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await root.send('Extensions.triggerAction', {
    id,
    targetId: info.targetInfos.find((t) => t.url === page.url()).targetId,
  });
  const tabId = await setup.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id,
    page.url(),
  );
  await setup.evaluate(() => chrome.storage.local.set({ microphoneReady: true }));
  const start = await setup.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({
        target: 'worker',
        type: 'START',
        tabId,
        title: 'Integration check',
      }),
    tabId,
  );
  if (!start.ok) {
    const diagnostic = await setup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'recorder', type: 'STATUS' }),
    );
    console.log('Recording startup diagnostic:', JSON.stringify(diagnostic));
  }
  assert.equal(start.ok, true, JSON.stringify(start));
  await page.locator('#audio').evaluate((audio) => audio.play());
  await page.waitForFunction(() => document.getElementById('audio').ended, {}, { timeout: 15000 });
  // Wait for a real stage-one result while recording remains open. Silence is valid.
  let liveValidated = false;
  const memoDeadline = Date.now() + 90000;
  while (Date.now() < memoDeadline) {
    const r = await setup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_STATUS' }),
    );
    console.log(
      'Before Stop',
      JSON.stringify({
        ok: r.ok,
        phase: r.value?.phase,
        version: r.value?.version,
        live: r.value?.liveV2,
        analysisError: r.value?.analysisError,
        llmCalls,
      }),
    );
    if (
      r.ok &&
      r.value.liveV2?.protocol === 2 &&
      r.value.version > 0 &&
      !r.value.liveV2.stage &&
      llmCalls > 0
    ) {
      liveValidated = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.ok(liveValidated, 'No stage-one live memo response while recording');
  await setup.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'STOP' }));
  const deadline = Date.now() + 180000;
  let transcriptDone = false,
    notesDone = false;
  let polls = 0;
  while (Date.now() < deadline) {
    const check = await setup.evaluate(async () => ({
      transcript: await chrome.runtime.sendMessage({ target: 'worker', type: 'TRANSCRIPT_STATUS' }),
      ai: await chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_STATUS' }),
    }));
    if (++polls % 10 === 0)
      console.log(
        JSON.stringify({
          transcriptPhase: check.transcript.value?.phase,
          segments: check.transcript.value?.segments?.length,
          aiPhase: check.ai.value?.phase,
          aiMessage: check.ai.value?.message,
          attempts,
          liveCalls,
          llmCalls,
        }),
      );
    transcriptDone =
      check.transcript.ok &&
      check.transcript.value.phase === 'complete' &&
      check.transcript.value.segments.length > 0;
    notesDone =
      check.ai.ok &&
      ['complete', 'disabled'].includes(check.ai.value.phase) &&
      check.ai.value.liveV2?.protocol === 2 &&
      check.ai.value.version > 0 &&
      check.ai.value.liveV2.closed === true;
    if (transcriptDone && notesDone) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(transcriptDone, 'Cloud transcript did not recover before the check deadline');
  if (!notesDone)
    console.log('AI lifecycle:', JSON.stringify(await setup.evaluate(() => checkAIStates)));
  assert.ok(notesDone, 'Audio transcript did not reach the live memo engine');
  const status = await setup.evaluate(async () => ({
    states: checkStates,
    recording: (await chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' })).value,
    transcript: (await chrome.runtime.sendMessage({ target: 'worker', type: 'TRANSCRIPT_STATUS' }))
      .value,
  }));
  assert.ok(status.states.some((s) => s.phase === 'recovering'));
  assert.equal(status.transcript.phase, 'complete');
  assert.ok(status.transcript.segments.length);
  assert.ok(!['error', 'save-failed', 'recording'].includes(status.recording.phase));
  assert.ok(notesDone);
  assert.ok(liveCalls <= 4);
  assert.deepEqual(errors, []);
  const report = {
    success: true,
    attempts,
    liveAsrCalls: liveCalls,
    liveLlmRequests: llmCalls,
    validatedLiveMemoResponse: notesDone,
    phases: [...new Set(status.states.map((s) => s.phase))],
    segments: status.transcript.segments.length,
    recordingPhase: status.recording.phase,
    scope:
      'Real tab capture, packaged VAD, managed relay, DeepInfra ASR and DeepSeek notes. One locally injected initial ASR failure; no synthetic LLM response. Functional check, not a quality ranking.',
    errors,
    upstreamChecks,
  };
  await writeFile(
    'artifacts/live-memo-v2/browser-pipeline/result.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(
    'artifacts/live-memo-v2/browser-pipeline/failure.json',
    JSON.stringify(
      {
        success: false,
        error: error.message,
        attempts,
        liveCalls,
        llmCalls,
        upstreamChecks,
        errors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  console.log(JSON.stringify({ attempts, liveCalls, liveLlmCalls: llmCalls, upstreamChecks }));
  await context?.close();
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  await new Promise((r) => source.close(r));
  await rm(profile, { recursive: true, force: true });
}
