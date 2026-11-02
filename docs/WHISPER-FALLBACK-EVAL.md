# Bounded Whisper fallback: controlled evaluation

Measured on 2026-10-23. **Decision: retain production baseline.** A local candidate can recover repetitive decoding, but this experiment does not establish reliable recovery of the spoken words. No production model, recognition settings, capture, VAD, stream mixing or notes behavior changed.

## What was tested

The candidate adapts the repetition-based retry approach in [OpenAI Whisper](https://github.com/openai/whisper/blob/main/whisper/transcribe.py), keeping the existing pinned base model and fp32/q4 WebGPU execution. It is deliberately a partial adaptation, not an implementation of the whole upstream transcriber:

1. Run the existing greedy decode with its 128-token allowance.
2. Flag UTF-8/zlib compression ratio above 2.4, or token-limit exhaustion without EOS.
3. Retry the **same audio**, preserving the detected language and token allowance, at temperature 0.2 with sampling enabled and `top_k=0`; if still flagged, retry once at 0.4.
4. Use the first structurally acceptable response. If both retries fail or error, preserve the original response and mark recovery unresolved.

No reference transcript enters recognition or selects a retry. Structural acceptance is not an accuracy/confidence score. This candidate does not use upstream average-log-probability ranking or no-speech probability checks. Installed Transformers.js 3.8.1 was inspected for sampling/temperature support, and effective settings were recorded for actual retry calls. RNG seeds are local evaluation controls; native randomness is restored after each call.

The experiment plan was saved **before decoding**. There were 46 paired cases, all completed without errors:

- **Primary:** 20 distinct FLEURS read-speech recordings: 10 Indonesian, 10 English, with published dataset transcripts.
- **Secondary:** those same 20 recordings with 64 ms leading silence added. They are derived controls, not another 20 independent recordings.
- **Diagnostic:** five seeded trials of the same failing podcast passage, plus one digital-silence control. The podcast has no verified reference transcript.

Baseline/candidate order was randomized for the 40 reference-backed pairs: baseline ran first 21 times, candidate 19. Audio was decoded with Chrome at 16 kHz and replayed as eight-second windows with one-second overlap, using production overlap cleanup. This isolates ASR and **bypasses VAD, real-time capture and live notes**. Word-error rates below describe this offline windowing protocol, not the complete extension or spontaneous meetings.

## Results

Scoring uses [JiWER](https://github.com/jitsi/jiwer) 4.0.0, with Unicode punctuation replaced by spaces, lowercasing and collapsed whitespace. Numbers remain literal: `25` and `twenty five` differ. Word error rate is `(substitutions + deletions + insertions) / reference words`; it is not a percentage of words the model is guaranteed to recognize correctly. Per-recording CER and word alignments are saved too.

| Cohort                                 | Baseline word errors      | Candidate word errors | Baseline WER | Candidate WER | Changed recordings |
| -------------------------------------- | ------------------------- | --------------------- | ------------ | ------------- | ------------------ |
| Primary: all 20 originals              | 129 / 371 reference words | 98 / 371              | 34.77%       | 26.42%        | 1 / 20             |
| Primary: Indonesian, 10                | 106 / 159                 | 75 / 159              | 66.67%       | 47.17%        | 1 / 10             |
| Primary: English, 10                   | 23 / 212                  | 23 / 212              | 10.85%       | 10.85%        | 0 / 10             |
| Secondary: 20 leading-silence versions | 107 / 371                 | 107 / 371             | 28.84%       | 28.84%        | 0 / 20             |

**All 31 fewer errors in the primary cohort come from one recording.** Insertions decrease from 59 to 26; substitutions increase from 64 to 66; deletions stay at 6. The other 19 recordings are unchanged. No clip has a higher total error count, but this does not establish that all important facts were preserved.

The affected recording is `id_id-10079821246909257680`, about announcements on the Metro in different languages. Its last window loops on `terdapatkan kebangan`. The first retry also loops. The second returns `yang berbual dengan jepang.` Its whole-recording WER improves from 177.78% to 62.96%, mainly because repeated insertions disappear. However, the reference lists **Spanyol, Inggris, Prancis, Arab, dan Jepang** and the candidate still fails to recover that list. This is direct evidence that stopping a loop does not establish useful word recovery.

Across the five podcast seeds, the candidate exits the repetition loop and reaches EOS in **5/5 trials**, using one retry each. It still produces questionable wording such as `pengel 4`; no podcast WER or factual-quality pass is claimed. Five seeds on one passage do not estimate reliability across recordings.

Digital silence still produces `you` in both variants, without triggering fallback. This direct-worker control bypasses VAD and does not demonstrate silence leakage in live recording. It also shows a limitation of repetition/EOS checks: a short hallucination can pass both.

## Latency and uncertainty

- Primary median summed inference: **813 ms baseline, 807 ms candidate**. The small difference is normal paired measurement variation; it is not a claimed speedup. Nineteen original recordings did not retry.
- Primary p95 summed inference: **1,011 ms baseline, 1,100 ms candidate**. With only 20 recordings this percentile is sensitive to the single slow case.
- The affected reference recording adds **2,053 ms** summed inference for two retries.
- Podcast retries add **726–853 ms**, median **765 ms**, relative to the paired baseline.

These are instrumented, warmed local decoding measurements. They exclude model download, real-time audio collection, live VAD, LLM generation and sidebar presentation. End-to-end elapsed times including the CDP bridge are recorded separately; neither measure is visible-note latency.

A paired bootstrap over the 20 primary recordings, 4,000 resamples with seed 20261023, gives a 95% interval for candidate-minus-baseline WER of **−25.55 to 0 percentage points**. This broad interval reflects that only one recording changes. It does not establish a population-wide benefit or general language ranking. Baseline/fallback differences on untriggered clips are exactly zero; their zero-width bootstrap interval is not evidence that unseen clips cannot regress.

## Interpretation and next boundary

The repetition detector finds a real failure in a second source recording, and temperature fallback can end it. However, the current candidate sometimes replaces a loop with a short, incomplete transcript. **Do not enable it based on lower aggregate WER alone.** Natural-speech accuracy review, confidence-aware selection, legitimate repeated-speech controls and production capture/VAD regression checks remain outstanding.

The broader word-recognition problem remains: many substitutions occur without repetition or token exhaustion, so this fallback never attempts them. Overlap cleanup also leaves some repeated words when independently decoded overlapping windows use different spellings. Those errors are not evidence that one global silence offset, larger token budget or repetition constraint will solve accuracy.

The next focused comparison should keep these reference errors frozen and test existing decoding/context handling or precision independently, rather than changing the model and pipeline together. Any recovery selection must be assessed for preserved names, lists, numbers and meaning, not merely a lower repetition score. The present experiment does not choose a replacement model or establish quantization as the cause.

## Reproduce and inspect

```sh
pnpm build
export LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright

# Uses the existing frozen corpus and exact podcast PCM; no HPOP calls.
node scripts/whisper-fallback-eval.mjs artifacts/whisper-fallback-eval.json

# Evaluation dependencies are isolated from the application.
python3 -m pip install --target artifacts/whisper-eval-python \
  -r scripts/requirements-whisper-eval.txt
PYTHONPATH=artifacts/whisper-eval-python python3 scripts/whisper-fallback-score.py \
  artifacts/whisper-fallback-eval.json
PYTHONPATH=artifacts/whisper-eval-python python3 scripts/test-whisper-score.py

pnpm check
```

Input fixtures come from `artifacts/latency-corpus/manifest.json`, prepared by `scripts/prepare-latency-corpus.py` from pinned [FLEURS](https://huggingface.co/datasets/google/fleurs) sources, and `artifacts/whisper-debug-podcast.json`. Both and all audio hashes are checked or recorded. See [the original investigation](WHISPER-DEBUG.md) for podcast capture commands. Freeze inputs instead of recapturing the podcast to reproduce these pairs. The FLEURS clips are read speech and must not substitute for natural meetings or mixed-language podcasts.

Local artifacts:

- `artifacts/whisper-fallback-eval.json.plan.json`: predeclared policy, case order, seeds, cohorts and limitations.
- `artifacts/whisper-fallback-eval.json`: immutable raw run, input hashes, every attempt and effective config, language, tokens, timing, selection and errors.
- `artifacts/whisper-fallback-eval.json.scored.json`: post-decoding scores and word alignments for review.
- `artifacts/whisper-fallback-eval.json.summary.json`: grouped rates, error counts, failures/missing cases, timing and bootstrap intervals.

Measured in Chrome **156.0.8078.47**, 2026-10-23 08:37:57–08:39:26 UTC. Source transcript and audio artifacts remain local. No paid LLM requests were made.

```text
Raw run SHA-256:
f2b510c2f51c750317d488d9b36ac1c9230cb63b5b3fb3dc546a7479725ce771
Manifest SHA-256:
a1a802dcb19e20c833d0c7c657369d326385a0387eff35ecc8f4d03a88b91ca1
Production model-worker SHA-256:
d1b346a22e5b29dc53e999057f6fb6605f95dc8952b4e41557433c402a16b20a
Evaluation worker observer SHA-256:
6304c11d66d36da85b877d001f27045acf23c4a26a9ea2a6b1194ef79e7580af
Evaluation harness aggregate SHA-256:
dabe10f41a1fafcb109164ce3fa02fdb058eb70e3a6fb0922943cf3d28a306bb
```

The raw run records the tools at evaluation time. Subsequently added configuration validation does not alter the measured retry policy. Scored output separately records its own script hash. JiWER, RapidFuzz and Click versions are pinned in the evaluation requirements file.

Verification passed: typecheck, 144 existing unit tests, latency tooling checks, diagnostic/fallback tests, JiWER normalization/count checks, and extension build. Fallback tests cover trigger detection, no-retry normal output, language retention, two-retry bound, preserving baseline on persistent failure or timeout, deterministic sampling and RNG restoration. Actual Chrome completed all 46 pairs; none were omitted from the report.
