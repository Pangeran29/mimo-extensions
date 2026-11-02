// Settings UX checks with browser/API mocks; never downloads a model or sends an API key.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const buildDir = process.env.LISTEN_UI_BUILD_DIR || 'dist';
const artifactPath = (original) =>
  process.env.LISTEN_UI_ARTIFACT_DIR
    ? path.join(process.env.LISTEN_UI_ARTIFACT_DIR, path.basename(original))
    : original;
const buildRoot = path.resolve(buildDir);
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(buildRoot, '.' + (pathname === '/' ? '/setup.html' : pathname));
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
const url = `http://127.0.0.1:${server.address().port}/setup.html`;
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
const headingProofs = [];
const blockedRequests = [];
const restrictNetwork = (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol))
    return route.continue();
  blockedRequests.push(url.origin);
  return route.abort();
};
await Promise.all([
  mkdir(process.env.LISTEN_UI_ARTIFACT_DIR || 'artifacts', { recursive: true }),
  ...(process.env.LISTEN_UI_ARTIFACT_DIR
    ? []
    : [mkdir('.impeccable/review/popup-settings', { recursive: true })]),
]);
async function page(width, height = 900, panel = true, ready = false, theme = 'Automatic') {
  const p = await browser.newPage({ viewport: { width, height } });
  await p.route('**/*', restrictNetwork);
  p.on('pageerror', (error) => errors.push(error.message));
  await p.addInitScript(
    ({ ready, theme }) => {
      window.mock = {
        hasKey: ready,
        failLoad: false,
        failSave: false,
        allow: true,
        mic: 'granted',
        saves: 0,
        stops: 0,
        resolveModel: null,
        settings: { enabled: ready, model: 'gpt-6-luna', goal: '', benchmarkPassed: false },
      };
      const listeners = [];
      window.publish = (s) =>
        listeners.forEach((fn) =>
          fn({ target: 'ui', type: 'TRANSCRIPT_STATE', snapshot: s }, { id: 'test' }),
        );
      Object.defineProperty(navigator, 'permissions', {
        value: { query: async () => ({ state: ready ? 'granted' : 'prompt', onchange: null }) },
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: async () => {
            if (window.mock.mic === 'denied') throw new DOMException('Blocked', 'NotAllowedError');
            return { getTracks: () => [{ stop: () => window.mock.stops++ }] };
          },
        },
      });
      window.chrome = {
        windows: { getCurrent: async () => ({ id: 1 }) },
        tabs: {
          query: async () => [{ id: 1, windowId: 1, title: 'Meeting', url: 'https://example.com' }],
        },
        sidePanel: { open: async () => {} },
        permissions: { request: async () => window.mock.allow },
        storage: {
          local: {
            get: async () => ({
              microphoneReady: ready,
              listenAssistantAppearance: theme,
              listenAgentDiagnosticsEnabled: window.mock.agentDiagnostics === true,
            }),
            set: async (value) => {
              if ('listenAgentDiagnosticsEnabled' in value)
                window.mock.agentDiagnostics = value.listenAgentDiagnosticsEnabled;
            },
          },
          session: { set: async () => {}, get: async () => ({}), remove: async () => {} },
          onChanged: { addListener: () => {} },
        },
        runtime: {
          id: 'test',
          getManifest: () => ({ name: 'Mimo', version: '0.11.0' }),
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: async (msg) => {
            if (msg.type === 'STATUS') return { ok: true, value: { phase: 'idle', retained: [] } };
            if (msg.type === 'ASSISTANT_STATUS')
              return {
                ok: true,
                value: {
                  phase: 'ready',
                  model: 'claude-sonnet-5-5',
                  lastFailure: window.mock.lastFailure,
                  version: 0,
                  summary: '',
                  summaries: [],
                  memory: [],
                  question: null,
                  history: [],
                  deeperBusy: false,
                },
              };
            if (msg.type === 'ASSISTANT_SETTINGS' && window.mock.failLoad)
              return { ok: false, error: 'Unavailable' };
            if (msg.type === 'ASSISTANT_SETTINGS')
              return {
                ok: true,
                value: {
                  settings: window.mock.settings,
                  hasKey: window.mock.hasKey,
                  configured: true,
                  hasAccess: window.mock.allow,
                },
              };
            if (msg.type === 'TRANSCRIPT_STATUS')
              return {
                ok: true,
                value: {
                  phase: ready ? 'ready' : 'unavailable',
                  modelReady: ready,
                  segments: [],
                  lagMs: 0,
                  incomplete: false,
                },
              };
            if (msg.type === 'PREPARE_TRANSCRIPTION')
              return new Promise((resolve) => {
                window.mock.resolveModel = resolve;
              });
            if (msg.type === 'ASSISTANT_CONFIGURE' || msg.type === 'ASSISTANT_DEFAULTS') {
              window.mock.saves++;
              await new Promise((r) => setTimeout(r, 150));
              if (window.mock.failSave)
                return { ok: false, error: 'Could not save. Check HPOP access and try again.' };
              window.mock.hasKey = msg.clearKey ? false : !!msg.apiKey || window.mock.hasKey;
              window.mock.settings =
                msg.type === 'ASSISTANT_DEFAULTS'
                  ? { ...window.mock.settings, goal: msg.goal.trim() }
                  : msg.settings;
              return {
                ok: true,
                value: {
                  settings: window.mock.settings,
                  hasKey: window.mock.hasKey,
                  hasAccess: window.mock.allow,
                },
              };
            }
          },
        },
      };
    },
    { ready, theme },
  );
  await p.goto(url + (panel ? '?panel=1' : ''));
  await p.waitForFunction(() => !document.getElementById('ai-fields').disabled);
  await p.waitForFunction(
    () => !document.getElementById('readiness').textContent.includes('Checking'),
  );
  return p;
}
let assertionCount = 0;
const assert = (condition, message) => {
  assertionCount++;
  if (!condition) throw Error(message);
};
async function portrait(p, label) {
  const greeting = p.locator('#settings-mimo-greeting');
  assert(await greeting.isVisible(), label + ': settings portrait hidden');
  assert(
    await greeting.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0),
    label + ': fallback portrait failed',
  );
  const bounds = await greeting.boundingBox();
  assert(bounds.width >= 44 && bounds.height >= 44, label + ': greeting target smaller than 44px');
  const proof = await greeting.evaluate((button) => {
    const doc = button.ownerDocument;
    const host = button.closest('.settings-hero, .settings-detail-heading');
    const heading = host.querySelector('h1');
    const container = button.closest('#overview, #detail');
    const bounds = (rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
    const range = doc.createRange();
    range.selectNodeContents(heading);
    const titleFragments = [...range.getClientRects()]
      .filter((r) => r.height > 0 && r.width > 0)
      .map(bounds);
    const portrait = bounds(button.getBoundingClientRect());
    const header = bounds(host.getBoundingClientRect());
    const overlapArea = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const functionalFonts = [];
    for (const control of doc.querySelectorAll('button, summary, a, input, select, textarea')) {
      const rect = control.getBoundingClientRect();
      if (
        control.closest('[hidden], .sr-only, [aria-hidden="true"]') ||
        !control.getClientRects().length ||
        rect.bottom <= 0 ||
        rect.top >= innerHeight
      )
        continue;
      if (
        control.checkVisibility &&
        !control.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        continue;
      const details = control.closest('details:not([open])');
      if (details && !details.querySelector(':scope > summary')?.contains(control)) continue;
      const walker = doc.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let hasVisibleText = false;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!node.textContent.trim() || parent.closest('.sr-only, svg, [aria-hidden="true"]'))
          continue;
        const textRange = doc.createRange();
        textRange.selectNodeContents(node);
        if (![...textRange.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue;
        functionalFonts.push({
          id: control.id,
          text: node.textContent.trim().slice(0, 60),
          fontSize: parseFloat(getComputedStyle(parent).fontSize),
        });
        hasVisibleText = true;
      }
      if (!hasVisibleText && ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName))
        functionalFonts.push({
          id: control.id,
          text: control.tagName.toLowerCase(),
          fontSize: parseFloat(getComputedStyle(control).fontSize),
        });
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rootZoom: Number(getComputedStyle(doc.documentElement).zoom),
      bodyZoom: Number(getComputedStyle(doc.body).zoom),
      containerId: container.id,
      containerInlineSize: container.clientWidth,
      containerVisualWidth: container.getBoundingClientRect().width,
      containerName: getComputedStyle(container).containerName,
      title: heading.textContent,
      titleFragments,
      portrait,
      header,
      titlePortraitOverlapAreas: titleFragments.map((r) => overlapArea(r, portrait)),
      functionalTextCount: functionalFonts.length,
      minimumFunctionalFontSize: Math.min(...functionalFonts.map((item) => item.fontSize)),
      functionalFontViolations: functionalFonts.filter((item) => item.fontSize < 10.99),
    };
  });
  headingProofs.push({ label, ...proof });
  assert(
    proof.titleFragments.length > 0 && proof.titlePortraitOverlapAreas.every((area) => area === 0),
    label + ': heading text overlaps portrait: ' + JSON.stringify(proof),
  );
  assert(
    proof.titleFragments.every(
      (r) =>
        r.left >= proof.header.left - 1 &&
        r.right <= proof.header.right + 1 &&
        r.top >= proof.header.top - 1 &&
        r.bottom <= proof.header.bottom + 1,
    ),
    label + ': heading text escapes its header: ' + JSON.stringify(proof),
  );
  assert(
    proof.functionalTextCount > 0 && proof.functionalFontViolations.length === 0,
    label + ': functional text below 11px: ' + JSON.stringify(proof),
  );
}
async function fits(p, label) {
  if (await p.locator('#settings-mimo-greeting').count()) await portrait(p, label);
  const result = await p.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  layoutProofs.push({ label, ...result });
  if (result.scroll > result.viewport) {
    console.log(
      await p.evaluate(() =>
        [...document.querySelectorAll('*')]
          .map((el) => ({ id: el.id, tag: el.tagName, right: el.getBoundingClientRect().right }))
          .filter((el) => el.right > innerWidth),
      ),
    );
    await screenshot(p, {
      animations: 'disabled',
      path: artifactPath('artifacts/settings-overflow.png'),
      fullPage: true,
    });
  }
  assert(result.scroll <= result.viewport, `${label} overflows: ${JSON.stringify(result)}`);
}
async function screenshot(p, options) {
  if (process.env.LISTEN_CAPTURE === '0') return;
  await p.evaluate(() => document.fonts.ready);
  const captureLabel = path.basename(options.path);
  if (await p.locator('#settings-mimo-greeting').count())
    await portrait(p, 'capture ' + captureLabel);
  else if (await p.locator('#settings-frame').count())
    await portrait(p.frameLocator('#settings-frame'), 'capture iframe ' + captureLabel);
  await p.screenshot(options);
  const filename = path.basename(options.path);
  captures.push(filename);
  const png = await readFile(options.path);
  captureMetadata.push({
    filename,
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
  const narrow = await page(272, 850);
  assert((await narrow.title()) === 'Mimo settings', 'Settings title has stale branding');
  assert(
    (await narrow.locator('.memo-brand').innerText()).trim() === 'Mimo',
    'Settings brand has stale branding',
  );
  await fits(narrow, '272px overview');
  const savesBeforeGreeting = await narrow.evaluate(() => window.mock.saves);
  await narrow.locator('#settings-mimo-greeting').click();
  assert(
    (await narrow.locator('#settings-mimo-message').innerText()).includes('right here'),
    'Settings greeting did not respond',
  );
  assert(
    await narrow.evaluate((saves) => window.mock.saves === saves, savesBeforeGreeting),
    'Greeting saved settings',
  );
  await screenshot(narrow, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-narrow.png'),
    fullPage: true,
  });
  assert(await narrow.locator('#overview-title').isVisible(), 'Settings title missing');
  assert(!(await narrow.locator('#ai-form').isVisible()), 'AI fields leaked into overview');
  await narrow.locator('#open-ai').click();
  await fits(narrow, '272px editor');
  assert(
    (await narrow.locator('#detail-title').textContent()) === 'AI connection',
    'Navigation failed',
  );
  assert(
    await narrow.locator('#detail-title').evaluate((el) => document.activeElement === el),
    'Detail focus missing',
  );
  await narrow.locator('#ai-save').click();
  await portrait(narrow, 'key validation');
  assert(
    (await narrow.locator('#ai-key').getAttribute('aria-invalid')) === 'true',
    'Missing key validation',
  );
  assert(
    (await narrow.locator('#ai-form select').count()) === 1,
    'AI connection must expose only the provider selector',
  );
  await narrow.locator('#ai-key').fill('synthetic-test-key');
  await narrow.locator('#back').click();
  assert(
    await narrow.locator('#open-ai').evaluate((el) => document.activeElement === el),
    'Back focus missing',
  );
  await narrow.locator('#open-ai').click();
  assert(
    (await narrow.locator('#ai-key').inputValue()) === 'synthetic-test-key',
    'Navigation lost draft',
  );
  await narrow.locator('#ai-reset').click();
  assert((await narrow.locator('#ai-key').inputValue()) === '', 'Reset did not clear draft');
  await screenshot(narrow, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-editor-narrow.png'),
    fullPage: true,
  });

  const desktop = await page(1100, 900, false);
  await fits(desktop, 'options tab');
  await screenshot(desktop, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-install.png'),
    fullPage: true,
  });
  const readyDesktop = await page(1100, 800, false, true, 'Daylight');
  await fits(readyDesktop, 'ready options tab');
  await screenshot(readyDesktop, {
    animations: 'disabled',
    path: artifactPath('.impeccable/review/popup-settings/settings-daylight-ready.png'),
    fullPage: true,
  });
  const readyNarrow = await page(340, 760, false, true, 'Midnight');
  await fits(readyNarrow, 'midnight options tab');
  await screenshot(readyNarrow, {
    animations: 'disabled',
    path: artifactPath('.impeccable/review/popup-settings/settings-midnight-ready.png'),
    fullPage: true,
  });
  await readyNarrow.locator('#open-transcription').click();
  await readyNarrow.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert(
    await readyNarrow.locator('#finish').isVisible(),
    'Standalone transcription detail lost notes navigation',
  );
  await screenshot(readyNarrow, {
    animations: 'disabled',
    path: artifactPath('.impeccable/review/popup-settings/settings-transcription-ready.png'),
    fullPage: false,
  });
  await readyNarrow.locator('#back').click();
  await readyNarrow.locator('#open-ai').click();
  await readyNarrow.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert(
    await readyNarrow.locator('#finish').isVisible(),
    'Standalone AI detail lost notes navigation',
  );
  await screenshot(readyNarrow, {
    animations: 'disabled',
    path: artifactPath('.impeccable/review/popup-settings/settings-midnight-ai.png'),
    fullPage: false,
  });
  const p = await page(360, 800);
  await p.locator('#open-microphone').click();
  await p.evaluate(() => (window.mock.mic = 'denied'));
  await p.locator('#grant').click();
  assert((await p.locator('#result').getAttribute('data-state')) === 'error', 'Mic denial missing');
  assert((await p.locator('#mic-help').getAttribute('open')) !== null, 'Mic recovery missing');
  await p.evaluate(() => (window.mock.mic = 'granted'));
  await p.locator('#grant').click();
  assert((await p.locator('#mic-state').textContent()) === 'Allowed', 'Mic status missing');
  assert((await p.evaluate(() => window.mock.stops)) === 1, 'Mic tracks not released');
  await p.locator('#back').click();
  await p.locator('#open-transcription').click();
  await p.locator('#prepare-transcription').click();
  assert(await p.locator('#prepare-transcription').isDisabled(), 'Preparation duplicate guard');
  await p.evaluate(() =>
    window.publish({
      phase: 'loading',
      modelReady: false,
      segments: [],
      lagMs: 0,
      incomplete: false,
      message: 'Downloading model: encoder.onnx 42%',
    }),
  );
  assert(
    (await p.locator('#model-progress').getAttribute('value')) === '42',
    'File progress discarded',
  );
  assert(
    (await p.locator('#transcription-result').textContent()).includes('encoder.onnx 42%'),
    'Progress message discarded',
  );
  await p.evaluate(() =>
    window.mock.resolveModel({ ok: false, error: 'Download unavailable. Try again.' }),
  );
  await p.waitForFunction(
    () =>
      document.getElementById('prepare-transcription').getAttribute('aria-label') ===
      'Retry transcription',
  );
  await p.locator('#prepare-transcription').click();
  await p.evaluate(() =>
    window.mock.resolveModel({
      ok: true,
      value: { phase: 'ready', modelReady: true, segments: [], incomplete: false, lagMs: 0 },
    }),
  );
  await p.waitForFunction(() => document.getElementById('model-state').textContent === 'Ready');
  await p.locator('#back').click();
  assert(
    (await p.locator('#readiness').textContent()) === 'AI connection needed to start.',
    'Incorrect readiness',
  );
  await screenshot(p, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-overview.png'),
    fullPage: true,
  });
  await p.locator('#open-ai').click();
  await screenshot(p, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-connection.png'),
    fullPage: true,
  });
  await p.locator('#ai-key').fill('synthetic-test-key');
  await p.locator('#ai-key-toggle').click();
  assert((await p.locator('#ai-key').getAttribute('type')) === 'text', 'Key show failed');
  await p.locator('#ai-key-toggle').click();
  await p.evaluate(() => (window.mock.allow = false));
  await p.locator('#ai-save').click();
  await p.waitForFunction(() =>
    document.getElementById('ai-result').textContent.includes('not allowed'),
  );
  assert(
    (await p.locator('#ai-key').inputValue()) === 'synthetic-test-key',
    'Permission failure lost input',
  );
  await p.evaluate(() => {
    window.mock.allow = true;
    window.mock.failSave = true;
  });
  await p.locator('#ai-save').click();
  await p.waitForFunction(() =>
    document.getElementById('ai-result').textContent.includes('Could not save'),
  );
  await portrait(p, 'connection failure');
  await screenshot(p, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-save-error.png'),
    fullPage: true,
  });
  assert(
    (await p.locator('#ai-key').inputValue()) === 'synthetic-test-key',
    'Save failure lost input',
  );
  await p.evaluate(() => (window.mock.failSave = false));
  await p.locator('#ai-save').evaluate((el) => {
    el.click();
    el.click();
  });
  await p.waitForFunction(() =>
    document.getElementById('ai-result').textContent.includes('Connection saved'),
  );
  assert((await p.evaluate(() => window.mock.saves)) === 2, 'Duplicate submission sent');
  assert((await p.locator('#ai-key').inputValue()) === '', 'Saved key not cleared');
  await portrait(p, 'connection saved');
  assert(
    (await p.locator('#ai-state').textContent()) === 'Configured',
    'Connection overpromises status',
  );
  await p.locator('#back').click();
  await p.locator('#open-defaults').click();
  await p.locator('#ai-goal').fill('Agree on scope and owner.');
  await p.locator('#defaults-save').click();
  await p.waitForFunction(
    () => document.getElementById('defaults-result').textContent === 'Defaults saved.',
  );
  assert((await p.evaluate(() => window.mock.settings.enabled)) === true, 'Defaults disabled AI');
  await p.locator('#back').click();
  await p.locator('#open-ai').click();
  await p.locator('#key-management > summary').click();
  await p.locator('#ai-clear').click();
  assert(
    (await p.evaluate(() => window.mock.hasKey)) === true,
    'Removal happened before confirmation',
  );
  await p.locator('#cancel-remove').click();
  await p.locator('#ai-clear').click();
  await p.locator('#confirm-remove').click();
  await p.waitForFunction(() =>
    document.getElementById('ai-result').textContent.includes('Key removed'),
  );
  assert((await p.locator('#ai-state').textContent()) === 'Add key', 'Removal status missing');
  await narrow.evaluate(() => (document.documentElement.style.zoom = '2'));
  await fits(narrow, '200 percent CSS zoom');
  await screenshot(narrow, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-zoom.png'),
    fullPage: true,
  });
  const host = await page(360, 800);
  await host.goto(url.replace('setup.html', 'assistant.html'));
  await host.locator('#settings').click();
  const frame = host.frameLocator('#settings-frame');
  await frame.locator('#overview-title').waitFor({ state: 'visible' });
  await portrait(frame, 'actual assistant settings iframe');
  await fits(host, 'actual assistant host');
  await frame.locator('#open-ai').click();
  await frame.locator('#ai-key').fill('synthetic-host-draft');
  await host.locator('#settings').click();
  assert(
    await host.locator('#start').evaluate((el) => document.activeElement === el),
    'Host return focus missing',
  );
  await host.locator('#settings').click();
  assert(
    (await frame.locator('#ai-key').inputValue()) === 'synthetic-host-draft',
    'Host switch lost draft',
  );
  await screenshot(host, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-redesign-host.png'),
    fullPage: true,
  });
  const failure = await page(360);
  await failure.addInitScript(() => {
    window.mock.failLoad = true;
  });
  await failure.reload();
  await failure.waitForFunction(
    () => document.getElementById('ai-state').textContent === 'Unavailable',
  );
  await failure.locator('#open-ai').click();
  assert(await failure.locator('#ai-reload').isVisible(), 'Load failure retry hidden');
  assert(await failure.locator('#ai-key').isDisabled(), 'Load failure left editable fields');
  await failure.evaluate(() => {
    window.mock.failLoad = false;
  });
  await failure.locator('#ai-reload').click();
  await failure.waitForFunction(() => !document.getElementById('ai-fields').disabled);
  if (await narrow.locator('#back').isVisible()) await narrow.locator('#back').click();
  await narrow.evaluate(() => {
    window.mock.lastFailure = {
      at: 1,
      requestId: 'synthetic',
      status: 0,
      category: 'format',
      reason: 'schema_mismatch',
      count: 3,
      validationIssues: [
        {
          field: 'summary',
          code: 'too_big',
          limit: 2400,
          size: 2800,
          input: 'synthetic-secret-input',
        },
      ],
    };
  });
  await narrow.locator('#open-privacy').click();
  assert(
    !(await narrow.locator('#agent-diagnostics-enabled').isChecked()),
    'Agent capture should default off',
  );
  await narrow.locator('#agent-diagnostics-enabled').check();
  await narrow.waitForFunction(() => window.mock.agentDiagnostics === true);
  assert(
    (await narrow.locator('#agent-diagnostics-result').textContent()).includes('next meeting'),
    'Capture scope unclear',
  );
  const diagnosticDownload = narrow.waitForEvent('download');
  await narrow.locator('#download-diagnostics').click();
  const downloaded = await diagnosticDownload;
  const reportText = await readFile(await downloaded.path(), 'utf8');
  const diagnostic = JSON.parse(reportText);
  assert(
    diagnostic.assistant.lastFailure.validationIssues[0].field === 'summary',
    'Failure field missing from diagnostic download',
  );
  assert(diagnostic.loadedBuild !== 'development', 'Packaged build identifier missing');
  assert(!reportText.includes('synthetic-secret-input'), 'Private validation input entered report');
  assert(await narrow.locator('#diagnostics-preview').isVisible(), 'Diagnostic preview missing');
  await fits(narrow, '272px diagnostic preview');
  const diagnosticHeadingProof = headingProofs.at(-1);
  assert(
    diagnosticHeadingProof.title === 'Privacy & help' &&
      diagnosticHeadingProof.rootZoom * diagnosticHeadingProof.bodyZoom === 2 &&
      diagnosticHeadingProof.containerInlineSize <= 240 &&
      diagnosticHeadingProof.containerName === 'mimo-settings',
    'Diagnostic stress case did not exercise its narrow CSS200 container: ' +
      JSON.stringify(diagnosticHeadingProof),
  );
  await screenshot(narrow, {
    animations: 'disabled',
    path: artifactPath('artifacts/settings-diagnostics.png'),
    fullPage: true,
  });
  const providers = await page(360, 900, true, true);
  await providers.locator('#open-ai').click();
  await providers.locator('#ai-provider').selectOption('deepinfra');
  assert(
    !(await providers.locator('#hpop-connection').isVisible()),
    'Managed provider still asks for an HPOP key',
  );
  assert(
    await providers.locator('#managed-notes-info').isVisible(),
    'Managed provider explanation missing',
  );
  await providers.locator('#ai-save').click();
  await providers.waitForFunction(() => !document.getElementById('ai-fields').disabled);
  assert(
    (await providers.locator('#ai-provider').inputValue()) === 'deepinfra',
    'Provider choice was not retained',
  );
  await providers.locator('#ai-provider').selectOption('hpop');
  assert(await providers.locator('#hpop-connection').isVisible(), 'HPOP controls did not return');
  await fits(providers, '360px provider selector');
  assert(!errors.length, 'Page errors: ' + errors.join(', '));
  assert(!blockedRequests.length, 'Unexpected remote requests: ' + blockedRequests.join(', '));
  const report = {
    buildDir,
    providerRequests: 0,
    captures,
    captureMetadata,
    layoutProofs,
    headingProofs,
    totals: {
      assertions: assertionCount,
      captures: captures.length,
      pageErrors: errors.length,
      remoteRequests: blockedRequests.length,
    },
    widths: [272, 360, 1100],
    cssZoom: 200,
    navigationFocusAndDraft: true,
    contextualValidation: true,
    micRecoveryAndRelease: true,
    actualFileProgress: true,
    preparationRetry: true,
    permissionAndSaveRecovery: true,
    duplicateSubmitBlocked: true,
    defaultsPreserveConnection: true,
    confirmKeyRemoval: true,
    assistantIframeDraftAndFocus: true,
    settingsLoadFailureRetry: true,
    safeDiagnosticDownload: true,
    selectableNotesProvider: true,
    optInAgentDiagnostics: true,
    mimoBrandAndPortrait: true,
    headingTextAndPortraitNeverOverlap: true,
    minimumFunctionalTextSize: 11,
    namedContainerRespondsToCssZoom: true,
    pageErrors: errors,
    mockedAPIs: true,
  };
  await writeFile(
    artifactPath('artifacts/settings-redesign-smoke.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
