// Bounded comparison of native directory picker invocation in extension and localhost contexts.
// Any failure is evidence of that browser/environment, never a simulated picker pass.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const artifact = path.resolve(
  process.env.LISTEN_FSA_PROBE_ARTIFACT || 'artifacts/end-meeting-2026-11-02/fsa-context-probe',
);
await mkdir(artifact, { recursive: true });
const extension = path.join(artifact, 'extension');
await mkdir(extension, { recursive: true });
const script = `
 const button=document.querySelector('button');
 button.onclick=()=>{
  window.probe={active:navigator.userActivation.isActive,secure:isSecureContext,focused:document.hasFocus(),visibility:document.visibilityState,href:location.href,started:Date.now()};
  const p=showDirectoryPicker({mode:'readwrite',startIn:'downloads',id:'mimo-probe'});
  p.then(h=>{window.probe.result={kind:h.kind,name:h.name};window.finished=true;document.querySelector('pre').textContent=JSON.stringify(window.probe);}).catch(e=>{window.probe.error={name:e.name,message:e.message};window.finished=true;document.querySelector('pre').textContent=JSON.stringify(window.probe);});
 };
`;
const html =
  '<!doctype html><html><head><title>Mimo isolated picker context probe</title></head><body><h1>Mimo isolated picker context probe</h1><button>Choose test directory</button><pre>Ready</pre><script src="probe.js"></script></body></html>';
await writeFile(
  path.join(extension, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Mimo isolated picker context probe',
    version: '1.0',
  }),
);
await writeFile(path.join(extension, 'probe.html'), html);
await writeFile(path.join(extension, 'probe.js'), script);
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/probe.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/probe.js' ? script : html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const profile = await mkdtemp(path.join(artifact, 'profile-'));
const report = { native: true, mocked: false, results: [], errors: [] };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 900, height: 720 },
  });
  report.browser = await context.browser().version();
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: extension });
  for (const [name, url] of [
    ['extension', 'chrome-extension://' + id + '/probe.html'],
    ['localhost', origin + '/probe.html'],
  ]) {
    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
    await page.locator('button').click();
    try {
      await page.waitForFunction(() => window.finished, {}, { timeout: 15000 });
    } catch {
      report.errors.push(name + ': chooser remained open; native selection required');
    }
    const result = await page.evaluate(() => window.probe);
    report.results.push({ context: name, ...result });
    await page.screenshot({ path: path.join(artifact, name + '.png') });
    console.log(JSON.stringify({ context: name, ...result }));
    await page.close();
  }
} catch (e) {
  report.errors.push(e.stack);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifact, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await context?.close().catch(() => {});
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
