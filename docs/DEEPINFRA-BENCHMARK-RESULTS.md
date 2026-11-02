# DeepInfra Qwen 0.6B — measured excerpt results

Measured 2026-10-25. **The Chrome extension is unchanged. This hosted recipe does not meet the requested 1–3 second complete-response target on this machine/network.**

Follow-up: [request-phase diagnostic](DEEPINFRA-REQUEST-OVERHEAD.md) measured six additional requests. Connection reuse was verified; most elapsed time remained after the client wrote the body and before response headers. Queueing versus remaining network/service work is not isolated.

The user authorized uploading the existing reviewed excerpts to DeepInfra. We used the exact 18 preserved eight-second WAVs, three serial passes, for 54 requests and 432 seconds of submitted audio. These represent six periods from one meeting, with tab/microphone/combined representations; they are not 18 independent meetings. References were used only for offline scoring, never sent to the provider. No Mandarin data was tested.

## Request recipe

- Endpoint: `https://api.deepinfra.com/v1/inference/Qwen/Qwen3-ASR-0.6B`.
- One multipart field, `audio`: unchanged 16 kHz mono IEEE float32 WAV. The WAV payload was verified byte-for-byte against the original float32 PCM.
- Provider defaults, no explicit language hint, prompt, reference vocabulary, correction, or adjacent context.
- One Python requests session, serial requests, no automatic retries; first-pass manifest order, subsequent-pass shuffled order with fixed seed.
- 54-attempt ceiling; stop on authentication/billing/schema/configuration failures, or reported cost reaching $0.10. Neither stopping condition occurred. No further inference requests were made.
- Credential supplied to a process with terminal echo disabled, held in memory, not written to scripts or artifacts. No proxy environment variables were present. The benchmark measures this local caller's network path, not a deployed backend.

## Speed and cost

| Measure | Observed |
| --- | --- |
| Successful requests / attempts | 54/54 |
| Automatic retries | 0 |
| Full-response median | 5.706 s |
| Full-response p95 | 9.681 s |
| Full-response range | 2.401–10.340 s |
| Complete responses within 3 s | 3/54 (5.6%) |
| Complete responses within 1 s | 0/54 |
| Provider-reported runtime median | 0.138 s |
| First request | 7.631 s |
| Pass medians | 4.985 / 5.352 / 5.859 s |
| Speech-only requests | 39, median 5.796 s; 2/39 within 3 s |
| Provider-reported total cost | $0.00143856 |

Full response means the complete prepared input is available before timing starts; timing ends after the complete JSON response is read and parsed. This includes request preparation/upload, connection/network, waiting/service overhead, and response handling. It excludes the eight seconds of audio collection, live segmentation, a future relay, LLM notes, and browser presentation. p95 uses linear interpolation over successful request wall times. There were no failed requests to exclude; all attempts remain in the deadline denominator.

Provider runtime is self-reported, not an independently traced inference stage. The median per-request difference between total time and reported runtime was 5.488 s. This establishes a large unaccounted portion; it does **not** isolate network/upload, queueing, internal preprocessing, or other service work. No DNS/TLS/upload stage instrumentation or provider queue timestamps were collected. Do not claim queueing or the network is proven to be the cause. A backend closer to the provider may help, but no improvement has been measured.

## Accuracy and output stability

Same literal WER scoring and exact human references as the previous local comparison; no spelling normalization beyond the existing scorer. WER is an error rate, not percent accuracy.

| Configuration | Combined-source errors / reference words | WER | Quiet controls with speech-like text |
| --- | --- | --- | --- |
| Previous local Qwen 0.6B CPU | 45/125 | 36.0% | 2/5 |
| DeepInfra pass 1 | 42/125 | 33.6% | 3/5 |
| DeepInfra pass 2 | 42/125 | 33.6% | 3/5 |
| DeepInfra pass 3 | 42/125 | 33.6% | 3/5 |

Cloud output has three fewer word errors on the primary combined-source sample. Across all 13 speech representations per pass, three had fewer errors than local Qwen, none more, and ten tied. The representations overlap in source/time; do not treat them as independent quality wins or use this small sample to establish a general improvement. Local CPU inference and hosted request latency have different boundaries and deployment recipes.

Seventeen of eighteen excerpts had identical normalized output across three cloud passes. `864:combined` varied between two normalized transcriptions, with unchanged aggregate WER. Quiet outputs included Chinese filler on three controls; the additional false output versus local Qwen was `1192:microphone`. The cloud result does not solve silence hallucinations or all mixed-language terminology errors. No LLM cleanup was applied.

## Decision

Retain Qwen 0.6B as the user's chosen model family/checkpoint direction. This benchmark supports cheap hosted access with broadly similar output on the accepted examples, but it **does not justify production rollout under a 1–3 second request target**. Keep the extension unchanged.

The next diagnostic, if pursued, should instrument the current request path (connection setup, upload completion, first response byte, full response, provider runtime) and compare the actual intended backend region with the current local caller before changing model or segmentation. Shorter audio collection could reduce live lag but is a separate quality-sensitive change. No claim of another provider being faster follows from this single-host run.

## Preserved artifacts and reproduction

Private output folder: `artifacts/deepinfra-qwen/20261025T094927Z/`.

- `RESULTS.md`: all 18 audio links, exact human references, previous local Qwen transcripts, and all three cloud outputs.
- `run.json`: request order, timings, status, hashes, settings, reported costs and runtime.
- `response-01.json` through `response-54.json`: raw successful responses.
- `summary.json`: accuracy groups, timing distributions, silence results, and output consistency.

Frozen reference SHA256: `76136748b1548b4011e27fcd7f70660c264725d0e25bacb6a71c63cebf6ce862`.

Manifest SHA256: `4c65ea15580bbe5c6cd3d3c1ee417db67e4aa20324005add7f5c7f99bf008867`.

Benchmark script SHA256: `5fa4ba80add80f81c959b678127cbcc7423bab03c7636e9b6d6595ff6a1ab944`.

Run SHA256: `67801fd43fb4cb979000be7c04ab6e0791264e97985caca5bc917e6022f504f0`.

Existing environment commands (Python executable: `artifacts/asr-replacement/runtime-env/bin/python`):

```sh
# Offline input verification; zero API calls.
artifacts/asr-replacement/runtime-env/bin/python scripts/asr-deepinfra-benchmark.py --dry-run

# Offline boundary tests; requests replaced with fake responses.
artifacts/asr-replacement/runtime-env/bin/python scripts/test_asr_deepinfra_benchmark.py

# Offline scoring/report generation; no API calls.
PYTHONPATH=artifacts/whisper-eval-python artifacts/asr-replacement/runtime-env/bin/python scripts/asr-deepinfra-report.py artifacts/deepinfra-qwen/20261025T094927Z
```

A new paid run requires the benchmark script without `--dry-run`, receiving a key through stdin in an echo-disabled terminal. It creates a new output directory; it does not overwrite this run. Do not put the key in a command argument, source file, or shell history.

Verification: frozen corpus hashes passed before and after; 54 raw response hashes verified; script hash matches the executed recipe; provider statuses all `succeeded`; three offline tests passed covering request cap/audio-only payload, credential non-persistence, authentication stop, and malformed-schema stop. No extension build or browser test is claimed: no production source was changed.
