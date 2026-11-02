// Synthetic states; no audio, model download, or provider requests.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const buildDir = process.env.LISTEN_UI_BUILD_DIR || 'dist';
const captureDir = process.env.LISTEN_UI_ARTIFACT_DIR || '.impeccable/review/popup-settings';
const reportDir = process.env.LISTEN_UI_ARTIFACT_DIR || 'artifacts';
await Promise.all([mkdir(captureDir, { recursive: true }), mkdir(reportDir, { recursive: true })]);
let assertionCount = 0;
const assert = (value, message) => {
  assertionCount++;
  if (!value) throw Error(message);
};
const buildRoot = path.resolve(buildDir);
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const f = path.resolve(buildRoot, '.' + (pathname === '/' ? '/popup.html' : pathname));
    const relative = path.relative(buildRoot, f);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.setHeader(
      'Content-Type',
      f.endsWith('.js')
        ? 'text/javascript'
        : f.endsWith('.css')
          ? 'text/css'
          : f.endsWith('.png')
            ? 'image/png'
            : 'text/html',
    );
    res.end(await readFile(f));
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
const captures = [];
const captureMetadata = [];
const layoutProofs = [];
const blockedRequests = [];
const restrictNetwork = (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol))
    return route.continue();
  blockedRequests.push(url.origin);
  return route.abort();
};
async function create(theme = 'Daylight') {
  const p = await browser.newPage({ viewport: { width: 320, height: 650 } });
  await p.clock.install();
  p.setDefaultTimeout(5000);
  await p.route('**/*', restrictNetwork);
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((theme) => {
    window.calls = [];
    window.listeners = [];
    window.storageListeners = [];
    window.local = { microphoneReady: true, listenAssistantAppearance: theme };
    window.current = { phase: 'idle', retained: [] };
    window.mockClosed = false;
    window.close = () => (window.mockClosed = true);
    window.publish = (s) => {
      window.current = s;
      window.listeners.forEach((fn) =>
        fn({ target: 'ui', type: 'STATE', status: s }, { id: 'test' }),
      );
    };
    window.publishModel = (phase) =>
      window.listeners.forEach((fn) =>
        fn(
          {
            target: 'ui',
            type: 'TRANSCRIPT_STATE',
            snapshot: {
              phase,
              modelReady: phase === 'ready',
              segments: [],
              incomplete: false,
              lagMs: 0,
            },
          },
          { id: 'test' },
        ),
      );
    window.chrome = {
      tabs: {
        query: async () => [
          { id: 7, windowId: 1, title: 'Product planning', url: 'https://example.com' },
        ],
      },
      sidePanel: { open: async () => window.calls.push('OPEN_PANEL') },
      storage: {
        local: {
          get: async (key) => ({ [key]: window.local[key] }),
          set: async (values) => {
            Object.assign(window.local, values);
            window.storageListeners.forEach((fn) =>
              fn(
                Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])),
                'local',
              ),
            );
          },
        },
        session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
        onChanged: { addListener: (fn) => window.storageListeners.push(fn) },
      },
      runtime: {
        id: 'test',
        onMessage: { addListener: (fn) => window.listeners.push(fn) },
        sendMessage: async (msg) => {
          window.calls.push(msg.type);
          if (msg.type === 'TRANSCRIPT_STATUS')
            return {
              ok: true,
              value: {
                phase: 'ready',
                modelReady: true,
                segments: [],
                incomplete: false,
                lagMs: 0,
              },
            };
          if (msg.type === 'START')
            window.current = {
              phase: 'recording',
              session: { id: 'test', sourceTitle: 'Product planning', durationMs: 134000 },
              retained: [],
            };
          if (msg.type === 'STOP') window.current = { ...window.current, phase: 'saving' };
          if (msg.type === 'RETRY') window.current = { phase: 'saving', retained: [] };
          return { ok: true, value: window.current };
        },
      },
    };
  }, theme);
  await p.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await p.waitForFunction(() => !document.getElementById('main-action').disabled);
  return p;
}
async function portrait(p) {
  assert(await p.locator('#memo-greeting').isVisible(), 'Mimo greeting is hidden');
  assert(
    await p.locator('#memo-greeting img').evaluate((img) => img.complete && img.naturalWidth > 0),
    'Mimo fallback portrait failed',
  );
  const bounds = await p.locator('#memo-greeting').boundingBox();
  assert(bounds.width >= 44 && bounds.height >= 44, 'Mimo greeting target is smaller than 44px');
}
async function fit(p) {
  const m = await p.evaluate(() => ({
    w: innerWidth,
    scroll: document.documentElement.scrollWidth,
    footer: document.querySelector('footer').getBoundingClientRect().right,
  }));
  layoutProofs.push(m);
  assert(m.scroll <= m.w && m.footer <= m.w, 'Popup overflows');
}
async function shot(p, name) {
  await p.evaluate(() => document.fonts.ready);
  await fit(p);
  await portrait(p);
  if (process.env.LISTEN_CAPTURE === '0') return;
  captures.push(`${name}.png`);
  await p
    .locator('body')
    .screenshot({ path: path.join(captureDir, `${name}.png`), animations: 'disabled' });
  const png = await readFile(path.join(captureDir, `${name}.png`));
  captureMetadata.push({
    filename: `${name}.png`,
    pngWidth: png.readUInt32BE(16),
    pngHeight: png.readUInt32BE(20),
    ...(await p.evaluate(() => ({
      logicalWidth: innerWidth,
      logicalHeight: innerHeight,
      fontsStatus: document.fonts.status,
      scrollWidth: document.documentElement.scrollWidth,
      surface: document.body.dataset.surface,
    }))),
  });
}
try {
  const p = await create();
  assert((await p.title()) === 'Mimo', 'Popup title has stale branding');
  assert(
    (await p.locator('.wordmark').innerText()).trim() === 'Mimo',
    'Popup wordmark has stale branding',
  );
  assert(
    await p
      .locator('#memo-greeting img')
      .evaluate(
        (img) =>
          img.complete &&
          img.naturalWidth > 0 &&
          new URL(img.currentSrc).pathname.endsWith('/memo/memo-slime.png'),
      ),
    'Popup Mimo image did not load from its nested PNG asset',
  );
  const callsBeforeGreeting = await p.evaluate(() => window.calls.length);
  await p.locator('#memo-greeting').hover();
  await p.mouse.down();
  assert(
    (await p.locator('#memo-greeting').getAttribute('data-mimo-pressed')) === 'true',
    'Pointer press does not react',
  );
  await p.mouse.up();
  assert(
    (await p.locator('#memo-message').innerText()).includes('Mimo'),
    'Character tap did not show its greeting',
  );
  assert(
    await p.evaluate(
      (count) => window.calls.length === count && window.current.phase === 'idle',
      callsBeforeGreeting,
    ),
    'Character greeting dispatched a recording action',
  );
  assert(await p.locator('#main-action').isVisible(), 'Greeting hid the separate recording action');
  assert(
    await p.locator('#main-action').isEnabled(),
    'Greeting disabled the separate recording action',
  );
  await shot(p, 'popup-daylight-idle');
  await p.locator('#main-action').click();
  await p.locator('#stop').waitFor({ state: 'visible' });
  assert(!(await p.locator('#main-action').isVisible()), 'Listen still shown while recording');
  assert(await p.locator('#open-assistant').isVisible(), 'No Open notes');
  await p.clock.runFor(1000);
  const elapsedBefore = await p.locator('#timer').textContent();
  await p.evaluate(() => window.publishModel('transcribing'));
  await p.clock.runFor(2000);
  const elapsedAfter = await p.locator('#timer').textContent();
  const seconds = (value) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  assert(
    seconds(elapsedAfter) - seconds(elapsedBefore) >= 2,
    'Transcript update reset the recording timer',
  );
  const liveCalls = await p.evaluate(() => window.calls.length);
  await p.locator('#memo-greeting').click();
  assert(
    await p.evaluate((count) => window.calls.length === count, liveCalls),
    'Live greeting dispatched an action',
  );
  await portrait(p);
  await shot(p, 'popup-daylight-recording');
  await p.locator('#stop').click();
  assert(
    (await p.evaluate(() => window.calls.filter((x) => x === 'STOP').length)) === 1,
    'Stop not sent once',
  );
  assert(!(await p.locator('#stop').isVisible()), 'Duplicate Stop visible');
  await shot(p, 'popup-saving');
  await p.evaluate(() =>
    window.publish({
      phase: 'save-failed',
      retained: [],
      session: {
        id: 'retained',
        sourceTitle: 'Product planning',
        createdAt: Date.now(),
        bytes: 3000000,
        status: 'retained',
        durationMs: 134000,
        error: 'Download unavailable. Retry saving.',
      },
    }),
  );
  await p.locator('#retained button').first().click();
  assert((await p.evaluate(() => window.calls)).includes('RETRY'), 'Retry did not dispatch');
  await p.evaluate(() => {
    window.publish({ phase: 'idle', retained: [] });
    window.publishModel('loading');
  });
  assert(await p.locator('#main-action').isDisabled(), 'Preparation allows start');
  assert(
    (await p.locator('#state').textContent()).includes('Preparing'),
    'Preparation status missing',
  );
  await shot(p, 'popup-preparing');
  await p.evaluate(() => window.publishModel('ready'));
  await p.waitForFunction(() => !document.getElementById('main-action').disabled);
  await p.evaluate(() => chrome.storage.local.set({ listenAssistantAppearance: 'Midnight' }));
  assert(
    (await p.locator('body').getAttribute('data-surface')) === 'Midnight',
    'Shared appearance ignored',
  );
  await shot(p, 'popup-midnight-idle');
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.locator('#memo-greeting').click();
  const movingGreeting = await p
    .locator('#memo-greeting')
    .evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1,
        ),
    );
  assert(!movingGreeting, 'Reduced motion still animates the popup greeting');
  await shot(p, 'popup-midnight-reduced-motion');
  await p.evaluate(() =>
    window.publish({
      phase: 'recording',
      retained: [],
      session: {
        id: 'live',
        durationMs: 134000,
        sourceTitle: 'A longer meeting title that must wrap without hiding any recording controls',
      },
    }),
  );
  await shot(p, 'popup-midnight-recording');
  await p.locator('#open-assistant').click();
  assert(
    await p.evaluate(() => window.mockClosed),
    'Open notes did not close popup after opening panel',
  );
  const settings = await create('Midnight');
  await settings.locator('#settings').click();
  assert(await settings.evaluate(() => window.mockClosed), 'Settings did not open panel');
  assert(!errors.length, 'Page errors: ' + errors.join(','));
  assert(!blockedRequests.length, 'Unexpected remote requests: ' + blockedRequests.join(','));
  const report = {
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
    popupStates: true,
    iconStop: true,
    opensNotes: true,
    opensSettings: true,
    saveRecovery: true,
    preparationGuard: true,
    sharedAppearance: true,
    mimoBrandAndCharacterAsset: true,
    greetingDoesNotStartRecording: true,
    reducedMotionGreeting: true,
    pageErrors: errors,
  };
  await writeFile(path.join(reportDir, 'popup-ui-smoke.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
