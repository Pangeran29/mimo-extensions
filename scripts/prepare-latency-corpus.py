"""Public read-speech controls, not substitutes for spontaneous meeting/podcast cases.
Downloads ten distinct real FLEURS clips per language; records provenance and leaves
semantic-readiness annotations pending human review. Never edits shipped assets.
"""
import csv, hashlib, io, json, tarfile, urllib.request
from pathlib import Path
root = Path('artifacts/latency-corpus')
root.mkdir(parents=True, exist_ok=True)
revision = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'
clips = []
for language in ['id_id', 'en_us']:
    base = f'https://huggingface.co/datasets/google/fleurs/resolve/{revision}/data/{language}'
    rows = {r[1]: r for r in csv.reader(io.StringIO(urllib.request.urlopen(base + '/test.tsv', timeout=45).read().decode()), delimiter='\t')}
    count = 0
    with urllib.request.urlopen(base + '/audio/test.tar.gz', timeout=90) as response:
        with tarfile.open(fileobj=response, mode='r|gz') as archive:
            for member in archive:
                name = Path(member.name).name
                if name not in rows or not name.endswith('.wav'):
                    continue
                content = archive.extractfile(member).read()
                dest = root / f'{language}-{name}'
                dest.write_bytes(content)
                clips.append({'id': f'{language}-{name[:-4]}', 'audio': str(dest.resolve()),
                    'source': base + '/audio/test.tar.gz', 'original': name,
                    'sha256': hashlib.sha256(content).hexdigest(), 'reference': rows[name][2],
                    'language': language, 'scenario': 'read-speech-control', 'license': 'CC-BY-4.0',
                    'firstSubstantiveSpeechMs': None, 'firstUsefulEvidenceMs': None})
                count += 1
                if count == 10: break
    print(language, count, 'distinct real clips', flush=True)
# Interleave languages so the four-pair pilot covers both.
clips = [clip for pair in zip(clips[:10], clips[10:]) for clip in pair]
manifest = {'kind': 'real-public-read-speech-controls', 'seed': 20261023, 'clips': clips,
    'requiredAdditionalScenarios': ['reported podcast https://www.youtube.com/watch?v=4Yll_sh1IY4 at 00:00',
        'natural mixed language', 'spontaneous continuous speech', 'short turns',
        'uncertain wording', 'corrections', 'silence/music', 'unfinished speech'],
    'warning': 'Read speech alone cannot pass the representative-case rollout gate. Annotate evidence readiness before analysis; never mark an opening eligible from word count alone.'}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
