# Third-party references and notices

## TabScribe

Small capture patterns in `src/engine.ts` are adapted from TabScribe: microphone constraints, Web Audio input nodes, and routing only tab sound to the playback destination.

Source: https://github.com/danielsemerjya/tabscribe/blob/main/offscreen/offscreen.js

MIT License

Copyright (c) 2026 Daniel Semerjyan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Google Chrome extension samples

Architecture reference: https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.tabcapture-recorder

The sample is Apache-2.0 licensed, Copyright 2023 Google LLC. This project follows the documented API architecture; its implementation is independently written rather than a copy of the sample. Documentation: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture

## Other research

Recall.ai's tutorial was consulted as supplementary documentation; no code was copied:
https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension

Screenity was researched but no GPL-licensed source was incorporated.

Development tools retain their respective licenses. The runtime libraries introduced in version 0.3 are listed below.

## Local transcription (version 0.3)

Runtime dependencies are now bundled; their license texts are distributed in `licenses/` and copied into the extension build. JavaScript, worklets, and WASM execute from the extension package. Remote downloads are model data only.

- **@huggingface/jinja**, MIT, Copyright (c) 2023 Hugging Face, embedded in the Transformers.js web bundle. https://github.com/huggingface/huggingface.js/tree/main/packages/jinja. Full license: `licenses/huggingface-jinja-MIT.txt`.
- **@ricky0123/vad-web 0.0.30**, ISC, Copyright (c) 2022-present ricky0123. https://github.com/ricky0123/vad. Reuses its Silero V5 wrapper and packaged resampling AudioWorklet; the extension owns bounded segmentation. Full notice, including the accompanying Silero notice: `licenses/vad-web-ISC.txt`.
- **Silero VAD V5** model, MIT, Copyright (c) 2020-present Silero Team. https://github.com/snakers4/silero-vad. Packaged from vad-web's distribution. Full license: `licenses/silero-vad-MIT.txt`.
- **ONNX Runtime Web/Common**, MIT, Copyright (c) Microsoft Corporation. https://github.com/microsoft/onnxruntime. Versions are fixed by the lockfile: The active VAD uses Web 1.30.0 with its matching packaged WASM module. Full license and upstream dependency notices: `licenses/onnxruntime-MIT.txt` and `licenses/onnxruntime-ThirdPartyNotices.txt`. Bundled JavaScript retains upstream legal comments, including Google's Apache-2.0 notices.

The two public speech fixtures used by development scripts come from **Google FLEURS**, CC-BY-4.0: https://huggingface.co/datasets/google/fleurs. Their dataset URLs, original filenames, reference text, and transformations are recorded in the generated `artifacts/speech/manifest.json`. The constructed bilingual clip concatenates Indonesian and English recordings after peak normalization; it is not a natural code-switching conversation. Fixture audio is not included in the extension.

## Optional meeting assistant (version 0.4)

- **Omi**, MIT, Copyright 2024 Based Hardware Contributors. https://github.com/BasedHardware/omi. Its proactive assistant's relevance checks, concrete evidence, and recent-notification context informed this implementation. The meeting prompts, scheduler, validators, and UI here are independently written; no Omi source is copied. Full upstream license: `licenses/omi-MIT.txt`.
- **OpenAI JavaScript SDK 7.33.0**, Apache-2.0. https://github.com/openai/openai-node. Bundled only in the dedicated AI network worker, for streaming Chat Completions and the Claude compatibility transport. Full license: `licenses/openai-Apache-2.0.txt`.
- **Zod 4.6.7**, MIT, Copyright (c) 2020 Colin McDonnell. https://github.com/colinhacks/zod. Local result schema and JSON Schema generation. Full license: `licenses/zod-MIT.txt`.

Historical Whisper licenses and evaluation scripts remain for reproducibility of prior local benchmarks; Whisper and Transformers.js are not shipped or loaded by the current extension. Cloud recognition is provided by DeepInfra using Qwen3-ASR 0.6B; model weights are not distributed in the extension.
