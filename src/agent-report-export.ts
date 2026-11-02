import { markAgentExport, readAgentReport, renderAgentReport } from './agent-diagnostics';
const exports = new Map<string, Promise<number>>();
/** Worker-owned data URL survives offscreen teardown; exports contain no executable scripts. */
export async function exportAgentReport(sessionId?: string, automatic = false): Promise<number> {
  const report = await readAgentReport(sessionId);
  if (!report) throw Error('No agent report found. Enable diagnostics before starting a meeting.');
  const id = report.session.sessionId;
  if (exports.has(id)) return exports.get(id)!;
  if (automatic && (!report.session.stoppedAt || !report.session.endedAt))
    throw Error('The meeting has not finished yet.');
  if (automatic && ['started', 'complete'].includes(report.session.exportState ?? '')) return -1;
  const task = (async () => {
    try {
      const html = renderAgentReport(report);
      const bytes = new TextEncoder().encode(html);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const downloadId = await chrome.downloads.download({
        url: 'data:text/html;charset=utf-8;base64,' + btoa(binary),
        filename:
          'listen-agent-report-' +
          new Date(report.session.startedAt).toISOString().replace(/[:.]/g, '-') +
          '.html',
        saveAs: false,
      });
      await markAgentExport(id, 'started');
      // Store the association so interrupted downloads can be diagnosed after a worker restart.
      await chrome.storage.local.set({ listenAgentReportDownload: { sessionId: id, downloadId } });
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.state === 'complete' || item?.state === 'interrupted')
        await markAgentExport(id, item.state === 'complete' ? 'complete' : 'failed');
      return downloadId;
    } catch {
      await markAgentExport(id, 'failed').catch(() => {});
      throw Error(
        'Agent report could not download. Retry from Privacy & help; the local report is retained.',
      );
    }
  })().finally(() => exports.delete(id));
  exports.set(id, task);
  return task;
}
export async function trackAgentReportDownload(
  delta: chrome.downloads.DownloadDelta,
): Promise<void> {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current ?? '')) return;
  const association = (await chrome.storage.local.get('listenAgentReportDownload'))
    .listenAgentReportDownload;
  if (association?.downloadId !== delta.id) return;
  await markAgentExport(
    association.sessionId,
    delta.state.current === 'complete' ? 'complete' : 'failed',
  );
}
