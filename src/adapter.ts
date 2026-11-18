/** Public DSH adapter integration over request-owned pi-ai Providers and transports. */
import { defaultProviderAuthContext, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Provider, ProviderRequestOptions, StreamOptions } from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Model } from '@earendil-works/pi-ai'
import { createGatewayModel } from './config.ts'
import type { GatewayRoute } from './config.ts'
import { ConnectionPool, diagnosticReasoningEffort, isResponsesTerminal, ResponsesTransport } from './transport.ts'
import type { AttemptFacts } from './transport.ts'
import { Circuit } from './circuit.ts'
import { fingerprint } from './continuation.ts'
import { randomUUID } from 'node:crypto'

/** The host supplies credential, image and header integrations through public APIs. */
export interface GatewayAdapterOptions {
  resolveApiKey: PiAiAdapterOptions['resolveApiKey']
  resolveAttachments?: PiAiAdapterOptions['resolveAttachments']
  resolveImageAccess?: PiAiAdapterOptions['resolveImageAccess']
  prepareHeaders?: PiAiAdapterOptions['prepareHeaders']
  onReplayDegrade?: PiAiAdapterOptions['onReplayDegrade']
  onDiscoveryError?: (provider: string, message: string) => void
  /** Notify the Host after an active route commits a changed discovered catalog. */
  onModelsUpdated?: (provider: string) => void
  onCircuitOpen?: (provider: string, failures: number, cooldownMs: number) => void
  onCleanupError?: (provider: string) => void
  report: (provider: string, event: Parameters<ConstructorParameters<typeof ResponsesTransport>[0]['report']>[0]) => void
}

/** Display-safe counters from one terminal response, without synthesized cache or output zeros. */
export interface RequestDiagnosticUsage {
  /** Uncached input: aggregate input less reported cache reads and writes. */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface RequestDiagnostic {
  id: string; provider: string; model: string; sessionId?: string; purpose?: string; startedAt: number; endedAt?: number
  /** Allowlisted GenerateOptions effort at adapter entry; the Host may already have applied a route default. */
  requestedReasoningEffort?: NonNullable<ReturnType<typeof diagnosticReasoningEffort>>
  outcome: 'running' | 'success' | 'error' | 'aborted'; code?: string; attempts: AttemptFacts[]
  /** One final reported snapshot, omitted entirely when no usable counters were reported. */
  usage?: RequestDiagnosticUsage
}
interface RequestState {
  transport?: ResponsesTransport; started: boolean; route?: GatewayRoute; mode?: 'auto' | 'sse'; options?: GenerateOptions
  diagnostic?: RequestDiagnostic; usage?: RequestDiagnosticUsage | undefined; circuitLease?: ReturnType<Circuit['admit']>
}
interface Lease { cancel: () => Promise<void>; settled: Promise<void> }
interface DiscoveryState { models: readonly Model<'openai-responses'>[]; expiresAt: number; pending?: Promise<void>; error?: 'discovery-failed' }

const GPT_MODEL_ID = /^(?:openai\/)?gpt-/i
const NON_TEXT_MODEL_ID = /(?:^|[-_/])(?:image|images|embedding|embeddings|audio|realtime|tts|transcribe|transcription|moderation|dall-e)(?:[-_/]|$)/i

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value === 0 ? 0 : value
}

/** The raw terminal JSON preserves field presence that pi-ai's normalized usage does not. */
function terminalUsage(response: unknown): RequestDiagnosticUsage | undefined {
  const usage = record(record(response)?.usage)
  if (usage === undefined) return undefined
  const details = record(usage.input_tokens_details)
  const cacheReadTokens = tokenCount(details?.cached_tokens)
  const cacheWriteTokens = tokenCount(details?.cache_write_tokens)
  const outputTokens = tokenCount(usage.output_tokens)
  const aggregate = tokenCount(usage.input_tokens)
  let inputTokens: number | undefined
  if (aggregate !== undefined && (usage.input_tokens_details == null || details !== undefined)
    && (details?.cached_tokens === undefined || cacheReadTokens !== undefined)
    && (details?.cache_write_tokens === undefined || cacheWriteTokens !== undefined)) {
    const uncached = aggregate - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)
    if (uncached >= 0) inputTokens = uncached
  }
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined
  return {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
  }
}

function waitWithSignal<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(value).then(result => { signal.removeEventListener('abort', aborted); resolve(result) }, error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}

/**
 * Serve only explicitly configured GPT models. Native replay and content conversion remain pi-ai-owned.
 * Disposal rejects new calls, cancels admitted iterators and waits for their socket cleanup.
 */
export class GatewayAdapter extends LlmAdapter {
  private readonly auth = { credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext() }
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Lease>()
  private readonly discoveries = new WeakMap<GatewayRoute, DiscoveryState>()
  private readonly circuits = new Map<GatewayRoute, Circuit>()
  private readonly pools = new Map<GatewayRoute, ConnectionPool>()
  private readonly recent: RequestDiagnostic[] = []
  private readonly cleanup = new Set<Promise<void>>()
  private readonly discoveryWork = new Set<Promise<void>>()
  private readonly cleanupFailures = new Set<string>()
  private disposing?: Promise<void>

  constructor(private routes: ReadonlyMap<string, GatewayRoute>, private readonly options: GatewayAdapterOptions) { super() }

  private route(id: string): GatewayRoute {
    const route = this.routes.get(id)
    if (route === undefined) throw new LlmError(`The GPT gateway plugin does not own route "${id}".`, 'NO_ADAPTER')
    return route
  }

  private modelsFor(route: GatewayRoute): readonly Model<'openai-responses'>[] {
    const discovered = this.discoveries.get(route)?.models ?? []
    return discovered.length === 0 ? route.models : [...route.models, ...discovered]
  }

  private circuit(route: GatewayRoute): Circuit {
    let circuit = this.circuits.get(route)
    if (!circuit) { circuit = new Circuit(route.config.fallbackAfterFailures, route.config.fallbackCooldownMs); this.circuits.set(route, circuit) }
    return circuit
  }
  private pool(route: GatewayRoute): ConnectionPool {
    let pool = this.pools.get(route)
    if (!pool) {
      const cfg = route.config
      pool = new ConnectionPool({ maxConnections: cfg.maxConnections, idleMs: cfg.connectionIdleMs, maxAgeMs: cfg.connectionMaxAgeMs, maxRetainedBytes: cfg.maxContinuationBytes, onCleanupError: () => { this.cleanupFailures.add(route.id); this.options.onCleanupError?.(route.id) } })
      this.pools.set(route, pool)
    }
    return pool
  }
  /** Swap future requests only; prepared calls retain their captured route generation. */
  updateRoutes(next: ReadonlyMap<string, GatewayRoute>): void {
    const stable = new Map<string, GatewayRoute>()
    for (const [id, route] of next) {
      const previous = this.routes.get(id)
      stable.set(id, previous && fingerprint(previous.config) === fingerprint(route.config) ? previous : route)
    }
    this.routes = stable
    for (let i = this.recent.length - 1; i >= 0; i--) if (!stable.has(this.recent[i]!.provider)) this.recent.splice(i, 1)
    // Weak keys isolate old admitted calls while allowing unused configuration generations to collect.
    for (const [old, pool] of this.pools) if (old !== stable.get(old.id)) {
      const task = pool.reset().then(() => {
        if (pool.snapshot().connections === 0 && this.pools.get(old) === pool) { this.pools.delete(old); this.circuits.delete(old) }
      }).catch((_error: unknown) => { this.cleanupFailures.add(old.id); this.options.onCleanupError?.(old.id) }).finally(() => this.cleanup.delete(task))
      this.cleanup.add(task)
    }
  }
  diagnostics() {
    return { routes: [...this.routes.values()].map(route => ({ provider: route.id, discoveryError: this.discoveries.get(route)?.error, circuit: this.circuit(route).snapshot(), pool: this.pools.get(route)?.snapshot() ?? { connections: 0, busy: 0, retainedBytes: 0 } })), requests: structuredClone(this.recent), cleanupFailures: [...this.cleanupFailures] }
  }
  /** Close idle connections only; current generations are never interrupted by a settings action. */
  async reset(provider: string): Promise<void> {
    const route = this.route(provider)
    this.circuit(route).reset()
    await this.pools.get(route)?.reset()
  }
  async releaseSession(provider: string, model: string, sessionId: string): Promise<void> {
    await this.pools.get(this.route(provider))?.reset(fingerprint([sessionId, model, 'agent']))
  }
  /** @param provider - Saved route id. @returns The discovered catalog or the last successful catalog on failure. */
  async refreshModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.route(provider)
    const state = this.discoveries.get(route)
    if (state && state.pending === undefined) state.expiresAt = 0
    return this.listModels(provider)
  }

  private async allModels(route: GatewayRoute): Promise<readonly Model<'openai-responses'>[]> {
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    if (!route.config.discover) return route.models
    const state = this.discoveries.get(route) ?? { models: [], expiresAt: 0 }
    this.discoveries.set(route, state)
    if (Date.now() >= state.expiresAt && state.pending === undefined) {
      const task = this.loadDiscovered(route, state).finally(() => { state.pending = undefined; this.discoveryWork.delete(task) })
      this.discoveryWork.add(task)
      state.pending = task
    }
    await state.pending
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    return [...route.models, ...state.models]
  }

  private async loadDiscovered(route: GatewayRoute, state: DiscoveryState): Promise<void> {
    let changed = false
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(route.config.discovery.timeoutMs)])
      signal.throwIfAborted()
      const apiKey = await waitWithSignal(this.options.resolveApiKey(route.id, route.profile), signal)
      signal.throwIfAborted()
      if (apiKey === undefined) throw new LlmError(`The GPT gateway credential for "${route.id}" was not resolved.`, 'MISSING_CREDENTIAL')
      const url = `${route.config.baseURL.replace(/\/+$/u, '')}/models`
      const response = await fetch(url, {
        headers: { ...route.config.headers, authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw new Error(`model discovery for "${route.id}" returned HTTP ${response.status}`)
      if (!response.body) throw new Error('Model discovery returned no body.')
      const reader = response.body.getReader()
      const buffers: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const value = await reader.read()
          if (value.done) break
          bytes += value.value.byteLength
          if (bytes > route.config.discovery.maxResponseBytes) throw new Error('Model discovery exceeded its response limit.')
          buffers.push(value.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      const body = record(JSON.parse(Buffer.concat(buffers).toString('utf8')))
      if (!body || !Array.isArray(body.data)) throw new Error('Model discovery returned an invalid model list.')
      const entries = body.data
      if (entries.length > route.config.discovery.maxModels) throw new Error('Model discovery exceeded its model limit.')
      const explicit = new Set(route.models.map(model => model.id))
      const excluded = new Set(route.config.discovery.exclude.map(id => id.toLowerCase()))
      const models: Model<'openai-responses'>[] = []
      for (const entry of entries) {
        const item = record(entry)
        const id = item?.id
        if (typeof id !== 'string' || !GPT_MODEL_ID.test(id) || NON_TEXT_MODEL_ID.test(id) || explicit.has(id) || excluded.has(id.toLowerCase()) || models.some(model => model.id === id)) continue
        const displayName = typeof item?.display_name === 'string' && item.display_name.length > 0 ? item.display_name : id
        const discovery = route.config.discovery
        models.push(createGatewayModel(route.id, route.config, id, displayName, discovery.contextWindow, discovery.maxTokens, discovery.input, discovery.reasoningEfforts))
      }
      changed = models.length !== state.models.length || models.some((model, index) => {
        const prior = state.models[index]
        return model.id !== prior?.id || model.name !== prior.name
      })
      state.models = models
      state.error = undefined
      state.expiresAt = Date.now() + route.config.discovery.ttlMs
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) return
      state.error = 'discovery-failed'
      state.expiresAt = Date.now() + route.config.discovery.ttlMs
      this.options.onDiscoveryError?.(route.id, error instanceof Error ? error.message : String(error))
      return
    }
    if (changed && !this.lifetime.signal.aborted && this.routes.get(route.id) === route) this.options.onModelsUpdated?.(route.id)
  }

  private native(route: GatewayRoute, state: RequestState, models: readonly Model<'openai-responses'>[] = route.models): PiAiAdapter {
    state.route = route
    const streams = openAIResponsesApi()
    const requestFetch = (options: ProviderRequestOptions | undefined): typeof globalThis.fetch => {
      if (state.transport !== undefined) throw new LlmError('A GPT gateway request cannot start a second native stream.', 'INVALID_PREPARED_CALL')
      if (options?.apiKey === undefined) throw new LlmError('The GPT gateway credential was not resolved.', 'MISSING_CREDENTIAL')
      const cfg = route.config
      const circuitLease = cfg.transport === 'sse' ? undefined : this.circuit(route).admit()
      const mode = circuitLease?.mode ?? 'sse'
      state.circuitLease = circuitLease
      state.route = route
      state.mode = mode
      state.transport = new ResponsesTransport({
        mode, baseURL: cfg.baseURL, apiKey: options.apiKey,
        signal: options.signal ?? this.lifetime.signal, callerSignal: state.options?.signal,
        connectTimeoutMs: cfg.websocketConnectTimeoutMs, closeTimeoutMs: cfg.closeTimeoutMs,
        maxFrameBytes: cfg.maxFrameBytes, maxBufferedEvents: cfg.maxBufferedEvents,
        report: event => this.options.report(route.id, event),
        ...cfg.reuseConnection && state.options?.sessionId && (state.options.purpose === undefined || state.options.purpose === 'agent') ? {
          pool: this.pool(route), poolKey: fingerprint([state.options.sessionId, state.options.model, state.options.purpose ?? 'agent']), continuation: cfg.continuation,
        } : {},
        onAttempt: facts => { state.diagnostic?.attempts.push(facts) },
      })
      return state.transport.fetch
    }
    const withRequestOptions = <T extends StreamOptions>(options: T | undefined) => {
      const onProviderStreamEvent: NonNullable<StreamOptions['onProviderStreamEvent']> = (data, model) => {
        const event = record(data)
        if (event && isResponsesTerminal(event.type)) state.usage = terminalUsage(event.response)
        return options?.onProviderStreamEvent?.(data, model)
      }
      return { ...options, fetch: requestFetch(options), maxRetries: 0, onProviderStreamEvent }
    }
    const provider: Provider = {
      id: route.id, name: route.profile.displayName, baseUrl: route.config.baseURL,
      auth: { apiKey: { name: 'Gateway credential', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'gateway-credential' }) } },
      getModels: () => models,
      stream: (model, context, options) => streams.stream(model, context, withRequestOptions(options)),
      streamSimple: (model, context, options) => streams.streamSimple(model, context, withRequestOptions(options)),
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
    const self = this
    return this.owned(async function* (request) {
      const models = await self.allModels(route)
      yield* self.native(route, state, models).stream(request)
    }, options, state)
  }

  private owned(dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>, options: GenerateOptions, state: RequestState): AsyncIterableIterator<StreamChunk> {
    if (this.lifetime.signal.aborted) throw new LlmError('The GPT gateway plugin is stopping.', 'ABORTED')
    if (state.started) throw new LlmError('This prepared GPT gateway call has already been used.', 'INVALID_PREPARED_CALL')
    state.started = true
    state.options = options
    const route = state.route ?? this.route(options.provider)
    const requestedReasoningEffort = diagnosticReasoningEffort(options.reasoningEffort)
    state.diagnostic = {
      id: randomUUID(), provider: options.provider, model: options.model,
      ...options.sessionId ? { sessionId: options.sessionId } : {},
      ...options.purpose ? { purpose: options.purpose } : {},
      ...requestedReasoningEffort === undefined ? {} : { requestedReasoningEffort },
      startedAt: Date.now(), outcome: 'running', attempts: [],
    }
    this.recent.push(state.diagnostic)
    const excess = this.recent.filter(record => record.provider === route.id).length - route.config.diagnosticsLimit
    for (let i = 0; i < excess; i++) this.recent.splice(this.recent.findIndex(record => record.provider === route.id), 1)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...options.signal === undefined ? [] : [options.signal]])
    state.options = { ...options, signal }
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
    } catch (error: unknown) {
      if (state.transport?.outcomeUnknown && !options.signal?.aborted) {
        throw new LlmError('The gateway generation outcome is unknown. Check provider usage before retrying.', 'OUTCOME_UNKNOWN', { cause: error })
      }
      throw error
    } finally {
      const success = terminal?.type === 'finish' && terminal.reason.kind !== 'error' && terminal.reason.kind !== 'aborted'
      try { await state.transport?.close(success) }
      finally {
        controller.abort(new Error('GPT gateway request settled'))
        state.circuitLease?.settle(state.transport?.wsFailure ? 'failure' : state.transport?.wsSucceeded ? 'success' : 'neutral')
        const route = state.route
        if (route && state.transport?.wsFailure && this.circuit(route).sseUntil > Date.now()) this.options.onCircuitOpen?.(route.id, this.circuit(route).failures, route.config.fallbackCooldownMs)
        if (state.diagnostic) {
          state.diagnostic.endedAt = Date.now()
          if (state.usage !== undefined) state.diagnostic.usage = state.usage
          state.diagnostic.outcome = success ? 'success' : terminal?.type === 'finish' && terminal.reason.kind === 'aborted' ? 'aborted' : 'error'
          state.diagnostic.code = state.transport?.failure?.code ?? (terminal?.type === 'finish' && (terminal.reason.kind === 'error' || terminal.reason.kind === 'aborted') ? terminal.reason.failure?.code : undefined)
        }
        for (const [old, pool] of this.pools) if (old !== this.routes.get(old.id) && pool.snapshot().busy === 0) {
          await pool.dispose(); this.pools.delete(old); this.circuits.delete(old)
        }
      }
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
      await Promise.allSettled([...this.discoveryWork])
      await Promise.all([...this.cleanup])
      const pools = await Promise.allSettled([...this.pools.values()].map(pool => pool.dispose()))
      this.pools.clear()
      const errors = [...results, ...pools].filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Some GPT gateway requests could not finish cleanup.')
    })()
    return this.disposing
  }
}
