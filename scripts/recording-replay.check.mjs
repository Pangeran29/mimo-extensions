import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { ReplayClock } from './recording-replay-clock.mjs';

test('replay clock orders completions, preserves equal-time ordering, and cancels deadlines', () => {
  const clock = new ReplayClock();
  const seen = [];
  clock.at(100, () => seen.push(['later', clock.now]));
  clock.at(30, () => seen.push(['first', clock.now]));
  const deadline = clock.at(50, () => seen.push(['cancelled', clock.now]));
  clock.at(30, () => { seen.push(['second', clock.now]); clock.clearTimeout(deadline); });
  while (clock.next()) {}
  assert.deepEqual(seen, [['first', 30], ['second', 30], ['later', 100]]);
});

test('offline recordings retain the exact context chain without future transcript leakage', async () => {
  const result = spawnSync(process.execPath, ['scripts/recording-replay.mjs', '--offline', '--run', '--limit-seconds', '35', '--output', 'artifacts/recording-replay/offline-check'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  for (const label of ['lemhanas-16-10', 'lemhanas-28-10']) {
    const report = JSON.parse(await readFile(`artifacts/recording-replay/offline-check/${label}/run.json`, 'utf8'));
    assert.equal(report.status, 'complete');
    assert.ok(report.notes.length >= 2);
    let memo = '';
    for (const note of report.notes) {
      assert.equal(note.input.previousSummary, memo);
      const supplied = JSON.parse(note.messages[1].content);
      assert.deepEqual(supplied.newTranscript.map((s) => s.id), note.input.newSegmentIds);
      for (const s of note.input.segments) {
        const asr = report.asr.find((a) => a.segmentId === s.id);
        assert.ok(asr.completedAtMs <= note.dispatchedAtMs, 'future transcript leaked');
      }
      if (note.decision?.accepted) memo = note.decision.memo;
      if (note.result) assert.ok(note.result.analysis.summary.length <= 2400);
    }
    assert.equal(report.finalSnapshot.summary, memo);
    assert.equal(report.transcript.length, report.asr.filter((a) => a.text).length);
    const html = await readFile(`artifacts/recording-replay/offline-check/${label}/review.html`, 'utf8');
    assert.ok(html.includes('Exact system + user messages'));
    assert.ok(html.includes('SYNTHETIC transport verification'));
    assert.ok(!html.includes('Bearer synthetic'));
  }
});
