"""Offline analysis of cloud outputs against the frozen human references."""
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / 'training:meeting/verified-excerpts-v1-76136748b154'
spec = importlib.util.spec_from_file_location('replacement_score', Path(__file__).with_name('asr-replacement-score.py'))
score = importlib.util.module_from_spec(spec)
spec.loader.exec_module(score)


def percentile(values, p):
    ordered = sorted(values)
    if not ordered:
        return None
    at = (len(ordered) - 1) * p
    low = int(at)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (at - low)


def latency(rows):
    times = [r['wallMs'] for r in rows if not r.get('error')]
    runtime = [r['providerRuntimeMs'] for r in rows if isinstance(r.get('providerRuntimeMs'), (int, float))]
    return dict(attempts=len(rows), successes=len(times), failures=len(rows) - len(times),
                medianMs=statistics.median(times) if times else None,
                p95Ms=percentile(times, .95), maximumMs=max(times) if times else None,
                minimumMs=min(times) if times else None,
                within3s=sum(t <= 3000 for t in times),
                within1s=sum(t <= 1000 for t in times),
                providerRuntimeMedianMs=statistics.median(runtime) if runtime else None)


def main(folder):
    path = Path(folder).resolve()
    raw = (path / 'run.json').read_bytes()
    run = json.loads(raw)
    reference = json.loads((BUNDLE / 'reference.json').read_bytes())
    assert run['referenceHash'] == hashlib.sha256((BUNDLE / 'reference.json').read_bytes()).hexdigest()
    for item in run['responseArtifacts']:
        assert hashlib.sha256((path / item['path']).read_bytes()).hexdigest() == item['sha256']
    local = score.evaluate((ROOT / 'artifacts/asr-replacement/qwen-0.6b.json').read_bytes(), reference)
    summary = dict(complete=run['complete'], runHash=hashlib.sha256(raw).hexdigest(),
                   latency=latency(run['results']), passes={},
                   localQwen=dict(groups=local['groups'], latency=local['latency'], silence=local['silenceSummary']),
                   noRetries=run['automaticRetries'] == 0,
                   limitations='One meeting/six periods. Prepared 8s input request latency from this machine; no relay/capture/notes/UI timing. Three repeats are correlated. No Mandarin evidence. No confidence claim for population latency or accuracy.')
    costs = [r.get('providerCostUsd') for r in run['results']]
    summary['billing'] = dict(reportedCostUsd=sum(c for c in costs if isinstance(c, (int, float))),
                              requestsWithReportedCost=sum(isinstance(c, (int, float)) for c in costs),
                              submittedAudioSeconds=len(run['results']) * 8)
    for pass_number in range(1, run['passCount'] + 1):
        rows = [r for r in run['results'] if r['passNumber'] == pass_number]
        if len(rows) != 18:
            summary['passes'][str(pass_number)] = dict(state='incomplete', attempts=len(rows))
            continue
        evaluation = score.evaluate(json.dumps({'results': rows}, ensure_ascii=False).encode(), reference)
        local_map = {r['id']: r for r in local['speech']}
        paired = [(r['errors'], local_map[r['id']]['errors']) for r in evaluation['speech']]
        summary['passes'][str(pass_number)] = dict(groups=evaluation['groups'], silence=evaluation['silenceSummary'],
            phraseChecks=evaluation['phraseChecks'], latency=latency(rows), errors=evaluation['errors'],
            pairedClipErrorCounts=dict(cloudFewer=sum(a < b for a, b in paired),
                                      cloudMore=sum(a > b for a, b in paired), tied=sum(a == b for a, b in paired)))
    ids = sorted({r['id'] for r in run['results']})
    summary['repeatConsistency'] = []
    for clip_id in ids:
        rows = [r for r in run['results'] if r['id'] == clip_id and r.get('result')]
        texts = [r['result']['text'] for r in rows]
        normalized = [score.scorer.metrics.normalize(t) for t in texts]
        summary['repeatConsistency'].append(dict(id=clip_id, samples=len(texts),
            distinctRaw=len(set(texts)), distinctNormalized=len(set(normalized))))
    summary['firstRequestMs'] = run['results'][0]['wallMs'] if run['results'] else None
    summary['laterRequests'] = latency(run['results'][1:])
    summary['speechRequests'] = latency([r for r in run['results'] if next(a for a in reference['annotations'] if a['id'] == r['id'])['status'] == 'speech'])
    residual = [r['wallMs'] - r['providerRuntimeMs'] for r in run['results'] if isinstance(r.get('providerRuntimeMs'), (int, float))]
    summary['medianWallMinusReportedRuntimeMs'] = statistics.median(residual) if residual else None
    (path / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    lines = ['# DeepInfra Qwen 0.6B — existing excerpt benchmark', '',
             'Private local report. Human reference and recordings remain unchanged.', '',
             '## Timing and billing', '', '```json', json.dumps({k:summary[k] for k in ['latency', 'billing', 'firstRequestMs', 'laterRequests', 'speechRequests']}, indent=2), '```', '',
             '## Accuracy against the human review', '',
             '| Configuration | Combined errors / words | Combined WER | Quiet controls with spoken text |',
             '| --- | --- | --- | --- |']
    def table_row(name, groups, silence):
        combined = groups['combined']
        return f"| {name} | {combined['errors']}/{combined['referenceWords']} | {combined['wer']:.1%} | {silence['spokenText']}/{silence['controls']} |"
    lines.append(table_row('Local Qwen CPU (previous)', local['groups'], local['silenceSummary']))
    for number, result in summary['passes'].items():
        if 'groups' in result:
            lines.append(table_row('DeepInfra pass ' + number, result['groups'], result['silence']))
    lines += ['', summary['limitations'], '',
              'Provider runtime is self-reported; wall time includes upload, connection/network, waiting, and body/JSON handling. The difference cannot isolate queueing versus network. Percentiles use linear interpolation over successful requests; failures remain in the deadline denominator.', '',
              '## All reviewed excerpts', '']
    local_raw = json.loads((ROOT / 'artifacts/asr-replacement/qwen-0.6b.json').read_bytes())
    for annotation in reference['annotations']:
        clip_id = annotation['id']
        local_row = next(r for r in local_raw['results'] if f"{r['startSeconds']}:{r['role']}" == clip_id)
        start, role = clip_id.split(':')
        audio_path = BUNDLE / f'clips/{int(start):04d}-{role}.wav'
        lines += [f'### {clip_id}', '', f'[Audio]({audio_path})', '',
                  '**Your verified reference:** ' + (annotation['text'] or '(no intelligible speech)'), '',
                  '**Previous local Qwen:** ' + (local_row['result']['text'] or '(empty)'), '']
        for row in (r for r in run['results'] if r['id'] == clip_id):
            text = row.get('result', {}).get('text', '')
            lines += [f"**DeepInfra pass {row['passNumber']} ({row['wallMs']/1000:.3f}s):** " + (row.get('error') or text or '(empty)'), '']
    (path / 'RESULTS.md').write_text('\n'.join(lines))
    print(json.dumps({k:summary[k] for k in ['complete', 'latency', 'billing', 'passes', 'firstRequestMs', 'medianWallMinusReportedRuntimeMs']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
