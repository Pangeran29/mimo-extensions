# End meeting · 0.13.3 candidate

The 0.13.3 reader removes the Sources control beneath each minutes bullet. Source IDs and exact quotations remain part of generation validation; the Transcript tab still opens the selected meeting's complete stored transcript. Discard now uses an inline confirmation with the selected meeting title/date, **Keep meeting** as the initial focus, and an explicit **Discard meeting** action. It does not depend on JavaScript confirm dialogs, which the automated Replay Lab browser dismisses without a dialog handler. Confirmation cancels when switching meeting, leaving the notes reader, starting a recording, or completing all three saves. Successful removal fences stale responses; a known meeting deleted from another window is cleared after an authoritative status query. Failed deletion leaves the reader and results available.

The final 0.13.3 project check passes 380 unit, 17 relay and five Node evaluation tests plus typecheck/build/offline checks. Its synthetic Chrome UI run passes 93 assertions with 13 captures, plus 11 unfinished-result follow-up assertions/two captures. Tests cover safe confirmation, single-session deletion, failure retention, stale responses, external deletion, cancellation and actual clipping-bound visibility of both choices in compact/embedded views. No provider requests or real-user jobs were used. After the user confirmed idle, only the beta Replay Lab was promoted and reopened as 0.13.3, with the same ready 214-segment session retained; the main/ordinary research builds and ledgers remain unchanged. See the [0.13.3 evidence record](../artifacts/mom-reader-2026-11-03/IMPLEMENTATION.md). These renderer tests use a fixed backend and do not establish a new native filesystem or real-model result.

Subsequent main activation: after fresh main-session idle confirmation, the exact normal 0.13.3 candidate was promoted to `dist` with its previous 0.12.1 files backed up. The main relay on 8787 was restarted and reports live protocols 1/2 and end-meeting protocol 1. A separate disposable normal-extension Chrome preflight passes 27 checks with no provider requests. The user subsequently confirmed the main extension displays 0.13.3 after manual Reload; this is user-reported runtime evidence, not automated inspection of the real profile. That profile was not read or changed by automation. Beta/research builds and ledgers remain unchanged by this main promotion. See [main activation evidence](../artifacts/main-0133-activation-2026-11-03/IMPLEMENTATION.md).

The 0.13.2 patch also corrects readable structured responses that fail source/quote validation. Actual 0.13.1 Replay Lab responses cited source IDs without matching quotes, used a quote with the wrong source ID during extraction, or changed a quoted phrase. These are rejected before semantic review; they must not appear in the sidebar or `mom.txt`. Each affected step gets at most one additional correction request with its original input, the rejected response and a specific validation code/path. The corrected response must pass the same validation, then the complete minutes must pass the existing reviewer. Transport retries and the separate single semantic revision remain bounded. This does not loosen exact-quote requirements or certify model accuracy. Opening the testing page alone still starts no inference.

Verification: 380 unit tests, 17 relay tests, five Node evaluation tests and the project checks pass. The separate fixed-response Chrome integration passes 54 assertions, including a source without a quote, held correction with no invalid output, complete review, sidebar display and matching `mom.txt`. All three preserved malformed real responses still fail validation with specific diagnostics. These checks made zero paid requests and did not change the installed builds or live profile. See the [0.13.2 evidence record](../artifacts/mom-validation-2026-11-03/IMPLEMENTATION.md); activation and an actual DeepInfra correction are separate runtime checks.

After the user's fresh idle confirmation, only the beta Replay Lab was promoted to 0.13.2 and reopened in the same profile. Runtime inspection confirmed version0.13.2, the same latest 94-segment failed session, and two saved-file acknowledgements. The testing relay remained healthy; main and ordinary research builds and historical ledgers were unchanged. No inference was started during activation. Retry meeting notes is still needed to obtain a real DeepInfra result; no successful corrected real MoM is claimed by the version check.

The 0.13.1 patch adds one bounded automatic revision when the minutes reviewer rejects a draft. The composer receives the rejected candidate, the rejection reason and the original evidence; the complete revised draft must pass source validation and every review batch before release. A second rejection stops processing with a retry state. Rejection feedback is checkpointed for explicit retry. Existing 0.13.0 Replay Lab failures can recover feedback from that run's diagnostic events only when the final transcript hash matches and the candidate's sources validate; retry reuses the saved transcript and extraction checkpoints rather than replaying audio.

This addresses a real 0.13.0 test in which the reviewer caught a server-ownership claim reversed against its source. Audio and transcript had saved correctly; withholding the inaccurate MoM was correct, but the original flow stopped without trying a source-grounded revision. See the local [diagnosis](../artifacts/mom-recovery-2026-11-02/diagnosis.json). No rejected draft is presented as accepted minutes.

The patch passes 369 unit tests, 17 relay tests, five Node evaluation tests and offline checks; a separate Chrome run passes 45 assertions, including an incorrect deadline rejected, repaired against feedback, rechecked, displayed and exported. Its provider responses are fixed local fixtures, not a real-model quality certification. Legacy rejection recovery was also checked offline against the actual saved 215-segment session without a provider call. With the user's idle/reopen authorization, only the beta Replay Lab was updated to 0.13.1; runtime inspection confirmed the same failed session and its two saved-file acknowledgements remain. Use **Retry meeting notes** on that result; replaying its audio is unnecessary. The real provider's corrected result still needs user review.

The original 0.13.0 candidate adds a post-meeting reader and a three-file meeting bundle. It supersedes the earlier rule that Stop only retained live understanding. Its preserved builds are under `artifacts/end-meeting-2026-11-02/build` and `artifacts/end-meeting-2026-11-02/replay-build`; a separate 0.13.0 beta was opened with its own testing relay. The 0.13.1 repair candidates are under `artifacts/mom-recovery-2026-11-02/`. Main-extension promotion remains separate. See the [original implementation and evidence record](../artifacts/end-meeting-2026-11-02/IMPLEMENTATION.md).

## Stop and read the result

1. Press Stop in Live memo or **Stop & save** in the popup. The click dispatches Stop before opening Chrome's folder picker, in the same user gesture. Ending capture does not wait for folder selection or notes generation.
2. Choose the parent folder for this meeting's files, or cancel. Cancellation retains the local session and leaves **Choose folder** available; it does not discard audio.
3. Mimo finishes the final speech window and waits for a complete, ordered transcript. The reader says when transcription is still recovering. Incomplete transcripts do not produce final minutes.
4. The separate end-meeting pipeline prepares concise factual bullets from the whole captured conversation, in its dominant language. **Meeting notes** replaces the live reading content. **Transcript** opens that result's own timestamped transcript; use the stable bottom navigation to return to Meeting notes.
5. The save area reports Audio, Transcript, and Meeting notes separately. Audio and a complete transcript can save before the notes finish. All three must report saved before the local audio is released.

The ordinary live proposal/reviewer chain stops publishing at Stop. Its accepted understanding and contributions remain separate saved state; they are not the input used as a substitute for the full transcript. New recording, session selection, and late old-session updates are fenced so an earlier result cannot replace a live session.

## The three files

Each chosen parent receives a new `Mimo-YYYY-MM-DD-HHMMSS-<session-prefix>` subfolder. The timestamp uses local time. Existing names receive a numeric suffix; another session's files are not deliberately reused. Retrying the same granted folder resumes its persisted bundle directory.

| File | Contents |
| --- | --- |
| `audio-YYYY-MM-DD-HHMMSS-<session-prefix>.webm` | The combined tab and microphone stream, encoded as WebM/Opus. Replay exports the stream actually played. |
| `transcript.txt` | The complete transcript with recording-relative `[HH:MM:SS–HH:MM:SS]` passage ranges. These are audio-window ranges, not word alignment or speaker labels. |
| `mom.txt` | Plain text bullet minutes, or an explicit no-conversation/no-substantive-content result. |

New meeting bundles export one combined audio file, not three separate audio downloads. The capture engine still encodes and temporarily stores its existing combined, microphone and tab streams; only combined audio is in the new bundle. Older retained recordings keep their legacy download/recovery path.

Writes use File System Access handles stored in extension IndexedDB. Blob data streams to the writer without converting the whole recording to base64 or one ArrayBuffer. This does not establish constant browser memory during Blob assembly or export. Files already saved are skipped on retry. Permission loss, full destination, and other write failures keep the remaining work local and expose **Choose folder** or **Retry saving**. Choosing another folder before audio cleanup starts a fresh bundle there; it can leave previously written files in the earlier folder. Discard removes retained local data and does not remove files already written to disk.

## How the minutes are checked

`src/end-meeting/mom.ts` is independent of live-v2 memory. A short transcript is composed directly; a long one is split into bounded chronological parts, extracted into evidence-linked facts, and reduced when needed. Extraction coverage, intermediate ledgers, draft, review progress, and a SHA-256 transcript identity are checkpointed. A changed final transcript invalidates the old draft and associated text-export completion.

The prompts distinguish proposals from explicit decisions, preserve corrections and unresolved issues, and forbid invented owners, deadlines, dates, recommendations, and general knowledge. Each claimed source ID must exist and have a matching exact quote. Duplicate normalized bullet text is rejected. A separate reviewer checks support, importance, dominant language, decisions/actions, corrections, and omissions before release. Batched review includes the complete compact bullet inventory for global checks and marks which bullets receive factual evidence in that batch, so omitted evidence for other batches is not treated as an omitted meeting point. Empty transcripts return an explicit empty result without a model request.

These checks establish structure, coverage and quote matching. They do not prove semantic truth, complete topic coverage, correct ASR wording, or the quality of a real provider result. Dominant language is requested and reviewed by the model rather than certified by a separate language detector. Important names, numbers, decisions and actions still require review against the audio.

The selected session provider/model/objective are retained with the job; credentials are not. HPOP uses its existing connection, including the native Claude forced-tool transport. Managed DeepInfra uses the loopback relay and checks `notes.supportedEndMeetingProtocols` for protocol `1` before inference. An older relay gives an actionable update error. The relay must be updated while sessions are idle before a real managed-provider MoM test. This work does not authorize restarting a relay during a recording.

Requests have a 65-second client bound and bounded transport retries with Retry-After/backoff. Explicit retry resumes valid checkpoints rather than assuming a failed stage completed. Opening or restoring the reader alone starts neither model requests nor destination writes. An interrupted notes request or file write becomes an explicit retry state. ASR keeps its existing durable outbox and recovery policy.

## Local retention

The production store (`mimo-end-meeting-v1`) retains the latest fully completed reader plus unfinished jobs. A job is eligible for completed-history pruning only after notes reach ready/empty, every file is saved, and audio cleanup succeeds. If all three files are confirmed saved but local audio deletion fails, the reader keeps an explicit cleanup message and Retry saving. Restore can retry that local database cleanup within a bounded attempt count without a provider request or filesystem write; an explicit cleanup retry does not require renewed folder permission. **Other unsaved meetings** lists other local sessions with any unsaved file or pending cleanup, including failed MoM jobs. Selecting a row reads its stored result and save status; it does not play audio or call AI. MoM appears only if already available. Discard affects only the selected meeting: it removes its retained recording and end-meeting result/destination records after explicit inline confirmation. Files already exported to the chosen folder stay there. Replay Lab's separate diagnostic run archive and imported source remain separate. This is local recovery, not a durable cloud archive; clearing extension/profile data removes it. The latest transcript and live assistant storage retain their existing separate behavior.

Replay Lab archives its run evidence separately. Its earlier runs are not governed by production's latest-completed-reader pruning.

## Replay Lab

Natural EOF and manual Stop enter the same end-meeting controller. Both stop live publication and flush the final speech window; EOF no longer waits to publish a final live memo. The lab records the played Web Audio stream with a separate native MediaRecorder. Manual Stop exports only the played prefix and marks the run partial; EOF exports the played recording. Source errors and interrupted runs retain explicit partial evidence.

Run finalization waits for transcription and end-meeting processing to settle, and the run stores its final end-meeting snapshot. A terminal failed/incomplete transcript can settle as partial evidence; it is not treated as a complete transcript suitable for minutes. Repeat uses a fresh session and does not turn older end results back into live context. Folder choice is separate from research run completion: an unsaved result can remain pending after the run settles.

Open only the isolated candidate when reviewing this feature:

```sh
LISTEN_REPLAY_BUILD_DIR=artifacts/end-meeting-2026-11-02/replay-build \
LISTEN_REPLAY_PROFILE_DIR=.local/end-meeting-beta-profile \
pnpm replay:lab --no-build
```

Opening the launcher does not autoplay or start provider inference. Explicit Start on speech uses the configured ASR/AI services. See [Replay Lab](REPLAY-LAB.md) for the ordinary research workflow and evidence boundaries.

## Native picker check still required

The user subsequently confirmed native selection of `/Users/Apple/Downloads/MimoExports`, and the resulting combined audio and transcript were observed on disk. MoM was absent because of the review rejection described above. This confirms that native destination for that Replay Lab session; popup/sidebar chooser completion and permission restoration after restart still need their own checks. Chrome deliberately blocks selecting the entire Downloads folder while allowing dedicated child folders.

The saved Chrome context probe establishes that both extension-page and localhost trusted clicks can invoke a pending native picker. It does not establish a selected OS folder, write consent, native popup/sidebar completion, or restored permission after restart. The deterministic export integration substitutes OPFS for selection: its handle and writer are real browser File System Access objects, but it is not native OS picker proof. See [File System Access evidence boundaries](../artifacts/end-meeting-2026-11-02/FSA-EVIDENCE.md).

Use a disposable candidate profile and a locally prepared silent audio file for a manual check without paid ASR/AI inference. Keep the existing profiles and any active recording untouched.

1. Open the isolated candidate Replay Lab above, choose the silent file, and start it. Silence should yield no speech windows or live model work. At EOF the empty result requires no MoM request.
2. Use **Choose folder**, select a new temporary OS folder, and grant Chrome's write consent if shown. Confirm a unique session subfolder contains exactly the combined WebM, `transcript.txt`, and `mom.txt`; play the WebM and inspect the text files.
3. In another silent run, press Stop before EOF. Cancel the native picker and confirm playback has stopped, the result remains available, and Choose folder can complete later. Check focus after the dialog closes and that Tab reaches a visible control.
4. Repeat the picker check through the actual assistant Stop and popup Stop/save in an isolated normal-build test profile with a controlled silent capture fixture. Use a local stub relay or enforce blocked external inference when exercising physical capture, since microphone noise can create speech windows.
5. Restart only the disposable browser. Inspect the retained result without automatic requests/writes. If Chrome has revoked access, choose the same folder again and confirm the original bundle resumes without an extra session folder. A read-only destination or full disk must retain failed files with a retry action.

Those manual results should be saved separately from the automated OPFS result. No full live-provider MoM quality, real-meeting language/decision accuracy, or activation claim follows from silent or fixed-response validation.
