// Actual isolated research extension: file playback -> VAD -> local fixed ASR/LLM
// -> post-meeting controller -> real browser FileSystemDirectoryHandle/IndexedDB writes.
// The destination is OPFS, NOT a selected OS directory; native picker invocation has
// separate evidence and still requires a real native selection check.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.mjs';
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const artifact = path.resolve(
  process.env.LISTEN_END_ARTIFACT || 'artifacts/end-meeting-2026-11-02/integration',
);
const buildDir = path.join(artifact, 'synthetic-build');
await mkdir(artifact, { recursive: true });
try {
  const previous = await readFile(path.join(artifact, 'result.json'));
  const history = path.join(artifact, 'run-history');
  await mkdir(history, { recursive: true });
  await writeFile(
    path.join(history, 'attempt-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'),
    previous,
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function sourceFingerprint() {
  const paths = [];
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, item.name);
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) paths.push(name);
    }
  };
  for (const directory of ['src', 'public', 'server', 'licenses']) await walk(directory);
  paths.push(
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'THIRD_PARTY_NOTICES.md',
    'scripts/build.mjs',
    'scripts/end-meeting-smoke.mjs',
  );
  const files = [];
  for (const name of paths.sort()) {
    const bytes = await readFile(name);
    files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  return { sha256: sha(JSON.stringify(files)), files };
}
const preservedPaths = [
  'dist/build-info.json',
  'dist/manifest.json',
  'artifacts/replay-lab/build/build-info.json',
  'artifacts/replay-lab/build/manifest.json',
  'artifacts/live-memo-v1/provider-budget.json',
  'artifacts/replay-lab-live/lemhanas-16-10-sample-600s-2026-10-31/provider-budget.json',
];
const preserved = new Map();
for (const file of preservedPaths) {
  try {
    preserved.set(file, await readFile(file));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
const fixture =
  'Synthetic end-meeting fixture: the team agreed to launch on 23 November. Rani will confirm support capacity by 18 November.';
const rejectionReason =
  'The action changes the deadline to 19 November, but the original transcript explicitly says 18 November. Preserve the agreed launch point and correct the deadline against its source.';
const checks = [],
  errors = [],
  requests = [],
  states = [],
  captures = [];
let context, page, profile, scenario, releaseAsr, releaseCompose, releaseRepair;
const check = (name, value, detail) => {
  assert.ok(value, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
  checks.push(name);
  console.log('PASS: ' + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sse(body, value) {
  const chunk = {
    id: 'offline-end-meeting',
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 100, total_tokens: 220 },
  };
  return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
const relay = createRelay({
  apiKey: 'synthetic-end-provider-secret',
  relayToken: 'synthetic-end-relay-token',
  providerFetch: async (url, options) => {
    assert.ok(scenario, 'Unexpected offline provider request');
    if (String(url).includes('/v1/inference/')) {
      scenario.calls.asr++;
      requests.push({ scenario: scenario.name, stage: 'asr', at: Date.now() });
      if (scenario.holdAsr) {
        scenario.asrHeld = true;
        await new Promise((r) => (releaseAsr = r));
        scenario.asrHeld = false;
      }
      return new Response(
        JSON.stringify({
          text: fixture,
          language: 'en',
          inference_status: { status: 'succeeded' },
        }),
      );
    }
    const body = JSON.parse(options.body),
      schema = body.response_format?.json_schema?.name;
    const input = JSON.parse(body.messages.find((m) => m.role === 'user').content);
    const stage = schema?.replace('meeting_minutes_', '').replace('_v1', '');
    requests.push({ scenario: scenario.name, schema, input, at: Date.now() });
    if (schema === 'live_memo_proposal_v2') {
      scenario.calls.proposal++;
      const source =
        (input.newTranscript?.[0] ?? input.recentTranscript?.[0] ?? input.evidence?.[0])?.id ?? 0;
      return sse(body, {
        protocol: 2,
        topic: { key: 'synthetic-end', label: 'Launch preparation', sources: [source] },
        topicChanged: false,
        updates: [],
        decision: 'silent',
        reason: 'Offline fixture; post-meeting behavior is under test.',
        memoUpdate: input.memo
          ? { action: 'keep', text: null, sources: [] }
          : {
              action: 'replace',
              text: 'The team agreed a launch date and a support follow-up.',
              sources: [source],
            },
        candidate: null,
        statusUpdate: null,
      });
    }
    if (schema === 'live_memo_review_v2') {
      scenario.calls.review++;
      return sse(body, {
        protocol: 2,
        memo: { accept: true, reason: 'Supported.' },
        contribution: { accept: false, reason: 'Not requested.' },
        status: { accept: false, reason: 'Not requested.' },
      });
    }
    assert.ok(['extract', 'compose', 'review'].includes(stage), 'Unexpected MoM schema ' + schema);
    scenario.calls['mom_' + stage]++;
    if (stage === 'compose' && scenario.failFirstCompose && scenario.calls.mom_compose === 1)
      return new Response(JSON.stringify({ error: { message: 'Synthetic503' } }), {
        status: 503,
        headers: { 'Retry-After': '1', 'Content-Type': 'application/json' },
      });
    if (stage === 'compose' && scenario.holdCompose) {
      scenario.composeHeld = true;
      await new Promise((r) => (releaseCompose = r));
      scenario.composeHeld = false;
    }
    if (stage === 'compose' && input.repairFeedback) {
      scenario.repairFeedback = input.repairFeedback;
      if (scenario.holdRepairCompose) {
        scenario.repairHeld = true;
        await new Promise((r) => (releaseRepair = r));
        scenario.repairHeld = false;
      }
    }
    if (stage === 'review')
      return sse(body, {
        protocol: 1,
        accept: !(scenario.rejectFirstReview && scenario.calls.mom_review === 1),
        reason:
          scenario.rejectFirstReview && scenario.calls.mom_review === 1
            ? rejectionReason
            : 'Synthetic fixture checks exact source quotes and explicit agreements.',
      });
    const transcript =
      input.transcript ?? input.chronologicalLedgers?.flatMap((x) => x.facts) ?? [];
    const segment = transcript[0];
    assert.ok(segment, 'MoM request must include full synthetic transcript');
    const source = segment.id ?? segment.sources?.[0] ?? 0;
    const facts = [
      {
        kind: 'decision',
        text: 'The team agreed to launch on 23 November.',
        sources: [source],
        quotes: [{ source, text: 'the team agreed to launch on 23 November.' }],
      },
      {
        kind: 'action',
        text:
          stage === 'compose' && scenario.rejectFirstReview && !input.repairFeedback
            ? 'Rani will confirm support capacity by 19 November.'
            : 'Rani will confirm support capacity by 18 November.',
        sources: [source],
        quotes: [{ source, text: 'Rani will confirm support capacity by 18 November.' }],
      },
    ];
    return sse(
      body,
      stage === 'extract'
        ? { language: 'en', facts }
        : { protocol: 1, language: 'en', bullets: facts, emptyReason: null },
    );
  },
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + relay.address().port;
async function command(type, payload = {}) {
  const reply = await page.evaluate(
    (message) => chrome.runtime.sendMessage({ target: 'worker', ...message }),
    { type, ...payload },
  );
  assert.equal(reply?.ok, true, type + ': ' + reply?.error);
  return reply.value;
}
async function sample(label) {
  const [replay, end, transcript] = await Promise.all([
    command('REPLAY_STATUS'),
    command('END_STATUS'),
    command('TRANSCRIPT_STATUS'),
  ]);
  const state = { at: Date.now(), label, replay, end, transcript };
  if (label) states.push(state);
  return state;
}
async function until(predicate, label, timeout = 45000) {
  let state;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    state = await sample();
    if (await predicate(state)) return state;
    if (state.replay.phase === 'error')
      throw Error(label + ': ' + (state.replay.error ?? state.replay.run?.error));
    await sleep(100);
  }
  throw Error('Timeout ' + label + ' latest=' + JSON.stringify(state));
}
async function capture(name) {
  await page.screenshot({
    path: path.join(artifact, name),
    fullPage: true,
    animations: 'disabled',
  });
  captures.push(name);
}
async function open() {
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('chrome-extension://' + extensionId + '/replay.html');
  await instrument();
}
async function instrument() {
  await page.evaluate(() => {
    window.__endTestCalls = [];
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const message = args.find((value) => value && typeof value === 'object' && value.type);
      const tracked = ['END_MEETING', 'REPLAY_START'].includes(message?.type)
        ? { message, at: Date.now() }
        : null;
      if (tracked) window.__endTestCalls.push(tracked);
      const reply = originalSend(...args);
      if (tracked && reply?.then)
        reply.then(
          (value) => {
            tracked.reply = value;
          },
          (error) => {
            tracked.error = String(error);
          },
        );
      return reply;
    };
  });
}
async function begin(name, audio, options = {}) {
  scenario = {
    name,
    calls: { asr: 0, proposal: 0, review: 0, mom_extract: 0, mom_compose: 0, mom_review: 0 },
    ...options,
  };
  await page.waitForFunction(() => !document.querySelector('#audio-file').disabled);
  await page
    .locator('#audio-file')
    .setInputFiles({ name: name + '.wav', mimeType: 'audio/wav', buffer: audio });
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('#source-select option')].some((x) =>
        x.textContent.includes(name),
      ),
    name,
  );
  await page.locator('#start-replay').click();
  if (options.probeStartup) {
    const startup = await sample('startup-read-polls');
    check(
      'Read-only status polls join offscreen startup without an unavailable error',
      !!startup.transcript && !!startup.replay,
    );
  }
  // Start resolves asynchronously. Wait for the real lab's acknowledgement before
  // diagnostic polling; the newly created offscreen may still be loading otherwise.
  await page.waitForFunction(
    () =>
      (document.querySelector('#run-status')?.textContent === 'Playing at 1×' &&
        !document.querySelector('#stop-replay').disabled) ||
      (!document.querySelector('#error').hidden && !!document.querySelector('#error').textContent),
    {},
    { timeout: 45000 },
  );
  const startProbe = await page.evaluate(() => ({
    status: document.querySelector('#run-status')?.textContent,
    error: document.querySelector('#error')?.textContent,
    calls: window.__endTestCalls,
  }));
  if (startProbe.status !== 'Playing at 1×') {
    await writeFile(
      path.join(artifact, 'start-probe.json'),
      JSON.stringify(startProbe, null, 2) + '\n',
    );
    throw Error('Lab did not start: ' + JSON.stringify(startProbe));
  }
  return until((s) => s.replay.phase === 'playing', name + ' playing');
}
async function files(job) {
  return page.evaluate(
    async ({ folder, audio }) => {
      const root = await navigator.storage.getDirectory(),
        dir = await root.getDirectoryHandle(folder);
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      const read = async (name) => await (await dir.getFileHandle(name)).getFile();
      const a = await read(audio),
        mom = await (await read('mom.txt')).text(),
        transcript = await (await read('transcript.txt')).text();
      const buffer = await a.arrayBuffer(),
        audioContext = new AudioContext();
      let duration;
      try {
        duration = (await audioContext.decodeAudioData(buffer.slice(0))).duration;
      } finally {
        await audioContext.close();
      }
      return {
        names: names.sort(),
        audio: {
          bytes: a.size,
          type: a.type,
          signature: [...new Uint8Array(buffer.slice(0, 4))],
          duration,
        },
        mom,
        transcript,
      };
    },
    { folder: job.folderName, audio: job.audioFilename },
  );
}
async function savedFileNames(job) {
  return page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(folder);
    const names = [];
    for await (const name of directory.keys()) names.push(name);
    return names.sort();
  }, job.folderName);
}
async function replayEvents(runId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('memo-replay-lab', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('events').objectStore('events').index('run').getAll(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, runId);
}
let extensionId, failure, buildInfo, sourceBefore, sourceAfterBuild, sourceAfter;
try {
  sourceBefore = await sourceFingerprint();
  await writeFile(
    path.join(artifact, 'source-before.json'),
    JSON.stringify(sourceBefore, null, 2) + '\n',
  );
  const result = await execute(process.execPath, ['scripts/build.mjs'], {
    env: {
      ...process.env,
      LISTEN_REPLAY_LAB: '1',
      LISTEN_BUILD_DIR: buildDir,
      LISTEN_RELAY_ORIGIN: origin,
      LISTEN_RELAY_TOKEN: 'synthetic-end-relay-token',
    },
    maxBuffer: 1024 * 1024,
  });
  await writeFile(path.join(artifact, 'build.log'), result.stdout + result.stderr);
  buildInfo = JSON.parse(await readFile(path.join(buildDir, 'build-info.json'), 'utf8'));
  sourceAfterBuild = await sourceFingerprint();
  check(
    'The isolated build uses an unchanged source snapshot',
    sourceBefore.sha256 === sourceAfterBuild.sha256,
  );
  const clip = await readFile(
    'training:meeting/verified-excerpts-v1-76136748b154/clips/0792-combined.wav',
  );
  assert.equal(clip.toString('ascii', 36, 40), 'data');
  const audio = Buffer.concat([clip, Buffer.alloc(clip.readUInt32LE(28) * 7)]);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.writeUInt32LE(audio.length - 44, 40);
  const sourceDuration = (audio.length - 44) / clip.readUInt32LE(28);
  profile = await mkdtemp(path.join(artifact, 'profile-'));
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push('Blocked external origin ' + new URL(route.request().url()).origin);
    return route.abort();
  });
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      if (window.__cancelTestPicker)
        throw new DOMException('Synthetic picker cancel', 'AbortError');
      return navigator.storage.getDirectory();
    };
  });
  const root = await context.browser().newBrowserCDPSession();
  ({ id: extensionId } = await root.send('Extensions.loadUnpacked', { path: buildDir }));
  await open();
  await page.evaluate(async () =>
    chrome.storage.local.set({
      microphoneReady: false,
      transcriptionEnabled: true,
      listenAgentDiagnosticsEnabled: true,
      assistantSettings: {
        enabled: true,
        provider: 'deepinfra',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        goal: 'Synthetic offline end-meeting test.',
        benchmarkPassed: false,
      },
    }),
  );
  await page.reload();
  await instrument();
  if (process.env.LISTEN_END_FOCUS_ONLY !== '1') {
    await page.locator('#choose-output-folder').click();
    const started = await begin('eof-final-asr-and-background-export', audio, {
      holdAsr: true,
      holdCompose: true,
      probeStartup: true,
    });
    const sessionId = started.replay.run.sessionId;
    const waiting = await until(
      (s) => s.end?.sessionId === sessionId && s.end.phase === 'waiting_transcript',
      'EOF waits for final ASR',
    );
    states.push({ ...waiting, label: 'eof-awaiting-final-asr' });
    check('EOF starts one session-bound post-meeting job', waiting.end.reason === 'eof');
    check(
      'MoM waits for final ASR rather than using incomplete live text',
      scenario.calls.mom_compose === 0 && scenario.calls.asr > 0,
    );
    check('Folder chosen before replay survives until EOF', waiting.end.destination === 'selected');
    releaseAsr();
    scenario.holdAsr = false;
    const composing = await until(
      (s) => s.end?.phase === 'generating' && scenario.composeHeld,
      'MoM compose held',
    );
    check(
      'MoM receives every accepted final transcript segment',
      requests.filter((r) => r.schema === 'meeting_minutes_compose_v1').at(-1).input.transcript
        .length === composing.transcript.segments.length,
    );
    await until(
      (s) => s.end.files.audio.phase === 'saved' && s.end.files.transcript.phase === 'saved',
      'audio and transcript save before MoM',
    );
    check('Audio and transcript save independently while MoM processes', true);
    await capture('eof-mom-processing.png');
    await page.close();
    releaseCompose();
    scenario.holdCompose = false;
    await open();
    const completed = await until(
      (s) =>
        s.end?.sessionId === sessionId &&
        s.end.phase === 'ready' &&
        Object.values(s.end.files).every((f) => f.phase === 'saved'),
      'background MoM and export finish',
    );
    states.push({ ...completed, label: 'eof-completed-after-page-close' });
    check(
      'Closing and reopening the UI preserves MoM and all three writes',
      completed.end.minutes.bullets.length === 2,
    );
    const full = await files(completed.end);
    await writeFile(path.join(artifact, 'eof-files.json'), JSON.stringify(full, null, 2) + '\n');
    check(
      'EOF bundle contains exactly audio, mom.txt and transcript.txt',
      JSON.stringify(full.names) ===
        JSON.stringify([completed.end.audioFilename, 'mom.txt', 'transcript.txt'].sort()),
    );
    check(
      'Combined output is a real decodable WebM/Opus stream',
      JSON.stringify(full.audio.signature) === JSON.stringify([26, 69, 223, 163]) &&
        full.audio.duration > sourceDuration - 1 &&
        full.audio.duration < sourceDuration + 1,
      full.audio,
    );
    check(
      'MoM export contains only bullet text and matches sidebar result',
      full.mom ===
        '- The team agreed to launch on 23 November.\n- Rani will confirm support capacity by 18 November.\n',
    );
    check(
      'Transcript export retains final speech and passage timestamps',
      full.transcript.includes(fixture) && /^\[00:00:/.test(full.transcript),
    );
    const frame = page.frameLocator('#memo-frame');
    await frame.getByRole('heading', { name: 'Meeting notes', exact: true }).waitFor();
    check(
      'Actual sidebar renders the final bullet list',
      (await frame.locator('.end-bullets > li').count()) === 2,
    );
    await capture('eof-meeting-notes-ready.png');
    await page.setViewportSize({ width: 600, height: 1000 });
    const zoom = await page.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      await chrome.tabs.setZoom(tab.id, 2);
      return chrome.tabs.getZoom(tab.id);
    });
    await page.locator('#memo-frame').scrollIntoViewIfNeeded();
    const zoomGeometry = await frame.locator('#end-meeting-panel').evaluate((panel) => ({
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      panelWidth: panel.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      bullets: [...panel.querySelectorAll('.end-bullets p')].map((p) => ({
        text: p.textContent,
        font: parseFloat(getComputedStyle(p).fontSize),
        width: p.getBoundingClientRect().width,
      })),
    }));
    check('Actual Chrome tab zoom is 200%', zoom === 2);
    check(
      'Meeting notes iframe fits at native 200% without horizontal clipping',
      zoomGeometry.pageWidth <= zoomGeometry.viewport + 1 &&
        zoomGeometry.panelScrollWidth <= zoomGeometry.panelWidth + 1 &&
        zoomGeometry.bullets.length === 2 &&
        zoomGeometry.bullets.every((b) => b.font >= 11),
      zoomGeometry,
    );
    await writeFile(
      path.join(artifact, 'native-zoom-200.json'),
      JSON.stringify({ zoom, geometry: zoomGeometry }, null, 2) + '\n',
    );
    const zoomSession = await context.newCDPSession(page);
    const zoomShot = await zoomSession.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    });
    await writeFile(
      path.join(artifact, 'meeting-notes-native-200.png'),
      Buffer.from(zoomShot.data, 'base64'),
    );
    await zoomSession.detach();
    captures.push('meeting-notes-native-200.png');
    await page.evaluate(async () => chrome.tabs.setZoom((await chrome.tabs.getCurrent()).id, 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => (window.__cancelTestPicker = true));
    const manual = await begin('manual-stop-cancel-retry-and-quality-repair', audio, {
      failFirstCompose: true,
      rejectFirstReview: true,
      holdRepairCompose: true,
    });
    await until((s) => s.replay.sourceMs >= 4000, 'played prefix reaches four seconds');
    await page.locator('#stop-replay').click();
    await sleep(700);
    const stopProbe = {
      ...(await sample('manual-stop-click-immediate')),
      ui: await page.evaluate(() => ({
        calls: window.__endTestCalls,
        error: document.querySelector('#error')?.textContent,
        runStatus: document.querySelector('#run-status')?.textContent,
        stopDisabled: document.querySelector('#stop-replay')?.disabled,
      })),
    };
    await writeFile(
      path.join(artifact, 'manual-stop-probe.json'),
      JSON.stringify(stopProbe, null, 2) + '\n',
    );
    await capture('manual-stop-click-immediate.png');
    check(
      'Stop button dispatches END_MEETING immediately',
      stopProbe.ui.calls.some((call) => call.message.type === 'END_MEETING'),
      stopProbe.ui,
    );
    const manualId = manual.replay.run.sessionId;
    const stopped = await until(
      (s) => s.end?.sessionId === manualId && s.end.reason === 'manual',
      'manual Stop creates end job',
    );
    check(
      'Cancel destination selection still stops actual playback',
      !['playing', 'draining'].includes(stopped.replay.phase),
    );
    check(
      'Cancel destination selection retains unsaved recording',
      stopped.end.destination === 'missing' && stopped.end.files.audio.phase === 'pending',
    );
    await command('END_MEETING', { sessionId: manualId });
    const retrying = await until(
      (s) => s.end?.sessionId === manualId && s.end.retryAt > Date.now(),
      'MoM503 schedules bounded retry',
    );
    states.push({ ...retrying, label: 'manual-mom-backoff' });
    check('MoM transport503 is recoverable without dropping audio', retrying.end.audio === 'ready');
    const repairing = await until(
      (s) => s.end?.sessionId === manualId && s.end.checkpoint?.repairing && scenario.repairHeld,
      'review rejection starts bounded feedback repair',
    );
    states.push({ ...repairing, label: 'manual-review-rejected-repair-held' });
    const feedback = scenario.repairFeedback;
    check(
      'Repair receives rejected draft, reviewer feedback and original source evidence',
      feedback?.reviewerReason === rejectionReason &&
        JSON.stringify(feedback.focusIndexes) === JSON.stringify([0, 1]) &&
        feedback.rejectedCandidate.bullets[1].text.includes('19 November') &&
        feedback.rejectedCandidate.bullets[0].text.includes('23 November') &&
        feedback.evidence.some((e) => e.excerpt.includes('by 18 November.')),
      feedback,
    );
    check(
      'Rejected draft remains internal while the correcting checkpoint is persisted',
      !repairing.end.minutes &&
        !repairing.end.checkpoint.draft &&
        repairing.end.checkpoint.lastRejection.reason === rejectionReason &&
        repairing.end.files.mom.phase === 'pending',
    );
    const manualFrame = page.frameLocator('#memo-frame');
    await manualFrame
      .locator('.end-status')
      .filter({ hasText: 'correcting the meeting notes' })
      .waitFor();
    check(
      'Sidebar shows correcting status without exposing rejected MoM bullets',
      (await manualFrame.locator('.end-bullets > li').count()) === 0,
    );
    check(
      'Canceling the initial folder choice retains the recording throughout quality repair',
      repairing.end.destination === 'missing' && repairing.end.audio === 'ready',
    );
    await manualFrame.locator('body').evaluate(() => (window.__cancelTestPicker = false));
    await manualFrame.getByRole('button', { name: 'Choose folder', exact: true }).click();
    const repairFiles = await until(
      (s) =>
        s.end?.sessionId === manualId &&
        s.end.files.audio.phase === 'saved' &&
        s.end.files.transcript.phase === 'saved',
      'audio and transcript export while quality repair waits',
    );
    const preRepairFiles = await savedFileNames(repairFiles.end);
    check(
      'Rejected MoM is never exported while audio and transcript are saved',
      JSON.stringify(preRepairFiles) ===
        JSON.stringify([repairFiles.end.audioFilename, 'transcript.txt'].sort()) &&
        repairFiles.end.files.mom.phase === 'pending',
      preRepairFiles,
    );
    await capture('manual-mom-correcting-no-rejected-output.png');
    releaseRepair();
    scenario.holdRepairCompose = false;
    const ready = await until(
      (s) => s.end?.sessionId === manualId && s.end.phase === 'ready',
      'repaired MoM is reviewed and accepted',
    );
    check(
      'Repeated Stop permits only the transport retry and one quality revision',
      scenario.calls.mom_compose === 3 && scenario.calls.mom_review === 2,
      scenario.calls,
    );
    const manualReviews = requests.filter(
      (r) => r.scenario === scenario.name && r.schema === 'meeting_minutes_review_v1',
    );
    check(
      'The complete corrected draft is checked again before publication',
      manualReviews.length === 2 &&
        manualReviews[0].input.candidateInventory[1].text.includes('19 November') &&
        manualReviews[1].input.candidateInventory[1].text.includes('18 November') &&
        manualReviews[1].input.candidateInventory.length === 2 &&
        ready.end.minutes.bullets.length === 2 &&
        !ready.end.checkpoint.repairing,
    );
    const saved = await until(
      (s) =>
        s.end?.sessionId === manualId &&
        Object.values(s.end.files).every((f) => f.phase === 'saved'),
      'save previously cancelled results',
    );
    const prefix = await files(saved.end);
    await writeFile(
      path.join(artifact, 'manual-files.json'),
      JSON.stringify(prefix, null, 2) + '\n',
    );
    await manualFrame.locator('.end-bullets > li').nth(1).waitFor();
    check(
      'Only accepted corrected MoM reaches the sidebar and mom.txt',
      prefix.mom ===
        '- The team agreed to launch on 23 November.\n- Rani will confirm support capacity by 18 November.\n' &&
        (await manualFrame.locator('.end-bullets').innerText()).includes('18 November') &&
        !(await manualFrame.locator('.end-bullets').innerText()).includes('19 November'),
    );
    const events = await replayEvents(manual.replay.run.id);
    await writeFile(
      path.join(artifact, 'manual-quality-repair-events.json'),
      JSON.stringify(events, null, 2) + '\n',
    );
    check(
      'Replay timeline persists rejection, repair and final acceptance events',
      events.some((e) => e.kind === 'end.mom-review-rejected') &&
        events.some((e) => e.kind === 'end.mom-repair-started') &&
        events.some((e) => e.kind === 'end.mom-verdict' && e.data.revision === 1 && e.data.accept),
    );
    check(
      'Manual Stop exports only the played prefix',
      prefix.audio.duration > 2 && prefix.audio.duration < sourceDuration - 3,
      prefix.audio,
    );
    check(
      'Manual Stop transcript timestamps remain within the played audio',
      saved.end.transcript.segments.every(
        (segment) => segment.endMs <= prefix.audio.duration * 1000 + 1000,
      ),
    );
    check(
      'Each replay receives its own output folder',
      saved.end.folderName !== completed.end.folderName,
    );
    await capture('manual-stop-meeting-notes-ready.png');
    const replay = await command('REPLAY_STATUS');
    check(
      'Replay final result includes the post-meeting result',
      replay.run?.endMeeting?.sessionId === manualId,
    );
  }
  const silent = await begin('sidebar-stop-focus-on-silent-prefix', audio, { probeStartup: true });
  const silentFrame = page.frameLocator('#memo-frame');
  await silentFrame.locator('body').evaluate(() => {
    window.__cancelTestPicker = true;
  });
  await silentFrame.locator('#stop').click();
  const silentEnd = await until(
    (s) => s.end?.sessionId === silent.replay.run.sessionId && s.end.phase === 'empty',
    'sidebar silent Stop finishes',
  );
  const focusAfterStop = await silentFrame.locator('body').evaluate(() => ({
    tag: document.activeElement?.tagName,
    id: document.activeElement?.id,
    text: document.activeElement?.textContent?.trim().slice(0, 120),
    visible: !!document.activeElement?.getClientRects().length,
  }));
  await page.keyboard.press('Tab');
  const firstTab = await silentFrame.locator('body').evaluate(() => ({
    tag: document.activeElement?.tagName,
    id: document.activeElement?.id,
    text: document.activeElement?.textContent?.trim().slice(0, 120),
    visible: !!document.activeElement?.getClientRects().length,
    inResults: !!document.activeElement?.closest('#end-meeting-panel'),
  }));
  await writeFile(
    path.join(artifact, 'sidebar-stop-focus.json'),
    JSON.stringify({ focusAfterStop, firstTab, sessionId: silentEnd.end.sessionId }, null, 2) +
      '\n',
  );
  check(
    'Sidebar Stop closes live capture even when its picker is canceled',
    silentEnd.end.reason === 'manual' && silentEnd.end.destination === 'missing',
  );
  check(
    'Sidebar Stop restores focus to the visible meeting-notes heading',
    focusAfterStop.tag === 'H2' && focusAfterStop.visible,
    { focusAfterStop, firstTab },
  );
  check(
    'Silent stopped prefix makes no unnecessary MoM provider request',
    scenario.calls.mom_compose === 0 && scenario.calls.mom_review === 0,
  );
  check(
    'Keyboard reaches meeting results after sidebar Stop',
    firstTab.visible && firstTab.inResults,
    { focusAfterStop, firstTab },
  );
  await capture('sidebar-stop-empty-result.png');
  for (const [file, before] of preserved) {
    const after = await readFile(file);
    check('Preserved main/ledger bytes: ' + file, sha(before) === sha(after));
  }
  check('No browser or blocked external-network errors', errors.length === 0, errors);
  sourceAfter = await sourceFingerprint();
  await writeFile(
    path.join(artifact, 'source-after.json'),
    JSON.stringify(sourceAfter, null, 2) + '\n',
  );
  check(
    'Source files remain frozen through the complete browser run',
    sourceBefore.sha256 === sourceAfter.sha256,
  );
} catch (e) {
  failure = e.stack;
  if (page && !page.isClosed()) {
    await page
      .screenshot({
        path: path.join(artifact, 'failure-state.png'),
        fullPage: true,
        animations: 'disabled',
      })
      .catch(() => {});
    const ui = await page
      .evaluate(() => ({ text: document.body.innerText, calls: window.__endTestCalls }))
      .catch(() => null);
    await writeFile(path.join(artifact, 'failure-ui.json'), JSON.stringify(ui, null, 2) + '\n');
  }
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  releaseAsr?.();
  releaseCompose?.();
  releaseRepair?.();
  await writeFile(
    path.join(artifact, 'result.json'),
    JSON.stringify(
      {
        passed: !failure,
        checks,
        errors,
        requests,
        states,
        captures,
        buildInfo,
        sourceFingerprint: sourceBefore?.sha256,
        sourceAfterBuildFingerprint: sourceAfterBuild?.sha256,
        sourceAfterFingerprint: sourceAfter?.sha256,
        failure: failure ?? null,
        paidProviderRequests: 0,
        destinationEvidence:
          process.env.LISTEN_END_FOCUS_ONLY === '1'
            ? 'Picker cancellation is substituted; this focused run does not select or write a directory.'
            : 'Real OPFS FileSystemDirectoryHandle persisted through extension IndexedDB; native OS folder selection is a separate manual check.',
        nativePickerMocked: true,
      },
      null,
      2,
    ) + '\n',
  );
  await context?.close().catch(() => {});
  await new Promise((r) => relay.close(r));
  if (profile) await rm(profile, { recursive: true, force: true });
}
