# Layer 3 validation — 15 October 2026

**Acceptance gate: not passed. No certified automatic model default.** The implemented feature is available for explicit development testing. Natural-meeting usefulness remains unverified.

## Authenticated HPOP model comparison

The exact requested model IDs were probed through `https://hpop.ai/v1`. GPT 6 Luna and Qwen 3.7 Plus returned HTTP 503 for this development account/route. They were excluded after preflight; a 60-checkpoint replay was not claimed for unavailable routes. This does not establish that these models are generally unavailable from HPOP.

Both Claude routes returned text instead of enforcing Chat Completions JSON Schema in preflight. The native Anthropic compatibility adapter was tested next. A native tool result supplies the schema and every complete result is validated locally. Initial native Haiku runs sometimes ignored forced tool choice on small talk; explicit tool transport instructions improved the final replay to 60/60 valid results. That improvement is not proof of upstream schema enforcement or forwarding of thinking settings.

The final comparison used 30 fixed Indonesian/English checkpoints, twice per available candidate: 20 consequential-gap cases and ten negative/resolved/uncertain/injection cases. No later conversation was exposed. At most two requests ran concurrently; the ongoing synthetic Chrome soak also used HPOP. The reported latency includes the complete validated response plus the scheduler's 150 ms coalescing allowance, rather than only first-token time. Real pending work and UI delivery can add more delay.

| Candidate / route | Valid results | Median | p95 | Estimated replay cost |
| --- | ---: | ---: | ---: | ---: |
| GPT 6 Luna / Chat Completions, reasoning none | Excluded: 503 | — | — | — |
| Claude Haiku 4.5 / native, thinking disabled | 60/60 | 5.23 s | 5.79 s | $0.2964 |
| Qwen 3.7 Plus / Chat Completions, thinking disabled | Excluded: 503 | — | — | — |
| Claude Sonnet 5.5 / native, adaptive thinking + low effort | 60/60 | 5.67 s | 6.79 s | $0.8718 |

Haiku median first tool-input token was **4.24 s**; Sonnet was **4.68 s**. Both fail the **≤3 s median** gate; Sonnet also fails **≤6 s p95**. No latency tie within 300 ms occurred. Prices use observed HPOP catalog input/output prices and returned usage, including the final native event's corrected input count. Actual route/cache billing may differ. Full provider reports are in ignored `artifacts/assistant-benchmark.json`; the report records the prompt/provider source hash and every result.

Each Claude candidate displayed 40 questions on the 40 positive replays and none on the 20 negative replays. This is **question presence, not 100% judged usefulness or coverage**. Review found an already-answered Haiku question in `conflicting-price`, pass 2: it asks which number the written proposal specifies, although the prefix already states 80 million. Haiku also added “AM” in a timezone case where the prefix only says “9”. These fail the zero already-answered/invented-fact requirement. Independent usefulness/coverage scoring for all outputs remains pending; confidence scores are not used. Sonnet's full semantic quality gate is not certified by the absence of those Haiku examples.

HPOP does not expose an independently verified upstream echo of reasoning/thinking controls. Accepted request parameters, no visible reasoning, or zero reported reasoning tokens are insufficient proof that controls were forwarded. Both candidates remain uncertified for automatic-default selection. The UI requires a manual candidate choice and clearly labels development status.

## Implementation tests

**61 focused tests pass.** `pnpm check` covers TypeScript, focused automated tests, and the unpacked build. The new tests exercise coalescing, one in-flight automatic request, pending updates, start interval, stale sessions/versions, source validation, generic/duplicate suppression, feedback/resolution, bounded context/memory, full-result latency measurement, authentication pause, bounded rate-limit retries, final update deadlines, independent persistence and recovery, slow-write coalescing, worker termination, session-only credential handling, native/Chat streaming adapters, and rejection of malformed/truncated results.

An actual isolated Chrome run used packaged Whisper/VAD, native tab capture of attributed bilingual public speech, a synthetic silent microphone, real HPOP requests, and all three native audio encoders. An injected 401 inside the network worker paused AI while recording and local transcription continued; Resume AI restored analysis. Assistant-window closure/reopening worked. The final authentication-recovery run produced three 40.08-second files. A separate 65-second run also returned a 1,440-character Opus deeper analysis with locally checked segment citations; its three 65.04-second files decoded in Chrome. Combined audio was mono and microphone/tab stereo. Final AI state persisted and restored as complete; main-world Chrome context queries confirmed offscreen closure. There were no captured browser errors. Reports are `artifacts/assistant-auth-smoke.json` and `artifacts/assistant-smoke.json`. Actual finalized-passage-to-result samples in the 65-second run ranged approximately **5.9–14.7 seconds** after the first result, including pending work/retries; the authentication-recovery backlog reached **16.9 seconds**. These exceed the benchmark-only timings and the acceptance targets. These checks do not assess real microphone quality or natural meetings.

The independent audio-only browser regression passed after Layer 3 integration: recording, tab switching/popup closure, failed download retention, retry, three exports, spectral source separation, playback, and idle cleanup. Existing local behavior remains available with AI disabled.

A validation-harness issue was corrected: Playwright utility-world polling was not a reliable check of extension offscreen contexts. Final short-run cleanup checks explicitly poll Chrome from the extension page's main world. Earlier cleanup claims based only on that utility-world predicate should not be treated as proof.

## Twenty-minute sustained run: AI gate failed

The 1,200-second run used the initial Layer 3 Haiku compatibility prompt, before the explicit tool-transport instruction and final cleanup refinements. Recording and local ASR stayed active, producing **183 transcript segments** and three decodable audio files of **1,200.06 / 1,200.06 / 1,200.12 seconds**, totaling **29,282,954 bytes**. No browser errors were captured.

AI accepted only one update, then correctly paused after three consecutive malformed responses; **117 of 120 samples were paused**. This verifies local isolation during AI failure, **not twenty minutes of sustained useful AI analysis**. The combined AI soak gate failed. The final adapter subsequently passed the 60-checkpoint replay and the short real-browser runs above; a fresh twenty-minute run of the final configuration remains unverified.

Recording-time measurements on the Apple M5 / 16 GB Mac, Chrome 155:

- Mean process CPU consumption: **21.8% of one core**, based on sampled browser-process CPU seconds.
- Total isolated browser RSS: **845–2,505 MiB**, initially 2,505 MiB and finally 1,113 MiB. Model warm-up and other concurrent development tests affect these readings; this is not a dedicated memory benchmark or proof of constant memory.
- Offscreen sampled JS heap: **7.7–16.4 MiB**. Peak observed ASR PCM queue: **7.712 seconds**; median sampled inference: **471 ms**. No queue overflow occurred.
- Audio export decoded completely. Export-time peak memory was not separately measured in this run.

The original soak harness's utility-world offscreen-close predicate was unreliable. `artifacts/assistant-soak.json` has been annotated accordingly; final short-run main-world context polling separately verified cleanup. Do not count the original `offscreenClosed` assertion as evidence.

## Remaining human verification

- Run a natural Indonesian/English work meeting, with consent, and judge whether the question arrives early enough and changes the discussion usefully.
- Review every checkpoint result against the labeled gap, facts, language, and previous answers. Do not replace this with question-presence counts.
- Confirm HPOP's actual route/control forwarding with provider evidence before certifying a default; rerun unavailable candidates when routing is fixed.
- Test the assistant window and permissions in normal headed Chrome on the user's desktop; synthetic/headless tests do not replace this.
- Existing real-microphone, meeting-audio, and two-hour recorder checks in `VALIDATION.md` still apply.
