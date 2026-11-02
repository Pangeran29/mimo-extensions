# Replacement ASR pilot — measured results

Measured on 2026-10-23. **Production remains Whisper base. This pilot does not select a winner.**

The user verified 18 exact eight-second excerpts: 13 speech representations and five no-intelligible-speech controls. They represent six periods of one meeting, with overlapping tab, microphone and combined sources. They are development examples, not 18 independent recordings. No candidate receives reference text, hotwords or earlier/later meeting context.

## Primary comparison

Lower word error rate (WER) is better. WER includes substitutions, deletions and insertions; it is not an accuracy percentage. The primary column uses all six combined speech excerpts (125 reference words). Literal normalization lowercases, removes punctuation and collapses whitespace; colloquial spelling and word joining still affect scores.

| Variant | Combined errors / words (WER) | All speech errors / words (descriptive) | Median inference / 8 s audio | Spoken text on no-speech controls |
| --- | --- | --- | --- | --- |
| production-base | 57/125 (45.6%) | 110/244 (45.1%) | 0.453 s | 0/5 |
| qwen-0.6b | 45/125 (36.0%) | 87/244 (35.7%) | 0.803 s | 2/5 |
| qwen-1.7b | Deferred larger-checkpoint follow-up | — | — | — |
| fun-mlt | 49/125 (39.2%) | 96/244 (39.3%) | 1.640 s | 5/5 |
| whisper-turbo-q4 | 45/125 (36.0%) | 83/244 (34.0%) | 8.945 s | 5/5 |

## Latency and resources

Latency starts with a complete eight-second PCM input already available and ends with a complete recognizer response. It excludes recording/segmentation, transcript scheduling, the LLM and sidebar presentation. It does not establish time to first visible note. Native models remain resident across the 18 serial calls. Browser preparation includes its existing one-second warmup. These are model-specific deployment recipes, not an isolated checkpoint-only experiment.

Hardware: Apple M5, ten CPU cores, 16 GiB unified memory, macOS 27.0.1. Foreground applications and public asset/dependency downloads remained active; pre-existing swap use was about 1.8 GiB. Timing/resource observations are descriptive and cannot establish minimum PC specifications. No simultaneous candidate inference was intended; native processes release their models before the next model starts.

### qwen-0.6b

- Inference range: 0.397–0.985 s. First call: 0.944 s; subsequent-call median: 0.802 s.
- Native process peak RSS: 2.60 GiB; inference CPU time: 39.23 core-seconds over 12.77 wall-seconds. RSS is not whole-computer or dedicated GPU memory.
- Model preparation: 0.163 s. Public checkpoint download time is separate. This is one observed preparation, not a distribution of cold starts.
- Combined clip comparison: 5 fewer-error, 1 more-error, 0 tied excerpts.
- Exploratory English-marker retention: 6/11 clip/term presence checks (baseline 2/11). Repeated uses of a term inside one clip count once, and source representations are not independent switching events. The `output` check also matches Indonesian suffixes such as `outputin`. This is not a general code-switching accuracy estimate.

No-speech raw outputs:

- `424:microphone`: ""
- `792:tab`: "嗯。"
- `864:tab`: "嗯嗯。"
- `872:microphone`: ""
- `1192:microphone`: ""

Raw speech hypotheses and verified references remain in the ignored local `artifacts/asr-replacement/scores.json`; this documentation does not copy private meeting dialogue.

### fun-mlt

- Inference range: 0.760–2.280 s. First call: 2.280 s; subsequent-call median: 1.616 s.
- Native process peak RSS: 4.80 GiB; inference CPU time: 30.55 core-seconds over 26.66 wall-seconds. RSS is not whole-computer or dedicated GPU memory.
- Model preparation: 10.593 s. Public checkpoint download time is separate. This is one observed preparation, not a distribution of cold starts.
- Checkpoint audit: 1261 tensors loaded; no missing text-transcription tensors. The maintained upstream hook disables the optional timestamp/CTC head absent from this checkpoint. Two adapter setup failures produced zero hypotheses and are preserved as integration attempts, not scored model outputs.
- Swap at this run's start: `vm.swapusage: total = 7168.00M  used = 5916.50M  free = 1251.50M  (encrypted)`. Swap at completion, while the model was still resident: `vm.swapusage: total = 7168.00M  used = 5884.50M  free = 1283.50M  (encrypted)`. The later memory-pressure state differs from the initial Qwen/browser run; do not treat these timings as a controlled resource ranking.
- Combined clip comparison: 3 fewer-error, 1 more-error, 2 tied excerpts.
- Exploratory English-marker retention: 4/11 clip/term presence checks (baseline 2/11). Repeated uses of a term inside one clip count once, and source representations are not independent switching events. The `output` check also matches Indonesian suffixes such as `outputin`. This is not a general code-switching accuracy estimate.

No-speech raw outputs:

- `424:microphone`: " 음"
- `792:tab`: "嗯。"
- `864:tab`: "嗯嗯。"
- `872:microphone`: "嗯。"
- `1192:microphone`: "just to to to sort of sort the the sort the sequences in in eh"

Raw speech hypotheses and verified references remain in the ignored local `artifacts/asr-replacement/scores.json`; this documentation does not copy private meeting dialogue.

### whisper-turbo-q4

- Inference range: 8.790–9.235 s. First call: 9.031 s; subsequent-call median: 8.943 s.
- Native-style peak RSS/CPU inference figures are unavailable for this browser run. Browser process sampling, when supplied, is labeled separately and can include shared pages and preparation.
- One-second browser sampling: 4.09 GiB peak summed process RSS over 177.0 seconds including preparation and inference. Shared pages may be counted more than once; dedicated GPU allocations are unavailable. Not comparable to native single-process peak RSS.
- Model preparation: 15.874 s. Public checkpoint download time is separate. This is one observed preparation, not a distribution of cold starts.
- Combined clip comparison: 4 fewer-error, 2 more-error, 0 tied excerpts.
- Exploratory English-marker retention: 10/11 clip/term presence checks (baseline 2/11). Repeated uses of a term inside one clip count once, and source representations are not independent switching events. The `output` check also matches Indonesian suffixes such as `outputin`. This is not a general code-switching accuracy estimate.

No-speech raw outputs:

- `424:microphone`: "Okay."
- `792:tab`: "you"
- `864:tab`: "mm-hmm"
- `872:microphone`: "so"
- `1192:microphone`: "so"

Raw speech hypotheses and verified references remain in the ignored local `artifacts/asr-replacement/scores.json`; this documentation does not copy private meeting dialogue.

## Limits and decision

- Keep production unchanged. Improvement on six selected development periods cannot certify meeting-wide reliability or select a universal replacement. Qwen 0.6B is the most promising next validation candidate here: combined WER ties turbo at 36.0%, with much shorter processing time and fewer false no-speech outputs. This is a pilot prioritization, not a deployment winner.
- These excerpts test Indonesian with English technical terms. No Mandarin reference audio was evaluated; Chinese filler on quiet input does not demonstrate Mandarin ability. Mandarin-English, Indonesian-Mandarin and three-way switching remain untested.
- Later speech must not repair an earlier hypothesis during accuracy scoring. Additional natural recordings with independent references and a continuous capture/queue/notes test are still needed before integration.
- Source-specific scores use the existing separately saved recordings. This does not change production stream mixing or establish word-to-source attribution.
- Two browser preparations were stopped before inference: the first during slow public downloads, the second when CDP response staging did not finish. The completed run uses standard Transformers.js localModelPath with remote model loading disabled. A dependency fetch timed out and was retried. Preparation interruptions are not recognition failures or accuracy evidence. Raw preparation records are retained separately.
- The selected Whisper recipe changes model, encoder precision and allowed language candidates (id/en/zh). Qwen uses an existing C CPU implementation. Fun uses the existing Python implementation on CPU/fp32. Differences cannot be attributed solely to checkpoint capacity.

## Reproduce and audit

Private data and outputs stay under ignored local `training:meeting/` and `artifacts/`. Preserve the canonical reference byte-for-byte. The frozen reference SHA256 is `76136748b1548b4011e27fcd7f70660c264725d0e25bacb6a71c63cebf6ce862`.

1. Verify `training:meeting/verified-excerpts-v1-76136748b154/manifest.json` and its audio/reference hashes. `scripts/preserve-meeting-eval.mjs` verifies or preserves the canonical bundle.
2. Restore the pinned checkpoints/revisions listed in `artifacts/asr-replacement/candidate-revisions.json`, verifying LFS SHA256 values from `upstream-file-hashes.json`. Download only the selected weight files. Downloads contain public model assets only.
3. Qwen source commit: `924694251d9e0f18e5d86bbd06aa3ab5f870002d`; build `make blas` in its isolated vendor checkout. Compile `scripts/asr-qwen-batch.c` with the resulting `qwen*.o` objects, `-lpthread -lm -framework Accelerate`, and the vendor include directory. The adapter invokes the existing float32 PCM API; the upstream model code is unchanged.
4. Native inference: `artifacts/asr-replacement/runtime-env/bin/python scripts/asr-replacement-native.py qwen-0.6b` (or `fun-mlt`). Result files are exclusive; archive an earlier run before repeating. Fun source commit: `c0a20e2bb698bbad11d143bdccd6c0760e9d6e5b`; use an isolated Python 3.12 environment with matched torch/torchaudio 2.9.1, Transformers 4.57.6 and FunASR 1.4.16. Record the final installed package lock.
5. Browser: set `LISTEN_PLAYWRIGHT_PATH` to the installed Playwright directory, then `node scripts/asr-replacement-browser.mjs`. It checks staged weight hashes, clones the production build, loads the selected model from the isolated extension with standard localModelPath, and leaves production sources unchanged. Model preparation excludes checkpoint download.
6. Score: `PYTHONPATH=artifacts/whisper-eval-python artifacts/asr-replacement/runtime-env/bin/python scripts/asr-replacement-score.py`; render this report with `scripts/asr-replacement-report.py`.
7. Audit `evaluation-plan.json`, `machine.json`, raw variant JSON, checkpoint hashes, stderr logs and `scores.json` under `artifacts/asr-replacement/`. Scoring rebinds a temporary in-memory reference copy to each candidate; the canonical reference file is never rewritten.

Verification: typecheck, 144 existing tests, latency-tool checks, Whisper diagnostic checks, five reference-scoring tests, Python syntax checks and extension build passed during this run. No production model, capture, VAD, notes prompt or persistence change was made.
