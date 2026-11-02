# Memo Replay Lab

Replay Lab runs a fixed audio recording through the actual extension at its original speed. The current 0.13.0 source candidate adds the shared end-meeting pipeline at EOF and manual Stop; its current evidence and activation limits are in [End meeting](END-MEETING.md). It is a separate research extension and Chrome profile; it does not replace `dist` or reuse the main extension's latest session.

## Open the lab

From the project directory, run:

```sh
pnpm replay:lab
```

The launcher builds the research extension and opens an isolated Chrome window. Chrome must be installed. Playwright is a project development dependency. The default build is stored in `artifacts/replay-lab/build`; the default persistent research browser profile is `.local/replay-lab-profile`. `LISTEN_REPLAY_BUILD_DIR` and `LISTEN_REPLAY_PROFILE_DIR` override both paths. To inspect the isolated 0.13.0 candidate without rebuilding or using the existing research profile:

```sh
LISTEN_REPLAY_BUILD_DIR=artifacts/end-meeting-2026-11-02/replay-build \
LISTEN_REPLAY_PROFILE_DIR=.local/end-meeting-beta-profile \
pnpm replay:lab --no-build
```

The main Chrome profile and extension are untouched.

On a new research profile, the launcher tries the existing managed DeepInfra connection using a health check and saves research-profile defaults. It does not start audio, ASR, or LLM inference. If setup is incomplete, open **AI settings** in the lab and configure the connection. Provider credentials in the main Chrome profile are not copied.

1. Choose an audio file. The lab stores a local copy and its SHA-256 identity.
2. Optionally enable **Hear the recording while it runs**.
3. Optionally **Choose output folder** for this page’s runs. Each run gets a unique session subfolder for combined audio, timestamped transcript and meeting notes. You can choose or retry afterwards.
4. Click **Start replay**. This explicitly starts real ASR and AI requests using the research profile's configured services; charges may apply.
5. Watch **Memo, live**. This embeds the real assistant page, not a report renderer or simulated Memo layout.
6. Inspect **What happened**. Select a stage, open an event's explanation, and expand **Complete evidence** for source text, IDs, request/response data, or diagnostics.
7. Click **Repeat** when processing has settled. It reuses the same source with a new run ID, session ID, and empty conversation context. Earlier evidence remains available under **Inspect a run**.
8. Export an HTML report or JSON before sharing a bug. The HTML download renders as an inert report page; embedded transcript/model content is escaped. Exports include conversation/model text, so review their contents before sharing them. Audio bytes and credentials are excluded.

Selecting an earlier run changes the evidence timeline. The embedded Memo always shows the latest actual session; historical run selection does not replay old snapshots into the live extension.

## What is exercised

The source is a local audio element connected to a Web Audio stream. Playback stays at 1×, including silence. Only played audio reaches the packaged VAD, speech-window/outbox pipeline, ASR adapter, ordered transcript, v2 proposal/reviewer chain, persistence, worker/offscreen messages, and actual UI. The physical microphone and tab-capture acquisition are bypassed. Separate device/permission/capture smoke tests are still required for those boundaries.

Files are limited to 128 MiB. Supported selections are WAV, WebM, MP3, M4A, MP4, Ogg, Opus, and FLAC; Chrome must be able to decode the actual contents. An unsupported or malformed file cannot reach ASR. Original audio stays in the research profile; audio windows and context leave the device only after Start. Audio bytes and credentials are excluded from reports.

Pause, arbitrary seek, accelerated playback, transcript-only replay, and frozen-response user modes are not included in this first implementation. Rewinding audio without rebuilding context would invalidate a comparison. The automated smoke harness does use fixed local responses to validate transport and UI without provider charges.

## End, Stop, recovery, and failure

In the 0.13.0 source candidate, natural EOF immediately stops live memo publication and enters the same durable end-meeting controller as ordinary Stop. The final VAD window is flushed; final complete ASR feeds factual whole-conversation minutes. Run finalization waits for transcription and end-meeting work to settle, rather than requiring the live memo cursor to publish a final update. The older 60-second live-memo EOF-drain behavior belongs to the historical implementation evidence below; it is not a deadline for final ASR or MoM generation.

**Stop** pauses playback and cancels live memo publication immediately, preserving accepted live state. It finalizes a separate WebM recording of only the played prefix, flushes final speech, and begins the shared complete-transcript minutes pipeline. Manual Stop marks the run partial because the full imported source was not played. EOF uses the played recording too; the imported original file is not copied as the export. Folder cancellation retains the result. The embedded Meeting notes reader offers per-file status, source inspection, save and retry actions.

If ASR remains unavailable, its existing durable outbox may remain pending after Stop or EOF. Repeat waits for recovery. Incomplete transcription does not produce final minutes; a terminal failed/incomplete transcript can settle the run as partial evidence rather than leave its status eternally active. Closing/restarting the research browser marks an interrupted run partial and never autoplays it. Opening the lab alone does not start ASR recovery. An explicit subsequent Start may first recover queued audio from the interrupted session, without reviving that session's live memo.

Source/processing/storage failures retain incomplete evidence with explicit flags. Replay events are capped at 32 MiB per run; full-content AI diagnostics have their existing 16 MiB session cap. The accepted state and full AI report are frozen into each completed run so that the ordinary diagnostic retention of three previous sessions cannot remove older research evidence. The research archive stores imported recordings and run evidence locally until its profile data is cleared; it has no automatic archive cleanup. Separately, the production end-meeting job store retains the latest fully saved completed reader plus unfinished jobs. A settled research run may still have unsaved meeting exports; its end-meeting snapshot records that distinction.

## Reading the evidence

Every run records source identity, build/protocol, provider/model/objective and ASR batching settings, audio progress, transcript state, accepted memo/contribution IDs, final snapshots, and lifecycle/error events. New runs also retain the final end-meeting snapshot and end-meeting request/review/export events. These are independent of the archived live memo state. The AI capture records both stages' exact request bodies and raw public responses, including reported token usage and elapsed time. Worker diagnostic events add request timing and failure categories.

Stage filters, row titles, and category labels use the same structured event description. Named diagnostics inside pipeline events retain their actual VAD/ASR/transcript/AI/display identity. Errors includes structured ASR and assistant failures plus source-error, drain-timeout, and interrupted-run markers; ordinary transcript/model prose mentioning an error is not treated as a failure. Each row opens a readable summary, then its independently controlled **Complete evidence** disclosure. Polling and reload preserve actionable status errors. During stopping, playback and live publication have ended while final audio, transcription, minutes or eligible file exports may still finish. A settled run is not a guarantee that all three meeting files were saved.

Frontend observations identify state receipt, applied DOM revisions, next-frame visibility estimates, bubble open/close causes, character reactions, Sources, feedback, and Stop. An unchanged accepted ID is retained output, not a new contribution. This also fixes the prior diagnostic probe's use of legacy memo/session variables for v2.

Audio position, elapsed wall time, and UI observation times are distinct. Worker/network events use the latest sampled audio position, approximately one-second precision; treat those positions as estimates. Source position does not mean that every second up to that point was included in a particular LLM request: inspect that request's transcript/source IDs. Visibility estimates do not prove browser paint; browser captures provide separate evidence.

The same recording makes audio input repeatable. Live ASR/LLM outputs and latency can still vary. Differences between runs should be assessed using source position, transcript arrivals, request inputs, accepted IDs and actual UI events. A failed or capped run is partial, not a quality pass.

## Development and verification

```sh
# Separate research build
LISTEN_REPLAY_LAB=1 LISTEN_BUILD_DIR=artifacts/replay-lab/build pnpm build

# Offline actual-extension integration with a synthetic local relay
pnpm test:replay-lab

# Open an existing tested research build without rebuilding
LISTEN_REPLAY_BUILD_DIR=artifacts/replay-lab/build pnpm replay:lab --no-build

# Offline end-meeting integration (real browser OPFS writer; native picker substituted)
pnpm test:end-meeting
```

The build script rejects `LISTEN_REPLAY_LAB=1` with output `dist`. Normal builds omit the lab pages and reject replay controls. Research-only relay origin/token overrides are available to the offline harness. No provider requests are made by the launcher smoke (`node scripts/replay-lab.mjs --smoke`).

Current end-meeting evidence and remaining native-picker checks are documented in [the 2026-11-02 implementation record](../artifacts/end-meeting-2026-11-02/IMPLEMENTATION.md). The native picker context probe establishes invocation, not completed OS selection or permissions; the deterministic integration substitutes OPFS selection.

Historical evidence for the 2026-10-31 implementation is under `artifacts/replay-lab-2026-10-31/` and `.impeccable/review/replay-lab/`:

- [Technical check](../artifacts/replay-lab-2026-10-31/check.log): typecheck, 259 unit tests, 11 relay tests, five evaluation-tool tests, and the separate research build pass.
- [WebM source-preparation smoke](../artifacts/replay-lab-2026-10-31/webm-source-smoke.json): the actual 16-10 and 28-10 Chrome recordings resolve to 1,321,679 ms and 2,054,576 ms. Both exercise the initial `Infinity` duration fallback (seek to `1e10`, then back to zero), remain paused at position zero with live prepared tracks, and close/end/revoke their resources during cleanup. This metadata/source-preparation check performs no playback, VAD, ASR or LLM work; paid requests are zero and the ledger is unchanged. It is not a full replay or quality validation. Reproduce with [replay-webm-source-smoke.mjs](../scripts/replay-webm-source-smoke.mjs).
- [Actual-extension offline smoke](../artifacts/replay-lab-2026-10-31/replay-lab-smoke.json): 44 checks pass, with no browser errors and zero paid provider requests. This covers real file/VAD/message/v2/UI integration with fixed local provider responses, including Repeat, EOF/Stop/reload, archived evidence, error recovery, disclosure state, and a rendered inert HTML export.
- [Normal UI regression](../.impeccable/review/replay-lab/regression/result.json) passes 26 checks; the [normal-build replay gate](../artifacts/replay-lab-2026-10-31/normal-replay-gate.json) rejects replay commands. [Main-build invariants](../artifacts/replay-lab-2026-10-31/main-build-invariants.json) confirm all 41 installed files exactly match the previous 0.9.0 candidate.
- [Launcher smoke](../artifacts/replay-lab-2026-10-31/launcher-smoke.log) confirms opening the research profile does not autoplay or start inference. [Headed launch](../artifacts/replay-lab-2026-10-31/launcher-live.log) records the separate research window opened with build `2026-10-31T05:11:33.453Z`, without starting audio or inference.
- [Browser evidence](../artifacts/replay-lab-2026-10-31/browser-evidence.md) identifies all eight validated captures and their build associations. The [first independent finish review](../artifacts/replay-lab-2026-10-31/frontend-finish-review.md) requested three bounded fixes; the [final verdict](../artifacts/replay-lab-2026-10-31/frontend-finish-verdict.md) resolves F1–F3 and returns **ship — scoped UI finish**. Saved [correction proofs](../artifacts/replay-lab-2026-10-31/reviewer-fix-proofs.json) accompany the 44-check smoke. The [downloaded HTML report](../artifacts/replay-lab-2026-10-31/synthetic-run-report.html) was opened and verified to render as a page.
- [Documentation handoff](../artifacts/replay-lab-2026-10-31/frontend-documentation.md) records the surface and inherited design-system boundary.

All automated provider traffic for this work terminates at the synthetic local relay. Full live-provider quality and latency remain unvalidated. The existing evaluation ledger remains exhausted at 800/800 and is not reset; a new automated live-provider evaluation requires a newly authorized budget. User-operated live replay is separate from the offline validation result.
