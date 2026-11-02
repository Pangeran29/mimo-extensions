# ASR replacement: Indonesian, English and Mandarin

Research checked 2026-10-23. The user requires **Indonesian, English and Mandarin**, including code-switching within sentences. Mandarin was explicitly confirmed; Cantonese is not part of the primary requirement. This document shortlists existing systems and defines the comparison. The local pilot is underway; see [measured results](ASR-REPLACEMENT-RESULTS.md). **No replacement is enabled.** Production remains unchanged.

## Requirement and existing integration constraint

Language coverage and intra-sentence code-switching are separate acceptance criteria. A supported-language list does not prove accurate multilingual meetings. Preserve original-language words instead of translating everything to one language. Explicitly check technical English inside Indonesian, Mandarin-English switches, names, numbers, corrections and concurrent voices.

Our current `src/transcription/model-worker.ts` compares only Indonesian and English language-token logits and forces the winning language for the whole window. Chinese is not considered. A model swap alone cannot establish Mandarin support with that wrapper. Use an existing model/runtime language-identification path supporting the required languages; validate it in the isolated evaluation before production integration. A dominant-language label alone is not evidence of failed code-switching.

The installed runtime is Transformers.js **3.8.1**, WebGPU. Python Hugging Face Transformers support and ONNX availability do not by themselves establish compatibility with this browser runtime.

## Shortlist from primary sources

| Candidate                  | Evidence for required languages                                   | Existing implementation and practical fit                                                                                                                                                                                        | Role in comparison                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qwen3-ASR-0.6B / 1.7B**  | Official release lists Indonesian, English and Chinese.           | Official Python inference/serving toolkit; streaming is documented for its vLLM backend. Existing sherpa-onnx export/deployment resources also exist. No compatible implementation was found in our installed JS model registry. | Compare the smaller and larger checkpoints for accuracy/resource trade-off using an existing supported runtime. Treat as a local-service candidate until browser compatibility is demonstrated. |
| **Fun-ASR-MLT-Nano-2512**  | Its multilingual checkpoint explicitly lists all three languages. | Existing FunASR inference path. The regular Fun-ASR-Nano checkpoint has different coverage and cannot stand in for MLT.                                                                                                          | Independent multilingual alternative; verify checkpoint-specific runtime support and local performance.                                                                                         |
| **Whisper large-v3-turbo** | Model card lists English, Chinese and Indonesian.                 | An ONNX Community export explicitly targets Transformers.js. This makes it the closest browser-path candidate, but actual WebGPU loading, memory and accuracy must be tested.                                                    | Browser integration comparator against the current base checkpoint.                                                                                                                             |

Sources: [Qwen official implementation](https://github.com/QwenLM/Qwen3-ASR), [Qwen technical report](https://arxiv.org/abs/2601.21337), [sherpa-onnx Qwen deployment](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/export.html), [Fun-ASR official implementation](https://github.com/QwenAudio/Fun-ASR), [Whisper turbo model card](https://huggingface.co/openai/whisper-large-v3-turbo), [browser-oriented ONNX export](https://huggingface.co/onnx-community/whisper-large-v3-turbo).

**Research priority:** Qwen3-ASR provides a documented all-three-language candidate with an existing inference toolkit. Whisper turbo provides a browser-oriented comparison. Fun-ASR-MLT-Nano provides an additional established alternative. This is an evaluation priority, not a measured ranking or a claim that any one model solves Indonesian/Mandarin code-switching.

Do not select English-only checkpoints. SenseVoiceSmall's public release lists Mandarin, Cantonese, English, Japanese and Korean, which does not meet the Indonesian requirement. Do not transfer capabilities between similarly named checkpoints. [SenseVoice source](https://github.com/QwenAudio/SenseVoice).

## Data and metrics

1. **Verified development examples:** preserve the 18 exact meeting excerpts and user-entered references in `training:meeting/verified-excerpts-v1-76136748b154/`. Thirteen are speech and five are no-intelligible-speech controls. They cover six periods of one meeting and are not independent session-level tests. Reference text never enters a decoder or model selection prompt.
2. **Single-language controls:** reuse the 10 Indonesian and 10 English FLEURS recordings with source hashes. Add Mandarin reference-backed recordings before claiming three-language support. Read-speech controls complement natural speech; they do not replace it.
3. **Natural code-switching:** use the verified Indonesian-English meeting and a separate Mandarin-English conversational corpus. [ASCEND](https://github.com/HLTCHKUST/ASCEND) provides spontaneous Mandarin-English conversation with annotations; confirm the dataset license and select a fixed held-out subset before downloading/evaluating. Do not describe concatenated monolingual clips as natural code-switching.
4. **Outstanding coverage:** Indonesian-Mandarin and three-way Indonesian-English-Mandarin conversation are not present in the current verified set. Report them as untested until suitable referenced recordings exist. No universal three-way reliability claim follows from pairwise tests.
5. **Independent validation:** reserve additional meeting periods and preferably different sessions/speakers from tuning. Reviewed development clips may diagnose a candidate but cannot remain an untouched test set after vocabulary or prompts are tuned against them.

Report Indonesian/English literal WER and Mandarin CER separately. Define Chinese script, punctuation, number and spacing treatment before scoring. Use Chinese-character/English-word mixed error rate for Mandarin-English switches, with a fixed tokenizer, alongside CER and name/term preservation. Avoid whitespace-only WER for Chinese or combining incompatible metrics into one misleading accuracy percentage.

Each result must include missing/no-note cases, no-speech behavior, detected language, false translations, hallucinated names/numbers, exact model/runtime revisions, audio hashes, warm/cold preparation, first stable transcript latency, finalized window latency, real-time factor and peak memory. Published server throughput or time-to-first-token is not browser performance or visible-note latency.

The user also requires storage and computer load to influence selection. See [resource estimates and measurement criteria](ASR-RESOURCES.md) for verified checkpoint sizes, clearly labelled memory budgets, hardware test tiers, CPU/GPU and power measurements, and concurrent-meeting gates. Resource predictions are not yet measured requirements.

## Controlled comparison and rollout

Use existing maintained inference implementations. Keep private audio local; this research does not authorize sending recordings to hosted demos or commercial APIs. Downloading public model assets is separate from uploading meeting content.

First run the frozen excerpts through each supported local runtime. Keep the same audio and dispatch context. Separate a matched-window comparison from each runtime's documented native streaming mode so a new model is not credited for a different window/context budget. Include existing upstream fallback/normalization behavior in provenance; do not pretend all runtime defaults match.

Evaluate accuracy and restored names/terms before deciding whether added latency and memory are acceptable. Then validate required languages and real code-switching on independent references, followed by live capture, VAD, source handling, continuous-session and notes-latency checks. A production switch requires evidence of practical gain; model marketing and supported-language lists cannot pass this gate.

No custom fine-tuning, replacement neural decoder, global spelling substitutions or growing collection of correction rules is the primary approach. Application integration should adapt existing recognizers rather than rebuild their speech-recognition algorithms. Keep the current baseline available for rollback.

## Current status

- Confirmed requirement: Indonesian, English, **Mandarin**, including code-switching.
- Preserved meeting excerpts, user references and baseline scores remain intact.
- Primary-source shortlist researched; candidate revisions recorded locally in `artifacts/asr-replacement/candidate-revisions.json`.
- Current two-language wrapper limitation identified; production untouched.
- No new checkpoint downloaded or executed in this research step; **no replacement accuracy/latency results are claimed**.
- Next executable work: prepare a pinned local comparison with suitable runtime adapters and Mandarin/code-switch reference fixtures. Record unavailable runtimes or missing fixtures as pending rather than passing them.
