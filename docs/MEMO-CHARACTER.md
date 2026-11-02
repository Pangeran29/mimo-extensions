# Memo character and focused live view

Version 0.9.0 changes the presentation of live memo protocol v2. ASR, providers, prompts, models, source memory, settings, credential storage and the proposal/reviewer pipeline retain their existing behavior. Stop still does not generate minutes of meeting.

## What the listener sees

Current understanding is the only main reading content. The top area keeps the running duration and Stop; the bottom navigation remains. The old Listen wordmark, processing/presence line, Activity details, update toasts, latest-update banner and contribution placeholder are absent. Actionable failures retain recovery controls, and transcript warnings are inside the transcript detail view.

Memo is an original mint jelly/slime character. An accepted understanding revision makes it acknowledge the update without moving the reading text. A genuinely new additional contribution opens a speech bubble above Memo and triggers a brief spring. Stop produces a settling/resting response. The idle popup offers a separate Start listening action: greeting the character never starts recording.

## Bubble lifecycle

- The speech bubble is a nonmodal region. Automatic arrival does not move keyboard focus.
- Close or Escape hides the bubble without sending Dismiss feedback. Clicking Memo reopens an available contribution.
- Repeated state or feedback for the same contribution does not reopen a user-closed bubble. Restored/closed sessions do not automatically display old contributions as new.
- Dismiss removes the active contribution and retains its history entry. Useful, Not helpful, evidence, checked relevance status and status sources remain available.
- Sources opens the transcript; Back restores the originating bubble and source focus when still available. Replaced/dismissed elements cannot retain an invalid focus target.
- The bubble scrolls internally and is bounded to leave recording controls and bottom navigation reachable, including narrow layouts and native Chrome 200% zoom.

The character is presentation only: interactions do not schedule inference, alter source facts or control recording except through the existing explicit Start/Stop controls. CSS and programmatic motion respect reduced motion and page visibility. Reactions use bounded squash/stretch, not invented speech levels or model progress.

## Artwork and provenance

The production asset is `public/memo/memo-slime.png`, a 1254×1254 RGBA image with real transparent pixels. It was generated using the built-in image generation tool. Its exact generation prompt is embedded in PNG text metadata and retained at `docs/design-assets/memo-slime.prompt.json`. The manifest uses the same native PNG for Memo icons; no remote asset or additional permission is required.

## Validation and installation state

Technical checks passed: 244 unit tests, 11 relay tests, five evaluation/viewer-tool tests, typecheck/build, three synthetic browser UI suites and an isolated unpacked-extension reload check. UI proof covers close/reopen, repeated and restored state, no focus theft, source return, feedback, history pagination, memo/contribution independence, Stop, narrow/internal scroll, native 200% zoom, themes and reduced motion. The independent frontend reviewer returned **ship at the reviewed UI scope**. Evidence is under `artifacts/memo-character-2026-10-30/` and `.impeccable/review/memo-character/`.

After the user explicitly confirmed all recordings stopped/idle, version 0.9.0 build `2026-10-30T11:13:27.764Z` was installed into `dist`. All 41 installed files match the tested candidate. The previous 0.8.0 build is retained in `artifacts/memo-character-2026-10-30/previous-build`. The existing relay remains ready with protocols [1, 2]; no restart was needed for this frontend change. The registered Chrome extension still needs a user-performed Reload and version 0.9.0 confirmation. Browser automation cannot navigate `chrome://extensions` under its URL policy. File promotion and running-browser activation are separate states and must be reported separately.

No notes-provider or ASR evaluation calls were made for this frontend change. The existing 800/800 evaluation ledger is unchanged, and the earlier partial model-quality evaluation is not promoted to a full pass. Artwork generation is separate from that provider evaluation.
