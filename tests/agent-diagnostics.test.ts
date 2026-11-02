import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  AGENT_DIAGNOSTICS_KEY,
  beginAgentDiagnostics,
  agentDiagnosticsActive,
  agentEvent,
  stopAgentDiagnostics,
  finishAgentDiagnostics,
  readAgentReport,
  renderAgentReport,
  resumeAgentDiagnostics,
} from '../src/agent-diagnostics';
import { exportAgentReport } from '../src/agent-report-export';
let enabled = false;
let download: ReturnType<typeof vi.fn>;
beforeEach(() => {
  enabled = false;
  download = vi.fn().mockResolvedValue(123);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: enabled }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    downloads: { download, search: vi.fn().mockResolvedValue([]) },
  });
});
afterEach(() => vi.unstubAllGlobals());
it('does not capture content or export when diagnostics are off', async () => {
  await beginAgentDiagnostics('off');
  agentEvent('off', 'input', { text: 'private' });
  expect(agentDiagnosticsActive('off')).toBe(false);
  expect(await readAgentReport('off')).toBeUndefined();
  expect(await finishAgentDiagnostics('off', {})).toBe(false);
});
it('captures immutable per-request inputs and decisions in order; finalizes only for explicit Stop', async () => {
  enabled = true;
  await beginAgentDiagnostics('ordered');
  const input = { segments: [{ id: 1, text: 'Original evidence' }], previousSummary: '' };
  agentEvent('ordered', 'input', input, 'ordered:1');
  input.segments[0].text = 'Mutated';
  agentEvent('ordered', 'response', { text: '{"summary":"A supported point"}' }, 'ordered:1');
  agentEvent('ordered', 'decision', { accepted: true, memo: 'A supported point' }, 'ordered:1');
  agentEvent(
    'ordered',
    'input',
    { segments: [{ id: 2, text: 'New evidence' }], previousSummary: 'A supported point' },
    'ordered:2',
  );
  agentEvent('ordered', 'decision', { accepted: false, reason: 'schema_mismatch' }, 'ordered:2');
  stopAgentDiagnostics('ordered');
  expect(await finishAgentDiagnostics('ordered', { savedMemo: 'A supported point' })).toBe(true);
  const report = (await readAgentReport('ordered'))!;
  expect((report.events[0].data as any).segments[0].text).toBe('Original evidence');
  expect(report.events.map((e) => e.kind)).toEqual([
    'input',
    'response',
    'decision',
    'input',
    'decision',
    'stop-requested',
    'session-finished',
  ]);
  expect(report.session.stoppedAt).toBeGreaterThan(0);
  expect(report.session.endedAt).toBeGreaterThan(0);
  agentEvent('ordered', 'response', { text: 'late' }, 'ordered:2');
  expect((await readAgentReport('ordered'))!.events).toHaveLength(7);
  await resumeAgentDiagnostics('ordered');
  expect(agentDiagnosticsActive('ordered')).toBe(false);
});
it('exports escaped self-contained HTML and retains reports after a download failure', async () => {
  enabled = true;
  await beginAgentDiagnostics('html');
  agentEvent('html', 'input', { text: '</pre><script>attack()</script>' }, 'html:1');
  stopAgentDiagnostics('html');
  await finishAgentDiagnostics('html', {});
  const html = renderAgentReport((await readAgentReport('html'))!);
  expect(html).not.toContain('<script>attack()');
  expect(html).toContain('&lt;script&gt;attack()');
  expect(html).toContain('Request 1');
  expect(html).toContain('Complete machine-readable report');
  download.mockRejectedValueOnce(Error('private API error'));
  await expect(exportAgentReport('html', true)).rejects.toThrow('local report is retained');
  expect((await readAgentReport('html'))?.session.exportState).toBe('failed');
  expect(await exportAgentReport('html', true)).toBe(123);
  const args = download.mock.calls.at(-1)![0];
  expect(args.filename).toMatch(/^listen-agent-report-.*\.html$/);
  expect(args.url).toMatch(/^data:text\/html;charset=utf-8;base64,/);
  expect(await exportAgentReport('html', true)).toBe(-1);
  expect(download).toHaveBeenCalledTimes(2);
});
it('retains incomplete reports without automatically downloading them', async () => {
  enabled = true;
  await beginAgentDiagnostics('incomplete');
  agentEvent('incomplete', 'input', { text: 'unfinished' }, 'incomplete:1');
  await expect(exportAgentReport('incomplete', true)).rejects.toThrow('has not finished');
  expect(download).not.toHaveBeenCalled();
  expect(await finishAgentDiagnostics('incomplete', { interrupted: true })).toBe(false);
  expect(await exportAgentReport('incomplete')).toBe(123);
});
it('marks the report incomplete rather than silently exceeding the content bound', async () => {
  enabled = true;
  await beginAgentDiagnostics('bounded');
  agentEvent('bounded', 'response', { text: 'x'.repeat(16 * 1024 * 1024) }, 'bounded:1');
  stopAgentDiagnostics('bounded');
  await finishAgentDiagnostics('bounded', {});
  const report = (await readAgentReport('bounded'))!;
  expect(report.session.limited).toBe(true);
  expect(report.events).toEqual([]);
  expect(renderAgentReport(report)).toContain('Report incomplete');
});
it('retains only the newest four reports when starting another meeting', async () => {
  enabled = true;
  for (let n = 0; n < 6; n++) {
    await beginAgentDiagnostics('retention-' + n);
    agentEvent('retention-' + n, 'input', { n });
    await finishAgentDiagnostics('retention-' + n, {});
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(await readAgentReport('retention-0')).toBeUndefined();
  expect(await readAgentReport('retention-1')).toBeUndefined();
  expect((await readAgentReport('retention-2'))?.session.sessionId).toBe('retention-2');
  expect((await readAgentReport())?.session.sessionId).toBe('retention-5');
});

it('starts in the offscreen recorder with an explicit opt-in and no Chrome storage API', async () => {
  vi.stubGlobal('chrome', { runtime: {} });
  await beginAgentDiagnostics('offscreen-opt-in', true);
  expect(agentDiagnosticsActive('offscreen-opt-in')).toBe(true);
  agentEvent('offscreen-opt-in', 'input', { text: 'Evidence' }, 'offscreen-opt-in:1');
  stopAgentDiagnostics('offscreen-opt-in');
  expect(await finishAgentDiagnostics('offscreen-opt-in', {})).toBe(true);
  expect((await readAgentReport('offscreen-opt-in'))!.events).toHaveLength(3);
});
