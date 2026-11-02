"""Render exact human/cloud transcripts for review; no network requests."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / 'training:meeting/verified-excerpts-v1-76136748b154'


def clock(seconds):
    return f'{seconds // 60:02d}:{seconds % 60:02d}'


def quoted(text):
    return ['```text', text, '```', ''] if text else ['*Empty response.*', '']


def main(folder):
    folder = Path(folder).resolve()
    run = json.loads((folder / 'run.json').read_bytes())
    reference_bytes = (BUNDLE / 'reference.json').read_bytes()
    reference = json.loads(reference_bytes)
    manifest = json.loads((BUNDLE / 'manifest.json').read_bytes())
    assert hashlib.sha256(reference_bytes).hexdigest() == run['referenceHash'] == manifest['referenceHash']
    assert run['complete'] and len(run['results']) == 54
    for artifact in run['responseArtifacts']:
        assert hashlib.sha256((folder / artifact['path']).read_bytes()).hexdigest() == artifact['sha256']
    refs = {a['id']: a for a in reference['annotations']}
    rows = {(r['id'], r['passNumber']): r for r in run['results']}
    summary = json.loads((folder / 'summary.json').read_bytes())
    lines = ['# Your annotations vs DeepInfra Qwen3-ASR 0.6B', '',
             'All 18 reviewed excerpts. Your annotations and machine outputs are reproduced exactly, without corrections. Your reference words were never supplied to DeepInfra.', '',
             '**Read each pair:** your verified words first, then the first DeepInfra response. Pass 1 is shown consistently for every excerpt; no best-result selection. Repeated responses are included only when the exact wording differs.', '',
             '**Sources:** Tab = captured meeting/tab audio; Microphone = your microphone; Combined = the saved mix. There are six periods from one meeting, represented by three audio tracks.', '',
             '**Measured result:** combined-source WER was 33.6% in each pass, compared with 36.0% for the earlier local Qwen run. DeepInfra returned speech-like filler on 3/5 no-intelligible-speech controls. These are small-sample findings; Mandarin was not tested.', '',
             '**Times:** full API request/response after the complete eight-second input is available. They exclude audio collection and notes generation. All three passes used the same exact audio; differences are retained below.', '',
             '## Excerpt index', '', '| Meeting time | Tab | Microphone | Combined |', '| --- | --- | --- | --- |']
    periods = sorted({c['startSeconds'] for c in manifest['clips']})
    for start in periods:
        links = [f'[{role}](#excerpt-{start}-{role})' for role in ['tab', 'microphone', 'combined']]
        lines.append(f'| {clock(start)}–{clock(start+8)} | ' + ' | '.join(links) + ' |')
    lines.append('')
    included = []
    for start in periods:
        lines += [f'## {clock(start)}–{clock(start+8)}', '']
        for role in ['tab', 'microphone', 'combined']:
            clip_id = f'{start}:{role}'
            clip = next(c for c in manifest['clips'] if c['id'] == clip_id)
            annotation = refs[clip_id]
            assert annotation['inputHash'] == clip['inputHash']
            assert hashlib.sha256((BUNDLE / clip['pcm']).read_bytes()).hexdigest() == clip['inputHash']
            samples = [rows[(clip_id, p)] for p in [1, 2, 3]]
            assert all(r['inputStats']['sha256'] == clip['inputHash'] for r in samples)
            lines += [f'<a id="excerpt-{start}-{role}"></a>', '', f'### {role.capitalize()} — {clip_id}', '',
                      f"[Listen to this eight-second excerpt]({BUNDLE / clip['audio']})", '', '**Your verified words**', '']
            if annotation['status'] == 'no-speech':
                assert annotation['text'] == ''
                lines += ['You marked this **no intelligible speech**. Reference text is empty.', '']
            else:
                lines += quoted(annotation['text'])
            first = samples[0]
            lines += [f"**DeepInfra Qwen 0.6B — pass 1** · {first['wallMs']/1000:.3f} s response", '']
            lines += quoted(first['result']['text'])
            for sample in samples[1:]:
                if sample['result']['text'] != first['result']['text']:
                    lines += [f"**Pass {sample['passNumber']} — different raw wording** · {sample['wallMs']/1000:.3f} s response", '']
                    lines += quoted(sample['result']['text'])
            if len({r['result']['text'] for r in samples}) == 1:
                lines += ['**Repeat check:** exact same text in all three passes.', '']
            lines += ['**All response times:** ' + ' · '.join(f"pass {r['passNumber']}: {r['wallMs']/1000:.3f} s" for r in samples), '', '---', '']
            included.append(clip_id)
    assert len(included) == len(set(included)) == 18
    output = folder / 'TRANSCRIPT-COMPARISON.md'
    output.write_text('\n'.join(lines))
    rendered = output.read_text()
    assert all(a['text'] in rendered for a in reference['annotations'])
    assert all(r['result']['text'] in rendered for r in run['results'])
    assert hashlib.sha256((BUNDLE / 'reference.json').read_bytes()).hexdigest() == run['referenceHash']
    print(f'Created {output}; all 18 annotations and 54 raw hypotheses verified; zero API requests.')


if __name__ == '__main__':
    main(sys.argv[1])
