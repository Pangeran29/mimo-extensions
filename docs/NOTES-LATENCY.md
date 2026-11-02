# First useful notes: investigation and controlled evaluation

**Implementation status (2026-10-23):** shared prompt policies, opt-in stage tracing, real-browser evaluation, a shared 100-request cap, and blind-review/rollout reporting are implemented. The shipped policy remains **baseline**. Authenticated HPOP evaluation and the representative-case quality gate remain pending; no 15/20/30-second winner is claimed. See the implementation section below.

The investigation and research sections below retain their original dates and historical measurements.

Investigation date: 2026-10-20. Production behavior has not been changed by this investigation.

## Finding

The extension has no one-minute notes interval. It finalizes speech on 600 ms silence or an approximately eight-second window, runs local Whisper, and schedules AI after 150 ms (minimum two seconds between request starts). One automatic AI request runs at a time; newer finalized passages are coalesced behind it. A complete, schema-validated response replaces the current memo. Network streaming is already enabled, but partial JSON is not displayed.

The reported reproduction is [this YouTube podcast](https://www.youtube.com/watch?v=4Yll_sh1IY4), playback and recording both starting at 00:00, first notes appearing around 01:00. This is user-observed timing, not an instrumented trace. Web retrieval of the video was throttled, and its opening speech has not been inspected. Do not assume there is meaningful speech at time zero: record silence, intro music and first substantive speech separately.

The actual cause of that session's minute-long delay remains unproven. Plausible contributors are late first transcript availability, slow provider completion, a failed request followed by retry, and valid early responses with an empty summary. A 30-second request timeout is a limit on one attempt, not a 30-second end-to-end guarantee. A timeout followed by a two-second backoff and a second request can exceed a minute from recording start. This describes a possible path, not evidence that it happened in the reported session.

## Fresh local measurement

Executed `node scripts/transcription-gate.mjs` using the existing cached model and isolated Chrome profile, on Apple M5 / 16 GiB RAM / Chrome 155.0.8059.80. Output: `artifacts/transcription-gate.json`; dated provenance and packaged-worker hash: `artifacts/notes-latency-investigation.json`. Model: `onnx-community/whisper-base`, pinned revision `1846881b6b3a3024392c1eea3ad983695bc23925`, WebGPU, fp32 encoder/q4 decoder. Three silent MediaRecorders were running during inference.

| Observation                                            | Measured value |
| ------------------------------------------------------ | -------------: |
| Cached model preparation and warmup                    |       1,206 ms |
| Indonesian first eight-second window recognition       |         515 ms |
| All eleven window inferences, observed range           |     358–991 ms |
| Indonesian fixture, total inference across two windows |         879 ms |
| English fixture, total inference across two windows    |         788 ms |
| Mixed fixture, total inference across three windows    |       1,280 ms |

This is a small real recognition test, not a complete capture/VAD/AI/UI latency benchmark, a latency percentile estimate, or an Indonesian accuracy certification. It does not include the podcast, model download, realistic microphone noise, or provider calls. The repeated continuous-speech fixture produced a degenerate repeated-number passage; speed alone is insufficient. The gate bypasses production VAD segmentation and its text-cleanup helper differs from production. Its raw text must not be treated as a production transcript.

Historical assistant reports used older prompts/models and an eight-second benchmark abort. They cannot certify the current Sonnet living-memo implementation. The legacy `scripts/assistant-benchmark.mjs` still has that abort and should not be used to rank this work unchanged.

## What to adopt from existing work

| Primary source                                                                                                                          | Relevant result or implementation                                                                                                  | Applicability to Listen                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Whisper-Streaming paper](https://aclanthology.org/2023.ijcnlp-demo.3/) and [implementation](https://github.com/ufal/whisper_streaming) | Local agreement commits text supported by successive decoding passes; reported 3.3-second transcription latency on its evaluation. | Useful evidence for stable incremental transcription. That number is neither browser performance nor audio-to-meeting-notes latency. Re-decoding has a computation cost. Do not replace our local engine on this headline alone.                |
| [SimulStreaming](https://github.com/ufal/SimulStreaming)                                                                                | Successor using a simultaneous inference policy; Python/GPU-oriented ASR and translation pipeline.                                 | Study confirmation and buffer management. It is not a drop-in Transformers.js extension package. Its computation-unaware simulation explicitly excludes compute time, so it cannot demonstrate our end-to-end target.                           |
| [Hugging Face realtime Whisper WebGPU example](https://github.com/huggingface/transformers.js-examples)                                 | Browser-side accelerated Whisper processing.                                                                                       | Our worker already derives from this approach. Retain WebGPU, worker isolation and warmup before attempting an engine migration.                                                                                                                |
| [Pipecat STT benchmark](https://github.com/pipecat-ai/stt-benchmark)                                                                    | Separates final-segment latency and transcript accuracy, reports distributions rather than one best-case response.                 | Adopt stage-specific measurement and paired accuracy review, not the vendor leaderboard as an Indonesian or meeting-notes ranking.                                                                                                              |
| [Anthropic latency guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)                | Shorter requested responses, appropriate model choice and streaming are latency controls.                                          | First compare a small first memo against the current request for 120–200 words. Streaming is already enabled; just enabling it again gains nothing. A lower output cap alone does not make an unchanged response shorter and can truncate JSON. |
| [Anthropic thinking controls](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)                         | Effort affects reasoning; steering effectiveness must be measured for the workload.                                                | We already request adaptive thinking at low effort. Do not claim thinking is disabled or assume HPOP forwards every control. Verify upstream behavior before another change.                                                                    |
| [Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming)                | Earlier tool-input fragments can be invalid or incomplete JSON.                                                                    | Not a shortcut to validated visible notes. Would require a separate provisional UI contract. Keep atomic, validated memo replacement for the first experiment.                                                                                  |
| [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)                                                  | Reuses eligible identical prefixes after cache creation.                                                                           | Potential benefit for subsequent updates, conditional on provider support and actual cache-read usage. It does not eliminate cold first-request latency.                                                                                        |

No reviewed source establishes that 15, 20 or 30 seconds is universally best for Indonesian meeting notes. Those targets need evaluation on this product's audio, provider and definition of useful notes.

## Recommended first intervention

Keep the current ASR engine, evidence rules, schema, single in-flight request and living memo. Compare exactly two conditions:

1. Baseline: current complete memo request, including its 120–200-word target.
2. Short first memo: while no substantive memo exists, allow a title and one to three supported points, at most 50 words. Subsequent updates use the existing complete-memo prompt. Sparse speech must remain sparse; empty input, greetings or music must not be padded into invented notes.

This is the leading candidate because it reduces requested work and visible output without replacing the model or audio stack. It remains a hypothesis until measured. A faster model is a separate later experiment, particularly if provider time dominates after shortening the first memo. Avoid changing ASR windows, prompt, model, thinking settings and retries together: that would make the result impossible to attribute.

With an eight-second first speech window, 515 ms recognition and 150 ms scheduling, an illustrative budget reaches AI dispatch at about 8.67 seconds after speech begins. That leaves roughly 6.3 / 11.3 / 21.3 seconds for a complete AI result and UI delivery under 15 / 20 / 30-second targets. These are budgets computed from one window measurement, not observed end-to-end timings or predicted success rates. Startup and opening silence must also fit when measuring from the click.

## Define 15 / 20 / 30 correctly

Measure all three deadlines on the same runs. Do not wait 15 seconds to collect audio and call the resulting note a 15-second experience: inference still has to happen afterward. Do not abort a request at each deadline or use three different timeouts; that changes retry behavior and confounds the comparison.

Primary outcome: time from the user's Listen click to the first **visible, useful, evidence-supported** note. Record recording-start and first-substantive-speech offsets as additional outcomes so cold startup and podcast introductions cannot be confused with AI delay. Report nonempty validated memo time separately; valid JSON and nonempty text do not prove usefulness.

Capture these events on one monotonic timeline, correlated by session, segment and request attempt:

- Listen click; model ready; capture started; first substantive speech.
- VAD window emitted; ASR started/completed; final transcript delivered.
- AI queued; request sent; first tool JSON delta; response complete; schema accepted or error category; retry started.
- Memo committed; first visible paint with the memo. Measure paint in the browser; a Node callback is not paint.

Existing `firstTokenMs` means first tool-input JSON fragment on the native route, not the first network byte, first thinking token or first visible note. Existing controller `latencyMs` starts at transcript arrival and cannot explain capture-to-transcript delay.

Run a small randomized paired pilot before spending on a large corpus: same opening, recorded segment availability, model, provider, controls and environment; baseline and short-first-memo order randomized within each repeat. Include the supplied podcast at 00:00, Indonesian and English speech, mixed language, silence/music, corrections, continuous speech and noisy input. Keep cold preparation/download and warmed sessions separate. Replay clips at real speed. Never expose future transcript text to an early request.

For each condition report:

- Useful-note success by 15, 20 and 30 seconds, including failures/no-note sessions in the denominator.
- First useful note p50/p95; also report censored no-note runs instead of dropping them from latency statistics.
- Stage times, retry/error rates, empty-summary responses and token usage.
- Blind review against only evidence available when each request was dispatched: at least one meaningful supported point, no invented decision/owner/date/number, and no material contradiction. Track later deletion/correction of early claims and whether the first note stays readable as it expands.
- Provider cost and update staleness during a longer session. A fast first note must not create a request backlog afterward.

Predeclare the acceptance threshold (suggestion: useful notes by the selected deadline on at least 95% of representative eligible sessions, with no unsupported critical decisions). Select the smallest deadline that meets the quality and reliability gate. Report confidence intervals, stratify silence-only openings and cold starts, and avoid treating repeats of the same clip as independent evidence of corpus coverage. Five repeats are a pilot, not p95 certification. If 15 seconds fails but 20 passes, use 20; do not declare a winner from average latency alone.

## Reproducible provider/controller replay

New tool: `scripts/notes-latency-benchmark.mjs`. It bundles the **current** controller and provider, replays finalized transcript arrivals in wall-clock time, retains actual scheduling/coalescing/retry behavior, and compares baseline with the short-first-memo experiment. Originally the intervention was confined to this process. The implemented shared policy now also supports isolated browser evaluation; the shipped default remains baseline. It records source/fixture hashes, randomized job order, request timings/errors/usage, first nonempty memo, all memo revisions and deadline attainment. JSON validation remains in place. Reports contain transcript-derived notes: keep private recordings local.

Trace format is demonstrated by `tests/fixtures/notes-latency-example.json`. That fixture is invented and explicitly marked synthetic; it is not the podcast and is not performance evidence. For a real trace, record each segment's `availableAtMs` when it actually becomes available relative to recording start. `startMs`/`endMs` locate speech in the audio; they are not delivery times. Include browser/device/cache metadata and an unambiguous time origin. The current replay starts at recording start; click-to-recording delay and browser delivery/paint must be measured separately in the final browser evaluation.

```sh
# Validate input and inspect job count. No network requests.
node scripts/notes-latency-benchmark.mjs --fixture tests/fixtures/notes-latency-example.json

# Locally supply LISTEN_HPOP_KEY in the environment, then run a MEASURED trace.
# Default: five paired repeats, real HPOP requests, potentially multiple calls per run.
node scripts/notes-latency-benchmark.mjs --fixture artifacts/podcast-opening-trace.json --run
```

The tool does not retrieve keys from Chrome or print them. `--run` refuses a missing environment key. Replay alone does not select a winner: blind usefulness/faithfulness review and browser end-to-end confirmation remain required. The browser review tool evaluates the declared gates after review. It uses the current 30-second request timeout rather than the legacy benchmark's eight-second abort.

Harness verification completed: syntax check, no-network plan, missing-key refusal, and a 60-second offline paired replay through the real controller/provider with fully stubbed SSE. Assertions covered 503 retry recovery, ordered segment delivery without future context, both experiment conditions, validated memo commits, and deadline accounting. Offline timings are not provider performance evidence and are not included in the measured results above.

## Remaining evidence

No HPOP benchmark key was available in the isolated process during this investigation. No live LLM performance, 15/20/30 attainment rate, or podcast end-to-end reproduction is claimed. Next required inputs are a measured opening transcript-arrival trace and locally configured benchmark credentials. Do not paste API keys into a chat or commit them to fixtures. Once available, run the paired replay, review quality blind, and confirm the winning condition in the real extension before changing the shipped default.

## Research addendum: should speech duration select the trigger?

Follow-up research, 2026-10-20. Recommendation: trigger on the earliest evidence-supported useful point, and evaluate elapsed-time deadlines separately. Fifteen seconds is a proposed first-visible-note target, not a minimum audio collection window. Twenty and thirty seconds remain comparison thresholds, not automatic instructions to wait longer. This is a design inference from the sources below; no reviewed study establishes an optimal 15/20/30-second meeting-notes interval.

### Empirical anchors

- [Yuan, Liberman and Cieri, Interspeech 2006](https://www.isca-archive.org/interspeech_2006/yuan06_interspeech.pdf) examined conversational corpora. For 2,438 word-aligned Switchboard telephone conversations, combined words divided by elapsed conversation time averaged 196 words/minute, ranging from 111 to 291 across conversations. These are English conversation-level rates, not an Indonesian speaker norm. Excluding silence produced a different rate, illustrating why the denominator matters.
- [The CANDOR corpus, Reece et al., 2023](https://talkbank.org/ca/access/0docs/CANDOR.pdf) contains 1,656 unscripted English video conversations, over 850 hours. Its turn-level analysis reports mean speech rate of 3.3 words/second. It independently supports substantial information arriving within tens of seconds, but neither word count nor this mean measures completed decisions or establishes a note interval.
- [Conversational Speech Behaviors Are Context Dependent, 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11087085/) studied 28 participants across 112 conversations and found speech behavior depended on task. Its pause-defined turns and exclusion of one-word turns make the reported durations unsuitable as universal podcast or meeting-turn lengths. Do not equate an acoustic segment with a complete semantic point.
- [Incremental temporal summarization in multi-party meetings, 2021](https://aclanthology.org/2021.sigdial-1.55/) collected annotations over 100-second dialogue chunks with preceding context. This supports evaluating summaries against prior context, but that annotation choice is not evidence that real-time users should wait 100 seconds, nor a comparison of our candidate deadlines.

Illustrative arithmetic using the Switchboard conversation-level rates (not forecasts of the supplied podcast):

| Elapsed conversation time | Words at the reported mean | Words at the observed lowest–highest conversation rates |
| ------------------------- | -------------------------: | ------------------------------------------------------: |
| 15 seconds                |                         49 |                                                   28–73 |
| 20 seconds                |                         65 |                                                   37–97 |
| 30 seconds                |                         98 |                                                  56–146 |

The same number of seconds can therefore contain very different amounts of speech. Even identical word counts can contain either greetings and repetition or a consequential decision. An eight-word complete commitment can be more useful than sixty words of setup. Longer windows provide more opportunity for context, but do not automatically improve the correctness of every note.

An Indonesian primary study, [Analisis Kecepatan Bicara Orang Dewasa Normal Di Surakarta](https://penerbitadm.pubmedia.id/index.php/iso/article/view/2047), sampled 63 adults with 2–5-minute open conversations. It is locally relevant, but its abstract reports a minimum above several reported group means; quantitative reporting needs clarification before using it to set a numeric norm. This investigation therefore does not transplant its figures, English rates, or a universal word-count gate into the extension.

### Relevant implementation pattern

[LiveKit's turn detection documentation](https://docs.livekit.io/agents/logic/turns/turn-detector/) explicitly distinguishes speech presence from whether a person has more to say and combines context with timing bounds. [Deepgram's endpointing documentation](https://developers.deepgram.com/docs/understand-endpointing-interim-results) separately identifies preliminary text, finalized transcript segments, and pause-triggered utterance boundaries. These are voice-agent implementations, not evidence about optimal meeting-note timing. Adopt the principle that silence and finalization are imperfect readiness signals; adopting either provider or an additional turn-detection model is not required for our first experiment.

For meeting notes, a complete useful point is a better unit than an entire speaker turn: a podcast speaker may make several complete points without yielding the floor. Likewise an eight-second forced ASR split can cut an unfinished sentence. Punctuation, a word count, silence, and ASR finalization are supporting signals; none alone certifies meaningful completion or factual accuracy.

### Short first note, precisely

A real, persistent first version of the same memo: a short topical title if useful and one sentence or one to two bullets capturing the earliest supported point. Fifty words is a ceiling, not a target or required minimum. It may contain only a dozen words. Avoid a generic topic announcement, artificial sections, invented commitments, and padding to make it look complete. Preserve proposal/question/decision distinctions. It is schema-validated before display, but factual support still requires quality review.

Invented illustration, not a transcript of the supplied podcast:

- Speech: "Catatan pertama sekarang baru muncul setelah satu menit." First memo: "Catatan awal muncul sekitar satu menit setelah sesi dimulai."
- Later speech: "Saya mengusulkan target lima belas detik, tapi kita belum memilih." Expand that memo with "Target yang diusulkan: 15 detik; belum diputuskan."
- Only after explicit agreement should the memo label that target as a decision. Add owners, dates or actions only when spoken. Integrate additions into the existing document and retain stable wording where possible.

Do not add a separate remote LLM request merely to ask whether the transcript is ready. The existing early analysis call can return a small grounded memo, or an empty summary when no substantive point is supported. Its delivery time and empty-response frequency must both be measured. This retains the current pipeline and isolates a prompt-level change in the existing benchmark.

### Indicators that decide 15 versus 20 versus 30

1. **Content readiness:** annotate the earliest time a useful proposition becomes supported. Identify genuinely unfinished clauses, missing referents, greetings and intro music separately. Do not require a whole agenda topic or speaker turn to finish.
2. **Transcript availability and quality:** measure when the evidence actually reaches the assistant, not just the audio timestamp. Count ASR-caused omissions, wrong numbers/names and later corrected first-note claims.
3. **Actual delivery:** measure validated, visible memo time from the Listen click, retaining startup and silence offsets. The budget includes content accumulation, ASR queue/inference, scheduling, provider completion/retries and UI delivery. Use the distribution of whole-run latency; adding component p95 values does not yield an end-to-end p95.
4. **Usefulness and stability:** blind reviewers confirm at least one substantive supported point, no invented critical detail, and no material distortion of tentative speech. Track unnecessary rewrites and later retractions, rather than scoring longer notes as better by default.

Select the smallest deadline whose measured useful-note success rate meets a predeclared reliability and quality requirement. The suggested 95% gate is a product proposal, not a threshold established by conversation research. If 15 seconds passes, there is no content-based reason to impose a 20-second wait. If only 20 passes, use 20 as the defensible target. If thirty seconds of substantial available speech yields no useful note, diagnose content/ASR/provider/validation separately; do not assume the solution is to keep waiting. Silence-only introductions must not be filled with invented notes just to satisfy a timer.

## Implemented evaluation and rollout (2026-10-23)

### Behavior and internal controls

`systemPrompt(input)` is shared by both provider transports and the replay. `AnalysisInput.memoPolicy` accepts `baseline` or `short-first-note`; the controller sets it without changing persisted settings or memo schemas. `DEFAULT_MEMO_POLICY` stays `baseline`. The candidate changes only first-memo instructions: one supported sentence or 1–3 points, optional title, at most 50 words. Empty results keep that instruction active. A saved nonempty memo switches subsequent calls to the original full-memo guidance. New sessions start afresh. Deeper analysis uses the original instructions.

For developer evaluation in a trusted extension page's DevTools, opt in **before opening Listen**:

```js
await chrome.storage.session.set({
  listenDiagnostics: {
    enabled: true,
    runId: crypto.randomUUID(),
    policy: 'short-first-note', // use 'baseline' for the control
  },
});
```

Disable with `chrome.storage.session.remove('listenDiagnostics')`. Changes affect the next assistant initialization; do not switch conditions midway through a measured session. No user-facing setting is added. Offscreen documents receive the configuration via trusted recorder messages; their restricted Chrome API environment cannot read storage directly. The network worker receives it on initialization.

`listenDiagnosticTrace` in session storage contains a serialized ring of up to 10,000 allowlisted metadata events, with a dropped-event count. It is opt-in, device-local, session-only, and reset logically when `runId` changes. No audio, transcript, memo, key, URLs or raw exception text enter this trace. Browser reports separately contain transcript-derived evidence and notes for local review. Session events use `performance.timeOrigin + performance.now()` and carry session/window/segment/request/version identifiers as applicable; sort by timestamp, not storage arrival order. Performance marks also appear in the Chrome trace.

Stages cover click, startup/model preparation, capture, first detected speech, emitted VAD windows, ASR, transcript delivery, AI queue/attempt/errors/retries, provider send/first JSON delta/completion/usage, validation, memo commit and UI presentation. `cached` identifies reuse of an already prepared worker, **not proof of a disk cache hit**. First detected speech is an acoustic signal; substantive speech and semantic evidence readiness need separate audio review.

`memo.presentation_estimate` uses two animation callbacks and checks the current session/memo, visible document, active summary view, and laid-out memo. It is an estimate of presentation opportunity, not a claim to measure physical display scanout. Inspect the saved Chrome timeline alongside these marks.

### Commands and evidence

Run offline checks and build:

```sh
pnpm check
node scripts/notes-latency-benchmark.mjs --fixture tests/fixtures/notes-latency-example.json --repeats 1
```

Prepare attributed public read-speech controls:

```sh
python3 scripts/prepare-latency-corpus.py
```

This produces 20 distinct real FLEURS clips, interleaving Indonesian and English, under `artifacts/latency-corpus/`. These are **read-speech controls**, not a representative meeting corpus. Add the reported podcast and real mixed-language, uncertain, correcting, continuous and short-turn speech; also include silence/music and unfinished-speech controls. Read speech alone deliberately cannot pass the representative-case gate. Source URL, dataset revision, reference text, license and file hash accompany each control. Semantic annotations remain unfilled until review.

The browser runner uses an isolated Chrome profile, copied model cache when available, native tab capture, production VAD/Whisper/controller/provider, and the **actual visible sidebar**. Only the microphone and its permission check are replaced with a silent test source; it does not test physical microphone hardware, noise, or OS consent. Audio plays once at normal speed after capture and network interception are ready. Its playback offset is recorded; it remains inside click-to-note latency. Three native audio downloads and an idle final state must be verified for a complete run.

```sh
# No-network plan:
node scripts/notes-latency-browser.mjs --audio artifacts/speech/id_id.wav --variant short-first-note

# Pipeline/transport check: synthetic LLM response, NOT live latency evidence.
node scripts/notes-latency-browser.mjs --audio artifacts/speech/id_id.wav --variant short-first-note --duration 30 --offline --run --output artifacts/notes-browser-offline.json

# Live measurement requires LISTEN_HPOP_KEY supplied locally, never in this command.
node scripts/notes-latency-browser.mjs --audio OPENING.wav --variant short-first-note --run --output artifacts/opening-candidate.json

# Reported podcast; player must load without an advertisement or access barrier.
node scripts/notes-latency-browser.mjs --url 'https://www.youtube.com/watch?v=4Yll_sh1IY4' --variant baseline --run --output artifacts/podcast-baseline.json
```

Set `LISTEN_PLAYWRIGHT_PATH` to an installed Playwright package if it is outside normal Node resolution; `LISTEN_CHROME_PATH` can select Chrome. Run commands from the project root after building. Browser runs save source/build/harness/fixture hashes, environment, events, exact supplied text context, memo revisions, downloads and a Chrome timeline. First run uses `--cohort warmed` by default. `--cohort cache-restoration` omits explicit prewarming; inspect preparation events to determine whether UI auto-restoration warmed it before the click, and never mix it into the warmed primary cohort merely because it was fast.

**Transport detail:** extension-owned worker requests bypassed Playwright routing in development. Two probes with a synthetic invalid credential reached HPOP and were rejected with HTTP 401. They provide no live-provider performance evidence and are counted in the shared ledger. The runner now loads an isolated copy of the production build with an evaluation-only fetch-gate prefix in its network worker and a message bridge in its offscreen parent. It installs the gate **before audio playback** and fails closed if it cannot do so. The shipped `dist` and production source do not contain that prefix; its hash is saved separately. Both conditions use the identical gate. Offline responses are constructed inside that worker; live mode reserves a budget slot and then uses its original fetch with unchanged credentials, redirects, request and abort handling. The local gate adds measurement overhead equally to both conditions; provider timing includes it. No credentials or request headers are passed to the gate/report.

Both replay and browser evaluation use `artifacts/notes-latency-budget.json`, capped at 100 reserved HTTP attempts across processes/runs. Retries and final updates count. Reservations survive crashes; concurrent ledger ownership fails closed. Do not delete/reset the ledger to complete this evaluation. The two rejected development probes leave **98 requests** for authenticated evaluation. Offline synthetic responses do not spend this budget.

For paired browser evaluation, supply a manifest with `clips` containing unique `id`, `audio` or `url`, and optional `durationSeconds`, with a fixed integer `seed`. Put four representative openings first. Run:

```sh
node scripts/notes-latency-suite.mjs --manifest CORPUS.json --phase pilot --run
# Review four completed pairs; save {"technicalPass":true,"findings":"..."} locally.
node scripts/notes-latency-suite.mjs --manifest CORPUS.json --phase full --pilot-review PILOT-REVIEW.json --run
```

Order is randomized within each pair. Full evaluation continues after the first four pairs and requires all eight pilot reports. `artifacts/notes-suite/reports.json` combines the report paths. A technical failure or exhausted budget stops further jobs. A missing key refuses live execution without making requests. The supplied FLEURS manifest is suitable for control runs; it does not cover the required natural scenarios.

Prepare the blind review and then score a completed copy:

```sh
node scripts/notes-latency-review.mjs --reports artifacts/notes-suite/reports.json --prepare --output artifacts/blind-review.json
node scripts/notes-latency-review.mjs --reports artifacts/notes-suite/reports.json --review artifacts/blind-review-completed.json --output artifacts/rollout-decision.json
```

The packet hides variants and timings, and includes each memo, source audio location, and exact evidence/context supplied at dispatch. Complete usefulness, faithfulness, critical unsupported details, material distortion and unnecessary-retraction fields for every revision. Review speech evidence first, then inspect later speech for retractions. Annotate first substantive speech and first useful evidence in **recording-relative milliseconds**, scenario and language (`id`, `en`, `mixed`). The packet supplies the estimated source-playback offset relative to capture; account for this when translating source-audio times into recording-relative annotations. Fill the continuous-session evidence only after a longer real run verifies responsive later updates and clean recording/save/finalization.

The scorer selects the smallest passing deadline at 15/20/30 seconds only with >=95% observed useful-note attainment, >=20 distinct eligible warmed openings, faster paired median, complete quality review, no unsupported critical details, no increased distortions/retractions, <=50-word candidate first memos, consistent source/build/model provenance, required scenario/language coverage and a passing continuous-session check. Eligibility is first useful evidence within eight seconds of recording. Duplicate source/condition runs are rejected in the primary analysis; report repeats separately. Nonempty JSON alone never qualifies.

No-note runs remain in deadline denominators and are reported as censored; observed p50/p95 explicitly exclude them. Paired median comparison uses the baseline's censor time as a conservative lower bound and candidate misses as infinity. Wilson confidence intervals are descriptive, not a population-level reliability certificate. Stage distributions, empty results, error counts and token usage are retained.

The scoring command never edits production code. Only after it reports `eligible-for-enabling`, set `DEFAULT_MEMO_POLICY` to `short-first-note`, rebuild and rerun checks/browser verification. The internal `baseline` override remains available for rollback. Until then production stays baseline; there is no timer or forced first-note placeholder.

### Current rollout decision

**Retain baseline.** No locally configured authenticated HPOP benchmark credential is available. Public read-speech controls are prepared, but podcast reproduction, representative natural-case evaluation, blinded quality review and a live continuous-session check remain incomplete. The original one-minute session's cause remains unconfirmed. No live attainment rates or deadline winner are claimed.

### Verification completed on 2026-10-23

- `pnpm check`: type checking, **144 Vitest tests**, offline evaluation-tool checks and extension build passed. New cases cover policy transitions/new sessions, both transports, bounded local traces, metadata redaction, request-budget refusal, blinded evidence cutoff, successful-retry evidence selection, censoring, rollout refusal for synthetic results, and the evaluation gate's offline/denied/native-fetch paths.
- Existing assistant UI smoke check passed at widths 272/340/398/1000 and 200% zoom, with no page errors.
- Three real-audio browser checks completed with a **synthetic LLM only**: Indonesian FLEURS, the reported podcast opening at 00:00, and the concatenated Indonesian/English control. Each captured stage events, visible sidebar presentation, three completed audio downloads and an idle final state. The mixed control verified an actual short-first request followed by two requests using the original full-memo guidance. Its audio is concatenated read speech, not natural code switching.
- In the podcast check, first finalized text arrived about **9.75 seconds after Listen** and AI dispatch occurred at **9.90 seconds**. Local inference for that first window was about **1.54 seconds**. These are individual observations, not percentile estimates. The first draft transcript contains extensive repeated “Terima kasih” wording; fidelity needs audio review. There is no evidence here that a useful note was supported within eight seconds, nor that shortening the prompt alone fixes the reported experience.
- All displayed notes in those checks came from a fixed synthetic response. Their presentation times **cannot establish live useful-note performance**. The original one-minute live-provider delay remains unconfirmed.

Machine-readable checks: `artifacts/notes-latency-implementation-validation.json`. Browser traces and supplied context: `artifacts/notes-browser-offline.json`, `artifacts/podcast-opening-offline.json`, `artifacts/notes-browser-mixed-offline.json`, plus their Chrome timelines. `artifacts/notes-latency-rollout-check.json` confirms that unreviewed synthetic checks do not permit rollout. The real provider/corpus/quality/continuous-session evaluation remains pending, and production remains baseline.
