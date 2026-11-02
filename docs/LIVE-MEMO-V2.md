# Live memo v2: current understanding and additional contribution

This implementation follows the approved two-layer product direction. Version 0.9.0 Memo files have been installed into the main `dist` directory and the relay restarted with protocol 2; the existing Chrome extension still needs a user-performed Reload before its running state is confirmed. The earlier v1 replay remains historical evidence; MOM, ASR changes, new profiles and automatic browsing remain out of scope.

## Processing and public state

One stage-one request understands the current conversation, updates source-linked memory, proposes a factual memo, optionally proposes one additional contribution, and optionally changes the active contribution's status. One reviewer request is made if any public component needs changing. It returns separate accept/reject verdicts for memo, contribution and status; it never rewrites content.

The memo targets one or two sentences with a hard 600-character limit. It follows the current focus, distinguishes proposals from decisions, and contains no outside knowledge or assistant recommendations. A supported memo may exist before the model establishes a canonical topic key. A substantive first memo may paraphrase transcript; later revisions need a meaningful change relative to the previously accepted memo. Ambiguous openings retain a gathering-context state. The previously accepted text stays visible during processing and failures.

Additional contributions target 30–90 words, with a hard 1,200-character body limit. The agent seeks explanations, connections, implications, distinctions, suggestions and important unanswered questions. There is no output quota or forced variety. Interpretation, general knowledge and suggestions remain marked and separate from participant claims. Exact normalized duplicates are suppressed locally; the reviewer checks semantic novelty and already-answered questions.

A topic change does not remove the last contribution. Its checked status can be `relevant`, `previous_topic`, `answered` or `corrected`. Priority is corrected, answered, previous-topic, relevant; returning to a topic can make a previous-topic contribution relevant, but cannot erase an answered/corrected status. Only a question contribution can be marked answered. Status changes carry evidence and are reviewed. A new accepted contribution replaces the old one; Dismiss clears only the contribution. History preserves earlier items and feedback, in pages of 25. Historical status labels describe their last shown status, not an ongoing claim of relevance.

## Contracts and compatibility

`AssistantSnapshot.liveV2` stores protocol 2 state, separate memo revision ID/text/topic/sources/time/through-segment cursor, contribution history, active ID, source-linked working memory and feedback version. `AnalysisInput.liveV2Input` includes the accepted memo, active contribution/status, separate new/recent transcript, recalled source quotes and proposed components for review. Legacy `live` and baseline analysis contracts remain available. The compatibility `summary` field projects the accepted memo body, not the contribution.

Wire schemas are `live_memo_proposal_v2` and `live_memo_review_v2`. The relay keeps baseline and v1 schemas on the same endpoint. Health retains `notes.liveMemoProtocol: 1` for v1 compatibility and adds `notes.supportedLiveMemoProtocols: [1,2]`; the v2 candidate checks support for 2. DeepInfra model/reasoning and the HPOP native forced-tool adapter are unchanged; both new schemas are mock-tested through HPOP SSE.

JSON/envelope failures reject the response. Once readable, memo, candidate and status are validated independently, so one invalid component does not discard valid siblings. Body limits reject rather than truncate. Source IDs must have been supplied. A conservative additional check rejects attendee-selection assertions inferred from ambiguous participant/no-decision wording; it is not a general semantic proof. Actor/action/object, uncertain ASR names, exact dates and proposal-versus-decision still require model checking and user review.

## Scheduling, storage and Stop

Scheduling remains one chain at a time, one-second arrival debounce, minimum ten seconds between proposal starts, 20-second proposal and 10-second review deadlines, bounded transport retries and Retry-After. Recent and recalled context use the existing 90-second/2,500-token and 1,500-token experimental budgets. Extra direct evidence includes memo and contribution/status source quotes. The reviewer sees the latest transcript at its start. Further ASR, feedback, Stop, cancellation or session changes fence all public components. Stage-one valid memory persists even when public output is rejected; its cursor never includes extra reviewer-only segments.

IndexedDB `listen-live-memo-v2` is separate. Fallback reads v1 through a copy migration, preserving contribution identity/body/feedback and keeping it out of the narrative memo. Original v1/baseline stores are untouched. Restored sessions remain closed. New sessions clear both outputs only after existing transcription recovery requirements are satisfied. Memo persistence or AI failure cannot stop recording/ASR.

Stop aborts automatic/deeper work and saves accepted state; audio export and pending transcription continue. Recovery cannot reactivate live output. There is no automatic final recap. Analyze deeper uses current understanding and relevant source context.

## UI and evaluation

The established themes, flat reading surface, typography and recorder controls remain. Current understanding and the active contribution are separate stable DOM elements, rendered as text. Memo changes preserve contribution identity, reading position and keyboard focus. Memo has Sources; contribution has Sources, status evidence, Useful, Not helpful and Dismiss. Process indicators describe real activity while accepted text remains visible. Latest-session memo/history remain accessible after Stop.

Build and checks stay isolated:

```sh
LISTEN_BUILD_DIR=artifacts/live-memo-v2/candidate-build pnpm check
node scripts/live-memo-v2-replay.mjs --checkpoints
node scripts/live-memo-v2-replay.mjs --synthetic
node scripts/live-memo-v2-replay.mjs --skip-synthetic
```

Offline transport uses `--offline`; it is not model-quality evidence. `--checkpoint-keys=recording:segment,...` supports targeted retests with the same transcript prefixes. Every invocation creates a fresh run directory, preserves raw responses and source hashes, and exposes complete inputs/prompts for both stages. Event IDs distinguish new memo/contribution/status changes from retained content. Feedback for memo (clarity, grounding, focus, timeliness) is separate from contribution usefulness. Replay time is a virtual ASR-arrival clock with measured provider duration, not measured full browser latency.

All v2 live calls use the EXISTING ledger `artifacts/live-memo-v1/provider-budget.json`. It started this cycle at 443/800, leaving 357. It is never reset. Retries and real browser ASR calls count. Prioritize 17 checkpoints, three non-meeting scenarios and one audio smoke, then replay 16-10 followed by 28-10. Exhaustion produces a partial report; incomplete full evaluation is never declared passed. No installed extension reload or existing relay restart occurs before user review.

The evaluation retained early runs that exposed an overly strict topic requirement, memo-review self-comparison, and actor/object ambiguity. Targeted retests and synthetic cases record the fixes; earlier outputs remain measurements of those earlier instructions. Model review is not quality certification and no usefulness percentage is claimed.

## Evaluation outcome · 2026-10-30

The shared ledger reached exactly 800 attempts (443 historical + the authorized 357 for v2), and provider evaluation stopped. Recording 16-10 processed 237/237 source segments, publishing 26 memo revisions and 10 contributions. Recording 28-10 processed 70/368 source segments, publishing 10 memo revisions and one contribution. Its final reviewer attempt was blocked by the evaluation ceiling before an upstream call. Overall full-replay evaluation is **partial, not passed**. The 17 checkpoints and three synthetic scenarios remain separately inspectable, including superseded and targeted attempts. App checks passed 244 unit tests, 11 relay tests, and three evaluation-tool tests; isolated UI and real audio/ASR/protocol-v2 smoke checks passed. Remaining ASR wording/interpretation and narrative-focus questions are explicitly listed for user review, not certified as correct. See `artifacts/live-memo-v2/review.html` and `review-focus.json`. At the end of that evaluation phase, no installed-extension activation or running relay restart had been performed. See the subsequent activation record below.

## Open the rendered report

Use the local browser viewer when a workspace file link opens HTML source instead of rendering the page. If the viewer is not running, start it with `pnpm review:v2`, then open `http://127.0.0.1:8766/live-memo-v2/review.html`. The direct 16-10 page is `http://127.0.0.1:8766/live-memo-v2/replay-2026-10-30T08-10-01-669Z/lemhanas-16-10/review.html`. This read-only viewer serves the existing report with `text/html; charset=utf-8`; it does not invoke a model, alter replay results or activate the extension. Source backups, runtime bundles and project configuration are not served.


## Version 0.8.0 activation and frontend · 2026-10-30

The user authorized promotion, a relay restart and an idle-only extension reload, together with a more expressive frontend. The reviewed build (`2026-10-30T09:31:32.277Z`) is installed in `dist`. The prior build is preserved under `artifacts/live-memo-v2/activation-2026-10-30/previous-build`. Actual Chrome popup inspection showed Ready to listen with no recording or pending-work hint before promotion. The restarted relay reports `supportedLiveMemoProtocols: [1,2]`; existing credentials, extension permissions, provider/model and ASR settings are unchanged.

Chrome Reload is **pending user action**: browser automation rejected the `chrome://extensions` protocol. No alternate reload mechanism was used, and running-main-extension v2 activation is not claimed. In Chrome, open Extensions, find Listen and click Reload while idle. Then open an ordinary audio website tab and Listen. An isolated unpacked-extension reload test passed separately, including local credential persistence; it does not substitute for confirming the main Chrome reload.

The new popup, live panel and Settings use a saturated violet primary region, periwinkle/ink themes, labeled navigation and actual-state motion. Current understanding and contribution update independently; sources, checked statuses, feedback and paged history remain. Technical timing is collapsed under Activity details. Reduced motion suppresses CSS and accepted-memo color animations. Narrow and native Chrome 200% layouts are covered, including a 2×2 navigation layout at 240px and below. Independent frontend review returned **ship at the reviewed UI scope**, without certifying model quality or activation.

Validation: 244 unit tests, 11 relay tests, five evaluation/viewer-tool tests, typecheck, three synthetic browser UI suites and the isolated reload test passed. Activation made zero provider calls; the existing evaluation ledger remains 800/800. See `activation.json`, `frontend-finish-review.md`, and `frontend-documentation.md` in the activation directory. Full replay evaluation and user usefulness findings retain their previously reported limits.


## Memo presentation · version 0.9.0

The current frontend candidate supersedes the 0.8.0 two-visible-area arrangement: Current understanding is the only main reading content, while Additional contribution appears in a nonmodal speech bubble from the interactive Memo slime. The header wordmark, thinking/presence line, Activity details, update toasts and latest-update banner are removed. Timer, Stop, bottom navigation, sources, feedback and paged history remain. Closing a bubble preserves the active contribution; Dismiss archives it. Accepted updates and Stop receive character reactions with reduced-motion support. See [Memo character and interactions](MEMO-CHARACTER.md).

Version 0.9.0 is technically validated and independently reviewed at the UI scope. Its tested copy is retained under `artifacts/memo-character-2026-10-30/build`. After the user confirmed all sessions idle, it was installed into `dist`; the prior 0.8.0 build is preserved under `previous-build`. Main Chrome Reload/version 0.9.0 remains user action and is not yet confirmed. Existing protocol v2 inference, relay, ASR and model settings remain unchanged. The 800/800 provider evaluation ledger is not reset, and no paid ASR/notes-provider request was added for this frontend change.
