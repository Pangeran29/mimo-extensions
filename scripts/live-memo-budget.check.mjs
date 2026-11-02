import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const moduleUrl = pathToFileURL(path.resolve('scripts/live-memo-budget.mjs')).href;
test('the shared ledger serializes concurrent reservations and fails closed at 800', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'listen-budget-test-'));
  try {
    const dir = path.join(cwd, 'artifacts/live-memo-v1');
    await mkdir(dir, { recursive: true });
    await writeFile(
      dir + '/provider-budget.json',
      JSON.stringify({
        limit: 800,
        attempts: Array.from({ length: 797 }, () => ({ kind: 'test-seed' })),
      }),
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {reserveLiveMemoRequest} from ${JSON.stringify(moduleUrl)};const results=await Promise.allSettled(Array.from({length:6},()=>reserveLiveMemoRequest('test')));console.log(JSON.stringify(results.map(r=>r.status)));`,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout);
    assert.equal(results.filter((s) => s === 'fulfilled').length, 3);
    assert.equal(results.filter((s) => s === 'rejected').length, 3);
    assert.equal(
      JSON.parse(await readFile(dir + '/provider-budget.json', 'utf8')).attempts.length,
      800,
    );
    await writeFile(dir + '/provider-budget.json', 'invalid ledger');
    const invalid = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {reserveLiveMemoRequest} from ${JSON.stringify(moduleUrl)};await reserveLiveMemoRequest('test');`,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.notEqual(invalid.status, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
