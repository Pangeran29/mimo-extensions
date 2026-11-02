// Local-only visual review harness: synthetic state, no key, model download, or API call.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const smoke = await readFile('scripts/settings-smoke.mjs', 'utf8');
const start =
  smoke.indexOf('await p.addInitScript(() => {') + 'await p.addInitScript(() => {'.length;
const end = smoke.indexOf('\n  });\n  await p.goto', start);
const mock = smoke
  .slice(start, end)
  .replace('hasKey: false', 'hasKey: false')
  .replace('enabled: false', 'enabled: true')
  .replace("state: 'prompt'", "state: 'granted'")
  .replace("phase: 'unavailable'", "phase: 'ready'")
  .replace('modelReady: false', 'modelReady: true');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/comparison.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<html><body style="margin:0;background:#fff"><iframe src="/setup.html" style="position:absolute;left:147px;top:17px;width:360px;height:684px;transform:scale(1.5333);transform-origin:top left;border:1px solid #e6e9ed;border-radius:3px"></iframe><iframe src="/setup.html?editor=1" style="position:absolute;left:750px;top:17px;width:360px;height:684px;transform:scale(1.5333);transform-origin:top left;border:1px solid #e6e9ed;border-radius:3px"></iframe></body></html>`,
    );
    return;
  }
  let file = path.basename(url.pathname) || 'setup.html';
  try {
    let content = await readFile(path.join('dist', file));
    if (file === 'setup.html')
      content = Buffer.from(
        content
          .toString()
          .replace(
            '<script type="module" src="setup.js">',
            `<script>${mock}; if (location.search.includes("editor=1")) addEventListener("load",()=>document.getElementById("open-ai").click());</script><script type="module" src="setup.js">`,
          ),
      );
    res.setHeader(
      'Content-Type',
      file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html',
    );
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(4318, '127.0.0.1', () =>
  console.log('Settings review: http://127.0.0.1:4318/setup.html (stop: Ctrl-C)'),
);
