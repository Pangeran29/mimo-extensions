// Actual tab capture + packaged VAD + WebGPU recognition in an isolated Chrome profile.
// Uses attributed public speech, a silent synthetic mic, and no personal browser data.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const assistantTest = process.env.LISTEN_ASSISTANT === '1';
const assistantFault = process.env.LISTEN_ASSISTANT_FAULT === '1';
let apiFault = false,
  apiResumed = false,
  deeperRequested = false;
let assistantWindowClosed = false;
let assistantWindowReopened = false;
let aiFailedButRecording = false;
let assistantSamples = [];
const seconds = Number(process.env.LISTEN_SOAK_SECONDS || 32);
const continuous = process.env.LISTEN_CONTINUOUS_SPEECH === '1';
const micSpeech = process.env.LISTEN_MIC_SPEECH === '1';
const fault = process.env.LISTEN_TRANSCRIPTION_FAULT === 'worker-crash';
let faultInjected = false;
const output = path.resolve('artifacts/transcription-downloads');
await mkdir(output, { recursive: true });
const speech = await readFile(
  continuous ? 'artifacts/speech/continuous.wav' : 'artifacts/speech/mixed.wav',
);
const server = createServer((req, res) => {
  if (req.url === '/speech.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(speech);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Bilingual speech test</title><audio id="audio" src="/speech.wav" loop controls></audio>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(path.resolve('artifacts/transcription-profile-'));
await mkdir(path.join(profile, 'Default', 'Service Worker'), {
  recursive: true,
});
await cp(
  'artifacts/transcription-gate-profile/Default/Service Worker/CacheStorage',
  path.join(profile, 'Default', 'Service Worker', 'CacheStorage'),
  { recursive: true },
);
await cp(
  'artifacts/transcription-gate-profile/Default/WebStorage',
  path.join(profile, 'Default', 'WebStorage'),
  { recursive: true },
);
let context;
const errors = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  context.on('page', (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: path.resolve('dist'),
  });
  await root.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: output,
  });
  let setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/setup.html`);
  await setup.evaluate(async () => {
    await chrome.storage.local.set({ microphoneReady: true });
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (!contexts.length)
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Isolated local transcription test',
      });
  });
  const { targetInfos } = await root.send('Target.getTargets');
  const target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
  const { sessionId } = await root.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  });
  let nextId = 0;
  let modelSession;
  let aiSession;
  root.on('Target.receivedMessageFromTarget', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message);
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') {
      if (m.params.targetInfo.url.endsWith('network-worker.js')) aiSession = m.params.sessionId;
      else modelSession = m.params.sessionId;
    }
    if (m.method === 'Runtime.consoleAPICalled')
      console.log('Browser:', m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(JSON.stringify(m.params.exceptionDetails));
  });
  async function call(method, params = {}) {
    const requestId = ++nextId;
    const response = new Promise((resolve, reject) => {
      const listener = (e) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message);
        if (m.id !== requestId) return;
        root.off('Target.receivedMessageFromTarget', listener);
        if (m.error || m.result?.exceptionDetails)
          reject(Error(JSON.stringify(m.error ?? m.result.exceptionDetails)));
        else resolve(m.result);
      };
      root.on('Target.receivedMessageFromTarget', listener);
    });
    await root.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id: requestId, method, params }),
    });
    return response;
  }
  async function evaluate(expression) {
    return (
      await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    )?.result?.value;
  }
  await call('Runtime.enable');
  if (fault || assistantFault)
    await call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
  await call('Performance.enable');
  await evaluate(`(()=>{
   const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{
    if(constraints.audio?.mandatory?.chromeMediaSource==='tab')return native(constraints);
    const c=new AudioContext();const d=c.createMediaStreamDestination();const o=c.createOscillator();const g=c.createGain();g.gain.value=0;o.connect(g).connect(d);o.start();
    window.testMicrophone={context:c,destination:d};
    const track=d.stream.getAudioTracks()[0];const stop=track.stop.bind(track);track.stop=()=>{stop();o.stop();void c.close();};return d.stream;
   };
 })()`);
  const rpc = (type, extra = {}) =>
    setup.evaluate(
      async ({ type, extra }) => {
        const reply = await chrome.runtime.sendMessage({
          target: 'worker',
          type,
          ...extra,
        });
        if (!reply?.ok) throw Error(reply?.error ?? 'No response');
        return reply.value;
      },
      { type, extra },
    );
  const panelWindowId = await setup.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const setupCDP = await context.newCDPSession(setup);
  async function openAssistantPanel() {
    const r = await setupCDP.send('Runtime.evaluate', {
      expression: `chrome.sidePanel.open({windowId:${panelWindowId}})`,
      userGesture: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error('Could not open assistant panel');
  }
  // Block all HTTP(S) traffic while preparing from the already-populated cache.
  await context.route(/^https?:\/\//, (route) => route.abort());
  console.log('Preparing cached model with external networking blocked…');
  console.log('Prepared:', await rpc('PREPARE_TRANSCRIPTION'));
  await context.unroute(/^https?:\/\//);
  if (assistantTest) {
    await setup.locator('#ai-enabled').check();
    await setup.locator('#ai-model').selectOption('claude-haiku-4-5-20251001');
    await setup.locator('#ai-key').fill(process.env.LISTEN_HPOP_KEY ?? '');
    await setup.locator('#ai-save').click();
    await setup
      .waitForFunction(
        () => document.getElementById('ai-result').textContent.startsWith('AI enabled'),
        null,
        { timeout: 5000 },
      )
      .catch(async (e) => {
        console.log('AI setup:', await setup.locator('#ai-result').innerText());
        throw e;
      });
    await openAssistantPanel();
  }

  const source = await context.newPage();
  await source.goto(`http://127.0.0.1:${server.address().port}`);
  await source.bringToFront();
  const targets = (
    await root.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }],
    })
  ).targetInfos;
  await root.send('Extensions.triggerAction', {
    id,
    targetId: targets.find((t) => t.url === source.url()).targetId,
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await source.bringToFront();
  await popup.reload();
  await popup.locator('#main-action').click();
  await popup
    .getByText('Listening', { exact: true })
    .waitFor({ timeout: 15000 })
    .catch(async (e) => {
      console.log(await popup.locator('body').innerText());
      throw e;
    });
  if (assistantTest)
    await setup.evaluate(() => {
      globalThis.aiEvents = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m.target === 'ui' && m.type === 'ASSISTANT_STATE')
          globalThis.aiEvents.push({ phase: m.snapshot.phase, v: m.snapshot.version });
        if (m.target === 'ui' && m.type === 'STATE')
          globalThis.aiEvents.push({ recorder: m.status.phase, aiBusy: m.status.assistantBusy });
      });
    });
  const started = Date.now(),
    metrics = [];
  if (micSpeech) {
    const speech = (await readFile('artifacts/speech/id_id.wav')).toString('base64');
    await evaluate(
      `(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(speech)}),c=>c.charCodeAt(0));const {context,destination}=window.testMicrophone;const b=await context.decodeAudioData(bytes.buffer);const s=context.createBufferSource();s.buffer=b;s.connect(destination);s.start();})()`,
    );
    await new Promise((r) => setTimeout(r, 9500));
    await source.locator('audio').evaluate((a) => {
      a.currentTime = 9.08;
      return a.play();
    });
  } else await source.locator('audio').evaluate((a) => a.play());
  while (Date.now() - started < seconds * 1000) {
    await new Promise((r) =>
      setTimeout(r, Math.min(10000, seconds * 1000 - (Date.now() - started))),
    );
    const snapshot = await rpc('TRANSCRIPT_STATUS');
    if (assistantTest) {
      const a = await rpc('ASSISTANT_STATUS');
      console.log('AI:', a.phase, a.version, a.latencyMs, a.message);
      assistantSamples.push({
        at: Date.now() - started,
        phase: a.phase,
        version: a.version,
        lastSegmentId: a.lastSegmentId,
        latencyMs: a.latencyMs,
        message: a.message,
        summary: a.summary,
        deeperBusy: a.deeperBusy,
        deeperLength: a.deeper?.length ?? 0,
        deeperError: a.deeperError,
        question: a.question,
      });
      if (assistantFault && !apiFault && Date.now() - started > 20000) {
        if (!aiSession) throw Error('AI worker not attached for failure injection');
        await call('Target.sendMessageToTarget', {
          sessionId: aiSession,
          message: JSON.stringify({
            id: 91001,
            method: 'Runtime.evaluate',
            params: {
              expression: `globalThis.originalAIFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'Injected auth failure',type:'authentication_error'}}),{status:401,headers:{'Content-Type':'application/json'}});`,
            },
          }),
        });
        apiFault = true;
      }
      if (assistantFault && apiFault && !apiResumed && a.phase === 'paused') {
        await rpc('ASSISTANT_RESUME');
        apiResumed = true;
      }
      if (!deeperRequested && a.version > 0 && process.env.LISTEN_ASSISTANT_DEEPER === '1') {
        deeperRequested = true;
        await rpc('ASSISTANT_DEEPER', { sessionId: a.sessionId });
      }
      if (a.phase === 'paused') {
        if ((await rpc('STATUS')).phase !== 'recording')
          throw Error('AI failure stopped recording');
        aiFailedButRecording = true;
      }
      if (!assistantWindowClosed && Date.now() - started > 15000) {
        await setup.evaluate((windowId) => chrome.sidePanel.close({ windowId }), panelWindowId);
        assistantWindowClosed = true;
      }
      if (assistantWindowClosed && !assistantWindowReopened && Date.now() - started > 25000) {
        await openAssistantPanel();
        assistantWindowReopened = true;
      }
    }
    const perf = await call('Performance.getMetrics');
    const values = Object.fromEntries(perf.metrics.map((m) => [m.name, m.value]));
    const processes = (await root.send('SystemInfo.getProcessInfo')).processInfo;
    const processIds = new Set(processes.map((p) => p.id));
    const rssKB = execFileSync('/bin/ps', ['-axo', 'pid=,rss='], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .reduce((total, line) => {
        const [pid, rss] = line.trim().split(/\s+/).map(Number);
        return total + (processIds.has(pid) ? rss : 0);
      }, 0);
    const cpuSeconds = processes.reduce((sum, p) => sum + p.cpuTime, 0);
    const memory = await evaluate(`({heap:performance.memory?.usedJSHeapSize})`);
    metrics.push({
      elapsedSeconds: (Date.now() - started) / 1000,
      phase: snapshot.phase,
      segments: snapshot.segments.length,
      lagMs: snapshot.lagMs,
      audioQueueMs: snapshot.audioQueueMs,
      lastInferenceMs: snapshot.lastInferenceMs,
      processRssBytes: rssKB * 1024,
      cpuSeconds,
      heapBytes: memory?.heap,
      taskSeconds: values.TaskDuration,
    });
    console.log(JSON.stringify(metrics.at(-1)));
    if (snapshot.phase === 'failed' && !fault) throw Error(snapshot.message);
    if (fault && !faultInjected && snapshot.segments.length) {
      if (!modelSession) throw Error('Cannot find model worker for failure injection');
      await call('Target.sendMessageToTarget', {
        sessionId: modelSession,
        message: JSON.stringify({
          id: 90001,
          method: 'Runtime.evaluate',
          params: {
            expression: 'setTimeout(()=>{throw new Error("Injected worker crash")},0)',
          },
        }),
      });
      faultInjected = true;
    }
    if (faultInjected) {
      const live = await rpc('STATUS');
      if (live.phase !== 'recording') throw Error('Model failure stopped audio recording');
    }

    if (Date.now() - started > 11000 && !popup.isClosed()) {
      await popup.close();
      await setup.bringToFront();
    }
  }
  await source.locator('audio').evaluate((a) => a.pause());
  console.log('Stopping:', await rpc('STOP'));
  let transcript, status;
  for (let i = 0; i < 400; i++) {
    transcript = await rpc('TRANSCRIPT_STATUS');
    status = await rpc('STATUS');
    if (['complete', 'failed'].includes(transcript.phase) && status.phase === 'idle') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (transcript.phase !== (fault ? 'failed' : 'complete'))
    throw Error('Incomplete transcription: ' + JSON.stringify(transcript));
  if (status.phase !== 'idle')
    throw Error('Audio did not finish saving: ' + JSON.stringify(status));
  const text = transcript.segments.map((s) => s.text).join(' ');
  if (
    !fault &&
    !continuous &&
    (!/virtual|konvens|standar/i.test(text) || !/communication|channels|styles/i.test(text))
  )
    throw Error('Missing one of the languages: ' + text);
  if (continuous && !transcript.segments.some((s, i, a) => i > 0 && s.startMs < a[i - 1].endMs))
    throw Error('Continuous fixture did not exercise forced overlap');
  if (fault && (!transcript.incomplete || !text || !faultInjected))
    throw Error('Worker failure did not retain completed text with a warning');
  let closed = false;
  for (let i = 0; i < 150; i++) {
    closed = await setup.evaluate(
      async () =>
        !(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length,
    );
    if (closed) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!closed) throw Error('Offscreen recorder did not close after final AI work');
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${id}/popup.html`);
  const restoredTranscript = await rpc('TRANSCRIPT_STATUS');
  if (
    restoredTranscript.segments.map((s) => s.text).join('\n') !==
    transcript.segments.map((s) => s.text).join('\n')
  )
    throw Error('Saved transcript restoration failed');
  if (await reopened.locator('#transcript-text').count())
    throw Error('Caption unexpectedly rendered in toolbar popup');
  const saved = await setup.evaluate(() => chrome.downloads.search({}));
  const files = saved
    .filter(
      (d) =>
        d.state === 'complete' &&
        d.filename.startsWith(output) &&
        Date.parse(d.startTime) >= started - 2000,
    )
    .sort((a, b) => a.id - b.id);
  if (files.length < 3) throw Error('Three audio exports did not complete');
  const playback = [];
  for (const f of files.slice(0, 3)) {
    const audio = await readFile(f.filename);
    playback.push(
      await setup.evaluate(async (bytes) => {
        const c = new AudioContext();
        const b = await c.decodeAudioData(new Uint8Array(bytes).buffer);
        await c.close();
        return { duration: b.duration, channels: b.numberOfChannels };
      }, Array.from(audio)),
    );
  }
  await reopened.screenshot({
    path: 'artifacts/transcription-popup.png',
    clip: { x: 0, y: 0, width: 304, height: 500 },
  });
  let assistantFinal;
  if (assistantTest) {
    assistantFinal = await rpc('ASSISTANT_STATUS');
    console.log(
      'Final AI:',
      assistantFinal.phase,
      assistantFinal.version,
      assistantFinal.message,
      'deeper:',
      !!assistantFinal.deeper,
    );
    console.log(
      'Final contexts/events:',
      await setup.evaluate(async () => ({
        contexts: await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
        events: globalThis.aiEvents?.slice(-30),
      })),
    );
    if (!['complete', 'disabled'].includes(assistantFinal.phase))
      throw Error('AI did not restore a settled status: ' + assistantFinal.phase);

    const page = context.pages().find((p) => p.url().endsWith('/assistant.html'));
    if (page) {
      await page.setViewportSize({ width: 440, height: 680 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: 'artifacts/assistant-window.png' });
    }
    if (!assistantSamples.some((a) => a.version > 0))
      throw Error('No AI analysis accepted during the browser session');
    if (assistantFault && (!apiFault || !apiResumed || !aiFailedButRecording))
      throw Error('AI authentication-failure recovery did not complete');
  }
  const report = {
    assistantFinal,
    assistantFault,
    apiFault,
    apiResumed,
    deeperRequested,
    assistantTest,
    assistantSamples,
    assistantWindowClosed,
    assistantWindowReopened,
    aiFailedButRecording,
    browser: context.browser().version(),
    seconds,
    continuousSpeech: continuous,
    injectedWorkerFailure: faultInjected,
    offscreenClosed: true,
    offlineCachedPreparation: true,
    nativeTabCapture: true,
    syntheticSilentMicrophone: !micSpeech,
    publicSpeechMicrophone: micSpeech,
    popupRestoration: true,
    transcript,
    metrics,
    files: files.slice(0, 3),
    playback,
    errors,
  };
  await writeFile(
    `artifacts/${assistantFault ? 'assistant-auth' : assistantTest ? 'assistant' : 'transcription'}-${fault ? 'failure' : continuous ? 'continuous' : seconds >= 1200 ? 'soak' : 'smoke'}.json`,
    JSON.stringify(report, null, 2),
  );
  if (errors.length) throw Error('Browser errors: ' + errors.join('; '));
  console.log(
    'Transcription integration passed:',
    transcript.segments.length,
    'segments; all three exports decoded.',
  );
} finally {
  await context?.close();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
