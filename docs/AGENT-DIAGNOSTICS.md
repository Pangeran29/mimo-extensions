# Local agent diagnostics

Implemented 2026-10-26. This is a separate full-content report; the existing metadata-only support diagnostics remain unchanged.

## Use

1. Finish any active meeting and wait for pending transcription/final notes before reloading the rebuilt extension.
2. Settings → Privacy & help → **Save agent diagnostics for future meetings**. This is off by default. Changes apply to the next meeting; they do not begin or stop capture mid-session.
3. Start a meeting normally. Each actual LLM attempt is captured, including grouped transcript passages and retries.
4. Press Stop & Save. Audio downloads continue as before. After queued transcription and final notes processing finish, a local `listen-agent-report-<timestamp>.html` downloads. Chrome's download preferences may ask where to save it.
5. Open the HTML file locally. It requires no server or network. **Download latest agent report** in Privacy & help retries an export or retrieves an incomplete report after interruption.

If recognition is still recovering, automatic export waits for the notes-finalization path; it does not falsely call pending audio complete. A final notes timeout or validation rejection is reported with the retained memo and incomplete state. A browser crash/reload cannot perform the normal automatic export; already-written events remain available for manual recovery. Reports are never reconstructed from later transcripts and presented as exact historical inputs.

## Read a report

Each attempt has a unique request ID, including a recorder-lifetime epoch to prevent collisions during recovery. The readable overview shows new transcript passages, the previous memo supplied, and notes after that attempt. Expand the detailed entries for:

- The exact `AnalysisInput`: objective, transcript IDs/times/text, earlier/new split, previous memo, bounded memory, recent questions and summaries, prompt policy, context-gap and validation feedback.
- Available, omitted and shortened segment IDs for automatic notes. Omitted IDs can include older already-processed context; they are not automatically evidence of lost unprocessed speech. The final transcript is included separately.
- The exact JSON request body sent by the provider SDK. This records system instructions, schema/tool configuration, selected model, reasoning controls and output-token allowance. HTTP headers, keys and endpoints are not captured.
- The assembled final output text / native tool-argument JSON, finish reason, elapsed time and token usage when returned. Malformed and oversize outputs are retained even when validation rejects them. Reasoning deltas are not captured.
- Application validation: accepted updated/unchanged/empty result, rejection metadata, cancellation, and memo retained or revised. Valid empty output does not erase previous notes.
- Actual local memo-save events and failures. A final snapshot of actual stored assistant state is distinct from the live controller snapshot. This avoids calling an in-memory update a successful save.
- Stop and final state, final transcript, pending/incomplete flags, and an optional correlated DOM reading from a responding sidebar. DOM text/visibility is an observation, not proof of visible paint. A missing or different-session panel is explicitly unconfirmed.

The complete machine-readable JSON is included as escaped text at the bottom of the same HTML file. No script executes, even if the transcript/model output contains HTML. The report can be inspected or copied for offline analysis. No private model chain of thought is recorded or inferred.

## Boundaries and storage

The opt-in flag is stored in trusted local Settings storage. The worker passes its value through the session-start message; the offscreen recorder cannot use Chrome's Settings storage API directly. Capture is fixed for that session. Full-content data is written to a separate IndexedDB database `listen-agent-diagnostics`, never the metadata timing stream or console logs.

Events have wall time, monotonic offset/time origin, session ID, request ID and database sequence. Writes are serialized locally. A report is capped at 16 MiB of serialized captured events; if reached, further events are omitted and the report declares itself incomplete. The rendered HTML may be larger because it contains readable views and full JSON. The newest four reports are retained; older report events are deleted when another session starts. Recording/audio stores are untouched. Downloaded files remain until the user removes them.

Diagnostics are best-effort. Capture/serialization/storage failures must not reject an otherwise valid model response or stop recording. Download failure retains the local report for retry. An interrupted/cancelled worker may leave no raw response or only a partial one; its application decision is recorded as cancelled rather than inventing a response. Automatic export is initiated only for a captured session with an explicit user Stop, after the final notes persistence path settles. Incomplete sessions can be exported manually.

Reports contain meeting text, prompts and notes. They do not upload to a diagnostic service. Provider credentials are excluded by construction: only SDK request bodies and model text are captured, never account headers or connection settings. Spoken/quoted secrets inside meeting content are still meeting content and should be reviewed before sharing.

## Verification

- Unit checks: opt-out, immutable inputs, event order, Stop versus interruption, incomplete recovery, safe HTML escaping, size bounds, four-report retention, export failure/retry/deduplication, offscreen opt-in without Chrome storage, both provider transports' rejected raw output, credential/header exclusion, and diagnostic callback failure isolation.
- Isolated Chrome capture/VAD/relay/notes/Stop/download run passed. It used the existing reviewed audio twice, a synthetic ASR outage followed by synthetic recognition, and synthetic LLM SSE. The resulting downloaded report contained multiple actual request inputs and a later previous memo, validated output, saved state and Stop/finalization events; test credentials were absent. These are functional tests, not model-quality measurements or paid live calls.
- Settings opt-in at narrow widths, sidebar behavior, notes-retry recovery after a simulated eight minutes, and saved-session startup checks passed. Browser code ran in isolated profiles; the user's recording and relay were not restarted.

```sh
pnpm typecheck
pnpm test
pnpm test:relay
pnpm test:latency-tools
pnpm test:whisper-debug
pnpm build
# Playwright available by module name or LISTEN_PLAYWRIGHT_PATH:
node scripts/agent-diagnostics-smoke.mjs
node scripts/settings-smoke.mjs
node scripts/assistant-ui-smoke.mjs
node scripts/notes-recovery-smoke.mjs
node scripts/restored-startup-smoke.mjs
```

Browser artifacts: `artifacts/agent-diagnostics-browser/result.json`, downloaded HTML and `report.png`. Test replies are marked synthetic and paidCalls=0. Earlier failed attempts under that directory document the offscreen-storage integration issue and the test harness's initial filename assumption; the final result is the successful check. Build/source hashes, final check totals and credential scan are recorded in `artifacts/agent-diagnostics-verification.json`.
