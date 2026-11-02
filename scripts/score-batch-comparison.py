"""Offline comparison of frozen ASR output against human-reviewed references.
Run with PYTHONPATH=artifacts/whisper-eval-python and the workspace Python.
No provider requests; no reference text is supplied to decoding.
"""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('existing_scorer', 'scripts/whisper-fallback-score.py')
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)
path = Path('artifacts/provider-batching/batch-comparison.json')
report = json.loads(path.read_text())
for row in report['rows']:
    row['score'] = scorer.counts(report['reference'], row['text']) if not row.get('error') else None
path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps([{'cap': r['cap'], 'drainMs': r['drainMs'], 'score': r['score']} for r in report['rows']]))
