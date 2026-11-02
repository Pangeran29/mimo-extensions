"""Post-hoc paired scoring; uses the predeclared frozen human reference."""
import hashlib
import importlib.util
import json
import statistics
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('reference_score', Path(__file__).with_name('meeting-reference-score.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/meeting-baseline')
data = json.loads((root/'precision-eval.json').read_bytes())
reference_bytes = (root/('reference-frozen-' + data['referenceHash'][:12] + '.json')).read_bytes()
if hashlib.sha256(reference_bytes).hexdigest() != data['referenceHash']:
    raise ValueError('Frozen reference hash changed')
reference = json.loads(reference_bytes)
result = dict(kind='paired-decoder-precision-result', complete=data['complete'],
              referenceHash=data['referenceHash'], variants={}, decision='RETAIN BASELINE; this is a small diagnostic, not a production rollout.')
for dtype, block in data['variants'].items():
    # Rebind a copy solely to reuse validation of each matching ID/sample hash;
    # original human reference and raw experiment artifacts remain unchanged.
    pilot_bytes = json.dumps(dict(results=block['results'])).encode()
    copied_ref = dict(reference, pilotHash=hashlib.sha256(pilot_bytes).hexdigest())
    scored = module.score(pilot_bytes, json.dumps(copied_ref).encode())
    result['variants'][dtype] = dict(groups=scored['groups'], speech=scored['speech'], noSpeech=scored['noSpeech'], errors=scored['errors'],
                                    inferenceMedianMs=statistics.median(row['result']['inferenceMs'] for row in block['results'] if row.get('result')))
if set(result['variants']) == {'q4', 'fp32'}:
    q4 = {row['id']:row for row in result['variants']['q4']['speech']}
    fp32 = {row['id']:row for row in result['variants']['fp32']['speech']}
    result['pairedSpeech'] = [dict(id=key,q4Errors=q4[key]['errors'],fp32Errors=fp32[key]['errors'],
                                  q4Text=q4[key]['hypothesis'],fp32Text=fp32[key]['hypothesis']) for key in q4.keys() & fp32.keys()]
(root/'precision-scores.json').write_text(json.dumps(result,indent=2,ensure_ascii=False))
print(json.dumps({k:({dtype:{'groups':v['groups'],'inferenceMedianMs':v['inferenceMedianMs'],'errors':v['errors']} for dtype,v in value.items()} if k=='variants' else value)
                  for k,value in result.items() if k!='pairedSpeech'},indent=2))
