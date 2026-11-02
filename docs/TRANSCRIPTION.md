> UI update (0.5.0): the toolbar popup no longer renders transcript text or Copy. Local recognition, saved segments, and the AI transcript subscription remain active. Sidebar transcript presentation is a separate upcoming UI task. Earlier popup instructions below describe the original transcription UI.

# Layer 2: local transcription

## Scope

Near-real-time draft text from the existing combined microphone/tab stream. The three audio recordings remain independent of transcription. This layer creates the text input needed by future summaries and follow-up questions; it has no LLM or cloud fallback.

## Reused implementation

- Hugging Face's [realtime Whisper WebGPU example](https://github.com/huggingface/transformers.js-examples/tree/main/realtime-whisper-webgpu): worker-owned lazy model load, mixed precision, GPU warm-up, progress messages.
- [Transformers.js 3.8.1](https://github.com/huggingface/transformers.js/tree/3.8.1): ASR pipeline and ONNX execution. Pinned multilingual [Whisper base](https://huggingface.co/onnx-community/whisper-base/tree/1846881b6b3a3024392c1eea3ad983695bc23925), FP32 encoder and Q4 merged decoder. The two ONNX files total 206,070,497 bytes, excluding tokenizer/config files.
- [Whisper language detection](https://github.com/openai/whisper/blob/main/whisper/decoding.py): the first decoder token's logits identify the language; this MVP compares Indonesian and English. Transformers.js's default is English, so leaving language unspecified silently translated our Indonesian fixture. Explicit language detection and `task: 'transcribe'` fixed that failure. The language probe runs an extra encoder pass; the measured performance gate includes it.
- [vad-web](https://github.com/ricky0123/vad): packaged AudioWorklet/resampler and Silero V5 wrapper. We deliberately use the low-level wrapper, because its higher-level utterance processor buffers an entire speech run. Our small segmenter enforces a maximum window, including for nonstop speech. No custom audio encoder, decoder, resampler, or VAD model was invented.

All modifications and licenses are listed in [third-party notices](../THIRD_PARTY_NOTICES.md).

## Audio and state flow

1. Initial Settings setup downloads/prepares the WebGPU model and packaged VAD and persists `transcriptionEnabled`. Thereafter a transcript-status request (Settings, Assistant, or popup) automatically restores and verifies the real model if its offscreen worker was unloaded. Restoration is shared across concurrent queries and attempted once per offscreen lifetime, with actual failure/retry shown instead of assumed readiness or repeated status-poll retries. It never prepares over active recording/transcription. Fresh installs do not auto-download without initial setup. Future Listen requests still warm/check the actual model before acquiring Chrome's short-lived capture token.
2. The recorder acquires both sources and builds the same mixed mono destination used for its combined file. A separate branch reads this stream. Only captured tab audio is routed to audible playback; transcription connects through a zero-gain sink.
3. The packaged worklet resamples to 16 kHz mono frames. Silero probabilities gate speech. The segmenter retains about 400 ms of pre-roll, waits for about 600 ms of silence, rejects less than 250 ms of speech, and caps windows around eight seconds. Only forced splits keep one second of overlap.
4. One worker request runs at a time. PCM ArrayBuffers transfer directly to that worker, not through Chrome messaging. The queue includes raw frames, the active segment, queued windows, and in-flight work. More than 30 seconds stops recognition explicitly instead of silently dropping audio. A model request has a 30-second deadline.
5. Results contain text and language; the controller assigns an ID and recording-relative window times. For explicit overlap only, up to 20 normalized suffix/prefix words are deduplicated. There are no partial-result revisions or word alignment promises.
6. State and completed text persist to a separate `listen-transcript` IndexedDB database. Only the latest session is retained; new capture clears it. Chrome messages carry text/metadata. The popup's Copy action is the user-facing transcript export.
7. Stop detaches the transcription graph without stopping shared tracks itself, flushes final speech, then lets inference finish for at most 30 seconds while audio export proceeds. Download completion alone cannot close the offscreen document while recognition is finishing. The model worker and VAD session are released at completion/failure.

The recorder and transcriber have separate state machines. A failure in local recognition does not set the recorder to error. Completed transcript text survives successful audio cleanup; restarted code never trusts stale storage to mean recognition is still running.

## Privacy and packaging

No audio leaves the device. The initial download fetches model/tokenizer/config data from `huggingface.co` and its observed `us.aws.cdn.hf.co` redirect. These are the only allowed external connections. JS, AudioWorklet, ONNX Runtime JS loaders, WASM, and the VAD model come from the extension package. WebGPU is required; there is no automatic CPU/server fallback.

No permissions were added. The extension still uses `activeTab`, `tabCapture`, `offscreen`, `downloads`, and `storage`. CSP enables packaged WASM compilation and local workers. Model caching is browser-managed, not guaranteed permanent offline storage. A fresh device needs the download; an evicted cache needs it again.

There is no keepalive loop for the service worker. Capture and inference live in the offscreen document and dedicated worker. Audio meter sampling only runs while its popup port exists. Periodic lag notifications are sent only while a popup is connected; meaningful result/state changes still notify open extension pages.

## Known limits

- This is passage transcription, not Google Meet-style continuously revised captions.
- Whisper base can make wording, punctuation, and numeral errors. Indonesian/English detection works per window; a concatenated bilingual clip does not establish natural within-sentence code-switching quality.
- Very quiet speech can be missed by Silero before Whisper sees it. In our original public English fixture, RMS amplitude was about 0.0037 (about -49 dBFS), before the recorder's gain headroom. The integration fixture peak-normalizes each public clip to 0.5 for comparable levels. Production capture does not secretly normalize audio or promise to recover inaudible speech.
- Simultaneous speakers and acoustic echo remain mixed. Separate recorded files exist for listening; this layer does not perform diarization or cross-source transcript deduplication.
- The queue's bound covers PCM, not model weights/GPU allocations, Chrome memory, or final audio export. Expect a meaningful memory cost. There is no claim of constant total memory.
- Only completed text is retained after interruption. Pending PCM is not persisted or replayed. Old transcription is replaced by a new session.

## Reproduce browser validation

`pnpm check` runs typechecking, focused tests, and the build. The following optional scripts require an existing Playwright installation, Python 3 for fixture preparation, Chrome with WebGPU, and Chrome 155+ for the test-only `Extensions.triggerAction` CDP command. Production recording does not depend on that CDP command.

```sh
python3 scripts/prepare-speech-fixtures.py
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-gate.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-smoke.mjs
LISTEN_SOAK_SECONDS=1200 LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-smoke.mjs
```

The gate downloads the pinned model once into `artifacts/transcription-gate-profile`. The integration harness copies only its model cache into a fresh isolated profile so an old extension service worker cannot contaminate the run. It tests cached preparation with external connections blocked, actual tab capture of public speech, a silent synthetic microphone, three encoders, popup restoration, transcript retention after download cleanup, and exported-file decoding. It never touches personal tabs or the actual microphone. Reports and fixture attribution remain in `artifacts/`.

The sustained harness samples the isolated browser's process RSS and cumulative CPU time, the offscreen JS heap, PCM backlog, inference duration, and transcript state every ten seconds. Process RSS is an aggregate across that test browser and can double-count shared pages; GPU memory is not independently measured. Offscreen heap excludes the recognition worker. CPU deltas are aggregate process CPU seconds, not Chrome Task Manager percentages. File decoding after export checks decodability/duration; it does not establish human intelligibility or sample-by-sample continuity.

Additional integration modes:

```sh
LISTEN_MIC_SPEECH=1 LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-smoke.mjs
LISTEN_TRANSCRIPTION_FAULT=worker-crash LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-smoke.mjs
LISTEN_CONTINUOUS_SPEECH=1 LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/node_modules/playwright node scripts/transcription-smoke.mjs
```

These respectively feed public speech through the synthetic microphone before tab playback, crash the recognition worker while checking that audio continues, and repeat a trimmed public clip to exercise forced eight-second splits and transferred-buffer overlap. They also check offscreen shutdown after saving/recognition settle.

See [validation results](VALIDATION.md) for measured outcomes and outstanding real-device checks.

See [Whisper debugging results](WHISPER-DEBUG.md) for exact-PCM capture/replay tools, the reproduced boundary-sensitive repetition failure, existing upstream fallback approaches, and the limits of the current accuracy evidence. Production recognition defaults remain unchanged.
