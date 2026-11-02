# Cloud transcription — local development integration

DeepInfra `Qwen/Qwen3-ASR-0.6B` replaces local Whisper. The user accepted the reviewed transcription quality and approximately five-second request response time on 2026-10-25. Existing VAD windows, audio capture, recording formats, overlap handling, HPOP notes prompts, and transcript schema remain in use.

## Run locally

The backend credential has been configured for this workspace in ignored `.local/deepinfra.json` with file mode 0600. It contains the DeepInfra key and a randomly generated development relay token. The provider key is read only by the Node backend, never bundled in the extension or saved in Chrome storage. Do not publish this file. The extension contains the loopback relay token, not a public-service authorization mechanism.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm relay
```

Load/reload `dist/` from `chrome://extensions`. Existing microphone and HPOP configuration is retained. Users do not enter a DeepInfra key, download a recognition model, or need WebGPU for transcription. The small bundled Silero V5 speech detector and matching ONNX/WASM runtime remain necessary to segment audio; those are distinct from Whisper.

To configure a different local backend key, stop the relay, remove the old `.local/deepinfra.json` after preserving it if needed, and run `node scripts/configure-deepinfra.mjs` with the key supplied on stdin in an echo-disabled terminal. Then rebuild and reload the extension so its development relay token matches the backend. The script refuses to overwrite an existing credential file. Never put a provider key in a command argument or source file.

## Flow and recovery

```text
Tab + microphone -> existing mixed stream -> packaged VAD -> finalized speech windows
                                                        |
                                                   IndexedDB outbox
                                                        |
                                     authenticated loopback relay -> DeepInfra
                                                        |
                              ordered transcript commit + atomic outbox deletion
                                                        |
                                     selected HPOP / managed DeepSeek notes -> sidebar and local saves
```

The local relay binds only to `127.0.0.1:8787`. It authenticates a development access token, rejects unrelated web origins/hostnames, limits request size and concurrent upstream work, forwards only the WAV as `audio`, and returns a minimal validated text/language response. It does not log audio, transcripts, credentials, or raw provider error bodies. Upstream timeout is 45 seconds; the extension request deadline is 50 seconds. A disconnected extension request cancels upstream work where possible; an already completed provider request can still be billed.

Each exact float32 WAV uses the same representation as the accepted benchmark. Audio windows are written to IndexedDB before sending. On service, network, timeout, or invalid-response failure, the current window remains at the head of the queue. The sidebar reports recovery; recording continues. Automatic retries use 2, 4, 8, 16, then 30 second delays. There is no Whisper fallback and no transcript guessing or LLM repair.

Stop ends audio capture and saving proceeds independently. Queued windows continue retrying until they recover. Transcript commits remain ordered; successfully committing text and deleting its pending audio happen in one database transaction. Empty recognizer output also acknowledges its window. A restored offscreen document resumes durable queued windows. Chrome startup recreates the offscreen service when pending windows exist; reopening the extension also restores pending work. Recovery requires Chrome and the local relay running.

New sessions wait for the previous transcription recovery to finish, so audio and memos cannot mix across sessions. Closing/reloading during recording can still lose the uncommitted current window/tail; existing raw recording recovery is unchanged. Clearing browser storage or uninstalling removes pending recovery data.

Recovery audio is bounded to 128 MiB of staged/queued float32 samples, including windows awaiting disk writes. At that limit, or if speech detection/local queue persistence fails, the transcript explicitly reports an incomplete state; raw audio recording continues. This is not unlimited offline transcription. Saved audio can preserve speech that could not enter the outbox. A terminal local-storage failure may require reopening Listen after resolving storage pressure; it is not handled as a transient cloud failure.

## Product boundaries

- This is a **local development** service integration. A public backend, authenticated user sessions, per-user accounting, deployment, and quotas are not implemented; do not expose the loopback relay publicly or ship this development access token as public-service authentication.
- The DeepInfra account is service-managed. HPOP's existing separate user configuration is unchanged by this STT task.
- Audio now leaves the computer for recognition. Setup/privacy copy describes DeepInfra audio transfer and local retention of pending speech. Model/CDN permissions and Transformers.js/Whisper runtime assets were removed from the production build.
- API latency excludes speech-window collection and LLM note generation. Keeping the existing segmentation avoids an unmeasured recognition-context change. No new universal language/accuracy claim is made; Mandarin has not been evaluated in the existing corpus.

## Verification commands

```sh
pnpm check
pnpm test:relay
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/cloud-transcription-smoke.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/settings-smoke.mjs
```

The cloud smoke check uses an isolated Chrome profile, existing reviewed audio, production capture/VAD/controller/relay, a simulated initial outage, and at most four real DeepInfra calls. HPOP is intercepted with a synthetic response: it verifies recovered-transcript delivery to the notes controller, not LLM note quality. It does not touch the user's active Chrome profile. Detailed results are recorded under `artifacts/cloud-integration/`.

### Verified implementation, 2026-10-25

- Typecheck, build, all **148 Vitest tests**, and **five relay transport/security tests** passed. The existing offline latency-tool and historical Whisper diagnostic-tool checks also passed.
- Controller checks cover continuing capture during a cloud outage, ordered automatic retry after Stop, empty-output acknowledgement, durable restart recovery, and stale-result isolation. The transcript/outbox commit is atomic.
- Real isolated Chrome check passed through `transcribing -> recovering -> finishing -> complete`: one simulated service failure, **two real DeepInfra calls**, two final transcript segments, saved recording/idle state, and recovered text consumed by the notes controller. HPOP was stubbed inside an isolated copy of its network-worker bundle; no real HPOP inference was used. This copy is under ignored artifacts and is not the production build.
- Settings browser checks passed at 272/360/1100 pixel widths and 200% CSS zoom, including focus, drafts, permissions, and setup recovery. Mechanical design scan returned no findings; the existing layout/font choices were preserved.
- The production build was scanned against the configured provider key: no match. Transformers.js, the Whisper recognition worker, the Whisper-specific ONNX runtime assets, and model-download hosts are absent. Only the packaged VAD runtime remains.
- `artifacts/listen-extension.zip` was refreshed from `dist/`. The authenticated loopback relay was started and its no-charge health check passed. Reload the unpacked extension to use the new build. Use `pnpm relay` to restart the relay after the development process exits.

Public deployment, authenticated customer accounts, usage metering, live HPOP quality, long-duration outage soak testing, and Mandarin evaluation remain outside this implementation. The previously accepted API latency remains an observation, not a service guarantee.

## Selectable notes providers (2026-10-26)

The same relay now serves the fixed DeepSeek model for notes; its health response includes the configured notes model. Restart an older relay between meetings to load this route and the current backend key, then reload the rebuilt extension. Existing HPOP notes remain available. The production default still sends individual speech windows; internal 16/24-second batch caps are experimental. See [implementation, measurements and rollout](PROVIDERS-AND-BATCHING.md). The earlier test counts and synthetic HPOP smoke above describe the original ASR migration, not the newer real DeepSeek browser check.
