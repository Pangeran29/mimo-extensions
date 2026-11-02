# Selectable notes providers and queued-audio merging

Date: 2026-10-26. **Current configuration: DeepSeek reasoning none; queued-audio merging enabled at a 16-second cap by user request. Earlier rollout decisions below describe the original evaluation.** Implementation is built and verified in isolated Chrome; the user's installed browser and running relay were not interrupted. This is still a local development integration, not a public deployment.

## What changed

Settings → AI connection offers HPOP / Claude Sonnet 5.5 and managed DeepInfra / `deepseek-ai/DeepSeek-V4.1-Flash-1017`. Existing installations retain HPOP. HPOP deeper analysis retains Opus; DeepInfra deeper analysis uses the pinned DeepSeek model and the existing deeper prompt. Switching is rejected during recording, transcription recovery or final analysis. The HPOP key survives selecting DeepInfra. There is no automatic fallback.

DeepInfra notes travel through the authenticated loopback relay. The provider key is backend-only in ignored owner-readable `.local/deepinfra.json`; the extension contains only the existing local development relay token. The notes route fixes the model/endpoint, bounds input/output, streams SSE, redacts errors, supports abort, and uses separate capacity from ASR. Readiness checks the relay's exact notes model without making an inference call. It does not prove provider credit or remote key validity.

The meeting prompt, schema, context budgets, output allowance and complete-response validation are preserved. Selected provider/model are identified in diagnostics and accepted-response metadata. Valid empty responses retain the memo and use the existing no-new-notes UI; provider failures use the existing recovery path.

Queued-window merging is implemented behind `LISTEN_ASR_BATCH_SECONDS=8|16|24`. It selects only already-waiting, same-session contiguous/overlapping windows when the serial worker becomes available. It never waits to fill a batch. PCM overlap is included once, retries freeze membership, original durable jobs remain until transcript and all acknowledgements commit atomically. Capture, VAD, ASR model and retry timing are unchanged. The relay accepts at most 24 seconds of the same float32 WAV representation.

## Measured evidence

These are small functional checks, not a reliability certification or an A/B quality ranking. Transcript-bearing outputs stay in ignored local `artifacts/`.

| Check | Actual result | Scope |
| --- | --- | --- |
| Exact DeepSeek schema preflight | HTTP 200, valid JSON, 2.56 s; reported estimated cost $0.000085456 | One nonstreaming contract check |
| Latest three DeepSeek streaming transcript checks | Valid responses in 6.08 / 5.15 / 5.19 s; two empty summaries, one title-only memo | Two reviewed Indonesian passages and the supplied vlog transcript; not audio capture |
| HPOP native Claude regression | Valid memo in 8.86 s, first JSON delta 8.13 s | One reviewed passage, existing native tool route |
| Real isolated Chrome pipeline | Capture, packaged VAD, real Qwen ASR, managed DeepSeek, accepted complete response and Stop/save succeeded; no page errors | One locally injected initial ASR outage, two real ASR requests and two real notes attempts; Stop cancelled one notes attempt before the final accepted response |
| ASR in the successful browser run | Upstream requests 15.55 s and 3.34 s | Request time only, excludes audio collection |
| Additional direct ASR diagnostic | 33.55 s for an eight-second excerpt | Shows substantial service variability |

An earlier browser attempt did not complete within its 90-second bound after four real ASR attempts. The successful rerun used a longer bounded observation period, with the same production provider path. Several earlier streamed development checks returned relay 503s; their underlying transport cause was not established. These failures remain in the request budget and are not counted as success. This work does not prove the historical eight-minute notes failure or the old no-note session's cause.

DeepSeek produced empty summaries and a title-only response despite schema validity. This is important model behavior to evaluate during user testing; passing validation does not establish that a memo is useful. No claim that DeepSeek is faster or better than HPOP follows from these different small inputs/runs.

## Batching comparison and rollout

The source was two adjacent manually reviewed meeting clips, 864–872 and 872–880 seconds, combined channel. PCM hashes are checked before dispatch; the sixteen-second source hash is `4bcb2eeed7ae259cb751067ff04fd32ffa011ccc40781c30051675bfd93f6211`. The evaluation explicitly formed overlapping windows [0,8], [7,15], [14,16]. References were used only for scoring after recognition.

| Cap | Requests | Already-queued backlog drain | Literal WER | CER |
| --- | --- | --- | --- | --- |
| 8 s (baseline) | 3 | 10.71 s | 33.3% | 11.3% |
| 16 s | 1 | 5.87 s | 33.3% | 9.0% |
| 24 s | 1 | 16.62 s | 33.3% | 9.0% |

The 16/24-second configurations sent **identical sixteen-second audio**; this was not a 24-second quality test. These are one-off, fixed-order observations of already-queued work, not real-time audio-to-transcript latency or queue-age measurements. Request variability is large. Literal Indonesian spelling/tokenization contributes to WER, and important terms remain wrong (bot detection / Lemhanas). Equal WER does not mean equal semantic quality.

**Rollout decision: retain the baseline eight-second dispatch default.** The 16-second observation is promising, but one source and no repeated randomized runs or candidate continuous browser session cannot justify enabling it broadly. The merging implementation is available for a separately bounded comparison; no new user setting is exposed. Recording and notes-provider choice can be used independently of batching.

## Verification and budget

Final checks cover provider normalization, old HPOP compatibility, DeepInfra automatic/deeper routing, readiness without an HPOP key, active-session switching, strict validation and empty responses, sample coverage/overlap/caps/gaps, ordered batching and new arrivals, recovered-batch retry, atomic storage failure, cancelled relay streams, fixed-model/auth/payload/redaction checks. Browser checks exercise the settings selector, sidebar/no-note/timing cues, failed-update recovery after simulated eight minutes, and closed-session startup.

The shared ledger records **25 requests including one free model-metadata GET**, reserving **$1.34** conservatively across both providers. The reservations include retries and cancellations and are not actual charges. HPOP returned no pricing; its one short live inference reserved $1. DeepInfra preflight returned the single cost above; a complete settled invoice was not available. No further paid tests were run after the reported comparison. Budget file: `artifacts/provider-batching/budget.json` (100 requests / $2 ceiling).

Live artifacts: `deepinfra-preflight.json`, `live-notes.json`, `live-notes-history.json`, `hpop-live.json`, `asr-diagnostic.json`, `batch-comparison.json` under `artifacts/provider-batching/`; full real browser result: `artifacts/provider-pipeline/result.json`. Current source/build hashes and final test totals are in `artifacts/provider-batching/verification.json`.

## Reproduce and run

```sh
pnpm typecheck
pnpm test
pnpm test:relay
pnpm test:latency-tools
pnpm test:whisper-debug
pnpm build
# Existing reviewed audio/reference assets and locally configured credentials required.
# These live scripts consume the persistent shared request/dollar budget:
node scripts/probe-notes-providers.mjs
node scripts/live-notes-check.mjs
node scripts/live-hpop-check.mjs
node scripts/probe-live-asr.mjs
node scripts/live-batch-check.mjs
node scripts/provider-pipeline-smoke.mjs
# Offline scoring (uses the existing local JiWER installation):
PYTHONPATH=artifacts/whisper-eval-python artifacts/asr-replacement/runtime-env/bin/python scripts/score-batch-comparison.py
# Browser checks require Playwright installed, or LISTEN_PLAYWRIGHT_PATH set:
node scripts/settings-smoke.mjs
node scripts/assistant-ui-smoke.mjs
node scripts/notes-recovery-smoke.mjs
node scripts/restored-startup-smoke.mjs
```

To activate locally, finish the current meeting first. Restart the developer relay (`pnpm relay`) to load the new notes route and refreshed backend key, then reload the unpacked `dist/` extension. Choose DeepInfra in Settings and save; choosing HPOP again restores that route with its saved key. The old running relay was deliberately left untouched, so the new notes route needs this between-meeting refresh.

The default build uses baseline batching. Experimental build: `LISTEN_ASR_BATCH_SECONDS=16 pnpm build` (or 24). Roll back with `LISTEN_ASR_BATCH_SECONDS=8 pnpm build`, then reload between meetings. Provider changes do not require rebuilding.

Public deployment, user authentication/usage metering, Windows testing, sustained real-meeting quality comparison, a multi-recording latency gate, and a combined candidate-batching browser session remain outside the verified result. The original reviewed recordings and human reference inputs are preserved.

## Reasoning comparison override (2026-10-26)

At the user’s request, DeepSeek automatic notes and deeper analysis now use `reasoning_effort: high` in both the extension adapter and the managed relay. Earlier measured results in this report used `none` and do not predict high-effort performance. Token allowances, prompts, schema and 30-second client / 29-second relay time bounds are unchanged. Nineteen provider unit tests, five notes-relay checks and typecheck passed; the build/package were refreshed. No paid high-effort comparison has been claimed. The relay was restarted after checking that it had no established connections; its fixed high-effort setting applies even to the already-loaded extension’s requests.

### Current override: medium (2026-10-26)

After observing increased response time with high effort, the user requested medium. DeepSeek automatic notes and deeper analysis now use `reasoning_effort: medium` in both adapter and relay. Qwen ASR is unchanged. Prompts, token allowances and timeouts remain unchanged. Nineteen provider tests, five relay tests, typecheck and build passed; package refreshed and keys excluded. Relay restarted with no established connections. New requests use medium without requiring the installed extension to reload. No live medium quality/latency result is claimed.

### Current override: low (2026-10-26)

The user requested low after observing medium latency. DeepSeek automatic notes and deeper analysis now use `reasoning_effort: low` in adapter and relay; Qwen ASR is unchanged. Prompts, token allowances and timeouts remain unchanged. Nineteen provider tests, five notes-relay checks, typecheck and build passed; package refreshed with provider keys excluded. Relay restarted after observing no established connections. New requests use low without an extension reload. No live low-effort latency or quality claim is made.

### Current setting restored: none (2026-10-26)

The user reported substantial latency without a noticeable quality gain across high/medium/low and requested the original `none` setting. DeepSeek automatic notes and deeper analysis now use `reasoning_effort: none` in both adapter and relay. This is a user-observed preference, not a controlled quality finding. Qwen ASR, HPOP, prompts, token allowances and timeouts are unchanged. Nineteen provider tests, five notes-relay checks, typecheck and build passed. Package refreshed and provider keys excluded. Relay restarted after observing no established connections, so new requests use none without an extension reload.

## Queued audio merging enabled by user request (2026-10-26)

The user explicitly requested the same waiting-work grouping for DeepInfra as for LLM notes. The default build and source fallback now use a 16-second unique-audio cap. One available window dispatches immediately; while a request runs, additional windows queue. When free, ASR selects the oldest contiguous/overlapping same-session prefix that fits the cap. Excess windows stay queued for later. Gaps are not silently removed or bridged. No concurrent requests, extra collection delay, prompt/model change or reasoning change is introduced. Existing overlap removal, frozen retries and atomic durable acknowledgements remain.

This enables the existing implementation for use; it does not establish a measured latency improvement beyond the exploratory comparison above. Broader candidate continuous-session performance is still unmeasured. Rollback: `LISTEN_ASR_BATCH_SECONDS=8 pnpm build`; default/enable: `pnpm build` or `LISTEN_ASR_BATCH_SECONDS=16 pnpm build`. Reload the extension only after Stop and pending recovery have completed. No relay restart is needed because its current 24-second WAV limit already covers the cap. Original eight-second VAD windows and the sidebar Audio window reading remain unchanged; the ASR request may contain several such windows.
