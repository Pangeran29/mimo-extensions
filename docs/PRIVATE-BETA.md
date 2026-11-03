# Mimo private beta preparation

Current code version: **0.13.3**, including the live empty-state contrast fix. The local extension is usable end to end; the current development build still depends on a relay on the developer's computer. A distributable private-beta package has not been released.

## Available for testing

- Live current understanding and selective additional contributions.
- End-meeting bullet notes, timestamped transcript and combined audio export.
- Recoverable saves and an explicit per-meeting discard confirmation.
- Replay Lab in a separate development build/profile.
- Verified project checks, isolated Chrome startup, UI/recovery tests and focused contrast checks. These checks do not certify every future model answer.

## Work before sharing a release package

| Area | Current behavior | Required beta work |
| --- | --- | --- |
| Backend | Normal build targets `http://127.0.0.1:8787`; relay binds to loopback. | Choose a deployment target and HTTPS domain; configure the release endpoint, manifest and CSP. Keep provider credentials on the server. |
| Tester access | A shared development relay token is embedded during local builds. | Add revocable access for invited testers. A bundled shared development token is not suitable tester authentication. |
| Usage control | Request size, concurrency, deadlines and retries are bounded. | Add server-side usage accounting and limits per tester, plus a global beta spending limit. |
| Release build | `scripts/build.mjs` reads ignored local development configuration. | Add an explicit release mode and checks rejecting local endpoints, development credentials and research-only pages. Create a reproducible versioned package. |
| Onboarding | Settings configure microphone, audio processing, provider and objective. | Explain which audio/transcript data leaves the device, supported capture flows and how testers obtain access. |
| Local files | Folder permission, three-file saves, retries and discard are implemented. | Test the native folder flow on tester platforms and document recovery, local retention and what Discard removes. |
| Feedback | Local replay/diagnostic reports can include conversation text. | Define an opt-in feedback flow and provide a way to report issues without automatically sharing meeting content. |

Generated development builds, local credentials, recordings and replay artifacts remain ignored by Git. The checked-in source does not include the provider key. A release package needs its own scan; pushing source is separate from distributing a build.

## Decisions for the next implementation plan

1. Initial tester group and supported operating systems.
2. Backend hosting account and domain.
3. Invite/access flow and usage limits.
4. Distribution channel, tester instructions and feedback collection.

Once those are chosen, implement the release backend/build path, run the complete flow in a fresh tester profile, then package the approved version. Keep the existing local Replay Lab available for repeatable development checks.
