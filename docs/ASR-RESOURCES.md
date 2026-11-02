# Replacement ASR: storage and computer resource estimates

Checked 2026-10-23. Disk estimates were collected from **actual file-size metadata at pinned model revisions**; selected checkpoints have now been downloaded for the local pilot. Runtime budgets and suggested PC tiers below are **planning estimates**, not certified minimum specifications. See [measured pilot results](ASR-REPLACEMENT-RESULTS.md) for completed runs and pending variants.

**16 GB is a test-machine target, not a verified minimum.** On this Apple M5, Qwen 0.6B's existing C CPU runtime reached 2.60 GiB peak process RSS across the 18 reviewed eight-second inputs, with 0.803-second median inference. It uses about 1.88 GB of model assets. This is a short single-recognizer pilot, not a full meeting or an 8 GB PC certification. The Whisper turbo Q4 browser run sampled about 4.09 GiB peak summed Chrome process RSS, including loading/warmup; summed RSS can count shared pages twice and is not directly comparable with the native process peak or a dedicated GPU allocation. That browser recipe was slower than real time (8.945-second median per eight-second clip).

Fun-ASR-MLT completed the same 18 inputs through its maintained Python CPU implementation: 4.80 GiB peak process RSS and 1.640-second median inference. Its audited checkpoint loaded all text-transcription tensors; upstream disables an untrained optional timestamp head. System swap was already about 5.8 GiB when this later run started, so resource/timing comparisons are descriptive rather than controlled idle-machine rankings. None of these short runs establishes a total-RAM minimum or sustained battery/thermal behavior.

Assumptions: one active recognizer, one meeting, short bounded audio windows, inference only, and notes generated remotely by the existing provider. A local notes LLM, simultaneous models, longer audio context or additional diarization requires separate resources. GB means decimal gigabytes; GiB means binary gigabytes.

If microphone and tab are later transcribed as two independent streams, measure both together. Recognition work and per-stream state increase; shared model weights may be reused by some runtimes, whereas separate worker/model instances may duplicate them. The single-stream estimates below cannot certify that future configuration.

## Model storage and working-memory budgets

| Candidate                    | Verified model weight download                                                                                                                       | Estimated ASR working-memory budget                     | Suggested total computer RAM for evaluation                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Qwen3-ASR-0.6B               | **1.876 GB** weights; about **1.88 GB** with model-side metadata/tokenizer                                                                           | **3–5 GB**                                              | **16 GB** mainstream target                                   |
| Qwen3-ASR-1.7B               | **4.699 GB** weights; about **4.70 GB** with metadata/tokenizer                                                                                      | **7–12 GB**                                             | **24–32 GB** preferred; 16 GB is a constrained test case      |
| Fun-ASR-MLT-Nano-2512        | **1.971 GB** checkpoint; about **1.99 GB** with tokenizer/config files                                                                               | **4–8 GB**, provisional                                 | **16 GB** feasibility target; **32 GB** comfortable test tier |
| Whisper large-v3-turbo, ONNX | **0.759 GB** for Q4 encoder + Q4 merged decoder; **1.619 GB** for FP16/FP16; **2.882 GB** for FP32 encoder + Q4 decoder, before a few MB of metadata | **4–8 GB**, provisional and precision/runtime dependent | **16 GB** starting target; **24–32 GB** gives more headroom   |

These working-memory budgets are allowances for model state plus execution buffers, loading copies and caches. They are not four published measurements. Host RAM and GPU VRAM allocations must be recorded separately where possible; Apple unified memory is shared and must not be counted twice. On a discrete-GPU PC, model allocations can be split between host RAM and VRAM, so the budget is not a promise that either pool alone is sufficient.

The model's advertised parameter count is not an adequate download-size calculator. The actual Qwen checkpoints include more than a simple `0.6B × 2 bytes` calculation suggests. Likewise, the Whisper FP32 encoder graph is only about 439 KB but references **2.548 GB of external tensor data**. That external file must be included. Do not sum every quantized variant in the repository: an installed model uses a particular file recipe.

Storage sources at the recorded revisions:

- [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B/tree/5eb144179a02acc5e5ba31e748d22b0cf3e303b0): `model.safetensors`, 1,876,091,704 bytes.
- [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/tree/7278e1e70fe206f11671096ffdd38061171dd6e5): two weight shards totalling 4,698,521,512 bytes.
- [Fun-ASR-MLT-Nano](https://huggingface.co/FunAudioLLM/Fun-ASR-MLT-Nano-2512/tree/2c088f535108689beff7e11cdc3d792af7d56552): `model.pt`, 1,971,090,564 bytes, plus local tokenizer/config files.
- [Whisper turbo ONNX](https://huggingface.co/onnx-community/whisper-large-v3-turbo/tree/360ebcde2559d60bb474678be3c1de9ef347d01a/onnx): selected encoder/decoder files and external tensor data where needed.

`artifacts/asr-replacement/resource-assets.json` preserves all file sizes from Hugging Face metadata; `resource-estimates.json` records the selected recipes and provisional budgets. No private audio was used for this lookup.

## Published memory evidence and its boundaries

The maintained [antirez Qwen CPU implementation](https://github.com/antirez/qwen-asr#cpu-memory-requirements) reports approximately **2.69–2.82 GiB** peak RSS for segmented 0.6B runs and **6.57–6.74 GiB** for segmented 1.7B runs on its Apple M3 Max benchmark. That is roughly 2.9–3.0 GB and 7.1–7.2 GB. Its CPU pipeline supports BLAS/Accelerate. Those results support including a native CPU option in evaluation; they do not predict our machine's exact memory or streaming speed. The official Python/vLLM path is a different runtime.

[OpenAI's Whisper table](https://github.com/openai/whisper#available-models-and-languages) estimates **about 6 GB VRAM** for the standard turbo implementation. That is a useful native-GPU reference, not measured WebGPU usage for our quantized ONNX export. Browser loading/shader workspaces and copies can produce different peaks.

No comparable checkpoint-specific, reproducible memory measurement was established for Fun-ASR-MLT-Nano in the reviewed primary documentation. Its **4–8 GB** allowance is an engineering estimate based on checkpoint size and runtime headroom. It must be replaced by measurements before setting a supported-PC minimum. Do not borrow a memory claim for the different regular Fun-ASR-Nano checkpoint.

## User PC targets to test

These are test cohorts, not shopping requirements or promised support:

| Tier                  | Hardware profile                                                                                | Interpretation                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lower-end feasibility | 8 GB total RAM; integrated graphics; recent four-core-class laptop                              | Stress/feasibility cohort. None of the shortlisted models is approved for this tier yet. Keep the meeting app and browser running during the test.                                                      |
| Mainstream target     | 16 GB RAM; modern six-to-eight-core-class CPU; SSD; compatible GPU/runtime                      | Primary target for Qwen 0.6B, Fun multilingual feasibility and quantized Whisper turbo. A CPU-supported native runtime can be tested without a dedicated GPU; this does not establish live performance. |
| Higher-resource tier  | 24–32 GB Apple unified memory, or 32 GB PC RAM with an 8 GB discrete GPU and compatible runtime | Preferred starting tier for Qwen 1.7B and generous headroom for the other candidates. GPU acceleration still depends on the selected implementation.                                                    |

For the browser candidate, verify actual WebGPU adapter support, limits, precision support and Chrome/runtime versions. For native candidates, use the existing runtime's supported CPU/GPU backend. ONNX availability does not make an architecture automatically compatible with our installed Transformers.js.

The current test computer is **Apple M5, 16 GB unified memory**, verified locally. It is a useful mainstream test machine, not proof that all 16 GB PCs will behave similarly. Qwen 1.7B may fit but needs close memory-pressure and concurrency testing on this machine.

Suggested **free-disk allowances**, separate from exact model weight sizes: reserve **3–5 GB** for a selected browser model and its cached variants, or **10–20 GB** for a native installation with Python/CPU/GPU dependencies, downloads and update headroom. These are installation-planning reserves, not measured package sizes. Users need only the chosen candidate, not every model. Meeting recordings are additional storage; the present three-track 22-minute recording is about 48 MB in total, while uncompressed analysis copies are much larger.

## CPU/GPU use and product impact

An honest CPU percentage cannot be derived from weight size. CPU-only inference can occupy several cores while processing; GPU inference shifts much of that work to the accelerator while keeping CPU work for capture, audio preparation and dispatch. Smaller models often reduce resource demand, but runtime efficiency, input duration, token count and recomputation can change the ordering.

Expect bursts during recognition, sustained model residency between chunks, and a larger cold-load peak. Whether the laptop becomes warm or drains battery quickly must be measured under a sustained meeting, not inferred from a single eight-second clip. A model that loads successfully can still be unsuitable if transcript backlog grows or the meeting UI becomes unresponsive.

## Resource indicators added to selection

For every model/runtime/precision and hardware tier, record:

1. **Disk/network:** selected weight bytes, installed runtime bytes, cache bytes, actual first download, cold start and warm start.
2. **Memory:** idle-to-loaded delta, steady and peak process memory, separately available GPU allocation, memory pressure and swap/page faults. Include the whole isolated browser/native process tree. Record aggregate RSS limitations and shared pages; do not label process RSS as exact physical GPU memory.
3. **Compute:** CPU core-seconds per audio minute, peak/average CPU utilization with its normalization stated, and GPU activity where the OS/runtime exposes it. If unavailable, report unavailable. One core at 100% and overall-machine utilization are different quantities.
4. **Timing:** ASR real-time factor, first stable text, finalized-window p50/p95, backlog over time, and 15/20/30-second visible-note attainment. Report real-time capture separately from faster-than-real-time file replay.
5. **Concurrent use:** an active meeting/video call, browser work and recording remain responsive; check audio loss, UI stalls and continuous-session finalization. Use the same workload for each candidate.
6. **Power/heat:** battery drain or energy per audio minute where measurable, thermal throttling and whether latency/backlog degrades over a 20–30-minute run. State OS permission/instrumentation limitations.

The basic keep-up condition is **RTF < 1** (less processing time than incoming audio duration). Prefer substantial margin; an initial engineering target is **RTF ≤ 0.5** under the concurrent workload, subject to the visible-note target. Neither threshold alone guarantees 15-second notes. A faster model still must pass Indonesian/English/Mandarin quality and code-switching checks.

Publish a minimum PC specification only after the lowest tested tier passes accuracy, latency, resource and sustained-session gates. Resource estimates do not qualify a model for rollout, and higher accuracy does not compensate for dropped audio or an ever-growing backlog.
