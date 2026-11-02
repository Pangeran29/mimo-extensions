import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LiveRequestLedger } from './replay-lab-live-run.mjs';

test('parallel ASR/LLM reservations cannot exceed the shared cap and are persisted before permission returns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memo-live-ledger-'));
  try {
    const file = path.join(dir, 'budget.json');
    const ledger = new LiveRequestLedger(file, 3, { test: true });
    await ledger.initialize();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => ledger.reserve(i % 2 ? 'PROPOSE' : 'ASR')),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(ledger.count, 3);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(
      saved.attempts.map((row) => row.attempt),
      [1, 2, 3],
    );
    assert.equal(saved.blocked, true);
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.reason.code === 'REPLAY_BUDGET_EXHAUSTED'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed and aborted attempts still consume their reservations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memo-live-ledger-'));
  try {
    const ledger = new LiveRequestLedger(path.join(dir, 'budget.json'), 2, { test: true });
    await ledger.initialize();
    const first = await ledger.reserve('ASR');
    const persisted = JSON.parse(await readFile(ledger.file, 'utf8'));
    assert.equal(persisted.attempts[0].outcome, 'reserved');
    await ledger.finish(first, { outcome: 'failed-or-aborted', errorName: 'AbortError' });
    const second = await ledger.reserve('REVIEW');
    await ledger.finish(second, { outcome: 'headers-received', status: 503 });
    await assert.rejects(ledger.reserve('ASR'), { code: 'REPLAY_BUDGET_EXHAUSTED' });
    assert.equal(ledger.count, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed ledger write fails closed for subsequent provider reservations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'memo-live-ledger-'));
  try {
    const file = path.join(dir, 'budget.json');
    const ledger = new LiveRequestLedger(file, 4, { test: true });
    await ledger.initialize();
    ledger.file = path.join(dir, 'missing', 'budget.json');
    await assert.rejects(ledger.reserve('ASR'));
    ledger.file = file;
    await assert.rejects(ledger.reserve('PROPOSE'), /no further provider calls permitted/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).attempts.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
