# Whisper recognition investigation

Measured locally on 2026-10-23. This is a diagnosis of the existing recognizer, not a model migration or an accuracy certification.

## Result

We reproduced the earlier podcast's repetitive first transcript **before the LLM**, using the same Whisper model, revision, precision and decoding defaults. Adding 64 ms of digital silence before a captured speech window, while retaining every original speech sample, produces exactly the same repetitive text saved in the earlier podcast run. Removing 64 ms from the tail alone does not. A boundary-sensitive decoding failure is therefore demonstrated on this input; the exact cause of the historical capture remains unproven because its original model-input PCM was not saved.

The repeated text reaches the output-token limit without generating EOS, and our browser decoding path accepts it without the repetition-based fallback present in OpenAI's reference implementation. This is a concrete robustness gap to address before attributing all errors to model size.

Ordinary word substitutions are a separate unresolved issue. No human-verified podcast transcript is available, so this investigation does not report WER, corrected wording, or a model accuracy percentage.

Production source, model, stream mixing, VAD settings, transcription options and notes behavior are unchanged. New tooling is opt-in and operates on an isolated extension copy. No live HPOP requests were made for this investigation.

Follow-up: [bounded fallback evaluation](WHISPER-FALLBACK-EVAL.md) reports paired testing against 20 reference recordings and the frozen podcast failure. It improves one repetition case while leaving ordinary word errors unresolved; production baseline is retained.

## Existing recognition path

1. Tab and microphone are captured separately; the ASR input combines them into mono at gain 0.5 each.
2. The audio worklet supplies 16 kHz PCM. Silero V5 probabilities drive the segmenter: about 0.4 s preroll, 0.6 s trailing silence, 0.25 s minimum speech, approximately eight-second forced windows and one-second overlap.
3. The worker compares Indonesian and English language-token logits, then transcribes each window independently.
4. Transformers.js **3.8.1**, `onnx-community/whisper-base`, revision `1846881b6b3a3024392c1eea3ad983695bc23925`, WebGPU, fp32 encoder and q4 merged decoder.
5. Measured effective decoding: `num_beams=1`, `do_sample=false`, `repetition_penalty=1`, `no_repeat_ngram_size=0`, `max_new_tokens=128`. Although config reports `temperature=1`, sampling is disabled. Changing temperature alone is not an established remedy for this path.
6. The controller cleans known blank markers, removes matching overlap text between windows, and sends finalized transcript text onward. It does not check intra-window repetition or whether generation ended at EOS.

The inspected installed `_call_whisper` path has one `model.generate` call per chunk and no compression/log-probability fallback loop. OpenAI's Python transcriber has additional behavior; using Whisper weights in Transformers.js does not automatically include that entire transcriber.

## Captures and controlled probes

Source: [podcast opening, starting at 00:00](https://www.youtube.com/watch?v=4Yll_sh1IY4). Native Chrome tab capture and production VAD/Whisper were used. The microphone was a silent test stream. The notes provider was synthetic to avoid unrelated LLM calls; no notes-quality or end-to-end live-LLM latency claims follow from this run.

`artifacts/whisper-debug-podcast.json` stores raw recognition responses, generated token IDs, selected language and effective decoding settings. Its `.asr/` directory contains exact Float32 model inputs, SHA-256 hashes and lossless float WAV copies. Samples are copied before the production ArrayBuffer transfer detaches them. Four windows were captured: 8.000, 7.912, 8.000 and 8.008 seconds; all selected Indonesian, had finite samples, and had no samples at or beyond amplitude 1. Peaks ranged from 0.267 to 0.394 and RMS from 0.0485 to 0.0526. This excludes digital clipping/non-finite PCM in these windows; it does not establish intelligibility or rule out every capture defect.

The new live capture did not loop. Its first raw output includes `boonnya pengelompat sebenarnya`; subsequent windows contain other questionable words. These are review candidates, not an approved reference transcript.

`artifacts/whisper-debug-replay.json` contains **19 local decoding cases**, including controls and repeats, not 19 independent recordings. Replay bypasses capture/VAD and feeds exact saved PCM into the same production worker with a diagnostic observer. Each input and deliberate transformation is hashed. Timings include observer overhead and are not a benchmark of uninstrumented production.

| Probe                                                     | Observed result                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Original first-window PCM, three repeats                  | Identical text and token IDs; 47 generated tokens plus four prefix tokens; EOS present                                      |
| Original PCM, token allowance 128 → 256                   | Identical text and tokens                                                                                                   |
| Original PCM, no-repeat trigram constraint                | Identical text and tokens                                                                                                   |
| Original PCM, amplitude ×2                                | Identical text and tokens; no clipping                                                                                      |
| Prepend 32 ms silence, remove 32 ms tail                  | Changed word choices, no loop                                                                                               |
| Prepend 64 ms silence, remove 64 ms tail, three repeats   | Identical repetitive text/tokens across all three; 128 generated tokens plus four prefix tokens; no EOS                     |
| Prepend 128 ms silence, remove 128 ms tail                | Repetition; token limit reached without EOS                                                                                 |
| **Prepend 64 ms silence, preserve all speech**            | **Same repetitive output as the historical first transcript**                                                               |
| Remove 64 ms tail, add no leading silence                 | Same text/tokens as original first window                                                                                   |
| Failing 64 ms shifted input, token allowance 256          | Loop continues to 256 generated tokens, still no EOS                                                                        |
| Failing 64 ms shifted input, no-repeat trigram constraint | Loop stops and EOS appears, but output changes to wording such as `Harim`, `Harad`, `pengel 4`; accuracy is not established |
| Other three captured windows                              | Raw text and token IDs match their live capture outputs                                                                     |
| Eight seconds of digital silence sent directly to worker  | Returns `you`, selects English; this bypasses VAD and does not demonstrate live silence leakage                             |

OpenAI's UTF-8/zlib compression-ratio metric is **1.31** on the original first window and **7.44** on the looping window, compared with the reference fallback threshold **2.4**. Raising the allowance to 256 yields **14.35**. This metric would flag this loop, but is not a general factual-accuracy score and can flag legitimate repetition.

## Evidence boundaries

- **Confirmed:** leading input alignment can trigger the repetitive failure for this pinned browser recognizer; output truncation is a consequence here, rather than insufficient allowance causing missing words.
- **Confirmed:** the raw worker output contains the problem. LLM note generation and inter-window overlap cleanup are not required to reproduce it.
- **Confirmed:** the tested speech windows select Indonesian; selecting English does not explain these cases.
- **Not demonstrated:** a segmenter bug, resampling bug, q4 quantization defect, universally inadequate model capacity, or the exact historical startup offset. The PCM-level reproduction bypasses VAD, so it cannot establish that VAD itself is broken.
- **Not measured:** real microphone/tab overlap, accents and languages beyond this passage, a human-verified podcast error rate, or higher-precision/larger-model improvements.
- **Important distinction:** three repeat decodes establish repeatability in this environment, not a population-wide reliability rate. Differences across fresh captures can also reflect different PCM and boundaries.

## Existing solutions to adopt and evaluate

[OpenAI Whisper's reference transcriber](https://github.com/openai/whisper/blob/main/whisper/transcribe.py) checks compression ratio and average log probability and retries failed decodes with a temperature schedule. The [maintainer's explanation of repetition](https://github.com/openai/whisper/discussions/192) identifies this as a known sequence-to-sequence failure mode. [Faster-Whisper's sequential transcriber](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py) likewise checks repetitive/low-confidence results and performs fallback decoding. These are existing approaches to adapt, not a need to invent an STT model.

Transformers.js supports a [no-repeat n-gram processor](https://huggingface.co/docs/transformers.js/api/utils/generation). The probe proves it can interrupt this loop, **not** that globally suppressing repeated phrases improves transcription. It can also interfere with legitimate repeated speech. Do not ship that probe as an accuracy fix.

The next scoped experiment should evaluate a bounded repetition/EOS-triggered fallback inspired by the reference transcribers, against these frozen inputs and verified speech references. Keep the original transcript when uncertainty cannot be resolved; do not silently invent corrected words or drop legitimate speech. Check both recovery accuracy and added latency, and verify the exact JS implementation supports the proposed decoding controls. Python-only option names must not be assumed to work in this browser runtime.

For ordinary substitutions, first annotate the saved WAVs against their actual words, including code-switching, names, interrupted words and overlapping speakers. Use that frozen reference to compare boundary handling, current decoding and precision separately. A model-size comparison becomes warranted if these controls leave an accuracy deficit; the present evidence does not yet choose a replacement model.

## Reproduce

Requirements: Node 22+, built extension, Chrome with WebGPU, Playwright available through `LISTEN_PLAYWRIGHT_PATH` or normal package resolution. Keep these local transcript-bearing artifacts outside commits. Diagnostic capture saves at most eight PCM inputs and is off unless explicitly requested.

```sh
pnpm build
export LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright

# Native capture + VAD + Whisper, synthetic notes provider, no HPOP key required.
node scripts/notes-latency-browser.mjs \
  --url 'https://www.youtube.com/watch?v=4Yll_sh1IY4' \
  --duration 30 --offline --run --capture-asr \
  --output artifacts/whisper-debug-podcast.json

# Frozen input replay and explicitly labelled local probes; no LLM calls.
node scripts/whisper-debug-replay.mjs \
  artifacts/whisper-debug-podcast.json artifacts/whisper-debug-replay.json

pnpm check
```

Fresh capture bytes and recognition may differ. Replay is the controlled comparison. Browser capture and replay share an exclusive evaluation-build lock and should run sequentially. The replay emits a lossless `artifacts/whisper-debug-replay.json.boundary-repro.wav` for reference annotation; it preserves all original speech with 64 ms added silence.

Measured provenance:

```text
Production source aggregate:
bd105bed31d46cadbf613f781ee2fb1a8c4216272139937b1ac2897c98f7b368
Production build aggregate:
0c348c7dd776c3572cf12f398a687af085e70adb491c45f6d9cb9a51814e18a3
Production model-worker SHA-256:
d1b346a22e5b29dc53e999057f6fb6605f95dc8952b4e41557433c402a16b20a
Original first-window PCM SHA-256:
60ea37c0ffcf8958797ebc6085cdfa64b1d115869eb94ed9d81d058ed19255da
64 ms leading-silence, preserved-speech PCM SHA-256:
19ce02fbb403311dd3af5de4e7feccad8e8e3d586f1795bb6b29a02afa73ec60
```

The JSON reports contain harness/observer hashes and Chrome version for their actual runs. The original capture used the initial observer; subsequent replay uses its updated diagnostic version. No production decoding change was made between them.

Verification: production typecheck, 144 existing unit tests, latency-tool checks, new PCM-transfer/diagnostic-isolation checks and extension build passed. The new tests verify preservation before buffer detachment, sample/hash metrics, bounded raw-audio capture, unchanged default generation options and returned tensors, probe reset and exclusion of unapproved override keys. Actual Chrome capture completed with four raw inputs and nineteen replay cases completed.
