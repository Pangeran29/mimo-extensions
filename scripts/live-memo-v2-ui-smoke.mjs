// Synthetic UI fixtures only. No microphone, model download, key, or provider request.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const buildDir = process.env.LISTEN_UI_BUILD_DIR || 'artifacts/mimo-navigation-2026-11-01/build';
const captureDir = process.env.LISTEN_UI_ARTIFACT_DIR || 'artifacts/mimo-navigation-2026-11-01/ui/main';
let assertionCount = 0;
const assert = (value, message) => {
  assertionCount++;
  if (!value) throw Error(message);
};
const buildRoot = path.resolve(buildDir);
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(buildRoot, '.' + (pathname === '/' ? '/assistant.html' : pathname));
    const relative = path.relative(buildRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.png')
            ? 'image/png'
            : 'text/html',
    );
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir(captureDir, { recursive: true });
const profile = await mkdtemp(path.join(path.resolve(captureDir), 'profile-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
  executablePath:
    process.env.LISTEN_CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const errors = [];
const blockedRequests = [];
const captures = [];
const captureMetadata = [];
const layoutProofs = [];
const measurements = [];
await browser.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (
    url.hostname === '127.0.0.1' ||
    ['data:', 'blob:', 'chrome-extension:'].includes(url.protocol)
  )
    return route.continue();
  blockedRequests.push(url.origin);
  return route.abort();
});
const capture = process.env.LISTEN_CAPTURE !== '0';
let currentPage;

async function create(width, height = 820, clockTime, restoredV2 = false) {
  const page = await browser.newPage();
  currentPage = page;
  await page.setViewportSize({ width, height });
  if (clockTime) await page.clock.install({ time: clockTime });
  page.setDefaultTimeout(7000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((restoredV2) => {
    if (window === window.top) {
      const now = Date.now();
      window.calls = [];
      window.messages = [];
      window.pendingFeedback = [];
      window.feedbackMode = 'success';
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
      if (restoredV2) {
        const contribution = {
          id: 'restored-contribution',
          topic: 'launch',
          createdAt: now,
          kind: 'suggestion',
          status: 'relevant',
          statusSources: [7],
          title: 'Restored approval handoff',
          body: 'Clarify the final approval handoff.',
          sources: [7],
          interpretation: false,
          generalKnowledge: false,
          proposal: true,
        };
        window.ai = {
          ...window.ai,
          summary: contribution.body,
          summaries: [],
          question: null,
          liveV2: {
            protocol: 2,
            memo: {
              id: 'restored-memo',
              text: 'Participants discuss launch approval.',
              topic: { key: 'launch', label: 'Launch', sources: [7] },
              sources: [7],
              createdAt: now,
              throughSegmentId: 7,
            },
            topic: { key: 'launch', label: 'Launch', sources: [7] },
            memory: [],
            contributions: [contribution],
            activeId: contribution.id,
            decision: 'candidate',
            closed: true,
            feedbackVersion: 0,
          },
        };
        window.rec = { phase: 'idle', retained: [] };
      }
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
        getManifest: () => ({ name: 'Mimo', version: '0.12.0' }),
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
          host.messages.push(structuredClone(msg));
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
            case 'ASSISTANT_FEEDBACK': {
              const saved = structuredClone(host.ai);
              const respond = () => {
                if (host.feedbackMode === 'failure')
                  return { ok: false, error: 'Synthetic feedback save failure' };
                if (saved.liveV2) {
                  const item = saved.liveV2.contributions.find((c) => c.id === msg.issueKey);
                  if (item) {
                    item.feedback = msg.feedback;
                    if (msg.feedback === 'dismissed') {
                      item.archivedAt = Date.now();
                      item.archivedReason = 'dismissed';
                      saved.liveV2.activeId = null;
                      saved.summary = '';
                    }
                  }
                  if (host.ai.sessionId === saved.sessionId) {
                    const current = host.ai.liveV2?.contributions.find(
                      (c) => c.id === msg.issueKey,
                    );
                    if (current) Object.assign(current, item);
                    if (msg.feedback === 'dismissed' && host.ai.liveV2?.activeId === msg.issueKey)
                      host.ai.liveV2.activeId = null;
                  }
                  return { ok: true, value: saved };
                }
                saved.question =
                  msg.feedback === 'dismissed'
                    ? null
                    : { ...saved.question, feedback: msg.feedback };
                return { ok: true, value: saved };
              };
              if (host.feedbackMode === 'deferred')
                return new Promise((resolve) =>
                  host.pendingFeedback.push(() => resolve(respond())),
                );
              return respond();
            }
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
  }, restoredV2);
  await page.goto(`http://127.0.0.1:${server.address().port}/assistant.html`);
  await page.waitForFunction(
    (restored) =>
      restored
        ? document.getElementById('memo-character')
        : document.querySelector('#summary-feed h1')?.textContent === 'MVP launch',
    restoredV2,
  );
  await page.evaluate(() => {
    window.fixtureProgress = {
      sessionId: 'fixture',
      audio: { state: 'collecting', bufferedMs: 3200, lastWindowMs: 8000 },
      asr: { state: 'running', elapsedMs: 5370, queued: 1 },
      llm: { state: 'running', elapsedMs: 2100, queued: false, paused: false },
    };
    window.publishProgress = () =>
      (window.progressListeners ?? []).forEach((fn) =>
        fn({ type: 'PIPELINE_PROGRESS', progress: window.fixtureProgress }),
      );
    window.publishProgress();
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page;
}
async function functionalTextLegibility(page, label) {
  await page.evaluate(() => document.fonts.ready);
  const proof = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const checked = [];
    let excludedScreenReaderOnly = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (
        !parent ||
        !node.textContent.trim() ||
        parent.closest('script, style, svg, [aria-hidden="true"]')
      )
        continue;
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (
        parent.closest('.sr-only') ||
        ((box.width <= 1 || box.height <= 1) &&
          (style.clipPath !== 'none' || style.clip !== 'auto'))
      ) {
        excludedScreenReaderOnly++;
        continue;
      }
      if (
        parent.closest('[hidden]') ||
        !parent.getClientRects().length ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      )
        continue;
      if (
        parent.checkVisibility &&
        !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        continue;
      const closedDetails = parent.closest('details:not([open])');
      if (closedDetails && !closedDetails.querySelector(':scope > summary')?.contains(parent))
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (
        ![...range.getClientRects()].some(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.right > 0 &&
            r.left < innerWidth &&
            r.bottom > 0 &&
            r.top < innerHeight,
        )
      )
        continue;
      checked.push({
        id: parent.id || parent.closest('[id]')?.id || '',
        tag: parent.tagName.toLowerCase(),
        text: node.textContent.trim().slice(0, 80),
        fontSize: parseFloat(style.fontSize),
      });
    }
    const navLabels = ['open-live', 'open-transcript', 'settings'].map((id) => {
      const button = document.getElementById(id);
      const text = button?.querySelector('span');
      return {
        id,
        text: text?.textContent.trim(),
        fontSize: text ? parseFloat(getComputedStyle(text).fontSize) : null,
        visible: !!button?.getClientRects().length && !button.closest('[hidden]'),
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      testedTextNodes: checked.length,
      minimumFontSize: Math.min(...checked.map((item) => item.fontSize)),
      violations: checked.filter((item) => item.fontSize < 10.99),
      smallestText: checked.sort((a, b) => a.fontSize - b.fontSize).slice(0, 12),
      navLabels,
      excludedScreenReaderOnly,
    };
  });
  measurements.push({ label: label + ' visible text legibility', ...proof });
  assert(
    proof.testedTextNodes > 0 && proof.violations.length === 0,
    label + ': visible text smaller than 11px: ' + JSON.stringify(proof),
  );
  assert(
    proof.navLabels.filter((item) => item.visible).every((item) => item.fontSize >= 10.99),
    label + ': visible navigation label smaller than 11px: ' + JSON.stringify(proof.navLabels),
  );
}
async function fit(page, label) {
  currentPage = page;
  const data = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    main: document.querySelector('main').getBoundingClientRect().width,
    footer: document.querySelector('footer').getBoundingClientRect().bottom,
    footerTop: document.querySelector('footer').getBoundingClientRect().top,
    footerReachable: [...document.querySelectorAll('footer button')].every((button) => {
      const r = button.getBoundingClientRect();
      return (
        !r.height ||
        button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      );
    }),
    stop: (() => {
      const button = document.querySelector('#stop');
      const r = button?.getBoundingClientRect();
      return button && !button.hidden && r?.height
        ? {
            top: r.top,
            bottom: r.bottom,
            reachable: button.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            ),
          }
        : null;
    })(),
    height: innerHeight,
  }));
  await functionalTextLegibility(page, label);
  layoutProofs.push({ label, ...data });
  assert(
    data.document <= data.width + 1 && data.main <= data.width + 1,
    label + ' horizontal overflow: ' + JSON.stringify(data),
  );
  assert(data.footer <= data.height + 1, label + ' footer outside screen: ' + JSON.stringify(data));
  assert(data.footerReachable, label + ' footer buttons are obscured: ' + JSON.stringify(data));
  assert(
    !data.stop ||
      (data.stop.top >= 0 && data.stop.bottom <= data.height + 1 && data.stop.reachable),
    label + ' Stop outside screen: ' + JSON.stringify(data),
  );
  if (await page.locator('#memo-bubble').isVisible()) {
    const bubble = await page.locator('#memo-bubble').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert(
      bubble.left >= -1 &&
        bubble.right <= bubble.width + 1 &&
        bubble.top >= -1 &&
        bubble.bottom <= bubble.height + 1,
      label + ' Mimo focus region outside screen: ' + JSON.stringify(bubble),
    );
    assert(
      bubble.bottom <= data.footerTop + 1,
      label + ' Mimo focus region overlaps bottom navigation',
    );
  }
}
async function fusedSessionControls(page, label) {
  const proof = await page.evaluate(() => {
    const bounds = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const character = document.getElementById('memo-character');
    const companion = document.getElementById('memo-companion');
    const surface = document.getElementById('mimo-reading-surface');
    const sessionControls = document.getElementById('mimo-session-controls');
    const stop = document.getElementById('stop');
    const timer = document.getElementById('recording-status');
    const c = bounds(character),
      s = bounds(stop),
      t = bounds(timer);
    const controls = bounds(sessionControls);
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      character: c,
      stop: s,
      timer: t,
      controls,
      nestedInCompanion: companion.contains(stop) && companion.contains(timer),
      nestedInFusedSurface:
        !!surface &&
        surface.contains(companion) &&
        surface.contains(document.getElementById('assistant-view')),
      exactSessionContainer:
        !!sessionControls &&
        sessionControls.parentElement === companion &&
        sessionControls.contains(stop) &&
        sessionControls.contains(timer),
      stopNestedInMascotButton: character.contains(stop),
      headerControls: !!document.querySelector('.app-header #stop, .app-header #recording-status'),
      gap: Math.max(0, controls.left - c.right, c.left - controls.right),
      overlap: overlap(c, controls),
      controlsStyle: {
        background: getComputedStyle(sessionControls).backgroundColor,
        borderWidth: parseFloat(getComputedStyle(sessionControls).borderTopWidth),
        shadow: getComputedStyle(sessionControls).boxShadow,
      },
      stopVisibleText: stop.innerText.trim(),
      stopAccessibleName: stop.getAttribute('aria-label'),
      characterReachable: character.contains(document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)),
      stopReachable: stop.contains(document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)),
      nav: [...document.querySelectorAll('footer .nav-button')]
        .filter((el) => el.getClientRects().length)
        .map((el) => ({ id: el.id, ...bounds(el) })),
    };
  });
  measurements.push({ label: label + ' fused session controls', ...proof });
  assert(
    proof.nestedInCompanion &&
      proof.nestedInFusedSurface &&
      proof.exactSessionContainer &&
      !proof.stopNestedInMascotButton &&
      !proof.headerControls,
    label +
      ': recording controls are detached or nested inside Mimo toggle: ' +
      JSON.stringify(proof),
  );
  assert(
    proof.character.width >= 43.5 &&
      proof.character.height >= 43.5 &&
      proof.stop.width >= 43.5 &&
      proof.stop.height >= 43.5,
    label + ': fused recording targets smaller than44px: ' + JSON.stringify(proof),
  );
  assert(
    proof.controls.top >= proof.character.bottom - 16 &&
      proof.controls.top <= proof.character.bottom + 12 &&
      proof.characterReachable && proof.stopReachable,
    label + ': clock/Stop row is not directly below a reachable Mimo: ' + JSON.stringify(proof),
  );
  assert(
    /rgba\(0, 0, 0, 0\)|transparent/.test(proof.controlsStyle.background) &&
      proof.controlsStyle.borderWidth === 0 &&
      proof.controlsStyle.shadow === 'none',
    label + ': clock/Stop still has a separate floating card: ' + JSON.stringify(proof.controlsStyle),
  );
  assert(
    proof.stopVisibleText === '' && !!proof.stopAccessibleName,
    label + ': Stop must be icon-only while retaining an accessible name',
  );
  assert(
    proof.nav.length === 3 && proof.nav.every((item) => item.id !== 'open-insights'),
    label +
      ': bottom navigation does not contain exactly three primary controls: ' +
      JSON.stringify(proof.nav),
  );
  return proof;
}
async function minimalLiveSurface(page) {
  assert(
    (await page.locator('#summary-feed > :not([data-current-memo])').count()) === 0,
    'The main feed must contain only Current understanding',
  );
  assert(
    (await page
      .locator('#presence, #activity-details, #update-notification, #jump-summary')
      .count()) === 0,
    'Removed presence, activity, toast or jump-notes UI remains in the document',
  );
  assert(
    !(await page.locator('header.app-header .brand-lockup').isVisible()),
    'The live header still has a brand lockup',
  );
  assert(
    !(await page.locator('.app-header').isVisible()),
    'A detached live header still consumes reading space',
  );
  assert(await page.locator('#stop').isVisible(), 'The minimal live view lost Stop');
  assert(await page.locator('footer').isVisible(), 'The minimal live view lost bottom navigation');
  assert(
    !(await page.locator('body').innerText()).includes('catching up'),
    'Catching-up copy remains visible in the live surface',
  );
  await fusedSessionControls(page, 'minimal live surface');
}
async function showBubble(page) {
  if (!(await page.locator('#memo-bubble').isVisible()))
    await page.locator('#memo-character').click();
  await page.locator('#memo-bubble').waitFor({ state: 'visible' });
}
async function openHistory(page) {
  if (!(await page.locator('#settings-frame').isVisible()))
    await page.locator((await page.locator('#settings').isVisible()) ? '#settings' : '#idle-settings').click();
  const shortcut = page.frameLocator('#settings-frame').locator('#settings-history');
  await shortcut.waitFor({ state: 'visible' });
  assert(
    await shortcut.evaluate((el) => !el.closest('footer')),
    'History is still a bottom navigation item',
  );
  await shortcut.click();
  await page.locator('#insights-view').waitFor({ state: 'visible' });
}
async function leaveHistory(page, destination = 'live') {
  assert(
    (await page.locator('#history-back-label').textContent()).trim() === 'Settings',
    'History Back label does not name its actual Settings destination',
  );
  await page.locator('#insights-back').click();
  await page.locator('#settings-frame').waitFor({ state: 'visible' });
  assert(
    await page.frameLocator('#settings-frame').locator('#settings-history').evaluate((el) => document.activeElement === el),
    'History Back did not restore its Settings shortcut focus',
  );
  if (await page.locator('#open-' + destination).isVisible()) await page.locator('#open-' + destination).click();
  else await page.frameLocator('#settings-frame').locator('#settings-return').click();
}

async function fixedSettingsNavigation(page, label) {
  const proof = await page.evaluate(() => {
    const settings = document.getElementById('settings');
    const footer = document.getElementById('session-controls');
    const visible = (el) => !!el?.getClientRects().length && !el.closest('[hidden]');
    return {
      footerVisible: visible(footer),
      labels: [...footer.querySelectorAll('.nav-button')].filter(visible).map((el) => el.innerText.trim()),
      selected: settings.getAttribute('aria-pressed'),
      name: settings.getAttribute('aria-label'),
      companionVisible: visible(document.getElementById('memo-companion')),
      returnVisible: visible(document.getElementById('settings-return')),
    };
  });
  measurements.push({ label, ...proof });
  assert(proof.footerVisible && proof.labels.join('|') === 'Live memo|Transcript|Settings',
    label + ': active footer changes its labels or structure: ' + JSON.stringify(proof));
  assert(proof.selected === 'true' && proof.name === 'Settings', label + ': Settings is not a stable selected tab');
  assert(!proof.companionVisible && !proof.returnVisible, label + ': utility view shows Live Mimo or an extra Back');
}
async function idleWelcome(page, label) {
  await page.bringToFront();
  const title = "(233) I'm 28, Single & Haven't Dated Anyone in Almost 6 Years - YouTube";
  await page.evaluate((title) => {
    window.activeTab.title = title;
    document.dispatchEvent(new Event('visibilitychange'));
  }, title);
  await page.waitForFunction((title) => document.getElementById('start-source').textContent === title, title);
  await page.locator('#start').hover();
  await page.waitForTimeout(250);
  const proof = await page.evaluate(() => {
    const card = document.getElementById('idle-view');
    const button = document.getElementById('start');
    const source = document.getElementById('start-source');
    const settings = document.getElementById('idle-settings');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
    };
    const b = rect(button), style = getComputedStyle(button), labelStyle = getComputedStyle(document.getElementById('start-label')), sourceStyle = getComputedStyle(source);
    const rgb = (color) => {
      const values = (color.match(/[\d.]+/g) || []).slice(0,3).map(Number);
      return color.startsWith('color(srgb') ? values.map((v) => v * 255) : values;
    };
    const luminance = (color) => rgb(color).map((v)=>v/255).map((v)=>v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4)
      .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ink = luminance(labelStyle.color), background = luminance(style.backgroundColor);
    return {
      viewport:{width:innerWidth,height:innerHeight},
      welcome:rect(card), button:b, settings:rect(settings),
      footerVisible:!!document.querySelector('footer').getClientRects().length && !document.querySelector('footer').closest('[hidden]'),
      settingsInWelcome:card.contains(settings) && !settings.closest('footer'),
      buttonVisible:style.visibility === 'visible' && parseFloat(style.opacity) > .99 && !!button.getClientRects().length,
      buttonEnabled:!button.disabled,
      hover:button.matches(':hover'), background:style.backgroundColor, color:labelStyle.color,
      opaqueButton:!['rgba(0, 0, 0, 0)','transparent'].includes(style.backgroundColor),
      contrast:(Math.max(ink,background)+.05)/(Math.min(ink,background)+.05),
      buttonReachable:button.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)),
      sourceText:source.textContent, source:rect(source), sourceLineHeight:parseFloat(sourceStyle.lineHeight),
    };
  });
  measurements.push({label:label+' welcome hover and integration',...proof});
  assert(!proof.footerVisible && proof.settingsInWelcome, label+': idle Settings still needs an otherwise empty bottom bar');
  assert(proof.welcome.top >= 12 && proof.welcome.left >= 8 && proof.welcome.right <= proof.viewport.width - 8,
    label+': welcome surface touches the outer viewport: '+JSON.stringify(proof.welcome));
  assert(proof.buttonEnabled && proof.hover && proof.buttonVisible && proof.opaqueButton && proof.buttonReachable && proof.contrast >=4.5,
    label+': Start disappears, loses contrast, or cannot be clicked on hover: '+JSON.stringify(proof));
  assert(proof.button.width >=44 && proof.button.height >=44 && proof.settings.width >=44 && proof.settings.height >=44,
    label+': welcome controls lost minimum hit areas');
  assert(proof.sourceText===title && proof.source.height <= proof.sourceLineHeight*3+1,
    label+': long source title lost its text or dominates the welcome: '+JSON.stringify(proof.source));
}
async function characterImage(page) {
  assert(
    await page
      .locator('#memo-character img')
      .evaluate(
        (img) =>
          img.complete &&
          img.naturalWidth > 0 &&
          new URL(img.currentSrc).pathname.endsWith('/memo/memo-slime.png'),
      ),
    'Mimo character image did not load from its nested PNG asset',
  );
  const asset = await page.request.get(
    await page.locator('#memo-character img').evaluate((img) => img.currentSrc),
  );
  assert(
    asset.ok() && asset.headers()['content-type'] === 'image/png',
    'Memo asset server did not return the PNG MIME type',
  );
}
async function shot(page, name) {
  currentPage = page;
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (
    capture &&
    (!process.env.LISTEN_CAPTURE_ONLY || process.env.LISTEN_CAPTURE_ONLY.split(',').includes(name))
  ) {
    const filename = `${name}.png`;
    await page.screenshot({
      path: path.join(captureDir, filename),
      fullPage: false,
      animations: 'disabled',
    });
    const png = await readFile(path.join(captureDir, filename));
    assert(
      png.length > 1024 &&
        png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'Invalid capture: ' + filename,
    );
    captures.push(filename);
    captureMetadata.push({
      filename,
      pngWidth: png.readUInt32BE(16),
      pngHeight: png.readUInt32BE(20),
      ...(await page.evaluate(() => ({
        logicalWidth: innerWidth,
        logicalHeight: innerHeight,
        fontsStatus: document.fonts.status,
        scrollWidth: document.documentElement.scrollWidth,
        mimoView: document.body.dataset.mimoView,
        surface: document.body.dataset.surface,
      }))),
    });
  }
}
async function mode(page, expected, label) {
  await page.waitForFunction((value) => document.body.dataset.mimoView === value, expected);
  assert(
    (await page.locator('#contribution-view').isVisible()) === (expected === 'contribution'),
    label + ': contribution focus visibility',
  );
  assert(
    (await page.locator('#analysis-panel').isVisible()) === (expected === 'understanding'),
    label + ': understanding visibility',
  );
}
const useful = (page) => page.locator('#memo-bubble-content [data-feedback="useful"]');
const skip = (page) => page.locator('#memo-bubble-content [data-skip-contribution]');
async function more(page) {
  const details = page.locator('#memo-bubble-content details.contribution-more');
  assert((await details.count()) === 1, 'Contribution must have one native More disclosure');
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
  return details;
}
async function feedbackCount(page) {
  return page.evaluate(() => window.calls.filter((type) => type === 'ASSISTANT_FEEDBACK').length);
}
async function publishContribution(page, id, options = {}) {
  await page.evaluate(
    ({ id, options }) => {
      const live = window.ai.liveV2;
      if (options.archivePrevious && live.activeId) {
        const previous = live.contributions.find((c) => c.id === live.activeId);
        if (previous)
          Object.assign(previous, { archivedAt: Date.now(), archivedReason: 'replaced' });
      }
      const item = {
        topic: 'launch',
        kind: 'suggestion',
        interpretation: false,
        generalKnowledge: false,
        proposal: true,
        ...(live.contributions.find((c) => c.id === live.activeId) ?? live.contributions[0]),
        id,
        createdAt: Date.now(),
        feedback: undefined,
        archivedAt: undefined,
        archivedReason: undefined,
        title: options.title ?? `Thought ${id}`,
        body: options.body ?? 'Suggestion: clarify the approval handoff before releasing.',
        sources: options.emptySources ? [] : [7],
        statusSources: options.emptySources ? [] : [7],
        status: 'relevant',
      };
      live.contributions.push(item);
      window.ai.version++;
      live.activeId = id;
      live.decision = 'candidate';
      window.publish('ASSISTANT_STATE', window.ai);
    },
    { id, options },
  );
}
async function hitTargets(page, label) {
  const targets = await page.evaluate(() =>
    [...document.querySelectorAll('button, summary')]
      .filter((el) => el.getClientRects().length && !el.closest('[hidden]'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.id,
          feedback: el.dataset.feedback,
          skip: 'skipContribution' in el.dataset,
          width: r.width,
          height: r.height,
        };
      }),
  );
  assert(
    targets.every((target) => target.width >= 31.5 && target.height >= 31.5),
    label + ': target below 32px ' + JSON.stringify(targets),
  );
  assert(
    targets
      .filter(
        (target) =>
          ['stop', 'memo-character'].includes(target.id) ||
          target.feedback === 'useful' ||
          target.skip,
      )
      .every((target) => target.width >= 43.5 && target.height >= 43.5),
    label + ': primary target below 44px ' + JSON.stringify(targets),
  );
  measurements.push({ label, targets });
}
async function focusMetrics(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.memo-bubble-scroll');
    const focus = document.activeElement;
    const r = focus?.getBoundingClientRect();
    return {
      displayedId: document.querySelector('#memo-bubble-content [data-contribution-id]')?.dataset
        .contributionId,
      focus: { id: focus?.id, feedback: focus?.dataset.feedback, top: r?.top, bottom: r?.bottom },
      scroll: {
        top: panel.scrollTop,
        height: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        pageY: scrollY,
      },
    };
  });
}
async function assertNoAction(page, callback, label) {
  const count = await page.evaluate(() => window.calls.length);
  await callback();
  assert(
    await page.evaluate((before) => window.calls.length === before, count),
    label + ' dispatched a recording/provider action',
  );
}
async function acceptedTextFits(page, label, kind, expectedText) {
  const proof = await page.evaluate(
    ({ kind, expectedText }) => {
      const scroller = document.querySelector(
        kind === 'contribution' ? '.memo-bubble-scroll' : '#analysis-panel',
      );
      const body = document.querySelector(
        kind === 'contribution'
          ? '#memo-bubble-content .live-body'
          : '[data-current-memo] .live-body',
      );
      return {
        kind,
        expectedCharacters: expectedText.length,
        actualText: body.textContent,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        fontSize: parseFloat(getComputedStyle(body).fontSize),
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    { kind, expectedText },
  );
  measurements.push({ label, ...proof });
  assert(proof.actualText === expectedText, label + ': accepted text changed or was truncated');
  assert(
    proof.scrollHeight <= proof.clientHeight + 1,
    label + ': ordinary accepted text needs internal scrolling: ' + JSON.stringify(proof),
  );
  assert(proof.fontSize >= 15, label + ': prose was shrunk to manufacture fit');
}
async function keyboardFocus(page, locator) {
  await page.locator('#stop').focus();
  let tabs = 0;
  while (!(await locator.evaluate((el) => document.activeElement === el)) && tabs < 40) {
    await page.keyboard.press('Tab');
    tabs++;
  }
  assert(
    await locator.evaluate((el) => document.activeElement === el && el.matches(':focus-visible')),
    'Keyboard navigation did not visibly focus its target',
  );
  return tabs;
}
try {
  const page = await create(420);
  await page.locator('#stop').focus();
  await page.evaluate(() => {
    const now = Date.now();
    const make = (i) => ({
      id: 'c' + i,
      topic: 'launch',
      createdAt: now - i * 1000,
      kind: 'suggestion',
      status: 'relevant',
      statusSources: [7],
      title: i === 0 ? 'Check the approval handoff' : null,
      body:
        i === 0
          ? 'Suggestion: clarify the handoff between QA and approval so a late test result does not silently delay the release. '.repeat(
              7,
            )
          : 'Suggestion: clarify the handoff between QA and approval.',
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
      liveV2: {
        protocol: 2,
        memo: {
          id: 'memo0',
          text: 'Participants discuss the QA handoff and launch approval.',
          topic: { key: 'launch', label: 'Launch', sources: [7] },
          sources: [7],
          createdAt: now,
          throughSegmentId: 7,
        },
        topic: { key: 'launch', label: 'Launch', sources: [7] },
        memory: [],
        contributions: Array.from({ length: 56 }, (_, i) => make(i)),
        activeId: 'c0',
        decision: 'candidate',
        closed: false,
        feedbackVersion: 0,
      },
    };
    const baseline = structuredClone(window.ai);
    baseline.liveV2.activeId = null;
    baseline.liveV2.contributions = [];
    baseline.liveV2.decision = 'silent';
    window.publish('ASSISTANT_STATE', baseline);
    window.publish('ASSISTANT_STATE', window.ai);
  });
  const originalV2Fixture = await page.evaluate(() => structuredClone(window.ai));
  await mode(page, 'contribution', 'new contribution');
  await minimalLiveSurface(page);
  await characterImage(page);
  assert(
    await page.locator('#stop').evaluate((el) => document.activeElement === el),
    'Automatic contribution entry stole focus',
  );
  assert(
    (await page.locator('#memo-character').getAttribute('aria-expanded')) === 'true',
    'Character expanded state missing',
  );
  assert(
    (await page.locator('#memo-bubble').getAttribute('aria-modal')) !== 'true',
    'Contribution focus must remain non-modal',
  );
  assert(
    !(await page.locator('.thought-toolbar').isVisible()),
    'Redundant contribution Back toolbar still consumes reading space',
  );
  assert(
    (await page.locator('#memo-bubble-content .live-body').textContent()) ===
      (await page.evaluate(() => window.ai.liveV2.contributions[0].body)),
    'Long accepted contribution was truncated',
  );
  const beforeClose = await feedbackCount(page);
  await page.locator('#memo-character').click();
  await mode(page, 'understanding', 'Close');
  assert(
    await page.locator('#memo-character').evaluate((el) => document.activeElement === el),
    'Mimo close did not retain its toggle focus',
  );
  assert(
    (await feedbackCount(page)) === beforeClose &&
      (await page.evaluate(() => window.ai.liveV2.activeId === 'c0')),
    'Close submitted feedback or archived the contribution',
  );
  await page.evaluate(() => window.publish('ASSISTANT_STATE', window.ai));
  await mode(page, 'understanding', 'same ID after Close');
  await showBubble(page);
  await useful(page).focus();
  await page.keyboard.press('Escape');
  await mode(page, 'understanding', 'Escape inside contribution');
  assert(
    await page.locator('#analysis-panel').evaluate((el) => document.activeElement === el),
    'Escape lost understanding focus',
  );
  await showBubble(page);
  await page.locator('#stop').focus();
  await page.keyboard.press('Escape');
  await mode(page, 'understanding', 'Escape from Stop');
  assert(
    await page.locator('#stop').evaluate((el) => document.activeElement === el),
    'Escape from outside contribution stole focus',
  );
  await showBubble(page);
  await skip(page).click();
  await mode(page, 'understanding', 'Skip');
  assert(
    (await feedbackCount(page)) === beforeClose &&
      (await page.evaluate(() => !window.ai.liveV2.contributions[0].archivedAt)),
    'Skip submitted negative feedback or archived the contribution',
  );
  await page.evaluate(() => window.publish('ASSISTANT_STATE', window.ai));
  await mode(page, 'understanding', 'same ID after Skip');

  await page.evaluate(() => {
    window.savedV2Fixture = structuredClone(window.ai);
    window.ai.liveV2.memo = null;
    window.ai.liveV2.activeId = null;
    window.ai.liveV2.contributions = [];
    window.ai.liveV2.decision = 'wait';
    window.fixtureProgress.llm = { state: 'idle', elapsedMs: 0, queued: false, paused: false };
    window.publishProgress();
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    (await page.locator('[data-current-memo] .live-body').textContent()).includes('Gathering'),
    'Ambiguous opening invented a current understanding',
  );
  assert(
    (await page.locator('#summary-feed .live-contribution').count()) === 0,
    'Gathering context put a contribution in the understanding feed',
  );
  assert(
    !(await page.locator('[data-current-memo] button[data-evidence-ids]').isVisible()),
    'Gathering context exposed empty Sources',
  );
  await assertNoAction(page, () => page.locator('#memo-character').click(), 'Character greeting');
  await mode(page, 'understanding', 'greeting without contribution');
  await fit(page, 'gathering context');
  await page.evaluate(() => {
    window.ai.liveV2.memo = structuredClone(window.savedV2Fixture.liveV2.memo);
    window.ai.liveV2.decision = 'silent';
    window.publish('ASSISTANT_STATE', window.ai);
  });
  const quietMemo = await page.locator('[data-current-memo] .live-body').textContent();
  assert(quietMemo.includes('QA handoff'), 'Quiet state lost current understanding');
  assert(
    (await page.locator('#summary-feed .live-contribution').count()) === 0,
    'Understanding alone implied a contribution',
  );
  await shot(page, 'midnight-understanding');
  await page.setViewportSize({ width: 1440, height: 900 });
  await fit(page, 'desktop understanding');
  await shot(page, 'desktop-understanding');
  await page.setViewportSize({ width: 420, height: 820 });
  await page.locator('[data-current-memo] button[data-evidence-ids]').click();
  await page.locator('#transcript-back').click();
  await mode(page, 'understanding', 'understanding Sources Back');
  assert(
    await page
      .locator('[data-current-memo] button[data-evidence-ids]')
      .evaluate((el) => document.activeElement === el),
    'Understanding Sources Back lost exact trigger',
  );
  await page.evaluate(() => {
    window.ai.phase = 'thinking';
    window.ai.liveV2.stage = 'proposal';
    window.ai.analyzingSince = Date.now();
    window.fixtureProgress.llm = {
      state: 'running',
      elapsedMs: 2100,
      queued: false,
      paused: false,
    };
    window.publishProgress();
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    (await page.locator('[data-current-memo] .live-body').textContent()) === quietMemo,
    'Processing replaced the last accepted understanding',
  );
  await minimalLiveSurface(page);
  await page.evaluate(() => {
    window.ai = window.savedV2Fixture;
    window.fixtureProgress.llm = { state: 'idle', elapsedMs: 0, queued: false, paused: false };
    window.publishProgress();
    window.publish('ASSISTANT_STATE', window.ai);
  });
  await showBubble(page);
  await page.setViewportSize({ width: 420, height: 400 });
  await useful(page).focus();
  const anchorBefore = await focusMetrics(page);
  assert(
    anchorBefore.scroll.height > anchorBefore.scroll.clientHeight &&
      anchorBefore.scroll.pageY === 0,
    'Long contribution did not scroll internally',
  );
  await fit(page, 'short contribution scroll');
  await page.evaluate(() => {
    window.oldContribution = document.querySelector(
      '#memo-bubble-content [data-contribution-id="c0"]',
    );
    window.ai.liveV2.memo = {
      ...window.ai.liveV2.memo,
      id: 'memo1',
      text: 'Participants propose a separate approval handoff after QA.',
    };
    window.publish('ASSISTANT_STATE', window.ai);
  });
  const anchorAfter = await focusMetrics(page);
  measurements.push({
    label: 'memo update while reading',
    before: anchorBefore,
    after: anchorAfter,
  });
  assert(
    await page.evaluate(
      () =>
        window.oldContribution ===
        document.querySelector('#memo-bubble-content [data-contribution-id="c0"]'),
    ),
    'Understanding update rebuilt the focused contribution',
  );
  assert(
    await useful(page).evaluate((el) => document.activeElement === el),
    'Understanding update lost keyboard focus',
  );
  assert(
    Math.abs(anchorAfter.focus.top - anchorBefore.focus.top) < 2 &&
      anchorAfter.scroll.top === anchorBefore.scroll.top,
    'Understanding update moved the reading anchor',
  );
  await mode(page, 'contribution', 'understanding update behind contribution');
  await page.locator('#memo-character').click();
  assert(
    (await page.locator('[data-current-memo] .live-body').textContent()).includes('propose'),
    'Returning to understanding did not show its latest accepted memo',
  );
  await page.setViewportSize({ width: 420, height: 820 });
  await showBubble(page);
  await page.locator('#memo-bubble-content button[data-evidence-ids]').first().click();
  assert(
    (await page.locator('#transcript-view').isVisible()) &&
      !(await page.locator('#memo-bubble').isVisible()),
    'Sources did not open an unobscured transcript',
  );
  await page.evaluate(() => {
    window.sourceFocus = document.activeElement;
    window.ai.liveV2.memo = {
      ...window.ai.liveV2.memo,
      id: 'memo-source-navigation',
      text: 'Participants confirm the approval handoff after QA.',
    };
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(
    await page.evaluate(() => document.activeElement === window.sourceFocus),
    'Incoming understanding stole transcript focus',
  );
  await page.locator('#transcript-back').click();
  await mode(page, 'contribution', 'Sources Back');
  assert(
    await page
      .locator('#memo-bubble-content button[data-evidence-ids]')
      .first()
      .evaluate((el) => document.activeElement === el),
    'Sources Back lost its exact trigger',
  );
  assert(
    await page.evaluate(
      () =>
        window.oldContribution ===
        document.querySelector('#memo-bubble-content [data-contribution-id="c0"]'),
    ),
    'Sources Back replaced the pinned contribution',
  );
  for (const status of ['answered', 'corrected']) {
    await page.evaluate((status) => {
      Object.assign(window.ai.liveV2.contributions[0], { status, statusSources: [7] });
      window.publish('ASSISTANT_STATE', window.ai);
    }, status);
    assert(
      (await page.locator('#memo-bubble-content .contribution-status').textContent()).includes(
        status === 'answered' ? 'Already addressed' : 'Corrected',
      ),
      status + ' status missing',
    );
  }
  await page.locator('#memo-bubble-content [data-status-source]').click();
  await page.locator('#transcript-back').click();
  assert(
    await page
      .locator('#memo-bubble-content [data-status-source]')
      .evaluate((el) => document.activeElement === el),
    'Status Sources Back lost focus',
  );
  await page.locator('#memo-character').click();
  await page.locator('#stop').focus();
  await page.evaluate(() => {
    window.savedEvidenceFixture = structuredClone(window.ai);
    window.ai.liveV2.memo = { ...window.ai.liveV2.memo, id: 'empty-evidence-memo', sources: [] };
  });
  await publishContribution(page, 'empty-evidence', { emptySources: true });
  await mode(page, 'contribution', 'new ID after local Close');
  assert(
    await page.locator('#stop').evaluate((el) => document.activeElement === el),
    'New contribution stole focus',
  );
  assert(
    await page.locator('[data-current-memo] button[data-evidence-ids]').evaluate((el) => el.hidden),
    'Understanding exposed empty Sources',
  );
  assert(
    !(await page.locator('#memo-bubble-content button[data-evidence-ids]').first().isVisible()),
    'Contribution exposed empty Sources',
  );
  assert(
    !(await page.locator('#memo-bubble-content [data-status-source]').isVisible()),
    'Status exposed empty Sources',
  );
  await page.evaluate(() => {
    window.savedEvidenceFixture.version = window.ai.version + 1;
    window.ai = window.savedEvidenceFixture;
    window.publish('ASSISTANT_STATE', window.ai);
  });
  await page.locator('#memo-character').click();
  await openHistory(page);
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
  await page.locator('#live-history-feed button[data-evidence-ids]').first().click();
  await page.locator('#transcript-back').click();
  assert(
    await page.locator('#insights-view').isVisible(),
    'History Sources Back did not return to History',
  );
  await leaveHistory(page);
  await mode(page, 'understanding', 'History Back');
  await showBubble(page);
  await useful(page).focus();
  await page.evaluate(() => {
    window.pinnedNode = document.querySelector('#memo-bubble-content [data-contribution-id]');
    window.pinnedFocus = document.activeElement;
  });
  const beforeQueue = await feedbackCount(page);
  const pinnedBefore = await focusMetrics(page);
  await publishContribution(page, 'queued-c1', { archivePrevious: true });
  const pinnedAfter = await focusMetrics(page);
  measurements.push({
    label: 'new contribution queued behind pinned reading',
    before: pinnedBefore,
    after: pinnedAfter,
  });
  assert(
    await page.evaluate(
      () =>
        window.pinnedNode ===
          document.querySelector('#memo-bubble-content [data-contribution-id]') &&
        window.pinnedFocus === document.activeElement,
    ),
    'Queued contribution replaced the pinned node or focus',
  );
  assert(
    pinnedAfter.displayedId === 'c0' &&
      Math.abs(pinnedAfter.focus.top - pinnedBefore.focus.top) < 2,
    'Queued contribution moved the reading anchor: ' +
      JSON.stringify({ before: pinnedBefore, after: pinnedAfter }),
  );
  assert(
    (await page.locator('#memo-character').getAttribute('data-has-pending-contribution')) ===
      'true',
    'Queued contribution lost its pending badge',
  );
  assert(
    (await feedbackCount(page)) === beforeQueue,
    'Unread queued contribution submitted feedback',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await fit(page, 'desktop focused reading');
  await fusedSessionControls(page, 'desktop focused reading');
  await hitTargets(page, 'desktop contribution');
  await shot(page, 'desktop-contribution-queued');
  await page.locator('#memo-bubble-content button[data-evidence-ids]').first().click();
  await publishContribution(page, 'queued-from-sources', { archivePrevious: true });
  await page.locator('#transcript-back').click();
  await mode(page, 'contribution', 'Sources Back with a newer pending ID');
  assert(
    (await page
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === 'c0',
    'Sources Back jumped from pinned content to a newer contribution',
  );
  assert(
    await page
      .locator('#memo-bubble-content button[data-evidence-ids]')
      .first()
      .evaluate((el) => document.activeElement === el),
    'Queued Sources Back lost exact trigger',
  );
  await skip(page).click();
  await mode(page, 'understanding', 'Skip pinned contribution');
  await showBubble(page);
  assert(
    (await page
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === 'queued-from-sources',
    'Character did not open latest pending contribution',
  );
  await page.locator('#open-transcript').click();
  assert(!(await page.locator('#transcript-back').isVisible()), 'Ordinary Transcript retains a redundant return CTA');
  assert(!(await page.locator('#memo-companion').isVisible()), 'Mimo follows the user into ordinary Transcript');
  await publishContribution(page, 'transcript-pending', { archivePrevious: true });
  await shot(page, 'active-transcript');
  await page.locator('#open-live').click();
  await mode(page, 'understanding', 'normal Transcript tab return');
  await showBubble(page);
  await page.locator('#settings').click();
  await publishContribution(page, 'settings-pending', { archivePrevious: true });
  await fixedSettingsNavigation(page, 'active Settings tab');
  await page.locator('#settings').click();
  assert(await page.locator('#settings-frame').isVisible(), 'Clicking active Settings acts like Back');
  await page.locator('#open-live').click();
  await mode(page, 'understanding', 'Settings live tab return');
  await showBubble(page);
  assert(
    (await page
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === 'settings-pending',
    'Character did not open latest pending after navigation',
  );
  await page.evaluate(() => (window.feedbackMode = 'deferred'));
  await useful(page).click();
  await page.waitForFunction(() => window.pendingFeedback.length === 1);
  assert(await useful(page).isDisabled(), 'Saving feedback allows duplicate clicks');
  await page.locator('#memo-character').click();
  await showBubble(page);
  await page.evaluate(() => {
    window.feedbackMode = 'success';
    window.pendingFeedback.shift()();
  });
  await page.waitForTimeout(1900);
  await mode(page, 'contribution', 'late feedback after Close and reopen');
  assert(
    (await page.locator('#memo-companion').getAttribute('data-reaction')) !== 'useful',
    'Stale feedback acknowledged a reopened interaction',
  );
  await page.locator('#memo-character').click();
  await publishContribution(page, 'before-newer-late', { archivePrevious: true });
  await page.evaluate(() => (window.feedbackMode = 'deferred'));
  await useful(page).click();
  await page.waitForFunction(() => window.pendingFeedback.length === 1);
  await page.locator('#memo-character').click();
  await publishContribution(page, 'newer-interaction', { archivePrevious: true });
  await page.evaluate(() => {
    window.feedbackMode = 'success';
    window.pendingFeedback.shift()();
  });
  await page.waitForTimeout(1900);
  await mode(page, 'contribution', 'late feedback after a newer ID');
  assert(
    (await page
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === 'newer-interaction',
    'Stale feedback replaced a newer contribution',
  );

  await page.setViewportSize({ width: 272, height: 820 });
  await page.evaluate(() => chrome.storage.local.set({ listenAssistantAppearance: 'Daylight' }));
  await fit(page, '272px Daylight');
  await fusedSessionControls(page, '272px Daylight');
  await hitTargets(page, '272px Daylight');
  await shot(page, 'daylight-narrow-contribution');
  await page.locator('#memo-character').click();
  await fit(page, '272px Daylight understanding');
  await shot(page, 'daylight-narrow-understanding');
  await showBubble(page);
  await page.setViewportSize({ width: 420, height: 820 });
  const zoomController = path.join(profile, 'zoom-controller');
  await mkdir(zoomController);
  await writeFile(
    path.join(zoomController, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Mimo isolated UI zoom controller',
      version: '1.0',
      permissions: ['tabs'],
      host_permissions: ['http://127.0.0.1/*'],
    }),
  );
  await writeFile(
    path.join(zoomController, 'control.html'),
    '<!doctype html><title>UI zoom control</title>',
  );
  const root = await browser.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: zoomController });
  const control = await browser.newPage();
  await control.goto(`chrome-extension://${id}/control.html`);
  await page.bringToFront();
  await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 2);
  });
  await page.waitForFunction(() => innerWidth <= 212);
  await mode(page, 'contribution', 'native zoom');
  await fit(page, 'native Chrome zoom 200 percent (210 logical px)');
  await hitTargets(page, 'native zoom 200 percent');
  await page.locator('.memo-bubble-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.evaluate(() => document.fonts.ready);
  const nativeReading = await page.evaluate(() => {
    const scroller = document.querySelector('.memo-bubble-scroll');
    const card = scroller.querySelector('[data-contribution-id]');
    const heading = card.querySelector('.contribution-heading h2');
    const body = card.querySelector('.live-body');
    const range = document.createRange();
    range.selectNodeContents(body);
    const bounds = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        height: r.height,
        width: r.width,
      };
    };
    const scrollBounds = bounds(scroller);
    // A browser may return a second rectangle for trailing whitespace on the
    // same line. Group fragments by their vertical coordinate before counting.
    const fragments = [...range.getClientRects()]
      .filter((r) => r.height > 0)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }));
    const lines = [];
    for (const fragment of fragments) {
      const line = lines.find((row) => Math.abs(row.top - fragment.top) < 0.5);
      if (line) {
        line.left = Math.min(line.left, fragment.left);
        line.right = Math.max(line.right, fragment.right);
        line.bottom = Math.max(line.bottom, fragment.bottom);
      } else lines.push({ ...fragment });
    }
    const visibleLines = lines.filter(
      (r) =>
        r.top >= scrollBounds.top - 1 &&
        r.bottom <= scrollBounds.bottom + 1 &&
        r.left >= scrollBounds.left - 1 &&
        r.right <= scrollBounds.right + 1,
    );
    const contribution = window.ai.liveV2.contributions.find(
      (c) => c.id === card.dataset.contributionId,
    );
    const tags = [...card.querySelectorAll('.knowledge-tags span')].map((tag) => tag.textContent);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      contributionId: card.dataset.contributionId,
      scrollTop: scroller.scrollTop,
      scroller: scrollBounds,
      heading: bounds(heading),
      title: heading.textContent,
      expectedTitle: contribution?.title ?? 'A thought to consider',
      headingCount: card.querySelectorAll('.contribution-heading h2, .contribution-title').length,
      genericEyebrows: card.querySelectorAll('.kind-tag, .contribution-heading h3').length,
      bodyLines: lines,
      initiallyVisibleBodyLines: visibleLines.length,
      tags,
    };
  });
  measurements.push({ label: 'native 200 percent initial reading measure', ...nativeReading });
  assert(
    nativeReading.title === nativeReading.expectedTitle,
    'Native 200 percent contribution lost its actual title: ' + JSON.stringify(nativeReading),
  );
  assert(
    nativeReading.genericEyebrows === 0 && nativeReading.headingCount === 1,
    'Contribution retains redundant generic heading metadata',
  );
  assert(
    new Set(nativeReading.tags).size === nativeReading.tags.length,
    'Contribution tags repeat the kind metadata',
  );
  assert(
    nativeReading.scrollTop === 0 &&
      nativeReading.heading.top >= nativeReading.scroller.top - 1 &&
      nativeReading.heading.bottom <= nativeReading.scroller.bottom + 1,
    'Native 200 percent initial contribution title is clipped: ' + JSON.stringify(nativeReading),
  );
  assert(
    nativeReading.initiallyVisibleBodyLines >= 3,
    'Native 200 percent contribution initially shows fewer than three full body lines: ' +
      JSON.stringify(nativeReading),
  );
  const nativeNavigation = await page.evaluate(() => {
    const button = document.getElementById('open-transcript');
    const label = button.querySelector('span');
    const range = document.createRange();
    range.selectNodeContents(label);
    const bounds = (rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
    const fragments = [...range.getClientRects()].filter((r) => r.height > 0).map(bounds);
    const lineTops = fragments.reduce(
      (lines, r) => (lines.some((top) => Math.abs(top - r.top) < 0.5) ? lines : [...lines, r.top]),
      [],
    );
    return {
      text: label.textContent,
      button: bounds(button.getBoundingClientRect()),
      fragments,
      lineCount: lineTops.length,
    };
  });
  measurements.push({ label: 'native 200 percent Transcript label', ...nativeNavigation });
  assert(
    nativeNavigation.text.trim() === 'Transcript' &&
      nativeNavigation.lineCount === 1 &&
      nativeNavigation.fragments.length > 0,
    'Native 200 percent Transcript label wraps: ' + JSON.stringify(nativeNavigation),
  );
  assert(
    nativeNavigation.fragments.every(
      (r) =>
        r.left >= nativeNavigation.button.left - 0.5 &&
        r.right <= nativeNavigation.button.right + 0.5 &&
        r.top >= nativeNavigation.button.top - 0.5 &&
        r.bottom <= nativeNavigation.button.bottom + 0.5,
    ),
    'Native 200 percent Transcript label escapes its button: ' + JSON.stringify(nativeNavigation),
  );
  const nativeBadge = await page.evaluate(() => {
    const button = document.getElementById('memo-character');
    const badge = button.querySelector('.memo-contribution-hint');
    const bounds = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const character = bounds(button);
    const hint = bounds(badge);
    // The portrait's middle contains the eyes and mouth; the badge must stay
    // above this central region, in the character button's upper-right corner.
    const protectedFace = {
      left: character.left + character.width * 0.2,
      right: character.left + character.width * 0.8,
      top: character.top + character.height * 0.36,
      bottom: character.top + character.height * 0.84,
    };
    const overlapWidth = Math.max(
      0,
      Math.min(hint.right, protectedFace.right) - Math.max(hint.left, protectedFace.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(hint.bottom, protectedFace.bottom) - Math.max(hint.top, protectedFace.top),
    );
    return {
      character,
      badge: hint,
      protectedFace,
      faceOverlapArea: overlapWidth * overlapHeight,
      badgeVisible:
        getComputedStyle(badge).opacity !== '0' && getComputedStyle(badge).visibility !== 'hidden',
    };
  });
  measurements.push({ label: 'native 200 percent character badge', ...nativeBadge });
  assert(
    nativeBadge.badgeVisible && nativeBadge.badge.width <= 18.5 && nativeBadge.badge.height <= 18.5,
    'Native 200 percent character badge is oversized: ' + JSON.stringify(nativeBadge),
  );
  assert(
    nativeBadge.character.width >= 43.5 &&
      nativeBadge.character.height >= 43.5 &&
      nativeBadge.badge.left >= nativeBadge.character.left + nativeBadge.character.width * 0.6 &&
      nativeBadge.badge.bottom <= nativeBadge.character.top + nativeBadge.character.height * 0.35 &&
      nativeBadge.faceOverlapArea === 0,
    'Native 200 percent badge covers the central character face: ' + JSON.stringify(nativeBadge),
  );
  const nativeFusion = await fusedSessionControls(page, 'native 200 percent upper edge');
  assert(
    nativeFusion.nav.length === 3 &&
      nativeFusion.nav.every(
        (item) =>
          item.top >= 0 &&
          item.bottom <= 411 &&
          item.width >= 43.5 &&
          item.height >= 43.5 &&
          Math.abs(item.top - nativeFusion.nav[0].top) < 1,
      ),
    'Native three-item navigation is not one reachable row: ' + JSON.stringify(nativeFusion.nav),
  );
  const nativeTextSeparation = await page.evaluate(() => {
    const rect = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const controls = ['memo-character', 'recording-status', 'stop'].map((id) =>
      rect(document.getElementById(id).getBoundingClientRect()),
    );
    const scroller = document.querySelector('.memo-bubble-scroll');
    const viewport = rect(scroller.getBoundingClientRect());
    const text = [...scroller.querySelectorAll('h2,.live-body')].flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()]
        .map((r) => ({
          left: Math.max(r.left, viewport.left),
          right: Math.min(r.right, viewport.right),
          top: Math.max(r.top, viewport.top),
          bottom: Math.min(r.bottom, viewport.bottom),
        }))
        .filter((r) => r.right > r.left && r.bottom > r.top);
    });
    return {
      controls,
      text,
      overlap: text.reduce((sum, t) => sum + controls.reduce((n, c) => n + overlap(t, c), 0), 0),
      cueAriaLive: document.getElementById('mimo-cue').getAttribute('aria-live'),
    };
  });
  measurements.push({
    label: 'native 200 percent upper mascot and visible reading separation',
    ...nativeTextSeparation,
  });
  assert(
    nativeTextSeparation.overlap === 0,
    'Upper mascot/controls obscure accepted text: ' + JSON.stringify(nativeTextSeparation),
  );
  assert(nativeTextSeparation.cueAriaLive === 'polite', 'Mimo cue lost its live announcement');
  await shot(page, 'native-zoom-200-contribution');
  await page.locator('#settings').click();
  const zoomSettings = page.frameLocator('#settings-frame');
  await zoomSettings.locator('#overview-title').waitFor({ state: 'visible' });
  assert(
    await zoomSettings
      .locator('body')
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Native 200 percent Settings overflowed its 210px logical host',
  );
  assert(
    !(await page.locator('#memo-companion').isVisible()) &&
      (await zoomSettings.locator('#settings-mimo-brand').isVisible()),
    'Native Settings must retain its own portrait without the live companion',
  );
  await fixedSettingsNavigation(page, 'native 200 percent embedded Settings');
  const nativeReadiness = await zoomSettings.locator('#readiness').evaluate((el) => {
    const style = getComputedStyle(el);
    const context = document.createElement('canvas').getContext('2d');
    context.font = style.font;
    const text = el.textContent;
    const words = [...text.matchAll(/\S+/g)].map((match) => {
      const range = document.createRange();
      range.setStart(el.firstChild, match.index);
      range.setEnd(el.firstChild, match.index + match[0].length);
      const lines = [...range.getClientRects()].filter((r) => r.height > 0);
      return { word: match[0], lineFragments: lines.length };
    });
    return {
      viewport: innerWidth,
      text,
      width: el.getBoundingClientRect().width,
      contentWidth: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      microphoneWordWidth: context.measureText('Microphone').width,
      words,
      wordBreak: style.wordBreak,
      overflowWrap: style.overflowWrap,
    };
  });
  measurements.push({ label: 'native 200 percent Settings readiness measure', ...nativeReadiness });
  assert(
    nativeReadiness.text.includes('Microphone'),
    'Native Settings readiness fixture does not exercise Microphone text',
  );
  assert(
    nativeReadiness.contentWidth >= nativeReadiness.microphoneWordWidth &&
      nativeReadiness.words.every((word) => word.lineFragments === 1),
    'Native 200 percent Settings splits readiness words into syllables: ' +
      JSON.stringify(nativeReadiness),
  );
  await shot(page, 'native-zoom-200-settings');
  await page.locator('#open-live').click();
  await mode(page, 'understanding', 'native zoom Settings live tab return');
  await showBubble(page);
  await control.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1);
  });
  await control.close();
  await page.setViewportSize({ width: 420, height: 820 });
  await page.evaluate(() => (window.feedbackMode = 'failure'));
  await useful(page).click();
  await page.locator('#memo-bubble-content .feedback-error').waitFor({ state: 'visible' });
  await mode(page, 'contribution', 'feedback save failure');
  assert(await useful(page).isEnabled(), 'Failed feedback cannot be retried');
  assert(
    (await page.locator('#memo-companion').getAttribute('data-reaction')) !== 'useful',
    'Failed feedback played success appreciation',
  );
  await shot(page, 'daylight-feedback-failed');
  await page.evaluate(() => (window.feedbackMode = 'success'));
  await useful(page).click();
  await page.waitForFunction(
    () => document.getElementById('memo-companion').dataset.reaction === 'useful',
  );
  assert(
    (await page.locator('#memo-character').getAttribute('data-mimo-pose')) === 'appreciation',
    'Saved Useful did not show appreciation',
  );
  await shot(page, 'daylight-useful-appreciation');
  await mode(page, 'understanding', 'saved Useful timed return');
  assert(
    (await page.locator('[data-current-memo] .live-body').textContent()).includes('confirm'),
    'Useful return lost current understanding',
  );
  await showBubble(page);
  const disclosure = await more(page);
  await disclosure.locator('[data-feedback="not-helpful"]').click();
  assert(
    (await disclosure.locator('[data-feedback="not-helpful"]').getAttribute('aria-pressed')) ===
      'true',
    'Not helpful feedback missing',
  );
  await mode(page, 'understanding', 'Not helpful');
  await showBubble(page);
  const dismissDisclosure = await more(page);
  await dismissDisclosure.locator('[data-feedback="dismissed"]').focus();
  await dismissDisclosure.locator('[data-feedback="dismissed"]').press('Enter');
  await mode(page, 'understanding', 'Dismiss');
  assert(
    await page.locator('[data-current-memo]').isVisible(),
    'Dismiss removed factual understanding',
  );
  assert(
    await page.evaluate(() => window.ai.liveV2.activeId === null),
    'Dismiss did not clear the active contribution',
  );
  await openHistory(page);
  const historyCards = await page.locator('#live-history-feed article').count();
  assert(historyCards >= 25, 'Dismissed contribution history disappeared');
  while (await page.locator('#history-more').isVisible())
    await page.locator('#history-more').click();
  assert(
    (await page
      .locator('#live-history-feed [data-contribution-id="newer-interaction"]')
      .count()) === 1,
    'Dismissed contribution missing from history',
  );
  await leaveHistory(page);
  await publishContribution(page, 'stop-active');
  await mode(page, 'contribution', 'contribution before Stop');
  const stopBefore = await page.locator('#memo-companion').getAttribute('data-reaction-id');
  await page.locator('#stop').click();
  await mode(page, 'understanding', 'Stop');
  assert(
    (await page.evaluate(() => window.calls.filter((type) => type === 'STOP').length)) === 1,
    'Stop was not dispatched once',
  );
  assert(
    (await page.locator('#memo-companion').getAttribute('data-reaction')) === 'stopped',
    'Stop did not show its rest reaction',
  );
  assert(
    (await page.locator('#memo-companion').getAttribute('data-reaction-id')) !== stopBefore,
    'Stop did not produce a new character reaction',
  );
  assert(
    !(await page.locator('body').innerText()).includes('Minutes of Meeting'),
    'Stop automatically generated minutes',
  );
  await publishContribution(page, 'late-after-stop', { archivePrevious: true });
  await mode(page, 'understanding', 'late contribution after Stop');
  await page.evaluate(() => {
    window.rec = { phase: 'idle', retained: [] };
    window.ai.liveV2.closed = true;
    window.ai.phase = 'complete';
    window.publish('STATE', window.rec);
    window.publish('ASSISTANT_STATE', window.ai);
  });
  assert(await page.locator('#idle-view').isVisible(), 'Stop lost the idle screen');
  await openHistory(page);
  await page.locator('#live-history-feed button[data-evidence-ids]').first().click();
  await page.locator('#transcript-back').click();
  assert(
    await page.locator('#insights-view').isVisible(),
    'Saved History Sources Back lost history',
  );
  await leaveHistory(page);
  if (await page.locator('#leave-saved').isVisible()) {
    await page.locator('#leave-saved').click();
    assert(
      await page.locator('#start').evaluate((el) => document.activeElement === el),
      'Back to start did not restore the actual Start control focus',
    );
  }
  assert(
    (await page.locator('#idle-view').isVisible()) && (await page.locator('#start').isEnabled()),
    'Saved session cannot start again',
  );
  await idleWelcome(page, 'Daylight idle after Stop');
  await shot(page, 'daylight-welcome-hover');
  await page.locator('#idle-settings').click();
  await page.frameLocator('#settings-frame').locator('#overview-title').waitFor({ state: 'visible' });
  assert(!(await page.locator('footer').isVisible()), 'Idle Settings retains a lone Back footer');
  assert(await page.frameLocator('#settings-frame').locator('#settings-return').isVisible(), 'Idle Settings lost its in-content Back');
  assert(await page.frameLocator('#settings-frame').locator('#settings-return').evaluate((el) => !el.closest('footer')), 'Idle Settings Back is still in the footer');
  assert(await page.frameLocator('#settings-frame').locator('#settings-mimo-brand').isVisible(), 'Idle Settings lost its default Mimo portrait');
  await shot(page, 'daylight-idle-settings');
  await page.frameLocator('#settings-frame').locator('#settings-return').click();
  assert(await page.locator('#idle-view').isVisible(), 'Idle Settings Back lost welcome');
  await page.locator('#start').focus();
  await fit(page, 'Daylight idle after Stop');
  await shot(page, 'daylight-rest-after-stop');
  await page.evaluate(() => chrome.storage.local.set({ listenAssistantAppearance: 'Midnight' }));
  await idleWelcome(page, 'Midnight idle after Stop');
  await fit(page, 'Midnight idle after Stop');
  await shot(page, 'midnight-rest-after-stop');
  await page.setViewportSize({ width: 272, height: 700 });
  await idleWelcome(page, 'narrow welcome');
  await fit(page, 'narrow welcome');
  await shot(page, 'narrow-welcome-hover');
  await page.setViewportSize({ width: 420, height: 820 });
  const restored = await create(420, 820, undefined, true);
  assert(
    !(await restored.locator('#memo-bubble').isVisible()),
    'A restored closed snapshot opened its old contribution',
  );
  await restored.evaluate(() => window.publish('ASSISTANT_STATE', window.ai));
  assert(
    !(await restored.locator('#memo-bubble').isVisible()),
    'Repeating a restored snapshot opened old content',
  );
  await fit(restored, 'restored closed session');
  const switched = await create(420);
  await switched.evaluate((fixture) => {
    window.ai = fixture;
    const baseline = structuredClone(fixture);
    baseline.liveV2.activeId = null;
    baseline.liveV2.contributions = [];
    baseline.liveV2.decision = 'silent';
    window.publish('ASSISTANT_STATE', baseline);
    window.publish('ASSISTANT_STATE', window.ai);
  }, originalV2Fixture);
  await mode(switched, 'contribution', 'old session before deferred feedback');
  await switched.evaluate(() => (window.feedbackMode = 'deferred'));
  await useful(switched).click();
  await switched.waitForFunction(() => window.pendingFeedback.length === 1);
  await switched.evaluate(() => {
    window.ai = structuredClone(window.ai);
    window.ai.sessionId = 'changed-fixture';
    window.ai.liveV2.contributions = [];
    window.ai.liveV2.activeId = null;
    window.ai.liveV2.decision = 'silent';
    window.rec.session.id = 'changed-fixture';
    window.publish('STATE', window.rec);
    window.publish('ASSISTANT_STATE', window.ai);
  });
  await publishContribution(switched, 'new-session-interaction');
  await mode(switched, 'contribution', 'new session before old feedback resolves');
  await switched.evaluate(() => {
    window.feedbackMode = 'success';
    window.pendingFeedback.shift()();
  });
  await switched.waitForTimeout(1900);
  await mode(switched, 'contribution', 'late feedback from previous session');
  assert(
    (await switched
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === 'new-session-interaction',
    'Previous-session feedback replaced the new session contribution',
  );
  assert(
    (await switched.locator('#memo-companion').getAttribute('data-reaction')) !== 'useful',
    'Previous-session feedback acknowledged the new session',
  );
  const reduced = await create(272);
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await reduced.locator('#stop').focus();
  await reduced.evaluate((fixture) => {
    window.ai = fixture;
    const baseline = structuredClone(fixture);
    baseline.liveV2.activeId = null;
    baseline.liveV2.contributions = [];
    baseline.liveV2.decision = 'silent';
    window.publish('ASSISTANT_STATE', baseline);
    window.publish('ASSISTANT_STATE', window.ai);
  }, originalV2Fixture);
  await mode(reduced, 'contribution', 'reduced motion');
  assert(
    await reduced.locator('#stop').evaluate((el) => document.activeElement === el),
    'Reduced-motion contribution stole focus',
  );
  assert(
    !(await reduced
      .locator('#memo-companion')
      .evaluate((el) =>
        el
          .getAnimations({ subtree: true })
          .some((a) => a.playState === 'running' && Number(a.effect?.getTiming().duration) > 1),
      )),
    'Reduced motion still animates Mimo',
  );
  await fit(reduced, 'reduced-motion contribution');
  await shot(reduced, 'midnight-reduced-motion');
  await reduced.route('**/mimo/mimo-expressions.png', (route) => route.abort());
  await reduced.reload();
  await characterImage(reduced);
  assert(
    await reduced
      .locator('#memo-character img')
      .evaluate(
        (img) =>
          getComputedStyle(img).visibility !== 'hidden' && getComputedStyle(img).opacity !== '0',
      ),
    'Missing sprite sheet hid static artwork',
  );
  const short = await create(420);
  const ordinaryMemo =
    'Tim sedang menyamakan alur persetujuan sebelum rilis. Hasil QA akan dipakai untuk menentukan langkah berikutnya.';
  const ordinaryContribution =
    'Sebelum mengunci jadwal rilis, tentukan siapa yang memberi persetujuan akhir dan kapan hasil QA harus tersedia. Dengan begitu, tim punya titik pengecekan yang jelas ketika ada temuan baru.';
  await short.evaluate(
    ({ fixture, memo, contribution }) => {
      window.ai = structuredClone(fixture);
      window.ai.version++;
      window.ai.liveV2.memo.text = memo;
      window.ai.liveV2.contributions[0].body = contribution;
      window.ai.liveV2.contributions[0].title = 'Pastikan alur persetujuannya jelas';
      const baseline = structuredClone(window.ai);
      baseline.liveV2.activeId = null;
      baseline.liveV2.contributions = [];
      baseline.liveV2.decision = 'silent';
      window.publish('ASSISTANT_STATE', baseline);
      window.publish('ASSISTANT_STATE', window.ai);
    },
    { fixture: originalV2Fixture, memo: ordinaryMemo, contribution: ordinaryContribution },
  );
  for (const size of [
    { width: 420, height: 820 },
    { width: 272, height: 700 },
  ]) {
    await short.setViewportSize(size);
    await showBubble(short);
    await acceptedTextFits(
      short,
      'ordinary contribution ' + size.width,
      'contribution',
      ordinaryContribution,
    );
    await fusedSessionControls(short, 'ordinary ' + size.width + ' upper surface');
    if (size.width === 420) await shot(short, 'ordinary-upper-contribution');
    await short.locator('#memo-character').click();
    await mode(short, 'understanding', 'ordinary Mimo toggle ' + size.width);
    await acceptedTextFits(
      short,
      'ordinary understanding ' + size.width,
      'understanding',
      ordinaryMemo,
    );
    if (size.width === 272) await shot(short, 'ordinary-upper-understanding-narrow');
  }
  await short.setViewportSize({ width: 420, height: 820 });
  await short.evaluate(() => chrome.storage.local.set({ listenAssistantAppearance: 'Daylight' }));
  await short.waitForFunction(() => document.body.dataset.surface === 'Daylight');
  await showBubble(short);
  const sourceFocus = short.locator('#memo-bubble-content [data-contribution-source]');
  const focusTabs = await keyboardFocus(short, sourceFocus);
  const focusProof = await sourceFocus.evaluate((el) => {
    const style = getComputedStyle(el),
      r = el.getBoundingClientRect();
    return {
      outlineColor: style.outlineColor,
      outlineWidth: parseFloat(style.outlineWidth),
      focusVisible: el.matches(':focus-visible'),
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });
  const rgb = (focusProof.outlineColor.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const luminance = (values) =>
    values
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const outlineL = luminance(rgb),
    fieldL = luminance([70, 67, 206]);
  const focusRatio = (Math.max(outlineL, fieldL) + 0.05) / (Math.min(outlineL, fieldL) + 0.05);
  measurements.push({
    label: 'upper violet keyboard Sources focus',
    ...focusProof,
    keyboardTabs: focusTabs,
    ratio: focusRatio,
  });
  assert(
    rgb.length === 3 && focusProof.focusVisible && focusProof.outlineWidth >= 2 && focusRatio >= 3,
    'Violet reading surface lost a contrasting keyboard focus indicator: ' +
      JSON.stringify({ ...focusProof, ratio: focusRatio }),
  );
  await shot(short, 'upper-violet-keyboard-focus');
  await keyboardFocus(short, short.locator('#memo-character'));
  await shot(short, 'upper-mimo-seam-keyboard-focus');
  const transcriptHistory = await create(420);
  await transcriptHistory.locator('#open-transcript').click();
  await openHistory(transcriptHistory);
  await leaveHistory(transcriptHistory, 'transcript');
  assert(
    await transcriptHistory.locator('#transcript-view').isVisible(),
    'History Back through Settings lost the original Transcript view',
  );
  await transcriptHistory.close();
  const mascotSourceReturn = await create(420);
  await mascotSourceReturn.evaluate((fixture) => {
    window.ai = fixture;
    const baseline = structuredClone(fixture);
    baseline.liveV2.activeId = null;
    baseline.liveV2.contributions = [];
    baseline.liveV2.decision = 'silent';
    window.publish('ASSISTANT_STATE', baseline);
    window.publish('ASSISTANT_STATE', window.ai);
  }, originalV2Fixture);
  await mode(mascotSourceReturn, 'contribution', 'Source return via global Mimo');
  const sourcePinnedId = await mascotSourceReturn
    .locator('#memo-bubble-content [data-contribution-id]')
    .getAttribute('data-contribution-id');
  await mascotSourceReturn.locator('#memo-bubble-content [data-contribution-source]').click();
  await publishContribution(mascotSourceReturn, 'pending-global-mimo-return', {
    archivePrevious: true,
  });
  assert(!(await mascotSourceReturn.locator('#memo-companion').isVisible()), 'Mimo follows contextual Transcript');
  assert(await mascotSourceReturn.locator('#transcript-back').isVisible(), 'Contextual Source return is absent');
  await shot(mascotSourceReturn, 'contextual-transcript-source-return');
  await mascotSourceReturn.locator('#transcript-back').click();
  await mode(mascotSourceReturn, 'contribution', 'Source Back with pending candidate');
  assert(
    (await mascotSourceReturn
      .locator('#memo-bubble-content [data-contribution-id]')
      .getAttribute('data-contribution-id')) === sourcePinnedId,
    'Global Mimo Source return replaced the pinned contribution with a pending one',
  );
  await mascotSourceReturn.close();
  for (const view of ['transcript', 'settings', 'history']) {
    const cross = await create(420);
    if (view === 'transcript') await cross.locator('#open-transcript').click();
    else if (view === 'settings') await cross.locator('#settings').click();
    else await openHistory(cross);
    await fit(cross, 'live navigation from ' + view);
    assert(!(await cross.locator('#memo-companion').isVisible()), 'Live companion leaked into ' + view);
    assert(!(await cross.locator('#stop').isVisible()), 'Live-only Stop leaked into ' + view);
    assert(await cross.locator('footer').isVisible(), 'Active footer disappeared in ' + view);
    if (view === 'settings') {
      const settingsFrame = cross.frameLocator('#settings-frame');
      await settingsFrame.locator('#overview-title').waitFor({ state: 'visible' });
      await settingsFrame.locator('#settings-mimo-brand').waitFor({ state: 'visible' });
      await fixedSettingsNavigation(cross, 'Settings after navigation');
      await shot(cross, 'active-settings-default-portrait');
    }
    await cross.locator('#open-live').click();
    await fusedSessionControls(cross, 'Stop after returning from ' + view);
    await cross.locator('#stop').click();
    await cross.waitForFunction(() => window.rec.phase === 'stopping');
    assert(
      await cross.evaluate(() => window.calls.filter((type) => type === 'STOP').length === 1),
      'Real Stop after return from ' + view + ' was not dispatched once',
    );
    await cross.close();
  }
  const retained = await create(420);
  await retained.evaluate(() => {
    window.rec.phase = 'save-failed';
    window.rec.error = 'Synthetic download failure';
    window.publish('STATE', window.rec);
  });
  await retained.locator('#audio-recovery').waitFor({ state: 'visible' });
  assert(
    (await retained.locator('#retry-save').isVisible()) &&
      (await retained.locator('#retry-save').isEnabled()),
    'Retained audio lost its retry action after header removal',
  );
  await fit(retained, 'retained audio recovery');
  await shot(retained, 'retained-audio-recovery');
  await retained.locator('#retry-save').click();
  await retained.waitForFunction(() => window.rec.phase === 'saving');
  assert(
    await retained.evaluate(() => window.calls.filter((type) => type === 'RETRY').length === 1),
    'Retained audio Retry was not dispatched once',
  );
  await retained.close();
  assert(!errors.length, JSON.stringify(errors));
  assert(!blockedRequests.length, 'Unexpected remote requests: ' + blockedRequests.join(', '));
  await writeFile(
    path.join(captureDir, 'result.json'),
    JSON.stringify(
      {
        success: true,
        buildDir,
        providerRequests: 0,
        captures,
        captureMetadata,
        layoutProofs,
        totals: {
          assertions: assertionCount,
          captures: captures.length,
          pageErrors: errors.length,
          remoteRequests: blockedRequests.length,
        },
        measurements,
        checks: [
          'full main contribution mode and separate current understanding',
          'ambiguous opening gathers context',
          'processing retains accepted understanding',
          'minimal live surface',
          'PNG asset and correct MIME type',
          'new ID enters once without stealing focus',
          'Close Escape and Skip remain local',
          'same ID does not reopen',
          'character greeting never dispatches recording or provider actions',
          'pending contribution queues behind pinned focus node',
          'understanding update preserves contribution DOM focus scroll and coordinates',
          'answered corrected status and evidence',
          'empty evidence guards',
          'Sources returns exact mode and trigger with pending content, without a companion in Transcript',
          'History Sources returns History',
          'normal Transcript and Settings tab returns do not auto-open pending',
          'idle Settings is in the welcome, idle Settings Back is in-content, and no idle footer remains',
          'Start listening remains visible contrasted and reachable on hover in both themes and narrow view',
          'active Settings keeps its label and icon, stays open on selected-tab click, and uses its own Mimo portrait',
          'Useful save appreciation and timed return',
          'failed feedback stays open and retries',
          'late feedback after close reopen newer ID or session change does not acknowledge or close newer interaction',
          'More disclosure retains Not helpful and Dismiss',
          'Dismiss preserves understanding and history',
          'history pagination 25 50 55',
          'Midnight Daylight and 272px narrow',
          'native Chrome 200 percent zoom at 210 logical px',
          'native initial view shows actual title and at least three complete body lines',
          'native Settings readiness retains whole words and sufficient Microphone measure',
          'native Transcript label stays on one line inside its navigation button',
          'all visible functional text remains at least 11px excluding screen-reader-only text',
          'upper-seam Mimo with unboxed clock and icon-only Stop beneath it does not obscure reading text',
          'all three native navigation controls occupy one visible row with full11px labels',
          'native 18px pending badge stays above the character face',
          'contribution metadata is below text with deduplicated tags',
          '32px secondary and 44px primary targets',
          'long contribution scroll leaves Stop and footer reachable',
          'Stop returns understanding and blocks late automatic entry',
          'saved history and explicit Back to start after Stop',
          'History returns Settings, and stable footer tabs return Live or Transcript without a loop',
          'restored closed snapshot remains closed',
          'reduced motion and static artwork fallback',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Mimo live UI smoke passed.');
} catch (error) {
  const failure = {
    success:false, buildDir, providerRequests:0,
    error:error.message, stack:error.stack,
    totals:{assertions:assertionCount,captures:captures.length,pageErrors:errors.length,remoteRequests:blockedRequests.length},
    captures,captureMetadata,layoutProofs,measurements,errors,
  };
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({path:path.join(captureDir,'failure-state.png'),animations:'disabled'}).catch(()=>{});
    failure.failureCapture='failure-state.png';
  }
  await writeFile(path.join(captureDir,'initial-failure.json'),JSON.stringify(failure,null,2));
  await writeFile(path.join(captureDir,'result.json'),JSON.stringify(failure,null,2));
  throw error;
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
