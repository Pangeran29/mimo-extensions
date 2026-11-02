// Offline failure-injection evidence through actual research Chrome, audio/VAD,
// ASR transport, v2 controller, relay transport, persistence, and the real UI.
// providerFetch is synthetic and NEVER delegates to fetch or any paid provider.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const artifact = path.resolve(
  process.env.LISTEN_STABILITY_ARTIFACT_DIR || 'artifacts/mimo-stability-2026-11-01/integration',
);
const buildDir = path.join(artifact, 'synthetic-build');
await mkdir(artifact, { recursive: true });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const unchangedPaths = ['dist/build-info.json', 'artifacts/live-memo-v1/provider-budget.json'];
const original = new Map(
  await Promise.all(unchangedPaths.map(async (file) => [file, await readFile(file)])),
);
const fixtureText =
  'Synthetic offline stability fixture: launching on 23 November is a proposal, and support capacity remains open.';
const memoText =
  'Synthetic offline recovery: a launch on 23 November is proposed; support capacity remains open.';
const contributionText =
  'Synthetic offline suggestion: ask who will confirm support capacity before agreeing to the proposed launch date.';
const checks = [];
const errors = [];
const requests = [];
const checkpoints = [];
const results = [];
let scenario;
let context;
let page;
let profile;
let failure;
let releaseHeldReview;
const check = (name, condition, detail) => {
  assert.ok(condition, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  checks.push(name);
  console.log('PASS: ' + name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function response(body, value) {
  const chunk = {
    id: 'synthetic-offline-stability',
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
const relay = createRelay({
  apiKey: 'synthetic-offline-provider-secret',
  relayToken: 'synthetic-offline-stability-token',
  providerFetch: async (url, options) => {
    assert.ok(scenario, 'Unexpected provider request outside an active synthetic scenario');
    // No network function is called here. Even the apparent upstream URL ends here.
    if (String(url).includes('/v1/inference/')) {
      scenario.calls.asr++;
      requests.push({
        scenario: scenario.name,
        stage: 'asr',
        at: Date.now(),
        ordinal: scenario.calls.asr,
      });
      return new Response(
        JSON.stringify({
          text: scenario.calls.asr === 1 ? fixtureText : '',
          language: 'en',
          inference_status: { status: 'succeeded' },
        }),
      );
    }
    const body = JSON.parse(options.body);
    const schema = body.response_format?.json_schema?.name;
    assert.ok(
      ['live_memo_proposal_v2', 'live_memo_review_v2'].includes(schema),
      `Unexpected synthetic request schema: ${schema}`,
    );
    const reviewing = schema === 'live_memo_review_v2';
    const stage = reviewing ? 'review' : 'proposal';
    scenario.calls[stage]++;
    const input = JSON.parse(body.messages.find((message) => message.role === 'user').content);
    const source = (input.newTranscript?.[0] ?? input.recentTranscript?.[0] ?? input.evidence?.[0])
      ?.id;
    assert.ok(Number.isInteger(source), 'Synthetic v2 request is missing actual ASR evidence');
    const request = {
      scenario: scenario.name,
      stage,
      ordinal: scenario.calls[stage],
      at: Date.now(),
      schema,
      input,
    };
    requests.push(request);
    if (
      reviewing &&
      (scenario.name === 'persistent-failure-and-stop' || scenario.calls.review === 1)
    ) {
      request.responseStatus = 503;
      const retryAfter =
        scenario.name === 'persistent-failure-and-stop' && scenario.calls.review === 3 ? '6' : '1';
      request.retryAfter = retryAfter;
      return new Response(
        JSON.stringify({ error: { message: 'Synthetic offline REVIEW 503 fixture' } }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter },
        },
      );
    }
    if (reviewing) {
      scenario.held = true;
      await new Promise((resolve) => {
        releaseHeldReview = resolve;
      });
      scenario.held = false;
      request.responseStatus = 200;
      return response(body, {
        protocol: 2,
        memo: { accept: true, reason: 'Synthetic supported memo accepted.' },
        contribution: { accept: true, reason: 'Synthetic explicit suggestion accepted.' },
        status: { accept: false, reason: 'No status update requested.' },
      });
    }
    request.responseStatus = 200;
    return response(body, {
      protocol: 2,
      topic: { key: 'offline-stability', label: 'Offline stability proposal', sources: [source] },
      topicChanged: false,
      updates: [
        {
          key: 'offline-launch',
          kind: 'proposal',
          text: fixtureText,
          sources: [source],
          topic: 'offline-stability',
          replaces: null,
        },
      ],
      decision: 'candidate',
      reason: 'Synthetic transport regression, not model quality.',
      memoUpdate: { action: 'replace', text: memoText, sources: [source] },
      candidate: {
        kind: 'suggestion',
        title: 'Synthetic next question',
        body: contributionText,
        sources: [source],
        interpretation: false,
        generalKnowledge: false,
        proposal: true,
      },
      statusUpdate: null,
    });
  },
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${relay.address().port}`;

async function command(type, payload = {}) {
  const reply = await page.evaluate(
    (message) => chrome.runtime.sendMessage({ target: 'worker', ...message }),
    { type, ...payload },
  );
  assert.equal(reply?.ok, true, `${type}: ${reply?.error}`);
  return reply.value;
}
async function sample(label) {
  const [replay, assistant, transcript] = await Promise.all([
    command('REPLAY_STATUS'),
    command('ASSISTANT_STATUS'),
    command('TRANSCRIPT_STATUS'),
  ]);
  const value = { at: Date.now(), label, replay, assistant, transcript };
  if (label) checkpoints.push(value);
  return value;
}
async function until(predicate, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let state;
  while (Date.now() < end) {
    state = await sample();
    if (await predicate(state)) return state;
    if (state.replay.phase === 'error')
      throw Error(`${label}: ${state.replay.error || state.replay.run?.error}`);
    await sleep(150);
  }
  throw Error(`Timed out: ${label}; latest=${JSON.stringify(state)}`);
}
async function capture(name) {
  await page.screenshot({
    path: path.join(artifact, name),
    fullPage: true,
    animations: 'disabled',
  });
}
async function exportEvidence(name) {
  const download = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const file = path.join(artifact, `${name}-evidence.json`);
  await (await download).saveAs(file);
  return JSON.parse(await readFile(file, 'utf8'));
}
async function begin(name, audio) {
  scenario = { name, calls: { asr: 0, proposal: 0, review: 0 }, held: false };
  // Backend completion can precede the lab's next status render. Its real import
  // handler ignores changes while that render still marks the prior run busy.
  await page.waitForFunction(() => !document.querySelector('#audio-file').disabled);
  await page
    .locator('#audio-file')
    .setInputFiles({ name: `${name}.wav`, mimeType: 'audio/wav', buffer: audio });
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll('#source-select option')].some((option) =>
        option.textContent.includes(name),
      ),
    name,
  );
  await page.locator('#start-replay').click();
  const playing = await until((state) => state.replay.phase === 'playing', `${name} starts`);
  check(
    `${name}: actual source starts at 1× without microphone or tab capture`,
    playing.replay.run.source.sha256 === digest(audio),
  );
  return playing;
}

try {
  const build = await execute(process.execPath, ['scripts/build.mjs'], {
    env: {
      ...process.env,
      LISTEN_REPLAY_LAB: '1',
      LISTEN_BUILD_DIR: buildDir,
      LISTEN_RELAY_ORIGIN: origin,
      LISTEN_RELAY_TOKEN: 'synthetic-offline-stability-token',
    },
    maxBuffer: 1024 * 1024,
  });
  await writeFile(path.join(artifact, 'synthetic-build.log'), build.stdout + build.stderr);
  const clip = await readFile(
    'training:meeting/verified-excerpts-v1-76136748b154/clips/0792-combined.wav',
  );
  assert.equal(clip.toString('ascii', 36, 40), 'data');
  assert.equal(clip.readUInt32LE(24), 16000);
  const makeAudio = (silenceSeconds) => {
    const audio = Buffer.concat([clip, Buffer.alloc(clip.readUInt32LE(28) * silenceSeconds)]);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.writeUInt32LE(audio.length - 44, 40);
    return audio;
  };
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
  context.on('page', (item) => item.on('pageerror', (error) => errors.push(error.message)));
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push(`Blocked unexpected network origin: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: buildDir });
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/replay.html`);
  await page.evaluate(async () =>
    chrome.storage.local.set({
      microphoneReady: false,
      transcriptionEnabled: true,
      listenAgentDiagnosticsEnabled: true,
      assistantSettings: {
        enabled: true,
        provider: 'deepinfra',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        goal: 'Synthetic offline stability regression.',
        benchmarkPassed: false,
      },
    }),
  );
  await page.reload();
  const frame = page.frameLocator('#memo-frame');

  const recoveryStart = await begin('review-recovery-at-eof', makeAudio(7));
  const backoff = await until(
    (state) => state.assistant.lastFailure?.status === 503 && state.assistant.retryAt > Date.now(),
    'first review fails and queues retry',
  );
  checkpoints.push({ ...backoff, label: 'recovery-backoff' });
  const cursor = backoff.assistant.lastSegmentId;
  const version = backoff.assistant.version;
  const segments = backoff.transcript.segments;
  const committedMemory = backoff.assistant.liveV2.memory;
  check(
    'Recovery: stage one committed its actual transcript cursor and memory before REVIEW failed',
    cursor === Math.max(...segments.map((segment) => segment.id)) && committedMemory.length === 1,
  );
  check(
    'Recovery: first failure is retained as HTTP 503 / count 1',
    backoff.assistant.lastFailure.status === 503 && backoff.assistant.lastFailure.count === 1,
  );
  check(
    'Recovery: pending automatic retry exposes no Try again control',
    await frame.locator('#resume').isHidden(),
  );
  await capture('recovery-backoff.png');
  const inFlight = await until(
    (state) => scenario.held && state.assistant.liveV2.stage === 'review',
    'automatic REVIEW retry starts without new ASR',
  );
  check(
    'Recovery: retry calls only REVIEW while transcript/cursor/version stay fixed',
    scenario.calls.proposal === 1 &&
      scenario.calls.review === 2 &&
      inFlight.assistant.lastSegmentId === cursor &&
      inFlight.assistant.version === version &&
      JSON.stringify(inFlight.transcript.segments) === JSON.stringify(segments),
  );
  check(
    'Recovery: in-flight automatic retry exposes no Try again control',
    await frame.locator('#resume').isHidden(),
  );
  const draining = await until(
    (state) => state.replay.phase === 'draining' && state.transcript.phase === 'complete',
    'natural EOF arrives while REVIEW is held',
  );
  checkpoints.push({ ...draining, label: 'recovery-eof-held' });
  check(
    'Recovery: EOF remains draining and busy while REVIEW is pending',
    scenario.held &&
      draining.replay.assistantBusy &&
      !draining.replay.run.endedAt &&
      !draining.assistant.liveV2.closed &&
      !draining.assistant.liveV2.memo,
  );
  check(
    'Recovery: EOF preserves the transcript during the AI outage',
    !draining.transcript.incomplete &&
      draining.transcript.segments.length === 1 &&
      JSON.stringify(draining.transcript.segments) === JSON.stringify(segments),
  );
  await capture('recovery-eof-held.png');
  releaseHeldReview();
  releaseHeldReview = undefined;
  await frame
    .locator('[data-current-memo="true"]')
    .getByText(memoText, { exact: true })
    .waitFor({ state: 'attached', timeout: 15000 });
  await frame
    .locator('#memo-bubble')
    .getByText(contributionText, { exact: true })
    .waitFor({ state: 'visible', timeout: 15000 });
  const recovered = await until(
    (state) => state.replay.phase === 'complete',
    'accepted REVIEW drains to completion',
  );
  checkpoints.push({ ...recovered, label: 'recovered-complete' });
  check(
    'Recovery: actual UI publishes the accepted understanding and focused contribution',
    recovered.assistant.liveV2.memo.text === memoText &&
      recovered.assistant.liveV2.contributions.length === 1,
  );
  check(
    'Recovery: completion has one PROPOSE and two REVIEWs, with no cursor/version advance on retry',
    scenario.calls.proposal === 1 &&
      scenario.calls.review === 2 &&
      recovered.assistant.lastSegmentId === cursor &&
      recovered.assistant.version === version &&
      JSON.stringify(recovered.assistant.liveV2.memory) === JSON.stringify(committedMemory),
  );
  check(
    'Recovery: successful REVIEW clears the actionable error and retains lastFailure diagnostics',
    !recovered.assistant.analysisError &&
      recovered.assistant.retryAt === undefined &&
      recovered.assistant.lastFailure.status === 503 &&
      recovered.assistant.lastFailure.count === 1,
  );
  await capture('recovery-complete.png');
  const recoveredEvidence = await exportEvidence('recovery');
  check(
    'Recovery: exported actual agent diagnostics retain the failed REVIEW and later accepted response',
    recoveredEvidence.agentReport.events.some(
      (event) =>
        event.kind === 'decision' &&
        event.data.stage === 'review' &&
        event.data.failure?.status === 503,
    ) &&
      recoveredEvidence.agentReport.events.filter((event) => event.kind === 'response').length >= 2,
  );
  results.push({
    name: scenario.name,
    calls: { ...scenario.calls },
    runId: recoveryStart.replay.run.id,
    sessionId: recovered.replay.run.sessionId,
  });

  const persistentStart = await begin('persistent-failure-and-stop', makeAudio(45));
  const paused = await until(
    (state) => state.assistant.phase === 'paused' && state.assistant.lastFailure?.count === 3,
    'three review failures reach bounded pause',
    45000,
  );
  checkpoints.push({ ...paused, label: 'persistent-paused' });
  check(
    'Persistent: three failed REVIEWs pause after exactly one successful PROPOSE',
    scenario.calls.proposal === 1 &&
      scenario.calls.review === 3 &&
      paused.assistant.lastFailure.status === 503 &&
      !paused.assistant.liveV2.memo &&
      paused.assistant.liveV2.contributions.length === 0,
  );
  check(
    'Persistent: pause clears the published automatic retry deadline',
    paused.assistant.retryAt === undefined,
  );
  check(
    'Persistent: audio remains playing and ASR transcript remains usable during bounded AI failure',
    paused.replay.phase === 'playing' &&
      paused.transcript.phase === 'transcribing' &&
      !paused.transcript.incomplete &&
      paused.transcript.segments.length === 1 &&
      paused.transcript.segments[0].text === fixtureText,
  );
  await frame.locator('#resume').waitFor({ state: 'visible' });
  check(
    'Persistent: Try again is available only after the bounded pause',
    !(await frame.locator('#resume').isDisabled()),
  );
  await capture('persistent-paused.png');
  // Observe past the actual provider Retry-After. A stale auto timer cannot be
  // hidden by the subsequent user retry and Stop.
  await sleep(6500);
  const stillPaused = await sample('paused-after-retry-after');
  check(
    'Persistent: pause remains bounded past Retry-After with no fourth REVIEW or duplicate PROPOSE',
    stillPaused.assistant.phase === 'paused' &&
      scenario.calls.proposal === 1 &&
      scenario.calls.review === 3,
  );
  await frame.locator('#resume').click();
  const resumed = await until(
    (state) =>
      state.assistant.phase !== 'paused' &&
      state.assistant.retryAt > Date.now() &&
      !state.assistant.liveV2.stage,
    'real Try again completes and queues the retained REVIEW',
    3000,
  );
  checkpoints.push({ ...resumed, label: 'manual-resume-queued' });
  check(
    'Stop: real Try again queues only the retained REVIEW before its scheduled retry',
    resumed.assistant.phase !== 'paused' &&
      resumed.assistant.retryAt > Date.now() &&
      !resumed.assistant.liveV2.stage &&
      resumed.replay.assistantBusy &&
      scenario.calls.proposal === 1 &&
      scenario.calls.review === 3,
  );
  await frame.locator('#resume').waitFor({ state: 'hidden' });
  check(
    'Stop: queued resumed retry immediately removes Try again',
    await frame.locator('#resume').isHidden(),
  );
  await page.locator('#stop-replay').click();
  const stopped = await until(
    (state) => state.replay.phase === 'complete',
    'Stop settles while retry is queued',
  );
  checkpoints.push({ ...stopped, label: 'stopped-backoff' });
  await sleep(Math.max(0, resumed.assistant.retryAt - Date.now()) + 1200);
  const afterStop = await sample('after-cancelled-retry-deadline');
  check(
    'Stop: backoff cancellation prevents later REVIEW and duplicate PROPOSE',
    scenario.calls.proposal === 1 && scenario.calls.review === 3,
  );
  check(
    'Stop: no stale memo or contribution is published after the cancelled retry deadline',
    afterStop.assistant.liveV2.closed &&
      !afterStop.assistant.liveV2.memo &&
      afterStop.assistant.liveV2.contributions.length === 0 &&
      afterStop.replay.run.stopReason === 'manual',
  );
  check(
    'Stop: transcript finishes and persists despite AI failure and cancellation',
    afterStop.transcript.phase === 'complete' &&
      !afterStop.transcript.incomplete &&
      afterStop.replay.run.finalTranscript.segments[0].text === fixtureText,
  );
  await capture('stopped-backoff.png');
  const persistentEvidence = await exportEvidence('persistent-stop');
  check(
    'Persistent: exported diagnostic failure sequence is exactly 1, 2, 3',
    JSON.stringify(
      persistentEvidence.agentReport.events
        .filter(
          (event) =>
            event.kind === 'decision' && event.data.stage === 'review' && event.data.failure,
        )
        .map((event) => event.data.failure.count),
    ) === '[1,2,3]',
  );
  results.push({
    name: scenario.name,
    calls: { ...scenario.calls },
    runId: persistentStart.replay.run.id,
    sessionId: afterStop.replay.run.sessionId,
  });
  check(
    'Chrome reports no JavaScript errors or unexpected external network requests',
    errors.length === 0,
    errors,
  );
  for (const [file, bytes] of original)
    check(`Untouched baseline: ${file}`, Buffer.compare(bytes, await readFile(file)) === 0);
} catch (error) {
  failure = error.stack || String(error);
  if (page) {
    await capture('failure.png').catch(() => {});
    const state = await sample('failure').catch(() => null);
    await writeFile(path.join(artifact, 'failure-state.json'), JSON.stringify(state, null, 2));
    await writeFile(
      path.join(artifact, 'failure-ui.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => 'UI unavailable'),
    );
  }
} finally {
  releaseHeldReview?.();
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => relay.close(resolve));
  const preserved = {};
  for (const [file, bytes] of original)
    preserved[file] = Buffer.compare(bytes, await readFile(file)) === 0;
  const report = {
    passed: !failure,
    scope:
      'Actual disposable unpacked research Chrome with real file playback/VAD/offscreen/controller/relay/UI; fixed synthetic ASR and LLM responses only.',
    limitations: [
      'No live model quality or live provider latency evaluation.',
      'Replay bypasses physical microphone and tab-capture acquisition.',
      'The silence fixture proves transcript preservation/finalization and ongoing playback during AI failure; it does not prove recognition of additional speech during that failure.',
      'Production request deadlines are unchanged; the accepted review is released at natural EOF before its 15-second deadline.',
    ],
    paidProviderRequests: 0,
    checks,
    errors,
    scenarios: results,
    currentCalls: scenario?.calls,
    preserved,
    ...(failure ? { failure } : {}),
  };
  await writeFile(path.join(artifact, 'provider-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(artifact, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2));
  await writeFile(
    path.join(artifact, 'stability-chrome-regression.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, checks: checks.length }, null, 2));
}
if (failure) process.exitCode = 1;
