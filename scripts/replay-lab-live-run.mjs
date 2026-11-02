// Explicitly authorized, bounded live research run. Importing this module never calls a provider.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRelay } from '../server/relay.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => ({
  name: error?.name || 'Error',
  message: String(error?.message || error).slice(0, 500),
});
async function atomic(file, value) {
  await writeFile(
    file + '.tmp',
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2),
  );
  await rename(file + '.tmp', file);
}

/** Serializes reservations and persists each one before any upstream fetch is permitted. */
export class LiveRequestLedger {
  constructor(file, limit, scope) {
    this.file = file;
    this.value = { version: 1, limit, scope, attempts: [], blocked: false };
    this.queue = Promise.resolve();
    this.failed = false;
  }
  async initialize() {
    await atomic(this.file, this.value);
  }
  get count() {
    return this.value.attempts.length;
  }
  get limit() {
    return this.value.limit;
  }
  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  reserve(kind) {
    return this.serial(async () => {
      if (this.failed)
        throw Error('Live request ledger unavailable; no further provider calls permitted.');
      if (this.count >= this.limit) {
        this.value.blocked = true;
        await atomic(this.file, this.value);
        const error = Error('Live provider request cap reached.');
        error.code = 'REPLAY_BUDGET_EXHAUSTED';
        throw error;
      }
      const entry = {
        attempt: this.count + 1,
        kind,
        startedAt: new Date().toISOString(),
        outcome: 'reserved',
      };
      this.value.attempts.push(entry);
      try {
        await atomic(this.file, this.value);
      } catch (error) {
        this.failed = true;
        throw error;
      }
      return entry.attempt;
    });
  }
  finish(attempt, fields) {
    return this.serial(async () => {
      const entry = this.value.attempts.find((item) => item.attempt === attempt);
      if (!entry) throw Error('Unknown reserved request.');
      Object.assign(entry, fields, { completedAt: new Date().toISOString() });
      try {
        await atomic(this.file, this.value);
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
  }
}

function options(argv) {
  const option = (name, fallback) =>
    argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const seconds = Number(option('seconds', '600'));
  const limit = Number(option('limit', '240'));
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    throw Error('This authorization permits at most 600 source seconds.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 240)
    throw Error('This authorization permits at most 240 provider attempts.');
  return {
    seconds,
    limit,
    source: path.resolve(
      root,
      option(
        'source',
        'training:meeting/lemhanas-16-10/meeting-recording-2026-10-23-16-05-35-combined.webm',
      ),
    ),
    output: path.resolve(
      root,
      option(
        'output',
        `artifacts/replay-lab-live/lemhanas-16-10-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
    ),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { seconds, limit, source, output } = options(argv);
  const ffmpeg = path.join(
    root,
    'artifacts/meeting-audio-tools/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',
  );
  const oldLedgerPath = path.join(root, 'artifacts/live-memo-v1/provider-budget.json');
  const [original, oldLedger, mainBuild, ffmpegBytes] = await Promise.all([
    readFile(source),
    readFile(oldLedgerPath),
    readFile(path.join(root, 'dist/build-info.json')),
    readFile(ffmpeg),
  ]);
  if (!original.length || !ffmpegBytes.length)
    throw Error('Required source or audio utility is empty.');
  if (argv.includes('--check')) {
    console.log(
      JSON.stringify({
        validated: true,
        seconds,
        limit,
        source: path.relative(root, source),
        originalSha256: sha(original),
        output,
        providerRequests: 0,
      }),
    );
    return;
  }
  // An immutable run directory also prevents accidental second launches against the same ledger.
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(path.join(output, 'review'));
  const scope = {
    recording: 'lemhanas-16-10',
    sourceStartMs: 0,
    requestedEndMs: seconds * 1000,
    providerAttemptLimit: limit,
    authorization:
      'User authorized a ten-minute live Replay Lab sample; all ASR, LLM, failed and retried upstream attempts share this separate cap.',
    originalBudgetLimit: 800,
    originalBudgetSha256: sha(oldLedger),
    realTimePlaybackRate: 1,
  };
  await atomic(path.join(output, 'authorization.json'), scope);
  const clip = path.join(output, `lemhanas-16-10-first-${seconds}s.webm`);
  await execute(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source,
      '-map',
      '0:a:0',
      '-t',
      String(seconds),
      '-vn',
      '-c:a',
      'copy',
      clip,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const clipped = await readFile(clip);
  const provenance = {
    original: { file: path.relative(root, source), sha256: sha(original), bytes: original.length },
    sample: {
      file: path.basename(clip),
      sha256: sha(clipped),
      bytes: clipped.length,
      requestedRangeMs: [0, seconds * 1000],
      extraction:
        'ffmpeg audio packet copy; no re-encoding; container/packet boundary may differ slightly from requested endpoint',
    },
  };
  await atomic(path.join(output, 'source-provenance.json'), provenance);
  const ledger = new LiveRequestLedger(path.join(output, 'provider-budget.json'), limit, scope);
  await ledger.initialize();
  const config = JSON.parse(await readFile(path.join(root, '.local/deepinfra.json'), 'utf8'));
  const relayToken = randomUUID();
  const globalAbort = new AbortController();
  let budgetExhausted = false;
  let ledgerFailure = false;
  let context, relay, page;
  let runId,
    startedAt,
    stopReason = 'natural-eof',
    failure;
  let lastStatus,
    lastIdentity = '',
    screenshotSequence = 0,
    checkpointSequence = 0;
  const browserErrors = [];
  const screenshots = [];
  const emit = (data) => console.log(JSON.stringify(data));
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
  async function command(type, payload = {}) {
    const result = await page.evaluate(
      (message) => chrome.runtime.sendMessage({ target: 'worker', ...message }),
      { type, ...payload },
    );
    if (!result?.ok) throw Error(result?.error || `Replay command failed: ${type}`);
    return result.value;
  }
  async function screenshot(label) {
    const name = `${String(++screenshotSequence).padStart(3, '0')}-${label}.png`;
    const file = path.join(output, 'review', name);
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    await atomic(path.join(output, 'review/latest.png'), await readFile(file));
    screenshots.push({
      file: `review/${name}`,
      at: new Date().toISOString(),
      sourceMs: lastStatus?.sourceMs ?? 0,
    });
    await atomic(path.join(output, 'screenshots.json'), screenshots);
  }
  async function evidence() {
    const value = await page.evaluate(async (id) => {
      async function read(name, store, key, index) {
        return new Promise((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(store)) {
              db.close();
              resolve(undefined);
              return;
            }
            const tx = db.transaction(store),
              object = tx.objectStore(store);
            const request = index ? object.index(index).getAll(key) : object.get(key);
            request.onerror = () => {
              db.close();
              reject(request.error);
            };
            request.onsuccess = () => {
              const result = request.result;
              db.close();
              resolve(result);
            };
          };
        });
      }
      const run = id ? await read('memo-replay-lab', 'runs', id) : undefined;
      if (!run) return { run: null, events: [], agentReport: undefined };
      const events = await read('memo-replay-lab', 'events', id, 'run');
      let agentReport = run.agentReport;
      if (!agentReport) {
        const session = await read('listen-agent-diagnostics', 'sessions', run.sessionId);
        const agentEvents = await read(
          'listen-agent-diagnostics',
          'events',
          run.sessionId,
          'session',
        );
        if (session) agentReport = { session, events: agentEvents ?? [] };
      }
      return { run, events: events ?? [], agentReport };
    }, runId);
    return {
      format: 'memo-replay-lab',
      version: 1,
      exportedAt: new Date().toISOString(),
      ...value,
      sample: provenance,
      authorization: scope,
      providerBudget: { attempts: ledger.count, limit, exhausted: budgetExhausted },
      limitations: [
        'A first-ten-minute sample, not the complete recording.',
        'Actual live provider responses and browser timing; results may vary on Repeat.',
        'Worker diagnostic source positions use approximately one-second playback samples.',
        'DOM/visibility observations do not prove visible browser paint.',
      ],
    };
  }
  async function snapshot(forceScreenshot = false, label = 'update') {
    lastStatus = await command('REPLAY_STATUS');
    if (!runId) runId = lastStatus.run?.id;
    const data = await evidence();
    await atomic(path.join(output, 'live-evidence.json'), data);
    const run = data.run;
    const states = data.events.filter((event) => event.kind === 'assistant-state');
    const assistant = run?.finalAssistant ?? states.at(-1)?.data;
    const transcriptStates = data.events.filter((event) => event.kind === 'transcript-state');
    const transcript = run?.finalTranscript ?? transcriptStates.at(-1)?.data;
    const publicState = assistant?.liveV2;
    const active = publicState?.contributions?.find((entry) => entry.id === publicState.activeId);
    const identity = JSON.stringify([publicState?.memo?.id, active?.id]);
    const progress = {
      ...lastStatus,
      recordedAt: new Date().toISOString(),
      elapsedRealMs: startedAt ? Date.now() - startedAt : 0,
      providerAttempts: ledger.count,
      providerLimit: limit,
      budgetExhausted,
      transcriptSegments: transcript?.segments?.length ?? 0,
      memo: publicState?.memo ?? null,
      activeContribution: active ?? null,
      sample: provenance,
    };
    await atomic(path.join(output, 'live-status.json'), progress);
    await atomic(
      path.join(output, `checkpoint-${String(++checkpointSequence).padStart(3, '0')}.json`),
      progress,
    );
    if (forceScreenshot || (identity !== lastIdentity && (publicState?.memo || active))) {
      await screenshot(label);
      lastIdentity = identity;
    }
    return progress;
  }
  async function exportViaUI() {
    await page.locator('#run-select').selectOption(runId);
    for (const [button, name] of [
      ['#export-json', 'full-evidence.json'],
      ['#export-run', 'report.html'],
    ]) {
      const download = page.waitForEvent('download', { timeout: 30000 });
      await page.locator(button).click();
      await (await download).saveAs(path.join(output, 'review', name));
    }
  }
  try {
    relay = createRelay({
      ...config,
      relayToken,
      providerFetch: async (url, options) => {
        if (globalAbort.signal.aborted) throw new DOMException('Run stopped', 'AbortError');
        const kind = String(url).includes('/v1/inference/')
          ? 'ASR'
          : (() => {
              try {
                const body = JSON.parse(options.body);
                return body.response_format?.json_schema?.name === 'live_memo_review_v2'
                  ? 'REVIEW'
                  : 'PROPOSE';
              } catch {
                return 'LLM';
              }
            })();
        let attempt;
        try {
          attempt = await ledger.reserve(kind);
        } catch (error) {
          if (error.code === 'REPLAY_BUDGET_EXHAUSTED') budgetExhausted = true;
          else ledgerFailure = true;
          globalAbort.abort();
          throw error;
        }
        const began = performance.now();
        const signal = options.signal
          ? AbortSignal.any([options.signal, globalAbort.signal])
          : globalAbort.signal;
        try {
          signal.throwIfAborted();
          const response = await fetch(url, { ...options, signal });
          await ledger.finish(attempt, {
            outcome: 'headers-received',
            status: response.status,
            responseHeadersMs: performance.now() - began,
          });
          return response;
        } catch (error) {
          await ledger
            .finish(attempt, {
              outcome: 'failed-or-aborted',
              errorName: error?.name ?? 'Error',
              elapsedMs: performance.now() - began,
            })
            .catch(() => {
              ledgerFailure = true;
            });
          throw error;
        }
      },
    });
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${relay.address().port}`;
    const buildDir = path.join(output, 'build');
    const built = await execute(process.execPath, ['scripts/build.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        LISTEN_REPLAY_LAB: '1',
        LISTEN_BUILD_DIR: buildDir,
        LISTEN_RELAY_ORIGIN: origin,
        LISTEN_RELAY_TOKEN: relayToken,
      },
      maxBuffer: 1024 * 1024,
    });
    await atomic(path.join(output, 'build.log'), built.stdout + built.stderr);
    const profile = path.join(output, 'profile');
    context = await chromium.launchPersistentContext(profile, {
      ...(process.env.LISTEN_CHROME_PATH
        ? { executablePath: process.env.LISTEN_CHROME_PATH }
        : { channel: 'chrome' }),
      headless: argv.includes('--headless'),
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
      args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
    });
    context.on('page', (p) => p.on('pageerror', (error) => browserErrors.push(safeError(error))));
    await context.route(/^https?:\/\//, (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const browser = await context.browser().newBrowserCDPSession();
    const { id } = await browser.send('Extensions.loadUnpacked', { path: buildDir });
    page = await context.newPage();
    await page.goto(`chrome-extension://${id}/replay.html`);
    await page.evaluate(async () =>
      chrome.storage.local.set({
        microphoneReady: false,
        transcriptionEnabled: true,
        listenAssistantAppearance: 'Daylight',
        assistantSettings: {
          enabled: true,
          provider: 'deepinfra',
          model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
          goal: '',
          benchmarkPassed: false,
        },
      }),
    );
    await page.reload();
    await page.locator('#audio-file').setInputFiles(clip);
    const importDeadline = Date.now() + 30000;
    while (await page.locator('#start-replay').isDisabled()) {
      if (Date.now() > importDeadline) throw Error('Source import did not become ready.');
      await sleep(250);
    }
    await screenshot('ready');
    startedAt = Date.now();
    await page.locator('#start-replay').click();
    const startDeadline = Date.now() + 45000;
    while (!runId || lastStatus?.phase === 'starting') {
      lastStatus = await command('REPLAY_STATUS');
      if (lastStatus.run?.id) runId = lastStatus.run.id;
      if (lastStatus.phase === 'error')
        throw Error(lastStatus.error || 'Replay failed during start.');
      if (Date.now() > startDeadline) throw Error('Replay start deadline exceeded.');
      if (!runId || lastStatus.phase === 'starting') await sleep(250);
    }
    if (lastStatus.durationMs > (seconds + 1) * 1000)
      throw Error('Prepared sample exceeds the authorized audio duration.');
    if (lastStatus.run.source.sha256 !== sha(clipped))
      throw Error('Selected Replay Lab source does not match the prepared sample.');
    provenance.sample.actualDurationMs = lastStatus.durationMs;
    await atomic(path.join(output, 'source-provenance.json'), provenance);
    await snapshot(true, 'started');
    emit({
      event: 'live-replay-started',
      output,
      sourceSeconds: seconds,
      providerLimit: limit,
      runId,
    });
    const wallDeadline = startedAt + 15 * 60 * 1000;
    let nextCheckpoint = Date.now() + 15000;
    while (true) {
      if (budgetExhausted || ledgerFailure || Date.now() > wallDeadline) {
        stopReason = budgetExhausted
          ? 'budget-cap'
          : ledgerFailure
            ? 'ledger-failure'
            : 'wall-deadline';
        globalAbort.abort();
        await command('REPLAY_STOP').catch(() => {});
        break;
      }
      lastStatus = await command('REPLAY_STATUS');
      if (['complete', 'error'].includes(lastStatus.phase) && lastStatus.run?.endedAt) break;
      const currentAssistant = await command('ASSISTANT_STATUS');
      const currentState = currentAssistant.liveV2;
      const active = currentState?.contributions?.find(
        (entry) => entry.id === currentState.activeId,
      );
      const identity = JSON.stringify([currentState?.memo?.id, active?.id]);
      if (identity !== lastIdentity && (currentState?.memo || active))
        await snapshot(false, `accepted-${Math.floor((lastStatus.sourceMs ?? 0) / 1000)}s`);
      if (Date.now() >= nextCheckpoint) {
        const progress = await snapshot(
          false,
          `at-${Math.floor((lastStatus.sourceMs ?? 0) / 1000)}s`,
        );
        emit({
          event: 'progress',
          sourceSeconds: Math.floor(progress.sourceMs / 1000),
          phase: progress.phase,
          segments: progress.transcriptSegments,
          memoId: progress.memo?.id ?? null,
          contributionId: progress.activeContribution?.id ?? null,
          requests: ledger.count,
          limit,
        });
        nextCheckpoint = Date.now() + 15000;
      }
      await sleep(1000);
    }
    await snapshot(true, 'final');
    await exportViaUI();
  } catch (error) {
    failure = safeError(error);
    stopReason = budgetExhausted ? 'budget-cap' : 'runner-error';
    globalAbort.abort();
    if (page) {
      await command('REPLAY_STOP').catch(() => {});
      await snapshot(true, 'partial').catch(() => {});
      await exportViaUI().catch(() => {});
    }
  } finally {
    globalAbort.abort();
    if (page && runId) {
      const finalEvidence = await evidence().catch(() => undefined);
      if (finalEvidence) await atomic(path.join(output, 'live-evidence.json'), finalEvidence);
    }
    const oldUnchanged = sha(await readFile(oldLedgerPath)) === sha(oldLedger);
    const mainUnchanged =
      sha(await readFile(path.join(root, 'dist/build-info.json'))) === sha(mainBuild);
    const summary = {
      completed:
        !failure &&
        !budgetExhausted &&
        !ledgerFailure &&
        stopReason === 'natural-eof' &&
        lastStatus?.phase === 'complete' &&
        !lastStatus?.run?.partial,
      partial:
        !!failure ||
        budgetExhausted ||
        ledgerFailure ||
        stopReason !== 'natural-eof' ||
        lastStatus?.phase !== 'complete' ||
        !!lastStatus?.run?.partial,
      stopReason,
      failure,
      runId,
      source: provenance,
      providerAttempts: ledger.count,
      providerLimit: limit,
      budgetExhausted,
      ledgerFailure,
      oldLedgerUnchanged: oldUnchanged,
      mainBuildUnchanged: mainUnchanged,
      browserErrors,
      screenshots,
      endedAt: new Date().toISOString(),
      modelQualityAcceptance:
        'Awaiting user review; technical completion is not model quality acceptance.',
    };
    await atomic(path.join(output, 'summary.json'), summary);
    await context?.close().catch(() => {});
    if (relay) {
      relay.closeAllConnections?.();
      await new Promise((resolve) => relay.close(resolve));
    }
    emit({
      event: 'live-replay-finished',
      output,
      completed: summary.completed,
      partial: summary.partial,
      requests: ledger.count,
      stopReason,
    });
    if (!oldUnchanged || !mainUnchanged)
      throw Error('Historical ledger/main build invariant changed.');
    if (failure) throw Error(failure.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
