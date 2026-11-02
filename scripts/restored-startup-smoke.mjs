// Isolated extension restoration check. Synthetic saved data; no recording or provider calls.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const output = path.resolve('artifacts/restored-startup');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, 'runtime-'));
let context;
try {
  const extension = path.join(temporary, 'extension');
  await cp('dist', extension, { recursive: true });
  const worker = path.join(extension, 'assistant/network-worker.js');
  await writeFile(
    worker,
    'globalThis.fetch=()=>Promise.reject(Error("Provider calls disabled in restoration check"));\n' +
      (await readFile(worker, 'utf8')),
  );
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/setup.html`);
  const result = await page.evaluate(async () => {
    const saved = {
      sessionId: 'saved-session',
      phase: 'complete',
      version: 1,
      summary: 'Previously saved memo.',
      summaries: [],
      memory: [],
      history: [],
      question: null,
      message: 'Saved',
      model: 'claude-sonnet-5-5',
      lastSegmentId: 0,
      incomplete: true,
      deeperBusy: false,
      contextGap: false,
    };
    const transcript = {
      sessionId: 'saved-session',
      phase: 'complete',
      modelReady: false,
      incomplete: false,
      lagMs: 0,
      segments: [0, 1].map((id) => ({
        id,
        sessionId: 'saved-session',
        startMs: id * 8000,
        endMs: id * 8000 + 7000,
        text: 'Synthetic finalized speech.',
      })),
    };
    const seed = async (name, version, snapshot) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('latest');
          if (name === 'listen-transcript')
            request.result.createObjectStore('pending', { keyPath: 'pendingId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('latest', 'readwrite');
        tx.objectStore('latest').put(snapshot, 'snapshot');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    };
    await seed('listen-assistant', 1, saved);
    await seed('listen-transcript', 2, transcript);
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Verify saved-meeting startup without capture',
    });
    const send = async (type, extra = {}) => {
      const reply = await chrome.runtime.sendMessage({ target: 'recorder', type, ...extra });
      if (!reply?.ok) throw Error(reply?.error || 'No recorder response');
      return reply.value;
    };
    const prepared = await send('PREPARE_TRANSCRIPTION');
    await send('ASSISTANT_INIT', {
      settings: { enabled: true, model: 'claude-sonnet-5-5', goal: '', benchmarkPassed: false },
      apiKey: 'synthetic-unused',
    });
    // Give the old 150ms scheduler enough time to reveal accidental reactivation.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const status = await send('STATUS');
    const ai = await send('ASSISTANT_STATUS');
    const asr = await send('TRANSCRIPT_STATUS');
    return {
      prepared: prepared.modelReady,
      recordingPhase: status.phase,
      assistantBusy: status.assistantBusy,
      transcriptionBusy: status.transcriptionBusy,
      aiPhase: ai.phase,
      version: ai.version,
      memo: ai.summary,
      transcriptSegments: asr.segments.length,
    };
  });
  assert.equal(result.prepared, true);
  assert.equal(result.recordingPhase, 'idle');
  assert.equal(result.assistantBusy, false);
  assert.equal(result.transcriptionBusy, false);
  assert.equal(result.aiPhase, 'complete');
  assert.equal(result.version, 1);
  assert.equal(result.memo, 'Previously saved memo.');
  assert.equal(result.transcriptSegments, 2);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      { success: true, synthetic: true, paidCalls: 0, captureTested: false, ...result },
      null,
      2,
    ),
  );
  console.log(
    'Chrome restoration passed: saved unfinished memo remains closed, speech detector prepares, no AI/transcription busy conflict, saved data retained. No capture or paid requests.',
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
