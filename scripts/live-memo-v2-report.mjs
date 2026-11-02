const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function renderLiveMemoReport(run, index) {
  const rows = run.trace
    .filter((t) => t.type === 'PROPOSE')
    .map((row, i) => {
      const review = run.trace.find((t) => t.type === 'REVIEW' && t.parent === row.requestId),
        end = review?.completedAt ?? row.completedAt ?? row.startedAt;
      const state = run.states.filter((s) => s.at <= end).at(-1)?.liveV2;
      const memo = state?.memo,
        contribution = state?.contributions.find((c) => c.id === state.activeId);
      const newMemo = memo?.id === row.requestId + ':memo',
        newContribution = contribution?.id === row.requestId;
      const details = (label, value) =>
        `<details><summary>${label}</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
      const feedback = (kind) =>
        `<select data-review="${esc(row.requestId + ':' + kind)}"><option value="">Review ${kind}</option>${(kind === 'memo' ? ['jelas dan akurat', 'kurang jelas', 'salah konteks', 'keliru / menebak', 'terlambat'] : ['membantu', 'mengulang', 'salah konteks', 'terlalu menebak', 'sebaiknya diam']).map((v) => `<option>${v}</option>`).join('')}</select>`;
      return `<tr id="${esc(row.requestId)}"><td>${i + 1}<br>${(row.startedAt / 1000).toFixed(1)}s</td><td>${esc(row.value?.topic?.label)}${details('Proposal input: full prompts, transcript, memory & history', row.messages ?? row.input)}${details('Reviewer input: latest context & proposed components', review?.messages ?? review?.input ?? 'Not requested')}</td><td><b>${memo ? (newMemo ? 'NEW MEMO' : 'Unchanged memo → ' + esc(memo.id)) : 'Gathering context'}</b>${newMemo ? `<p>${esc(memo.text)}</p>` : ''}${memo ? details('Current memo and sources', memo) : ''}${feedback('memo')}</td><td><b>${contribution ? (newContribution ? 'NEW CONTRIBUTION' : 'Unchanged → ' + esc(contribution.id)) : 'No contribution'}</b>${newContribution ? `<p>${esc(contribution.body)}</p>` : ''}${contribution ? `<p>Status: ${esc(contribution.status)}</p>` + details('Retained contribution, feedback & status sources', contribution) : ''}${feedback('contribution')}</td><td>${details('Proposal / candidate / status update', row.value ?? row.error)}${details('Independent reviewer verdicts', review?.value ?? (review?.error ? { error: review.error, explanation: review.errorExplanation } : 'Not requested'))}<p>${esc(JSON.stringify(row.componentErrors ?? []))}</p>${details('Raw response and diagnostics', row.rawResponse)}${details('Review raw response', review?.rawResponse)}<p>${esc(JSON.stringify(row.error ?? ''))}</p></td><td>Proposal ${Math.round(row.elapsedMs ?? 0)} ms<br>Review ${Math.round(review?.elapsedMs ?? 0)} ms<pre>${esc(JSON.stringify({ proposal: row.usage, review: review?.usage }))}</pre></td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(run.label)} — memo v2</title><style>body{font:15px/1.5 system-ui;margin:24px;color:#172a3b;background:#fff}table{width:100%;border-collapse:collapse}td,th{padding:12px;border:1px solid #c7d4de;vertical-align:top;min-width:180px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:560px}select,button{font:inherit;padding:8px}header{max-width:900px}a{color:#006b80}</style><header><a href="../index.html">All runs</a><h1>${esc(run.label)} — pemahaman + kontribusi</h1><p>Status: ${esc(run.status)}. ${esc(index.mode)}. User acceptance pending.</p><p>${esc(index.latencyNote)}. Unchanged entries reference their stable ID; they are not regenerated outputs. Candidate/reviewer acceptance does not guarantee publication when newer ASR or Stop invalidates the response.</p><button id="export">Export review feedback</button><p id="notice" role="status"></p></header><table><thead><tr>${['Step / replay time', 'Both stage inputs', 'Current understanding', 'Additional contribution', 'Decisions / diagnostics', 'Timing / tokens'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><script>const key=${JSON.stringify('live-v2-review:' + run.label + ':' + index.createdAt)};let feedback={};try{feedback=JSON.parse(localStorage.getItem(key)||'{}')}catch{}for(const s of document.querySelectorAll('select')){s.value=feedback[s.dataset.review]||'';s.onchange=()=>{feedback[s.dataset.review]=s.value;try{localStorage.setItem(key,JSON.stringify(feedback));document.getElementById('notice').textContent='Saved locally.'}catch{document.getElementById('notice').textContent='Export feedback to save.'}}}document.getElementById('export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({label:${JSON.stringify(run.label)},feedback},null,2)],{type:'application/json'}));a.download='live-memo-v2-feedback.json';a.click();URL.revokeObjectURL(a.href)}</script></html>`;
}
