// Offline safety/analysis verification: never calls a provider or opens personal profiles.
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reserveRequest, budgetStatus } from './notes-latency-budget.mjs';
const dir = await mkdtemp(path.join(tmpdir(), 'listen-eval-tools-'));
const run = (args) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
try {
  // Verify the evaluation prefix cannot send an offline or denied request.
  const sent = [],
    nativeCalls = [];
  let receive;
  const scope = {
    Response,
    setTimeout,
    clearTimeout,
    Error,
    Map,
    JSON,
    fetch: async (...args) => {
      nativeCalls.push(args);
      return new Response('native');
    },
    self: {
      addEventListener: (_name, fn) => {
        receive = fn;
      },
      postMessage: (message) => sent.push(message),
    },
  };
  runInNewContext(await readFile('scripts/notes-latency-network-gate.js', 'utf8'), scope);
  const options = {
    body: JSON.stringify({ messages: [{ content: 'evidence' }] }),
    headers: { authorization: 'private-test-key' },
  };
  let response = scope.fetch('https://hpop.ai/v1/messages', options);
  assert(!JSON.stringify(sent).includes('private-test-key'));
  receive({
    data: {
      type: 'EVALUATION_FETCH_REPLY',
      id: sent.at(-1).id,
      reply: { allowed: true, offline: true, body: 'synthetic' },
    },
    stopImmediatePropagation() {},
  });
  assert.equal(await (await response).text(), 'synthetic');
  assert.equal(nativeCalls.length, 0);
  response = scope.fetch('https://hpop.ai/v1/messages', options);
  receive({
    data: { type: 'EVALUATION_FETCH_REPLY', id: sent.at(-1).id, reply: { allowed: false } },
    stopImmediatePropagation() {},
  });
  await assert.rejects(response, /budget exhausted/);
  assert.equal(nativeCalls.length, 0);
  response = scope.fetch('https://hpop.ai/v1/messages', options);
  receive({
    data: {
      type: 'EVALUATION_FETCH_REPLY',
      id: sent.at(-1).id,
      reply: { allowed: true, offline: false },
    },
    stopImmediatePropagation() {},
  });
  assert.equal(await (await response).text(), 'native');
  assert.equal(nativeCalls[0][1], options);
  const ledger = path.join(dir, 'budget.json');
  for (let i = 0; i < 100; i++) await reserveRequest(ledger, { tool: 'offline-unit-test' });
  await assert.rejects(reserveRequest(ledger), /cap reached/);
  assert.equal((await budgetStatus(ledger)).used, 100);
  await writeFile(ledger, JSON.stringify({ cap: 101, used: 0 }));
  await assert.rejects(reserveRequest(ledger), /Invalid budget/);
  const scenarios = [
    'podcast',
    'mixed-language',
    'corrections',
    'uncertainty',
    'silence/music',
    'unfinished',
    'short-turn',
    'continuous',
  ];
  const reports = [];
  for (let i = 0; i < 20; i++)
    for (const variant of ['baseline', 'short-first-note']) {
      const candidate = variant === 'short-first-note',
        at = candidate ? 10000 : 25000;
      const file = path.join(dir, `${i}-${variant}.json`);
      await writeFile(
        file,
        JSON.stringify({
          variant,
          source: 'private-audio',
          sourceHash: 'source',
          harnessHash: 'harness',
          evaluationGateHash: 'gate',
          buildHash: 'build',
          model: 'fixed',
          cohort: 'warmed',
          fixtureHash: `clip-${i}`,
          kind: 'measured',
          complete: true,
          droppedEvents: 0,
          clickAt: 1000,
          segments: [
            { id: 0, text: 'Supported launch proposal.', availableAt: 3000 },
            { id: 1, text: 'Future speech must be hidden.', availableAt: 5000 },
          ],
          revisions: [{ version: 1, memo: 'A launch was proposed.' }],
          events: [
            { name: 'ai.attempt', at: 2000, version: 1, requestId: 'failed-earlier-attempt' },
            { name: 'ai.attempt', at: 4000, version: 1, requestId: 'a' },
            { name: 'memo.committed', at: 1000 + at - 1, version: 1, requestId: 'a' },
            { name: 'memo.presentation_estimate', at: 1000 + at, version: 1 },
            { name: 'capture.stopped', at: 46000 },
          ],
        }),
      );
      reports.push(file);
    }
  const list = path.join(dir, 'reports.json'),
    reviewFile = path.join(dir, 'review.json'),
    resultFile = path.join(dir, 'result.json');
  await writeFile(list, JSON.stringify(reports));
  run(['scripts/notes-latency-review.mjs', '--reports', list, '--prepare', '--output', reviewFile]);
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert(!JSON.stringify(review).includes('short-first-note'));
  for (let i = 0; i < review.cases.length; i++) {
    Object.assign(review.cases[i], {
      firstUsefulEvidenceMs: 5000,
      scenario: scenarios[i % scenarios.length],
      language: ['id', 'en', 'mixed'][i % 3],
    });
    for (const r of review.cases[i].revisions)
      Object.assign(r, {
        useful: true,
        faithful: true,
        criticalUnsupported: false,
        materialDistortion: false,
        unnecessaryRetraction: false,
      });
    assert.equal(review.cases[i].revisions[0].evidenceAvailableAtDispatch.length, 1);
  }
  review.continuousSession = { passed: true, report: 'local-tested-session.json' };
  await writeFile(reviewFile, JSON.stringify(review));
  const score = () =>
    run([
      'scripts/notes-latency-review.mjs',
      '--reports',
      list,
      '--review',
      reviewFile,
      '--output',
      resultFile,
    ]);
  score();
  assert.equal(JSON.parse(await readFile(resultFile, 'utf8')).selectedDeadlineMs, 15000);
  // Empty/no-note runs stay in the denominator, never become zero latency.
  for (const file of reports.filter((f) => f.includes('short-first-note')).slice(0, 2)) {
    const r = JSON.parse(await readFile(file, 'utf8'));
    r.revisions = [];
    r.events = r.events.filter((e) => e.name !== 'memo.presentation_estimate');
    await writeFile(file, JSON.stringify(r));
  }
  score();
  const scored = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(scored.rollout, 'retain-baseline');
  assert.equal(scored.conditions['short-first-note'].deadlines[0].rate, 0.9);
  assert.equal(scored.conditions['short-first-note'].censored, 2);
  // Synthetic provider runs can never qualify as measured evidence.
  for (const file of reports) {
    const r = JSON.parse(await readFile(file, 'utf8'));
    r.kind = 'synthetic-provider';
    await writeFile(file, JSON.stringify(r));
  }
  score();
  assert.equal(JSON.parse(await readFile(resultFile, 'utf8')).rollout, 'retain-baseline');
  console.log(
    'Offline evaluation tool checks passed: shared cap, blind review, evidence cutoff, deadline gates, censoring, synthetic rejection.',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
