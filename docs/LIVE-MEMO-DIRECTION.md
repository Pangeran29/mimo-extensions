# Live memo: user-defined direction

Accepted user requirements, 29 October 2026. Captured after review of the two recorded pipeline runs. This describes the intended experience; the production prompt, controller and UI still implement the cumulative-memo baseline.

## Purpose

The live memo acts like an attentive additional participant who listens, understands the ongoing conversation, and contributes when something useful can be added. Its value is the help it provides at that moment: a relevant question, clarification, implication, suggestion, connection or other thoughtful contribution that improves the user's understanding or helps the conversation move forward.

A topical label, paraphrase or explanation of what was just said is not sufficient by itself. An explanation earns its place when it resolves confusion, makes a relationship clearer or provides another concrete benefit. Novel wording and confident presentation do not establish usefulness.

## Live memo and MOM are distinct

| | Live memo | MOM / minutes of meeting |
|---|---|---|
| Purpose | Help with the ongoing conversation | Record/review the whole meeting |
| Scope of an output | What matters to the current context | Start-to-finish coverage |
| Relationship to earlier speech | Use it selectively to understand or contribute now | Integrate it into the overall record |
| Timing | During the session, when useful | Separate processing after Finish |
| Current development scope | In scope | Deferred |

MOM is a future separate feature. This brief does not assert that it already exists or authorize designing/implementing its post-Finish pipeline now. Existing recording, transcription and final-processing safeguards continue to apply until explicitly changed.

## Required behavior

1. **Stay with the current conversation.** If the discussion moves A → B → C, the next contribution should concern C. Earlier A or B may be used internally, or mentioned when they materially explain, constrain, contradict or otherwise affect C. Do not restart from A simply because it is part of the meeting.
2. **Carry useful context without replaying it.** Additional context should improve understanding over time. Preserve relevant earlier information internally; do not confuse that need with a requirement to repeat it in every output.
3. **Earn each visible contribution.** Ask what this gives the user beyond hearing the conversation or rereading the previous memo. Output may be a question, explanation, idea or other useful thought. Do not require every output to include all of these, or to fill a fixed document template.
4. **Allow silence.** During the opening fragments, unfinished claims, ambiguous references or other insufficient context, wait. Do not invent a title, interpretation or insight to demonstrate activity. Silence remains valid later when nothing useful can be added.
5. **Avoid redundant updates.** Do not repeat a previously shown point unless the new conversation changes it, makes it newly relevant or warrants a correction. A fresh audio window is not itself a reason for a fresh visible memo.
6. **Keep the contribution current.** A previous contribution should not be presented as fresh help for a new topic when it no longer applies. How earlier contributions remain accessible is a presentation decision still to be made.
7. **Separate comprehension from speculation.** Base factual statements on available evidence. Ideas may go beyond what participants explicitly said, but present them as proposals or possibilities. Questions may expose consequential unknowns without asserting that a suspected problem exists. Distinguish what was said, what the assistant infers, and what it suggests; do not turn a proposal into an agreed decision.
8. **Support different audio purposes.** Keep meetings, YouTube and other spoken material in view. Decisions, owners and tasks can be relevant in meetings; do not require that structure for every conversation or audio source.

The evidence/interpretation distinction in item 7 is an operational interpretation of the user's request for understanding and useful ideas, not an extra user-selected output format. It needs to remain understandable without turning every contribution into a long disclaimer.

## Review examples

These are illustrative acceptance scenarios, not model outputs or verified improvements.

| Situation | Expected behavior | Reject |
|---|---|---|
| Only “we're going to build something…” is available | Wait for enough context | Inventing the project's purpose or a confident topic |
| Topic C is being discussed after A and B | Contribute about C; use earlier material only if it affects C | A recap that restarts from A |
| A new point merely repeats a known fact | Remain quiet unless there is a new useful connection | Rewording the last memo as a new insight |
| A current proposal depends on an earlier constraint | Explain that relationship or ask a specific grounded question | Restating all earlier background |
| A useful possible approach occurs to the assistant | Offer it explicitly as a suggestion tied to the present discussion | Presenting the idea as something participants agreed |
| New speech corrects an earlier assumption | Revise the interpretation and make the consequential correction clear | Continuing to reason from the obsolete assumption |
| Nothing useful can be added | Remain quiet | A generic question, random interpretation or filler |

## Questions for evaluating a candidate output

- Does it address what is being discussed now?
- Does it add a concrete benefit beyond repetition?
- Is there enough context to support the contribution?
- Are facts, interpretations, suggestions and unanswered questions distinguishable?
- Is any repeated older material necessary to understand this contribution?
- Would the user prefer receiving this now to receiving no contribution?

Apply these to selected moments in the existing recordings, using only the transcript available at each moment. Preserve the original baseline. A technically valid response is not automatically useful. No numeric pass threshold, fixed cadence, word count or timing guarantee has been selected yet.

## Implementation decisions still open

- How to identify the active thread and meaningful reasons to contribute.
- How earlier evidence is retained and selected for the current request.
- How live output represents facts, interpretation, ideas and questions without becoming formulaic.
- Whether a new contribution replaces a current one, updates it, or becomes part of a navigable history; how stale content is distinguished from current help.
- How optional general-knowledge explanations would work. The user's interest in helpful explanations does not by itself select web research, another external service or an unrestricted knowledge policy.
- Appropriate model controls, output limits and latency tradeoffs. “Thoughtful” does not by itself select a higher reasoning setting or a different model.

The next design should be judged against these user requirements, not against the older cumulative-minutes prompt or the earlier suggestion that a current-topic summary alone would satisfy the product goal.

Reference learning: [Hedy public-experience study](HEDY-EXPERIENCE-STUDY.md) maps documented product behavior and an illustrated example to these requirements. Its suggested controls, policies and benchmark cases are hypotheses to evaluate, not additional accepted requirements or a claim that Hedy was tested on our recordings.
