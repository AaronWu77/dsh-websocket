---
description: "Manage standalone GPT Responses gateways with session WebSocket reuse, incremental continuation and bounded SSE recovery."
kind: "package-bundle"
---

# dsh-Websocket

English | [中文](README.zh.md)

## Summary

Use Settings → WebSocket gateways to configure separately named GPT Responses routes, copy compatible existing provider declarations, and inspect their actual transport and upload sizes. WebSocket connections can persist across serial session requests; exact context extensions use `previous_response_id` and new input only. Safe pre-generation failures may fall back to SSE. Existing providers, selected models and subagent model permissions remain unchanged. The bundle starts with no routes and uses the existing credential service.

## Table of contents

- [Settings and adoption](#settings-and-adoption)
- [Continuation and isolation](#continuation-and-isolation)
- [Recovery and cleanup](#recovery-and-cleanup)
- [Configuration](#configuration)
- [Development and verification](#development-and-verification)
- [Model experience](#model-experience)
- [Known limitations](#known-limitations)
- [Upgrade from 0.3](#upgrade-from-03)

## Settings and adoption

Install this bundle with Harness Plugin Manager after building and validating it. Settings → WebSocket gateways separates saved settings from recent requests. Choose a route from the desktop list or narrow-screen selector, edit its connection or models, and open advanced controls only when needed. Saving applies to new calls; admitted and prepared calls retain their captured configuration. Replacing a credential does not interrupt active calls. Deleting a route does not delete history or the original provider.

Import previews local GPT Responses models without network requests. The preview identifies each context window and output token limit as model configuration, catalog metadata, a route default, or a built-in default. Copy a compatible source into a new route such as `source-ws`, or select missing models to add to an existing route on the same endpoint. Merging preserves the target credentials and settings. Unsupported model capabilities or unresolved limits need correction before importing. Import is a one-time copy: the preview does not verify WebSocket support, and later source changes do not sync automatically.

Credentials use named references, and the page can store a replacement through DSH's credential service. Secrets and stored header values are not returned to the browser. A blank header editor retains stored values; `{}` clears them. All mutations are revision-checked. Conflicts retain the draft. The management tool `websocket_gateway` shares describe/save/import/delete/refresh/reset operations; credential entry and billable verification remain owner-UI-only.

Saved routes with model discovery enabled can refresh `${baseURL}/models` without inference. A failed refresh retains the last successful catalog and reports the failure; successful changes update the chat model selector. Explicit models win over discovered ids. `discovery.exclude` filters discovered ids only; remove an explicit model row to stop explicitly advertising it. Discovery supplies declared metadata because model-list endpoints do not establish context windows or reasoning capabilities. Explicit reasoning selections override the optional route default; omitting `reasoning` does not select the first advertised effort.

Recent requests lists the latest five requests across gateways, including auxiliary calls. Open the controls below the list to filter or refresh, or expand a card for diagnostics. Filter all routes or include auxiliary calls to inspect more of the current process. Each card shows the final outbound attempt; details list every attempt, including the reasoning effort and output token limit when present. Reported token usage separates uncached input, output, cache reads, and cache writes; a dash means the gateway did not report a usable value. An SSE attempt is labeled as a fallback only if a WebSocket failure triggered it. Attempts also record full/incremental mode and safe failure codes. A failed history match reports prefix lengths and the first differing item type or allowlisted field presence, without recording payload values. Upload sizes count UTF-8 application JSON, including fallback and continuation-rebuild attempts. The reduction compares each recorded attempt with its equivalent full request; it is limited to retained recent requests, excludes transport framing/handshakes/TLS, and is not a billing estimate. Refresh status reads metadata only. The explicit verification action confirms permission before two small synthetic inference rounds; it checks remembered random text, WS use and incremental second-round dispatch without sending chat history.

## Continuation and isolation

A live connection belongs to a route configuration generation, credential/header identity, model and session. Auxiliary requests without a main-session identity use request-owned connections. A busy session connection is not shared: a concurrent call uses a separate full-context SSE request. The adapter never multiplexes unrelated responses into one parser.

The first round sends the complete pi-ai-serialized input. A completed response contributes its id and output fingerprints to a bounded, memory-only head. A later request uses a delta only when its full serialized input is an exact extension of that known input plus output and its request controls/tools match. The comparison normalizes completed function-call status, parsed function arguments, and empty assistant output-text `logprobs`. The transmitted items are not changed. Message phase, reasoning signatures, nonempty response metadata, item ids and array order remain significant. Unrecognized or mismatched output, compaction, edits and image offloading cause full-context rebuilds, not approximate prefix reuse. Session history remains complete and authoritative.

New connections cannot assume the previous connection's `store: false` cache exists. An explicit pre-generation `previous_response_not_found` rejection permits at most one full-context resend; ambiguous disconnects do not. Connection retention and incremental continuation are separate options. Disabling continuation still permits socket reuse; disabling reuse closes the socket with each request. Idle and maximum-age deadlines release pooled connections, and limits bound retained connections and history fingerprints.

## Recovery and cleanup

`auto` falls back to SSE only before a generation request is sent, after recognized connection failure, handshake timeout or HTTP 404/405/426/501 upgrade refusal. Authentication, quota, rate-limit and invalid-request failures do not switch protocols. Unconfirmed generation after sending, including partial-output disconnect or idle timeout, is `OUTCOME_UNKNOWN`: it may already have been billed and is not silently resent. Explicit cancellation remains cancellation.

Eligible WS failures count even when same-attempt SSE fallback succeeds. After `fallbackAfterFailures` failures, new attempts use SSE for `fallbackCooldownMs`. Expiry does not start background work: one subsequent request probes WS while concurrent requests stay on SSE. WS success resets the circuit; SSE success does not. Authentication and quota errors do not count as WS connection faults. Only finite retry policies excluding unknown outcomes and permanent refusals are accepted; the existing DSH retry executor owns transient retries.

A structured Responses `server_error` on a failed WS/SSE terminal, or a standalone WS error frame after submission, reports `UPSTREAM_SERVER_ERROR`. It does not count as a connection failure, change protocols, or trigger automatic replay, even when no output was received. A rate-limit error in a generation terminal is likewise not replayed (`UPSTREAM_RATE_LIMIT`). An HTTP 5xx that rejects the WS upgrade before a generation is sent remains `SERVER` and can use the configured finite retry policy. Request details show allowlisted provider error codes without storing provider error text.

Each request owns its cancellation and parser. Successful terminals return healthy connections to the pool; cancellation, consumer return and failed streams close the affected socket. Plugin disposal rejects new calls, drains admitted iterators including paused consumers, and closes idle connections. Cleanup failures are surfaced in diagnostics and logs. Settings reset closes idle connections and resets cooling without interrupting active requests. No global fetch, dispatcher, WebSocket constructor or server prototype is replaced.

## Configuration

The entry's `providers` dictionary is live-editable; its keys are new provider ids, not aliases for existing routes. Each declaration requires `baseURL`, `apiKeyEnv`, and explicit GPT `models` or `discover: true`. Explicit models require `id`, `contextWindow`, `maxTokens`; optional `input` defaults to text and `reasoningEfforts` defaults to none. Only `gpt-` and `openai/gpt-` ids are accepted. Model and route metadata must match the actual gateway.

| Field | Default | Meaning |
| --- | --- | --- |
| `transport` | `auto` | WS preferred or `sse` only |
| `requestFormat` | `standard` | `codex` encodes leading developer instructions as typed Responses input blocks and makes automatic tool choice explicit when tools exist. Keeps the gateway endpoint, credentials, session cache key, continuation and SSE fallback; no Codex Connect dependency. `codex-instructions` instead moves the first developer message into top-level `instructions` from the first request and sends it on every frame, including deltas. Use it on a separate route; cache behavior is provider-dependent. |
| `clientMetadata` | `off` | `codex` merges `client_metadata.session_id` from the request's DSH session into every WebSocket `response.create` frame, including continuation deltas, so a gateway can keep one upstream session and prompt-cache key. SSE fallback bodies and continuation fingerprints stay unchanged. Enable it only for gateways that accept unknown request fields. |
| `reuseConnection`, `continuation` | `true` | Independent retention and delta controls |
| `connectionIdleMs`, `connectionMaxAgeMs` | `300000`, `3000000` | Idle/max age; maximum configured age is below 60 minutes |
| `maxConnections`, `maxContinuationBytes` | `8`, `1048576` | Retained connections per route generation / fingerprint bytes per connection |
| `fallbackAfterFailures`, `fallbackCooldownMs` | `5`, `300000` | WS fault threshold / SSE cooling; threshold 0 disables cooling |
| `websocketConnectTimeoutMs`, `closeTimeoutMs`, `streamIdleTimeoutMs` | `10000`, `2000`, `300000` | Handshake, close and response idle deadlines |
| `maxFrameBytes`, `maxBufferedEvents` | `8388608`, `128` | Received WS frame / bounded queued events |
| `diagnosticsLimit` | `100` | Recent request records retained in memory |
| `discovery.ttlMs`, `discovery.timeoutMs` | `300000`, `10000` | Discovery cache / request deadline |
| `discovery.contextWindow`, `discovery.maxTokens` | `500000`, `128000` | Declared metadata for discovered ids |
| `discovery.maxResponseBytes`, `discovery.maxModels` | `4194304`, `1000` | Response-byte / entry limits for model discovery |
| `retryPolicy` | DSH finite normal policy | The UI exposes a finite maximum retry count |

Image byte/count/pixel limits, custom headers, maximum-output compatibility and discovery metadata are editable in advanced sections. Config validates before registration. Unknown fields, duplicate capabilities, unsafe retry codes and an unsupported route-wide reasoning default reject activation or saving.

## Development and verification

Development links assume `<DSH checkout>/local-plugins/plugins/<this directory>`. The standalone package owns all implementation and test changes; no DSH source changes are required. The client factory uses the running GUI's React, locale, theme and slots. Owner-only authenticated Connection routes call the same Host management implementation as the tool. See [adapter](src/adapter.ts), [transport](src/transport.ts), [continuation](src/continuation.ts), [management](src/management.ts) and [client](src/client.js).

```text
pnpm run build
pnpm run build:check
pnpm test
pnpm run test:profile
pnpm run test:lifecycle
```

`test:lifecycle` allocates a token-guarded temporary HMR profile and exercises install, old-to-new upgrade, failed-install recovery, queued-save/disposal contention, paused-stream unload and removal across fresh processes. It never targets the current GUI profile. It expects the old package in sibling `gpt-ws-gateway`, or `GATEWAY_PREVIOUS_BUNDLE`; `GATEWAY_CANDIDATE_BUNDLE` can select an immutable packed candidate. On this Windows/pnpm combination the test sets `UV_THREADPOOL_SIZE=1` only in its child processes to avoid pnpm's parallel parent-directory cleanup race. This is a tested workaround, not a fix to pnpm or proof that an in-place live upgrade is safe. Do not automatically remove or replace the running plugin; stage the verified artifact, obtain explicit deployment permission and plan a stopped-process upgrade with rollback available.

The scratch profile explicitly denies install scripts from `@google/genai@2.21.0` and `protobufjs@7.6.6`, unrelated transitive SDK dependencies of the OpenAI-only fixture; it does not approve scripts. A real installation with undecided build policies can stop for a user decision. Do not copy the test policy into the running profile or approve builds automatically.

Tests use loopback HTTP/WS listeners with dynamic ports, deterministic circuit clocks, actual pi-ai serialization, emitted-client component tests and scratch-profile Loader/management checks. `test:profile` uses a built DSH CLI; `GPT_GATEWAY_DSH_BIN` can select its path. Synthetic keys and isolated state prevent real-account inference. A passing local test does not establish support by a real gateway. The existing icon is retained; [LICENSE](LICENSE) covers original plugin code and SDKs retain their licenses.

## Model experience

The management tool adds a bounded schema to agents whose composition provides tools; there is no additional system prompt or user message. Model history, tools, images and reasoning remain serialized by DSH/pi-ai. WS and SSE use the same Responses parser. Continuation changes uploaded JSON, not the authoritative history or billing rules. `store: false` remains unchanged. Native replay metadata can degrade when switching from an original adapter to a new WS route. A reasoning default can affect latency and token usage; no cost or latency reduction is guaranteed.

## Known limitations

Only ordinary API-key GPT Responses routes are supported, not Codex OAuth, Chat Completions-only servers, other model families, proxies or shared-socket multiplexing. Import is deliberately conservative and is a snapshot, not a live reference to another adapter. Original providers keep their proxy and auth behavior; proxy-required routes must not be copied into this direct-only plugin. Server model metadata, WS cache lifetime and continuation compatibility require gateway-specific acceptance.

Continuation is memory-only and conservative. Process restart, credential/header changes or unmatched serialization rebuild full context. There is no cross-restart socket recovery or resumption of an in-flight generation. Diagnostic records are not durable session history; the full conversation remains in DSH. Real-account and rendered-browser acceptance must be reported separately from simulated and component checks. Disable this bundle or select the original provider to roll back.

## Upgrade from 0.3

Existing separately named routes and credentials remain valid. Session requests now retain connections and attempt exact incremental continuation by default; set `reuseConnection: false` and `continuation: false` for request-owned behavior. WS faults that successfully fell back to SSE now count toward cooling; authentication faults do not. Truncated generations are unknown outcomes rather than transient transport retries. Replace `retryPolicy.mode: always` or unsafe retry-code lists with a finite normal policy before upgrading. No provider ids or session data are migrated automatically.
