// Synthetic UI fixtures only. No microphone, model download, key, or provider request.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const assert = (value, message) => {
  if (!value) throw Error(message);
};
const server = createServer(async (req, res) => {
  const file = path.basename(new URL(req.url, 'http://localhost').pathname) || 'assistant.html';
  try {
    res.setHeader(
      'Content-Type',
      file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html',
    );
    res.end(await readFile(path.join('artifacts/live-memo-v1/candidate-build', file)));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir('artifacts/live-memo-v1/ui', { recursive: true });
const profile = await mkdtemp(path.resolve('artifacts/live-memo-v1/ui/profile-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
  executablePath:
    process.env.LISTEN_CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const errors = [];
const capture = process.env.LISTEN_CAPTURE !== '0';
const captureDir = 'artifacts/live-memo-v1/ui';
await mkdir(captureDir, { recursive: true });
async function create(width, height = 820, deviceScaleFactor = 1, clockTime) {
  const page = await browser.newPage();
  await page.setViewportSize({ width, height });
  if (clockTime) await page.clock.install({ time: clockTime });
  page.setDefaultTimeout(7000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (window === window.top) {
      const now = Date.now();
      window.calls = [];
      window.listeners = [];
      window.storageListeners = [];
      window.local = { listenAssistantAppearance: 'Midnight', microphoneReady: true };
      window.activeTab = {
        id: 7,
        windowId: 1,
        title: 'Planning meeting',
        url: 'https://example.com',
      };
      window.session = {};
      const memory = [
        {
          kind: 'decision',
          key: 'scope',
          text: 'MVP covers recording, transcription, and AI analysis.',
          evidenceSegmentIds: [0],
        },
      ];
      const memo =
        '# MVP launch\nThe team is preparing a focused Friday release, with QA and approval still to close.\n\n## Key points\n- The MVP covers recording, local transcription, and AI analysis.\n- Audio stays available while analysis runs.\n- Transcript details are available throughout the meeting.\n\n## Decisions\n- Keep the release scope to the three core features.\n- Friday remains the target, subject to QA passing.\n\n## Next steps\n- Maya finishes QA Thursday at noon.\n- Confirm final approval before the release.\n\n## Open questions\n- Who gives final approval?';
      window.ai = {
        phase: 'listening',
        sessionId: 'fixture',
        version: 8,
        summary: memo,
        summaries: [
          {
            format: 'memo',
            version: 8,
            createdAt: now,
            throughMs: 562000,
            summary: memo,
            memory,
            evidenceSegmentIds: [0, 7],
          },
        ],
        question: {
          text: 'Who gives final approval before Friday?',
          reason: 'Final approval is still an unresolved dependency.',
          issueKey: 'approval-owner',
          evidenceSegmentIds: [7],
          feedback: 'shown',
          createdAt: now,
        },
        memory,
        history: [],
        message: 'Connected',
        model: 'gpt-6-luna',
        lastSegmentId: 7,
        incomplete: false,
        deeperBusy: false,
        contextGap: false,
        updatedAt: now,
      };
      window.asr = {
        phase: 'transcribing',
        sessionId: 'fixture',
        modelReady: true,
        segments: Array.from({ length: 8 }, (_, i) => ({
          id: i,
          sessionId: 'fixture',
          startMs: 440000 + i * 16000,
          endMs: 450000 + i * 16000,
          text:
            i === 7
              ? 'Maya will own QA. Testing should finish Thursday at noon. Who gives final approval?'
              : 'Friday is our target. The MVP includes recording, transcription, and AI analysis.',
        })),
        incomplete: false,
        lagMs: 0,
        activity: 'waiting',
      };
      window.rec = {
        phase: 'recording',
        session: { id: 'fixture', createdAt: now - 562000, durationMs: 562000 },
        retained: [],
      };
      window.publish = (type, snapshot) =>
        window.listeners.forEach((fn) =>
          fn(
            structuredClone({
              target: 'ui',
              type,
              ...(type === 'STATE' ? { status: snapshot } : { snapshot }),
            }),
            { id: 'test' },
          ),
        );
      window.appendSummary = () => {
        const version = window.ai.version + 1,
          now = Date.now();
        const summary = window.ai.summary
          .replace(
            '- Confirm final approval before the release.',
            '- Alex gives final approval Thursday afternoon.',
          )
          .replace('\n\n## Open questions\n- Who gives final approval?', '');
        window.ai = {
          ...window.ai,
          version,
          summary,
          phase: 'listening',
          analyzingSince: undefined,
          updatedAt: now,
          lastSegmentId: 8,
          question: null,
          summaries: [
            {
              format: 'memo',
              version,
              summary,
              createdAt: now,
              throughMs: 578000,
              memory: window.ai.memory,
              evidenceSegmentIds: [8],
            },
          ],
        };
        window.asr.segments.push({
          id: 8,
          sessionId: 'fixture',
          startMs: 570000,
          endMs: 578000,
          text: 'Alex can give final approval Thursday afternoon. If QA passes, Friday is confirmed.',
        });
        window.publish('TRANSCRIPT_STATE', window.asr);
        window.publish('ASSISTANT_STATE', window.ai);
      };
    }
    const host = window.top;
    const storage = (area) => ({
      get: async () => structuredClone(host[area]),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: host[area][key], newValue: value };
          host[area][key] = value;
        }
        host.storageListeners.forEach((fn) => fn(changes, area));
      },
    });
    window.chrome = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { query: async () => [host.activeTab] },
      storage: {
        session: storage('session'),
        local: storage('local'),
        onChanged: { addListener: (fn) => host.storageListeners.push(fn) },
      },
      permissions: { contains: async () => true },
      runtime: {
        id: 'test',
        onMessage: { addListener: (fn) => host.listeners.push(fn) },
        connect: () => {
          const listeners = [];
          host.progressListeners ??= [];
          return {
            onMessage: {
              addListener: (fn) => {
                listeners.push(fn);
                host.progressListeners.push(fn);
              },
            },
            onDisconnect: { addListener: () => {} },
            disconnect: () => {
              host.progressListeners = host.progressListeners.filter(
                (fn) => !listeners.includes(fn),
              );
            },
          };
        },
        sendMessage: async (msg) => {
          host.calls.push(msg.type);
          switch (msg.type) {
            case 'ASSISTANT_STATUS':
              return { ok: true, value: structuredClone(host.ai) };
            case 'TRANSCRIPT_STATUS':
              return { ok: true, value: structuredClone(host.asr) };
            case 'STATUS':
              return { ok: true, value: structuredClone(host.rec) };
            case 'START':
              host.lastStart = msg;
              if (host.startFailure)
                return { ok: false, error: 'Microphone access is required. Open Settings.' };
              host.rec = {
                phase: 'recording',
                session: { id: 'new-fixture', createdAt: Date.now(), durationMs: 0 },
                retained: [],
              };
              return { ok: true, value: structuredClone(host.rec) };
            case 'ASSISTANT_SETTINGS':
              return {
                ok: true,
                value: {
                  settings: { enabled: true, model: 'gpt-6-luna', goal: '' },
                  hasKey: true,
                  hasAccess: true,
                },
              };
            case 'ASSISTANT_FEEDBACK':
              if (host.ai.live) {
                const item = host.ai.live.contributions.find((c) => c.id === msg.issueKey);
                if (item) {
                  item.feedback = msg.feedback;
                  if (msg.feedback === 'dismissed') {
                    item.archivedAt = Date.now();
                    item.archivedReason = 'dismissed';
                    host.ai.live.activeId = null;
                    host.ai.summary = '';
                  }
                }
                return { ok: true, value: structuredClone(host.ai) };
              }
              host.ai.question =
                msg.feedback === 'dismissed'
                  ? null
                  : { ...host.ai.question, feedback: msg.feedback };
              return { ok: true, value: structuredClone(host.ai) };
            case 'ASSISTANT_DEEPER':
              host.ai.deeper =
                'QA is the release dependency. Confirm testing results before final approval.';
              return { ok: true, value: structuredClone(host.ai) };
            case 'ASSISTANT_RESUME':
              host.ai.phase = 'listening';
              host.ai.analysisError = undefined;
              return { ok: true, value: structuredClone(host.ai) };
            case 'STOP':
              host.rec.phase = 'stopping';
              return { ok: true, value: structuredClone(host.rec) };
            case 'RETRY':
              host.rec.phase = 'saving';
              return { ok: true, value: structuredClone(host.rec) };
            case 'ASSISTANT_DEFAULTS':
              return {
                ok: true,
                value: {
                  settings: { enabled: true, model: 'gpt-6-luna', goal: msg.goal },
                  hasKey: true,
                  hasAccess: true,
                },
              };
            default:
              return { ok: false, error: 'Unsupported fixture action: ' + msg.type };
          }
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/assistant.html`);
  await page.waitForFunction(
    () => document.querySelector('#summary-feed h1')?.textContent === 'MVP launch',
  );
  await page.evaluate(() => {
    window.fixtureProgress = {
      sessionId: 'fixture',
      audio: { state: 'collecting', bufferedMs: 3200, lastWindowMs: 8000 },
      asr: { state: 'running', elapsedMs: 5370, queued: 1 },
      llm: { state: 'running', elapsedMs: 2100, queued: false, paused: false },
    };
    window.publishProgress = () =>
      window.progressListeners.forEach((fn) =>
        fn({ type: 'PIPELINE_PROGRESS', progress: window.fixtureProgress }),
      );
    window.publishProgress();
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page;
}
async function fit(page, label) {
  const data = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    main: document.querySelector('main').getBoundingClientRect().width,
    footer: document.querySelector('footer').getBoundingClientRect().bottom,
    height: innerHeight,
  }));
  assert(
    data.document <= data.width + 1 && data.main <= data.width + 1,
    label + ' horizontal overflow: ' + JSON.stringify(data),
  );
  assert(data.footer <= data.height + 1, label + ' footer outside screen: ' + JSON.stringify(data));
}
async function shot(page, name) {
  if (
    capture &&
    (!process.env.LISTEN_CAPTURE_ONLY || process.env.LISTEN_CAPTURE_ONLY.split(',').includes(name))
  )
    await page.screenshot({
      path: `${captureDir}/${name}.png`,
      fullPage: false,
      animations: 'disabled',
    });
}
try {
  const page = await create(420);
  await page.evaluate(() => {
    const now = Date.now();
    const make = (i) => ({
      id: 'c' + i,
      topic: 'launch',
      createdAt: now - i * 1000,
      kind: 'suggestion',
      title: i === 0 ? 'Check the approval handoff' : null,
      body: 'Suggestion: clarify the handoff between QA and approval so a late test result does not silently delay the release.',
      sources: [7],
      interpretation: false,
      generalKnowledge: false,
      proposal: true,
      ...(i ? { archivedAt: now, archivedReason: 'replaced' } : {}),
    });
    window.ai = {
      ...window.ai,
      question: null,
      summaries: [],
      summary: make(0).body,
      live: {
        protocol: 1,
        topic: { key: 'launch', label: 'Launch', sources: [7] },
        memory: [],
        contributions: Array.from({ length: 56 }, (_, i) => make(i)),
        activeId: 'c0',
        decision: 'candidate',
        closed: false,
        feedbackVersion: 0,
      },
    };
    window.publish('ASSISTANT_STATE', window.ai);
  });
  await page.waitForSelector('.live-contribution');
  await page.locator('#summary-feed button[data-feedback="useful"]').click();
  assert(
    (await page
      .locator('#summary-feed button[data-feedback="useful"]')
      .getAttribute('aria-pressed')) === 'true',
    'Useful feedback not reflected',
  );
  await page.locator('#summary-feed button[data-evidence-ids]').click();
  assert(await page.locator('#transcript-view').isVisible(), 'Sources did not open transcript');
  await page.locator('#transcript-back').click();
  await page.locator('#open-insights').click();
  assert(
    (await page.locator('#live-history-feed article').count()) === 25,
    'History must start with 25 items',
  );
  await page.locator('#history-more').click();
  assert(
    (await page.locator('#live-history-feed article').count()) === 50,
    'Second history page missing',
  );
  await page.locator('#history-more').click();
  assert(
    (await page.locator('#live-history-feed article').count()) === 55,
    'Final history page missing',
  );
  await page.locator('#insights-back').click();
  await shot(page, 'midnight-active');
  await fit(page, 'midnight');
  await page.evaluate(() => {
    window.local.listenAssistantAppearance = 'Daylight';
    window.storageListeners.forEach((f) =>
      f({ listenAssistantAppearance: { newValue: 'Daylight' } }, 'local'),
    );
  });
  await page.setViewportSize({ width: 272, height: 820 });
  await fit(page, 'narrow');
  await shot(page, 'daylight-narrow');
  await page.setViewportSize({ width: 420, height: 820 });
  const root = await browser.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', {
    path: path.resolve('artifacts/live-memo-v1/candidate-build'),
  });
  const control = await browser.newPage();
  await control.goto(`chrome-extension://${id}/setup.html`);
  await page.bringToFront();
  await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 2);
  });
  await page.waitForFunction(() => innerWidth <= 212);
  await fit(page, 'native Chrome zoom 200 percent');
  await shot(page, 'native-zoom-200');
  await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1);
  });
  await control.close();
  await page.setViewportSize({ width: 272, height: 820 });
  await page.locator('#summary-feed button[data-feedback="not-helpful"]').click();
  assert(
    (await page
      .locator('#summary-feed button[data-feedback="not-helpful"]')
      .getAttribute('aria-pressed')) === 'true',
    'Not helpful feedback missing',
  );
  await page.locator('#summary-feed button[data-feedback="dismissed"]').focus();
  await page.locator('#summary-feed button[data-feedback="dismissed"]').press('Enter');
  assert(await page.locator('#summary-empty').isVisible(), 'Dismiss must return to listening');
  assert(
    await page.evaluate(() => document.activeElement.id === 'analysis-panel'),
    'Dismiss lost reading-region focus',
  );
  await page.locator('#open-insights').click();
  assert(
    (await page.locator('#live-history-feed article').count()) === 56,
    'Dismissed item missing from history',
  );
  await page.evaluate(() => {
    window.rec = { phase: 'idle', retained: [] };
    window.ai.live.closed = true;
    window.ai.phase = 'complete';
    window.publish('STATE', window.rec);
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(await page.locator('#idle-view').isVisible(), 'Stop should retain idle Listen screen');
  await page.locator('#open-insights').click();
  assert(await page.locator('#live-history').isVisible(), 'Saved history must remain accessible');
  await page.locator('#live-history-feed button[data-evidence-ids]').first().click();
  await page.locator('#transcript-back').click();
  assert(await page.locator('#insights-view').isVisible(), 'Source Back must return to history');
  await page.locator('#insights-back').click();
  assert(await page.locator('#idle-view').isVisible(), 'Saved history Back must return to Listen');
  assert(errors.length === 0, JSON.stringify(errors));
  await writeFile(
    captureDir + '/result.json',
    JSON.stringify(
      {
        success: true,
        checks: [
          'active contribution',
          'source navigation',
          'three feedback actions',
          'history pages 25/50/55',
          'dismiss archive and focus',
          'themes',
          '272px narrow',
          'native Chrome zoom 200 percent',
          'saved history after Stop and source return',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Live memo UI smoke passed.');
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((r) => server.close(r));
}
