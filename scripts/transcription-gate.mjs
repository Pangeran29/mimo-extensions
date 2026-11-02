import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
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
  const { id } = await root.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/setup.html`);
  await page.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length)
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'WORKERS'],
        justification: 'Validate local recognition before integration',
      });
  });
  const { targetInfos } = await root.send('Target.getTargets');
  const target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
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
  async function evaluate(expression) {
    const requestId = ++nextId;
    const response = new Promise((resolve, reject) => {
      const listener = (e) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message);
        if (m.id !== requestId) return;
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
  gateWorker.onmessage=({data})=>{if(data.type==='PROGRESS'){if(['initiate','done','warmup'].includes(data.progress.status))console.log(JSON.stringify(data.progress));return;}const p=pending.get(data.requestId);if(p){pending.delete(data.requestId);data.type==='ERROR'?p.reject(Error(data.error)):p.resolve(data);}};
  gateWorker.onerror=e=>{console.error(e.message);for(const p of pending.values())p.reject(Error(e.message));pending.clear();};
  window.gateRequest=(type,extra={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});gateWorker.postMessage({type,requestId,...extra});});
 })()`);
  await root.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: 9999, method: 'Runtime.enable' }),
  });
  console.log('Preparing model in offscreen document…');
  const load = await evaluate(`gateRequest('PREPARE')`);
  console.log('Model ready:', JSON.stringify(load));
  const fixtures = JSON.parse(await readFile('artifacts/speech/manifest.json', 'utf8'));
  const results = [];
  await evaluate(
    `(()=>{window.gateAudio=new AudioContext();const d=gateAudio.createMediaStreamDestination();const o=gateAudio.createOscillator();const g=gateAudio.createGain();g.gain.value=0;o.connect(g).connect(d);o.start();window.gateEncoders=Array.from({length:3},()=>{const r=new MediaRecorder(d.stream,{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:96000});r.ondataavailable=()=>{};r.start(1000);return r;});})()`,
  );
  for (const fixture of fixtures) {
    const b64 = (await readFile(fixture.file)).toString('base64');
    const result =
      await evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));const c=new AudioContext({sampleRate:16000});const decoded=await c.decodeAudioData(bytes.buffer);const audio=decoded.getChannelData(0);const windows=[];let merged='';
    for(let start=0;start<audio.length;start+=7*16000){
      if(start>0&&audio.length-start<1600)break;
      const pcm=audio.slice(start,Math.min(start+8*16000,audio.length));
      const output=await gateRequest('TRANSCRIBE',{audio:pcm,sessionId:'gate'});windows.push(output);
      const before=merged.split(/\\s+/);const words=output.text.split(/\\s+/);const norm=w=>w.toLowerCase().replace(/[^\\p{L}\\p{N}]/gu,'');let overlap=0;
      if(start)for(let n=1;n<=Math.min(20,before.length,words.length);n++)if(before.slice(-n).map(norm).join(' ')===words.slice(0,n).map(norm).join(' '))overlap=n;
      merged=[merged,...words.slice(overlap)].filter(Boolean).join(' ');
      if(start+8*16000>=audio.length)break;
    }
    await c.close();return {text:merged,inferenceMs:windows.reduce((sum,w)=>sum+w.inferenceMs,0),windows};})()`);
    console.log(fixture.id, JSON.stringify(result));
    results.push({
      ...fixture,
      ...result,
      realTimeFactor: result.inferenceMs / (fixture.seconds * 1000),
    });
  }
  await writeFile(
    'artifacts/transcription-gate.json',
    JSON.stringify({ browser: context.browser().version(), load, results }, null, 2),
  );
  console.log('Gate report written. Evaluate accuracy before integrating.');
} finally {
  await context.close();
  for (const part of cacheParts) {
    await mkdir(path.dirname(path.join(cacheRoot, part)), { recursive: true });
    await cp(path.join(profile, part), path.join(cacheRoot, part), { recursive: true }).catch(
      () => {},
    );
  }
  await rm(profile, { recursive: true, force: true });
}
