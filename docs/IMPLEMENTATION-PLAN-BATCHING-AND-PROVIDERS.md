# Implementation plan: queued-audio batching and selectable notes providers

Date: 2026-10-26. User requested both features for the extension, not a standalone model benchmark. Implementation and isolated verification are authorized; publishing/deployment and changes to an active user recording are outside this task.

## Decisions and access collected

- Keep HPOP available with its current automatic notes model, `claude-sonnet-5-5`, and its existing explicit deeper-analysis behavior.
- Add DeepInfra using the exact model `deepseek-ai/DeepSeek-V4.1-Flash-1017`.
- Reuse the service-managed DeepInfra account for ASR and notes. Its key remains backend-only; no customer DeepInfra key entry is added.
- The user supplied current DeepInfra and HPOP test keys. They are stored only in ignored owner-readable `.local` files. Neither value belongs in source, logs, reports, screenshots or the extension package.
- A **combined maximum of 100 live provider requests or US$2** applies to this work. Include both providers, ASR, retries and follow-up/deeper calls. Stop before either cap would be exceeded. Use a shared persistent budget ledger and conservative cost reservations; if a request's cost cannot be bounded, leave that live check pending rather than overspend. No SDK-hidden retries.
- Use existing reviewed meeting recordings/transcripts and the supplied vlog transcript. Any transcript-bearing evaluation artifacts stay local.
- No Console operations, browser setup or repeated debugging steps are required from the user. Run an isolated browser/profile and a separate test relay. Do not reload the user's installed extension or interrupt the running local relay/recording to perform tests.

## Product defaults

HPOP remains the selected provider for existing installs. Settings → AI connection gains a provider selector with clear model names. DeepInfra selection needs the managed local service, not an HPOP key. HPOP retains its saved key and access checks independently, so choosing DeepInfra does not delete or overwrite it.

Provider changes apply between meetings. Keep the current session pinned to its provider and reject/defer changes clearly while recording or finalizing; do not abort an in-flight notes request or clear a memo to switch providers. After selection, both automatic notes and the explicit deeper action use that provider. DeepInfra deeper analysis uses the same requested DeepSeek model and the existing deeper-analysis prompt; it does not silently call HPOP. HPOP's deeper model stays as currently implemented.

No automatic fallback between accounts/providers. A failing selected provider keeps recording/transcription running and uses the existing visible error/recovery path.

## Phase 1 — Baseline and provider contract verification

1. Record the current source/build identity and existing regression checks. Preserve current recording, ASR, notes, empty-summary handling, validation and recovery contracts.
2. Verify the DeepInfra key and the exact model with bounded real requests once budget accounting is in place.
3. Check streaming, the actual complete production analysis schema (including nullable question and size limits), output token controls, usage and reasoning-disabled behavior. Prefer the documented OpenAI JSON-schema route. If it is unsupported for this exact model, test one documented forced-tool route without weakening local validation. If neither works reliably, report the provider unavailable; do not silently substitute another model or accept arbitrary text.
4. Keep request/response evidence locally for these controlled development tests with strict key/header redaction. Capture exact validation issues, accepted-empty outcomes and timeouts. Distinguish live responses from injected fixtures in every report.

## Phase 2 — Provider adapter and managed relay

Add an explicit provider identity and a canonical provider→model mapping. Read legacy settings as HPOP. Reject unknown providers/models; do not let arbitrary endpoints be supplied from Settings.

Required areas:

- `src/assistant/types.ts`: provider type/settings, provider-aware snapshots and initialization protocol, backward-compatible settings normalization.
- New small provider configuration/adapter module: fixed model and endpoint mapping, provider-specific controls, no change to the shared meeting prompt/schema.
- `src/assistant/provider.ts`, `client.ts`, `network-worker.ts`: route through explicit provider configuration; preserve existing HPOP exports/transport behavior; retain complete-response validation, cancellation, request correlation and time bounds. Use `reasoning_effort: none` for live DeepSeek summaries if the exact route confirms support. Keep internal reasoning separate from the final JSON/memo.
- `server/relay.mjs` plus a focused notes-route helper: a fixed-model, authenticated loopback OpenAI-compatible notes endpoint. Reuse the server-side DeepInfra key. Validate request size and allowed fields; do not provide a generic open proxy. Stream successful SSE with bounded output and propagate cancellation; preserve safe status/Retry-After information without forwarding provider credentials or raw error bodies.
- Keep speech and notes request accounting/limits separate inside the relay so a notes call does not block an otherwise available ASR slot.
- `src/assistant/settings.ts`, `offscreen.ts`, `worker.ts`: selected-provider readiness and startup checks. DeepInfra must not require an HPOP key/permission. Preserve existing HPOP key migration and saved sessions. Do not reopen a completed meeting during settings changes.
- `src/setup.ts`, `public/setup.html` and minimal CSS: provider choice and conditional connection guidance, active-session switching restrictions, and truthful configuration/readiness labels.
- Provider-neutral error/status/privacy copy and support-report identification. Preserve live timings and accepted-empty explanation. Manifest permissions stay limited to the existing HPOP and loopback destinations; the browser never receives the DeepInfra provider key.

## Phase 3 — Queued-window merging, independently switchable

Follow `ASR-BACKLOG-BATCHING-SCOPE.md` for the exact boundary.

- New pure `src/transcription/batch.ts` selects the oldest eligible queue prefix and assembles PCM with internal overlap removed once.
- `src/transcription/controller.ts` selects a batch only when the serial worker is free. Do not add a collection timer or concurrent ASR requests. Keep a single available window's behavior unchanged. Freeze active batch membership and account for all original queued windows.
- `src/transcription/store.ts` atomically commits the transcript and acknowledges every original job in the batch. Retain individual original jobs for crash/retry recovery; no schema migration or durable duplicate merged audio.
- Raise the relay's bounded WAV size/duration limit consistently with the experimental cap. Keep ASR model, format, authentication and initial request timeouts unchanged.
- Merge only same-session, touching/overlapping sample ranges. Stop at a real gap or cap. Do not join nonadjacent benchmark clips as continuous speech.
- Evaluate baseline, 16-second and 24-second unique-audio caps; caps are maxima, not waiting timers. Enable the smallest cap that provides a measured backlog benefit without unacceptable accuracy or recovery regressions. If evidence is insufficient or no candidate helps, retain the baseline dispatch default and document why. Keep an internal rollback switch.

No recording-engine, VAD segmentation, LLM prompt/persona or context-budget rewrite belongs to this phase. A batch produces a larger transcript segment, so verify downstream evidence references and LLM cadence even though that code is unchanged.

## Phase 4 — Verification matrix

Run focused tests after each phase, then the full checks after integration.

- Provider settings migration, save/reload, readiness without the other provider's key, no loss of HPOP key, explicit selected-provider deeper routing and safe between-meeting switching.
- Both transports: nonempty memo, valid empty summary, malformed JSON, schema/evidence rejection, retries/rate limits, timeout, worker cancellation, Stop/finalization, new session and saved-session restoration.
- Batching: exact PCM/sample coverage, overlap, caps, gaps, session isolation, first-window dispatch without waiting, new arrivals while busy, no concurrent calls, whole-batch retry/acknowledgement, empty ASR output and crash/restart recovery.
- Relay: authorization, origins/host, payload limits, fixed-model enforcement, SSE, abort, key/error redaction and independent ASR/notes handling.
- Actual isolated Chrome pipeline: production capture/VAD/relay/transcript/provider/sidebar paths. First use deterministic faults to verify mechanics, then real provider calls within the shared cap. Synthetic replies never count as live latency or quality evidence.
- A continuous-session check and Stop/save check, including no-note feedback, notes update delivery and preserved pending audio.
- Compare batches on the same real continuous audio, not a changing stream. Record queue age, audio-to-transcript delivery, ASR request duration/count, accuracy and failures. Validate provider switching with ASR batching disabled first, then test the combined configuration.
- Full type check, unit tests, relay checks, build, secret scan, extension ZIP and reproducible reports. No unsupported population-wide reliability or model-quality claims.

## Unattended completion and failure policy

Do not wait for another approval for routine implementation/testing within this scope. Resolve ordinary implementation choices conservatively and record them. Stop paid calls at the combined budget cap; do not keep retrying a failed provider preflight indefinitely. If exact model access, credits, provider schema support or a live test is blocked, finish independent work and report the precise blocker. Preserve baseline behavior for an unsafe/unsupported path.

Deliver a selectable working provider UI and a documented batching rollout decision, with changed files, actual tests/live calls/cost estimates, limitations and rollback instructions. Leave the user's active browser session untouched. Public deployment, account/usage billing, customer rollout, new personas and source separation are deferred.

## Primary sources checked

- Exact model and API: https://deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash-1017/api
- OpenAI-compatible endpoint: https://docs.deepinfra.com/chat/overview
- Structured outputs: https://docs.deepinfra.com/chat/structured-outputs
- Streaming: https://docs.deepinfra.com/chat/streaming
- Reasoning controls: https://docs.deepinfra.com/chat/reasoning

These establish documented capabilities, not measured compatibility or latency for our extension. Current live behavior must be tested against the pinned model ID.
