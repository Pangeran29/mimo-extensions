const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function renderLiveMemoReport(run, index) {
  const headers = [
    'Step / replay time',
    'Current context and evidence',
    'Decision / candidate',
    'Reviewer and processing',
    'Displayed contribution',
    'Timing / tokens / feedback',
  ];
  const cells = run.trace
    .filter((t) => t.type === 'PROPOSE')
    .map((row, i) => {
      const published = run.finalSnapshot?.live?.contributions.some((c) => c.id === row.requestId);
      const reviewer = run.trace.find((r) => r.type === 'REVIEW' && r.parent === row.requestId);
      const completedAt = reviewer?.completedAt ?? row.completedAt ?? row.startedAt;
      const after = run.states.filter((s) => s.at <= completedAt).at(-1);
      const active = after?.live?.contributions.find((c) => c.id === after.live.activeId);
      return `<tr id="${escape(row.requestId)}"><td>${i + 1}<br>${(row.startedAt / 1000).toFixed(1)}s</td><td><b>${escape(row.value?.topic?.label ?? 'Uncertain')}</b><details><summary>Input, source quotes & history</summary><pre>${escape(JSON.stringify(row.input.liveInput, null, 2))}</pre></details></td><td><b>${escape(row.value?.decision ?? 'ERROR')}</b><p>${escape(row.value?.reason)}</p><pre>${escape(JSON.stringify(row.value?.candidate ?? null, null, 2))}</pre></td><td>${escape(reviewer ? JSON.stringify(reviewer.value ?? reviewer.error) : 'No candidate; no reviewer call')}<p>${escape(reviewer?.value?.accept && !published ? 'Accepted by model but NOT displayed: invalidated by newer transcript, feedback or Stop.' : published ? 'Published.' : 'No new contribution published.')}</p><p>${escape(row.errorExplanation ?? (row.error ? JSON.stringify(row.error) : ''))}</p></td><td><b>${active ? (active.id === row.requestId ? 'New contribution' : 'Active unchanged — no new output') : 'Silence / listening'}</b><p>${escape(active?.body ?? '')}</p><details><summary>State updates</summary><pre>${escape(JSON.stringify(row.value?.updates, null, 2))}</pre></details></td><td>Proposal ${Math.round(row.elapsedMs ?? 0)} ms<br>Review ${Math.round(reviewer?.elapsedMs ?? 0)} ms<br>${escape(JSON.stringify({ proposal: row.usage, review: reviewer?.usage }))}<p><select data-review="${escape(row.requestId)}"><option value="">Your review</option>${['membantu', 'mengulang', 'salah konteks', 'terlalu menebak', 'sebaiknya diam'].map((v) => `<option>${v}</option>`).join('')}</select></p></td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(run.label)} — live memo review</title><style>body{font:15px system-ui;margin:24px;color:#182632;background:#fafbf9}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bec9ce;padding:12px;vertical-align:top;min-width:180px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:600px}td:nth-child(2){min-width:280px}select,button{font:inherit;padding:8px}header{position:sticky;left:0;max-width:900px}</style><header><a href="../index.html">All runs & checkpoints</a><h1>${escape(run.label)}</h1><p>${escape(index.mode)}. Status: ${escape(run.status)}. No MOM. Decisions are model judgments; review required.</p><p>${escape(index.latencyNote)}</p><button id="export">Export review feedback</button><p id="save-status" role="status"></p></header><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${cells}</tbody></table><script>const key=${JSON.stringify('live-memo-review:' + run.label + ':' + index.createdAt)};let feedback={};try{feedback=JSON.parse(localStorage.getItem(key)||'{}')}catch{}for(const e of document.querySelectorAll('select')){e.value=feedback[e.dataset.review]||'';e.onchange=()=>{feedback[e.dataset.review]=e.value;try{localStorage.setItem(key,JSON.stringify(feedback));document.getElementById('save-status').textContent='Feedback saved in this browser.'}catch{document.getElementById('save-status').textContent='Export feedback to save it.'}}}document.getElementById('export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({run:${JSON.stringify(run.label)},feedback},null,2)],{type:'application/json'}));a.download='live-memo-feedback.json';a.click();URL.revokeObjectURL(a.href)}</script></html>`;
}
