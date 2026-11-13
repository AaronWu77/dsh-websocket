/** Request-owned Responses WebSocket transport exposed as a scoped Fetch implementation. */
import OpenAI from 'openai'
import { ResponsesWS } from 'openai/resources/responses/ws'
import type { ResponsesStreamMessage } from 'openai/resources/responses/internal-base'
import type { ResponsesClientEvent } from 'openai/resources/responses/responses'
import type { WebSocket } from 'ws'

/** Stable failure categories used by the owning DSH adapter. */
export type TransportFailureCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'SERVER' | 'TRANSPORT' | 'TIMEOUT' | 'ABORTED' | 'OUTCOME_UNKNOWN' | 'MALFORMED_RESPONSE'

/** Safe failure facts; raw headers, credentials and provider bodies are never included. */
export class TransportFailure extends Error {
  constructor(
    readonly code: TransportFailureCode,
    message: string,
    readonly fallbackAllowed = false,
    readonly status?: number,
  ) { super(message); this.name = 'TransportFailure' }
}

/** One request's validated transport settings. No connections survive its owner. */
export interface ResponsesTransportOptions {
  mode: 'auto' | 'sse'
  baseURL: string
  apiKey: string
  signal: AbortSignal
  connectTimeoutMs: number
  closeTimeoutMs: number
  maxFrameBytes: number
  maxBufferedEvents: number
  report: (event: { transport: 'websocket' | 'sse'; phase: 'connected' | 'fallback' | 'request'; code?: TransportFailureCode }) => void
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
  const unsupported = [404, 405, 426, 501].includes(status)
  return new TransportFailure(status >= 500 ? 'SERVER' : 'INVALID_REQUEST', 'The gateway rejected the Responses upgrade.', unsupported, status)
}

function providerFailure(value: unknown): TransportFailure {
  const record = typeof value === 'object' && value !== null ? value : {}
  const status = 'status' in record && typeof record.status === 'number' ? record.status : undefined
  const error = 'error' in record && typeof record.error === 'object' && record.error !== null ? record.error : record
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return new TransportFailure('QUOTA', 'The gateway account quota is exhausted; review provider usage before retrying.', false, status)
  if (status === 401 || status === 403 || code === 'invalid_api_key') return new TransportFailure('AUTH', 'The gateway rejected the Responses credential.', false, status)
  if (status === 429 || code === 'rate_limit_exceeded') return new TransportFailure('RATE_LIMIT', 'The gateway rate-limited the Responses request.', false, status)
  return new TransportFailure(status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST', 'The gateway rejected the Responses request; check its model and request settings.', false, status)
}

function isTerminal(type: string): boolean {
  return type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed'
}

/**
 * Adapt the existing HTTP request serializer to WS without replacing global fetch or WebSocket.
 * Each instance accepts at most one request. Call close() after consuming or abandoning its body.
 */
export class ResponsesTransport {
  failure?: TransportFailure
  private socket?: WebSocket
  private connection?: ResponsesWS
  private events?: AsyncIterableIterator<ResponsesStreamMessage>
  private socketClosed?: Promise<void>
  private closeTask?: Promise<void>
  private readonly lifetime = new AbortController()
  private sent = false
  private received = false
  private used = false
  private handshakeStatus?: number
  private handshakeTimedOut = false
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private detachAbort?: () => void

  constructor(private readonly options: ResponsesTransportOptions) {}

  /** Dispatch one serialized POST /responses; other operations are refused, never intercepted globally. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.used) throw new TransportFailure('INVALID_REQUEST', 'A transport instance cannot dispatch a second request.')
    this.used = true
    const signal = AbortSignal.any([this.options.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const request = new Request(input, { ...init, signal, redirect: 'error' })
    const endpoint = new URL(request.url)
    const base = new URL(this.options.baseURL)
    if (endpoint.origin !== base.origin || request.method !== 'POST' || !endpoint.pathname.endsWith('/responses')) {
      throw new TransportFailure('INVALID_REQUEST', 'The scoped transport accepts only this gateway\'s Responses POST.')
    }
    if (this.options.mode === 'sse') {
      this.options.report({ transport: 'sse', phase: 'request' })
      return globalThis.fetch(request)
    }
    const payload: unknown = await request.clone().json()
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('model' in payload) || typeof payload.model !== 'string') {
      throw new TransportFailure('INVALID_REQUEST', 'The serialized Responses request has no model.')
    }
    try {
      return await this.open(request, { ...payload, model: payload.model }, signal)
    } catch (error: unknown) {
      const failure = this.classify(error, signal)
      await this.closeSocket()
      if (failure.fallbackAllowed && !signal.aborted) {
        this.options.report({ transport: 'sse', phase: 'fallback', code: failure.code })
        return globalThis.fetch(request)
      }
      this.failure = failure
      throw failure
    }
  }

  private classify(error: unknown, signal: AbortSignal): TransportFailure {
    if (signal.aborted) return new TransportFailure('ABORTED', 'The Responses request was cancelled.')
    if (error instanceof TransportFailure) return error
    if (this.handshakeStatus !== undefined) return failedHandshake(this.handshakeStatus)
    if (this.handshakeTimedOut && !this.sent) return new TransportFailure('TIMEOUT', 'The Responses upgrade timed out before a generation request was sent.', true)
    if (!this.sent) {
      const code = errno(error)
      const network = code !== undefined && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)
      return new TransportFailure('TRANSPORT', 'The Responses connection could not be established.', network)
    }
    if (!this.received) return new TransportFailure('OUTCOME_UNKNOWN', 'The request outcome is unknown. Generation may already have started; check provider usage before retrying.')
    return new TransportFailure('TRANSPORT', 'The Responses connection ended before its terminal response event.')
  }

  private async open(request: Request, payload: object & { model: string }, signal: AbortSignal): Promise<Response> {
    const headers = new Headers(request.headers)
    for (const key of ['accept', 'content-type', 'content-length', 'connection', 'upgrade', 'host']) headers.delete(key)
    const endpoint = new URL(request.url)
    endpoint.pathname = endpoint.pathname.slice(0, -'/responses'.length) || '/'
    endpoint.search = ''
    const connection = new ResponsesWS(new OpenAI({ baseURL: endpoint.href, apiKey: this.options.apiKey, maxRetries: 0 }), {
      headers: Object.fromEntries(headers),
      maxPayload: this.options.maxFrameBytes,
      perMessageDeflate: false,
      followRedirects: false,
      reconnect: null,
    })
    this.connection = connection
    // The iterator reports expected errors; this listener prevents SDK unhandled rejections.
    connection.on('error', () => {})
    const socket = connection.socket.platformSocket
    this.socket = socket
    this.socketClosed = new Promise(resolve => socket.once('close', () => resolve()))
    socket.once('unexpected-response', (_request, response) => {
      this.handshakeStatus = response.statusCode
      response.resume()
      socket.terminate()
    })
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimedOut = true
      socket.terminate()
    }, this.options.connectTimeoutMs)
    this.handshakeTimer.unref()
    socket.once('open', () => {
      if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    })
    this.events = connection.stream({ maxBufferedEvents: this.options.maxBufferedEvents })
    const onAbort = (): void => { socket.terminate() }
    signal.addEventListener('abort', onAbort, { once: true })
    this.detachAbort = () => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
    const { stream: _stream, background: _background, ...body } = payload as { model: string; stream?: boolean; background?: boolean }
    const create = { ...body, type: 'response.create' as const }
    // The payload already crossed pi-ai's Responses serializer; the wire parser checks its model above.
    const event = create as ResponsesClientEvent
    const nextMessage = async (): Promise<object & { type: string }> => {
      for (;;) {
        const next = await this.events!.next()
        signal.throwIfAborted()
        if (next.done) throw this.classify(undefined, signal)
        const item = next.value
        if (item.type === 'open') {
          this.options.report({ transport: 'websocket', phase: 'connected' })
          this.sent = true
          connection.send(event)
        } else if (item.type === 'message') {
          this.received = true
          const value: unknown = item.message
          if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
            throw new TransportFailure('MALFORMED_RESPONSE', 'The gateway returned a Responses event without a type.')
          }
          return { ...value, type: value.type }
        } else if (item.type === 'error') {
          if (item.error.error !== undefined) throw providerFailure(item.error.error)
          throw item.error
        } else if (item.type === 'close') {
          if (this.handshakeStatus !== undefined) throw failedHandshake(this.handshakeStatus)
          throw this.classify(undefined, signal)
        }
      }
    }
    let pending: (object & { type: string }) | undefined = await nextMessage()
    const encoder = new TextEncoder()
    let ended = false
    const responseBody = new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (ended) return
        try {
          const value = pending ?? await nextMessage()
          pending = undefined
          controller.enqueue(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`))
          if (isTerminal(value.type)) {
            ended = true
            await this.closeSocket()
            controller.close()
          }
        } catch (error: unknown) {
          ended = true
          this.failure = this.classify(error, signal)
          try { await this.closeSocket() }
          catch (closeError: unknown) { controller.error(closeError); return }
          controller.error(this.failure)
        }
      },
      cancel: async () => { ended = true; await this.close() },
    })
    return new Response(responseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  private closeSocket(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closeTask = this.finishSocket()
    return this.closeTask
  }

  private async finishSocket(): Promise<void> {
    const socket = this.socket
    if (socket === undefined) return
    this.detachAbort?.()
    this.detachAbort = undefined
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    const closed = this.socketClosed!
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          socket.terminate()
          deadline = setTimeout(() => reject(new TransportFailure('TRANSPORT', 'The owned Responses connection did not finish closing.')), this.options.closeTimeoutMs)
          deadline.unref()
        }, this.options.closeTimeoutMs)
        timer.unref()
      })
      if (socket.readyState !== socket.CLOSED) this.connection!.close()
      await Promise.race([closed, bounded])
      await this.events?.return?.()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (deadline !== undefined) clearTimeout(deadline)
      this.socket = undefined
    }
  }

  /** Cancel remaining work and wait until this request's owned socket has closed. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Responses transport disposed'))
    await this.closeSocket()
  }
}
