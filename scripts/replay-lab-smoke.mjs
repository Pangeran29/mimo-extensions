// Actual unpacked research extension, real file playback/VAD, fixed local ASR/LLM fixtures.
// No call can leave the synthetic relay. This is transport/UI evidence, not AI-quality evidence.
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
  process.env.LISTEN_REPLAY_ARTIFACT_DIR || 'artifacts/replay-lab-2026-10-31',
);
const screenshots = path.resolve('.impeccable/review/replay-lab');
const buildDir = path.join(artifact, 'synthetic-build');
await mkdir(artifact, { recursive: true });
await mkdir(screenshots, { recursive: true });
const ledgerPath = 'artifacts/live-memo-v1/provider-budget.json';
const ledgerBefore = await readFile(ledgerPath);
const mainBefore = await readFile('dist/build-info.json');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fixtureText =
  'Synthetic test fixture: launching on 23 November is a proposal, and support capacity remains open.';
const memoText =
  'Synthetic fixture: a launch on 23 November is proposed; support capacity remains an open question.';
const contributionText =
  'Synthetic test suggestion: before agreeing to the proposed launch date, ask who will confirm support capacity and when that confirmation is needed. This is a suggested next question, not a decision made by the participants.';
const calls = { asr: 0, proposal: 0, review: 0 };
const requests = [];
const relay = createRelay({
  apiKey: 'synthetic-provider-secret',
  relayToken: 'synthetic-replay-token',
  providerFetch: async (url, options) => {
    // Intentionally never delegates to fetch. All upstream requests end in fixtures here.
    if (String(url).includes('/v1/inference/')) {
      calls.asr++;
      return new Response(
        JSON.stringify({
          text: fixtureText,
          language: 'en',
          inference_status: { status: 'succeeded' },
        }),
      );
    }
    const body = JSON.parse(options.body);
    const review = body.response_format?.json_schema?.name === 'live_memo_review_v2';
    const input = JSON.parse(body.messages.find((message) => message.role === 'user').content);
    const source =
      (input.newTranscript?.[0] ?? input.recentTranscript?.[0] ?? input.evidence?.[0])?.id ?? 0;
    const value = review
      ? {
          protocol: 2,
          memo: { accept: true, reason: 'Synthetic fixture accepts the supported proposal.' },
          contribution: {
            accept: true,
            reason: 'Synthetic fixture accepts an explicit suggestion.',
          },
          status: { accept: false, reason: 'Not requested.' },
        }
      : {
          protocol: 2,
          topic: { key: 'synthetic-launch', label: 'Synthetic launch proposal', sources: [source] },
          topicChanged: false,
          updates: [],
          decision: input.activeContribution ? 'silent' : 'candidate',
          reason: 'Synthetic transport/UI fixture; this does not assess model quality.',
          memoUpdate: input.memo
            ? { action: 'keep', text: null, sources: [] }
            : { action: 'replace', text: memoText, sources: [source] },
          candidate: input.activeContribution
            ? null
            : {
                kind: 'suggestion',
                title: 'Synthetic next question',
                body: contributionText,
                sources: [source],
                interpretation: false,
                generalKnowledge: false,
                proposal: true,
              },
          statusUpdate: null,
        };
    calls[review ? 'review' : 'proposal']++;
    requests.push({
      stage: review ? 'review' : 'proposal',
      schema: body.response_format?.json_schema?.name,
      input,
    });
    const chunk = {
      id: 'synthetic-replay',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${relay.address().port}`;
let context;
let profile;
const browserErrors = [];
const checks = [];
const contrast = [];
const reviewerFixProofs = [];
const screenshotsSaved = [];
let failure;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS: ' + name);
};
async function capture(page, name) {
  if (process.env.LISTEN_REPLAY_SKIP_CAPTURES === '1') return;
  const only = process.env.LISTEN_REPLAY_CAPTURE_ONLY?.split(',').filter(Boolean);
  if (only?.length && !only.includes(name)) return;
  if (
    process.env.LISTEN_REPLAY_TARGETED_CAPTURES_ONLY === '1' &&
    !['stopping-recovery.png', 'source-error.png'].includes(name)
  )
    return;
  if (name === 'native-zoom-200.png') {
    // Full-page clips use CSS pixels and crop a tab with native Chrome zoom.
    const session = await context.newCDPSession(page);
    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(path.join(screenshots, name), Buffer.from(shot.data, 'base64'));
    await session.detach();
  } else {
    await page.screenshot({
      path: path.join(screenshots, name),
      fullPage: true,
      animations: 'disabled',
    });
  }
  screenshotsSaved.push(path.join(screenshots, name));
}
async function inspectContrast(page, theme) {
  const values = await page.evaluate(() => {
    const rgba = (value) => value.match(/[\d.]+/g).map(Number);
    const luminance = (values) => {
      const [r, g, b] = values
        .slice(0, 3)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    return [...document.querySelectorAll('p,small,label,a,button,select,h1,h2,time,span,summary')]
      .filter((node) => node.getClientRects().length && node.textContent.trim() && !node.disabled)
      .map((node) => {
        const style = getComputedStyle(node);
        let ancestor = node,
          background;
        while (ancestor) {
          const color = rgba(getComputedStyle(ancestor).backgroundColor);
          if (color.length === 3 || color[3] === 1) {
            background = color;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        if (!background || Number(style.opacity) < 1) return null;
        const foreground = rgba(style.color);
        const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        const ratio = (levels[0] + 0.05) / (levels[1] + 0.05);
        const font = parseFloat(style.fontSize);
        const threshold =
          font >= 24 || (font >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
        return {
          text: node.textContent.trim().slice(0, 100),
          ratio,
          threshold,
          color: style.color,
          background: background.slice(0, 3),
          selector: node.id || node.className || node.tagName,
        };
      })
      .filter(Boolean);
  });
  contrast.push({ theme, values });
  check(`${theme} contrast probe measured visible text`, values.length > 10);
  const failures = values.filter((value) => value.ratio < value.threshold);
  check(
    `${theme} visible text meets computed WCAG contrast thresholds: ${JSON.stringify(failures)}`,
    failures.length === 0,
  );
}

try {
  const result = await execute(process.execPath, ['scripts/build.mjs'], {
    env: {
      ...process.env,
      LISTEN_REPLAY_LAB: '1',
      LISTEN_BUILD_DIR: buildDir,
      LISTEN_RELAY_ORIGIN: origin,
      LISTEN_RELAY_TOKEN: 'synthetic-replay-token',
    },
    maxBuffer: 1024 * 1024,
  });
  await writeFile(path.join(artifact, 'synthetic-build.log'), result.stdout + result.stderr);
  // Reuse a reviewed existing voice excerpt. Fixed transcript/LLM answers below are synthetic.
  const clip = await readFile(
    'training:meeting/verified-excerpts-v1-76136748b154/clips/0792-combined.wav',
  );
  assert.equal(clip.toString('ascii', 36, 40), 'data');
  const sampleRate = clip.readUInt32LE(24);
  const bytesPerSecond = clip.readUInt32LE(28);
  const audio = Buffer.concat([
    clip.subarray(0, 44),
    clip.subarray(44),
    Buffer.alloc(bytesPerSecond * 7),
  ]);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.writeUInt32LE(audio.length - 44, 40);
  const sourceHash = digest(audio);
  const sourceDuration = ((audio.length - 44) / bytesPerSecond) * 1000;
  check(
    'Fixture preserves genuine speech and trailing silence at 1×',
    sampleRate === 16000 && sourceDuration >= 14000,
  );
  profile = await mkdtemp(path.join(artifact, 'profile-'));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message)));
  // Fail closed on unexpected external traffic; fixture requests are exclusively loopback.
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    browserErrors.push(
      `Blocked unexpected network origin: ${new URL(route.request().url()).origin}`,
    );
    return route.abort();
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: buildDir });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/replay.html`);
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      microphoneReady: false,
      transcriptionEnabled: true,
      listenAssistantAppearance: 'Daylight',
      assistantSettings: {
        enabled: true,
        provider: 'deepinfra',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
        goal: 'Synthetic fixture for replay transport and UI verification.',
        benchmarkPassed: false,
      },
    });
  });
  await page.reload();
  const command = (type, payload = {}) =>
    page.evaluate((message) => chrome.runtime.sendMessage({ target: 'worker', ...message }), {
      type,
      ...payload,
    });
  const status = async () => {
    const reply = await command('REPLAY_STATUS');
    assert.equal(reply.ok, true, reply.error);
    return reply.value;
  };
  async function until(predicate, label, timeout = 60000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const state = await status();
      if (await predicate(state)) return state;
      if (state.phase === 'error') throw Error(`${label}: ${state.error || state.run?.error}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw Error(`Timed out: ${label}; latest=${JSON.stringify(await status())}`);
  }
  const initial = await status();
  check(
    'Research build exposes Replay Lab without starting input',
    initial.enabled && initial.phase === 'idle' && calls.asr === 0 && calls.proposal === 0,
  );
  await capture(page, 'desktop-idle.png');
  await inspectContrast(page, 'Daylight');
  await page.locator('#audio-file').setInputFiles({
    name: 'broken.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('not a wave'),
  });
  await page.waitForTimeout(200);
  check('Invalid source cannot produce a paid request', calls.asr === 0 && calls.proposal === 0);
  await page.locator('#audio-file').setInputFiles({
    name: 'synthetic-transport-fixture.wav',
    mimeType: 'audio/wav',
    buffer: audio,
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#source-select option')].some((option) =>
      option.textContent.includes('synthetic-transport-fixture'),
    ),
  );
  const sourceId = await page.locator('#source-select').inputValue();
  assert.ok(sourceId);
  const startingAt = Date.now();
  await page.locator('#start-replay').click();
  const playing = await until((state) => state.phase === 'playing', 'source starts in real time');
  const firstRunId = playing.run.id;
  const firstSessionId = playing.run.sessionId;
  check('Selected audio identity is frozen by SHA-256', playing.run.source.sha256 === sourceHash);
  check(
    'Replay starts without microphone readiness or tab capture',
    await page.evaluate(
      async () => (await chrome.storage.local.get('microphoneReady')).microphoneReady === false,
    ),
  );
  const duplicate = await command('REPLAY_START', { sourceId });
  check(
    'Duplicate Start is rejected while the first replay owns the pipeline',
    duplicate.ok === false,
  );
  await page.waitForTimeout(1000);
  const elapsed = await status();
  check(
    'Input is streamed progressively, not submitted as a whole recording',
    elapsed.sourceMs > 0 && elapsed.sourceMs < sourceDuration / 2,
  );
  const frame = page.frameLocator('#memo-frame');
  await frame
    .locator('[data-current-memo="true"]')
    .getByText(memoText, { exact: true })
    .waitFor({ state: 'attached', timeout: 45000 });
  await frame.locator('#memo-bubble').waitFor({ state: 'visible', timeout: 10000 });
  check(
    'Actual v2 understanding and focused contribution arrive after local ASR and both LLM stages',
    calls.asr > 0 &&
      calls.proposal > 0 &&
      calls.review > 0 &&
      (await frame.locator('#analysis-panel').isHidden()),
  );
  await capture(page, 'desktop-active.png');
  await frame.locator('#memo-character').click();
  await frame.locator('#memo-bubble').waitFor({ state: 'hidden' });
  await frame.locator('#memo-character').click();
  await frame.locator('#memo-bubble').waitFor({ state: 'visible' });
  await frame.locator('[data-feedback="useful"]').first().click();
  await frame.locator('#analysis-panel').waitFor({ state: 'visible' });
  check(
    'Useful returns the real replay interface to its accepted understanding',
    await frame.locator('#memo-bubble').isHidden(),
  );
  check('Real character/bubble feedback interactions work during audio replay', true);
  await page.setViewportSize({ width: 390, height: 900 });
  await capture(page, 'mobile-active.png');
  check(
    'Narrow replay page has no horizontal document overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const completed = await until(
    (state) => state.phase === 'complete',
    'EOF drains and closes the replay',
    80000,
  );
  check(
    'EOF completes only after the real-time audio duration',
    Date.now() - startingAt >= sourceDuration - 1500,
  );
  check(
    'EOF preserves a final closed session instead of producing MOM',
    completed.run.sessionId === firstSessionId && completed.run.sourceMs >= sourceDuration - 300,
  );
  await page.locator('#run-status').getByText('Replay complete', { exact: true }).waitFor();
  await capture(page, 'desktop-complete.png');
  await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab.id, 2);
  });
  await page.waitForFunction(() => innerWidth <= 725);
  check(
    'Native browser zoom 200% retains a readable page without horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await capture(page, 'native-zoom-200.png');
  await page.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab.id, 1);
  });
  await page.evaluate(() => chrome.storage.local.set({ listenAssistantAppearance: 'Midnight' }));
  await page.waitForFunction(() => document.documentElement.dataset.surface === 'Midnight');
  await inspectContrast(page, 'Midnight');
  await capture(page, 'midnight-complete.png');
  // Reviewer F1/F3: these explicitly labelled local events test the research
  // timeline classifier and nested disclosure, not the provider's behavior.
  const syntheticPipelineEvents = [
    {
      kind: 'pipeline-diagnostic',
      data: {
        name: 'asr.error',
        status: 503,
        testFixture: 'Reviewer F1 classifier probe; no ASR outage occurred.',
      },
    },
    {
      kind: 'pipeline-diagnostic',
      data: { name: 'vad.window', windowId: 987, testFixture: 'Reviewer F1 wrapped VAD probe.' },
    },
    {
      kind: 'transcript-state',
      data: {
        phase: 'complete',
        segments: [
          {
            id: 999,
            text: 'Synthetic classifier fixture: the speaker is explaining error handling.',
          },
        ],
        testFixture: 'Reviewer F1 ordinary transcript prose probe; not actual ASR.',
      },
    },
  ];
  for (const event of syntheticPipelineEvents) {
    const response = await command('REPLAY_UI_EVENT', {
      sessionId: firstSessionId,
      event: { ...event, at: Date.now(), monotonicMs: 1, timeOrigin: Date.now() },
    });
    assert.ok(
      response.ok && response.value.accepted,
      'Could not inject the labelled classifier fixture.',
    );
  }
  await page.locator('#event-filter').selectOption('error');
  const errorTitle = page
    .locator('#event-list .event-title')
    .getByText('ASR request failed', { exact: true });
  await errorTitle.waitFor();
  check(
    'Errors resolves the wrapped asr.error name and HTTP failure',
    (await errorTitle.count()) === 1,
  );
  check(
    'Ordinary transcript prose containing error is excluded from Errors',
    !(await page.locator('#event-list').textContent()).includes(
      'the speaker is explaining error handling',
    ),
  );
  const errorRow = page
    .locator('#event-list > details')
    .filter({ hasText: 'ASR request failed' })
    .first();
  await errorRow.locator(':scope > summary').click();
  const technical = errorRow.locator(':scope > details.technical');
  check(
    'Opening an event keeps its Complete evidence disclosure closed',
    (await technical.getAttribute('open')) === null,
  );
  const closedGlyph = await technical
    .locator(':scope > summary')
    .evaluate((node) => getComputedStyle(node, '::before').content);
  check('Closed nested Complete evidence displays its own plus marker', closedGlyph.includes('+'));
  await technical.locator(':scope > summary').click();
  const openGlyph = await technical
    .locator(':scope > summary')
    .evaluate((node) => getComputedStyle(node, '::before').content);
  check('Opened nested Complete evidence displays its own minus marker', openGlyph.includes('−'));
  await page.locator('#event-filter').selectOption('transcript');
  await page
    .locator('#event-list .event-title')
    .getByText('vad window', { exact: true })
    .first()
    .waitFor();
  check(
    'Transcript filter includes the wrapped synthetic VAD window diagnostic',
    (await page.locator('#event-list > details').filter({ hasText: '"windowId": 987' }).count()) ===
      1,
  );
  check(
    'Transcript filter retains ordinary error prose as transcript evidence',
    (await page
      .locator('#event-list .event-description')
      .filter({ hasText: 'the speaker is explaining error handling' })
      .count()) === 1,
  );
  reviewerFixProofs.push({
    finding: 'F1/F3',
    evidence:
      'Actual research event store and rendered timeline; explicitly labelled synthetic diagnostic events injected through REPLAY_UI_EVENT.',
    events: syntheticPipelineEvents,
    closedGlyph,
    openGlyph,
    paidRequests: 0,
  });
  await page.locator('#event-filter').selectOption('all');
  // Reviewer F2: replace only this lab document's status read. The underlying
  // extension and real completed session remain untouched, then restore it.
  const recoveryError =
    'Synthetic reviewer fixture: transcription is unavailable; queued audio is recovering.';
  await page.evaluate(
    ({ base, error }) => {
      globalThis.__replayOriginalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, ...args) =>
        message?.target === 'worker' && message?.type === 'REPLAY_STATUS'
          ? Promise.resolve({
              ok: true,
              value: {
                ...base,
                phase: 'stopping',
                transcriptionBusy: true,
                assistantBusy: false,
                error,
                run: { ...base.run, phase: 'stopping', error },
              },
            })
          : globalThis.__replayOriginalSendMessage(message, ...args);
      document.dispatchEvent(new Event('visibilitychange'));
    },
    { base: completed, error: recoveryError },
  );
  await page
    .locator('#run-detail')
    .getByText(
      'Playback and live memo publication have stopped. Pending transcription is finishing or recovering; Repeat becomes available when it settles.',
      { exact: true },
    )
    .waitFor();
  await page.locator('#error').getByText(recoveryError, { exact: true }).waitFor();
  check(
    'Stopping recovery explicitly describes stopped live publication and pending ASR',
    await page.locator('#repeat-replay').isDisabled(),
  );
  check(
    'Status-reported processing errors appear in the actionable alert',
    await page.locator('#error').isVisible(),
  );
  await capture(page, 'stopping-recovery.png');
  await page.evaluate(() => {
    chrome.runtime.sendMessage = globalThis.__replayOriginalSendMessage;
    delete globalThis.__replayOriginalSendMessage;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#run-status').getByText('Replay complete', { exact: true }).waitFor();
  await page.locator('#error').waitFor({ state: 'hidden' });
  reviewerFixProofs.push({
    finding: 'F2',
    evidence:
      'UI-only REPLAY_STATUS override in the disposable lab document; actual completed extension run unchanged. Original messaging restored after the probe.',
    injectedPhase: 'stopping',
    injectedError: recoveryError,
    paidRequests: 0,
  });
  const download = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const downloaded = await download;
  const downloadPath = path.join(artifact, 'synthetic-run-export.json');
  await downloaded.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
  const events = exported.events ?? exported.timeline ?? [];
  check(
    'Export includes replay source identity and a nonempty diagnostic timeline',
    JSON.stringify(exported).includes(sourceHash) && events.length > 0,
  );
  const agentEvents = exported.agentReport?.events ?? [];
  check(
    'Export retains both v2 provider request inputs and response verdicts',
    agentEvents.filter((event) => event.kind === 'request').length >= 2 &&
      agentEvents.filter((event) => event.kind === 'response').length >= 2,
  );
  check(
    'Export correlates actual v2 DOM revisions with bubble interactions',
    events.some((event) => event.kind === 'ui.dom_applied' && event.data.memoId) &&
      events.some((event) => event.kind === 'ui.bubble_opened' && event.data.contributionId),
  );
  const htmlDownload = page.waitForEvent('download');
  await page.locator('#export-run').click();
  const reportDownload = await htmlDownload;
  const htmlPath = path.join(artifact, 'synthetic-run-report.html');
  await reportDownload.saveAs(htmlPath);
  const html = await readFile(htmlPath, 'utf8');
  check(
    'HTML export is a complete escaped document',
    /^<!doctype html>/i.test(html) &&
      html.includes('&quot;') &&
      html.includes('Memo replay evidence'),
  );
  const reportPage = await context.newPage();
  await reportPage.goto(new URL('file://' + htmlPath).href);
  await reportPage.getByRole('heading', { name: 'Memo replay evidence', exact: true }).waitFor();
  check(
    'Downloaded HTML report renders as a page rather than source code',
    (await reportPage.locator('h1').textContent()) === 'Memo replay evidence' &&
      !(await reportPage.locator('body').innerText()).trimStart().startsWith('<!doctype'),
  );
  await reportPage.close();
  await page.locator('#repeat-replay').click();
  const repeated = await until(
    (state) => state.phase === 'playing',
    'Repeat starts a clean replay session',
  );
  check(
    'Repeat reuses the exact source with a fresh run and session',
    repeated.run.source.sha256 === sourceHash &&
      repeated.run.id !== firstRunId &&
      repeated.run.sessionId !== firstSessionId,
  );
  const late = await command('REPLAY_UI_EVENT', {
    sessionId: firstSessionId,
    event: {
      kind: 'ui.synthetic_old_session',
      at: Date.now(),
      monotonicMs: 1,
      timeOrigin: Date.now(),
      data: {},
    },
  });
  check(
    'Frontend events from the prior session cannot attach to the new run',
    late.ok && late.value?.accepted === false,
  );
  await frame.locator('#stop').click();
  const stopped = await until(
    (state) => ['complete', 'idle'].includes(state.phase),
    'Explicit Stop settles',
  );
  check(
    'Explicit Stop cannot revive the previous accepted memo',
    stopped.run?.sessionId !== firstSessionId,
  );
  const stoppedCalls = { ...calls };
  await page.reload();
  await page.waitForTimeout(1500);
  const restored = await status();
  check(
    'Reload does not autoplay a recovered replay',
    !['starting', 'playing'].includes(restored.phase) &&
      calls.asr === stoppedCalls.asr &&
      calls.proposal === stoppedCalls.proposal,
  );
  check(
    'Archived run selection remains available after Repeat and reload',
    (await page.locator('#run-select option').count()) >= 2,
  );
  const retained = await page.evaluate(
    (runId) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('memo-replay-lab');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('runs').objectStore('runs').get(runId);
          request.onerror = () => {
            db.close();
            reject(request.error);
          };
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
        };
      }),
    firstRunId,
  );
  check(
    'Repeat preserves the earlier run and its complete AI evidence',
    retained.finalAssistant?.sessionId === firstSessionId &&
      retained.finalAssistant?.liveV2?.memo?.text === memoText &&
      retained.agentReport?.events?.filter((event) => event.kind === 'request').length >= 2,
  );
  const beforeInvalid = { ...calls };
  await page.locator('#source-select').selectOption({ label: 'broken.wav' });
  const invalidSourceId = await page.locator('#source-select').inputValue();
  await page.locator('#start-replay').click();
  // Poll extension messaging in Node. An async waitForFunction predicate can
  // yield the promise itself with this browser/driver pair, rather than the
  // resolved predicate. Return the exact matching status, never a later query.
  let invalid;
  const invalidPolls = [];
  const invalidDeadline = Date.now() + 25000;
  while (Date.now() < invalidDeadline) {
    const state = await status();
    invalidPolls.push({
      id: state.run?.id,
      sourceId: state.run?.sourceId,
      phase: state.phase,
      stopReason: state.run?.stopReason,
      endedAt: state.run?.endedAt,
      busy: state.transcriptionBusy || state.assistantBusy,
    });
    if (
      state.run?.sourceId === invalidSourceId &&
      state.run?.id !== stopped.run?.id &&
      state.phase === 'error' &&
      state.run?.endedAt &&
      !state.transcriptionBusy &&
      !state.assistantBusy
    ) {
      invalid = state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await writeFile(
    path.join(artifact, 'invalid-source-polls.json'),
    JSON.stringify(invalidPolls, null, 2),
  );
  assert.ok(invalid, 'Malformed audio did not reach a terminal error for the selected source.');
  await writeFile(
    path.join(artifact, 'invalid-source-at-assert.json'),
    JSON.stringify(invalid, null, 2),
  );
  const invalidSummary = {
    partial: invalid.run.partial,
    reason: invalid.run.stopReason,
    calls,
    beforeInvalid,
  };
  check(
    'Malformed audio produces an explicit partial source error without ASR or LLM work: ' +
      JSON.stringify(invalidSummary),
    invalid.run.partial &&
      invalid.run.stopReason === 'source-error' &&
      calls.asr === beforeInvalid.asr &&
      calls.proposal === beforeInvalid.proposal &&
      calls.review === beforeInvalid.review,
  );
  check(
    'A failed source never inherits the previous session memo as its result',
    !invalid.run.finalAssistant || invalid.run.finalAssistant.sessionId === invalid.run.sessionId,
  );
  await page.waitForFunction(
    (runId) => document.querySelector('#run-select')?.value === runId,
    invalid.run.id,
  );
  await page.locator('#event-filter').selectOption('error');
  await page
    .locator('#event-list .event-title')
    .getByText('Replay stopped after a failure', { exact: true })
    .waitFor();
  await page
    .locator('#event-list .event-title')
    .getByText('Replay ended with an error', { exact: true })
    .waitFor();
  check('Errors includes source-error stop and terminal run failure markers', true);
  await page.reload();
  await page
    .locator('#error')
    .getByText('Chrome could not decode this audio file. Try WAV or WebM audio.', { exact: true })
    .waitFor();
  check(
    'A real source error remains actionable after reloading Replay Lab',
    await page.locator('#error').isVisible(),
  );
  reviewerFixProofs.push({
    finding: 'F1/F2',
    evidence:
      'Actual malformed file playback attempt; no synthetic status override. Source-error stop/final markers visible in Errors and the actual persisted status.error is visible after UI reload.',
    sourceId: invalidSourceId,
    runId: invalid.run.id,
    paidRequests: 0,
  });
  await capture(page, 'source-error.png');
  check(
    'Browser did not report JavaScript errors or external requests',
    browserErrors.length === 0,
  );
  check(
    'Evaluation provider ledger is byte-for-byte unchanged',
    Buffer.compare(ledgerBefore, await readFile(ledgerPath)) === 0,
  );
  check(
    'Main extension build was not replaced',
    Buffer.compare(mainBefore, await readFile('dist/build-info.json')) === 0,
  );
  await writeFile(
    path.join(artifact, 'synthetic-provider-requests.json'),
    JSON.stringify(requests, null, 2),
  );
  await writeFile(
    path.join(artifact, 'reviewer-fix-proofs.json'),
    JSON.stringify(reviewerFixProofs, null, 2),
  );
} catch (error) {
  failure = error.stack || String(error);
  if (context) {
    const page = context.pages().find((item) => item.url().endsWith('/replay.html'));
    if (page) {
      await page
        .screenshot({ path: path.join(artifact, 'failure.png'), fullPage: true })
        .catch(() => {});
      const state = await page
        .evaluate(async () => ({
          text: document.body.innerText,
          replay: await chrome.runtime.sendMessage({ target: 'worker', type: 'REPLAY_STATUS' }),
          transcript: await chrome.runtime.sendMessage({
            target: 'worker',
            type: 'TRANSCRIPT_STATUS',
          }),
          assistant: await chrome.runtime.sendMessage({
            target: 'worker',
            type: 'ASSISTANT_STATUS',
          }),
        }))
        .catch(() => null);
      await writeFile(path.join(artifact, 'failure-state.json'), JSON.stringify(state, null, 2));
    }
  }
} finally {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => relay.close(resolve));
  const report = {
    passed: !failure,
    scope:
      'Synthetic relay responses through actual unpacked research extension and file/VAD/UI pipeline; not model-quality validation.',
    paidProviderRequests: 0,
    calls,
    checks,
    contrast,
    browserErrors,
    screenshots: screenshotsSaved,
    ledgerUnchanged: Buffer.compare(ledgerBefore, await readFile(ledgerPath)) === 0,
    mainBuildUnchanged: Buffer.compare(mainBefore, await readFile('dist/build-info.json')) === 0,
    ...(failure ? { failure } : {}),
  };
  await writeFile(path.join(artifact, 'replay-lab-smoke.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ...report,
        checks: checks.length,
        contrast: contrast.map((item) => ({
          theme: item.theme,
          measured: item.values.length,
          minimum: Math.min(...item.values.map((value) => value.ratio)),
        })),
      },
      null,
      2,
    ),
  );
}
if (failure) process.exitCode = 1;
