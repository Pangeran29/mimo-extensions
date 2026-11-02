import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLiveMemoReport } from './live-memo-v2-report.mjs';
test('v2 report separates memo/contribution feedback and exposes both stage inputs without repeating a new event', () => {
  const memo = { id: 'r1:memo', text: '<script>unsafe model text</script>', sources: [0] };
  const input = { liveV2Input: { newTranscript: [{ id: 0, text: 'source' }] } };
  const run = {
    label: 'fixture',
    status: 'completed',
    trace: [
      {
        type: 'PROPOSE',
        requestId: 'r1',
        startedAt: 100,
        completedAt: 150,
        input,
        messages: [{ content: 'FULL_PROPOSAL_PROMPT' }],
        value: {
          topic: null,
          memoUpdate: { action: 'replace', text: memo.text, sources: [0] },
          candidate: null,
        },
      },
      {
        type: 'REVIEW',
        parent: 'r1',
        startedAt: 150,
        completedAt: 200,
        input,
        messages: [{ content: 'FULL_REVIEW_PROMPT' }],
        value: {
          memo: { accept: true },
          contribution: { accept: false },
          status: { accept: false },
        },
      },
      {
        type: 'PROPOSE',
        requestId: 'r2',
        startedAt: 300,
        completedAt: 350,
        input,
        value: { memoUpdate: { action: 'keep', text: null, sources: [] }, candidate: null },
      },
    ],
    states: [{ at: 200, liveV2: { memo, activeId: null, contributions: [] } }],
  };
  const html = renderLiveMemoReport(run, {
    mode: 'Synthetic test',
    createdAt: 'fixture',
    latencyNote: 'Virtual clock',
  });
  assert.equal((html.match(/<b>NEW MEMO<\/b>/g) || []).length, 1);
  assert.ok(html.includes('Unchanged memo'));
  assert.ok(html.includes('r1:memo'));
  assert.ok(html.includes('r1:contribution'));
  assert.ok(html.includes('FULL_PROPOSAL_PROMPT'));
  assert.ok(html.includes('FULL_REVIEW_PROMPT'));
  assert.ok(!html.includes('<script>unsafe model text'));
  assert.ok(html.includes('&lt;script&gt;unsafe model text'));
});
