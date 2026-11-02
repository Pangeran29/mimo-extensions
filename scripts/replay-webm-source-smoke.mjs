// Metadata/source preparation only for the user's existing Chrome recordings.
// Never starts playback, VAD, ASR, memo inference, or any upstream connection.
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve('artifacts/replay-lab-2026-10-31');
await mkdir(output, { recursive: true });
const ledgerPath = 'artifacts/live-memo-v1/provider-budget.json';
const ledgerBefore = await readFile(ledgerPath);
const sources = [
  'training:meeting/lemhanas-16-10/meeting-recording-2026-10-23-16-05-35-combined.webm',
  'training:meeting/lemhanas-28-10/meeting-recording-2026-10-28-10-08-15-combined.webm',
];
const files = await Promise.all(
  sources.map(async (filename) => {
    const bytes = await readFile(filename);
    return { filename, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }),
);
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export {ReplayAudioSource} from './src/replay/source';`,
  },
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  write: false,
});
const served = [];
const server = createServer((request, response) => {
  served.push(request.url);
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    return response.end('<!doctype html><title>WebM metadata preparation check</title>');
  }
  if (request.url === '/source.js') {
    response.setHeader('Content-Type', 'text/javascript');
    return response.end(bundle.outputFiles[0].contents);
  }
  const match = /^\/recording-(\d)\.webm$/.exec(request.url);
  if (match && files[Number(match[1])]) {
    response.setHeader('Content-Type', 'audio/webm');
    return response.end(files[Number(match[1])].bytes);
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
const unexpected = [];
let browser;
let failure;
try {
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext();
  await context.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    unexpected.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  for (let index = 0; index < files.length; index++) {
    const prepared = await page.evaluate(async (index) => {
      const { ReplayAudioSource } = await import('/source.js');
      const blob = await (await fetch(`/recording-${index}.webm`)).blob();
      const created = [],
        revoked = [],
        seeks = [],
        metadata = [];
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        return revoke(url);
      };
      const source = new ReplayAudioSource();
      let playCalls = 0;
      source.audio.play = () => {
        playCalls++;
        return Promise.reject(Error('Playback must not run in a metadata check.'));
      };
      source.audio.addEventListener('loadedmetadata', () =>
        metadata.push(String(source.audio.duration)),
      );
      const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(source.audio, 'currentTime', {
        get() {
          return time.get.call(this);
        },
        set(value) {
          seeks.push(value);
          time.set.call(this, value);
        },
      });
      let value;
      try {
        await source.prepare(blob, false);
        value = {
          durationMs: source.durationMs,
          currentTime: source.audio.currentTime,
          paused: source.audio.paused,
          playbackRate: source.audio.playbackRate,
          trackStates: source.destination.stream.getAudioTracks().map((track) => track.readyState),
          contextState: source.context.state,
          initialMetadataDurations: metadata,
          seekRequests: seeks,
          infinityDurationFallbackUsed: seeks.includes(1e10),
        };
      } finally {
        await source.release();
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
      }
      return {
        ...value,
        playCalls,
        cleanup: {
          contextState: source.context.state,
          trackStates: source.destination.stream.getAudioTracks().map((track) => track.readyState),
          srcRemoved: !source.audio.getAttribute('src'),
          allObjectUrlsRevoked:
            created.length === revoked.length && created.every((url) => revoked.includes(url)),
        },
      };
    }, index);
    const result = {
      filename: files[index].filename,
      size: files[index].bytes.length,
      sha256: files[index].sha256,
      ...prepared,
    };
    results.push(result);
    assert.ok(
      result.durationMs > 0 && Number.isFinite(result.durationMs),
      'WebM duration must be finite.',
    );
    assert.equal(
      result.currentTime,
      0,
      'Metadata discovery must return to the recording beginning.',
    );
    assert.ok(
      result.paused && result.playbackRate === 1 && result.playCalls === 0,
      'Metadata preparation must not play audio.',
    );
    assert.ok(
      result.trackStates.length > 0 && result.trackStates.every((state) => state === 'live'),
      'Prepared audio stream must be live.',
    );
    assert.ok(
      result.cleanup.contextState === 'closed' &&
        result.cleanup.srcRemoved &&
        result.cleanup.allObjectUrlsRevoked &&
        result.cleanup.trackStates.every((state) => state === 'ended'),
      'Release must close the context, tracks, and blob URL.',
    );
  }
  assert.equal(unexpected.length, 0, 'Unexpected network destination.');
  assert.equal(
    Buffer.compare(ledgerBefore, await readFile(ledgerPath)),
    0,
    'Provider ledger changed.',
  );
} catch (error) {
  failure = error.stack || String(error);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  const report = {
    passed: !failure,
    scope:
      'Actual Chrome-recorded WebM metadata and ReplayAudioSource preparation/cleanup only; no playback, VAD, ASR, or LLM.',
    paidProviderRequests: 0,
    ledgerUnchanged: Buffer.compare(ledgerBefore, await readFile(ledgerPath)) === 0,
    unexpectedRequests: unexpected,
    localRequests: served,
    results,
    ...(failure ? { failure } : {}),
  };
  await writeFile(path.join(output, 'webm-source-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
