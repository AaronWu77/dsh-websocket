---
description: "为独立命名的 GPT Responses 网关提供 WebSocket 优先与受控 SSE 回退的可选插件包。"
kind: "package-bundle"
---

# dsh-Websocket

[English](README.md) | 中文

## 概述

这个仅含 Host 代码的插件包注册明确配置的 GPT Responses 路由，不修改 DSH、Codex Connect、DeepSeek 或任何现有提供商路由。每次模型请求在 `auto` 模式优先使用 WebSocket，并可在生成请求尚未发送时回退 SSE。连接归属于单次请求，并在终止结果之前关闭。默认插件包不声明任何网关；凭据通过 DSH 凭据服务引用。

## 目录

- [使用方法](#使用方法)
- [失败与清理](#失败与清理)
- [实现](#实现)
- [模型体验](#模型体验)
- [已知限制](#已知限制)

## 使用方法

构建并验证这个独立包后，通过 Harness 插件管理器安装其 bundle。配置插件条目时使用新的路由 id，不替换已有提供商。这个本地候选版本不代表真实网关或生产 profile 已验收；更改默认模型前应先完成验收。

清单中的开发依赖链接要求将本仓库放在 `<DSH checkout>/local-plugins/plugins/dsh-websocket`，不包含机器专属的绝对路径。`pnpm run test:profile` 使用构建好的 DSH CLI，也可以通过 `GPT_GATEWAY_DSH_BIN` 明确指定该入口。profile 测试使用虚构凭据与本地回环端点，不使用真实账号。

```yaml
providers:
  my-gateway-ws:
    displayName: My GPT gateway
    baseURL: https://gateway.example.invalid/v1
    apiKeyEnv: GATEWAY_API_KEY
    transport: auto
    # reasoning: high  # 请求未选择档位时可选的路由默认值。
    discover: true
    discovery:
      contextWindow: 500000
      maxTokens: 128000
      input: [text, image]
      reasoningEfforts: [high, xhigh, max]
    fallbackAfterFailures: 5
    fallbackCooldownMs: 300000
    models:
      - id: gpt-example
        contextWindow: 500000
        maxTokens: 128000
        input: [text, image]
        reasoningEfforts: [high, xhigh, max]
```

示例是配置模板，不是可用的实际地址。通过已有凭据服务保存密钥，不要写入插件包。`transport: sse` 为该路由关闭 WS。只接受 `gpt-` 或 `openai/gpt-` 模型 id；非 GPT id、重复能力和未支持的配置字段会在注册路由前报错。思考等级必须符合网关实际支持的 Responses 能力。

`reasoning` 可在请求未选择档位时提供路由默认值；请求中显式指定的档位优先。省略该字段会保留原有的提供商默认行为：`reasoningEfforts` 仅声明能力，不会自动选择第一项。默认值必须被每个显式模型以及已启用的自动发现元数据模板支持；无效默认值会在注册路由前报错。

Responses 使用 `reasoning.effort` 传递所选档位，WS 的 `response.create` 事件也一样；插件不伪造 `reasoning_effort` 别名。现有模型声明不向具备思考能力的模型提供 `off`。对未声明思考能力的模型，`off` 表示省略档位，不会强制向上游发送 `none`，也不承诺服务端关闭思考。

`discover: true` 时，适配器还会读取 `${baseURL}/models`，把 `models` 未列出的 GPT 文本模型 id 自动追加进来；图片、音频、embedding 等非文本 id 会被忽略。显式条目优先并覆盖元数据；`discovery.exclude` 可列出网关有、但本路由不应提供的 id。网关的模型列表不提供上下文窗口或思考等级，因此发现模型使用 `discovery` 默认值；新模型元数据不同时应补一条显式覆盖。发现结果按 `ttlMs` 缓存，失败时保留显式模型并记录安全告警；默认关闭。

连续 `fallbackAfterFailures` 次 WebSocket 失败后（默认 5 次；0 表示关闭），该路由在 `fallbackCooldownMs` 内改用 SSE（默认 5 分钟）。冷却到期后只重新探测一次 WebSocket：成功则清零失败计数，失败则重新进入 SSE 冷却。已经在同一次请求内成功回退到 SSE 的失败不计数。

配置模式提供握手、流空闲与关闭超时、帧和事件队列限制、图片限制及普通 DSH `retryPolicy`。省略重试策略时沿用 DSH 的有限 normal 策略，插件不增加独立的重试循环。原有提供商路由保留用于回滚。插件不会更改已选模型或子智能体模型允许列表。

## 失败与清理

`auto` 可在已识别的连接失败、升级超时，或发送 `response.create` 前收到 HTTP 404/405/426/501 升级拒绝时回退。认证失败、限流、取消和生成请求被拒绝不会触发协议切换。SSE 使用同一凭据、地址和序列化请求；仅在 WS 事件中移除传输专用的 `stream`、`background` 字段。

生成请求已发送但尚无提供商事件时，断连被标记为 `OUTCOME_UNKNOWN`，不隐藏重发 SSE：生成可能已经计费。收到提供商事件后的响应截断会失败，不会拼接第二次生成。DSH 适配器保留稳定的传输失败代码，由已有重试策略决定是否进行后续尝试。

每次请求拥有自己的连接、取消信号和有界事件队列。正常结束、消费者返回、取消和插件卸载会关闭所属 socket；卸载停止接纳请求并等待已接纳的迭代器，包括暂停的消费者。关闭超时只终止本请求拥有的 socket。清理无法完成时报告失败，而不当作成功。

Host 诊断记录路由、所选传输、连接或回退阶段和安全的失败代码，不记录密钥、请求头、提示或响应正文。不替换全局 fetch、WebSocket 构造函数、dispatcher 或服务器原型。

## 实现

[包清单](package.json)声明 bundle 和显式 SDK 依赖。[补丁](cordis.patch.yml)插入一个路由字典为空的 Host 插件。[适配器](src/adapter.ts)复用 DSH 公开的 `PiAiAdapter` 和请求级 pi-ai Provider。[传输实现](src/transport.ts)向现有 Responses 序列化与解析流程注入请求级 Fetch，使用官方 OpenAI Responses WS 客户端及其底层 `ws`。

```text
pnpm run build
pnpm run build:check
pnpm test
```

测试使用真实回环 HTTP 与 WS 监听器、动态分配端口和确定性清理。本地回环测试通过不代表真实网关支持已经验证。[许可](LICENSE)适用于本插件原创代码，SDK 保留各自许可。没有复制 dsh-ws-deflate 的实现。

## 模型体验

插件不增加系统提示、工具定义或用户消息。DSH 与 pi-ai 继续序列化历史、图片、思考选项和工具调用。WS 与 SSE 使用相同的 Responses 解析器；usage 在终止结果之前提供。对话切换到新路由时可能丢弃旧适配器的提供商原生 replay 元数据并改变缓存命中，但不会迁移或删除历史。WS 不保证降低 token 费用或延迟。配置的默认思考档位与显式档位选择相同的上游参数，可能影响 token 用量和延迟。

## 已知限制

第一版不跨请求共享连接或 WS continuation 缓存，每次模型调用重新握手。它支持普通 API Key Responses 网关，不支持 Codex OAuth 或仅提供 Chat Completions 的服务器。网关特定请求头与模型能力需要明确配置。

发现模型使用 `discovery` 默认值，因为网关的 `/v1/models` 不提供上下文窗口或思考等级。自动发现需要兼容的 `/v1/models` 端点与可解析凭据；网关未列出某个模型时不会凭空出现，运行中的进程也只在 `ttlMs` 到期后刷新。

当前版本没有逐路由代理集成，也不继承 Codex Connect 的代理管理器。仅用于明确允许直连的路由。它不会更改或绕过已有提供商已配置的代理：原有路由保持独立且不变。在实现并验证显式代理支持前，不应将必须使用代理的路由接入本插件。

真实账号推理、浏览器展示和活动 profile 安装需要单独验收。插件 API 兼容性限定于清单声明的版本；升级 DSH 后仍需检查插件兼容性。回滚方式是选回原有提供商或设为 `transport: sse`。
