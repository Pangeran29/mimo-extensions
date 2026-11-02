# Replay Lab

Mode: Operate. This is a research surface inside Memo's established visual system.

The user needs to feed the same recording through the real extension, observe its behavior live, find which stage caused a problem, and repeat with fresh conversation memory. The main extension and its latest session must remain separate. Opening the lab must not start playback or paid inference. Existing recordings, AI settings, and the normal Memo interface are the content; synthetic responses are labeled as test evidence, not model-quality evidence.

## Direction contract

THESIS: Put a repeatable audio experiment beside the actual Memo interface, with a readable event trail that opens into complete evidence.

OWN-WORLD: Inherit Memo's Daylight and Midnight surfaces, system sans, violet action color, mint character, restrained rectangular controls, and visible keyboard focus. No new illustration or visual identity.

STORY: Choose a recording, Start, observe Memo, inspect the responsible stage, then Repeat with the same source hash and a new session. Preserve previous runs for export.

FIRST VIEWPORT: At desktop width, source controls and playback status occupy the left column; the real Memo iframe occupies a narrower right column. The timeline follows the source controls. At narrow widths, controls, Memo, and timeline become one column. Start is adjacent to Stop and Repeat.

FORM: Precisely specified task extension, code-led. No concept seed or approved raster comp. The signature interaction is Repeat preserving source identity while clearing conversation memory.

FINISH: unreviewed and undocumented is unfinished. Record the independent finish review and verdict, the evidence/build matrix, and the inherited system in DESIGN.md and .impeccable/design.json. Preserve those shared files unless an approved reusable system change exists. The existing Memo raster retains its provenance; this surface adds no raster.

## Implemented scope

The source chooser stores local audio up to 128 MiB with SHA-256 identity. Start, Stop and Repeat are adjacent. Start explicitly uses the research profile's configured ASR and AI connection; opening or reloading the lab never autoplays. The original recording plays progressively at 1× through packaged VAD, the ASR outbox, ordered transcript and v2 proposal/reviewer chain. The microphone and tab-capture acquisition are bypassed. The right-hand surface embeds `assistant.html?replay=1`, the actual Memo interface, including accepted understanding, the canonical character, contribution bubble, feedback, Sources and Stop.

A compact event trail uses stage filters, readable structured summaries and independently controlled Complete evidence disclosures. Wrapped diagnostic names retain their actual stage; structured failure markers belong to Errors without classifying arbitrary transcript/model prose as an error. Source position, wall time and UI observation time remain distinct. Older-run selection changes the evidence below while Memo shows the latest actual session. HTML reports render as inert escaped pages; HTML/JSON include conversation/model text and exclude audio bytes and credentials.

Repeat reuses the source hash with fresh run/session IDs and empty conversation memory, preserving earlier evidence. EOF flushes the final VAD window and drains pending work, with a 60-second memo deadline that marks an unsettled run partial. Manual Stop ends playback and live publication while retaining accepted state and pending ASR recovery. An ASR outage may keep Repeat waiting beyond that deadline. Pause, seek, accelerated playback, frozen-response user modes and automatic MOM are outside this scope.

## Evidence and limits

The research build defaults to `artifacts/replay-lab/build`; its persistent Chrome profile is `.local/replay-lab-profile`. Normal builds omit the research pages and reject replay controls. `artifacts/replay-lab-2026-10-31/main-build-invariants.json` records all 41 installed main files matching the prior 0.9.0 candidate. The shared paid evaluation ledger remains exhausted at 800/800 and unchanged.

`artifacts/replay-lab-2026-10-31/check.log` records typecheck/build, 259 unit tests, 11 relay tests and five evaluation-tool tests passing. Normal UI regression passes 26 checks and the normal-build replay gate passes. The latest actual-extension smoke passes 44 checks with zero paid provider requests and no browser errors. It uses genuine speech playback and fixed local ASR/proposal/reviewer responses. Its synthetic fixtures validate transport, lifecycle and UI; live-provider quality and latency remain unvalidated. The launcher smoke confirms no autoplay. The independent first review required F1–F3; saved correction proofs and the latest smoke cover all three. `frontend-finish-verdict.md` resolves F1–F3 and returns **ship — scoped UI finish**. `launcher-live.log` records the headed research window opened with build `2026-10-31T05:11:33.453Z`, without audio or inference starting.

Eight saved capture paths under `.impeccable/review/replay-lab/` cover desktop idle/active/complete, 390px active, native Chrome 200%, Midnight complete, stopping recovery and source error. `artifacts/replay-lab-2026-10-31/browser-evidence.md` owns their build associations; `frontend-documentation.md` records the documentation pass. DOM visibility estimates do not prove browser paint, and saved captures do not certify main-profile activation.

Hook triage: secondary text on the playback surface originally measured 4.32:1 in Daylight. Using normal ink there resolved the finding. Saved computed probes pass in Daylight and Midnight; no new hook suppression was added. This is a surface correction within the existing palette, not an approved shared-system change.
