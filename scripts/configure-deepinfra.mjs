import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.includes('\n')) break;
}
const apiKey = input.trim();
if (!apiKey || apiKey.length > 512) throw new Error('Expected a key on stdin.');
await mkdir('.local', { recursive: true, mode: 0o700 });
await writeFile(
  '.local/deepinfra.json',
  JSON.stringify({ apiKey, relayToken: randomBytes(32).toString('hex') }),
  { mode: 0o600, flag: 'wx' },
);
await chmod('.local/deepinfra.json', 0o600);
console.log(
  'Backend credential configured locally. Rebuild the extension to pair it with this relay.',
);
