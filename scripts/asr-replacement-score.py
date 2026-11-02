"""Read-only scoring of replacement outputs against frozen human evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import re

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT/'artifacts/asr-replacement'
BUNDLE = ROOT/'training:meeting/verified-excerpts-v1-76136748b154'
spec = importlib.util.spec_from_file_location('reference_score', Path(__file__).with_name('meeting-reference-score.py'))
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)


def evaluate(raw, reference):
    # Scorer binds the exact candidate bytes to a temporary in-memory copy.
    # The frozen human reference is never rewritten.
    ref = dict(reference, pilotHash=hashlib.sha256(raw).hexdigest())
    result = scorer.score(raw, json.dumps(ref).encode())
    result['frozenReferenceHash'] = hashlib.sha256((BUNDLE/'reference.json').read_bytes()).hexdigest()
    times = [r['inferenceMs'] for r in result['speech'] + result['noSpeech']]
    result['latency'] = dict(count=len(times), medianMs=statistics.median(times) if times else None,
                             minMs=min(times) if times else None, maxMs=max(times) if times else None,
                             medianRtf=statistics.median(times)/8000 if times else None)
    # Keep annotation strings visible. They are not spoken-word hallucinations.
    annotations = {'(coughing)', '[no audio]', '[blank_audio]', '[pause]',
                   '[silence]', '[music]', '(music)', '(silence)'}
    for row in result['noSpeech']:
        text = row['hypothesis'].strip()
        row['annotationOnly'] = text.lower() in annotations
        row['containsSpokenText'] = bool(re.search(r'[^\W\d_]', text, re.UNICODE)) and not row['annotationOnly']
    result['silenceSummary'] = dict(controls=len(result['noSpeech']),
        spokenText=sum(row['containsSpokenText'] for row in result['noSpeech']),
        annotationOnly=sum(row['annotationOnly'] for row in result['noSpeech']))
    ordered = json.loads(raw)['results']
    result['firstInferenceMs'] = ordered[0].get('result', {}).get('inferenceMs') if ordered else None
    subsequent = [r['result']['inferenceMs'] for r in ordered[1:] if r.get('result', {}).get('type') == 'RESULT']
    result['subsequentMedianMs'] = statistics.median(subsequent) if subsequent else None
    result['phraseChecks'] = []
    for row in result['speech']:
        ref, hyp = scorer.metrics.normalize(row['reference']), scorer.metrics.normalize(row['hypothesis'])
        for phrase in ['bot detected', 'bot detection', 'top issue', 'output']:
            if phrase in ref:
                result['phraseChecks'].append(dict(id=row['id'], phrase=phrase, preserved=phrase in hyp))
    return result


if __name__ == '__main__':
    reference = json.loads((BUNDLE/'reference.json').read_bytes())
    report = dict(scope='One meeting, six periods; literal WER. No Mandarin evidence, independent-meeting estimate or rollout claim.', variants={})
    report['variants']['production-base'] = evaluate((BUNDLE/'pilot.json').read_bytes(), reference)
    for variant in ['qwen-0.6b', 'qwen-1.7b', 'fun-mlt', 'whisper-turbo-q4']:
        file = WORK/(variant+'.json')
        if not file.exists():
            report['variants'][variant] = dict(state='pending'); continue
        raw = file.read_bytes(); run = json.loads(raw)
        if not run.get('complete'):
            report['variants'][variant] = dict(state='incomplete', results=len(run['results']), error=run.get('runError')); continue
        result = evaluate(raw, reference)
        result['run'] = {k:v for k,v in run.items() if k not in ['results']}
        rss = [r['peakRssBytes'] for r in run['results'] if 'peakRssBytes' in r]
        cpu = [r['cpuSeconds'] for r in run['results'] if 'cpuSeconds' in r]
        result['resources'] = dict(peakRssBytes=max(rss) if rss else None,
                                   totalInferenceCpuSeconds=sum(cpu) if cpu else None)
        report['variants'][variant] = result
    (WORK/'scores.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    for name, result in report['variants'].items():
        print(name, json.dumps({k:result[k] for k in ['state','groups','latency','resources'] if k in result}))
