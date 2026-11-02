# Live sidebar progress — 2026-10-25

The top status now includes three independent, display-only readings:

- **Audio window:** actual buffered audio duration, including overlap, while speech is being collected. Shows the most recently emitted window duration while waiting. Silence is not presented as an API request.
- **DeepInfra:** current transcription attempt's elapsed time, then the latest completed or failed duration. This includes local encoding, relay, network and complete response; it is not server inference time alone. The tooltip reports queued windows. Retry countdowns are separate from request durations.
- **LLM notes:** current automatic notes attempt through complete-response validation, then its latest duration. Excludes audio collection, transcription and retry wait. Explicit deeper analysis remains a separate action and is not included in this reading.

Stages may run concurrently. These are not a single window's end-to-end timeline, and their displayed values should not be added together. Each new attempt replaces the previous reading. Timers use the monotonic clock in the offscreen process, so opening the panel halfway through a request still shows the elapsed request time.

New finalized transcript text and changed validated notes trigger a small bottom notification. It lasts about 4.5 seconds, can be dismissed, and does not move focus or scroll. A fresh notes notification takes priority over a later transcript notice. Restored notes, unchanged responses and partial model output do not trigger it.

## No new recordings or timing logs

Readings are private in-memory controller fields, sent over the existing visible-assistant port four times per second. The port is disconnected when the sidebar is hidden, shows Settings, or leaves the live session. No progress samples, notification history or new timing fields are written to IndexedDB, Chrome storage, analytics, or diagnostic traces. Existing recording/transcript/memo saving and previously implemented diagnostics remain unchanged. Closing/reloading the offscreen process discards these readings.

## Verification

With Node and Playwright available:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/build.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/assistant-ui-smoke.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/notes-recovery-smoke.mjs
```

Verified: type check, 160 tests, build, Chrome UI checks at 272/340/398/1000 CSS pixels and a 200% zoom-equivalent viewport, plus the existing invalid-response recovery smoke. UI checks use synthetic process readings and confirm simultaneous timers, completed durations, retry countdowns, new/unchanged/restored update notifications, preserved reading position, and no page errors. Controller tests check real stage transitions with mocked providers and verify the new readings are absent from persisted snapshots. No paid provider calls were made for these checks.
