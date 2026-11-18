/** Scoped Responses Fetch with request leases over bounded session-owned WS connections. */
import OpenAI from 'openai'
import { ResponsesWS } from 'openai/resources/responses/ws'
import type { ResponsesStreamMessage } from 'openai/resources/responses/internal-base'
import type { ResponsesClientEvent } from 'openai/resources/responses/responses'
import type { WebSocket } from 'ws'
import { Continuation, fingerprint, object } from './continuation.ts'
import type { ContinuationComparison, JsonObject, ResetReason } from './continuation.ts'

export type TransportFailureCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'SERVER' | 'TRANSPORT' | 'TIMEOUT' | 'ABORTED' | 'OUTCOME_UNKNOWN' | 'MALFORMED_RESPONSE' | 'CONTINUATION_MISSING'
/** Failures contain safe messages, never raw upstream bodies or headers. */
export class TransportFailure extends Error {
  constructor(readonly code: TransportFailureCode, message: string, readonly fallbackAllowed = false, readonly status?: number) { super(message); this.name = 'TransportFailure' }
}
type DiagnosticReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** @param value - untrusted effort value. @returns a safe diagnostic effort, not the original arbitrary string. */
export function diagnosticReasoningEffort(value: unknown): DiagnosticReasoningEffort | undefined {
  switch (value) {
    case 'off': case 'minimal': case 'low': case 'medium': case 'high': case 'xhigh': case 'max': return value
    default: return undefined
  }
}

export interface AttemptFacts {
  transport: 'websocket' | 'sse'
  requestBytes: number
  fullBytes: number
  delta: boolean
  reused: boolean
  /** Prior WS failure only when it caused this SSE body to be sent. */
  fallbackReason?: TransportFailureCode
  resetReason?: ResetReason
  /** Value-free history comparison when the request could not continue. */
  continuationComparison?: ContinuationComparison
  /** Allowlisted value of reasoning.effort in the outbound payload. */
  sentReasoningEffort?: DiagnosticReasoningEffort | 'none'
  /** Positive integer max_output_tokens in the outbound payload. */
  maxOutputTokens?: number
}

function wireControls(body: JsonObject): Pick<AttemptFacts, 'sentReasoningEffort' | 'maxOutputTokens'> {
  const effort = object(body.reasoning)?.effort
  const sentReasoningEffort = effort === 'none' ? 'none' : diagnosticReasoningEffort(effort)
  const maxOutputTokens = body.max_output_tokens
  return {
    ...sentReasoningEffort === undefined ? {} : { sentReasoningEffort },
    ...typeof maxOutputTokens === 'number' && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {},
  }
}

export interface ResponsesTransportOptions {
  mode: 'auto' | 'sse'
  baseURL: string
  apiKey: string
  signal: AbortSignal
  callerSignal?: AbortSignal
  connectTimeoutMs: number
  closeTimeoutMs: number
  maxFrameBytes: number
  maxBufferedEvents: number
  report: (event: { transport: 'websocket' | 'sse'; phase: 'connected' | 'fallback' | 'request'; code?: TransportFailureCode }) => void
  pool?: ConnectionPool
  poolKey?: string
  continuation?: boolean
  onAttempt?: (facts: AttemptFacts) => void
}
function errno(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  if ('cause' in error && error.cause !== error) return errno(error.cause)
  return undefined
}
function failedHandshake(status: number): TransportFailure {
  if (status === 401 || status === 403) return new TransportFailure('AUTH', 'The gateway rejected authentication for the Responses connection.', false, status)
  if (status === 429) return new TransportFailure('RATE_LIMIT', 'The gateway rate-limited the Responses connection.', false, status)
  return new TransportFailure(status >= 500 ? 'SERVER' : 'INVALID_REQUEST', 'The gateway rejected the Responses upgrade.', [404, 405, 426, 501].includes(status), status)
}
function providerFailure(value: unknown): TransportFailure {
  const item = object(value) ?? {}
  const error = object(item.error) ?? item
  const status = typeof item.status === 'number' ? item.status : undefined
  if (error.code === 'previous_response_not_found') return new TransportFailure('CONTINUATION_MISSING', 'The gateway no longer has this continuation.', false, status)
  if (error.code === 'insufficient_quota' || error.code === 'billing_hard_limit_reached') return new TransportFailure('QUOTA', 'The gateway account quota is exhausted; review provider usage before retrying.', false, status)
  if (status === 401 || status === 403 || error.code === 'invalid_api_key') return new TransportFailure('AUTH', 'The gateway rejected the Responses credential.', false, status)
  if (status === 429 || error.code === 'rate_limit_exceeded') return new TransportFailure('RATE_LIMIT', 'The gateway rate-limited the Responses request.', false, status)
  return new TransportFailure(status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST', 'The gateway rejected the Responses request; check its model and request settings.', false, status)
}
/** @param type - Untrusted Responses event discriminant. @returns Whether the event is terminal. */
export function isResponsesTerminal(type: unknown): boolean {
  return type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed'
}

/** One connection has exactly one consumer; it never reconnects or resends automatically. */
class Channel {
  readonly connection: ResponsesWS
  readonly socket: WebSocket
  readonly events: AsyncIterableIterator<ResponsesStreamMessage>
  readonly closed: Promise<void>
  readonly chain: Continuation
  readonly createdAt = Date.now()
  readonly scope: string | undefined
  busy = true
  timer?: ReturnType<typeof setTimeout>
  private status?: number
  private timedOut = false
  private readyState = false
  private closing?: Promise<void>
  private readonly closeTimeoutMs: number
  constructor(options: ResponsesTransportOptions, request: Request, retainedBytes: number) {
    this.closeTimeoutMs = options.closeTimeoutMs
    this.scope = options.poolKey
    const headers = new Headers(request.headers)
    for (const key of ['accept', 'content-type', 'content-length', 'connection', 'upgrade', 'host']) headers.delete(key)
    const endpoint = new URL(request.url)
    endpoint.pathname = endpoint.pathname.slice(0, -'/responses'.length) || '/'
    endpoint.search = ''
    this.chain = new Continuation(retainedBytes)
    this.connection = new ResponsesWS(new OpenAI({ baseURL: endpoint.href, apiKey: options.apiKey, maxRetries: 0 }), {
      headers: Object.fromEntries(headers), maxPayload: options.maxFrameBytes, perMessageDeflate: false,
      followRedirects: false, reconnect: null,
    })
    // Expected SDK errors are consumed by the bounded iterator.
    this.connection.on('error', () => {})
    this.socket = this.connection.socket.platformSocket
    this.closed = new Promise(resolve => this.socket.once('close', () => { this.chain.reset(); resolve() }))
    this.socket.once('unexpected-response', (_request, response) => {
      this.status = response.statusCode; response.resume(); this.socket.terminate()
    })
    const timeout = setTimeout(() => { this.timedOut = true; this.socket.terminate() }, options.connectTimeoutMs)
    timeout.unref()
    const clear = () => clearTimeout(timeout)
    this.socket.once('open', clear)
    this.socket.once('close', clear)
    this.events = this.connection.stream({ maxBufferedEvents: options.maxBufferedEvents })
  }
  get usable(): boolean { return this.socket.readyState === this.socket.OPEN && this.closing === undefined }
  async ready(signal: AbortSignal): Promise<boolean> {
    if (this.readyState) {
      if (!this.usable) throw new TransportFailure('TRANSPORT', 'The idle connection closed before this request was sent.', true)
      return true
    }
    for (;;) {
      const next = await this.events.next()
      signal.throwIfAborted()
      if (!next.done && next.value.type === 'open') { this.readyState = true; return false }
      if (this.status !== undefined) throw failedHandshake(this.status)
      if (this.timedOut) throw new TransportFailure('TIMEOUT', 'The Responses upgrade timed out before a generation request was sent.', true)
      if (next.done || next.value.type === 'close' || next.value.type === 'error') {
        const code = next.done || next.value.type !== 'error' ? undefined : errno(next.value.error)
        throw new TransportFailure('TRANSPORT', 'The Responses connection could not be established.', code !== undefined && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code))
      }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.chain.reset()
    if (this.timer) clearTimeout(this.timer)
    this.closing = (async () => {
      let force: ReturnType<typeof setTimeout> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const bounded = new Promise<never>((_resolve, reject) => {
          force = setTimeout(() => {
            this.socket.terminate()
            deadline = setTimeout(() => reject(new TransportFailure('TRANSPORT', 'The owned Responses connection did not finish closing.')), this.closeTimeoutMs)
          }, this.closeTimeoutMs)
        })
        if (this.socket.readyState !== this.socket.CLOSED) this.connection.close()
        await Promise.race([this.closed, bounded])
        await this.events.return?.()
      } finally { if (force) clearTimeout(force); if (deadline) clearTimeout(deadline) }
    })()
    return this.closing
  }
}
export interface PoolOptions { maxConnections: number; idleMs: number; maxAgeMs: number; maxRetainedBytes: number; onCleanupError?: () => void }
/** An adapter owns this pool and awaits disposal of active and idle connections. */
export class ConnectionPool {
  private readonly channels = new Map<string, Channel>()
  private readonly pending = new Map<Channel, Promise<void>>()
  private readonly errors: unknown[] = []
  private disposed = false
  constructor(private readonly options: PoolOptions) {}
  get maxRetainedBytes(): number { return this.options.maxRetainedBytes }
  private retire(key: string, channel: Channel): void {
    if (this.channels.get(key) === channel) this.channels.delete(key)
    if (this.pending.has(channel)) return
    const work = channel.close().catch(error => { this.errors.push(error); this.options.onCleanupError?.() }).finally(() => this.pending.delete(channel))
    this.pending.set(channel, work)
  }
  take(key: string, create: () => Channel): { channel: Channel; release: (keep: boolean) => Promise<void> } | undefined {
    if (this.disposed) throw new TransportFailure('ABORTED', 'The gateway connection pool stopped.')
    let channel = this.channels.get(key)
    if (channel?.busy) return undefined
    if (channel && (!channel.usable || Date.now() - channel.createdAt >= this.options.maxAgeMs)) { this.retire(key, channel); channel = undefined }
    if (!channel) {
      // Closing sockets still consume capacity. Evict an idle lease, but use full SSE
      // until its bounded close settles rather than briefly exceeding the physical limit.
      if (this.channels.size + this.pending.size >= this.options.maxConnections) {
        const idle = [...this.channels].find(([, item]) => !item.busy)
        if (idle) this.retire(...idle)
        return undefined
      }
      channel = create()
      this.channels.set(key, channel)
    }
    channel.busy = true
    if (channel.timer) clearTimeout(channel.timer)
    const owned = channel
    return { channel, release: async keep => {
      if (!keep || this.disposed || !owned.usable) { this.retire(key, owned); await this.drain(); return }
      owned.busy = false
      owned.timer = setTimeout(() => this.retire(key, owned), Math.min(this.options.idleMs, Math.max(1, this.options.maxAgeMs - (Date.now() - owned.createdAt))))
      owned.timer.unref()
    } }
  }
  snapshot() { return { connections: this.channels.size + this.pending.size, busy: [...this.channels.values()].filter(c => c.busy).length, retainedBytes: [...this.channels.values()].reduce((n, c) => n + c.chain.retainedBytes, 0) } }
  async reset(scope?: string): Promise<void> { for (const [key, channel] of this.channels) if (!channel.busy && (scope === undefined || channel.scope === scope)) this.retire(key, channel); await this.drain() }
  private async drain(): Promise<void> { await Promise.all([...this.pending.values()]); if (this.errors.length) throw new AggregateError(this.errors.splice(0), 'Gateway connection cleanup failed.') }
  async dispose(): Promise<void> { this.disposed = true; for (const [key, channel] of this.channels) this.retire(key, channel); await this.drain() }
}

/** One admitted request; success may return its connection to the owning session pool. */
export class ResponsesTransport {
  failure?: TransportFailure
  wsFailure?: TransportFailure
  wsSucceeded = false
  private channel?: Channel
  private release?: (keep: boolean) => Promise<void>
  private detachAbort?: () => void
  private readonly lifetime = new AbortController()
  private used = false
  private completed = false
  private sent = false
  private generated = false
  private terminalReceived = false
  private providerRejected = false
  get outcomeUnknown(): boolean { return this.sent && !this.terminalReceived && !this.providerRejected }
  private candidate?: { payload: JsonObject; response: unknown }
  private closing?: Promise<void>
  constructor(private readonly options: ResponsesTransportOptions) {}
  private classify(error: unknown, signal: AbortSignal): TransportFailure {
    if (signal.aborted) {
      if (this.outcomeUnknown && this.options.callerSignal && !this.options.callerSignal.aborted) return new TransportFailure('OUTCOME_UNKNOWN', 'The response timed out after sending. Generation may have been billed; check provider usage before retrying.')
      return new TransportFailure('ABORTED', 'The Responses request was cancelled.')
    }
    if (error instanceof TransportFailure) return error
    if (this.sent) return new TransportFailure('OUTCOME_UNKNOWN', 'The request outcome is unknown. Generation may already have started; check provider usage before retrying.')
    return new TransportFailure('TRANSPORT', 'The Responses connection failed before the request was sent.', true)
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.used) throw new TransportFailure('INVALID_REQUEST', 'A transport instance cannot dispatch a second request.')
    this.used = true
    const signal = AbortSignal.any([this.options.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const request = new Request(input, { ...init, signal, redirect: 'error' })
    const endpoint = new URL(request.url), base = new URL(this.options.baseURL)
    if (endpoint.origin !== base.origin || endpoint.pathname !== `${base.pathname.replace(/\/+$/, '')}/responses` || request.method !== 'POST' || endpoint.search) {
      throw new TransportFailure('INVALID_REQUEST', 'The scoped transport accepts only this gateway\'s Responses POST.')
    }
    const raw = await request.clone().text()
    const payload = object(JSON.parse(raw))
    if (!payload || typeof payload.model !== 'string') throw new TransportFailure('INVALID_REQUEST', 'The serialized Responses request has no model.')
    const sse = (fallback?: TransportFailure) => {
      this.options.report({ transport: 'sse', phase: fallback ? 'fallback' : 'request', ...fallback ? { code: fallback.code } : {} })
      const bytes = Buffer.byteLength(raw)
      this.options.onAttempt?.({
        transport: 'sse', requestBytes: bytes, fullBytes: bytes, delta: false, reused: false,
        ...fallback === undefined ? {} : { fallbackReason: fallback.code },
        ...wireControls(payload),
      })
      return globalThis.fetch(request)
    }
    if (this.options.mode === 'sse') return sse()
    try {
      const make = () => new Channel(this.options, request, this.options.pool ? this.options.pool.maxRetainedBytes : 1_048_576)
      if (this.options.pool && this.options.poolKey) {
        const key = fingerprint([this.options.poolKey, endpoint.href, this.options.apiKey, [...request.headers]])
        const lease = this.options.pool.take(key, make)
        if (!lease) return sse()
        this.channel = lease.channel; this.release = lease.release
      } else { this.channel = make(); this.release = async () => { await this.channel!.close() } }
      const channel = this.channel
      const onAbort = () => channel.socket.terminate()
      signal.addEventListener('abort', onAbort, { once: true })
      this.detachAbort = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
      const reused = await channel.ready(signal)
      if (!reused) this.options.report({ transport: 'websocket', phase: 'connected' })
      let plan = channel.chain.plan(payload, Boolean(this.options.continuation && this.options.poolKey))
      const send = () => {
        const create = { ...plan.body, type: 'response.create' as const }
        this.options.onAttempt?.({
          transport: 'websocket', requestBytes: Buffer.byteLength(JSON.stringify(create)),
          fullBytes: Buffer.byteLength(JSON.stringify({ ...payload, stream: undefined, background: undefined, type: 'response.create' })),
          delta: plan.delta, reused,
          ...plan.reason === undefined ? {} : { resetReason: plan.reason },
          ...plan.comparison === undefined ? {} : { continuationComparison: plan.comparison },
          ...wireControls(create),
        })
        this.sent = true
        channel.connection.send(create as ResponsesClientEvent)
      }
      send()
      const nextMessage = async (): Promise<JsonObject & { type: string }> => {
        for (;;) {
          const next = await channel.events.next()
          signal.throwIfAborted()
          if (next.done) throw this.classify(undefined, signal)
          const item = next.value
          if (item.type === 'message') {
            const value = object(item.message)
            if (!value || typeof value.type !== 'string') throw new TransportFailure('MALFORMED_RESPONSE', 'The gateway returned a Responses event without a type.')
            if (value.type === 'error') { this.providerRejected = true; throw providerFailure(value) }
            this.generated = true
            return { ...value, type: value.type }
          }
          if (item.type === 'error') {
            if (item.error.error !== undefined) {
              const error = providerFailure(item.error.error)
              // Only an explicit pre-generation missing-parent rejection permits one full rebuild.
              if (error.code === 'CONTINUATION_MISSING' && plan.delta && !this.generated) {
                channel.chain.reset(); plan = { body: { ...payload, stream: undefined, background: undefined, previous_response_id: undefined }, delta: false, reason: 'cache-miss' }; send(); continue
              }
              this.providerRejected = true
              throw error
            }
            throw item.error
          }
          if (item.type === 'close') throw this.classify(undefined, signal)
        }
      }
      let pending: (JsonObject & { type: string }) | undefined = await nextMessage()
      const encoder = new TextEncoder()
      let ended = false
      const responseBody = new ReadableStream<Uint8Array>({
        pull: async controller => {
          if (ended) return
          try {
            const value = pending ?? await nextMessage(); pending = undefined
            if (isResponsesTerminal(value.type)) {
              ended = true
              this.terminalReceived = true
              this.completed = value.type === 'response.completed' && object(value.response)?.status === 'completed'
              if (this.completed) this.candidate = { payload, response: value.response }
              this.detachAbort?.()
              if (!this.options.poolKey) await this.releaseConnection(false)
              controller.enqueue(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`))
              controller.close()
            } else controller.enqueue(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`))
          } catch (error: unknown) {
            ended = true; this.failure = this.classify(error, signal); this.noteWsFailure(this.failure)
            try { await this.close(false) } catch (closeError: unknown) { controller.error(closeError); return }
            controller.error(this.failure)
          }
        },
        cancel: async () => { ended = true; await this.close(false) },
      })
      return new Response(responseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    } catch (error: unknown) {
      const failure = this.classify(error, signal)
      this.noteWsFailure(failure)
      await this.releaseConnection(false)
      if (failure.fallbackAllowed && !this.sent && !signal.aborted) return sse(failure)
      this.failure = failure
      throw failure
    }
  }
  private noteWsFailure(failure: TransportFailure): void {
    if (failure.fallbackAllowed || ['OUTCOME_UNKNOWN', 'TRANSPORT', 'TIMEOUT', 'MALFORMED_RESPONSE'].includes(failure.code)) this.wsFailure = failure
  }
  private async releaseConnection(keep: boolean): Promise<void> {
    this.detachAbort?.(); this.detachAbort = undefined
    const release = this.release; this.release = undefined
    if (release) await release(keep)
  }
  /** Commit a completed head only after the caller has accepted a successful parsed terminal. */
  close(success = this.completed): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      const keep = success && this.completed && this.failure === undefined
      if (keep && this.candidate) this.channel!.chain.commit(this.candidate.payload, this.candidate.response)
      this.wsSucceeded = keep
      await this.releaseConnection(keep)
      this.lifetime.abort(new Error('Responses request settled'))
    })()
    return this.closing
  }
}
