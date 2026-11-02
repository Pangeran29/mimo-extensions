# Scope review: merge speech windows already waiting for transcription

Date: 2026-10-26. Status: code inspection and proposed boundaries only. **No production change, rollout, paid request, or performance improvement is claimed.** The batch cap remains undecided. This review concerns ASR backlog, not the separate investigation into empty or invalid LLM notes.

## Objective

When a DeepInfra request finishes, allow the next sequential request to contain the oldest eligible speech windows that are already queued. The intended gain is less waiting behind repeated request overhead during a slowdown. Keep normal low-backlog dispatch prompt. Verify that no audio is lost, duplicated or reordered.

Do not wait to fill a batch. Do not add concurrent ASR calls. Audio capture and speech-window creation remain continuous and unchanged. Enable only if measured queue delay improves without an unacceptable accuracy or reliability trade-off.

## Current path and insertion point

`src/transcription/controller.ts`:

- `start()`, around lines 194–228: the segmenter emits an original window; it receives an ID, is durably saved and enters `this.windows`. Preserve this enqueue path.
- `pumpInference()`, around lines 335–350: the serial consumer currently selects only `this.windows[0]` and calls `client.transcribe(window.audio, window.sessionId)`. This is the insertion point for selection and assembly of an already-queued batch.
- Around lines 386–404: the response becomes one finalized transcript segment, the transcript and original pending job are committed together, and the in-memory head is removed. This must acknowledge every selected original job atomically for a batch.
- `liveProgress()`, around lines 58–74: queue reporting currently assumes one original window is in flight. Update that count to reflect the number of original windows represented by the active request. Keep audio-window readings about original VAD windows, rather than silently relabelling them as batches.

## Smallest proposed production change set

| File | Change | Boundary |
| --- | --- | --- |
| New `src/transcription/batch.ts` | Pure selection/assembly helper: choose a prefix of queued original jobs; return merged PCM, original job IDs, start/end samples and first-window overlap flag. | No storage, network, timers, UI, model calls or mutation of original PCM. Internal batch type stays here; existing AudioWindow/TranscriptSegment interfaces stay compatible. |
| `src/transcription/controller.ts` | Call helper at dispatch, submit one request, commit one result, acknowledge the selected prefix, adjust pending/in-flight counters. | Keep one active request, existing capture, retry/backoff, lifecycle and recovery rules. Maintain an internal baseline option for comparison/rollback. |
| `src/transcription/store.ts` | Add an atomic acknowledgement operation that writes the updated transcript and deletes all selected original pending IDs in one IndexedDB transaction. | Preserve original durable jobs, enqueue API and database version/schema. Do not persist a second merged audio copy. |
| `server/relay.mjs` | Align the maximum fixed-format WAV payload/duration with the selected bounded batch cap. | Keep model, credentials, auth, origins, host checks, WAV format, provider request shape, response validation and timeouts unchanged initially. |

### Files inspected that do not require a production edit

- `src/transcription/segmenter.ts`: preserve approximately eight-second windows, pause detection, preroll, minimum speech duration and one-second forced-split overlap.
- `src/transcription/client.ts`: already accepts a variable-length Float32Array. Preserve its public API, relay destination and 50-second timeout initially.
- `src/transcription/wav.ts`: already writes a variable-length float32 WAV. No re-encoding format change is required.
- `src/transcription/types.ts`: keep the finalized segment contract and original pending-job structure compatible.
- `src/engine.ts`: microphone/tab mixing, raw recording, audio encoders and download/saving remain outside the patch.
- `src/offscreen.ts`, `src/worker.ts`, `src/assistant/*`: do not change orchestration, startup, model/prompt, validation, notes policy, retry behavior or context budgets for this optimization.
- Sidebar/Settings: no new setting or redesign is needed for the initial experiment. Correct the existing queue counter inside the transcription controller.

## Batch eligibility and limits

A batch is a prefix of the pending queue, never a selection that jumps over an older job. Merge only jobs from the same session whose sample ranges touch or overlap. Initially stop at a real gap, invalid range or session boundary. Never concatenate distant excerpts while pretending their timestamps form continuous audio.

Use absolute `startSample`/`endSample` to remove shared PCM once. For example, three nominal eight-second windows at 0–8, 7–15 and 14–22 represent about 22 seconds of unique audio. Keep the first original window's overlap flag for duplicate-text handling against the previously delivered transcript. Internal overlaps have already been removed from audio and must not cause repeated spoken content.

Pick whole eligible windows that fit the cap; do not split/resegment an original window. If only one window is available or eligible, preserve its existing request behavior. Freeze the selected batch membership while its request is active. New arrivals remain behind it. Prefer a stable selected batch for retries; after a process restart it may be reconstructed from the unchanged original durable jobs, provided no job is acknowledged twice.

**The cap is a request-size limit, not an added collection timer.** Initial comparison candidates are 16 and 24 seconds of encoded unique audio; neither is established as the winner. Check the provider's current supported limits before live evaluation. Keep timeouts fixed for the first experiment; a timeout change is a separate decision supported by measured results.

The relay currently accepts at most 600,000 bytes. At 16,000 Hz, mono float32 with a 44-byte header, that corresponds to about 9.37 seconds. Sixteen seconds requires 1,024,044 bytes; 24 seconds requires 1,536,044 bytes. Increasing only the extension's batch duration would cause HTTP 413 rejections. Preserve a bounded relay limit and enforce the agreed WAV duration as well as size.

Do not repurpose `MAX_AUDIO` (30 seconds) in the controller as a batch limit: it bounds queued incoming frames. Preserve the existing 128 MiB queued-audio safety bound; account for the bounded transient merged PCM copy separately.

## Storage and lifecycle invariants

- Individual original windows remain durable until the full provider response has been accepted and the transcript plus all acknowledgements commit successfully.
- A request failure leaves all selected jobs pending. A storage failure must not advance the in-memory queue or deliver partial text.
- An empty successful transcription acknowledges all selected jobs and creates no artificial transcript text.
- Remove only the selected prefix after commit; windows that arrived during the request remain queued.
- Stop flushes the existing partial speech window and drains pending work under the existing lifecycle. Do not stop shared capture tracks from the transcription branch or change recording/finalization semantics.
- On teardown or restart, recovery reads original jobs in order; never leave a partially acknowledged batch.
- Continue producing monotonically ordered transcript segment IDs and correct sample-derived start/end times.

## Downstream effects that must be tested

No LLM code edit is required, but **its input timing and granularity change**. One merged request initially produces one transcript segment spanning the batch, not one segment per original window; the current provider response supplies no per-window alignment to reconstruct those boundaries reliably. This means fewer/larger transcript arrivals, coarser evidence timestamps and potentially a different cadence of LLM calls. The existing 90-second/context-size limits still apply.

Those effects are part of the acceptance criteria. Leaving a file untouched does not guarantee its behavior cannot be affected. Do not claim the optimization fixes empty LLM summaries or schema failures.

## Verification before enablement

1. Pure-helper checks: single-window equivalence, touching/overlapping windows, exact PCM deduplication, caps, gaps, sessions and input immutability.
2. Controller checks with a deliberately delayed ASR response: enqueue additional windows during the first call, verify one next bounded batch, no collection wait and no parallel calls. Cover arrivals during a request/retry, empty response, Stop and new-session isolation.
3. Persistence checks: all selected original IDs disappear together with the saved transcript, or all remain pending. Simulate failure/restart before acknowledgement and verify delivery once, in order.
4. Relay checks: a valid larger batch passes; oversize and malformed payloads fail; existing auth/origin/key-redaction/abort tests still pass.
5. Isolated Chrome integration: production capture → VAD → queue → relay → transcript → sidebar, with deterministic provider delay to verify batching mechanics. Synthetic downstream LLM responses establish interface compatibility only, not real LLM quality.
6. A bounded live DeepInfra comparison on the same continuous audio and verified reference, including overlap boundaries and corrections. Compare baseline, 16-second and 24-second caps using queue age, audio-to-transcript delay, request duration/count, transcript accuracy and failures. Spliced nonadjacent benchmark excerpts are not evidence of continuous-stream behavior.
7. Existing type checks, relevant tests and build; verify recording, saving, finalization, pending-audio recovery and notes evidence references. Do not claim live accuracy or latency improvements from offline tests.

The first implementation should stay internally switchable to the current one-window behavior until these checks pass. No production implementation was performed as part of this scope review.
