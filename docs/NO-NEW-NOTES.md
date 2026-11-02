# Accepted empty notes: verification and user feedback

Implemented 2026-10-26. The earlier live vlog session's individual LLM responses were not captured. This patch does **not** retrospectively prove that its blank panel was caused by an empty summary. No live HPOP request was made for this work; a credential is still unavailable in the isolated runner.

## Verified mechanism

The production provider accepts a complete, schema-valid response with `summary: ""`. After validation, the controller keeps the existing memo (or keeps it empty if none exists), advances the processed transcript cursor, and treats the request as successful. This is intentional no-update behavior, distinct from receiving no response, a malformed response or a timeout.

Controlled checks cover both provider transports, the controller, actual local storage, and the production sidebar. They confirm that an accepted empty summary can leave the memo and panel empty. They do not establish why a real model chose an empty summary for the user's particular transcript.

## Positive identification

`AssistantSnapshot.lastAnalysis` records only the latest accepted request ID, version, timestamp, trimmed returned-summary character count, resulting memo character count and outcome (`empty`, `unchanged`, `updated`). A failed request cannot create an empty-success outcome. New sessions reset it; existing notes survive empty updates. No raw response is retained.

The explicit diagnostics export now compares three stages using session, request ID and version:

1. Accepted response metadata from the controller.
2. The actual saved snapshot read from IndexedDB.
3. A read-only status reply from the sidebar containing its memo and DOM character counts.

`notesVerification.finding` reports `confirmed_empty_summary` only when the same accepted response is correlated across all three stages and every notes count is zero. It distinguishes uncommitted, unsaved and unrendered text, preserved notes after an empty update, and successfully rendered notes. Missing data or mismatched request versions remain inconclusive. A later/current failure is reported separately rather than attributing it to an older successful empty result.

The panel reading concerns DOM content, not proof of physical screen paint. Its current view is included, since a diagnostics export normally occurs while Settings is visible. No panel reply, no saved snapshot, legacy metadata or a concurrent request can prevent correlation; the report must not infer a rendering bug from those cases.

Existing opt-in trace events also include accepted summary length and a correlated `memo.outcome_rendered` event. Tracing stays disabled by default. This adds latest-result metadata, not response text or a continuous performance recording.

## User-facing behavior

For a validated empty result:

- Before the first memo, the empty view says **No notes yet.** It explains: **The last completed AI check returned no notes. You can review the transcript.**
- A brief bottom notification says **No new notes from this passage.** Repeated state broadcasts do not repeat it.
- The completed LLM timer says, for example, **4.2s · no new notes**.
- Existing notes remain visible when an empty update follows them.
- An actual nonempty memo replaces the empty explanation normally.

These messages report what the AI returned. They do not claim that the conversation was unimportant, irrelevant or unsuitable for notes; the current response schema provides no reason for skipping. Prompt policy, model, validation, retry schedule and transcript context window are unchanged.

## Verification

Use the repository's normal Node runtime:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/build.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/assistant-ui-smoke.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/settings-smoke.mjs
LISTEN_PLAYWRIGHT_PATH=/absolute/path/to/playwright node scripts/notes-recovery-smoke.mjs
```

Chrome UI checks exercise a controlled accepted-empty state, the notification and timer, correlated panel status, no duplicate notification, and subsequent normal note rendering. Provider checks use controlled streamed replies for both transports. These are mechanism/contract checks, not a live reproduction of the original model decision.

Artifacts: `artifacts/assistant-ui-smoke.json`, `artifacts/settings-redesign-smoke.json`, and `.impeccable/review/memo/no-new-notes.png`. No active user recording was stopped or reloaded automatically.
