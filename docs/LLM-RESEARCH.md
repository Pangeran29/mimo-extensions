# Layer 3 research: live analysis and useful follow-up questions

Current-reference note, 29 October 2026: this is the historical 15 October research. Revalidation found that Omi's old mentor scheduler path is removed and its current proactivity contract records retirement of the real-time mentor producers on 26 October. See [the current deployed-products and implementation review](LIVE-ASSISTANCE-RESEARCH-2026-10-29.md) before adapting those references. The user's current live-memo requirements are in [LIVE-MEMO-DIRECTION.md](LIVE-MEMO-DIRECTION.md).

Research date: 15 October 2026. Research only; no LLM integration, model calls, or credentials were added. The recorder/transcriber build is unchanged.

## Recommendation

Use one bounded, structured analysis call on newly finalized transcript text, initially paced around 10–15 seconds during speech. Maintain compact meeting state and permit a null question. Start evaluation with HPOP's `claude-sonnet-5-5`, compare `gpt-6.1-sol`, and use `qwen3.7-plus` as the lower-price challenger. This is an engineering shortlist, not a measured ranking of question quality. Actual provider requests and bilingual meeting evaluations are still required.

## Closest reusable implementations

### Omi

- [Bounded conversation buffer](https://github.com/BasedHardware/omi/blob/main/backend/utils/mentor_notifications.py): accumulates new segments, caps recent messages, and waits for sufficient new context before evaluation. The inspected source uses a 50-message bound and a ten-new-message threshold; these are reference settings, not suitable defaults to copy blindly into our longer ASR passages.
- [Proactive notification implementation](https://github.com/BasedHardware/omi/blob/main/backend/utils/llm/proactive_notification.py): separate relevance assessment, notification generation, validation, and recent-notification context. Concrete evidence and staying silent are explicit concerns. Numeric self-assessed relevance/confidence values are model outputs, not calibrated probabilities.
- [MIT license](https://github.com/BasedHardware/omi/blob/main/LICENSE), Copyright 2024 Based Hardware Contributors. Relevant portions can be adapted with attribution. No Omi code was copied in this research step.
- Improvement for this MVP: combine state update and optional question into one structured call, with deterministic eligibility/deduplication afterward. Multiple model calls per update add cost and latency; introduce separate gate/generator models only if measured performance warrants them.

### AWS Live Meeting Assistant

- [Repository](https://github.com/aws-samples/amazon-transcribe-live-meeting-assistant), MIT licensed.
- [Assistant documentation](https://github.com/aws-samples/amazon-transcribe-live-meeting-assistant/blob/develop/docs/meeting-assistant.md): current-transcript access, transcript search/summarization, meeting-history/document tools, and streamed assistant responses. Its documented activation is wake phrase, chat, or shortcut buttons; it is not evidence of an identical proactive-question product.
- Reuse the separation between transcript events, meeting context, and assistant results. Our existing local audio/ASR path remains; this MVP needs no AWS deployment or external knowledge retrieval.

## HPOP: directly inspected catalog and docs

The user identified [HPOP pricing/model catalog](https://hpop.ai/pricing). Its JavaScript-rendered catalog was read in the browser. The page showed 62 enabled models. Relevant observed IDs and displayed token prices:

| Model | Displayed input / output USD per 1M tokens | Interpretation |
| --- | --- | --- |
| `claude-sonnet-5-5` | 1.50 / 7.50 | First quality/latency candidate to test |
| `gpt-6.1-sol` | 1.50 / 7.50 | Strong comparison candidate; page displayed 22 s average latency at inspection |
| `qwen3.7-plus` | 0.2397 / 0.9588 | Lower-price challenger |
| `gpt-6-luna` | 0.075 / 0.375 | Later frequent-update optimization candidate |
| `claude-opus-5-5` | 3.00 / 15.00 | Optional quality reference for offline evaluation |

These are catalog displays with different route groups and dynamic/token pricing labels; they are not guaranteed account billing rates. The page's aggregate latency is not a comparable benchmark for our prompt, reasoning settings, or output length. Missing latency badges do not establish faster service. No authenticated availability or upstream identity was independently tested.

HPOP links its [official API docs](https://doc-hpop-ai.apifox.cn/). The [Chat Completions specification](https://doc-hpop-ai.apifox.cn/494653598e0.md) documents `/v1/chat/completions`, streaming, `response_format` with JSON Schema, `reasoning_effort`, and usage options. Actual support must be checked for each selected model and route. OpenAI-compatible does not mean all provider-specific thinking/caching settings translate identically.

Primary model references:

- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): balanced capability/cost candidate, structured output/streaming support on the native API.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs): schema shape guarantees are distinct from factual/semantic correctness.
- [Claude model comparison](https://platform.claude.com/docs/en/models/overview): Sonnet 5.5 is positioned for speed and intelligence, Haiku for low-latency/high-volume work, Opus/Fable for more demanding work. This does not establish the best meeting-question model.
- [Qwen text model capabilities](https://www.alibabacloud.com/help/en/model-studio/text-generation-model/), [thinking controls](https://www.alibabacloud.com/help/en/model-studio/deep-thinking): Qwen3.7 Plus supports hybrid thinking; test non-thinking mode for live latency if HPOP forwards the setting. Qwen3.8 appears in native documentation but was not listed in HPOP's Qwen filter at inspection.

## Proposed execution design

1. Subscribe to finalized transcript segments with existing session ID, segment ID, and audio-relative time bounds. Keep the original transcript and audio available locally.
2. On meaningful new text, schedule an analysis update with a minimum interval initially around 10–15 seconds. Skip silence and unchanged text. Use one in-flight request and one coalesced pending update; pending work includes every segment since the last accepted update. Do not queue obsolete per-chunk requests.
3. Send meeting goal/role if supplied, compact evidence-backed state, recent raw transcript (initially around two minutes with a token cap), new segments, and recently shown/dismissed questions. Preserve exact quotes/source IDs for important earlier commitments; a recursive summary alone must not become the factual authority.
4. Request a short structured result: summary update, decisions, unresolved items, and zero or one candidate question with source segment IDs, the missing information, and why it matters now. Keep stable instructions first for caching when supported. Bound output and reasoning to live-task needs.
5. Validate schema and source references. Apply local rules: issue still open, meaningful consequence for the meeting goal, not answered already, not substantially the same as a shown/dismissed question. A model's confidence score alone cannot authorize display. Transcript content is untrusted meeting data, not instructions to the assistant.
6. Display a brief evolving analysis and at most one active question. Later transcript can resolve/retract a question. Add useful/dismiss feedback. Silence is a correct output. All questions remain suggestions for the user to ask; no meeting audio output or automatic messaging.
7. Reject stale responses using session ID and analysis version. Timeouts/rate limits use bounded retries; a failed LLM must not block capture or local transcription. Include any final LLM work in offscreen lifetime ownership before closing the document.

Plain TypeScript, an OpenAI-compatible client, and local schema validation are sufficient. Personal MVP configuration can use the user's own endpoint/key; a distributed shared service key belongs behind a backend. Do not embed it in the extension package. The current network CSP/permission boundary needs explicit integration work for HPOP.

Audio and Whisper remain local. This proposed API layer sends transcript text through HPOP to its selected model provider; it changes the local-only privacy boundary and should be an explicit opt-in feature.

## Question quality contract

Suggest a question only when the answer would materially change a decision, expose an unresolved dependency/risk, clarify a contradictory claim, or complete an important commitment. Avoid generic requests for more detail. Do not ask what the conversation already answered. For doubtful ASR wording/numbers, ask for confirmation rather than treating a guessed transcription as fact. Match the user's preferred language, supporting Indonesian/English mixed context.

Example: a vendor is selected because its price is lower, and migration cost has not been discussed. A candidate question is "Apakah perbandingan harganya sudah termasuk biaya migrasi?" Explain that the unresolved cost basis could change the selection, with source IDs. This is a question about an unknown, not an assertion that migration cost exists or is excluded. If all-in pricing was already established, return no question.

## Evaluation before selecting a winner

Replay the same Indonesian/English transcript prefixes through all three candidates, without exposing later conversation. Include useful-question moments and many moments where no intervention is needed, already-answered issues, natural repeats, ASR errors, and mixed-language speech. Use approximately 30–50 labeled checkpoints as an initial screen, then real meetings.

Measure useful-question precision, important missed gaps, unsupported claims, repeated/already-answered questions, language appropriateness, complete-result p50/p95 latency, and actual HPOP token/currency cost. Compare anonymized outputs with human judgment; model self-grading cannot prove that its own suggestion was necessary. Select the cheapest/fastest model meeting the quality threshold. No API evaluation has run yet, so there is no measured winner or promised generation latency.
