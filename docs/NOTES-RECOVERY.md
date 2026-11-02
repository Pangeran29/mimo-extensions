# Notes stop updating after an invalid model result

## Finding and patch — 2026-10-25

The reported sidebar message comes from notes generation, not cloud transcription. The controller previously paused permanently after **three consecutive failures**, including malformed model output, timeouts, rate limits and service outages. Finalized transcripts could continue arriving, but the paused scheduler would not dispatch another notes request until manual retry.

There is no eight-minute notes expiry in that scheduler. The original session was already stopped/reloaded before inspection; its invalid response and precise validation failure were not recovered. The three-failure pause is confirmed in code and reproduced synthetically; the original response's cause remains unproven.

The patch:

- Keeps the last validated memo and processed-transcript cursor unchanged on invalid output.
- Automatically retries format, network, timeout, HTTP 408/409/429 and server errors. Backoff is 2s, 4s, 30s, then 60s between attempts, measured after failures. Longer provider Retry-After values take precedence. One request runs at a time; transcript arrivals do not bypass backoff.
- Continues coalescing newly finalized speech into the next request using the existing 90-second/context-size bounds. Long outages can exceed those bounds; automatic recovery does not guarantee coverage of every missed passage.
- Retains manual pause for authentication and other permanent HTTP request errors. Disabling AI or starting a new session cancels scheduled retries. Manual retry now clears an existing retry timer.
- Leaves recording, transcription, provider/model, token allowance, prompt and strict complete-response validation unchanged. Finalization retains its bounded deadline; unfinished analysis is marked incomplete.

## Safe failure diagnostics

`AssistantSnapshot.lastFailure` retains the latest failure's timestamp, request ID, HTTP status, category, fixed reason code and consecutive count. It is saved locally with the existing assistant snapshot, survives successful recovery/reload, and resets for a new session. It contains no response text, audio, transcript or key. This small metadata record is available without enabling detailed tracing. Existing opt-in tracing remains off by default.

Reason codes distinguish `json_syntax`, `schema_mismatch`, `unknown_evidence`, `response_too_large`, `output_truncated`, `missing_tool`, `unexpected_tool`, `unexpected_finish`, and `unknown`. Both provider transports and the network-worker bridge preserve these codes. `unknown` also accompanies transport failures where no format check was reached. Strict schema and evidence checks still reject invalid results.

If another failure occurs, the helpful user evidence is the approximate time and whether transcript text keeps arriving and the retry countdown progresses. Keep the session open if possible. Save the meeting audio normally before reloading. No need to share credentials or the entire private transcript.

For developer inspection, run this in a trusted extension page's DevTools (not the YouTube console), **before starting another meeting**, then share only the resulting metadata:

```js
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('listen-assistant', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const failure = await new Promise((resolve, reject) => {
  const request = db.transaction('latest').objectStore('latest').get('snapshot');
  request.onsuccess = () => resolve(request.result?.lastFailure ?? null);
  request.onerror = () => reject(request.error);
});
db.close();
console.log(failure);
```

For stage timing and token usage, enable the existing local diagnostic trace before a new session, using `policy: 'baseline'` to preserve production behavior. See [NOTES-LATENCY.md](NOTES-LATENCY.md). Trace `ai.error.reason` now carries the same fixed reason code. No raw model output is retained, so a schema failure code alone does not identify the exact offending field or prove why the model generated it.

## Verification

Commands from the repository root (Node 22+ on PATH):

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/test-notes-latency-tools.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/notes-recovery-smoke.mjs
node scripts/build.mjs
```

The smoke script defaults to macOS Chrome; set `LISTEN_CHROME_PATH` for another installation. It starts an isolated browser with synthetic transcript and provider SSE. It uses the real controller, client, worker, provider validation and presence code, injects three schema failures after eight simulated minutes, checks the retained memo and automatic recovery in the rendered page, and makes **zero paid requests**. It does not replay the user's original session or test real provider quality. Output: `artifacts/notes-recovery/result.json`.

Verified on this machine: 156 Vitest tests, five relay checks, type check, offline latency-tool checks, Chrome recovery smoke and extension build passed. The Chrome report records `schema_mismatch`, consecutive count 3, and the recovered memo at version 2 with the error cleared. The unpacked build and extension ZIP were rebuilt; the provider credential was verified absent from the build. The user's browser extension was not reloaded automatically.

## Live schema mismatch investigation — 2026-10-25

The user captured `category: format`, `reason: schema_mismatch`, `status: 0`, `count: 8` from a running session. A separate read showed the last accepted memo at **2381 characters**, 19 below the unchanged 2400-character maximum. This confirms eight consecutive local schema rejections. It does not identify the failing field in those rejected outputs: the earlier build discarded Zod issue details. A revised memo exceeding the character cap is the leading hypothesis, not a proven diagnosis. Other field lengths, missing fields, invalid types or extra fields can produce the same old code.

The follow-up patch preserves up to five allowlisted validation issues: field path, issue code, numeric constraint and string/array size. It excludes response text, schema messages, unknown property names and enum values. The existing local last-failure record carries this metadata through the worker and controller; raw responses remain unrecorded. The sidebar retry warning displays the first failed constraint, avoiding another Console-only investigation.

The next already-scheduled retry receives sanitized application feedback describing the failed constraint. For `summary: too_big`, it asks for a complete memo below 2000 characters, keeping the hard cap at 2400 and prioritizing decisions, owners, dates, numbers and unresolved commitments over old background. Successful recovery clears feedback from subsequent requests. The patch adds no calls beyond the current retry schedule, no new provider/model, no automatic truncation, and no weaker acceptance schema. Normal successful-request prompts and explicit deeper analysis retain their previous instructions.

This adopts the established validation-feedback pattern described by [Pydantic AI's output documentation](https://pydantic.dev/docs/ai/core-concepts/output/). [Anthropic's structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) also documents that constraints such as string length can still require application-side validation. Neither source establishes which constraint failed through HPOP in this session. This reliability patch changes retry prompts; earlier latency evaluation results remain historical and do not measure this recovery behavior.

Verification: 168 tests, type check, build, offline latency-tool checks, Chrome sidebar smoke, and the isolated worker/provider recovery check passed. The recovery check now requires validation feedback to reach the native provider request after an injected schema failure. All provider responses in these checks were synthetic; zero paid calls were made. Actual provider recovery is not yet measured. The active user session was not reloaded or stopped. Apply the rebuilt extension only after saving the recording normally.

## Reload/startup regression — 2026-10-25

A follow-up report showed all three Settings indicators ready, followed by the generic `Session could not start` warning. That warning was emitted after microphone, transcription preparation and AI configuration checks, when recorder START failed. It discarded the actual recorder error.

A regression test reproduced a concrete reload bug: configuring AI changed restored completed analysis back to `listening`; initialization then observed the old saved transcript, including speech left unprocessed after earlier note failures. This scheduled old-session AI work and could trip the recorder's `assistant.busy` guard when a new meeting started. This reproduction establishes the code defect, but the original generic warning did not preserve enough evidence to exclude other recorder failures in the user's attempt.

The patch tracks a closed assistant session, preserves it across configuration changes and ignores normal observations of its old transcript. A new session resets that state. Explicit durable-audio recovery may reopen the old session to process recovered speech. Offscreen initialization observes a saved transcript only when transcription actually has live or recovery work. Startup now preserves the recorder's underlying error in the warning instead of redirecting users to generic configuration advice.

Verified: 172 tests, type check, build, Chrome sidebar smoke and notes-retry smoke passed. `scripts/restored-startup-smoke.mjs` additionally loads an isolated Chrome extension with a synthetic saved memo and an unprocessed saved transcript segment, prepares the real packaged speech detector, initializes AI and verifies no AI/transcription busy conflict, no memo revision, and retained saved text. Its provider worker is blocked from network access. It does not start a real audio capture or prove the user's hardware-specific capture path; no paid calls were made. Report: `artifacts/restored-startup/result.json`.

## Support export for a stopped retrying session — 2026-10-25

A later report described repeated LLM retries from a new start, with the meeting already stopped. No new failure metadata has yet been obtained for that session. Its root cause remains unknown; do not assume the previous session's `schema_mismatch` or near-limit memo explains it.

The browser tool blocked access to the extension's internal URL. The user could not enter diagnostic Console commands. A user-facing alternative now lives in **Settings → Privacy & help → Download diagnostics**. An explicit click reads ASSISTANT_STATUS, builds a selected-field report, downloads JSON and shows a preview. It does not initiate a recording, transcription preparation, paid request, or automatic diagnostic logging. It excludes audio, transcript, memo text, questions, memory, goal, credentials, raw responses and exception messages. Existing safe validation metadata and numeric memo size are included. Reports are created only on request.

Builds now have a timestamp identifier compiled into the UI and saved alongside future failure records. Reports distinguish the UI's loaded build from the failure-producing build; failures from older builds are labelled unavailable rather than guessed. The build identifier also ships in `dist/build-info.json`. The extension's numeric release version remains unchanged for this local development patch.

Verified: type check, 174 tests, build, and the Settings browser smoke passed. The smoke downloads a synthetic report, checks privacy exclusions and build identity, and verifies the preview fits a narrow viewport. Actual stopped-session report and live diagnosis remain pending. No additional LLM-behavior change was made in this diagnostic-only pass.
