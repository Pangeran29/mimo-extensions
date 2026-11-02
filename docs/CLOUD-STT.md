# Managed cloud STT exploration

Research checked 2026-10-25. This supersedes the proposed customer-installed native Qwen deployment direction. No production changes, paid requests, or private audio uploads were made for this research. Preserve the existing recordings, human references, and local benchmark artifacts.

## Direction

Performance follow-up: [Qwen cloud performance evidence](QWEN-CLOUD-PERFORMANCE.md) separates published latency signals, queueing, inference mode/quality, and the remaining service-path measurement. No fastest or highest-quality host is established from public documentation.

**Latest clarification, 2026-10-25:** retain Qwen as the model choice, but research alternative hosting platforms for Qwen3-ASR 0.6B and compare hosting costs. The earlier interpretation that the user wanted Alibaba as the exclusive hosting vendor was incorrect. Do not reopen selection among unrelated recognition models.

### Verified alternative Qwen 0.6B hosting listings

Public list-price snapshots, checked 2026-10-25; no paid request or private-audio upload performed.

| Platform | Listed model | Published rate | Converted audio-hour rate | Delivery evidence |
| --- | --- | --- | --- | --- |
| [DeepInfra](https://deepinfra.com/Qwen/Qwen3-ASR-0.6B) | `Qwen/Qwen3-ASR-0.6B` | $0.00020/minute | $0.012 | [Documented multipart audio upload API](https://deepinfra.com/Qwen/Qwen3-ASR-0.6B/api); live input streaming not established by this documentation |
| [OpenRouter](https://openrouter.ai/qwen/qwen3-asr-0.6b) | `qwen/qwen3-asr-0.6b` | $0.000003/second | $0.0108 | Gateway; page lists DeepInfra as upstream, not a second independent hosting fleet |
| [reMona](https://www.remona.net/docs/models/qwen-qwen3-asr-0-6b) | `Qwen/Qwen3-ASR-0.6B` | $0.0000031/second | $0.01116 | Audio-upload endpoint; underlying infrastructure and live-streaming support not established |
| [Alibaba](https://www.alibabacloud.com/help/en/model-studio/model-pricing) | `qwen3-asr-flash-realtime`, Singapore | $0.000090/second | $0.324 | Documented real-time service, not identified as the exact 0.6B checkpoint |

DeepInfra is the strongest direct-host lead for the selected checkpoint based on these sources. Its advertised audio-hour rate is 27 times lower than Alibaba Flash Realtime's; this is a price comparison across different service/model offerings, not equal streaming capability. OpenRouter displays a slightly different effective rate; do not silently reconcile it with DeepInfra's direct rate. Verify billed duration rounding, gateway fees, and current account rates before budgeting.

At DeepInfra's published rate, 100 audio hours would cost $1.20 and 1,000 would cost $12, excluding backend/notes costs and any duplicated or overlapping audio. A chunk-upload integration can reuse current segmentation but includes collection delay; it cannot be represented as verified 1–3 second live streaming. Model-level streaming descriptions on a model card do not prove the hosted transport supports incremental audio input. Hosted checkpoint identity also does not pin the revision or decoding recipe used in our local run.

Additional scope boundaries: [SiliconFlow](https://www.siliconflow.cn/pricing) lists Qwen3-ASR **1.7B**, not the selected 0.6B, at CNY 0.00022/audio second. [FlexAI](https://flex.ai/models/qwen3-asr-0-6b) lists dedicated 0.6B endpoints at $2.10/GPU-hour; provisioned compute time is not comparable to pay-per-audio-hour billing. Neither is the first recommendation for the current exact-model, minimal-setup requirement.

The Alibaba-only decision below is historical and superseded by the latest clarification above.

**Updated user decision, 2026-10-25: focus exclusively on Alibaba Cloud Qwen ASR. Do not start another cross-provider comparison.** Use the existing Qwen 0.6B findings as the reason for this direction. Research hosted-model identity, pricing, and integration; production implementation has not started. The other-provider material below is retained as historical research, not active recommendations.

Use an established managed streaming speech-to-text service rather than distribute or operate model inference ourselves. The earlier Soniox/Deepgram shortlist and two-provider evaluation proposal are superseded by this decision.

### Alibaba integration assessment

The documented managed target is `qwen3-asr-flash-realtime`, with Singapore pricing of $0.324 per streamed audio hour. Illustrative transcription-only totals: 10 hours $3.24, 100 hours $32.40, 1,000 hours $324. Two separately billed full-duration source streams would approximately double audio charges. Notes generation and our backend costs are additional. [Official pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing).

Integration is moderate application work, substantially smaller in scope than distributing native inference across customer operating systems. Recommended conservative architecture: extension capture -> authenticated WebSocket relay -> Alibaba ASR -> finalized transcript -> existing notes pipeline. Alibaba documents API-key authentication in the WebSocket handshake; keep that key on the relay. Do not assume temporary credentials documented for other Alibaba protocols or products work with this exact model. [Authentication](https://www.alibabacloud.com/help/en/model-studio/realtime-token-authentication).

Our transcription controller already receives 16 kHz Float32 audio. Adapt this to the API's PCM16 format and stream incrementally instead of waiting for completed inference windows. Replace model preparation/download status with cloud connection status; normalize interim/final events; handle final flush, disconnect, bounded queues, and errors. Keep capture, local recording, persistence, and LLM note behavior intact. The relay handles authentication, session limits, and connection forwarding; it does not host a model or require GPU resources. No defensible calendar estimate is established from this research alone.

The existing local results justify selecting Qwen; they do not certify managed Flash as the same 0.6B checkpoint. The reviewed public API documentation does not identify its parameter count or provide an exact `Qwen/Qwen3-ASR-0.6B` selector. Exact-checkpoint hosting and managed Flash are different deployment choices. Do not label Flash output as measured 0.6B output or promise the local inference latency. No broader model-selection exercise is required; eventual connection/Stop/notes checks validate the integration itself.

The previously tested checkpoint was Qwen3-ASR **0.6B**. The official open series lists 0.6B and 1.7B. A managed Qwen service is not established to be that exact checkpoint or runtime; its accuracy and latency require separate measurement. [Official Qwen repository](https://github.com/QwenLM/Qwen3-ASR).

## Candidates

| Candidate | Documented capabilities relevant here | Main unresolved question |
| --- | --- | --- |
| Alibaba Cloud `qwen3-asr-flash-realtime` | Managed WebSocket transcription; Indonesian, English, Mandarin; Singapore service option | Code-switching quality on our speech and browser authentication/relay requirements |
| Soniox `stt-rt-v5` | Streaming; Indonesian, English, Chinese; documented mid-sentence switching; Web SDK and temporary browser keys | Actual Mandarin and mixed-language accuracy and final-text delay from the user's network |
| Deepgram `nova-3`, `language=multi` | Streaming multilingual model; Indonesian, English, Mandarin; language hints and mid-sentence switching | Whether it beats the first pair on our examples and network |

Sources: [Alibaba model/language matrix](https://www.alibabacloud.com/help/en/model-studio/asr-model/), [Alibaba real-time integration](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide), [Soniox languages](https://soniox.com/docs/stt/concepts/supported-languages), [Soniox model changes](https://soniox.com/docs/stt/models), [Deepgram multilingual documentation](https://developers.deepgram.com/docs/nova-3-language-prompting).

Alibaba also now recommends `qwen-audio-3.1-asr-flash-streaming` for continuous transcription. It is a distinct service candidate, not an alias for the local 0.6B model. Confirm exact model, region availability, and price before choosing a single Alibaba configuration for a comparison; do not silently substitute models mid-run. Language support alone does not establish reliable three-language switching.

## Public price snapshots

One stream, transcription only; exclude notes generation, our infrastructure, optional features, taxes, and any parallel source streams. These are documentation snapshots, not quotes or measured bills.

- Soniox real-time: approximately **$0.12/hour**, billed by audio/text tokens. Actual totals depend on token usage. [Pricing](https://soniox.com/pricing).
- Alibaba `qwen3-asr-flash-realtime`, Singapore: **$0.000090/second = $0.324/hour**. This price does not cover the separately named Qwen-Audio 3.1 service. [Pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing).
- Deepgram Nova-3 multilingual streaming: currently advertised promotional **$0.0058/minute = $0.348/hour**; regular listed **$0.0092/minute = $0.552/hour**. Recheck account terms and data-use settings. [Pricing](https://deepgram.com/pricing).

## Existing implementations to learn from

- [Soniox direct browser streaming guide](https://soniox.com/docs/guides/direct-stream): a backend issues temporary keys; the browser sends audio directly to the provider. Adopt its SDK/authentication pattern, adapting audio input to our existing tab/microphone capture rather than replacing capture with the example's microphone-only default.
- [Soniox JavaScript SDK](https://github.com/soniox/soniox-js) and [official examples](https://github.com/soniox/soniox_examples): inspect and reuse supported client integration instead of implementing model inference or a custom protocol stack.
- [OpenTypeless Qwen integration](https://www.opentypeless.com/en/docs/stt-aliyun-qwen3-asr): an existing dictation application documents PCM16/16 kHz mono streaming to Qwen's regional DashScope WebSocket endpoints. This demonstrates an integration pattern, not meeting-quality or latency evidence.
- [Recall.ai Deepgram integration](https://docs.recall.ai/docs/deepgram): an existing meeting infrastructure provider documents live transcription through Deepgram, including multilingual configuration and transcript events. We can learn the separation between capture and managed recognition without adopting its meeting-bot infrastructure.

## Proposed integration boundary, not an implementation authorization

```text
Existing tab + microphone capture
             |
     Audio frames as they arrive
             |
     Managed streaming STT
       /                 \
 provisional text     finalized text
  transcript UI       existing transcript contract
                              |
                       existing LLM notes
                              |
                       existing sidebar/save

Small authenticated backend -> short-lived provider access
```

For providers supporting browser temporary credentials, keep the long-lived secret on our backend and stream audio directly to the provider. Enforce session limits and usage quotas there. Other providers may require an audio relay; verify this before claiming equal integration effort.

Do not wait for the existing eight-second inference window to finish before transmitting streaming audio. Preserve recording and note behavior, but adapt ASR transport and partial/final handling. Finalized content must commit once, without duplicate words after reconnect or Stop. Cloud recognition does not itself solve microphone/tab source attribution; do not combine that experiment with provider selection.

Customer model downloads and inference memory/GPU requirements disappear. Browser capture, encoding, buffering, and recording still consume resources. Internet dependence and per-session operating cost replace local inference requirements. Raw audio now leaves the computer: confirm provider retention, model-training policy, and processing region before a private-audio run. Soniox documents no model training and no audio/transcript retention unless storage is explicitly requested through a supported service; other providers need their own account-specific verification. [Soniox data handling](https://soniox.com/docs/security-and-privacy).

## Historical evaluation proposal — superseded, do not execute

Use the preserved 18 reviewed excerpts unchanged for an initial accuracy/silence comparison of two services. These cover six periods of one meeting, not 18 independent meetings. Add separately verified Mandarin and genuine three-way switching samples before claiming the language requirement is met.

Replay at real speed through each provider's streaming API, never transmitting future audio faster than it would arrive live. Keep references out of requests. Record exact model/version, region, settings, connection startup, billed usage, and failures. Keep first-pass vocabulary bias disabled unless evaluating a separate controlled condition.

Report word error rate on Indonesian/English, character error rate for Mandarin, named/technical-term retention, errors around language switches, and false speech on quiet clips. Do not use an LLM to repair transcripts before scoring recognition.

Define the requested **1–3 seconds** as audio-to-final-text lag: for timestamped words, browser receipt time of the final result minus the corresponding audio end time on the replay clock. Report first partial separately, plus median, p95, startup time, and utterance finalization delay. Log corrections to provisional text and no-result/error cases. Short excerpts are a screening tool; continuous speech and longer sessions are needed to establish backlog and finalization behavior. Neither vendor marketing latency nor the previous complete-eight-second-input local inference timing is directly equivalent to this measure.

Choose one provider only after it satisfies the measured quality and latency requirements; then integrate its maintained SDK behind the existing transcription boundary and verify reconnect, Stop/flush, recording, notes, and saving. This narrowly scoped evaluation validates provider fit; it does not involve developing or tuning an STT model. Credentials, a spending cap, and authorization for the recordings' cloud processing remain prerequisites for live evaluation.
