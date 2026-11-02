// Isolated synthetic review: never writes to the user's meeting reference.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pcmWav } from './whisper-debug-metrics.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const root = await mkdtemp(path.resolve('artifacts/meeting-review-test-'));
let child, browser;
try {
  const audio = path.join(root, 'test.wav');
  await writeFile(audio, pcmWav(Buffer.alloc(32000)));
  const hash = createHash('sha256').update(Buffer.alloc(32000)).digest('hex');
  const pilot = {
    results: ['tab', 'microphone', 'combined'].map((role) => ({
      role,
      startSeconds: 0,
      endSeconds: 8,
      inputStats: { sha256: hash },
      result: { text: 'machine </script><img src=x onerror=alert(1)>' },
      reviewAudio: audio,
    })),
  };
  const pilotBytes = Buffer.from(JSON.stringify(pilot));
  await writeFile(path.join(root, 'pilot.json'), pilotBytes);
  const pilotHash = createHash('sha256').update(pilotBytes).digest('hex');
  child = spawn(process.execPath, ['scripts/meeting-reference-review.mjs', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Review server startup timeout')), 10000);
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+\//);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(Error('Review server exited ' + code));
    });
  });
  assert.equal((await fetch(new URL('/wrong/', url))).status, 404);
  assert.equal((await fetch(url + 'audio/0')).headers.get('content-type'), 'audio/wav');
  const annotations = pilot.results.map((r) => ({
    id: '0:' + r.role,
    inputHash: hash,
    status: 'pending',
    text: '',
    draftRevealed: false,
  }));
  const post = (annotations) =>
    fetch(url + 'save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pilotHash, annotations }),
    });
  const duplicate = structuredClone(annotations);
  duplicate[1] = duplicate[0];
  assert.equal((await post(duplicate)).status, 400);
  const uncertain = structuredClone(annotations);
  uncertain[0] = { ...uncertain[0], status: 'speech', text: '[unclear]' };
  assert.equal((await post(uncertain)).status, 400);
  await assert.rejects(() => readFile(path.join(root, 'reference.json')));
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(url);
  assert.equal(await page.locator('script').count(), 1); // Draft cannot break out of JSON.
  assert.equal(await page.locator('.draft:visible').count(), 0);
  const track = page.locator('.track').first();
  assert.equal(
    await track.getByRole('button', { name: 'Reveal machine draft' }).isEnabled(),
    false,
  );
  await track.getByRole('textbox').fill('Saya [unclear].');
  await track.getByRole('combobox').selectOption('speech');
  assert.equal(await track.getByRole('combobox').inputValue(), 'pending');
  await track.getByRole('textbox').fill('Rapat mulai besok.');
  await track.getByRole('button', { name: 'Reveal machine draft' }).click();
  assert.equal(await track.locator('.draft').isVisible(), true);
  assert.equal(await track.locator('img').count(), 0);
  await track.getByRole('combobox').selectOption('speech');
  const mic = page.locator('.track').nth(1);
  await mic.getByRole('combobox').selectOption('no-speech');
  assert.equal(await mic.getByRole('textbox').isDisabled(), true);
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.waitForFunction(() =>
    document.getElementById('save-status').textContent.includes('Saved locally'),
  );
  const saved = JSON.parse(await readFile(path.join(root, 'reference.json')));
  assert.equal(saved.annotations[0].text, 'Rapat mulai besok.');
  assert.equal(saved.annotations[0].textBeforeReveal, 'Rapat mulai besok.');
  assert.equal(saved.annotations[0].draftRevealed, true);
  assert.equal(saved.annotations[1].status, 'no-speech');
  assert.equal(saved.annotations[2].status, 'pending');
  await page.reload();
  assert.equal(await track.getByRole('textbox').inputValue(), 'Rapat mulai besok.');
  await page
    .locator('audio')
    .first()
    .evaluate(async (a) => {
      a.load();
      await new Promise((resolve, reject) => {
        a.onloadedmetadata = resolve;
        a.onerror = reject;
      });
    });
  assert.equal(
    await page
      .locator('audio')
      .first()
      .evaluate((a) => a.duration),
    0.5,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/meeting-review-test-mobile.png', fullPage: true });
  console.log(
    'Meeting review: local save, audio loading, blind reveal, uncertain/pending safeguards, source/hash binding, reload and mobile layout passed.',
  );
} finally {
  await browser?.close();
  child?.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
