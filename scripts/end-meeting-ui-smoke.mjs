// Synthetic post-meeting UI evidence. No capture, ASR, credentials or provider calls.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const followup = process.env.MIMO_END_UI_FOLLOWUP_ONLY === '1';
const artifact = path.resolve(process.env.MIMO_END_UI_ARTIFACT_DIR || (followup ? 'artifacts/end-meeting-2026-11-02/ui-followup' : 'artifacts/end-meeting-2026-11-02/ui'));
const output = path.join(artifact, 'ui-build');
await mkdir(output, { recursive: true });
await cp('public', output, { recursive: true });
await build({ entryPoints: ['src/assistant-window.ts', 'src/popup.ts'], outdir: output, bundle: true, format: 'esm', target: 'chrome116', define: { LISTEN_REPLAY_LAB: 'false', LISTEN_BUILD_ID: '"synthetic-end-ui"' } });
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(output, '.' + new URL(req.url, 'http://localhost').pathname);
    if (path.relative(output, file).startsWith('..')) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(artifact, 'profile-'));
const browser = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.LISTEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [], remote = [], checks = [], captures = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
await browser.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
  remote.push(url.origin);
  return route.abort();
});
await browser.addInitScript(() => {
  const now = Date.now();
  window.listeners = [];
  window.calls = [];
  const settings = { enabled: true, provider: 'deepinfra', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', goal: '', benchmarkPassed: false };
  window.asr = { phase: 'complete', sessionId: 'synthetic-ended', segments: [
    { id: 1, sessionId: 'synthetic-ended', startMs: 0, endMs: 9000, text: 'The beta will include combined audio, meeting notes, and a transcript.' },
    { id: 2, sessionId: 'synthetic-ended', startMs: 9000, endMs: 18000, text: 'Maya will test the export flow by Thursday. November 23 is only a proposal.' },
  ], incomplete: false, lagMs: 0, modelReady: false };
  window.ai = { phase: 'complete', sessionId: 'synthetic-ended', version: 1, summary: '', summaries: [], question: null, memory: [], history: [], message: '', model: settings.model, lastSegmentId: 2, incomplete: false, deeperBusy: false, contextGap: false };
  window.job = { protocol: 1, sessionId: 'synthetic-ended', createdAt: now - 60000, updatedAt: now, revision: 1, sourceTitle: 'Synthetic beta planning', durationMs: 18000, reason: 'manual', settings, phase: 'ready', audio: 'ready', destination: 'missing', folderName: 'Mimo-synthetic-ended', audioFilename: 'audio-synthetic.webm', transcript: window.asr, minutes: { protocol: 1, language: 'en', emptyReason: null, bullets: [
    { kind: 'decision', text: 'The beta includes combined audio, meeting notes, and the full transcript.', sources: [1] },
    { kind: 'action', text: 'Maya will test the export flow by Thursday.', sources: [2] },
    { kind: 'discussion', text: 'November 23 remains a proposed date.', sources: [2] },
  ] }, files: { audio: { phase: 'pending' }, transcript: { phase: 'pending' }, mom: { phase: 'pending' } } };
  window.recorderState = { phase: 'idle', retained: [], transcriptionBusy: false, assistantBusy: false };
  window.jobs = { [window.job.sessionId]: window.job };
  window.emit = (type, data) => window.listeners.forEach((listener) => listener({ target: 'ui', type, ...data }, { id: 'fixture' }, () => {}));
  const storage = { get: async () => ({ listenAssistantAppearance: 'Daylight', microphoneReady: true }), set: async () => {} };
  window.chrome = {
    runtime: { id: 'fixture', getURL: (v) => '/' + v, onMessage: { addListener: (listener) => window.listeners.push(listener) }, sendMessage: async (m) => {
      window.calls.push(m);
      if (m.type === 'ASSISTANT_STATUS') return { ok: true, value: window.ai };
      if (m.type === 'TRANSCRIPT_STATUS') return { ok: true, value: window.asr };
      if (m.type === 'STATUS') return { ok: true, value: window.recorderState };
      if (m.type === 'END_STATUS') return { ok: true, value: m.sessionId ? window.jobs[m.sessionId] : window.job };
      if (m.type === 'END_MEETING') {
        const id = m.sessionId ?? window.job.sessionId;
        if (!window.jobs[id]) {
          const recovered = structuredClone(window.job);
          recovered.sessionId = id;
          recovered.updatedAt++;
          recovered.minutes.bullets = [{ kind: 'discussion', text: 'Recovered interrupted recording.', sources: [] }];
          window.jobs[id] = recovered;
        }
        return { ok: true, value: window.jobs[id] };
      }
      return { ok: true, value: undefined };
    } },
    storage: { local: storage, session: storage, onChanged: { addListener: () => {} } },
    tabs: { query: async () => [{ id: 7, windowId: 1, url: 'https://example.com', title: 'Synthetic planning' }], onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    windows: { getCurrent: async () => ({ id: 1 }), onFocusChanged: { addListener: () => {} } },
  };
});
try {
  for (const [name, width, height, theme] of (followup ? [['pending', 420, 820, 'Daylight']] : [['daylight', 420, 820, 'Daylight'], ['midnight', 420, 820, 'Midnight'], ['narrow', 272, 620, 'Midnight'], ['compact210', 210, 410, 'Daylight']])) {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto(origin + '/assistant.html');
    await page.locator('#end-meeting-panel').waitFor({ state: 'visible' });
    await page.evaluate((theme) => { document.body.dataset.surface = theme; }, theme);
    if (followup) {
      await page.evaluate(async () => {
        const older = structuredClone(window.job);
        older.sessionId = 'older-unsaved';
        older.sourceTitle = 'Earlier unsaved meeting';
        older.createdAt -= 120000;
        older.transcript.sessionId = older.sessionId;
        older.transcript.segments = older.transcript.segments.map((segment) => ({ ...segment, sessionId: older.sessionId, text: 'Earlier meeting evidence.' }));
        older.minutes.bullets = [{ kind: 'discussion', text: 'Earlier meeting notes remain available.', sources: [1] }];
        const complete = structuredClone(older);
        complete.sessionId = 'already-saved';
        complete.sourceTitle = 'Already saved meeting';
        Object.values(complete.files).forEach((file) => { file.phase = 'saved'; });
        window.jobs[older.sessionId] = older;
        window.jobs[complete.sessionId] = complete;
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('mimo-end-meeting-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').put(older); tx.objectStore('jobs').put(complete); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        window.emit('END_STATE', { job: window.job });
      });
      const others = page.locator('#end-meeting-panel .end-other');
      await others.getByText('Other unsaved meetings (1)', { exact: true }).waitFor();
      await others.locator('summary').click();
      check('only an unfinished prior result is offered', await others.getByRole('button').count() === 1);
      check('completed bundles stay outside the pending list', !await others.getByText('Already saved meeting', { exact: false }).count());
      await page.screenshot({ path: path.join(artifact, 'other-unsaved-meetings.png') }); captures.push('other-unsaved-meetings.png');
      await others.getByRole('button', { name: /Earlier unsaved meeting/ }).click();
      await page.getByText('Earlier meeting notes remain available.', { exact: true }).waitFor();
      check('explicit idle selection opens an older result', await page.locator('.end-bullets').innerText() === 'Earlier meeting notes remain available.\n\nSources');
      await page.evaluate(() => window.emit('END_STATE', { job: window.job }));
      check('latest-session automatic updates do not steal selected older reader', (await page.locator('.end-bullets').innerText()).includes('Earlier meeting notes'));
      await page.locator('.end-sources').first().click();
      check('older MoM sources use its own transcript snapshot', (await page.locator('#transcript-feed').innerText()).includes('Earlier meeting evidence.'));
      await page.locator('#transcript-back').click();
      await page.evaluate(() => { window.recorderState = { phase: 'recording', session: { id: 'new-live', createdAt: Date.now(), sourceTitle: 'New live meeting', durationMs: 0 }, retained: [] }; window.emit('STATE', { status: window.recorderState }); window.emit('END_STATE', { job: window.jobs['older-unsaved'] }); });
      check('new recording closes explicit old reader and rejects late old events', !await page.locator('#end-meeting-panel').isVisible());
      await page.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('Cancelled for offline test', 'AbortError'); }; window.recorderState = { phase: 'idle', retained: [{ id: 'raw-interrupted', createdAt: Date.now() - 180000, sourceTitle: 'Interrupted audio', durationMs: 30000, bytes: 100, chunks: 1, status: 'capturing', filename: 'audio.webm', partial: true, tabId: 7, exportKind: 'meeting-bundle-v1' }] }; window.emit('STATE', { status: window.recorderState }); });
      await page.locator('#pending-meetings > summary').click();
      await page.getByRole('button', { name: 'Recover meeting files: Interrupted audio', exact: true }).click();
      await page.getByText('Recovered interrupted recording.', { exact: true }).waitFor();
      check('raw interrupted bundle exposes recovery without an existing job', await page.evaluate(() => window.calls.some((call) => call.type === 'END_MEETING' && call.sessionId === 'raw-interrupted')));
      check('recovering a retained row does not start or stop a different capture', await page.evaluate(() => !window.calls.some((call) => call.type === 'START' || call.type === 'STOP')));
      await page.screenshot({ path: path.join(artifact, 'recovered-interrupted-reader.png') }); captures.push('recovered-interrupted-reader.png');
      await page.close();
      continue;
    }
    check(name + ': three factual bullets', await page.locator('.end-bullets > li').count() === 3);
    check(name + ': live understanding hidden', !await page.locator('#analysis-panel').isVisible());
    check(name + ': live contribution hidden', !await page.locator('#contribution-view').isVisible());
    check(name + ': Stop hidden', !await page.locator('#stop').isVisible());
    check(name + ': three stable navigation destinations', await page.locator('#open-live').isVisible() && await page.locator('#open-transcript').isVisible() && await page.locator('#settings').isVisible());
    check(name + ': no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(name + ': footer labels fit each target', await page.locator('#session-controls .nav-button > span').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth)));
    await page.screenshot({ path: path.join(artifact, name + '-ready.png') }); captures.push(name + '-ready.png');
    if (name === 'daylight') {
      await page.locator('.end-sources').first().click();
      check('source opens transcript', await page.locator('#transcript-view').isVisible());
      check('source Back identifies meeting notes', await page.locator('#transcript-back').innerText() === 'Back to meeting notes');
      await page.locator('#transcript-back').click();
      check('source Back restores source focus', await page.locator('.end-sources').first().evaluate((el) => el === document.activeElement));
      await page.locator('.end-sources').first().evaluate((el) => { window.originalBullet = el; });
      await page.evaluate(() => { window.job.updatedAt++; window.job.files.audio.phase = 'saved'; window.emit('END_STATE', { job: window.job }); });
      check('save progress preserves reading DOM and focus', await page.locator('.end-sources').first().evaluate((el) => el === window.originalBullet && el === document.activeElement));
      await page.locator('#memo-character').click();
      check('Mimo cannot reopen old live contributions', !await page.locator('#contribution-view').isVisible() && await page.locator('#end-meeting-panel').isVisible());
      await page.evaluate(() => { window.job.updatedAt++; window.job.phase = 'generating'; delete window.job.minutes; window.emit('END_STATE', { job: window.job }); });
      check('processing has real-stage copy', (await page.locator('.end-status').innerText()).includes('whole conversation'));
      await page.screenshot({ path: path.join(artifact, 'processing.png') }); captures.push('processing.png');
      await page.evaluate(() => { window.job.updatedAt++; window.job.phase = 'failed'; window.job.error = 'The AI service did not finish. Your audio and transcript are retained.'; window.emit('END_STATE', { job: window.job }); });
      check('failed MoM has retry', await page.getByRole('button', { name: 'Retry meeting notes', exact: true }).isVisible());
      await page.locator('#memo-character').click();
      check('failed-state Mimo greeting does not claim notes exist', (await page.locator('#mimo-cue').textContent()).includes('need another try'));
      await page.screenshot({ path: path.join(artifact, 'failure.png') }); captures.push('failure.png');
      await page.evaluate(() => { window.job.updatedAt++; window.job.phase='empty'; window.job.minutes={protocol:1,language:'und',bullets:[],emptyReason:'No conversation was captured.'}; window.emit('END_STATE',{job:window.job}); });
      await page.locator('#memo-character').click();
      check('empty-state Mimo greeting reports insufficient conversation', (await page.locator('#mimo-cue').textContent()).includes('enough conversation'));
      await page.screenshot({ path: path.join(artifact, 'empty.png') }); captures.push('empty.png');
      await page.evaluate(() => { window.job.updatedAt++; for(const f of Object.values(window.job.files))f.phase='saved'; window.job.cleanupError='Temporary audio cleanup failed.'; window.emit('END_STATE',{job:window.job}); });
      check('completed files with failed local cleanup expose a retry', await page.getByRole('button',{name:'Retry saving',exact:true}).isVisible());
      await page.evaluate(() => { window.recorderState = { phase: 'recording', session: { id: 'new-recording', createdAt: Date.now(), durationMs: 0, sourceTitle: 'New meeting' }, retained: [] }; window.emit('STATE', { status: window.recorderState }); window.job.updatedAt++; window.emit('END_STATE', { job: window.job }); });
      check('old end-job cannot take over a new recording', !await page.locator('#end-meeting-panel').isVisible());
    }
    await page.close();
  }
  check('no page errors', errors.length === 0);
  check('no external requests', remote.length === 0);
} finally {
  await writeFile(path.join(artifact, 'result.json'), JSON.stringify({ checks, assertions: checks.length, captures, errors, remoteRequests: remote, paidProviderRequests: 0, nativeZoom: false, limitation: 'Synthetic UI backend. The compact210 case is a CSS viewport at 1×, not native Chrome 200% zoom. Native picker/provider/capture behavior is separate evidence.' }, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
console.log(JSON.stringify({ assertions: checks.length, captures: captures.length, errors }, null, 2));
