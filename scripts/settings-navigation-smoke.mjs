// Focused Settings parent/iframe navigation checks. Actual packaged code; local fixtures only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const buildDir = path.resolve(process.env.LISTEN_UI_BUILD_DIR || 'artifacts/mimo-settings-back-2026-11-01/build');
const outputDir = path.resolve(process.env.LISTEN_UI_ARTIFACT_DIR || 'artifacts/mimo-settings-back-2026-11-01/ui');
const checks = [], captures = [], errors = [], remote = [];
let current;
const assert = (condition, message) => {
  if (!condition) throw Error(message);
  checks.push(message);
};
await mkdir(outputDir, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(buildDir, '.' + name);
    if (path.relative(buildDir, file).startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.LISTEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext();
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
  remote.push(url.origin);
  return route.abort();
});

async function create({ active = false, history = false, theme = 'Daylight', width = 420, standalone = false } = {}) {
  const page = await context.newPage();
  current = page;
  page.setDefaultTimeout(6000);
  await page.setViewportSize({ width, height: 820 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ active, history, theme }) => {
    if (window === window.top) {
      const now = Date.now(), sessionId = 'settings-fixture';
      const contribution = {
        id: 'saved-thought', createdAt: now, topic: 'launch', kind: 'suggestion', status: 'relevant',
        statusSources: [0], title: 'Approval handoff', body: 'Clarify the final approval handoff.',
        sources: [0], interpretation: false, generalKnowledge: false, proposal: true,
      };
      window.fixture = {
        calls: [], listeners: [], storageListeners: [], local: { listenAssistantAppearance: theme, microphoneReady: true }, session: {},
        rec: active ? { phase: 'recording', session: { id: sessionId, createdAt: now - 40000, durationMs: 40000 }, retained: [] } : { phase: 'idle', retained: [] },
        ai: {
          phase: active ? 'listening' : 'ready', sessionId: history || active ? sessionId : undefined, version: 1,
          summary: '', summaries: [], memory: [], history: [], question: null, deeperBusy: false, lastSegmentId: 0, incomplete: false,
          liveV2: history || active ? {
            protocol: 2, memo: { id: 'saved-memo', text: 'Participants discuss launch approval.', topic: { key: 'launch', label: 'Launch', sources: [0] }, sources: [0], createdAt: now, throughSegmentId: 0 },
            topic: { key: 'launch', label: 'Launch', sources: [0] }, memory: [], contributions: history ? [contribution] : [], activeId: history ? contribution.id : null,
            decision: 'silent', closed: !active, feedbackVersion: 0,
          } : undefined,
        },
        asr: { phase: active ? 'transcribing' : 'ready', sessionId, modelReady: true, lagMs: 0, incomplete: false, segments: [{ id: 0, sessionId, startMs: 0, endMs: 8000, text: 'Participants discuss launch approval.' }] },
      };
    }
    const host = window.top.fixture;
    const store = (area) => ({
      get: async () => structuredClone(host[area]),
      set: async (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: host[area][key], newValue: value };
          host[area][key] = value;
        }
        host.storageListeners.forEach((listener) => listener(changes, area));
      },
      remove: async (key) => { delete host[area][key]; },
    });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted', onchange: null }) } });
    window.chrome = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: { query: async () => [{ id: 7, windowId: 1, title: 'Settings fixture', url: 'https://example.com' }] },
      storage: { local: store('local'), session: store('session'), onChanged: { addListener: (fn) => host.storageListeners.push(fn) } },
      permissions: { contains: async () => true, request: async () => true, onRemoved: { addListener: () => {} } },
      runtime: {
        id: 'fixture', getManifest: () => ({ name: 'Mimo', version: '0.12.1' }),
        onMessage: { addListener: (fn) => host.listeners.push(fn) },
        connect: () => ({ onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} }, disconnect: () => {} }),
        sendMessage: async (msg) => {
          host.calls.push(msg.type);
          if (msg.type === 'STATUS') return { ok: true, value: structuredClone(host.rec) };
          if (msg.type === 'ASSISTANT_STATUS') return { ok: true, value: structuredClone(host.ai) };
          if (msg.type === 'TRANSCRIPT_STATUS') return { ok: true, value: structuredClone(host.asr) };
          if (msg.type === 'ASSISTANT_SETTINGS') return { ok: true, value: { configured: true, settings: { provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', enabled: true, goal: '' }, hasAccess: true, hasKey: false, relayStatus: 'ready' } };
          return { ok: false, error: 'Unsupported fixture action: ' + msg.type };
        },
      },
    };
  }, { active, history, theme });
  await page.goto(origin + (standalone ? '/setup.html' : '/assistant.html'));
  if (standalone) await page.locator('#overview-title').waitFor({ state: 'visible' });
  else await page.locator(active ? '#open-live' : '#idle-settings').waitFor({ state: 'visible' });
  return page;
}
const frame = (page) => page.frameLocator('#settings-frame');
async function openSettings(page, active = false) {
  await page.locator(active ? '#settings' : '#idle-settings').click();
  await frame(page).locator('#overview-title').waitFor({ state: 'visible' });
  await frame(page).locator('#ai-fields').waitFor({ state: 'attached' });
}
async function capture(page, filename) {
  await page.evaluate(() => document.fonts.ready);
  const bytes = await page.screenshot({ path: path.join(outputDir, filename), animations: 'disabled' });
  const size = page.viewportSize();
  captures.push({ filename, path: path.join(outputDir, filename), pngWidth: bytes.readUInt32BE(16), pngHeight: bytes.readUInt32BE(20), logicalWidth: size.width, logicalHeight: size.height, sha256: createHash('sha256').update(bytes).digest('hex'), viewportKind: 'CSS viewport; not a native Chrome zoom claim' });
}
async function noParentBar(page, label) {
  assert(!(await page.locator('#settings-shortcuts').isVisible()), label + ': no parent Settings topbar');
  assert(await page.locator('#settings-return').count() === 0, label + ': parent has no duplicate Back');
}
async function overviewBack(page, label) {
  const child = frame(page);
  const proof = await child.locator('#settings-return').evaluate((button) => {
    const title = document.getElementById('overview-title'), hero = button.closest('.settings-hero');
    const b = button.getBoundingClientRect(), h = title.getBoundingClientRect();
    return { inside: !!hero && hero.contains(title), before: button.nextElementSibling === title, width: b.width, height: b.height, visibleText: button.innerText.trim(), aria: button.getAttribute('aria-label'), leftOfTitle: b.right <= h.left + 1, withinViewport: b.left >= 0 && h.right <= innerWidth + 1 };
  });
  assert(proof.inside && proof.before && proof.leftOfTitle, label + ': overview Back precedes Settings in the card heading');
  assert(proof.width >= 44 && proof.height >= 44, label + ': overview Back has a 44px hit target');
  assert(proof.visibleText === '' && /back/i.test(proof.aria || ''), label + ': overview Back is icon-only with accessible name');
  assert(proof.withinViewport, label + ': heading and Back fit the child viewport');
}
async function trustedHost(page, data) {
  await page.evaluate((data) => document.getElementById('settings-frame').contentWindow.postMessage(data, location.origin), data);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
let success = false;
try {
  const idle = await create();
  await openSettings(idle);
  await frame(idle).locator('#settings-return').waitFor({ state: 'visible' });
  await noParentBar(idle, 'Idle overview');
  await overviewBack(idle, 'Idle overview');
  assert(!(await idle.locator('#session-controls').isVisible()), 'Idle Settings has no one-item footer');
  await capture(idle, 'idle-settings-overview.png');
  await frame(idle).locator('#open-microphone').click();
  assert(await frame(idle).locator('#back').isVisible(), 'Microphone retains its detail Back');
  assert(!(await frame(idle).locator('#settings-return').isVisible()), 'Microphone has no overview Back');
  await noParentBar(idle, 'Microphone detail');
  assert((await frame(idle).locator('button[aria-label^="Back"]').filter({ visible: true }).count()) === 1, 'Microphone exposes exactly one Back control');
  await capture(idle, 'idle-microphone-detail.png');
  await frame(idle).locator('#back').click();
  await frame(idle).locator('#settings-return').waitFor({ state: 'visible' });
  await frame(idle).locator('#open-defaults').click();
  await frame(idle).locator('#ai-goal').fill('Keep this local unsaved objective.');
  await trustedHost(idle, { type: 'MIMO_SETTINGS_HOST', canReturn: true, hasHistory: false });
  assert(await frame(idle).locator('#ai-goal').inputValue() === 'Keep this local unsaved objective.', 'Host update preserves a dirty detail draft');
  assert(await frame(idle).locator('#detail-title').innerText() === 'Session defaults', 'Host update does not reset the detail screen');
  await frame(idle).locator('#back').click();
  await frame(idle).locator('#settings-return').click();
  await idle.locator('#idle-view').waitFor({ state: 'visible' });
  assert(!(await idle.locator('#settings-frame').isVisible()), 'Overview Back returns to the welcome content');

  const active = await create({ active: true, history: true });
  await openSettings(active, true);
  await frame(active).locator('#settings-history').waitFor({ state: 'visible' });
  await noParentBar(active, 'Active Settings');
  assert(!(await frame(active).locator('#settings-return').isVisible()), 'Active Settings has no parent exit Back');
  assert((await active.locator('#session-controls .nav-button:visible').allTextContents()).map((s) => s.trim()).join('|') === 'Live memo|Transcript|Settings', 'Active footer retains all three tab identities');
  assert(await frame(active).locator('#settings-mimo-greeting').isVisible(), 'Active Settings retains its own Mimo portrait');
  await capture(active, 'active-settings-overview.png');
  await active.evaluate(() => {
    for (const data of [{ type: 'MIMO_SETTINGS_RETURN' }, { type: 'MIMO_SETTINGS_OPEN_HISTORY' }]) {
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data }));
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.invalid', source: document.getElementById('settings-frame').contentWindow, data }));
    }
  });
  assert(await active.locator('#settings-frame').isVisible(), 'Parent ignores forged-origin/source child actions');
  assert(!(await active.locator('#insights-view').isVisible()), 'Forged history actions do not navigate');
  await frame(active).locator('body').evaluate(() => window.parent.postMessage({ type: 'MIMO_SETTINGS_RETURN' }, location.origin));
  assert(await active.locator('#settings-frame').isVisible(), 'Real child cannot request idle-only return during a live session');
  await frame(active).locator('body').evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.invalid', source: window.parent, data: { type: 'MIMO_SETTINGS_HOST', canReturn: true, hasHistory: false } }));
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { type: 'MIMO_SETTINGS_HOST', canReturn: true, hasHistory: false } }));
  });
  assert(!(await frame(active).locator('#settings-return').isVisible()) && await frame(active).locator('#settings-history').isVisible(), 'Child ignores forged host-state messages');
  await frame(active).locator('#open-microphone').click();
  assert(!(await frame(active).locator('#settings-return').isVisible()) && !(await frame(active).locator('#settings-history').isVisible()), 'Detail screen shows neither overview exit nor history shortcut');
  await capture(active, 'active-microphone-detail.png');
  await frame(active).locator('#back').click();
  await frame(active).locator('#settings-history').click();
  await active.locator('#insights-view').waitFor({ state: 'visible' });
  assert(await active.locator('#live-history').isVisible(), 'Card history action opens actual stored contributions');
  await active.locator('#insights-back').click();
  await frame(active).locator('#overview-title').waitFor({ state: 'visible' });
  await active.waitForFunction(() => document.getElementById('settings-frame').contentDocument.activeElement?.id === 'settings-history');
  assert(await frame(active).locator('#settings-history').evaluate((el) => document.activeElement === el), 'History Back restores focus to its child Settings shortcut');

  const narrow = await create({ width: 210, theme: 'Midnight' });
  await openSettings(narrow);
  await frame(narrow).locator('#settings-return').waitFor({ state: 'visible' });
  await overviewBack(narrow, '210px compact overview');
  await noParentBar(narrow, '210px compact overview');
  assert(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Compact parent has no horizontal overflow');
  assert(await frame(narrow).locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Compact Settings has no horizontal overflow');
  await capture(narrow, 'compact-210-settings-overview.png');
  await frame(narrow).locator('#open-microphone').click();
  assert(await frame(narrow).locator('#back').isVisible() && !(await frame(narrow).locator('#settings-return').isVisible()), 'Compact Microphone retains only detail Back');
  await capture(narrow, 'compact-210-microphone-detail.png');

  const standalone = await create({ standalone: true, width: 900, theme: 'Midnight' });
  await standalone.evaluate(() => window.postMessage({ type: 'MIMO_SETTINGS_HOST', canReturn: true, hasHistory: true }, location.origin));
  assert(!(await standalone.locator('#settings-return').isVisible()), 'Standalone Settings does not accept embedded exit state');
  assert(!(await standalone.locator('#settings-history').isVisible()), 'Standalone Settings has no host history shortcut');
  await standalone.locator('#open-microphone').click();
  assert(await standalone.locator('#back').isVisible(), 'Standalone detail navigation remains available');
  await capture(standalone, 'standalone-microphone-detail.png');
  assert(errors.length === 0, 'No browser page errors');
  assert(remote.length === 0, 'No remote or provider requests');
  success = true;
} catch (error) {
  if (current) await capture(current, 'failure-state.png').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(outputDir, 'result.json'), JSON.stringify({
    success, candidate: JSON.parse(await readFile(path.join(buildDir, 'build-info.json'), 'utf8')),
    version: JSON.parse(await readFile(path.join(buildDir, 'manifest.json'), 'utf8')).version,
    totals: { assertions: checks.length, captures: captures.length, pageErrors: errors.length, remoteRequests: remote.length },
    checks, captures, errors, remote, providerRequests: 0,
    scope: 'Focused Settings parent/iframe navigation with actual packaged source and synthetic Chrome/worker data. Screenshots use CSS viewports, not native-zoom claims. No main profile, microphone, model download, or real ASR/LLM operation.',
  }, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log('PASS: ' + checks.length + ' Settings navigation assertions, ' + captures.length + ' captures; zero provider requests.');
