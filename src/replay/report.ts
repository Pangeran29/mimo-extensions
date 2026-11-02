/** Static, inert research export. Text from audio and models is never interpreted as markup. */
export interface ReplayEvidence {
  format: 'memo-replay-lab';
  version: 1;
  exportedAt: string;
  run: unknown;
  events: unknown[];
  agentReport?: unknown;
  limitations: string[];
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
export function renderReplayReport(evidence: ReplayEvidence): string {
  const pretty = (value: unknown) => escape(JSON.stringify(value, null, 2));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Memo replay evidence</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:40px auto;max-width:1000px;padding:0 24px;background:#f5f6fc;color:#252b45}h1,h2{line-height:1.3}section{border-top:1px solid #aeb9d1;margin-top:28px;padding-top:20px}summary{cursor:pointer;padding:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#fff;border:1px solid #dce1ef;border-radius:12px;font:13px/1.6 monospace}li{margin:8px 0}</style></head><body><h1>Memo replay evidence</h1><p>This report contains the recording identity, timeline, transcript/context, model requests and responses when available, and extension presentation events. The original audio and credentials are excluded.</p><p>Exported ${escape(evidence.exportedAt)}. A repeated visible revision is an existing output, not a new contribution.</p><h2>What this run can establish</h2><ul>${evidence.limitations.map((s) => `<li>${escape(s)}</li>`).join('')}</ul><section><h2>Run and source identity</h2><pre>${pretty(evidence.run)}</pre></section><section><h2>Audio, transcript, and extension timeline</h2>${evidence.events.map((e, i) => `<details><summary>Event ${i + 1}: ${escape(String((e as { kind?: string }).kind ?? 'event'))}</summary><pre>${pretty(e)}</pre></details>`).join('')}</section><section><h2>AI inputs, responses, decisions, and final accepted state</h2><pre>${pretty(evidence.agentReport ?? 'No full-content AI report is available for this run.')}</pre></section><section><h2>Complete machine-readable evidence</h2><pre>${pretty(evidence)}</pre></section></body></html>`;
}
