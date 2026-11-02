# Recorded audio → transcript → notes baseline

Use the supplied combined recordings as evaluation fixtures. This does not train or fine-tune a model. The baseline preserves the production notes prompt, schema, model, objective default and memory/context budgets before any improvement work.

The intended product direction is general audio understanding across meetings, YouTube, lectures, and other input/output audio. This first review deliberately records today's meeting-oriented behavior. Broader-purpose prompt changes and quality criteria come after the user reviews this baseline.

## Run

```sh
# Decode and detect speech locally, without provider inference:
node scripts/recording-replay.mjs

# Both complete recordings, using the existing backend credential:
node scripts/recording-replay.mjs --run

# Verify the completed evidence and add exact playable ASR window clips:
node scripts/recording-replay-finalize.mjs artifacts/recording-replay/baseline-2026-10-29

# A separate short run (never present this as full-recording coverage):
node scripts/recording-replay.mjs --run --recording lemhanas-16-10 --limit-seconds 60 --output artifacts/recording-replay/pilot

# Synthetic transport/context-chain verification; no paid inference:
node --test scripts/recording-replay.check.mjs
```

Requires Node 22+, installed workspace dependencies, the configured `.local/deepinfra.json`, and FFmpeg. `LISTEN_FFMPEG_PATH` overrides the bundled development FFmpeg executable. Defaults to both supplied recordings. The script starts its own authenticated relay on an ephemeral loopback port; it leaves the user's running relay, Chrome, extension build and settings untouched.

## Method

1. Hash and decode each `-combined.webm` file to 16 kHz mono float32 PCM. Original files are never modified. No normalization, transcript correction or speaker inference is applied.
2. Run the same Silero V5 model, 512-sample frames and production `SpeechSegmenter`. Retain actual detected window ranges and overlap flags. Pad only a final incomplete frame (less than 32 ms).
3. Release windows on an accelerated source clock at their end times. Production `selectBatch` merges only already-queued contiguous windows, capped at 16 seconds. Run serial Qwen3-ASR requests using the production client and isolated relay. Apply production overlap removal before delivering transcript segments.
4. Feed transcript arrivals to the current `AssistantController`. Only its timer and `Date.now()` references are redirected in the evaluation bundle; the production source files are unchanged. Provider fetches, abort deadlines and request-duration measurements use the real clock. Network calls run concurrently where the simulated ASR/notes schedule allows; completions enter the replay clock using measured duration. No future transcript is supplied to an earlier request. Idle source time is skipped, so this is not observed browser latency.
5. Use the current DeepSeek model, `reasoning_effort: none`, baseline memo policy, unchanged prompt and schema. Record the full exact request messages, raw response including failed/partial results, validation/acceptance decision, resulting memo, memory and active question. Stop/final analysis uses the current controller's bounded completion logic.

An ASR failure retries the same batch with the production backoff; six consecutive failures stop the evaluation with partial evidence. Notes retain the controller's recovery behavior. Additional evaluation request ceilings prevent an endless paid retry loop. These evaluation limits do not change production.

Successful ASR results are cached by exact PCM and model for reruns, with original measured request duration retained. Cached results are labeled. LLM calls remain live on each run. Choose a fresh `--output` directory to preserve a previous run; default output is overwritten. A global ceiling of 1,800 upstream calls per invocation is a request bound, not a dollar-cost estimate.

## Review files

`artifacts/recording-replay/baseline-2026-10-29/index.html` links the separate reports. Each recording contains:

- `review.html`: expandable sequence table. Each row is one LLM attempt; new transcript, earlier context, previous memo, memory, question history, full prompts, raw output and accepted memo are inspectable. A second table maps audio windows to raw and overlap-cleaned transcripts.
- `run.json`: full evidence, source hashes, timings, model/configuration and intermediate/final state. Checkpointed during execution; partial runs are clearly labeled.
- `final-notes.md`: latest accepted memo and run status.
- `audio/`: exact float32 WAV windows reconstructed by the finalizer from the hashed decoded PCM and each ASR range, including the final frame's zero padding. Expand an ASR row to play its short clip directly. Retries of an identical range reuse the same clip.

The finalizer checks the previous-memo chain, transcript availability before each request, response schemas, source hashes and completed-run window coverage. It also checks exported text for the configured provider key and relay token. Passing these checks establishes trace integrity, not note accuracy.

The evidence contains private meeting content. Reports and caches remain local under ignored `artifacts/`. Provider keys and authorization headers are excluded from reports. The isolated runtime bundle contains a local relay token as the extension does; do not publish that bundle.

## Interpretation

This tests the recorded-audio/VAD/ASR/notes content pipeline. It does not test tab/microphone capture, the browser resampler, audio device handling, IndexedDB recovery, UI paint or actual Listen-click latency. Re-decoded Opus recordings differ from live PCM. Real provider results remain unreviewed drafts; structural validation and nonempty notes do not establish factual correctness. The compact memo and finite memory are the current product behavior, including any lost older details.

Review the baseline first. Keep findings separate from prompt/model changes, and preserve the original evidence for later comparisons. The two recordings alone do not establish performance across YouTube, lectures, interviews or other audio categories.
