# Qwen 0.6B cloud hosting: performance evidence

Checked 2026-10-25. Scope: retain Qwen3-ASR 0.6B as selected; investigate hosting performance, not a new model contest. This document records the initial public research, which made no inference calls. A subsequent user-authorized live run is now complete: [measured DeepInfra results](DEEPINFRA-BENCHMARK-RESULTS.md). It observed 5.706 s median complete-response latency and 33.6% combined-source WER; production remains unchanged. The public latency snapshot below is not our measured result.

## Finding and recommendation

DeepInfra direct is the strongest documented shared-host starting point for the selected checkpoint. Its public price is $0.00020/audio minute ($0.012/audio hour). There is a promising public latency signal via OpenRouter, but no evidence sufficient to certify our 1–3 second complete-transcription requirement or rank a fastest/highest-quality host. Treat the recommendation as a host to verify, not an established production winner.

## Evidence matrix

| Route | Established by reviewed sources | Not established |
| --- | --- | --- |
| DeepInfra direct | Exact 0.6B model listing; synchronous multipart audio upload; text, segment/word timestamps and runtime metadata in API example | Per-audio-length p50/p95/p99 from our service; live incremental input API; serving revision/precision and equivalence to our local recipe |
| OpenRouter -> DeepInfra | Same upstream provider listed; a current public p50 latency snapshot | Faster than direct; independent inference capacity; our input-length and network latency distribution |
| reMona | Named 0.6B endpoint and multipart upload example | Comparable model-specific latency distributions, serving recipe, independent infrastructure, incremental input transport |
| FlexAI dedicated | Provisioned Qwen 0.6B endpoint offering, billed by GPU time | Public model-specific comparative latency/accuracy or an economical advantage at our traffic level |
| Alibaba Flash Realtime | Documented managed real-time audio service | Exact identity with the selected open 0.6B checkpoint; a directly comparable host benchmark |

Sources: [DeepInfra model](https://deepinfra.com/Qwen/Qwen3-ASR-0.6B), [API](https://deepinfra.com/Qwen/Qwen3-ASR-0.6B/api), [OpenRouter model route](https://openrouter.ai/qwen/qwen3-asr-0.6b), [reMona](https://www.remona.net/docs/models/qwen-qwen3-asr-0-6b), [FlexAI](https://flex.ai/models/qwen3-asr-0-6b), [Alibaba](https://www.alibabacloud.com/help/en/model-studio/asr-model/).

## How to interpret published speed

The OpenRouter page returned **0.75 s p50** for DeepInfra, all locations / one-week view, in the research snapshot. Audio durations, workload composition, sample count, and ASR-specific clock boundaries were not disclosed alongside that value. No p95 for our workload was established. Earlier retrievals in this conversation returned a different snapshot (10.30 s); these are not controlled observations and do not establish a measured speed improvement or deterioration. Do not pool them or treat them as direct-host tests. Exclude search mirrors and scraped model directories as independent benchmarks.

OpenRouter's transcription tutorial describes a request/JSON-response endpoint and says most routing controls are not applied there. Do not assume chat-specific percentile routing or quantization filters also work for transcription. Going direct removes a gateway dependency, but lower actual latency must be measured rather than assumed. [Transcription endpoint behavior](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/).

Qwen's technical report gives about 92 ms average time to first token for a particular low-concurrency server inference setup. This excludes our complete capture/upload/application path. Its aggregate throughput claim at high concurrency is not the completion time for a single user's audio. Neither number is a hosted DeepInfra service commitment. [Technical report, section 2.4](https://arxiv.org/html/2601.21337v2).

## Queueing and service tiers

DeepInfra documents 200 concurrent requests per model by default and warns that a busy model can return HTTP 429 even below the account limit. Capacity recovery and retries can add delay. Account concurrency allowance is not reserved model capacity or a latency SLA. [Rate limits](https://docs.deepinfra.com/account/rate-limits).

The Qwen page exposes generic service-tier and fail-fast fields, but explicitly limits priority/flex behavior to models supporting those tiers. I did not establish a Qwen-specific priority entitlement or premium rate. Do not promise a priority-tier fix. Fail-fast trades queue waiting for immediate failure; it does not create a successful fast transcript. Prefer default service over speculative flex settings for the initial live check.

## Quality: what the same model name does and does not prove

Our human-reviewed local Qwen output remains the reason for selecting 0.6B. A hosted checkpoint name does not pin the same revision, preprocessing, precision, language detection, decoding, or context behavior. No reviewed public host comparison establishes the best Indonesian–English–Mandarin switching quality.

Qwen's own section 4.5 compares offline and streaming with 2-second chunks. For 0.6B, its reported average error score increases from 3.48 offline to 4.40 streaming across the listed English/Chinese tests. Those scores are not our meeting accuracy, an Indonesian result, or a claim about DeepInfra's implementation. They do demonstrate why changing inference mode is not automatically quality-neutral. Do not implement frequent independent tiny uploads and assume equivalence to the paper's stateful streaming. [Technical report, section 4.5](https://arxiv.org/html/2601.21337v2).

The DeepInfra documentation reviewed establishes a complete-audio upload API. Model-card text about streaming capability and an internal chunk-length parameter do not establish a live transport that accepts incremental microphone frames. Chat token streaming and speech synthesis streaming are also different features. Plan around the documented upload path unless model-specific live-ASR documentation is obtained.

## What the 1–3 second requirement means

Keep two measurements separate:

1. Complete-input request latency: send a prepared audio excerpt and measure until complete, usable JSON arrives at our backend. This answers the user's question about provider response to our service. Include connection/setup, upload, queue, inference, download, failures, and retries.
2. Live transcript lag: end time of a spoken word in replay -> receipt/commit of the final text containing it. This additionally includes audio collection and scheduling. An 8-second window plus a hypothetical 0.75-second response can delay the earliest speech by roughly 8.75 seconds, before relay/network overhead and LLM notes.

The hypothetical arithmetic is not an observed service result. A 1–3 second upload response does not imply all speech becomes visible within 1–3 seconds. Shorter clips may lower collection delay but change available recognition context. Do not alter chunking as an unmeasured side effect of hosting selection.

## Smallest remaining verification

Before production integration, validate **DeepInfra direct only** with the existing immutable reviewed corpus and baseline outputs. No new provider tournament or model tuning is needed. Credentials must be configured server-side and the audio's cloud processing authorized before this step; no such live run was performed here.

- Send all 18 preserved excerpts once, unmodified, with a fixed request recipe, no reference leakage, no vocabulary/LLM correction, and model/language detection settings recorded. Score against the exact human references, including quiet controls.
- Reuse those same inputs for a small, capped latency sample (for example three passes, 54 requests total including the initial pass; count retries inside the cap). Space passes across time, start sequentially, and keep the first connection separate. Report p50/p95, maximum, failures, retries, and useful output rather than fastest-only timing. Tail estimates from such a small sample remain uncertain.
- Record backend region, local network, connection reuse, audio duration, wall-clock request latency, provider runtime when returned, model ID, all settings, request IDs, and actual billed cost. Provider runtime alone excludes the rest of the request path.
- Compare hosted results to local Qwen rather than rerunning unrelated models. Manual review should focus on lost technical terms, language switches, names/numbers, and hallucinated speech on silence. Mandarin needs additional verified data before a Mandarin-quality claim.
- A single continuous real-speed replay then checks capture/queue lag, sustained throughput, Stop/final flush, duplicate/lost segments, and notes delivery. Keep original segmentation first; any later shorter-window strategy is a separate controlled change if collection delay is the dominant bottleneck.

If complete-input requests reliably meet the target and hosted output preserves the accepted local quality, integration is justified. If the bottleneck is queueing, network, collection, or decoding, identify it before changing architecture. Public research can narrow the choice; it cannot substitute for a provider measurement from our actual service path.
