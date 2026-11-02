# DeepInfra request overhead — phase diagnostic

Measured 2026-10-25, using the user-authorized existing excerpts and previously supplied credential. No extension source, audio source, reference transcript, model, language hint, or decoding option was changed.

## Result

Six of six requests succeeded. Median complete-response time was **5.366 s**. The largest measured phase was **after the client finished writing the request body, before response headers arrived**: median **4.684 s**, accounting for **87.6% of summed wall time** across this small run.

This narrows the boundary but does not identify a unique root cause. It is not evidence that queueing alone, or network transit alone, caused the delay.

| Phase | Observation |
| --- | --- |
| DNS, first connection | 12.6 ms |
| TCP connect, first connection | 59.0 ms |
| TLS wrapping/handshake, first connection | 448.1 ms |
| Total first connection setup | 533.5 ms |
| Client body socket writes, median | 472.0 ms |
| After body write -> response headers, median | 4,683.9 ms |
| Response body read, median | 0.157 ms |
| Provider-reported inference runtime, median | 180 ms |
| Complete request, median | 5,366.2 ms |
| Complete request, reused-connection median | 5,268.6 ms |

DNS/TCP/TLS are nested within total connection setup. Provider-reported runtime occurs within the overall response wait, not an additional serial phase. Do not add all rows together or sum component medians as though they describe one request.

## Per-request observations

| Request | Excerpt | Connection setup ms | Body write ms | After-write wait ms | Total ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 424:combined | 533.5 | 1,066.0 | 4,755.2 | 6,362.9 |
| 2 | 792:combined | 0, reused | 250.7 | 4,612.5 | 4,867.1 |
| 3 | 864:combined | 0, reused | 398.8 | 4,866.0 | 5,268.6 |
| 4 | 424:combined | 0, reused | 401.2 | 4,317.5 | 4,721.6 |
| 5 | 792:combined | 0, reused | 542.9 | 8,661.7 | 9,207.5 |
| 6 | 864:combined | 0, reused | 1,234.0 | 4,225.7 | 5,463.8 |

Connection reuse was observed for all five later requests, rather than assumed from using a session object. Responses also advertised `Connection: keep-alive`. The second request for the same `792:combined` audio took 9.207 s versus 4.867 s on the first, with most of the increase in after-write wait. That is variability in the request path, not a controlled test identifying server queueing.

## Measurement boundaries and limitations

The script instruments the original Python requests/urllib3 transport: DNS resolution, TCP connect, TLS wrapping/handshake, HTTP header/body sends, response-header return, full response read, and JSON parse. It uses the same exact eight-second float32 WAV representation and one shared session, without retries or prompts. Three combined-source excerpts were sent twice in a fixed order, six API calls maximum. Reported total cost was **$0.00015984**.

Client socket-write completion means Python handed the body to the TLS/socket transport. It does not prove that every byte had reached DeepInfra's inference server. The measured after-write wait still includes any remaining audio transit, provider ingress/routing, unreported preprocessing, queueing, inference, and response transit. The small response body arrived immediately after headers, so downloading the transcript body is not a substantial observed cost.

The provider supplied no `Server-Timing` header in these responses, and `inference_status.runtime_ms` does not expose ingress or queue timestamps. Its reported runtime is not an independently verified complete provider processing clock. We cannot subdivide the approximately 4–9 second wait further from these traces alone.

The earlier timing discrepancy cannot be resolved merely by connection reuse: this diagnostic actually reused connections and still exceeded three seconds on every request. Avoid claiming that model inference, the notes prompt, or response JSON processing explains the delay.

These are local-caller measurements on one network at one time, not performance from a deployed relay or all customer networks. Six requests do not establish a latency SLA or a statistically reliable p95. No model-quality ranking is made from this diagnostic, and no new language coverage was tested.

## Next diagnostic boundary

The most useful additional evidence would be provider ingress/queue/start/end timings correlated with the saved request IDs. A controlled replay from an intended backend region would separately test whether moving the caller changes the wait. Neither was performed here; no provider support message was sent and no infrastructure was deployed. Do not change the model or shorten recognition context based on this measurement alone.

## Artifacts and verification

Private artifacts: `artifacts/deepinfra-overhead/20261025T100320Z/` contains `run.json`, six raw `response-*.json` files and `summary.json`. Request IDs and safe response headers are retained locally for provider correlation; credentials and request headers are not recorded.

Runner: `scripts/asr-deepinfra-overhead.py`. It accepts the credential through stdin in an echo-disabled terminal, and keeps it in process memory only. It verifies the entire frozen corpus before and after and refuses credential-containing JSON writes. The original 54-request benchmark is preserved separately and was not modified or rerun.

Verification: all six HTTP statuses were 200 and all provider statuses `succeeded`; trace timestamps, stage ordering, source hash, and original corpus hashes passed validation. Python compilation passed. This is a diagnostic script change only; no extension tests/build or user-visible paint measurement is claimed.
