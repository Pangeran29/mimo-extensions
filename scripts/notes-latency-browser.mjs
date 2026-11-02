// Real-time Chrome capture -> VAD -> Whisper -> provider -> actual side panel.
// --offline stubs only HPOP and is transport verification, NEVER latency evidence.
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, cp, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { reserveRequest, budgetStatus } from './notes-latency-budget.mjs';
import { audioStats, compressionRatio, pcmWav } from './whisper-debug-metrics.mjs';
const { values: v } = parseArgs({
  options: {
    audio: { type: 'string' },
    url: { type: 'string' },
    variant: { type: 'string', default: 'baseline' },
    duration: { type: 'string', default: '45' },
    run: { type: 'boolean' },
    offline: { type: 'boolean' },
    output: { type: 'string', default: 'artifacts/notes-browser.json' },
    budget: { type: 'string', default: 'artifacts/notes-latency-budget.json' },
    cohort: { type: 'string', default: 'warmed' },
    cache: { type: 'string', default: 'artifacts/transcription-gate-profile' },
    'capture-asr': { type: 'boolean' },
  },
});
const duration = Number(v.duration);
if (
  !v.audio === !v.url ||
  !['baseline', 'short-first-note'].includes(v.variant) ||
  !['warmed', 'cache-restoration'].includes(v.cohort) ||
  !Number.isFinite(duration) ||
  duration < 30 ||
  duration > 1200
)
  throw Error(
    'Specify exactly one --audio LOCAL.wav or --url URL; --variant baseline|short-first-note; --duration 30–1200 seconds. Default is no-network plan.',
  );
if (v.url && !/^https?:\/\//.test(v.url)) throw Error('Use an HTTP(S) source URL.');
const audio = v.audio ? await readFile(v.audio) : undefined;
const sourceHash = createHash('sha256');
for (const name of [
  'diagnostics.ts',
  'diagnostic-store.ts',
  'worker.ts',
  'offscreen.ts',
  'types.ts',
  'assistant/settings.ts',
  'assistant/client.ts',
  'assistant/network-worker.ts',
  'engine.ts',
  'transcription/controller.ts',
  'transcription/segmenter.ts',
  'transcription/model-worker.ts',
  'assistant/controller.ts',
  'assistant/prompt.ts',
  'assistant/provider.ts',
  'assistant/types.ts',
  'assistant/schema.ts',
  'assistant/timing.ts',
  'assistant-window.ts',
])
  sourceHash.update(name).update(await readFile('src/' + name));
const provenance = {
  sourceHash: sourceHash.digest('hex'),
  harnessHash: createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .update(await readFile('scripts/notes-latency-budget.mjs'))
    .update(await readFile('scripts/notes-latency-network-gate.js'))
    .digest('hex'),
  buildHash: createHash('sha256')
    .update(await readFile('dist/assistant/network-worker.js'))
    .update(await readFile('dist/offscreen.js'))
    .update(await readFile('dist/assistant-window.js'))
    .update(await readFile('dist/worker.js'))
    .update(await readFile('dist/transcription/model-worker.js'))
    .digest('hex'),
  model: 'claude-sonnet-5-5',
  cohort: v.cohort,
  fixtureHash: audio ? createHash('sha256').update(audio).digest('hex') : null,
  source: v.audio ? path.resolve(v.audio) : v.url,
  variant: v.variant,
  durationSeconds: duration,
  scope: v.offline
    ? 'OFFLINE transport check: synthetic LLM; no latency or quality evidence'
    : 'Browser end-to-end; usefulness review pending',
};
console.log(JSON.stringify({ ...provenance, requestsAllowed: 100, run: !!v.run }, null, 2));
if (!v.run) process.exit(0);
if (!v.offline && !process.env.LISTEN_HPOP_KEY)
  throw Error('Set LISTEN_HPOP_KEY locally; live evaluation pending.');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
await mkdir(path.dirname(v.output), { recursive: true });
const profile = await mkdtemp(path.resolve('artifacts/notes-browser-profile-'));
const evaluationBuild = path.resolve('artifacts/notes-latency-evaluation-build');
const buildLock = await open(evaluationBuild + '.lock', 'wx');
await cp('dist', evaluationBuild, { recursive: true });
const gatePrefix = await readFile('scripts/notes-latency-network-gate.js', 'utf8');
await writeFile(
  path.join(evaluationBuild, 'assistant/network-worker.js'),
  gatePrefix + '\n' + (await readFile('dist/assistant/network-worker.js', 'utf8')),
);
if (v['capture-asr']) {
  const worker = await readFile('dist/transcription/model-worker.js', 'utf8');
  if (!worker.includes('async function prepare()'))
    throw Error('Diagnostic hook needs review for this build');
  await writeFile(
    path.join(evaluationBuild, 'transcription/model-worker.js'),
    worker + '\n' + (await readFile('scripts/whisper-debug-worker.js', 'utf8')),
  );
  await mkdir(v.output + '.asr', { recursive: true });
}
for (const part of ['Default/Service Worker/CacheStorage', 'Default/WebStorage']) {
  await mkdir(path.dirname(path.join(profile, part)), { recursive: true });
  await cp(path.join(v.cache, part), path.join(profile, part), { recursive: true }).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
}
const server = createServer((req, res) => {
  if (req.url === '/audio.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(audio);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><title>Listen evaluation source</title><audio id="audio" src="/audio.wav" controls></audio>',
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let context,
  root,
  setup,
  traceStarted = false;
let budgetStopped = false;
const runId = randomUUID(),
  attempts = [],
  downloads = [],
  errors = [];
const report = {
  ...provenance,
  runId,
  kind: v.offline ? 'synthetic-provider' : 'measured',
  evaluationGateHash: createHash('sha256').update(gatePrefix).digest('hex'),
  quality: 'UNREVIEWED',
  environment: {},
  attempts,
  downloads,
  errors,
  revisions: [],
  segments: [],
  events: [],
  firstPresentationMs: null,
  annotations: { firstSubstantiveSpeechMs: null, firstUsefulEvidenceMs: null },
  deadlinesMs: [15000, 20000, 30000],
  complete: false,
  asrDebug: v['capture-asr'] ? [] : undefined,
};
const asrWrites = [];
function recordAsr(detail) {
  if (detail.kind === 'input') {
    const bytes = Buffer.from(detail.audio, 'base64');
    delete detail.audio;
    Object.assign(detail, audioStats(bytes));
    const basename = `${report.asrDebug.filter((x) => x.kind === 'input').length}-${detail.requestId}`;
    detail.pcm = path.resolve(v.output + '.asr', basename + '.f32');
    detail.wav = path.resolve(v.output + '.asr', basename + '.wav');
    asrWrites.push(
      Promise.all([writeFile(detail.pcm, bytes), writeFile(detail.wav, pcmWav(bytes))]),
    );
  }
  if (typeof detail.text === 'string') detail.compressionRatio = compressionRatio(detail.text);
  report.asrDebug.push(detail);
}
async function waitStatus(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const reply = await setup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
    );
    if (reply?.ok && predicate(reply.value)) return reply.value;
    await sleep(200);
  }
  throw Error('Recorder status did not reach the required state');
}
async function targetEval(targetId, expression) {
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: false });
  try {
    await root.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id: -1, method: 'Runtime.runIfWaitingForDebugger' }),
    });
    await root.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id: 0, method: 'Runtime.enable' }),
    });
    return await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        root.off('Target.receivedMessageFromTarget', listener);
        reject(Error('Target evaluation timed out'));
      }, 15000);
      const listener = (event) => {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message);
        if (reply.id !== 1) return;
        clearTimeout(timeout);
        root.off('Target.receivedMessageFromTarget', listener);
        if (reply.error || reply.result?.exceptionDetails)
          reject(Error('Target evaluation failed'));
        else resolve(reply.result?.result?.value);
      };
      root.on('Target.receivedMessageFromTarget', listener);
      try {
        await root.send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          }),
        });
      } catch (error) {
        clearTimeout(timeout);
        root.off('Target.receivedMessageFromTarget', listener);
        reject(error);
      }
    });
  } finally {
    await root.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
// Extension-owned workers bypass Playwright routing. Gate their fetch before
// starting source playback: offline calls never leave Chrome; live calls reserve
// a shared budget slot before using the worker's ORIGINAL fetch and credentials.
async function gateNetworkWorker(targetId) {
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: false });
  let serial = 10;
  const pending = new Map();
  function command(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Network gate timed out: ' + method));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      root
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
    });
  }
  root.on('Target.receivedMessageFromTarget', async (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id && pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error || message.result?.exceptionDetails)
        p.reject(Error('Network gate command failed'));
      else p.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.bindingCalled' && message.params.name === 'listenAsrDebug') {
      recordAsr(JSON.parse(message.params.payload));
      return;
    }
    if (message.method !== 'Runtime.bindingCalled' || message.params.name !== 'listenFetchGate')
      return;
    const request = JSON.parse(message.params.payload);
    let allowed = true;
    if (!v.offline) {
      try {
        await reserveRequest(v.budget, { tool: 'browser', runId });
      } catch {
        budgetStopped = true;
        allowed = false;
      }
    }
    let input = null;
    try {
      input = JSON.parse(request.body.messages.at(-1).content);
    } catch {}
    attempts.push({
      number: attempts.length + 1,
      model: request.body.model,
      context: input,
      firstMemoAttempt: !input?.previousSummary?.trim(),
      shortPrompt: String(request.body.system ?? request.body.messages?.[0]?.content).includes(
        'At most 50 words',
      ),
      reserved: allowed,
      at: Date.now(),
    });
    const analysis = {
      summary: '# Transport verification\nSynthetic response; not measured meeting notes.',
      updates: [],
      question: null,
    };
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'offline', name: 'meeting_analysis', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(analysis) },
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const reply = {
      allowed,
      offline: !!v.offline,
      body: v.offline
        ? events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
        : null,
    };
    await command('Runtime.evaluate', {
      expression: `globalThis.listenGateReplies.get(${request.id})(${JSON.stringify(reply)})`,
    }).catch(() => {});
  });
  await command('Runtime.enable');
  if (v['capture-asr']) {
    await command('Runtime.addBinding', { name: 'listenAsrDebug' });
    await command('Runtime.evaluate', {
      expression: await readFile('scripts/whisper-debug-capture.js', 'utf8'),
    });
    report.asrObserver = {
      scope:
        'Isolated evaluation copy only; first eight PCM inputs; all results and generation tokens',
      hash: createHash('sha256')
        .update(await readFile('scripts/whisper-debug-worker.js'))
        .update(await readFile('scripts/whisper-debug-capture.js'))
        .update(await readFile('scripts/whisper-debug-metrics.mjs'))
        .digest('hex'),
      timing:
        'Observer copies PCM and reads generation tokens; timings include diagnostic overhead',
    };
  }
  await command('Runtime.addBinding', { name: 'listenFetchGate' });
  await command('Runtime.evaluate', {
    expression: `(() => {
    const NativeWorker=globalThis.Worker; let serial=0;
    globalThis.listenGateReplies=new Map();
    globalThis.Worker=class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if(!String(url).endsWith('/assistant/network-worker.js'))return;
        this.addEventListener('message', event=>{
          if(event.data?.type!=='EVALUATION_FETCH')return;
          event.stopImmediatePropagation();
          const id=++serial, workerId=event.data.id;
          globalThis.listenGateReplies.set(id,reply=>{
            globalThis.listenGateReplies.delete(id);
            this.postMessage({type:'EVALUATION_FETCH_REPLY',id:workerId,reply});
          });
          globalThis.listenFetchGate(JSON.stringify({id,body:event.data.body}));
        });
      }
    };
  })()`,
  });
  report.environment.providerTransport =
    'worker native fetch, with local pre-send budget gate; synthetic Response in offline mode';
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:' && location.pathname === '/setup.html') {
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (descriptor) =>
        descriptor.name === 'microphone'
          ? Promise.resolve({
              state: 'granted',
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
            })
          : query(descriptor);
    }
  });
  context.on('page', (page) => {
    page.on('pageerror', (e) => errors.push(e.name)); // Do not serialize provider errors or credentials.
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
  });
  root = await context.browser().newBrowserCDPSession();
  await root.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
  await mkdir(path.resolve(v.output + '.audio'), { recursive: true });
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.resolve(v.output + '.audio'),
  });
  const { id } = await root.send('Extensions.loadUnpacked', { path: evaluationBuild });
  setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/setup.html`);
  report.environment = await setup.evaluate(() => ({
    browser: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    gpuAvailable: 'gpu' in navigator,
    modelCache: 'copied-if-available; actual preparation traced',
    microphone: 'silent test stream; native tab capture',
  }));
  await setup.evaluate(
    async ({ runId, policy, key }) => {
      await chrome.storage.session.set({ listenDiagnostics: { enabled: true, runId, policy } });
      await chrome.storage.local.set({
        microphoneReady: true,
        transcriptionEnabled: true,
        assistantKey: key,
        assistantSettings: {
          enabled: true,
          model: 'claude-sonnet-5-5',
          goal: '',
          benchmarkPassed: false,
        },
      });
      await chrome.runtime.sendMessage({ target: 'worker', type: 'TRANSCRIPT_STATUS' });
      window.evaluationRevisions = [];
      window.evaluationSegments = [];
      window.evaluationDownloadIds = [];
      chrome.downloads.onCreated.addListener((item) => window.evaluationDownloadIds.push(item.id));
      chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'ASSISTANT_STATE' && message.snapshot.summary) {
          const revisions = window.evaluationRevisions;
          if (revisions.at(-1)?.memo !== message.snapshot.summary)
            revisions.push({
              at: performance.timeOrigin + performance.now(),
              version: message.snapshot.version,
              memo: message.snapshot.summary,
              throughSegmentId: message.snapshot.lastSegmentId,
            });
        }
        if (message.type === 'TRANSCRIPT_STATE') {
          for (const segment of message.snapshot.segments)
            if (
              !window.evaluationSegments.some(
                (s) => s.id === segment.id && s.sessionId === segment.sessionId,
              )
            )
              window.evaluationSegments.push({
                ...segment,
                availableAt: performance.timeOrigin + performance.now(),
              });
        }
      });
    },
    { runId, policy: v.variant, key: v.offline ? 'offline-test-key' : process.env.LISTEN_HPOP_KEY },
  );
  const targets = await root.send('Target.getTargets');
  const offscreen = targets.targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
  if (!offscreen) throw Error('Offscreen target unavailable');
  // Only microphone is replaced. Fake-device Chrome flags also replace tab capture.
  await targetEval(
    offscreen.targetId,
    `(() => {
    const nativeQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor.name === 'microphone' ? Promise.resolve({state: 'granted'}) : nativeQuery(descriptor);
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.audio?.mandatory?.chromeMediaSource === 'tab') return native(constraints);
      const c = new AudioContext(); await c.resume();
      const destination = c.createMediaStreamDestination();
      const oscillator = c.createOscillator(), gain = c.createGain(); gain.gain.value = 0;
      oscillator.connect(gain).connect(destination); oscillator.start();
      const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); void c.close(); };
      return destination.stream;
    };
  })()`,
  );
  await gateNetworkWorker(offscreen.targetId);
  // Preparation precedes the click for the primary warmed cohort; cold-restoration
  // timing is in model.preparing/prepared, never called a warmed click measurement.
  const prepared =
    v.cohort === 'warmed'
      ? await setup.evaluate(() =>
          chrome.runtime.sendMessage({ target: 'worker', type: 'PREPARE_TRANSCRIPTION' }),
        )
      : { ok: true };
  if (!prepared?.ok) throw Error('Model preparation failed');
  const source = await context.newPage();
  await source.goto(v.url || `http://127.0.0.1:${server.address().port}`);
  if (v.url)
    await source
      .locator('video')
      .first()
      .evaluate((el) => {
        el.pause();
        el.currentTime = 0;
      });
  await source.bringToFront();
  const tabs = await root.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = tabs.targetInfos.find((t) => t.url === source.url());
  if (!target) throw Error('Source tab target unavailable');
  await root.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing',
    transferMode: 'ReturnAsStream',
  });
  traceStarted = true;
  await root.send('Extensions.triggerAction', { id, targetId: target.targetId });
  // Chrome does not consistently expose action popups to Playwright. Open the
  // actual sidebar through its existing Settings action and exercise its Listen control.
  await source.keyboard.press('Escape');
  await setup.locator('#finish').click();
  let panelTarget;
  for (let i = 0; i < 50 && !panelTarget; i++) {
    panelTarget = (await root.send('Target.getTargets')).targetInfos.find((t) =>
      t.url.endsWith('/assistant.html'),
    );
    if (!panelTarget) await sleep(100);
  }
  if (!panelTarget) throw Error('Actual assistant side panel unavailable');
  await source.bringToFront();
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await targetEval(
      panelTarget.targetId,
      `!document.getElementById('start')?.disabled && document.getElementById('start')?.getClientRects().length > 0`,
    );
    if (!ready) await sleep(100);
  }
  if (!ready) throw Error('Actual sidebar Listen control did not become ready');
  await targetEval(panelTarget.targetId, `document.getElementById('start').click()`);
  await waitStatus((s) => s.phase === 'recording', 30000);
  if (audio)
    await source.locator('audio').evaluate((el) => {
      el.currentTime = 0;
      return el.play();
    });
  else {
    // YouTube/public player: restore beginning after capture, record the exact offset.
    if (await source.locator('.ad-showing').count())
      throw Error('Player is showing an advertisement; podcast opening is not comparable');
    const video = source.locator('video').first();
    await video.waitFor({ timeout: 15000 });
    await video.evaluate((el) => {
      el.currentTime = 0;
      return el.play();
    });
  }
  const playback = await source
    .locator(audio ? 'audio' : 'video')
    .first()
    .evaluate((el) => ({
      at: performance.timeOrigin + performance.now(),
      currentTimeMs: el.currentTime * 1000,
    }));
  report.audioPlaybackAt = playback.at - playback.currentTimeMs;
  report.audioPlaybackMeasurement =
    'Media currentTime subtracted from monotonic probe; estimate of source time zero';
  const contexts = await setup.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
  );
  if (!contexts.length) throw Error('Actual sidebar did not open');
  panelTarget = (await root.send('Target.getTargets')).targetInfos.find((t) =>
    t.url.endsWith('/assistant.html'),
  );
  if (panelTarget)
    await targetEval(panelTarget.targetId, `document.visibilityState === 'visible'`).then(
      (visible) => {
        report.environment.sidePanelVisibleAtStart = visible;
        if (!visible) throw Error('Sidebar hidden; cannot measure visible delivery');
      },
    );
  const end = Date.now() + duration * 1000;
  while (Date.now() < end && !budgetStopped) await sleep(Math.min(1000, end - Date.now()));
  await setup.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'STOP' }));
  // Let final transcription, AI and downloads settle; these events are tagged after-stop in reports.
  await waitStatus(
    (s) =>
      !s.transcriptionBusy &&
      !s.assistantBusy &&
      !['recording', 'stopping', 'saving'].includes(s.phase),
    75000,
  );
  report.finalStatus = await setup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
  );
  const savedDownloads = await setup.evaluate(async () =>
    Promise.all(
      window.evaluationDownloadIds.map(async (id) => (await chrome.downloads.search({ id }))[0]),
    ),
  );
  downloads.splice(
    0,
    downloads.length,
    ...savedDownloads.map((d) => ({ filename: d?.filename, state: d?.state })),
  );
  if (
    downloads.length !== 3 ||
    downloads.some((d) => d.state !== 'complete') ||
    report.finalStatus.value?.phase !== 'idle'
  )
    throw Error('Three audio downloads and idle final state were not verified');
  report.complete = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Browser evaluation failed';
  if (root) {
    const targets = await root.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const panel = targets.targetInfos.find((t) => t.url.endsWith('/assistant.html'));
    if (panel)
      report.panelError = await targetEval(
        panel.targetId,
        `document.getElementById('ai-error')?.textContent`,
      ).catch(() => null);
  }
} finally {
  if (setup && !setup.isClosed()) {
    await sleep(300);
    const collected = await setup
      .evaluate(async () => ({
        trace: (await chrome.storage.session.get('listenDiagnosticTrace')).listenDiagnosticTrace,
        revisions: window.evaluationRevisions || [],
        segments: window.evaluationSegments || [],
      }))
      .catch(() => ({}));
    report.events = (collected.trace?.events || []).sort((a, b) => a.at - b.at);
    const sent = report.events.filter((e) => e.name === 'provider.sent');
    for (let i = 0; i < attempts.length; i++)
      Object.assign(attempts[i], { requestId: sent[i]?.requestId, version: sent[i]?.version });
    report.droppedEvents = collected.trace?.dropped || 0;
    report.revisions = collected.revisions || [];
    report.segments = collected.segments || [];
    const click = report.events.find((e) => e.name === 'listen.clicked');
    const capture = report.events.find((e) => e.name === 'capture.started');
    const presentation = report.events.find((e) => e.name === 'memo.presentation_estimate');
    report.clickAt = click?.at ?? null;
    report.captureAt = capture?.at ?? null;
    report.firstPresentationMs = click && presentation ? presentation.at - click.at : null;
    report.presentationMeasurement =
      'Double requestAnimationFrame, visible DOM; estimate, inspect Chrome trace for rendering evidence';
  }
  if (root && traceStarted) {
    const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
    await root.send('Tracing.end');
    const { stream } = await complete;
    let data = '';
    try {
      for (;;) {
        const chunk = await root.send('IO.read', { handle: stream });
        data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
        if (chunk.eof) break;
      }
      await writeFile(v.output + '.chrome-trace.json', data);
      report.chromeTrace = path.resolve(v.output + '.chrome-trace.json');
    } finally {
      await root.send('IO.close', { handle: stream });
    }
  }
  report.budgetStopped = budgetStopped;
  await Promise.all(asrWrites);
  report.budget = v.offline ? null : await budgetStatus(v.budget);
  await writeFile(v.output, JSON.stringify(report, null, 2));
  await context?.close();
  // Keep the stable evaluation origin's model cache for the next paired run.
  for (const part of ['Default/Service Worker/CacheStorage', 'Default/WebStorage']) {
    await mkdir(path.dirname(path.join(v.cache, part)), { recursive: true });
    await cp(path.join(profile, part), path.join(v.cache, part), { recursive: true }).catch((e) => {
      if (e.code !== 'ENOENT') report.cacheSaveFailed = true;
    });
  }
  await buildLock.close();
  await rm(evaluationBuild + '.lock', { force: true });
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await writeFile(v.output, JSON.stringify(report, null, 2));
}
console.log(
  `Saved ${v.output}; ${report.complete ? 'completed' : 'incomplete'}; quality review pending.`,
);
if (!report.complete) process.exitCode = 1;
