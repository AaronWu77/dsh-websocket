/** Public DSH adapter integration over request-owned pi-ai Providers and transports. */
import { defaultProviderAuthContext, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Provider, ProviderRequestOptions } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Model } from '@earendil-works/pi-ai'
import { createGatewayModel } from './config.ts'
import type { GatewayRoute } from './config.ts'
import { ResponsesTransport } from './transport.ts'

/** The host supplies credential, image and header integrations through public APIs. */
export interface GatewayAdapterOptions {
  resolveApiKey: PiAiAdapterOptions['resolveApiKey']
  resolveAttachments?: PiAiAdapterOptions['resolveAttachments']
  resolveImageAccess?: PiAiAdapterOptions['resolveImageAccess']
  prepareHeaders?: PiAiAdapterOptions['prepareHeaders']
  onReplayDegrade?: PiAiAdapterOptions['onReplayDegrade']
  onDiscoveryError?: (provider: string, message: string) => void
  report: (provider: string, event: Parameters<ConstructorParameters<typeof ResponsesTransport>[0]['report']>[0]) => void
}

interface RequestState { transport?: ResponsesTransport; started: boolean }
interface Lease { cancel: () => Promise<void>; settled: Promise<void> }
interface DiscoveryState { models: readonly Model<'openai-responses'>[]; expiresAt: number; pending?: Promise<void> }

const GPT_MODEL_ID = /^(?:openai\/)?gpt-/i

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Serve only explicitly configured GPT models. Native replay and content conversion remain pi-ai-owned.
 * Disposal rejects new calls, cancels admitted iterators and waits for their socket cleanup.
 */
export class GatewayAdapter extends LlmAdapter {
  private readonly auth = { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() }
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Lease>()
  private readonly discoveries = new Map<string, DiscoveryState>()
  private disposing?: Promise<void>

  constructor(private readonly routes: ReadonlyMap<string, GatewayRoute>, private readonly options: GatewayAdapterOptions) { super() }

  private route(id: string): GatewayRoute {
    const route = this.routes.get(id)
    if (route === undefined) throw new LlmError(`The GPT gateway plugin does not own route "${id}".`, 'NO_ADAPTER')
    return route
  }

  private modelsFor(route: GatewayRoute): readonly Model<'openai-responses'>[] {
    const discovered = this.discoveries.get(route.id)?.models ?? []
    return discovered.length === 0 ? route.models : [...route.models, ...discovered]
  }

  private async allModels(route: GatewayRoute): Promise<readonly Model<'openai-responses'>[]> {
    if (!route.config.discover) return route.models
    const state = this.discoveries.get(route.id) ?? { models: [], expiresAt: 0 }
    this.discoveries.set(route.id, state)
    if (Date.now() >= state.expiresAt && state.pending === undefined) {
      state.pending = this.loadDiscovered(route, state).finally(() => { state.pending = undefined })
    }
    await state.pending
    return this.modelsFor(route)
  }

  private async loadDiscovered(route: GatewayRoute, state: DiscoveryState): Promise<void> {
    try {
      const apiKey = await this.options.resolveApiKey(route.id, route.profile)
      if (apiKey === undefined) throw new LlmError(`The GPT gateway credential for "${route.id}" was not resolved.`, 'MISSING_CREDENTIAL')
      const url = `${route.config.baseURL.replace(/\/+$/u, '')}/models`
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(route.config.discovery.timeoutMs)])
      const response = await fetch(url, {
        headers: { ...route.config.headers, authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw new Error(`model discovery for "${route.id}" returned HTTP ${response.status}`)
      const body = record(await response.json())
      const entries = body !== undefined && Array.isArray(body.data) ? body.data : []
      const explicit = new Set(route.models.map(model => model.id))
      const models: Model<'openai-responses'>[] = []
      for (const entry of entries) {
        const item = record(entry)
        const id = item?.id
        if (typeof id !== 'string' || !GPT_MODEL_ID.test(id) || explicit.has(id) || models.some(model => model.id === id)) continue
        const displayName = typeof item?.display_name === 'string' && item.display_name.length > 0 ? item.display_name : id
        const discovery = route.config.discovery
        models.push(createGatewayModel(route.id, route.config, id, displayName, discovery.contextWindow, discovery.maxTokens, discovery.input, discovery.reasoningEfforts))
      }
      state.models = models
      state.expiresAt = Date.now() + route.config.discovery.ttlMs
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) return
      state.expiresAt = Date.now() + Math.min(route.config.discovery.ttlMs, 60_000)
      this.options.onDiscoveryError?.(route.id, error instanceof Error ? error.message : String(error))
    }
  }

  private native(route: GatewayRoute, state: RequestState, models: readonly Model<'openai-responses'>[] = route.models): PiAiAdapter {
    const streams = openAIResponsesApi()
    const requestFetch = (options: ProviderRequestOptions | undefined): typeof globalThis.fetch => {
      if (state.transport !== undefined) throw new LlmError('A GPT gateway request cannot start a second native stream.', 'INVALID_PREPARED_CALL')
      if (options?.apiKey === undefined) throw new LlmError('The GPT gateway credential was not resolved.', 'MISSING_CREDENTIAL')
      const cfg = route.config
      state.transport = new ResponsesTransport({
        mode: cfg.transport, baseURL: cfg.baseURL, apiKey: options.apiKey,
        signal: options.signal ?? this.lifetime.signal,
        connectTimeoutMs: cfg.websocketConnectTimeoutMs, closeTimeoutMs: cfg.closeTimeoutMs,
        maxFrameBytes: cfg.maxFrameBytes, maxBufferedEvents: cfg.maxBufferedEvents,
        report: event => this.options.report(route.id, event),
      })
      return state.transport.fetch
    }
    const provider: Provider = {
      id: route.id, name: route.profile.displayName, baseUrl: route.config.baseURL,
      auth: { apiKey: { name: 'Gateway credential', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'gateway-credential' }) } },
      getModels: () => models,
      stream: (model, context, options) => streams.stream(model, context, { ...options, fetch: requestFetch(options), maxRetries: 0 }),
      streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, fetch: requestFetch(options), maxRetries: 0 }),
    }
    const configuredMaxTokens = new Map(route.profile.configuredMaxTokens)
    for (const model of models) {
      if (!configuredMaxTokens.has(model.id)) configuredMaxTokens.set(model.id, model.maxTokens)
    }
    const profiles = new Map([[route.id, { ...route.profile, configuredMaxTokens, piProvider: provider }]])
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: this.options.resolveApiKey,
      auth: this.auth,
      resolveAttachments: this.options.resolveAttachments,
      resolveImageAccess: this.options.resolveImageAccess,
      prepareHeaders: this.options.prepareHeaders,
      onReplayDegrade: this.options.onReplayDegrade,
    })
  }

  override providerInfo(provider: string) { return { id: provider, name: this.route(provider).profile.displayName } }
  override providerRetryPolicy(provider: string) { return this.route(provider).profile.retryPolicy }
  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const route = this.route(provider)
    return this.native(route, { started: false }, this.modelsFor(route)).imageRequestTarget(provider, model, image)
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.route(provider)
    const models = await this.allModels(route)
    return models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...model.input] }))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const route = this.route(provider)
    const models = await this.allModels(route)
    signal?.throwIfAborted()
    return this.native(route, { started: false }, models).resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    const route = this.route(provider)
    const models = await this.allModels(route)
    const state: RequestState = { started: false }
    const native = this.native(route, state, models)
    const prepared = await native.prepareCall(provider, model, signal)
    return { model: prepared.model, stream: options => this.owned(prepared.stream, options, state) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.route(options.provider)
    const state: RequestState = { started: false }
    const native = this.native(route, state, this.modelsFor(route))
    return this.owned(request => native.stream(request), options, state)
  }

  private owned(dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>, options: GenerateOptions, state: RequestState): AsyncIterableIterator<StreamChunk> {
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    if (state.started) throw new LlmError('This prepared GPT gateway call has already been used.', 'INVALID_PREPARED_CALL')
    state.started = true
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...options.signal === undefined ? [] : [options.signal]])
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const iterator = this.forward(dispatch, { ...options, signal }, state, controller)
    let finished = false
    let terminalDelivered = false
    let consumerReturned = false
    const finish = (): void => {
      if (finished) return
      finished = true
      this.active.delete(lease)
      settle()
    }
    const owned: AsyncIterableIterator<StreamChunk> = {
      [Symbol.asyncIterator]() { return this },
      next: async () => {
        try {
          const value = await iterator.next()
          if (value.done) {
            finish()
            if (this.lifetime.signal.aborted && !consumerReturned && !terminalDelivered) {
              terminalDelivered = true
              const aborted: StreamChunk = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'The GPT gateway plugin stopped this request. Retry after enabling the plugin.' } } }
              return { done: false, value: aborted }
            }
          } else if (value.value.type === 'finish') terminalDelivered = true
          return value
        } catch (error: unknown) { finish(); throw error }
      },
      return: async () => {
        consumerReturned = true
        controller.abort(new Error('GPT gateway consumer stopped'))
        try { return await iterator.return(undefined) }
        finally { finish() }
      },
      throw: async error => {
        consumerReturned = true
        controller.abort(error)
        try { return await iterator.throw(error) }
        finally { finish() }
      },
    }
    const lease: Lease = { settled, cancel: async () => {
      controller.abort(new Error('GPT gateway plugin stopped the request'))
      try { await iterator.return(undefined) }
      finally { finish() }
    } }
    this.active.add(lease)
    return owned
  }

  private async *forward(dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>, options: GenerateOptions, state: RequestState, controller: AbortController): AsyncGenerator<StreamChunk> {
    let terminal: StreamChunk | undefined
    try {
      options.signal?.throwIfAborted()
      for await (const chunk of dispatch(options)) {
        if (chunk.type === 'finish') {
          const failure = state.transport?.failure
          terminal = failure === undefined || chunk.reason.kind !== 'error'
            ? chunk
            : { ...chunk, reason: { kind: 'error', failure: { code: failure.code, message: failure.message, ...failure.status === undefined ? {} : { status: failure.status } } } }
          break
        }
        yield chunk
      }
    } finally {
      controller.abort(new Error('GPT gateway request settled'))
      await state.transport?.close()
    }
    if (terminal !== undefined) yield terminal
  }

  /** Reject new calls and settle all accepted iterators, including consumers paused at a yield. */
  dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing
    this.lifetime.abort(new Error('GPT gateway plugin disposed'))
    const leases = [...this.active]
    this.disposing = (async () => {
      const results = await Promise.allSettled(leases.map(lease => lease.cancel()))
      await Promise.all(leases.map(lease => lease.settled))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Some GPT gateway requests could not finish cleanup.')
    })()
    return this.disposing
  }
}
