// Disposable native File System Access evidence. No app build, profile or relay is modified.
// The picker must be completed through the visible OS UI; no chooser/permission is mocked.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const artifact = path.resolve(
  process.env.LISTEN_FSA_ARTIFACT || 'artifacts/end-meeting-2026-11-02/fsa-proof',
);
await mkdir(artifact, { recursive: true });
const extension = path.join(artifact, 'extension');
const output = path.join(artifact, 'chosen-output');
await mkdir(extension, { recursive: true });
await mkdir(output, { recursive: true });
const shared = `
export const db = () => new Promise((resolve,reject) => {
  const r=indexedDB.open('mimo-fsa-native-proof',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('proof');
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
});
export async function get(key){const d=await db();return new Promise((res,rej)=>{const r=d.transaction('proof').objectStore('proof').get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
export async function put(key,value){const d=await db();return new Promise((res,rej)=>{const tx=d.transaction('proof','readwrite');tx.objectStore('proof').put(value,key);tx.oncomplete=res;tx.onabort=()=>rej(tx.error);});}
`;
await writeFile(path.join(extension, 'shared.js'), shared);
await writeFile(
  path.join(extension, 'manifest.json'),
  JSON.stringify(
    {
      manifest_version: 3,
      name: 'Mimo isolated native folder proof',
      version: '1.0',
      permissions: ['offscreen', 'sidePanel'],
      background: { service_worker: 'worker.js', type: 'module' },
      action: { default_popup: 'proof.html?mode=popup' },
      side_panel: { default_path: 'proof.html?mode=sidebar' },
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(extension, 'proof.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Mimo isolated native folder proof</title><style>body{font:18px system-ui;padding:32px;min-width:340px;}button{padding:14px;margin:8px 0;}pre{white-space:pre-wrap;}iframe{width:100%;height:200px;}</style></head><body><h1>Mimo native folder proof</h1><button id="pick">Choose test output folder</button><button id="background">Write after page closes</button><button id="permission">Restore write permission</button><button id="sidebar">Open actual side panel</button><pre id="status">Ready</pre><script type="module" src="proof.js"></script></body></html>`,
);
await writeFile(
  path.join(extension, 'frame.html'),
  '<!doctype html><html><head><title>Mimo same-origin frame proof</title></head><body><h1>Same-origin iframe</h1><iframe src="proof.html?mode=frame"></iframe></body></html>',
);
await writeFile(
  path.join(extension, 'proof.js'),
  `
import { get,put } from './shared.js';
const mode=new URLSearchParams(location.search).get('mode')||'top';
const status=document.querySelector('#status');
document.querySelector('#pick').onclick=()=>{
  const active=navigator.userActivation.isActive;
  const choice=showDirectoryPicker({mode:'readwrite',id:'mimo-native-proof'});
  status.textContent='Picker open: '+mode;
  choice.then(async handle=>{
    await put('destination',handle);
    const r={mode,active,kind:handle.kind,name:handle.name,permission:await handle.queryPermission({mode:'readwrite'})};
    await put('pick-'+mode,r); status.textContent=JSON.stringify(r);window.picked=r;
  }).catch(e=>{window.pickError={name:e.name,message:e.message};status.textContent=JSON.stringify(window.pickError);});
};
document.querySelector('#background').onclick=async()=>{status.textContent='Background write requested';await chrome.runtime.sendMessage({type:'WRITE',mode});};
document.querySelector('#permission').onclick=async()=>{const h=await get('destination');const result=await h.requestPermission({mode:'readwrite'});await put('restoredPermission',result);status.textContent=result;};
document.querySelector('#sidebar').onclick=async()=>{await chrome.sidePanel.open({windowId:(await chrome.windows.getCurrent()).id});};
window.proofGet=get;
`,
);
await writeFile(
  path.join(extension, 'offscreen.html'),
  '<!doctype html><script type="module" src="offscreen.js"></script>',
);
await writeFile(
  path.join(extension, 'offscreen.js'),
  `
import {get,put} from './shared.js';
chrome.runtime.onMessage.addListener((m,s,respond)=>{
 if(m.target!=='offscreen')return;
 (async()=>{
  await new Promise(r=>setTimeout(r,1500));
  const dir=await get('destination');
  const permission=await dir.queryPermission({mode:'readwrite'});
  if(permission!=='granted') throw Error('Permission '+permission);
  const child=await dir.getDirectoryHandle('background-'+m.mode,{create:true});
  for(const [name,text] of [['audio-proof.webm','synthetic bytes, not media'],['mom.txt','- Native directory handle survived page closure.\n'],['transcript.txt','[00:00:00] Synthetic local proof.\n']]){
    const file=await child.getFileHandle(name,{create:true});
    const w=await file.createWritable();await w.write(text);await w.close();
  }
  const result={mode:m.mode,permission,files:['audio-proof.webm','mom.txt','transcript.txt'],at:Date.now()};
  await put('write-'+m.mode,result);return result;
 })().then(v=>respond({ok:true,value:v})).catch(async e=>{await put('write-error',{message:e.message});respond({ok:false,error:e.message});});
 return true;
});
`,
);
await writeFile(
  path.join(extension, 'worker.js'),
  `
chrome.runtime.onMessage.addListener((m,s,respond)=>{
 if(m.type!=='WRITE')return;
 (async()=>{
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if(!contexts.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Write disposable native folder proof files.'});
  return chrome.runtime.sendMessage({target:'offscreen',mode:m.mode});
 })().then(respond).catch(e=>respond({ok:false,error:e.message}));return true;
});
`,
);

const profile = await mkdtemp(path.join(artifact, 'profile-'));
const report = {
  checks: [],
  screenshots: [],
  errors: [],
  externalRequests: [],
  output,
  profile,
  startedAt: new Date().toISOString(),
  nativeChooser: true,
  mockHandles: false,
};
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
  console.log('PASS: ' + name);
};
let context;
let browserSession;
let page;
let id;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    viewport: { width: 900, height: 720 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  await context.route(/^https?:\/\//, (route) => {
    report.externalRequests.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  browserSession = await context.browser().newBrowserCDPSession();
  ({ id } = await browserSession.send('Extensions.loadUnpacked', { path: extension }));
  page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto('chrome-extension://' + id + '/proof.html?mode=top');
  await page.bringToFront();
}
async function save() {
  await writeFile(path.join(artifact, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
try {
  await launch();
  console.log('SELECT_THIS_DIRECTORY=' + output);
  check(
    'Actual Chrome exposes the native directory picker',
    await page.evaluate(() => typeof showDirectoryPicker === 'function'),
  );
  await writeFile(
    path.join(artifact, 'ready.json'),
    JSON.stringify({ id, output, profile, url: page.url() }, null, 2),
  );
  if (process.env.LISTEN_FSA_MANUAL !== '1') await page.locator('#pick').click();
  console.log('NATIVE_PICKER_OPEN_TOP');
  await page.waitForFunction(() => window.picked || window.pickError, {}, { timeout: 180000 });
  const picked = await page.evaluate(() => ({ picked: window.picked, error: window.pickError }));
  assert.ok(picked.picked, JSON.stringify(picked));
  check(
    'Trusted top-level extension click chooses a real readwrite directory',
    picked.picked.active &&
      picked.picked.permission === 'granted' &&
      picked.picked.name === 'chosen-output',
  );
  await page.screenshot({ path: path.join(artifact, 'top-picked.png') });
  report.screenshots.push('top-picked.png');
  await page.locator('#background').click({ noWaitAfter: true });
  await page.close();
  page = await context.newPage();
  await page.goto('chrome-extension://' + id + '/proof.html?mode=observer');
  await page.waitForFunction(
    async () => !!(await window.proofGet('write-top')),
    {},
    { timeout: 15000 },
  );
  check(
    'Offscreen writes all three files after the choosing page closes',
    (await readdir(path.join(output, 'background-top'))).length === 3,
  );
  check(
    'Native chosen-directory file content is readable outside Chrome',
    (await readFile(path.join(output, 'background-top', 'mom.txt'), 'utf8')).includes(
      'survived page closure',
    ),
  );
  await page.goto('chrome-extension://' + id + '/frame.html');
  const frame = page.frameLocator('iframe');
  await frame.locator('#pick').click();
  console.log('NATIVE_PICKER_OPEN_FRAME');
  await page
    .frame({ url: /proof\.html\?mode=frame/ })
    .waitForFunction(() => window.picked || window.pickError, {}, { timeout: 180000 });
  const framePicked = await page
    .frame({ url: /proof\.html\?mode=frame/ })
    .evaluate(() => ({ picked: window.picked, error: window.pickError }));
  assert.ok(framePicked.picked, JSON.stringify(framePicked));
  check(
    'Same-origin extension iframe can choose a real output directory',
    framePicked.picked.permission === 'granted' && framePicked.picked.mode === 'frame',
  );
  await page.screenshot({ path: path.join(artifact, 'frame-picked.png') });
  report.screenshots.push('frame-picked.png');
  await context.close();
  context = undefined;
  await launch();
  const restored = await page.evaluate(async () => {
    const h = await window.proofGet('destination');
    return (
      h && {
        kind: h.kind,
        name: h.name,
        permission: await h.queryPermission({ mode: 'readwrite' }),
      }
    );
  });
  check(
    'Real native directory handle survives complete Chrome restart',
    restored?.kind === 'directory' && restored.name === 'chosen-output',
  );
  report.restoredPermission = restored.permission;
  check('No provider or external HTTP requests were made', report.externalRequests.length === 0);
  check('Proof pages have no JavaScript errors', report.errors.length === 0);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.failure = e.stack;
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  await save();
  await context?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
