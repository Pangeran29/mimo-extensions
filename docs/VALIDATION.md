# Compact settings controls and required states — 17 October 2026

Version 0.7.2 applies the assistant's compact Helvetica Neue / Arial typography to Settings: 13 px main text and at least 12 px supporting copy. A short instruction clarifies that microphone, transcription, and AI setup are all needed. The microphone action is a 44 px SVG icon button with dynamic accessible name, tooltip, busy state, and current permission label. Download, save, and secondary actions use compact content-width controls instead of full-width blocks.

Missing setup uses amber with text labels; ready states use green; validation errors retain red text and field treatment. Missing key/model fields carry Required labels and an amber background, clearing as users enter values. AI setup opens when incomplete; saved ready settings can stay collapsed. The microphone-only “Ready to listen” footer claim was replaced by neutral session instructions. Settings behavior, session-only credential storage, health checks, and provider requests remain unchanged.

`pnpm check`: 93 tests, typecheck, and build pass. Browser Settings checks cover required highlights and labels, accessible microphone icon before/after checking, filled-field highlight removal, permission refusal, model retry, saving and key removal, 272/340/1100 px layouts, and 200% zoom. Actual Chrome panel navigation/save/session-health-warning checks passed. The Impeccable scan caught undersized secondary text; those values were raised to 12 px. Required text contrast is 6.19:1, ready text 6.09:1, and muted text 5.53:1 on their respective backgrounds. Normal field borders were strengthened to 3.30:1 against white. A checkbox outline causing 3 px overflow was moved inside its control. Screenshots and reports remain in `artifacts/settings-*.png` and `settings-smoke.json`. No real microphone, model download, or authenticated AI call was performed for this refinement.

# Compact assistant typography — 17 October 2026

Version 0.7.1 renames the first tab Meeting assistant, removes Session details entirely, and renders transcript passages as inline `[mm:ss] text` rows. The sidebar uses a compact Helvetica Neue / Arial system font stack with regular-weight 13 px body text and a 17 px follow-up question. Smaller section gaps and lighter headings reduce density pressure without changing capture, transcription, or analysis behavior. This dense desktop text size follows the user's explicit preference and remains browser-zoomable.

`pnpm check`: 93 tests, typecheck, and build pass. Browser UI fixture checks also verify inline timestamp/text alignment, compact font size, renamed tab, absent session-details UI, existing live-tab updates, transcript scrolling, feedback, source navigation, 272/340/1000 px layouts, and 200% zoom. Native side-panel Settings/navigation and unhealthy-session warning integration passed. Impeccable scan: no findings. Screenshots and reports remain under `artifacts/assistant-*.png` and `assistant-ui-smoke.json`.

Chrome's supported Side Panel API has no width setter, so the extension cannot impose a 70:30 website/sidebar ratio. The user can resize Chrome's panel using the divider; the UI adapts to the available width. Reference: https://developer.chrome.com/docs/extensions/reference/api/sidePanel . No overlay, additional permissions, browser-window resizing, or page injection was introduced to imitate this split.

# Analysis and Transcript views — 17 October 2026

Version 0.7.0 gives the existing assistant sidebar two accessible tabs: Analysis (default) and Transcript. Follow-up questions lead, followed by meeting notes, established decisions and open points. Reasons/evidence and session diagnostics are collapsed. Source context can open the relevant timestamped transcript passage. Quiet persistent controls keep session status and Stop & Save available. Settings remains in the same docked frame.

Transcript consumes the existing finalized local-ASR snapshots and events; no audio, model, scheduling, or provider behavior changed. The timestamped feed updates while hidden, follows new text when the reader is at the bottom, preserves their place while reading older text, and provides Jump to latest. Tabs support arrow keys, Home/End, focus, selection state, and labelled panels. The UI uses textContent for all generated text and guards against initial status responses overwriting newer live updates.

**93 automated tests, typecheck, and build passed.** Browser UI fixture checks (`scripts/assistant-ui-smoke.mjs`, report `artifacts/assistant-ui-smoke.json`) verified default Analysis, keyboard tabs, concurrent hidden-view updates, timestamps, scroll preservation, Jump to latest, evidence navigation, feedback, deeper results, Stop, 272/340/1000 px layouts and 200% zoom. Screenshots: `assistant-analysis.png`, `assistant-transcript.png`, `assistant-narrow.png`, `assistant-wide.png`, `assistant-empty.png`, `assistant-zoom.png`. The zoom check exposed a footer-control overflow; controls now wrap intrinsically. Impeccable scan reported no findings. Native Chrome side-panel integration also passed Settings/navigation and readiness-warning checks. Results/screenshots use explicitly synthetic meeting fixtures; a real meeting, microphone, model, or paid provider call was not run for this presentation change.

# Session readiness gate — 17 October 2026

Version 0.6.2 requires microphone, prepared/enabled local transcription, and enabled/configured AI before starting each new session. The worker rejects incomplete settings before capture, checks actual microphone permission and hardware with immediate track release, warms and verifies the live speech model before obtaining a short-lived tab token, and requires AI initialization. AI preferences/credentials are rechecked after model loading to catch changes during preparation. A failed start cannot silently downgrade to audio-only capture. Settings receives a per-window session warning and the panel navigates there; the warning clears after a successful preflight. The popup still opens the panel in the original user gesture.

**93 automated tests, typecheck, and build pass.** New coverage includes missing microphone/model/AI setup, missing session key, unsupported model, revoked HPOP permission, hardware loss, failed model preparation, settings changed during model loading, existing-session busy handling, successful check order, and microphone-track release. The actual Chrome 155 panel integration confirmed that missing setup refuses recording, navigates an open assistant to Settings, and displays the warning. Settings layout/form regression passed too. Reports remain `artifacts/assistant-panel-smoke.json` and `artifacts/settings-smoke.json`.

AI readiness checks configuration only: no paid request or transcript is sent, and invalid credentials/provider outages can still surface on the first actual analysis. Full successful preflight is covered with mocks; physical microphone/model/AI integration was not rerun for this change. Older audio-only browser harnesses need complete model/AI setup to pass the new worker start gate. Runtime recognition/API failures after a successful start continue to preserve audio recording.

# Quieter settings — 17 October 2026

Version 0.6.1 reduces the default sidebar to Microphone, Local transcription, a collapsed AI assistant row, and one Help & privacy disclosure. Repeated headings, intros, success explanations, technical requirements, and the duplicate sidebar navigation block were removed or consolidated. The model download uses a quiet outline; microphone setup remains the primary first-use action. Optional meeting objective is collapsed until needed and opens when an objective is saved. AI data-sharing consent remains visible beside the opt-in. No capabilities were removed.

`pnpm check` passed: 78 tests, typecheck, and build. The updated settings smoke passed permission/error/retry, form validation and save behavior, 272/340/1100 px layouts, and 200% zoom. The native Chrome side-panel settings save/navigation check also passed. Updated screenshots and reports remain in `artifacts/settings-*.png`, `settings-smoke.json`, and `assistant-panel-smoke.json`. Impeccable scan: no findings. No physical microphone, real model download, or authenticated AI call was repeated for this refinement.

# Sidebar settings and onboarding — 17 October 2026

Version 0.6.0 simplifies the existing settings surface for narrow Chrome side panels and the first-install tab. Microphone and model setup are prominent actions with independent state. Completed setup actions become secondary. Optional AI configuration is progressively disclosed; privacy, model/device requirements, and permission help remain accessible. No recording, ASR, or AI-provider behavior changes.

Added inline key/model validation, key show/hide, input preservation on save failure, duplicate-submit prevention, retryable settings loading and model preparation, objective count, and current microphone permission checks. A saved AI preference without a session key shows “Key needed”. Chrome clears session storage on extension reload/update/disable or browser restart; the UI now explains this accurately. Other settings remain in local storage.

**78 automated tests, typecheck, and build pass.** The settings browser check (`scripts/settings-smoke.mjs`, report `artifacts/settings-smoke.json`) uses mocked APIs to verify permission denial/success and immediate microphone release, model preparation/retry, field errors, key visibility, HPOP permission refusal, failed-save input preservation, duplicate submit blocking, saving, and removing a key. Layouts at 272 px (content width inside a narrow panel), 340 px, 1100 px, and 200% zoom passed without horizontal overflow. Screenshots: `settings-narrow.png`, `settings-install.png`, `settings-ai-error.png`, `settings-ready.png`, `settings-zoom.png`. The Impeccable mechanical scan reported no findings. Visual verification used one batched inspection and one confirmation after the adjustment batch.

The actual Chrome 155 side-panel integration passed: setup opens Assistant, Settings stays docked, preferences save through the real extension worker, Back to Assistant works, the popup reuses the same panel, and interacting with website tabs preserves it. Report: `artifacts/assistant-panel-smoke.json`. Its entry point was updated because the compact idle popup intentionally hides Open Assistant. These checks do not download the 206 MB model, use a real API key, or request physical microphone access. Native microphone permission prompts, real model downloads, and natural-meeting usefulness were not revalidated in this UI change.

# Intentional save cancellation — 16 October 2026

Version 0.5.1 treats Chrome's `USER_CANCELED` interruption and the explicit `Download canceled` file-picker rejection as an intentional choice. It deletes that session's temporary audio, revokes its export URL, skips remaining separate exports, and returns to idle without a recovery warning. Already saved files and the separate transcript are preserved. Unknown interruption reasons and genuine download errors still retain audio for retry/discard. Existing retained recordings are not deleted without new cancellation evidence or Discard.

`pnpm check`: **78 tests pass**, typecheck and build pass. Added coverage for cancellation before a download ID, missing error fields in state deltas, worker restart reconciliation, URL cleanup, cancellation after saving the mix, repeated cancellation, and starting another recording. Native isolated Chrome 155 integration verified a real `USER_CANCELED` download (CDP download denial), clean idle/no badge/no retained session, and no further exports. A separate run injected `FILE_ACCESS_DENIED`, retried successfully, decoded all three source-separated exports, and verified playback. Reports: `artifacts/download-cancel-smoke.json` and `artifacts/browser-smoke.json`. Manually dismissing the macOS file picker remains unverified; its promise rejection is covered by mocks. The synthetic checks do not use the user's microphone or personal tabs.

Run cancellation integration with `LISTEN_CANCEL_SMOKE=1` using `scripts/browser-smoke.mjs`; normal mode checks failure/retry. Chrome's CDP download denial is classified as cancellation, so normal mode now injects a filesystem failure instead.

# Compact popup — 16 October 2026

Version 0.5.0 refines only the toolbar popup: a 304 px view with one circular Listen control, short source context, Settings, and conditional recording/recovery actions. Captions, Copy, audio meters, and format details are removed from this surface. Transcription remains local and continues feeding AI; a sidebar transcript presentation is deferred to the next UI task.

Listen sends START to the worker and calls Chrome’s side-panel API within the same original click gesture. It does not wait for model loading before requesting the panel, and the worker owns capture if the popup closes. Startup failures are relayed to the assistant. Settled ASR/AI status is broadcast so a reopened popup can re-enable the control without polling transcript text.

**61 tests, typecheck, and build pass.** Native Chrome 155 checks verified automatic panel opening, popup closure/tab switching, three decoded audio exports with spectral source separation, and download denial/retry. The popup has idle, recording, setup, disabled, saving, error, recovery, keyboard-focus, and reduced-motion treatments. Normal-width/zoom layout checks are recorded in `artifacts/popup-layout-check.json`; visual snapshots are `popup-idle.png`, `recording-popup.png`, `popup-recovery.png`, `popup-setup.png`, and `popup-zoom.png`. The Impeccable detector flagged a colored shadow; the final button uses a flat fill and fine outline instead.

# Docked settings — 16 October 2026

Version 0.4.2 opens Settings inside the existing assistant side panel, with a Back to Assistant control. Both the popup Settings button and assistant header use this flow. Microphone setup also routes there. The form reuses `setup.html` in a same-origin frame, with a compact panel layout; recording/AI ownership remains in the offscreen document.

`pnpm check`: **61 tests pass**, typecheck and build pass. The Chrome 155 panel smoke test opened settings, saved a synthetic meeting objective, returned to Assistant, opened Settings from the popup in the same panel document, and interacted with the website without dismissing the panel. No API key or microphone was used. A settings iframe adds its own extension frame context; the check counts top-level assistant panel documents rather than treating iframe contexts as extra panels. Real microphone permission prompts inside the docked form remain unverified.

# Assistant side panel — 16 October 2026

Version 0.4.1 replaces the floating assistant window with Chrome's global side panel in the browser window where Open Assistant was clicked. The popup calls `chrome.sidePanel.open` directly inside the button gesture; no asynchronous worker round trip is needed to preserve user activation. The panel reuses the existing assistant view and state subscriptions. The new permission is `sidePanel`; the minimum Chrome version remains 116.

`pnpm check`: **61 tests pass**, TypeScript passes, unpacked build succeeds. An isolated Chrome 155 browser check clicked the actual Open Assistant button and confirmed exactly one `SIDE_PANEL` context, no floating popup window, and the same panel document surviving typing on the source page and switching tabs. This UI check used no API key, microphone, or meeting data. Report: `artifacts/assistant-panel-smoke.json`; reproduce with Playwright via `node scripts/assistant-panel-smoke.mjs`.

The assistant remains a companion to the current recording. Switching tabs does not move the audio capture source. Closing the side panel leaves the offscreen recorder and AI lifecycle unchanged. Prior Layer 3 model-quality and latency limitations below still apply.

# Validation — 15 October 2026

Layer 3 results, model latency gates, AI failure checks, and remaining human checks are in [ASSISTANT-VALIDATION.md](ASSISTANT-VALIDATION.md). Earlier measurements below describe their original versions.

## Local transcription update (version 0.3)

Validated on the Apple M5 Mac (16 GB), Google Chrome **155.0.8059.79**.

- Strict typecheck, reproducible build, and **32 automated tests passed**. New coverage includes bounded silence/speech windows, overlap with transferred/detached buffers, final-speech flushing, ordered queued recognition, the 30-second PCM bound and inference deadline, stale-result rejection, model worker errors, and independent transcript retention.
- The original audio integration check passed again: actual tab capture plus synthetic microphone, three isolated outputs, download-denial/retry, decoding, and temporary-audio cleanup.
- Model gate passed for attributed Indonesian and English FLEURS clips, plus a concatenated language-switch fixture. Cached preparation was about **1.4 seconds** in the final gate; an earlier cold download/preparation took about **124 seconds**. Recognition per window was roughly **0.37–0.55 seconds** in that gate, with three encoders active. These are machine-specific observations, not latency guarantees.
- The production integration passed with external connections blocked during cached preparation. Speech fed through a synthetic microphone appeared before tab playback began; later tab speech produced text in both languages. All three files decoded, completed text survived audio deletion and popup reopening, and the offscreen document closed after saving and inference settled.
- A forced recognition-worker exception retained completed text and marked transcription incomplete while audio continued. Stop still saved all three files, and final cleanup completed. Report: `artifacts/transcription-failure.json`.
- A 32-second continuous-speech stress check exercised repeated eight-second windows with one-second overlap through actual transferable buffers. Observed window starts/ends included **0–8000**, **7000–15008**, **14008–22016** ms. Capture, finishing, export, and offscreen cleanup passed. This exposed and fixed a detached-buffer ordering defect; the regression test transfers the actual buffer before the segmenter continues. The artificially trimmed/repeated speech produced some decoder repetition/garbled wording, so this is a lifecycle pass, **not an accuracy pass**. Report: `artifacts/transcription-continuous.json`.

### Twenty-minute sustained run

Real-time duration: **1200 seconds**, looping public Indonesian/English speech through native tab capture, a silent synthetic microphone, all three encoders active, and local recognition. Completed **183 text segments**, with **no reported browser errors**.

| Measurement | Observed result |
| --- | --- |
| Pending PCM, maximum sampled | **7.744 seconds**, below the 30-second bound |
| Inference duration, sampled min / median / max | **413 / 495 / 853 ms** |
| Aggregate isolated-browser RSS, sampled range | **592–1739 MiB**; first 1739 MiB, final 892 MiB |
| Offscreen JS heap, sampled range | **4.45–10.72 MiB**; excludes the model worker |
| Aggregate process CPU time / wall time | About **22.5% of one CPU core** between first and last samples |
| Combined / microphone / tab file size | **14,475,284 / 300,103 / 14,504,487 bytes**; silent mic compresses heavily |
| Decoded duration | **1200.06 / 1200.06 / 1200.12 seconds** |
| Decoded channel count | **1 / 2 / 2** |

The whole exported files decoded in Chrome. Temporary audio cleaned up and completed text remained available. Reports: `artifacts/transcription-soak.json` and `.log`. Sampling occurred every ten seconds; these are observed samples, not guaranteed peaks. Aggregate RSS can double-count shared memory and does not isolate GPU allocations. Export's separate peak memory was **not measured**. Full-file decoding verifies decodability/duration, not listening quality or every-sample continuity.

The sustained run used the compiled snapshot retained in `artifacts/transcription-soak-build`. Final notification/error-handling changes and the forced-split buffer correction were subsequently checked with focused tests and the short actual-Chrome integrations above; the full 20-minute run was not repeated after those changes. The sustained fixture had natural pauses and did not validate the continuous-speech split path by itself.

### Remaining transcription checks

- Natural Indonesian/English code switching, real microphone quality, simultaneous participants, headphones/speakers, names/numbers, and perceived end-to-end latency in an actual meeting remain **unverified**.
- Original quiet English fixture RMS was about **0.0037** before mixing. Whisper recognized it when directly supplied PCM, but VAD could reject it through capture. The integration language-switch fixture peak-normalizes each clip to 0.5; production audio is unchanged. Very quiet speech may be omitted.
- Whisper base produces draft text with recognition errors. The constructed language-switch fixture is not evidence of Feishu-equivalent meeting quality. Repeated or abruptly cut speech can produce repetitive output; generation is bounded to 128 new tokens per window.
- WebGPU-unavailable failure paths are covered by mocks and actionable UI handling, not a separate physical GPU/device test. Chrome 116, other hardware, cache eviction, actual browser restart during transcription, and physical toolbar-popup behavior still need manual verification.
- First-use microphone permission, real meeting checks, worker suspension, and the original two-hour recorder soak below remain outstanding. Copy's clipboard behavior needs a manual check; browser tests avoid overwriting the user's clipboard.

See [transcription architecture and reproduction](TRANSCRIPTION.md). Public fixtures are attributed in `artifacts/speech/manifest.json`; no personal audio was used.

## Separate-output update (version 0.2)

- Strict typecheck, build, and **16 automated tests passed**, including per-source isolation, partial download success, retry after microphone-file failure, and recovery that skips already saved files.
- Re-ran the isolated Chrome integration test with native tab capture and a synthetic microphone. All three files downloaded, decoded, and measured **4.80 seconds** in this run.
- Combined: mono; 440 Hz tab amplitude **0.1000**, 880 Hz microphone amplitude **0.1001**.
- Microphone-only: 880 Hz amplitude **0.1997**; tab-frequency amplitude below **0.000002**.
- Tab-only: 440 Hz amplitude **0.1995**; microphone-frequency amplitude below **0.000010**.
- Verified denied-download retention, retry, all-three-file cleanup, and continued capture after closing the control page/switching tabs. The separate streams preserve source channel layout (stereo in this synthetic test).
- Real microphones may acoustically pick up speaker playback; these measurements demonstrate source routing isolation, not guaranteed acoustic isolation. Real-device and long-session limitations below still apply. Three encoders increase resource usage; no new CPU/memory benchmark is claimed.

## Original MVP checks (version 0.1)

- TypeScript strict typecheck and esbuild unpacked extension build: passed.
- 14 automated tests: passed. They cover ordered/atomic chunk storage, duplicate chunk rollback, session deletion isolation, the 16 MiB queue bound, storage write failures, duplicate starts/stops, final-chunk ordering, source disconnection, startup failure cleanup, recovery, and download cleanup/retry.
- Real browser integration in an isolated profile on this Mac: passed on installed Google Chrome **155.0.8059.79**.
- Actual `chrome.tabCapture` captured a local webpage playing a generated 440 Hz tone. The microphone acquisition was replaced in the test harness with a generated 880 Hz MediaStream; the production extension was unchanged.
- The native Web Audio graph, MediaRecorder encoder, IndexedDB storage, extension messages, Chrome downloads API, and downloaded-file decoding were exercised.
- Both live source meters reported receiving audio.
- Recording survived closing its control page and switching to another tab.
- A deliberately denied download retained the committed audio; retry downloaded it, and successful completion removed the temporary recording.
- Exported WebM played in Chrome. Decoded output: mono, about **4.68 seconds**, **56,853 bytes**; amplitudes near 0.1000 at both 440 Hz and 880 Hz, with approximately 0.000023 at the unrelated 660 Hz control frequency. This verifies both sources were present, not merely that a nonempty file existed.
- No browser page errors were observed during the successful integration test.

The headless integration harness renders the popup UI as an extension tab because Chrome does not expose an action-popup target there. It invokes the extension action through CDP to grant real tab access. It does not establish the physical toolbar popup's dismissal behavior; the recording engine is independent of that UI lifetime.

## Not yet verified with a human

These checks require real devices, meeting participants, or a sustained session. They are **not claimed complete**:

| Scenario | Procedure and expected result |
| --- | --- |
| First-use permission | Load `dist`, allow microphone on setup, and verify the microphone indicator stops after the test. Deny permission once and check the recovery instructions. |
| YouTube + voice | Play an ordinary video, press Listen, speak a recognizable sentence, stop, and listen to the downloaded file. Both sources should be intelligible. |
| Browser meeting | Record a meeting with another participant. Confirm their voice and your own voice appear. |
| Physical popup | Close/reopen the toolbar popup, switch tabs, and confirm the timer/source remain correct. |
| Headphones/speakers | Compare headphones with speakers. Confirm normal tab playback, no microphone monitoring/feedback, and assess echo. Browser echo cancellation is requested, not guaranteed. |
| Silence/overlap | Record a silent tab, quiet microphone, and overlapping speech. Silence must not trigger false failure. |
| Device loss | Disconnect the microphone or close the captured tab. Capture should stop, release remaining devices, and attempt to save a partial recording. |
| Worker suspension | Use `chrome://extensions` to inspect the service worker, close DevTools so it can suspend, then reopen the popup after a minute. Audio should continue; Stop must work. |
| Restart recovery | While recording, close Chrome, reopen it, and check retained audio appears with an interrupted warning. Retry Save should export committed chunks; the tail may be missing or unplayable. |
| Long-session soak | Record for two hours with normal browsing. Observe Chrome Task Manager CPU/memory at 0, 15, 30, 60, 90, and 120 minutes. Measure export's separate peak memory, file size, full playback, continuity, and release of capture indicators. |
| Oldest supported browser / Windows | Manifest compatibility targets Chrome 116+, but live validation has only used the installed Mac Chrome version. |

No two-hour recorder soak, real microphone quality assessment, or live meeting test has been completed. The version 0.3 synthetic measurements above do not replace those checks.

## Reproduce automated checks

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

An optional integration harness is included in `scripts/browser-smoke.mjs`. It requires a separately available Playwright installation and Chrome 155+ supporting CDP `Extensions.triggerAction`. It creates and removes its own browser profile; generated audio and a JSON report remain in `artifacts/`.

```sh
# Point to an existing Playwright package, or install Playwright separately.
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/browser-smoke.mjs
```

Override the browser with `LISTEN_CHROME_PATH`; set `LISTEN_HEADED=1` to show the isolated test window. The test uses no real microphone. Synthetic tab sound may be audible. It does not change your normal browser profile. Build `dist` first.

The browser harness deliberately removes Playwright's `--mute-audio` default, which otherwise makes native captured tab audio silent. It does not use Chrome's fake-media-device flags, which can replace the tab audio source and give misleading results.


## Reload persistence · 2026-10-19

130 tests, typecheck and build passed for automatic restoration and persistent AI credentials. Coverage includes trusted-local key storage, a session-storage reset, legacy migration, removal of both stores, one shared actual-model preparation request, no initial download on a fresh install, failed restoration without a polling retry loop, and active recording/transcription guards. Existing mocked Settings and Assistant browser flows passed. `scripts/extension-reload-smoke.mjs` loads the same unpacked directory twice through Chrome's actual extension loader and verifies the extension ID stays the same, session storage clears, the synthetic saved key/objective persist without appearing in settings responses, and Remove key deletes local/session copies. No real key, paid provider request, model download or GPU inference was used by this reload check. Real model restoration is covered by controller/worker tests here; earlier real ASR validations remain separate. See `artifacts/extension-reload-smoke.json`.

This current behavior supersedes the dated session-only key notes above. Persistence requires retaining the same extension identity/profile; removing/reinstalling it or loading a different extension ID has separate storage. Browser-managed model cache may be evicted, requiring a download again.


## Living-memo timeout correction · 2026-10-20

A reported first-success/next-update failure exposed stale eight-second AI deadlines after the move to complete 2,400-character memos. All automatic request layers now share a 30-second limit; client worker replies have 250 ms grace. Final AI processing after transcription also has a bounded 30-second budget. One automatic request and coalesced pending passages remain, with three consecutive attempts and existing backoff/Retry-After handling. SDK timeout/abort exceptions are checked before their APIError superclass; HTTP 5xx failures now have a service-unavailable message.

134 tests, typecheck and build pass. New mocked regressions accept a second client memo after twelve seconds, accept complete chat/native-provider responses with twelve seconds elapsed, preserve the watchdog, and distinguish SDK timeout/abort/network errors. No live HPOP request or real podcast replay was performed. This confirms and corrects a local timeout defect matching the reported pattern; it does not establish that this was the sole cause of the user's live failure. Earlier dated eight-second latency gates remain historical.
