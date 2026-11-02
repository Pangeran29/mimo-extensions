// Dedicated research browser. Opening this tool never starts audio or provider inference.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.resolve(
  root,
  process.env.LISTEN_REPLAY_BUILD_DIR || 'artifacts/replay-lab/build',
);
const profile = path.resolve(root, process.env.LISTEN_REPLAY_PROFILE_DIR || '.local/replay-lab-profile');
const smoke = process.argv.includes('--smoke');
if (buildDir === path.join(root, 'dist'))
  throw Error('Replay Lab requires a separate build directory.');
if (!process.argv.includes('--no-build')) {
  await execute(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    env: { ...process.env, LISTEN_REPLAY_LAB: '1', LISTEN_BUILD_DIR: buildDir },
  });
}
const manifest = JSON.parse(await readFile(path.join(buildDir, 'manifest.json'), 'utf8'));
if (manifest.name !== 'Memo Replay Lab') throw Error('This is not a Replay Lab research build.');
await mkdir(profile, { recursive: true });
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.LISTEN_CHROME_PATH
      ? { executablePath: process.env.LISTEN_CHROME_PATH }
      : { channel: 'chrome' }),
    headless: smoke,
    acceptDownloads: true,
    viewport: null,
    ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  const browser = await context.browser().newBrowserCDPSession();
  const { id } = await browser.send('Extensions.loadUnpacked', { path: buildDir });
  const url = `chrome-extension://${id}/replay.html`;
  const page = context.pages().find((p) => p.url() === url) || (await context.newPage());
  await page.goto(url);
  const connection = await page.evaluate(async () => {
    const current = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'ASSISTANT_SETTINGS',
    });
    if (current.value?.configured) return { configured: true };
    // Read-only relay health check, then research-profile defaults. No ASR/LLM call.
    const result = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'ASSISTANT_CONFIGURE',
      settings: { enabled: true, provider: 'deepinfra', goal: '', benchmarkPassed: false },
    });
    return { configured: result.ok === true };
  });
  await page.bringToFront();
  console.log('Memo Replay Lab is open in its separate Chrome profile.');
  console.log('Choose an audio file, then Start replay. Repeat creates a fresh session.');
  if (!connection.configured)
    console.log('Open AI settings to configure the research profile before starting.');
  console.log('No recording or provider inference has been started.');
  if (smoke) {
    const replay = await page.evaluate(
      async () =>
        (await chrome.runtime.sendMessage({ target: 'worker', type: 'REPLAY_STATUS' })).value,
    );
    if (['starting', 'playing', 'draining'].includes(replay?.phase))
      throw Error('Launcher unexpectedly found an active replay.');
    console.log('Launcher smoke passed: no autoplay.');
  } else {
    const close = () => void context?.close();
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    await new Promise((resolve) => context.once('close', resolve));
  }
} finally {
  await context?.close();
}
