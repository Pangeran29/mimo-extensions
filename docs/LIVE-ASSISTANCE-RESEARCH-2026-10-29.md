# Existing solutions for Listen's live memo

Research date: 29 October 2026. Scope: deployed, in-conversation assistance and inspectable implementation patterns relevant to `LIVE-MEMO-DIRECTION.md`. This is documentation and source inspection, not a hands-on product comparison. No third-party code was executed, no models were installed, and no recordings were submitted to another service. Commercial vendors' descriptions establish documented capabilities, not independently measured usefulness.

## Finding

The product category exists: proactive conversation assistance / real-time conversation coaching. Hedy is the closest documented experience to the user's definition. Otter and Cluely offer related live features. Public implementations provide useful decision patterns, but the inspected material does not establish a maintained drop-in engine that satisfies Listen's general-purpose Indonesian/English requirements.

## Deployed product references

| Product | Documented live behavior | Fit for Listen | Implementation visibility |
|---|---|---|---|
| Hedy Automatic Suggestions | Unprompted conversational coaching with configurable selectivity | Closest experience reference | Describes analysis and quality filtering; exact prompts, thresholds and backend code not disclosed in reviewed pages |
| Otter Live Assist | Private coaching cards based on supplied organizational material | Strong example of actionable assistance during calls | Commercial product, closed implementation |
| Cluely Live Insights | Transcript-derived suggested actions plus on-demand answers | Useful separation of automatic discovery and user-requested expansion | Public user guide, closed implementation |
| Granola Chat | In-meeting questions and reusable chat recipes | Partial reference for requested help | Reviewed pages do not establish the same unprompted contribution policy |

### Hedy: closest user-experience reference

Its [Automatic Suggestions documentation](https://hedy.ai/help/automatic-suggestions/) describes automatic questions and insights, analysis followed by quality filtering, meaningful-context requirements, and selectable frequency. It includes meeting, lecture and other conversation types. This supports selective contribution as an existing product pattern; the internal algorithm remains unknown.

[Recaps and detailed notes](https://hedy.ai/help/session-recaps-and-detailed-notes/) are generated after ending the session, a useful precedent for keeping live assistance separate from MOM.

[Context documentation](https://www.hedy.ai/help/managing-custom-contexts/) distinguishes reusable personal context, engagement/topic context and notes for one conversation. These can inform suggestions. This is evidence for distinguishing background from the ongoing transcript, not proof of automatic within-conversation topic tracking.

Hedy's [language announcement](https://www.hedy.ai/post/13-new-languages-expanding-global-access-to-ai-meeting-support/) explicitly lists Indonesian. This is a capability claim; natural Indonesian/English code switching has not been tested here.

**What can actually be integrated?** The [API documentation](https://hedy.ai/help/hedy-api/) describes access to existing sessions and context management, and states that API calls cannot start or stop live sessions. It does not document a general endpoint for feeding Listen's transcript stream into Hedy's suggestion engine. Its [webhook documentation](https://hedy.ai/help/webhooks/) does document `Suggestion Created`, delivering suggestions generated during a Hedy live session. That could support a benchmark log; it is not a standalone inference API. Availability requires the documented subscription/cloud configuration.

**Lesson for Listen — inference:** distinguish the decision to contribute from drafting a response; keep live suggestions and final recap separate. Study the actual experience before trying to reproduce proprietary internals. Do not copy its timing as a universal requirement.

### Otter: a commercial deployment of live contribution

The [Live Assist announcement](https://otter.ai/blog/otter-ai-introduces-live-assist-the-first-live-coaching-agent-for-every-call), dated 21 July 2026, says the feature is available on Enterprise. It describes user-visible coaching cards, suggested questions and talk tracks grounded in playbooks, past meetings and other resources. This demonstrates documented deployment of assistance during calls rather than only post-call notes. Its [workflow page](https://otter.ai/meeting-workflow) also presents live coaching.

**Limit:** the [supported-language page](https://help.otter.ai/hc/en-us/articles/360047247414-Supported-languages) lists six transcription languages and does not include Indonesian. Multilingual chat is not equivalent to Indonesian audio transcription. It is an architecture/experience reference rather than the first candidate for testing these Indonesian recordings. No public implementation of the coaching decision policy was verified.

### Cluely: discovery can be automatic while expansion is requested

The [Live Insights guide](https://docs.cluely.com/feature/liveinsights) documents dynamic questions, keywords and suggestions derived from a transcript. Users can expand those actions, use preset assistance, or ask a question. This is a useful distinction between detecting a relevant opportunity and generating a longer answer. It does not establish that every full answer is unsolicited or that its filtering meets Listen's quality standard. Only official `cluely.com` documentation was used for these claims; similarly named third-party sites were not treated as official evidence.

### Granola: useful adjacent product, not the strongest proactive reference

[Granola Chat](https://www.granola.ai/chat) explicitly describes use during meetings and asking better questions. The reviewed page documents chat and reusable recipes. An automatic, silence-preferring suggestion policy matching the user's brief was not observed on that page. That is a limit of this review, not a claim that no such feature exists.

## Public implementations

### Omi: inspect the pattern, account for the retirement

Pinned inspected commit: [`582195a64f55b7ab6178afdad0545e4af825e3b8`](https://github.com/BasedHardware/omi/tree/582195a64f55b7ab6178afdad0545e4af825e3b8), retrieved 29 October 2026. Public code license: MIT, as recorded in its LICENSE file.

The retained [proactive notification module](https://github.com/BasedHardware/omi/blob/582195a64f55b7ab6178afdad0545e4af825e3b8/backend/utils/llm/proactive_notification.py) separates relevance assessment, candidate generation and a critic. Its inputs include current conversation, personal facts/goals and recent notifications; generation can also use relevant past conversations. The critic rejects redundant, generic or unhelpful advice. A negative gate result is valid. These are concrete code patterns, not a claim about current shipping behavior.

**Current-state caveat:** the pinned [proactivity contract](https://github.com/BasedHardware/omi/blob/582195a64f55b7ab6178afdad0545e4af825e3b8/backend/docs/proactivity_v2/CONTRACT.md) records retirement on 26 October: real-time mentor and commitment-follow-up producers were deleted, and feed compatibility responses are disabled. The old `backend/utils/mentor_notifications.py` URL from Listen's earlier research now returns 404. Retained helper functions must not be mistaken for an active end-to-end feature. No reason for the retirement is inferred.

Our [existing research](LLM-RESEARCH.md) and third-party notices already acknowledge Omi's influence. This is a revalidation and an important status change, not discovery of an entirely new foundation.

**Adaptation boundary — our assessment:** its personal-goal and interruption policy is narrower than Listen's passive video/lecture use. In particular, suppressing suggestions when the user is not speaking would be inappropriate for a listener. Fixed notification lengths, daily caps, message counts and model-assigned scores are not validated defaults for our audio windows. Model self-scores are not calibrated probabilities or an independent usefulness test.

### LlamaPIE: when-to-contribute is an explicit learning task

The [ACL 2025 paper](https://aclanthology.org/2025.findings-acl.710/) describes a small model for response timing and a larger model for generating concise assistance, with reported user studies in its setting. This is a research prototype, not evidence of a broadly deployed commercial app.

Pinned inspected [repository](https://github.com/chentuochao/LlamaPIE/tree/c02b7f62f7b12e397eb04b272df2df51a2abb799): `c02b7f62f7b12e397eb04b272df2df51a2abb799`. The code includes `infer_dual_model.py`, training scripts, evaluation material and an Apple Silicon text demonstration. The inference path runs a classifier before invoking the generator. Its dialogue representation is speaker-aware and includes silence markers; its setup depends on specialized trained models. The source includes development-specific configuration and is not a ready-made adapter for Listen's current API client. The code license is MIT; this review did not establish rights or suitability for adopting every referenced model/dataset.

**Lesson — inference:** contribution timing and contribution wording can be evaluated independently. This does not require us to train a classifier or replace DeepSeek immediately. A simpler gate can first test whether the separation helps on our fixtures.

## What the references support

The following is a synthesis for Listen, not a claim that all vendors use the same implementation:

```text
Retain incoming transcript and relevant context
                    ↓
Assess whether a contribution is useful now
              ↓ no       ↓ yes
         remain quiet   draft a contribution
                              ↓
              check relevance, novelty, support and timeliness
                              ↓
                    show it or remain quiet
```

Keep recently shown/resolved/dismissed contributions available to avoid repetition. Select earlier evidence for its relationship to the current discussion. Recheck whether a response is still timely before displaying it. MOM remains a separate later flow.

Hedy documents analysis/filtering as a product process; Omi contains a three-stage implementation; LlamaPIE separates a trained trigger from a generator. These distinctions matter. A decision pipeline is a reusable concept, not a requirement to add three sequential LLM calls to every transcript window. Additional calls can introduce cost, delay, correlated errors and over-suppression, so gate architecture itself needs a bounded comparison.

## How this can save development time

1. **Use Hedy as the initial experience benchmark.** Assess whether its selective suggestions actually satisfy the user. Include opening ambiguity, topic A → B → C, a useful question, a correction and a no-help-needed moment. This is a proposed trial, not one performed in this research.
2. **Verify the benchmark input route.** To compare live behavior, use authorized live playback/capture of the recordings or another reproducible live source. Do not assume file import recreates a chronological suggestion stream: that behavior was not verified. Hedy's documented suggestion webhook is a possible output log while Hedy itself runs the session.
3. **Extract a small set of patterns from Omi and LlamaPIE.** Selective gating, recent-contribution history, clear negative output and a final usefulness check are stronger starting points than rewriting a cumulative memo prompt indefinitely. Avoid importing a retired routing stack or installing research-model dependencies before a benefit is demonstrated.
4. **Preserve our working audio/ASR pipeline.** First compare candidate behavior using frozen, chronological transcript prefixes. Use only evidence available at each point. No new audio/model/provider choice is justified by this research alone.
5. **Judge the complete decision, including silence.** Record useful contributions, unsupported claims, repeated/stale advice, useful moments missed and end-to-end time to a timely contribution. Include many moments where silence is preferred. Human review remains necessary; a critic model is another filter, not proof that a suggestion helps.

The fastest credible next step is a bounded benchmark and a small isolated decision-policy experiment, followed by user review. The findings do not justify an immediate production rewrite, model training or a platform migration.

## Evidence and remaining uncertainty

Public HTML and source snapshots are stored in `docs/research/live-assistance-2026-10-29/`. Each repository has a commit record; commercial snapshots have retrieval metadata in `web-sources.json`. One credential-like literal in upstream research code was redacted in the local snapshot and was not used. No third-party project instructions were applied to this repository.

Not established: comparative usefulness, Indonesian code-switching quality, actual latency/cost on our meetings, commercial internal prompt policies, or a headless live-assistance API suitable for replacing our backend. A documented launch and a public demo do not independently establish reliability. The useful outcome of this research is a verified shortlist, concrete code patterns and clear adaptation boundaries.
