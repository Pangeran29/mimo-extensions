// Synthetic UI fixtures only. No microphone, model download, key, or provider request.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
    res.end(await readFile(path.join('dist', file)));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.LISTEN_CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const errors = [];
const capture = process.env.LISTEN_CAPTURE !== '0';
const captureDir = '.impeccable/review/memo';
await mkdir(captureDir, { recursive: true });
async function create(width, height = 820, deviceScaleFactor = 1, clockTime) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
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
      fullPage: true,
      animations: 'disabled',
    });
}
try {
  const p = await create(398, 820);
  await fit(p, '398px');
  assert(await p.locator('#pipeline-progress').isVisible(), 'Live timers missing');
  assert(
    (await p.locator('#audio-progress').textContent()) === '3.2s buffered',
    'Audio duration mismatch',
  );
  assert(
    (await p.locator('#asr-progress').textContent()) === '5.4s · working',
    'ASR elapsed mismatch',
  );
  assert(
    (await p.locator('#llm-progress').textContent()) === '2.1s · working',
    'LLM elapsed mismatch',
  );
  assert(
    !(await p.locator('#update-notification').isVisible()),
    'Restored notes produced an update notification',
  );
  await shot(p, 'midnight');
  assert(!(await p.locator('#view-heading').isVisible()), 'Summary heading still visible');
  assert((await p.locator('#latest-speech').count()) === 0, 'Speech preview still present');
  assert((await p.locator('.panel-header').count()) === 0, 'Brand bar still present');
  assert((await p.locator('#open-transcript svg').count()) === 1, 'Transcript icon missing');
  await p.setViewportSize({ width: 398, height: 500 });
  // Let the resize-follow callback settle before simulating a reader's scroll.
  await p.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await p.locator('#analysis-panel').evaluate((el) => (el.scrollTop = 100));
  await p.waitForTimeout(100);
  const position = await p.locator('#analysis-panel').evaluate((el) => el.scrollTop);
  assert(position > 24, 'Reader scroll fixture did not move away from latest notes');
  await p.evaluate(() => {
    window.ai.phase = 'thinking';
    window.ai.analyzingSince = Date.now() - 11000;
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    (await p.locator('#presence-detail').textContent()).includes('longer'),
    'Long-running response lacks feedback',
  );
  assert(
    (await p.locator('#analysis-panel').evaluate((el) => el.scrollTop)) === position,
    'Analysis request moved reading position',
  );
  await shot(p, 'updating');
  await p.evaluate(() => window.appendSummary());
  await p.waitForTimeout(100);
  assert(await p.locator('#update-notification').isVisible(), 'New memo notification missing');
  assert(
    (await p.locator('#update-notification-text').textContent()).includes('Notes updated'),
    'Wrong notification type',
  );
  await shot(p, 'new-update');
  await p.locator('#dismiss-update').click();
  await p.evaluate(() => window.publish('ASSISTANT_STATE', window.ai));
  assert(
    !(await p.locator('#update-notification').isVisible()),
    'Unchanged memo triggered notification',
  );
  await p.evaluate(() => {
    window.asr.segments.push({
      ...window.asr.segments.at(-1),
      id: 9,
      text: 'Another supported point.',
    });
    window.publish('TRANSCRIPT_STATE', window.asr);
  });
  assert(
    (await p.locator('#update-notification-text').textContent()).includes('Transcript received'),
    'New transcript notification missing',
  );
  await p.locator('#dismiss-update').click();
  await p.evaluate(() => {
    window.fixtureProgress.asr = { state: 'done', elapsedMs: 5370, queued: 0 };
    window.fixtureProgress.llm = {
      state: 'failed',
      elapsedMs: 1200,
      queued: true,
      paused: false,
      retryInMs: 4000,
    };
    window.publishProgress();
  });
  assert(
    (await p.locator('#asr-progress').textContent()) === '5.4s · last',
    'Completed ASR time missing',
  );
  assert(
    (await p.locator('#llm-progress').textContent()) === 'Retry in 4s',
    'Retry shown as active request',
  );
  assert(
    (await p.locator('#analysis-panel').evaluate((el) => el.scrollTop)) === position,
    'New revision moved historical reading position',
  );
  assert(
    (await p.locator('#jump-summary').textContent()) === 'Notes updated ↑',
    'Memo update cue missing',
  );
  assert((await p.locator('#summary-feed').count()) === 1, 'More than one memo');
  assert(
    (await p.locator('#summary-feed').textContent()).includes('Alex gives final approval'),
    'Memo did not update',
  );
  assert(
    !(await p.locator('#summary-feed').textContent()).includes('Who gives final approval?'),
    'Resolved question remains in memo',
  );
  assert((await p.locator('#summary-feed h1').count()) === 1, 'Memo title duplicated');
  await p.locator('#jump-summary').click();
  assert(!(await p.locator('#jump-summary').isVisible()), 'Jump did not return to notes');
  await p.setViewportSize({ width: 398, height: 820 });
  assert(!(await p.locator('#follow-up').isVisible()), 'Absent follow-up still rendered');
  await p.locator('#open-transcript').click();
  assert(await p.locator('#transcript-view').isVisible(), 'Source did not open transcript');

  await p.evaluate(() => {
    window.ai.phase = 'paused';
    window.ai.analysisError = 'API key expired. Check AI connection in Settings.';
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(await p.locator('#resume').isVisible(), 'AI recovery hidden in Transcript');
  await shot(p, 'paused-transcript');
  await p.locator('#resume').click();
  assert(!(await p.locator('#resume').isVisible()), 'Resume did not clear paused state');
  await p.locator('#transcript-back').click();
  await p.evaluate(() => {
    window.rec.phase = 'saving';
    window.publish('STATE', window.rec);
  });
  await p.locator('#open-transcript').click();
  assert(await p.locator('#transcript-view').isVisible(), 'Saving must keep transcript available');
  await shot(p, 'saving-transcript');
  await p.evaluate(() => {
    window.rec.phase = 'recording';
    window.publish('STATE', window.rec);
  });
  await p.locator('#transcript-back').click();
  await p.locator('#open-insights').click();
  await p.locator('#deeper').click();
  assert((await p.locator('#deep-result').textContent()).includes('QA'), 'Deeper analysis failed');
  await p.locator('#insights-back').click();
  await p.locator('#settings').click();
  const settings = p.frameLocator('#settings-frame');
  await settings.locator('html[data-surface="Midnight"]').waitFor();
  assert(
    (await settings.locator('html').evaluate((el) => getComputedStyle(el).backgroundColor)) ===
      (await p.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)),
    'Midnight Settings and host backgrounds differ',
  );
  await shot(p, 'settings-midnight');
  await p.locator('#open-insights').click();
  assert(await p.locator('#insights-view').isVisible(), 'Insights from Settings remained hidden');
  assert(!(await p.locator('#settings-frame').isVisible()), 'Insights did not leave Settings');
  assert(
    await p.evaluate(() => document.activeElement.id === 'view-title'),
    'Insights heading did not receive focus',
  );
  await shot(p, 'settings-to-insights');
  await p.locator('#insights-back').click();
  await p.locator('#settings').click();
  await settings.locator('#open-ai').click();
  await shot(p, 'settings-midnight-ai');
  await settings.locator('#back').click();
  await settings.locator('#open-appearance').click();
  await shot(p, 'settings-midnight-appearance');
  await settings.locator('#assistant-surface').selectOption('Daylight');
  await p.waitForFunction(() => document.body.dataset.surface === 'Daylight');
  await settings.locator('html[data-surface="Daylight"]').waitFor();
  assert(
    (await settings.locator('html').evaluate((el) => getComputedStyle(el).backgroundColor)) ===
      (await p.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)),
    'Daylight Settings and host backgrounds differ',
  );
  assert(await p.locator('#stop').isVisible(), 'Stop hidden in Settings');
  await shot(p, 'appearance');
  await settings.locator('#back').click();
  await shot(p, 'settings-daylight');
  await p.locator('#settings').click();
  await shot(p, 'daylight');
  await p.reload();
  // Reload fixture intentionally resets theme storage; test restored history, not fixture persistence.
  await p.waitForFunction(
    () => document.querySelector('#summary-feed h1')?.textContent === 'MVP launch',
  );
  assert((await p.locator('#summary-feed h1').count()) === 1, 'Saved memo not restored');
  await p.locator('#evidence').click();
  assert((await p.locator('[data-evidence=true]').count()) === 1, 'Question source missing');
  await p.locator('#transcript-back').click();
  await p.locator('#useful').click();
  assert((await p.locator('#useful').textContent()) === 'Marked useful', 'Useful feedback failed');
  await p.locator('#dismiss').click();
  assert(!(await p.locator('#follow-up').isVisible()), 'Dismiss failed');
  await p.evaluate(() => {
    window.asr.activity = 'speech';
    window.publish('TRANSCRIPT_STATE', window.asr);
  });
  assert(
    (await p.locator('#presence-label').textContent()) === 'Listening',
    'Speech presence missing',
  );
  await p.evaluate(() => {
    window.asr.activity = 'recognizing';
    window.publish('TRANSCRIPT_STATE', window.asr);
  });
  assert(
    (await p.locator('#presence-label').textContent()) === 'Transcribing…',
    'Recognition presence missing',
  );
  await shot(p, 'transcribing');
  await p.evaluate(() => {
    window.asr.phase = 'failed';
    window.asr.message = 'Speech processing stopped. Recording continues.';
    window.publish('TRANSCRIPT_STATE', window.asr);
  });
  assert(await p.locator('#presence-settings').isVisible(), 'Transcription failure lacks recovery');
  await p.locator('#settings').click();
  await p.locator('#stop').click();
  assert(!(await p.locator('#stop').isVisible()), 'Duplicate Stop available');
  const narrow = await create(272, 700);
  await fit(narrow, '272px');
  await shot(narrow, 'narrow');
  const daylight = await create(340, 760);
  await daylight.evaluate(() =>
    chrome.storage.local.set({ listenAssistantAppearance: 'Daylight' }),
  );
  await fit(daylight, '340px');
  await shot(daylight, 'mobile');
  const wide = await create(1000, 900);
  await fit(wide, '1000px');
  await shot(wide, 'desktop');
  // Browser zoom reduces the CSS viewport and scales physical pixels.
  const zoom = await create(340, 500, 2);
  await fit(zoom, '200% zoom');
  await shot(zoom, 'zoom');
  const idle = await create(340, 760);
  await idle.evaluate(() => {
    window.ai = {
      ...window.ai,
      sessionId: undefined,
      phase: 'ready',
      summary: '',
      summaries: [],
      question: null,
      memory: [],
      updatedAt: undefined,
    };
    window.asr = { ...window.asr, sessionId: undefined, segments: [], activity: 'waiting' };
    window.publish('ASSISTANT_STATE', window.ai);
    window.publish('TRANSCRIPT_STATE', window.asr);
    window.publish('STATE', { phase: 'idle', retained: [] });
  });
  assert(await idle.locator('#start').isVisible(), 'Idle Listen action missing');
  assert(!(await idle.locator('#assistant-view').isVisible()), 'Idle shows a live preview');
  assert(!(await idle.locator('#latest-speech').isVisible()), 'Idle speech dock still visible');
  assert(
    !(await idle.locator('#recording-status').isVisible()),
    'Idle recording status still visible',
  );
  await shot(idle, 'idle');
  await idle.evaluate(() => {
    window.startFailure = true;
  });
  await idle.locator('#start').click();
  await idle.waitForFunction(() => !document.getElementById('ai-alert').hidden);
  assert(!(await idle.locator('#assistant-view').isVisible()), 'Failed start showed live preview');
  assert(await idle.locator('#start').isEnabled(), 'Failed start left Listen stuck');
  await idle.evaluate(() => {
    window.startFailure = false;
    window.activeTab = {
      id: 22,
      windowId: 1,
      title: 'New current meeting',
      url: 'https://example.com/new',
    };
  });
  await idle.locator('#start').click();
  await idle.waitForFunction(() => !document.getElementById('assistant-view').hidden);
  assert((await idle.evaluate(() => window.lastStart.tabId)) === 22, 'Start used a stale tab');
  assert(
    (await idle.locator('#summary-feed').textContent()) === '',
    'New recording retained old memo',
  );
  assert(!(await idle.locator('#idle-view').isVisible()), 'Live recording still shows Listen CTA');
  assert(await idle.locator('#stop').isVisible(), 'Started session has no Stop');
  await shot(idle, 'started-from-panel');
  const schedule = await create(340, 760, 1, new Date(2026, 9, 18, 17, 59, 59));
  await schedule.evaluate(() => window.publish('STATE', { phase: 'idle', retained: [] }));
  await schedule.evaluate(() =>
    chrome.storage.local.set({ listenAssistantAppearance: 'Automatic' }),
  );
  await schedule.locator('#settings').click();
  const scheduleSettings = schedule.frameLocator('#settings-frame');
  await scheduleSettings.locator('html[data-surface="Daylight"]').waitFor();
  assert(
    (await schedule.locator('body').getAttribute('data-surface')) === 'Daylight',
    'Afternoon is not Daylight',
  );
  await schedule.clock.runFor(2100);
  assert(
    (await schedule.locator('body').getAttribute('data-surface')) === 'Midnight',
    '18:00 did not switch to Midnight',
  );
  assert(
    (await scheduleSettings.locator('html').getAttribute('data-surface')) === 'Midnight',
    'Settings missed the18:00 boundary',
  );
  await shot(schedule, 'settings-automatic-midnight');
  await schedule.clock.setSystemTime(new Date(2026, 9, 19, 5, 59, 59));
  await schedule.clock.runFor(2100);
  assert(
    (await schedule.locator('body').getAttribute('data-surface')) === 'Daylight',
    '06:00 did not switch to Daylight',
  );
  assert(
    (await scheduleSettings.locator('html').getAttribute('data-surface')) === 'Daylight',
    'Settings missed the06:00 boundary',
  );
  await shot(schedule, 'settings-automatic-daylight');
  await idle.evaluate(() =>
    window.publish('STATE', { phase: 'save-failed', session: { id: 'fixture' }, retained: [] }),
  );
  await idle.locator('#retry-save').click();
  assert(
    (await idle.locator('#session-status').textContent()).includes('Saving'),
    'Retry save failed',
  );
  const emptyPage = await create(340, 700);
  await emptyPage.evaluate(() => {
    window.rec = {
      ...window.rec,
      session: { id: 'empty-check', createdAt: Date.now(), durationMs: 0 },
    };
    window.publish('STATE', window.rec);
    window.asr = {
      ...window.asr,
      sessionId: 'empty-check',
      activity: 'waiting',
      segments: [
        {
          id: 0,
          sessionId: 'empty-check',
          startMs: 0,
          endMs: 7000,
          text: 'It is raining today. The coffee is good.',
        },
      ],
    };
    window.publish('TRANSCRIPT_STATE', window.asr);
    window.ai = {
      ...window.ai,
      sessionId: 'empty-check',
      phase: 'listening',
      version: 0,
      summary: '',
      summaries: [],
      memory: [],
      history: [],
      question: null,
      lastSegmentId: -1,
      updatedAt: undefined,
      lastAnalysis: undefined,
    };
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    (await emptyPage.locator('#summary-empty h2').textContent()) === 'Your notes start here.',
    'No completed request was mislabelled as empty',
  );
  await emptyPage.evaluate(() => {
    window.ai = {
      ...window.ai,
      version: 1,
      lastSegmentId: 0,
      updatedAt: Date.now(),
      lastAnalysis: {
        requestId: 'empty-check:1',
        version: 1,
        at: Date.now(),
        summaryCharacters: 0,
        memoCharacters: 0,
        outcome: 'empty',
      },
    };
    window.publish('ASSISTANT_STATE', window.ai);
    window.fixtureProgress = {
      ...window.fixtureProgress,
      sessionId: 'empty-check',
      llm: { state: 'done', elapsedMs: 4200, queued: false, paused: false, outcome: 'empty' },
    };
    window.publishProgress();
  });
  assert(
    (await emptyPage.locator('#summary-empty h2').textContent()) === 'No notes yet.',
    'Validated empty result was left unexplained',
  );
  assert(
    (await emptyPage.locator('#summary-empty p').textContent()).includes(
      'last completed AI check returned no notes',
    ),
    'Empty-result explanation missing',
  );
  assert(
    (await emptyPage.locator('#llm-progress').textContent()) === '4.2s · no new notes',
    'Timer confuses empty result with a new memo',
  );
  assert(
    (await emptyPage.locator('#update-notification-text').textContent()) ===
      'No new notes from this passage.',
    'Empty outcome notification missing',
  );
  const panelReading = await emptyPage.evaluate(
    () =>
      new Promise((resolve) =>
        window.listeners.forEach((fn) =>
          fn({ target: 'ui', type: 'MEMO_PRESENTATION_STATUS' }, { id: 'test' }, resolve),
        ),
      ),
  );
  assert(
    panelReading.value.requestId === 'empty-check:1' &&
      panelReading.value.domCharacters === 0 &&
      panelReading.value.emptyOutcomeMessage,
    'Panel outcome lacks correlated evidence',
  );
  await shot(emptyPage, 'no-new-notes');
  await emptyPage.locator('#dismiss-update').click();
  await emptyPage.evaluate(() => window.publish('ASSISTANT_STATE', window.ai));
  assert(
    !(await emptyPage.locator('#update-notification').isVisible()),
    'Repeated state resent empty-outcome notification',
  );
  await emptyPage.evaluate(() => {
    const summary = '# Rainy day\nThe speaker describes a rainy day and good coffee.';
    window.ai = {
      ...window.ai,
      version: 2,
      summary,
      updatedAt: Date.now(),
      lastAnalysis: {
        requestId: 'empty-check:2',
        version: 2,
        at: Date.now(),
        summaryCharacters: summary.length,
        memoCharacters: summary.length,
        outcome: 'updated',
      },
    };
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    !(await emptyPage.locator('#summary-empty').isVisible()),
    'First real note did not replace empty explanation',
  );
  assert(
    (await emptyPage.locator('#summary-feed').textContent()).includes('rainy day'),
    'Supported memo failed to render after empty result',
  );
  await fit(emptyPage, '340px empty response and recovery');
  assert(!errors.length, 'Page errors: ' + errors.join(', '));
  const report = {
    fixtureData: true,
    liveStageReadings: true,
    acceptedEmptyOutcome: true,
    correlatedPanelReading: true,
    transientUpdateNotifications: true,
    singleLivingMemo: true,
    preservesReadingPosition: true,
    memoUpdateCue: true,
    sourceNavigation: true,
    recoveryVisibleInTranscript: true,
    speechStates: true,
    slowFeedback: true,
    appearance: true,
    timeBasedAppearance: true,
    sharedSettingsAppearance: true,
    idleListenAndStartRecovery: true,
    rechecksActiveTabOnStart: true,
    settingsStop: true,
    feedback: true,
    deeper: true,
    retrySave: true,
    widths: [272, 340, 398, 1000],
    zoom: 200,
    pageErrors: errors,
  };
  await writeFile('artifacts/assistant-ui-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
