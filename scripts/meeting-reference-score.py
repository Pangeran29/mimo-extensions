"""Score a saved human review against immutable raw pilot outputs; no model calls."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('metrics', Path(__file__).with_name('whisper-fallback-score.py'))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


def score(pilot_bytes, reference_bytes):
    pilot, reference = json.loads(pilot_bytes), json.loads(reference_bytes)
    if reference['pilotHash'] != hashlib.sha256(pilot_bytes).hexdigest():
        raise ValueError('Reference belongs to a different pilot')
    refs = reference['annotations']
    if len({a['id'] for a in refs}) != len(refs):
        raise ValueError('Duplicate annotations')
    lookup = {a['id']: a for a in refs}
    expected = {f"{row['startSeconds']}:{row['role']}" for row in pilot['results']}
    if set(lookup) != expected:
        raise ValueError('Reference IDs do not match the pilot')
    result = dict(pilotHash=reference['pilotHash'], referenceHash=hashlib.sha256(reference_bytes).hexdigest(),
                  scope='Six selected periods from one meeting; paired source representations are not independent recordings. Literal word normalization; no spelling repair or vocabulary substitutions.',
                  pending=[], speech=[], noSpeech=[], errors=[], groups={})
    for row in pilot['results']:
        key = f"{row['startSeconds']}:{row['role']}"
        annotation = lookup.get(key)
        if annotation is None or annotation['inputHash'] != row['inputStats']['sha256']:
            raise ValueError('Missing or mismatched reference: ' + key)
        if annotation['status'] not in ['speech', 'no-speech']:
            result['pending'].append(key)
            continue
        if row.get('error') or row.get('result', {}).get('type') != 'RESULT':
            result['errors'].append(key)
            continue
        item = dict(id=key, role=row['role'], startSeconds=row['startSeconds'],
                    reference=annotation['text'], hypothesis=row['result']['text'],
                    inputHash=row['inputStats']['sha256'],
                    draftRevealed=annotation.get('draftRevealed'),
                    unchangedAfterReveal=annotation.get('textBeforeReveal') == annotation['text'],
                    inferenceMs=row['result']['inferenceMs'], language=row['result']['language'],
                    structuralFlags=row.get('assessment', {}).get('reasons', []))
        if annotation['status'] == 'no-speech':
            if annotation['text'].strip():
                raise ValueError('No-speech reference contains text: ' + key)
            item['rawNonempty'] = bool(row['result']['text'].strip())
            result['noSpeech'].append(item)
        else:
            if not annotation['text'].strip() or '[unclear]' in annotation['text'].lower():
                raise ValueError('Speech reference is empty or unclear: ' + key)
            item.update(metrics.counts(annotation['text'], row['result']['text']))
            result['speech'].append(item)
    for role in ['tab', 'microphone', 'combined', 'all']:
        rows = [a for a in result['speech'] if role == 'all' or a['role'] == role]
        words = sum(a['referenceWords'] for a in rows)
        errors = sum(a['errors'] for a in rows)
        result['groups'][role] = dict(speechClips=len(rows), referenceWords=words, errors=errors,
                                     wer=errors/words if words else None,
                                     substitutions=sum(a['substitutions'] for a in rows),
                                     deletions=sum(a['deletions'] for a in rows),
                                     insertions=sum(a['insertions'] for a in rows))
    return result


if __name__ == '__main__':
    root = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/meeting-baseline')
    pilot_bytes = (root/'pilot.json').read_bytes()
    reference_bytes = (root/'reference.json').read_bytes()
    result = score(pilot_bytes, reference_bytes)
    result['scorerHash'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    # Immutable copy prevents a later review edit from silently moving the target.
    frozen = root/('reference-frozen-' + result['referenceHash'][:12] + '.json')
    if frozen.exists() and frozen.read_bytes() != reference_bytes:
        raise ValueError('Reference snapshot collision')
    frozen.write_bytes(reference_bytes)
    (root/'reference-scores.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps({k:v for k,v in result.items() if k not in ['speech','noSpeech']}, indent=2))
