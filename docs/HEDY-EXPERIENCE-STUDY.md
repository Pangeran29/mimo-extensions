# Learning from Hedy's public experience

29 October 2026. This studies Hedy's official help flows and publicly illustrated UI, then maps them to Listen's accepted live-memo requirements. It is not an authenticated product trial or a benchmark of Hedy on the supplied recordings. No account was created, no audio was captured, and no recordings were uploaded. Hedy's implementation remains proprietary in the reviewed material.

## Main lesson

Make helpful intervention a separate product behavior. A system can listen and understand without having something worth displaying. Conversation context informs the judgment; the displayed contribution should justify the attention it asks from the listener. This is our interpretation of the documented experience, not a claim to have recovered Hedy's internal algorithm.

## Experience patterns and their implications

| Publicly documented/illustrated behavior | What we can learn for Listen | What remains unproven |
|---|---|---|
| Automatic Suggestions has a meaningful-context requirement and selectable frequency. | Waiting can be a legitimate state; analysis does not oblige output. | The precise trigger, thresholds and quality on our recordings. |
| Suggestions and manual Quick Prompts are separate controls. | Unsolicited help needs a stronger attention threshold; a direct question can request more detail. | Whether Listen needs chat or quick buttons in its first iteration. |
| Session types change the kind of assistance. | Listening to a lecture and participating in a planning meeting are different tasks. | The right default and minimum configuration for our users. |
| Personal context, engagement context and one-conversation notes are distinct inputs. | Background should inform current relevance without being repeated in the output. | How Hedy selects or compresses those inputs internally. |
| The newest suggestion can offer optional follow-up questions. | Start with a useful contribution and let the user choose depth. | Whether follow-up controls improve Listen's specific use case. |
| Recaps and detailed notes are generated after ending a session. | Preserve the user's live memo / MOM distinction. | Our eventual MOM pipeline, which remains deferred. |

Sources: [Automatic Suggestions](https://hedy.ai/help/automatic-suggestions/), [Quick Prompts](https://hedy.ai/help/hedy-quick-prompts/), [Session Types](https://hedy.ai/help/understanding-hedy-session-types/), [Context Management](https://www.hedy.ai/help/managing-custom-contexts/), [Conversation Guide](https://hedy.ai/help/mastering-conversations-with-hedy/), [Recaps](https://hedy.ai/help/session-recaps-and-detailed-notes/).

### 1. Learn the attention policy

The automatic-suggestion guide describes ambient coaching, analysis plus filtering, and a meaningful opening context requirement. Selective settings may legitimately produce little visible content. These are vendor-described behaviors, not measured success rates.

For Listen, distinguish: listening with insufficient context; understanding but having no useful contribution; and having a timely contribution. A subtle status can communicate that the pipeline is active without creating content to fill the space. This status recommendation is ours; Hedy's precise waiting UI was not verified. Do not turn the documented approximate startup time into a fixed two-minute delay.

### 2. Study a concrete useful contribution

The publicly rendered Automatic Suggestions tutorial poster illustrates a pricing deadline conflicting with a decision to defer a discount. The suggestion connects those facts and brings the dependency to the user's attention. This is a vendor-created example, not a response observed in our own live test.

The transferable behavior is the relationship: earlier constraint + current proposal → consequence worth considering now. A relevant contribution may revisit an earlier point when it affects the present decision. That fits the user's permission to use topics A and B when they genuinely affect C. It does not justify recapping A and B on every update.

### 3. Personalize the definition of useful

Hedy's [class/course guide](https://hedy.ai/help/how-to-use-hedy-for-classes-and-courses/) asks users to provide their background, existing knowledge and preferred help. Its [session-type guide](https://hedy.ai/help/understanding-hedy-session-types/) differentiates lecture comprehension from meeting participation.

Our implication: the same passage may warrant a clarification for a learner and silence for an expert. Optional intent or role context could help; it should not become a mandatory profile questionnaire. Two possible experiment conditions are “help me understand” and “help me contribute,” but these are unapproved design options, not new product requirements. Existing saved meeting objectives may be sufficient for an initial comparison.

### 4. Keep depth under user control

The [conversation guide](https://hedy.ai/help/mastering-conversations-with-hedy/) documents optional follow-up questions attached to the newest answer or suggestion. The [quick-prompt guide](https://hedy.ai/help/hedy-quick-prompts/) documents user-requested help during a session.

Our implication: a concise contribution should stand on its own. Expansion can serve the user who wants more, rather than make every live contribution long. We should first establish the usefulness of the contribution itself; recreating a complete chat product is unnecessary for that experiment.

### 5. Do not confuse different meanings of topic

Hedy's [context documentation](https://www.hedy.ai/help/managing-custom-contexts/) describes a topic as an engagement such as a client or course, with reusable background; notes capture this particular conversation. Those are useful information boundaries. They are not evidence that Hedy exposes a reliable automatic A → B → C topic-segmentation engine. We still need to design and evaluate current-thread selection for Listen.

## Behavior examples for our recordings

These are our proposed review expectations, not Hedy outputs or verified reference answers. Use only evidence available at each checkpoint. Source IDs refer to the preserved `run.json` transcripts.

| Checkpoint | What is available | Candidate review expectation |
|---|---|---|
| `lemhanas-16-10`, segment 0 | An unfinished opening about starting a project | Prefer silence over a guessed project description. |
| `lemhanas-16-10`, segment 6 | An existing system and proposed AI development are clearer | Understanding the subject alone should not force a visible contribution. Evaluate whether anything helpful can actually be added. |
| `lemhanas-16-10`, segment 87 | A participant already asks whether the 46-day period includes the local model | Avoid repeating that same question as a new insight. Follow the answer before intervening. |
| `lemhanas-16-10`, segment 101 | The discussion raises the need for a stronger model alongside earlier scope/resource concerns | Assess whether a useful connection can be contributed without using the later conversation to invent a solution prematurely. |
| `lemhanas-28-10`, segments 171–172 | Tuesday updates and Monday readiness are explicitly stated | Do not merely repeat the schedule. A further contribution needs a concrete additional benefit. |
| `lemhanas-28-10`, segments 271–272 | Desired map depth is discussed with a lighter fallback if the polygon is heavy | Assess whether clarifying the distinction between visual zoom and available detail would help. Do not present a formal implementation decision as agreed if it has not been agreed. |
| `lemhanas-28-10`, segment 349 | The transcript says 23 November | Preserve that evidence and its uncertainty; reject an unsupported switch to December. |

Several examples deliberately include preferred silence. A benchmark containing only obvious opportunities to speak will reward an overactive assistant. The resource and map expectations are conditional: earlier and immediate surrounding context must be checked, and a participant may already be making the connection. Do not force a contribution to meet a quota.

## What we should carry forward

Proposed candidate policy, not production implementation:

1. Identify the current thread and the user's intent, where known.
2. Identify a specific benefit a contribution could provide now.
3. Check sufficient evidence, novelty and whether participants already addressed it.
4. Draft only the useful contribution; relevant earlier evidence may support it.
5. Check whether it is still relevant and supported at display time; otherwise remain quiet.

These are logical responsibilities, not a decision to use five model calls or a particular multi-agent framework. A candidate should be inspected on frozen transcript prefixes before touching the working audio pipeline. Expose the reason for speaking or remaining quiet in evaluation traces, not necessarily in the user interface.

First comparison fields: checkpoint, current thread, input evidence, proposed contribution or silence, benefit claimed, redundancy/already-addressed check, unsupported statements, and the user's “helpful / not helpful / would prefer silence” judgment. Keep machine filtering separate from user preference. Timing and interruption cost require a later live test.

Seven frozen transcript-prefix checkpoints are prepared locally in `artifacts/hedy-inspired-review/index.json`, with one JSON file per checkpoint. Each contains only transcript delivered by that point. Expectations are proposed review criteria; candidate output and user review fields are empty. No model calls were made to prepare them, and they are not Hedy-generated results.

## What we should not infer or copy

- The exact model, prompts, retrieval method, number of inference requests, deduplication mechanism and failure handling are not disclosed in these pages.
- A documented filtering process does not prove that every suggestion is useful or that a model's self-rating is reliable.
- A larger set of session modes is not automatically a better first version for Listen.
- “Entire session context” in product documentation does not establish that every raw word is sent to every model request.
- Do not promise live external fact verification from this review. The conversation guide describes limits on external information; general suggestions and verified research are different capabilities.
- File-import support does not establish replay of historical live suggestions. The [import guide](https://hedy.ai/help/importing-audio-and-video-files-to-hedy/) describes native-app processing, but a chronological suggestion benchmark through import was not verified.

## A hands-on Hedy benchmark remains separate

No authenticated Hedy session was run in this study. A reproducible next benchmark can start with a synthetic public conversation before using private recordings. It should include an ambiguous opening, established facts that need no repetition, an already-asked question, a topic shift, a useful cross-context dependency and a correction. Configure context and frequency explicitly, and retain negative moments rather than score only displayed suggestions.

For testing the supplied recordings, use an authorized live capture/replay route unless the app is shown to support equivalent chronological import behavior. Hedy's [suggestion webhook](https://hedy.ai/help/webhooks/) can potentially log suggestions while its own session runs; its [API](https://hedy.ai/help/hedy-api/) is not documented as a general transcript-in/suggestion-out replacement for our backend. That boundary still needs a product trial, account access and an explicitly chosen data route. This research does not upload the supplied recordings by implication.

## Evidence

Additional public pages are archived under `docs/research/hedy-experience-2026-10-29/`. The tutorial poster was visually inspected in the in-app browser on the official help page; observed text is summarized rather than treated as a live generated response. The visible page and documentation were available without authentication. Earlier commercial/source research is in [LIVE-ASSISTANCE-RESEARCH-2026-10-29.md](LIVE-ASSISTANCE-RESEARCH-2026-10-29.md). Our accepted requirements remain [LIVE-MEMO-DIRECTION.md](LIVE-MEMO-DIRECTION.md). No application behavior was changed.
