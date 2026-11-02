# Live memo v1 — contribution, context and history

This implementation replaces automatic cumulative minutes with a selective live companion. The main area shows one accepted contribution. It can ask an unanswered question, explain a concept, connect relevant information, suggest an option, or correct an interpretation. Understanding a topic does not itself require output. `wait` means insufficient context; `silent` means no useful addition. Both update context without generating visible text.

## Pipeline and contracts

`live-controller.ts` coordinates `PROPOSE` (20-second deadline) and conditional `REVIEW` (10-second deadline). They use `live_memo_proposal_v1` and `live_memo_review_v1`, validated locally with strict Zod schemas and source-ID checks. The reviewer accepts or rejects; it never rewrites the candidate. Its decision is a model judgment, not certification. Candidate body target is 30–90 words; the strict maximum is 1,200 characters, with no truncation. Titles are optional and rendered as text, as is the body.

The proposal receives separate new and recent transcript, current focus, source-quoted recalled information, recent contributions, relevant feedback, and the existing Settings objective. Recent context spans at most 90 seconds / 2,500 estimated tokens. New backlog is processed in bounded 2,500-token batches; the cursor advances through that batch only. Recalled memory is capped at 1,500 estimated tokens and ranked by lexical overlap, with priority for current-topic constraints and open questions. Estimates use UTF-8 bytes divided by three; these are experimental budgets, not actual tokenizer counts. Prior output is not the source of conversational truth. Transcript segments and their quotes remain primary.

Memory records distinguish facts, constraints, proposals, decisions, open/resolved questions and corrections. Each carries source IDs and a stable topic key; a correction can replace an earlier record by key. General model knowledge is permitted without browsing. Candidate flags and wording distinguish interpretation, general knowledge and suggestion from participant statements. References establish the conversational premise, not external knowledge.

One automatic chain runs at a time. New ASR arrivals debounce for one second, with a minimum ten seconds between proposal starts. New arrivals are coalesced; there is no fixed two-minute wait. Transport/format failures have bounded retry/backoff and honor Retry-After. Silence and semantic rejection are successful processing, never retries. Valid memory survives review rejection or review failure. The reviewer reads the latest transcript when it starts; further transcript or feedback changes before completion invalidate presentation. Stop, cancellation and session epochs fence late results.

## UI and storage

The active contribution provides kind, timestamp, Sources, Useful, Not helpful and Dismiss. More insights contains history in batches of 25 and Analyze deeper for the active context. Source navigation returns to its originating reading view. Topic changes archive the old active item; returning to an earlier topic does not automatically restore it. History remains available for the latest saved session. Updates do not switch views or scroll the reader to new content; if a focused contribution is removed, focus stays in the reading region.

IndexedDB `listen-live-memo-v1` is separate from historical `listen-assistant`. Its latest-session snapshot contains source-linked context, cursor, accepted contributions and feedback. The old database is read only; old minutes appear as “Notes from a previous version,” never as live contributions. New sessions reset live state. Transcript persistence and durable ASR windows retain their existing stores and behavior. A memo storage failure does not stop recording or ASR and is surfaced in the assistant.

Stop aborts live memo/deeper requests and saves accepted state. Audio export and ASR queues continue. Recovered closed-session transcription cannot restart live contributions. No final recap or MOM is created. MOM remains future work triggered explicitly after the session.

## Providers and relay transition

The existing OpenAI-compatible transport handles DeepInfra, retaining the pinned model and `reasoning_effort: none`. HPOP Claude uses the existing forced-tool transport for both new schemas, covered by mock SSE tests. The relay accepts those schemas and the historical `meeting_analysis` contract on the same endpoint. Health advertises `notes.liveMemoProtocol: 1`; an older running relay produces an explicit restart instruction. Restart only outside recording. No automatic provider fallback or browsing is added.

The baseline controller, prompts, schemas and replay data remain available for historical comparison. Their cumulative `summary` is not an input to live memo. A compatibility `summary` field projects the active contribution body for existing diagnostics; live rendering and generation use structured live state.

## Build and activation

Create a review build without overwriting the installed unpacked extension:

```sh
LISTEN_BUILD_DIR=artifacts/live-memo-v1/candidate-build pnpm check
```

The default build destination remains `dist` for ordinary builds. This implementation's validation uses the separate candidate directory. Do not reload the user's extension or restart their running relay during recording. Review real replay output first. Acceptance of the implementation is separate from user acceptance of usefulness; no benefit percentage has been established.

## Replay and request ceiling

```sh
node scripts/live-memo-replay.mjs --offline
node scripts/live-memo-replay.mjs --checkpoints
node scripts/live-memo-replay.mjs
```

Every invocation creates a new run directory. Offline mode is synthetic transport verification, not quality evidence. Checkpoint mode evaluates the seven frozen checkpoints plus ten five-minute checkpoints (four from the first recording, six from the second). It uses each transcript prefix's latest segment as new input with up to 90 seconds of recent context; it starts without inferred old memory. Full replay processes both complete baseline ASR arrival streams through the real controller, retaining context/history across steps. It reuses original ASR text, not newly transcribed full audio. Three synthetic non-meeting scenarios test conceptual explanation, unnecessary contribution and correction. “Synthetic scenario” describes its transcript; the online run still uses real model calls.

Replay time is a virtual clock with measured provider durations. It is not a browser capture-to-display latency measurement. Reports retain structured inputs, source quotes, proposal/silence reasons, candidates, reviewer results, raw state transitions, errors, usage and timing. A model-accepted candidate can still be suppressed by newer ASR, feedback or Stop. Human review labels save locally in the report and can be exported as JSON: membantu, mengulang, salah konteks, terlalu menebak, sebaiknya diam.

All live replay/checkpoint/browser evaluation requests share `artifacts/live-memo-v1/provider-budget.json`, capped at 800 upstream provider attempts including retries. The isolated browser smoke also counts ASR calls. Early interrupted experiments retain partial status and count against the same ceiling; they are never described as passed full runs. If the cap is reached, stop with a partial report.

### Provider outages during evaluation

An arrival replay finishing is not equivalent to every segment being processed. The initial full replay of the second recording paused after three consecutive provider failures at segment 88; it is explicitly partial processing. Evaluation can continue from a saved context checkpoint with `--resume=<prior-run-root>` (optionally `--recording=<label>`), collecting the already-arrived backlog and preserving subsequent baseline ASR arrival order. This reconstructs an evaluation state only. It does not enable production recovery of a closed session, and does not generate a MOM. Original failures and continuation traces remain linked in the consolidated report. The harness applies real 20/10-second network abort signals as well as its virtual scheduling deadlines, and records raw responses for diagnostic runs. The earlier run's one schema mismatch has no retained raw response; its same input was re-probed successfully, so the exact invalid field in that original response remains unavailable.
