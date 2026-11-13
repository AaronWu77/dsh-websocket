---
description: "An opt-in bundle for separately named GPT Responses gateways using WebSocket first and bounded SSE fallback."
kind: "package-bundle"
---

# dsh-Websocket

English | [中文](README.zh.md)

## Summary

This Host-only bundle registers explicitly configured GPT Responses routes without changing DSH, Codex Connect, DeepSeek, or existing provider routes. Each model request prefers WebSocket in `auto` mode and may fall back to SSE before a generation request has been sent. Connections belong to one request and are closed before its terminal result. The default bundle declares no gateways; credentials are referenced through DSH's credential service.

## Table of contents

- [Use this package](#use-this-package)
- [Failures and cleanup](#failures-and-cleanup)
- [Implementation](#implementation)
- [Model experience](#model-experience)
- [Known limitations](#known-limitations)

## Use this package

Build this standalone package, validate it, and install its bundle through Harness Plugin Manager. Configure its plugin entry with a new route id rather than replacing an existing provider. This local candidate is not a claim of live gateway or production-profile acceptance; perform that acceptance before changing the default model.

Development links in the manifest assume this repository is located at `<DSH checkout>/local-plugins/plugins/dsh-websocket` and contain no machine-specific absolute paths. `pnpm run test:profile` uses a built DSH CLI; `GPT_GATEWAY_DSH_BIN` can select that entry explicitly. The profile test uses synthetic credentials and loopback endpoints, not a real account.

```yaml
providers:
  my-gateway-ws:
    displayName: My GPT gateway
    baseURL: https://gateway.example.invalid/v1
    apiKeyEnv: GATEWAY_API_KEY
    transport: auto
    discover: true
    discovery:
      contextWindow: 500000
      maxTokens: 128000
      input: [text, image]
      reasoningEfforts: [high, xhigh, max]
    models:
      - id: gpt-example
        contextWindow: 500000
        maxTokens: 128000
        input: [text, image]
        reasoningEfforts: [high, xhigh, max]
```

The example is a declaration template, not a working endpoint. Store the key through the existing credential service, not in the bundle. `transport: sse` disables WS for that route. Only `gpt-` or `openai/gpt-` model ids are accepted; non-GPT ids, duplicate capabilities and unsupported configuration fields fail before route registration. Model effort names must match the gateway's actual Responses capabilities.

With `discover: true`, the adapter also reads `${baseURL}/models` and appends every GPT text id that `models` does not list; image, audio, embedding and similar non-text ids are ignored. Explicit entries win and override metadata; `discovery.exclude` names ids the gateway lists but this route should not offer. The gateway model list carries no context-window or reasoning-level metadata, so `discovery` supplies defaults for discovered ids; add an explicit entry when a new model differs. Discovery is cached for `ttlMs`, a failure keeps the explicit models and logs a safe warning, and discovery is off by default.

The schema exposes handshake, stream-idle and close timeouts, frame and event-queue limits, image limits, and the ordinary DSH `retryPolicy`. Omitted retry policy uses DSH's finite normal policy; the plugin adds no separate retry loop. Existing provider routes remain available for rollback. The plugin does not change the selected model or subagent model allowlist.

## Failures and cleanup

`auto` can fall back after a recognized connection failure, an upgrade timeout, or an HTTP 404/405/426/501 upgrade rejection before sending `response.create`. Authentication failures, rate limits, cancellation and rejected generation requests do not trigger protocol switching. The same credential, endpoint and serialized request are retained for SSE; transport-only `stream` and `background` fields are removed only from the WS event.

After sending a generation request, a connection drop with no provider event is `OUTCOME_UNKNOWN`, not a hidden SSE retry: generation may already be billed. Once provider events arrive, a truncated response fails without concatenating a second generation. The DSH adapter preserves stable transport failure codes so the existing retry policy owns any subsequent attempt.

Each request owns its connection, cancellation signal and bounded event queue. Normal completion, consumer return, cancellation and plugin disposal close owned sockets; disposal stops admission and waits for admitted iterators, including paused consumers. A close deadline terminates only this request's socket. A failure to finish cleanup is reported rather than treated as success.

Host diagnostics report route, selected transport, connection or fallback phase and safe failure code. They do not log keys, headers, prompts or response bodies. No global fetch, WebSocket constructor, dispatcher or server prototype is replaced.

## Implementation

[The manifest](package.json) declares the bundle and explicit SDK dependencies. [The patch](cordis.patch.yml) inserts one Host plugin with an empty route dictionary. [The adapter](src/adapter.ts) reuses DSH's public `PiAiAdapter` and a request-owned pi-ai Provider. [The transport](src/transport.ts) injects a scoped Fetch implementation into the existing Responses serializer and parser, using the official OpenAI Responses WS client and `ws` underneath.

```text
pnpm run build
pnpm run build:check
pnpm test
```

Tests use real loopback HTTP and WS listeners with dynamically allocated ports and deterministic teardown. A passing loopback test does not establish support by a real gateway. [The license](LICENSE) covers this plugin's original code; SDKs retain their own licenses. No implementation is copied from dsh-ws-deflate.

## Model experience

The plugin adds no system prompt, tool definition or user message. DSH and pi-ai continue to serialize history, images, thinking options and tool calls. WS and SSE feed the same Responses parser; usage precedes the terminal result. Moving a conversation to a newly registered route can discard provider-native replay metadata from the old adapter and change cache hits; history is not migrated or deleted. WS does not guarantee reduced token billing or lower latency.

## Known limitations

The first version does not pool connections or use WS continuation caches across requests. Every model call performs a fresh handshake. It supports ordinary API-key Responses gateways, not Codex OAuth or Chat Completions-only servers. Gateway-specific headers and model capabilities require explicit configuration.

Discovered models use `discovery` defaults because the gateway's `/v1/models` response does not provide context windows or reasoning levels. Discovery needs an OpenAI-compatible `/v1/models` endpoint and a resolvable credential; it does not make a model available if the gateway omits it, and a running process only refreshes after `ttlMs`.

This version has no per-route proxy integration and does not inherit Codex Connect's proxy manager. Use it only for routes intended to connect directly. It neither changes nor bypasses a configured proxy on an existing provider: those original routes remain separate and untouched. Do not adopt a proxy-required route into this plugin until explicit proxy support is implemented and tested.

Real-account inference, browser presentation and active-profile installation require separate acceptance. Plugin API compatibility is pinned to the manifest's supported versions; DSH upgrades still require plugin compatibility checks. Switching back to the original provider or to `transport: sse` is the rollback path.
