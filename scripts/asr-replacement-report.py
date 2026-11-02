"""Render measured pilot results; incomplete variants remain explicitly pending."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT/'artifacts/asr-replacement'
data = json.loads((WORK/'scores.json').read_text())
variants = data['variants']
lines = [
    '# Replacement ASR pilot — measured results', '',
    'Measured on 2026-10-23. **Production remains Whisper base. This pilot does not select a winner.**', '',
    'The user verified 18 exact eight-second excerpts: 13 speech representations and five no-intelligible-speech controls. They represent six periods of one meeting, with overlapping tab, microphone and combined sources. They are development examples, not 18 independent recordings. No candidate receives reference text, hotwords or earlier/later meeting context.', '',
    '## Primary comparison', '',
    'Lower word error rate (WER) is better. WER includes substitutions, deletions and insertions; it is not an accuracy percentage. The primary column uses all six combined speech excerpts (125 reference words). Literal normalization lowercases, removes punctuation and collapses whitespace; colloquial spelling and word joining still affect scores.', '',
    '| Variant | Combined errors / words (WER) | All speech errors / words (descriptive) | Median inference / 8 s audio | Spoken text on no-speech controls |',
    '| --- | --- | --- | --- | --- |',
]
for name, result in variants.items():
    if 'groups' not in result:
        state = 'Deferred larger-checkpoint follow-up' if name == 'qwen-1.7b' else result.get('state', 'pending')
        lines.append(f'| {name} | {state} | — | — | — |'); continue
    c, a = result['groups']['combined'], result['groups']['all']
    quiet = result['silenceSummary']
    lines.append(f"| {name} | {c['errors']}/{c['referenceWords']} ({c['wer']:.1%}) | {a['errors']}/{a['referenceWords']} ({a['wer']:.1%}) | {result['latency']['medianMs']/1000:.3f} s | {quiet['spokenText']}/{quiet['controls']} |")
lines += ['', '## Latency and resources', '',
    'Latency starts with a complete eight-second PCM input already available and ends with a complete recognizer response. It excludes recording/segmentation, transcript scheduling, the LLM and sidebar presentation. It does not establish time to first visible note. Native models remain resident across the 18 serial calls. Browser preparation includes its existing one-second warmup. These are model-specific deployment recipes, not an isolated checkpoint-only experiment.', '',
    'Hardware: Apple M5, ten CPU cores, 16 GiB unified memory, macOS 27.0.1. Foreground applications and public asset/dependency downloads remained active; pre-existing swap use was about 1.8 GiB. Timing/resource observations are descriptive and cannot establish minimum PC specifications. No simultaneous candidate inference was intended; native processes release their models before the next model starts.', '']
baseline = {r['id']:r for r in variants['production-base']['speech']}
for name, result in variants.items():
    if name == 'production-base' or 'groups' not in result: continue
    run = result.get('run', {}); resources = result.get('resources', {})
    lines += [f'### {name}', '',
        f"- Inference range: {result['latency']['minMs']/1000:.3f}–{result['latency']['maxMs']/1000:.3f} s. First call: {result['firstInferenceMs']/1000:.3f} s; subsequent-call median: {result['subsequentMedianMs']/1000:.3f} s."]
    if resources.get('peakRssBytes'):
        wall = sum(r['result']['inferenceMs'] for r in json.loads((WORK/(name+'.json')).read_text())['results'])/1000
        lines += [f"- Native process peak RSS: {resources['peakRssBytes']/1024**3:.2f} GiB; inference CPU time: {resources['totalInferenceCpuSeconds']:.2f} core-seconds over {wall:.2f} wall-seconds. RSS is not whole-computer or dedicated GPU memory."]
    else:
        lines += ['- Native-style peak RSS/CPU inference figures are unavailable for this browser run. Browser process sampling, when supplied, is labeled separately and can include shared pages and preparation.']
        summary = WORK/'browser-resource-summary.json'
        if name == 'whisper-turbo-q4' and summary.exists():
            browser_resources = json.loads(summary.read_text())
            lines += [f"- One-second browser sampling: {browser_resources['sampledPeakRssSumBytes']/1024**3:.2f} GiB peak summed process RSS over {browser_resources['seconds']:.1f} seconds including preparation and inference. Shared pages may be counted more than once; dedicated GPU allocations are unavailable. Not comparable to native single-process peak RSS."]
    load = run.get('load', {})
    load_ms = load.get('ms', load.get('loadMs'))
    if load_ms is not None:
        lines += [f'- Model preparation: {load_ms/1000:.3f} s. Public checkpoint download time is separate. This is one observed preparation, not a distribution of cold starts.']
    if name == 'fun-mlt':
        audit = run['implementation']['checkpointAudit']
        lines += [f"- Checkpoint audit: {audit['loadedTensorCount']} tensors loaded; no missing text-transcription tensors. The maintained upstream hook disables the optional timestamp/CTC head absent from this checkpoint. Two adapter setup failures produced zero hypotheses and are preserved as integration attempts, not scored model outputs.",
                  f"- Swap at this run's start: `{run.get('swapBefore', 'unavailable')}`. Swap at completion, while the model was still resident: `{run.get('swapAfter', 'unavailable')}`. The later memory-pressure state differs from the initial Qwen/browser run; do not treat these timings as a controlled resource ranking."]
    subset = [r for r in result['speech'] if r['role']=='combined']
    wins = sum(r['errors']<baseline[r['id']]['errors'] for r in subset)
    losses = sum(r['errors']>baseline[r['id']]['errors'] for r in subset)
    lines += [f'- Combined clip comparison: {wins} fewer-error, {losses} more-error, {len(subset)-wins-losses} tied excerpts.']
    checks = result['phraseChecks']
    lines += [f"- Exploratory English-marker retention: {sum(r['preserved'] for r in checks)}/{len(checks)} clip/term presence checks (baseline {sum(r['preserved'] for r in variants['production-base']['phraseChecks'])}/{len(variants['production-base']['phraseChecks'])}). Repeated uses of a term inside one clip count once, and source representations are not independent switching events. The `output` check also matches Indonesian suffixes such as `outputin`. This is not a general code-switching accuracy estimate.", '']
    lines += ['No-speech raw outputs:', '']
    for row in result['noSpeech']:
        lines.append(f"- `{row['id']}`: {json.dumps(row['hypothesis'],ensure_ascii=False)}")
    lines += ['', 'Raw speech hypotheses and verified references remain in the ignored local `artifacts/asr-replacement/scores.json`; this documentation does not copy private meeting dialogue.', '']
lines += ['## Limits and decision', '',
    '- Keep production unchanged. Improvement on six selected development periods cannot certify meeting-wide reliability or select a universal replacement. Qwen 0.6B is the most promising next validation candidate here: combined WER ties turbo at 36.0%, with much shorter processing time and fewer false no-speech outputs. This is a pilot prioritization, not a deployment winner.',
    '- These excerpts test Indonesian with English technical terms. No Mandarin reference audio was evaluated; Chinese filler on quiet input does not demonstrate Mandarin ability. Mandarin-English, Indonesian-Mandarin and three-way switching remain untested.',
    '- Later speech must not repair an earlier hypothesis during accuracy scoring. Additional natural recordings with independent references and a continuous capture/queue/notes test are still needed before integration.',
    '- Source-specific scores use the existing separately saved recordings. This does not change production stream mixing or establish word-to-source attribution.',
    '- Two browser preparations were stopped before inference: the first during slow public downloads, the second when CDP response staging did not finish. The completed run uses standard Transformers.js localModelPath with remote model loading disabled. A dependency fetch timed out and was retried. Preparation interruptions are not recognition failures or accuracy evidence. Raw preparation records are retained separately.',
    '- The selected Whisper recipe changes model, encoder precision and allowed language candidates (id/en/zh). Qwen uses an existing C CPU implementation. Fun uses the existing Python implementation on CPU/fp32. Differences cannot be attributed solely to checkpoint capacity.', '',
    '## Reproduce and audit', '',
    'Private data and outputs stay under ignored local `training:meeting/` and `artifacts/`. Preserve the canonical reference byte-for-byte. The frozen reference SHA256 is `76136748b1548b4011e27fcd7f70660c264725d0e25bacb6a71c63cebf6ce862`.', '',
    '1. Verify `training:meeting/verified-excerpts-v1-76136748b154/manifest.json` and its audio/reference hashes. `scripts/preserve-meeting-eval.mjs` verifies or preserves the canonical bundle.',
    '2. Restore the pinned checkpoints/revisions listed in `artifacts/asr-replacement/candidate-revisions.json`, verifying LFS SHA256 values from `upstream-file-hashes.json`. Download only the selected weight files. Downloads contain public model assets only.',
    '3. Qwen source commit: `924694251d9e0f18e5d86bbd06aa3ab5f870002d`; build `make blas` in its isolated vendor checkout. Compile `scripts/asr-qwen-batch.c` with the resulting `qwen*.o` objects, `-lpthread -lm -framework Accelerate`, and the vendor include directory. The adapter invokes the existing float32 PCM API; the upstream model code is unchanged.',
    '4. Native inference: `artifacts/asr-replacement/runtime-env/bin/python scripts/asr-replacement-native.py qwen-0.6b` (or `fun-mlt`). Result files are exclusive; archive an earlier run before repeating. Fun source commit: `c0a20e2bb698bbad11d143bdccd6c0760e9d6e5b`; use an isolated Python 3.12 environment with matched torch/torchaudio 2.9.1, Transformers 4.57.6 and FunASR 1.4.16. Record the final installed package lock.',
    '5. Browser: set `LISTEN_PLAYWRIGHT_PATH` to the installed Playwright directory, then `node scripts/asr-replacement-browser.mjs`. It checks staged weight hashes, clones the production build, loads the selected model from the isolated extension with standard localModelPath, and leaves production sources unchanged. Model preparation excludes checkpoint download.',
    '6. Score: `PYTHONPATH=artifacts/whisper-eval-python artifacts/asr-replacement/runtime-env/bin/python scripts/asr-replacement-score.py`; render this report with `scripts/asr-replacement-report.py`.',
    '7. Audit `evaluation-plan.json`, `machine.json`, raw variant JSON, checkpoint hashes, stderr logs and `scores.json` under `artifacts/asr-replacement/`. Scoring rebinds a temporary in-memory reference copy to each candidate; the canonical reference file is never rewritten.', '',
    'Verification: typecheck, 144 existing tests, latency-tool checks, Whisper diagnostic checks, five reference-scoring tests, Python syntax checks and extension build passed during this run. No production model, capture, VAD, notes prompt or persistence change was made.',
]
(ROOT/'docs/ASR-REPLACEMENT-RESULTS.md').write_text('\n'.join(lines)+'\n')
print('Updated docs/ASR-REPLACEMENT-RESULTS.md')
