// Optional integration check. Requires Playwright and Chrome 155+ with Extensions.triggerAction.
// Uses an isolated profile and generated audio, never your actual microphone or personal tabs.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve('artifacts');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'listen-smoke-'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Audio capture test</title><button id="play">Play test tone</button><script>play.onclick=()=>{const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();o.frequency.value=440;g.gain.value=.2;o.connect(g).connect(c.destination);o.start();window.audio=c;}</script>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let context;
const errors = [];
const downloads = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: !process.env.LISTEN_HEADED,
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  context.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    p.on('download', (d) => downloads.push(d));
  });
  const browserCDP = await context.browser().newBrowserCDPSession();
  const { id } = await browserCDP.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
  console.log('Extension loaded:', id);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  console.log('Worker ready');

  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/setup.html`);
  console.log('Setup page ready');
  // Inject only microphone acquisition, leaving native tab capture and the audio graph untouched.
  // Chrome's fake-device flags also replace tab capture, so they cannot validate the two sources.
  const syntheticMic = `(()=>{
   const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{
     if(constraints.audio?.mandatory?.chromeMediaSource==='tab')return native(constraints);
     const c=new AudioContext();await c.resume();const o=c.createOscillator();const g=c.createGain();
     const d=c.createMediaStreamDestination();o.frequency.value=880;g.gain.value=.2;o.connect(g).connect(d);o.start();
     const track=d.stream.getAudioTracks()[0];const stop=track.stop.bind(track);
     track.stop=()=>{stop();o.stop();void c.close();};return d.stream;
   };
 })()`;
  await setup.evaluate(syntheticMic);
  await setup.evaluate(() =>
    chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Isolated capture integration test',
    }),
  );
  const { targetInfos: offscreenTargets } = await browserCDP.send('Target.getTargets');
  const offscreenTarget = offscreenTargets.find((t) => t.url.endsWith('/offscreen.html'));
  if (!offscreenTarget) throw Error('Offscreen recorder target not found');
  const { sessionId: offscreenSession } = await browserCDP.send('Target.attachToTarget', {
    targetId: offscreenTarget.targetId,
    flatten: false,
  });
  const injected = new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.sessionId !== offscreenSession) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      browserCDP.off('Target.receivedMessageFromTarget', listener);
      message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result);
    };
    browserCDP.on('Target.receivedMessageFromTarget', listener);
  });
  await browserCDP.send('Target.sendMessageToTarget', {
    sessionId: offscreenSession,
    message: JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: syntheticMic },
    }),
  });
  await injected;
  await setup.locator('#grant').click();
  await setup.getByText('Microphone allowed.', { exact: false }).waitFor();
  const source = await context.newPage();
  await source.goto(`http://127.0.0.1:${server.address().port}`);
  await source.locator('#play').click();
  await source.bringToFront();
  const { targetInfos } = await browserCDP.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const sourceTarget = targetInfos.find((t) => t.url === source.url());
  if (!sourceTarget) throw Error('Source tab target not found: ' + JSON.stringify(targetInfos));
  await browserCDP.send('Extensions.triggerAction', { id, targetId: sourceTarget.targetId });
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(
    'Pages:',
    context.pages().map((p) => p.url()),
  );
  let popup = context.pages().find((p) => p.url().endsWith('/popup.html'));
  if (!popup) {
    // Headless Chrome does not expose an action popup target. Render the same UI in a tab.
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await source.bringToFront();
    await popup.reload();
  }
  await popup.locator('#main-action').waitFor({ state: 'visible' });
  await popup.waitForFunction(() => !document.getElementById('main-action').disabled);
  await popup.screenshot({
    path: path.join(output, 'popup-idle.png'),
    clip: {
      x: 0,
      y: 0,
      width: 304,
      height: Math.ceil((await popup.locator('main').boundingBox()).height),
    },
  });
  if (await popup.locator('#transcript-text').count())
    throw Error('Toolbar popup still contains transcript');
  await popup.locator('#main-action').click();
  await popup
    .getByText('Listening', { exact: true })
    .waitFor({ timeout: 8000 })
    .catch(async (e) => {
      console.log('Popup failure:', await popup.locator('body').innerText());
      console.log('Errors:', errors);
      throw e;
    });
  const panelContexts = await setup.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }),
  );
  if (!panelContexts.some((c) => c.documentUrl?.endsWith('/assistant.html')))
    throw Error('Listen did not automatically open the assistant panel');
  await popup.screenshot({
    path: path.join(output, 'recording-popup.png'),
    clip: {
      x: 0,
      y: 0,
      width: 304,
      height: Math.ceil((await popup.locator('main').boundingBox()).height),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await popup.close();
  const other = await context.newPage();
  await other.goto('about:blank');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const live = await worker.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'recorder', type: 'STATUS' }),
  );
  if (live.value?.phase !== 'recording')
    throw Error('Recording did not survive popup closure/tab switch');
  console.log('Live recording:', JSON.stringify(live.value.session));
  // The stop control is background messaging, just as the popup uses it.
  if (process.env.LISTEN_CANCEL_SMOKE) {
    await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  } else {
  // Inject a genuine save failure. Chrome's CDP 'deny' maps to USER_CANCELED,
  // which now intentionally discards audio rather than offering recovery.
  await worker.evaluate(() => {
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async () => {
      chrome.downloads.download = original;
      throw new Error('FILE_ACCESS_DENIED');
    };
  });
  }
  const reply = await setup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'worker', type: 'STOP' }),
  );
  console.log('Stop:', JSON.stringify(reply));
  if (process.env.LISTEN_CANCEL_SMOKE) {
    let result;
    for (let i = 0; i < 100; i++) {
      result = await setup.evaluate(() => chrome.runtime.sendMessage({target:'worker',type:'STATUS'}));
      if (result.value?.phase === 'idle') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (result?.value?.phase !== 'idle' || result.value.retained.length || result.value.error)
      throw Error('Cancellation did not return cleanly to idle: '+JSON.stringify(result));
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    if (badge) throw Error('Cancellation left an error badge: '+badge);
    const records = await setup.evaluate(() => chrome.downloads.search({}));
    if (records.length !== 1 || records[0].error !== 'USER_CANCELED')
      throw Error('Expected one canceled export and no further exports: '+JSON.stringify(records));
    await writeFile(path.join(output,'download-cancel-smoke.json'),JSON.stringify({
      browser:await context.browser().version(),status:result.value,badge,
      downloadReason:records[0].error,remainingExportsSkipped:true,errors,
    },null,2));
    console.log('Native cancellation smoke passed: clean idle, no badge, no retained audio or further exports.');
  } else {
  let failed;
  for (let i = 0; i < 100; i++) {
    failed = await setup.evaluate(() =>
      chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
    );
    if (failed.value?.phase === 'save-failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (failed.value?.phase !== 'save-failed' || !failed.value.session.bytes)
    throw Error('Denied download did not preserve audio for retry');
  console.log('Download failure retained:', JSON.stringify(failed.value.session));
  const recoveryPopup = await context.newPage();
  await recoveryPopup.goto(`chrome-extension://${id}/popup.html`);
  await recoveryPopup.locator('#recovery').waitFor({ state: 'visible' });
  await recoveryPopup.screenshot({
    path: path.join(output, 'popup-recovery.png'),
    clip: {
      x: 0,
      y: 0,
      width: 304,
      height: Math.min(600, Math.ceil((await recoveryPopup.locator('main').boundingBox()).height)),
    },
  });
  await recoveryPopup.close();

  await browserCDP.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  const retry = await setup.evaluate(
    (id) => chrome.runtime.sendMessage({ target: 'worker', type: 'RETRY', id }),
    failed.value.session.id,
  );
  if (!retry.ok) throw Error('Retry failed: ' + JSON.stringify(retry));
  let exported = [];
  for (let i = 0; i < 150; i++) {
    const records = await setup.evaluate(() => chrome.downloads.search({}));
    exported = records
      .filter((r) => r.mime === 'audio/webm' && r.state === 'complete')
      .sort((a, b) => a.id - b.id);
    if (exported.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (exported.length !== 3) {
    console.log(
      'Save status:',
      JSON.stringify(
        await setup.evaluate(() =>
          chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
        ),
      ),
    );
    throw Error(`Expected three completed downloads, got ${exported.length}`);
  }
  const names = ['combined', 'microphone', 'tab'];
  for (let i = 0; i < 3; i++)
    await copyFile(exported[i].filename, path.join(output, `smoke-${names[i]}.webm`));
  console.log('Downloads:', JSON.stringify(exported));
  const playback = await context.newPage();
  // Local file playback tests the actual exported artifact, with real Chromium decoding.
  await playback.goto('file://' + path.join(output, 'smoke-combined.webm'));
  const playbackResult = await playback.evaluate(async () => {
    const a = document.querySelector('video,audio');
    if (!a) throw Error('No audio player');
    await a.play();
    await new Promise((r) => setTimeout(r, 1000));
    return { currentTime: a.currentTime, readyState: a.readyState, error: a.error?.message };
  });
  if (playbackResult.error || playbackResult.currentTime < 0.5)
    throw Error('Exported audio did not play');
  const analysis = [];
  for (const name of names) {
    const audio = await readFile(path.join(output, `smoke-${name}.webm`));
    const result = await playback.evaluate(async (bytes) => {
      const c = new AudioContext();
      const buffer = await c.decodeAudioData(new Uint8Array(bytes).buffer);
      const data = buffer.getChannelData(0);
      const start = Math.min(buffer.sampleRate, Math.floor(data.length / 4));
      const n = Math.min(buffer.sampleRate, data.length - start);
      const amplitude = (f) => {
        let re = 0,
          im = 0;
        for (let i = 0; i < n; i++) {
          const angle = (2 * Math.PI * f * i) / buffer.sampleRate;
          re += data[start + i] * Math.cos(angle);
          im += data[start + i] * Math.sin(angle);
        }
        return (2 * Math.hypot(re, im)) / n;
      };
      const result = {
        duration: buffer.duration,
        channels: buffer.numberOfChannels,
        tab440Hz: amplitude(440),
        mic880Hz: amplitude(880),
      };
      await c.close();
      return result;
    }, Array.from(audio));
    analysis.push({ source: name, ...result });
  }
  console.log('Decoded outputs:', JSON.stringify(analysis));
  const [combined, microphone, tab] = analysis;
  if (combined.tab440Hz < 0.005 || combined.mic880Hz < 0.005 || combined.channels !== 1)
    throw Error('Combined output missing sources');
  if (microphone.mic880Hz < 0.005 || microphone.tab440Hz > 0.002)
    throw Error('Microphone output is missing or contaminated with tab audio');
  if (tab.tab440Hz < 0.005 || tab.mic880Hz > 0.002)
    throw Error('Tab output is missing or contaminated with microphone audio');
  if (
    Math.max(...analysis.map((a) => a.duration)) - Math.min(...analysis.map((a) => a.duration)) >
    0.15
  )
    throw Error('Output durations differ unexpectedly');
  const final = await setup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
  );
  console.log('Final:', JSON.stringify(final));
  console.log('Playback:', JSON.stringify(playbackResult));
  if (final.value?.phase !== 'idle' || final.value.retained.length)
    throw Error('Successful download was not cleaned up');
  if (errors.length) throw Error('Browser errors: ' + errors.join('; '));
  await writeFile(
    path.join(output, 'browser-smoke.json'),
    JSON.stringify(
      {
        browser: await context.browser().version(),
        download: exported,
        downloadFailureAndRetry: true,
        automaticAssistantPanel: true,
        compactPopup: true,
        transcriptRemoved: true,
        popupCloseAndTabSwitch: true,
        playback: playbackResult,
        analysis,
        errors,
      },
      null,
      2,
    ),
  );
  await setup.evaluate(() => chrome.storage.local.set({ microphoneReady: false }));
  await source.evaluate(() => {
    document.title =
      'Weekly planning: an intentionally long meeting title that should wrap cleanly without widening the toolbar popup';
  });
  const compact = await context.newPage();
  await compact.goto(`chrome-extension://${id}/popup.html`);
  await source.bringToFront();
  await compact.reload();
  await compact.waitForFunction(
    () => document.getElementById('action-label').textContent === 'Set up',
  );
  await compact.screenshot({
    path: path.join(output, 'popup-setup.png'),
    clip: {
      x: 0,
      y: 0,
      width: 304,
      height: Math.ceil((await compact.locator('main').boundingBox()).height),
    },
  });
  if (await compact.evaluate(() => document.body.scrollWidth > document.body.clientWidth))
    throw Error('Compact popup overflows at normal width');
  await compact.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  const zoom = await compact.evaluate(() => ({
    viewport: innerWidth,
    width: document.querySelector('main').getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  if (zoom.overflow || zoom.width > 608) throw Error('Popup overflows at 200 percent zoom');
  await compact.screenshot({
    path: path.join(output, 'popup-zoom.png'),
    clip: {
      x: 0,
      y: 0,
      width: 608,
      height: Math.min(1000, Math.ceil((await compact.locator('main').boundingBox()).height)),
    },
  });
  await compact.close();
  console.log('Browser smoke passed. Synthetic audio only; not a real meeting/microphone test.');
  }
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
