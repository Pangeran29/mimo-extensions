// No key, model, microphone, or meeting data is needed for this UI lifecycle check.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LISTEN_PLAYWRIGHT_PATH || 'playwright');
const profile = await mkdtemp(path.join(tmpdir(), 'listen-panel-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.LISTEN_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: !process.env.LISTEN_HEADED,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const root = await context.browser().newBrowserCDPSession();
  const { id } = await root.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/setup.html`);
  const source = await context.newPage();
  await source.goto('https://example.com');
  await source.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'meeting-notes';
    input.placeholder = 'Meeting notes';
    document.body.append(input);
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await source.bringToFront();
  await popup.reload();
  // The simplified idle popup offers Settings; first-run setup can open Assistant directly.
  await setup.locator('#finish').click();
  let panelContexts = [];
  for (let i = 0; i < 50; i++) {
    panelContexts = await setup.evaluate(() =>
      chrome.runtime
        .getContexts({ contextTypes: ['SIDE_PANEL'] })
        .then((rows) => rows.filter((row) => row.documentUrl?.endsWith('/assistant.html'))),
    );
    if (panelContexts.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (panelContexts.length !== 1)
    throw Error('Expected one assistant side panel; found ' + panelContexts.length);
  await source.bringToFront();
  await source.locator('#meeting-notes').fill('Taking notes while the assistant stays open');
  const remaining = await setup.evaluate(() =>
    chrome.runtime
      .getContexts({ contextTypes: ['SIDE_PANEL'] })
      .then((rows) => rows.filter((row) => row.documentUrl?.endsWith('/assistant.html'))),
  );
  if (remaining.length !== 1 || remaining[0].documentId !== panelContexts[0].documentId)
    throw Error('Panel disappeared or reloaded while interacting with source tab');
  const other = await context.newPage();
  await other.goto('https://example.com/?another-tab');
  await other.bringToFront();
  const afterSwitch = await setup.evaluate(() =>
    chrome.runtime
      .getContexts({ contextTypes: ['SIDE_PANEL'] })
      .then((rows) => rows.filter((row) => row.documentUrl?.endsWith('/assistant.html'))),
  );
  if (afterSwitch.length !== 1) throw Error('Global assistant panel did not persist across tabs');
  const windows = await setup.evaluate(() => chrome.windows.getAll());
  if (windows.some((w) => w.type === 'popup'))
    throw Error('Assistant opened a floating popup window');
  const { targetInfos } = await root.send('Target.getTargets');
  const target = targetInfos.find((t) => t.url.endsWith('/assistant.html'));
  if (!target) throw Error('Assistant panel target missing');
  const { sessionId } = await root.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  });
  let serial = 0;
  async function panelEvaluate(expression) {
    const id = ++serial;
    const response = new Promise((resolve, reject) => {
      const listener = (e) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message);
        if (m.id !== id) return;
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
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    });
    return response;
  }
  await panelEvaluate("document.getElementById('settings').click()");
  let settingsReady = false;
  for (let i = 0; i < 50; i++) {
    settingsReady = await panelEvaluate(
      "document.getElementById('settings-frame').contentDocument?.querySelector('h1')?.textContent==='Settings'",
    );
    if (settingsReady) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!settingsReady) throw Error('Settings did not open inside panel');
  await panelEvaluate(
    "(()=>{const d=document.getElementById('settings-frame').contentDocument;d.getElementById('open-defaults').click();const goal=d.getElementById('ai-goal');goal.value='Docked settings smoke';goal.dispatchEvent(new Event('input',{bubbles:true}));d.getElementById('defaults-save').click();})()",
  );
  let saved = false;
  for (let i = 0; i < 50; i++) {
    saved = await setup.evaluate(
      async () =>
        (await chrome.storage.local.get('assistantSettings')).assistantSettings?.goal ===
        'Docked settings smoke',
    );
    if (saved) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!saved) throw Error('Docked settings could not save preferences');
  await panelEvaluate("document.getElementById('settings').click()");
  if (
    !(await panelEvaluate(
      "(!document.getElementById('idle-view').hidden || !document.getElementById('assistant-view').hidden) && document.getElementById('settings-frame').hidden",
    ))
  )
    throw Error('Back to Assistant failed');
  const settingsPopup = await context.newPage();
  await settingsPopup.goto(`chrome-extension://${id}/popup.html`);
  await source.bringToFront();
  await settingsPopup.reload();
  await settingsPopup.locator('#settings').click();
  let popupSettings = false;
  for (let i = 0; i < 50; i++) {
    popupSettings = await panelEvaluate("!document.getElementById('settings-frame').hidden");
    if (popupSettings) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!popupSettings) throw Error('Popup Settings did not route into the docked panel');
  const afterSettings = await setup.evaluate(() =>
    chrome.runtime
      .getContexts({ contextTypes: ['SIDE_PANEL'] })
      .then((rows) => rows.filter((row) => row.documentUrl?.endsWith('/assistant.html'))),
  );
  if (afterSettings.length !== 1 || afterSettings[0].documentId !== panelContexts[0].documentId)
    throw Error('Settings replaced or duplicated the assistant panel');
  await source.locator('#meeting-notes').fill('Still working with docked settings open');
  // A fresh profile has no mic/model/AI setup. Listen must refuse capture,
  // open the existing panel's Settings view, and show an actionable warning.
  await panelEvaluate("document.getElementById('settings').click()");
  await source.bringToFront();
  const { targetInfos: healthTargets } = await root.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const healthSource = healthTargets.find((target) => target.url === source.url());
  if (!healthSource) throw Error('Health check source tab missing');
  await root.send('Extensions.triggerAction', { id, targetId: healthSource.targetId });
  await panelEvaluate("window.dispatchEvent(new Event('focus'))");
  let canStart = false;
  for (let i = 0; i < 50; i++) {
    canStart = await panelEvaluate(
      "!document.getElementById('idle-view').hidden && !document.getElementById('start').disabled && document.getElementById('assistant-view').hidden",
    );
    if (canStart) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!canStart) throw Error('Idle side panel did not offer Listen for the active website');
  await panelEvaluate("document.getElementById('start').click()");
  let warned = false;
  for (let i = 0; i < 60; i++) {
    warned = await panelEvaluate(`(()=>{
      const frame=document.getElementById('settings-frame');
      const warning=frame.contentDocument?.getElementById('overview-feedback');
      return !frame.hidden && warning && !warning.hidden && warning.textContent.includes('Before listening');
    })()`);
    if (warned) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!warned) throw Error('Missing setup did not open Settings with a warning');
  if (await panelEvaluate("document.getElementById('ai-alert').getBoundingClientRect().height > 0"))
    throw Error('Settings duplicated its inline warning in the host notification');
  const healthStatus = await setup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'worker', type: 'STATUS' }),
  );
  if (healthStatus.value?.phase !== 'idle' || healthStatus.value?.session)
    throw Error('Unhealthy setup started recording');
  const report = {
    browser: context.browser().version(),
    sessionHealthWarning: true,
    settingsWarningInlineOnly: true,
    idleListenStartsThroughHealthGate: true,
    unhealthyStartBlocked: true,
    onePanel: true,
    settingsInsidePanel: true,
    settingsSave: true,
    backToAssistant: true,
    popupSettingsUsesSamePanel: true,
    pageInteractionPreservesDocument: true,
    tabSwitchPreservesPanel: true,
    noFloatingWindow: true,
    panelContexts,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/assistant-panel-smoke.json', JSON.stringify(report, null, 2));
  console.log('Assistant side panel passed:', JSON.stringify(report));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
