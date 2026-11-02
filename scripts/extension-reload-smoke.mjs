// Actual unpacked reload; synthetic credential only, no provider/audio/model download.
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const buildDir = path.resolve(process.env.LISTEN_UI_BUILD_DIR || 'dist');
const { version: expectedVersion } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const profile = await mkdtemp(path.join(tmpdir(), 'listen-reload-'));
let assertionCount = 0;
const assert = (value, message) => {
  assertionCount++;
  if (!value) throw Error(message);
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: buildDir });
  let page = await context.newPage();
  await page.goto(`chrome-extension://${id}/setup.html`);
  await page.waitForFunction(() => !!chrome.runtime?.id);
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  assert(
    manifest.name.startsWith('Mimo') &&
      manifest.action?.default_title === 'Mimo' &&
      manifest.version === expectedVersion,
    'Isolated extension loaded the wrong Mimo package',
  );
  assert((await page.title()) === 'Mimo settings', 'Isolated settings has stale branding');
  assert(
    await page
      .locator('#settings-mimo-greeting img')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    'Isolated Mimo portrait did not load',
  );
  const saved = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'ASSISTANT_CONFIGURE',
      settings: {
        enabled: false,
        model: 'claude-sonnet-5-5',
        goal: 'Persisted objective',
        benchmarkPassed: false,
      },
      apiKey: 'reload-smoke-synthetic-key',
    });
    await chrome.storage.session.set({ reloadSmoke: true });
    return {
      ok: r.ok,
      hasKey: r.value?.hasKey,
      leaked: JSON.stringify(r).includes('reload-smoke-synthetic-key'),
    };
  });
  assert(
    saved.ok && saved.hasKey && !saved.leaked,
    'Synthetic connection could not be saved privately',
  );
  // Re-load the same directory/ID, as with Chrome's Load unpacked development flow.
  const reloaded = await root.send('Extensions.loadUnpacked', { path: buildDir });
  assert(reloaded.id === id, 'Reload changed the extension identity');
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/setup.html`);
  const restored = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ target: 'worker', type: 'ASSISTANT_SETTINGS' });
    const ephemeral = await chrome.storage.session.get('reloadSmoke');
    return {
      hasKey: r.value?.hasKey,
      goal: r.value?.settings.goal,
      sessionCleared: !ephemeral.reloadSmoke,
      leaked: JSON.stringify(r).includes('reload-smoke-synthetic-key'),
    };
  });
  assert(
    restored.hasKey &&
      restored.sessionCleared &&
      !restored.leaked &&
      restored.goal === 'Persisted objective',
    'Connection did not survive an actual extension reload',
  );
  const cleared = await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'ASSISTANT_CONFIGURE',
      settings: { enabled: false, model: 'claude-sonnet-5-5', goal: '', benchmarkPassed: false },
      clearKey: true,
    });
    const local = await chrome.storage.local.get('assistantKey');
    const session = await chrome.storage.session.get('assistantKey');
    return !local.assistantKey && !session.assistantKey;
  });
  assert(cleared, 'Remove key left a credential behind');
  const report = {
    buildDir,
    name: manifest.name,
    version: manifest.version,
    mimoPortraitLoaded: true,
    actualUnpackedReload: true,
    keyPersistsLocally: true,
    sessionReallyCleared: true,
    keyAbsentFromResponses: true,
    removeKeyClearsBothStores: true,
    providerRequests: false,
    modelDownload: false,
    totals: { assertions: assertionCount },
  };
  await writeFile(
    process.env.LISTEN_RELOAD_SMOKE_REPORT || 'artifacts/extension-reload-smoke.json',
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
