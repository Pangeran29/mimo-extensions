import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveMemoReport } from './live-memo-report.mjs';
test('review report escapes provider text and exposes silence, errors and exportable feedback', () => {
  const input = {
    newSegmentIds: [0],
    liveInput: { recentTranscript: [{ id: 0, text: '<script>untrusted transcript</script>' }] },
  };
  const run = {
    label: 'test',
    status: 'completed',
    trace: [
      {
        type: 'PROPOSE',
        requestId: 'r1',
        startedAt: 1000,
        completedAt: 1100,
        input,
        value: { decision: 'silent', reason: 'No additional value', candidate: null, updates: [] },
        elapsedMs: 100,
      },
      {
        type: 'PROPOSE',
        requestId: 'r2',
        startedAt: 12000,
        completedAt: 12100,
        input,
        error: { category: 'format', reason: 'schema_mismatch' },
      },
    ],
    states: [
      {
        at: 13000,
        lastSegmentId: 0,
        live: {
          activeId: 'future',
          contributions: [{ id: 'future', body: 'FUTURE DISPLAY MUST NOT LEAK' }],
        },
      },
    ],
    finalSnapshot: { live: { contributions: [] } },
  };
  const html = renderLiveMemoReport(run, {
    createdAt: 'test',
    mode: 'Synthetic test',
    latencyNote: 'Not real browser latency',
  });
  assert.ok(html.includes('&lt;script&gt;untrusted transcript&lt;/script&gt;'));
  assert.ok(!html.includes('<script>untrusted transcript'));
  assert.ok(html.includes('No additional value'));
  assert.ok(html.includes('schema_mismatch'));
  assert.ok(html.includes('Export review feedback'));
  assert.ok(html.includes('sebaiknya diam'));
  assert.ok(!html.includes('FUTURE DISPLAY MUST NOT LEAK'));
});
