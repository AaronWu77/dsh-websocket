/** Public DSH adapter integration over request-owned pi-ai Providers and transports. */
import { defaultProviderAuthContext, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Provider, ProviderRequestOptions } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GatewayRoute } from './config.ts'
import { ResponsesTransport } from './transport.ts'

/** The host supplies credential, image and header integrations through public APIs. */
export interface GatewayAdapterOptions {
  resolveApiKey: PiAiAdapterOptions['resolveApiKey']
  resolveAttachments?: PiAiAdapterOptions['resolveAttachments']
  resolveImageAccess?: PiAiAdapterOptions['resolveImageAccess']
  prepareHeaders?: PiAiAdapterOptions['prepareHeaders']
  onReplayDegrade?: PiAiAdapterOptions['onReplayDegrade']
  report: (provider: string, event: Parameters<ConstructorParameters<typeof ResponsesTransport>[0]['report']>[0]) => void
}

interface RequestState { transport?: ResponsesTransport; started: boolean }
interface Lease { cancel: () => Promise<void>; settled: Promise<void> }

/**
 * Serve only explicitly configured GPT models. Native replay and content conversion remain pi-ai-owned.
 * Disposal rejects new calls, cancels admitted iterators and waits for their socket cleanup.
 */
export class GatewayAdapter extends LlmAdapter {
  private readonly auth = { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() }
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Lease>()
  private disposing?: Promise<void>

  constructor(private readonly routes: ReadonlyMap<string, GatewayRoute>, private readonly options: GatewayAdapterOptions) { super() }

  private route(id: string): GatewayRoute {
    const route = this.routes.get(id)
    if (route === undefined) throw new LlmError(`The GPT gateway plugin does not own route "${id}".`, 'NO_ADAPTER')
    return route
  }

  private native(route: GatewayRoute, state: RequestState): PiAiAdapter {
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
      getModels: () => route.models,
      stream: (model, context, options) => streams.stream(model, context, { ...options, fetch: requestFetch(options), maxRetries: 0 }),
      streamSimple: (model, context, options) => streams.streamSimple(model, context, { ...options, fetch: requestFetch(options), maxRetries: 0 }),
    }
    const profiles = new Map([[route.id, { ...route.profile, piProvider: provider }]])
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
    return this.native(this.route(provider), { started: false }).imageRequestTarget(provider, model, image)
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.route(provider).models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: [...model.input] })))
  }
  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    return this.native(this.route(provider), { started: false }).resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    const route = this.route(provider)
    const state: RequestState = { started: false }
    const native = this.native(route, state)
    const prepared = await native.prepareCall(provider, model, signal)
    return { model: prepared.model, stream: options => this.owned(prepared.stream, options, state) }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const state: RequestState = { started: false }
    const native = this.native(this.route(options.provider), state)
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
