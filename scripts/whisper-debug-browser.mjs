// Exact PCM replay; no LLM requests. Based on existing transcription-gate harness.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function withWhisperDebug(run, { decoderDtype = 'q4', replacement = null, prepareTimeoutMs = 300000 } = {}) {
  if (!['q4', 'fp32'].includes(decoderDtype)) throw Error('Unsupported evaluation precision');
  const build = path.resolve('artifacts/notes-latency-evaluation-build');
  const buildLock = await open(build + '.lock', 'wx');
  await cp('dist', build, { recursive: true });
  const modelWorker = await readFile('dist/transcription/model-worker.js', 'utf8');
  if (!modelWorker.includes('async function prepare()')) throw Error('Observer hook needs review');
  const observer = await readFile('scripts/whisper-debug-worker.js', 'utf8');
  const modelWorkerHash = createHash('sha256').update(modelWorker).digest('hex');
  const observerHash = createHash('sha256').update(observer).digest('hex');
  const needle = 'dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }';
  if (decoderDtype !== 'q4' && modelWorker.split(needle).length !== 2)
    throw Error('Precision experiment needs review for this build');
  let evaluationWorker =
    decoderDtype === 'q4'
      ? modelWorker
      : modelWorker.replace(
          needle,
          'dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" }',
        );
  if (replacement) {
    const substitutions = [
      ['onnx-community/whisper-base', replacement.model],
      ['1846881b6b3a3024392c1eea3ad983695bc23925', replacement.revision],
      ['encoder_model: "fp32"', `encoder_model: "${replacement.encoderDtype}"`],
    ];
    for (const [before, after] of substitutions) {
      if (evaluationWorker.split(before).length !== 2) throw Error('Replacement experiment needs review: ' + before);
      evaluationWorker = evaluationWorker.replace(before, after);
    }
    const languageChoice = 'language = scores[config.lang_to_id["<|id|>"]] > scores[config.lang_to_id["<|en|>"]] ? "id" : "en";';
    if (evaluationWorker.split(languageChoice).length !== 2)
      throw Error('Replacement language experiment needs review');
    evaluationWorker = evaluationWorker.replace(languageChoice,
      'language = ["id", "en", "zh"].reduce((best, lang) => scores[config.lang_to_id["<|" + lang + "|>"]] > scores[config.lang_to_id["<|" + best + "|>"]] ? lang : best, "id");');
    if (replacement.localAssets) {
      const localFlag = 'env.allowLocalModels = false;';
      if (evaluationWorker.split(localFlag).length !== 2) throw Error('Local model staging needs review');
      evaluationWorker = evaluationWorker.replace(localFlag,
        'env.allowLocalModels = true; env.allowRemoteModels = false; env.localModelPath = new URL("../models/", self.location.href).href;');
      await cp(replacement.localAssets, path.join(build, 'models', replacement.model), { recursive: true });
    }
  }
  const evaluationWorkerHash = createHash('sha256').update(evaluationWorker).digest('hex');
  await writeFile(
    path.join(build, 'transcription/model-worker.js'),
    evaluationWorker + '\n' + observer,
  );
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
  await mkdir('artifacts', { recursive: true });
  // Reuse model data, never stale extension registrations or disabled preferences.
  const cacheRoot = path.resolve('artifacts/transcription-gate-profile');
  const profile = await mkdtemp(path.resolve('artifacts/transcription-gate-'));
  const cacheParts = ['Default/Service Worker/CacheStorage', 'Default/WebStorage'];
  for (const part of cacheParts) {
    await mkdir(path.dirname(path.join(profile, part)), { recursive: true });
    await cp(path.join(cacheRoot, part), path.join(profile, part), { recursive: true }).catch(
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }

  const context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const root = await context.browser().newBrowserCDPSession();
    await root.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
    const { id } = await root.send('Extensions.loadUnpacked', { path: build });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/setup.html`);
    await page.evaluate(async () => {
      // No transcription preference is enabled in this isolated profile, so the
      // production service worker cannot race us with automatic model restoration.
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts.length)
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA', 'BLOBS'],
          justification: 'Replay locally captured PCM through the existing recognizer',
        });
    });
    let target;
    for (let n = 0; n < 50 && !target; n++) {
      const { targetInfos } = await root.send('Target.getTargets');
      target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
      if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!target) throw Error('Offscreen document was not created');
    const { sessionId } = await root.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: false,
    });
    let nextId = 0;
    root.on('Target.receivedMessageFromTarget', (e) => {
      if (e.sessionId !== sessionId) return;
      const m = JSON.parse(e.message);
      if (m.method === 'Runtime.consoleAPICalled')
        console.log('Browser:', m.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    async function evaluate(expression, timeoutMs = 45000) {
      const requestId = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          root.off('Target.receivedMessageFromTarget', listener);
          reject(Error('ASR replay target evaluation timed out'));
        }, timeoutMs);
        const listener = (e) => {
          if (e.sessionId !== sessionId) return;
          const m = JSON.parse(e.message);
          if (m.id !== requestId) return;
          clearTimeout(timer);
          root.off('Target.receivedMessageFromTarget', listener);
          if (m.error || m.result?.exceptionDetails)
            reject(Error(JSON.stringify(m.error ?? m.result.exceptionDetails)));
          else resolve(m.result?.result?.value);
        };
        root.on('Target.receivedMessageFromTarget', listener);
      });
      await root.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({
          id: requestId,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      });
      return response;
    }
    await evaluate(`(()=>{
  window.gateWorker=new Worker(new URL('transcription/model-worker.js',location.href),{type:'module'});
  let id=0;const pending=new Map();
  window.debugGenerations=[];gateWorker.onmessage=({data})=>{if(data.type==='ASR_DEBUG'){window.debugGenerations.push(data.detail);return;}if(data.type==='PROGRESS'){if(['initiate','done','warmup'].includes(data.progress.status))console.log(JSON.stringify(data.progress));return;}const p=pending.get(data.requestId);if(p){pending.delete(data.requestId);data.type==='ERROR'?p.reject(Error(data.error)):p.resolve(data);}};
  gateWorker.onerror=e=>{console.error(e.message);for(const p of pending.values())p.reject(Error(e.message));pending.clear();};
  window.gateRequest=(type,extra={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});gateWorker.postMessage({type,requestId,...extra});});
 })()`);
    await root.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id: 9999, method: 'Runtime.enable' }),
    });
    console.log('Preparing model in offscreen document…');
    const load = await evaluate(`gateRequest('PREPARE')`, prepareTimeoutMs);
    console.log('Model ready:', JSON.stringify(load));
    return await run({
      evaluate,
      load,
      context,
      modelWorkerHash,
      observerHash,
      evaluationWorkerHash,
      decoderDtype,
    });
  } finally {
    await context.close();
    for (const part of cacheParts) {
      await mkdir(path.dirname(path.join(cacheRoot, part)), { recursive: true });
      await cp(path.join(profile, part), path.join(cacheRoot, part), { recursive: true }).catch(
        () => {},
      );
    }
    await rm(profile, { recursive: true, force: true });
    await rm(build, { recursive: true, force: true });
    await buildLock.close();
    await rm(build + '.lock', { force: true });
  }
}
