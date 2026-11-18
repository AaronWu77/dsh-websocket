/** Public adapter integration over the real pi-ai serializer and loopback wire transports. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GatewayAdapter } from '../src/adapter.ts'
import type { GatewayAdapterOptions } from '../src/adapter.ts'
import { Config, resolveRoutes } from '../src/config.ts'
import type { GatewayInput } from '../src/config.ts'

const CASE_TIMEOUT_MS = 15_000

type JsonRecord = Record<string, unknown>
type Report = Parameters<GatewayAdapterOptions['report']>[1]

interface WireRequest {
  socket: WebSocket
  closed: Promise<void>
  headers: IncomingMessage['headers']
  payload: JsonRecord
}

class Queue<T> {
  private readonly values: T[] = []
  private readonly readers: Array<(value: T) => void> = []
  push(value: T): void {
    const reader = this.readers.shift()
    if (reader === undefined) this.values.push(value)
    else reader(value)
  }
  next(): Promise<T> {
    const value = this.values.shift()
    return value === undefined ? new Promise(resolve => this.readers.push(resolve)) : Promise.resolve(value)
  }
}

function record(value: unknown): JsonRecord {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as JsonRecord
}

function responseEvents(model: string, text: string): JsonRecord[] {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture', object: 'response', model, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    {
      type: 'response.completed', sequence_number: 4,
      response: {
        id: 'resp_fixture', object: 'response', model, status: 'completed', output: [item],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 },
      },
    },
  ]
}

function sendEvents(request: WireRequest, text = 'fixture answer'): void {
  for (const event of responseEvents(String(request.payload.model), text)) request.socket.send(JSON.stringify(event))
}

async function wireFixture(t: TestContext, options: {
  status?: number
  onCreate?: (request: WireRequest) => void
  events?: typeof responseEvents
} = {}) {
  const events = options.events ?? responseEvents
  const requests = new Queue<WireRequest>()
  const upgrades: IncomingMessage[] = []
  const posts: Array<{ headers: IncomingMessage['headers']; payload: JsonRecord; bytes: number }> = []
  const connections: Array<{ socket: WebSocket; closed: Promise<void> }> = []
  const rawSockets = new Map<Socket, Promise<void>>()
  const errors: unknown[] = []
  let cancellationStarted = false
  const onSocketError = (error: Error): void => {
    if (cancellationStarted && 'code' in error && error.code === 'ECONNRESET') return
    errors.push(error)
  }
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', error => errors.push(error))
    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks)
        const payload = record(JSON.parse(body.toString('utf8')))
        posts.push({ headers: request.headers, payload, bytes: body.byteLength })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events(String(payload.model), 'fixture answer').map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } catch (error: unknown) {
        errors.push(error)
        response.writeHead(500).end()
      }
    })
  })
  server.on('connection', socket => {
    rawSockets.set(socket, new Promise(resolve => socket.once('close', () => resolve())))
    socket.on('error', onSocketError)
  })
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request)
    if (options.status !== undefined) {
      socket.end(`HTTP/1.1 ${options.status} Fixture rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const connection = { socket: ws, closed: new Promise<void>(resolve => ws.once('close', () => resolve())) }
      connections.push(connection)
      ws.on('error', onSocketError)
      ws.on('message', data => {
        try {
          const received = { ...connection, headers: request.headers, payload: record(JSON.parse(data.toString())) }
          requests.push(received)
          if (options.onCreate === undefined) {
            for (const event of events(String(received.payload.model), 'fixture answer')) ws.send(JSON.stringify(event))
          } else options.onCreate(received)
        } catch (error: unknown) {
          errors.push(error)
          ws.terminate()
        }
      })
    })
  })
  t.after(async () => {
    const websocketClosed = new Promise<void>((resolve, reject) => wss.close(error => error === undefined ? resolve() : reject(error)))
    const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    for (const connection of connections) connection.socket.terminate()
    server.closeAllConnections()
    for (const socket of rawSockets.keys()) socket.destroy()
    await Promise.all([websocketClosed, httpClosed, ...connections.map(connection => connection.closed), ...rawSockets.values()])
    assert.deepEqual(errors, [], 'the wire fixture did not encounter server or socket errors')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`, nextCreate: () => requests.next(), upgrades, posts, connections,
    expectCancellation: () => { cancellationStarted = true },
  }
}

function declaration(baseURL: string, ids: string[] = ['gateway-ws'], overrides: Partial<GatewayInput> = {}) {
  return {
    providers: Object.fromEntries(ids.map(id => [id, {
      displayName: id,
      baseURL,
      apiKeyEnv: `KEY_${id.replace(/-/g, '_')}`,
      headers: { 'x-gateway-route': id },
      websocketConnectTimeoutMs: 3_000,
      closeTimeoutMs: 200,
      streamIdleTimeoutMs: 5_000,
      fallbackAfterFailures: 5,
      fallbackCooldownMs: 300_000,
      models: [{ id: 'gpt-fixture', contextWindow: 32_000, maxTokens: 512 }],
      ...overrides,
    }])),
  }
}

function adapter(t: TestContext, baseURL: string, ids: string[] = ['gateway-ws'], resolveApiKey?: GatewayAdapterOptions['resolveApiKey'], overrides: Partial<GatewayInput> = {}) {
  const credentials: Array<{ provider: string; reference: string | undefined }> = []
  const reports: Array<{ provider: string; event: Report }> = []
  const client = new GatewayAdapter(resolveRoutes(Config(declaration(baseURL, ids, overrides))), {
    resolveApiKey: resolveApiKey ?? (async (provider, profile) => {
      credentials.push({ provider, reference: profile.apiKeyEnv })
      return `credential:${provider}`
    }),
    report: (provider, event) => reports.push({ provider, event }),
  })
  t.after(() => client.dispose())
  return { client, credentials, reports }
}

function request(provider = 'gateway-ws', model = 'gpt-fixture'): GenerateOptions {
  return { provider, model, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'integration input' }] }] }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function assertSuccess(chunks: StreamChunk[], text = 'fixture answer'): void {
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), text)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end'), { type: 'block-end', index: 0, block: { type: 'text', text } })
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage'), { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3 } })
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  assert.ok(finish.replayState)
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
}

function llmCode(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, expected)
    return true
  }
}

async function assertClosed(connection: { socket: WebSocket; closed: Promise<void> }): Promise<void> {
  await connection.closed
  assert.equal(connection.socket.readyState, WebSocket.CLOSED)
}

function assertAborted(chunk: StreamChunk): void {
  assert.ok(chunk.type === 'finish' && chunk.reason.kind === 'aborted')
  assert.equal(chunk.reason.failure?.code, 'ABORTED')
  assert.equal(chunk.replayState, undefined)
}

async function expectAbortedThenDone(iterator: AsyncIterator<StreamChunk>): Promise<void> {
  const terminal = await iterator.next()
  assert.ok(!terminal.done)
  assertAborted(terminal.value)
  assert.equal((await iterator.next()).done, true)
}

test('the public adapter serializes a user request through PI and maps WS output, usage and replay', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client, credentials, reports } = adapter(t, gateway.baseURL)
  const chunks = await collect(client.stream(request()))
  assertSuccess(chunks)
  const sent = await gateway.nextCreate()
  assert.equal(sent.payload.type, 'response.create')
  assert.equal(sent.payload.model, 'gpt-fixture')
  assert.equal(sent.payload.max_output_tokens, 64)
  assert.deepEqual(sent.payload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'integration input' }] }])
  assert.equal(sent.payload.stream, undefined)
  assert.equal(sent.headers.authorization, 'Bearer credential:gateway-ws')
  assert.equal(sent.headers['x-gateway-route'], 'gateway-ws')
  assert.deepEqual(credentials, [{ provider: 'gateway-ws', reference: 'KEY_gateway_ws' }])
  assert.deepEqual(reports, [{ provider: 'gateway-ws', event: { transport: 'websocket', phase: 'connected' } }])
  assert.equal(gateway.posts.length, 0)
  await assertClosed(sent)
})

for (const mode of ['websocket', 'sse', 'fallback'] as const) {
  test(`reports only final safe token counts over ${mode}`, { timeout: CASE_TIMEOUT_MS }, async t => {
    const cases: { usage: JsonRecord | undefined; expected: JsonRecord | undefined }[] = [
      { usage: { input_tokens: 40, output_tokens: 7, input_tokens_details: { cached_tokens: 12, cache_write_tokens: 5 } },
        expected: { inputTokens: 23, outputTokens: 7, cacheReadTokens: 12, cacheWriteTokens: 5 } },
      { usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        expected: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 3 } }, expected: { inputTokens: 6, cacheReadTokens: 3 } },
      { usage: { input_tokens: 9, output_tokens: 0 }, expected: { inputTokens: 9, outputTokens: 0 } },
      { usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1.25, input_tokens_details: { cached_tokens: -1, cache_write_tokens: 'fixture-private-value' } }, expected: undefined },
      { usage: { input_tokens: 2, output_tokens: 0, input_tokens_details: { cached_tokens: 3 } }, expected: { outputTokens: 0, cacheReadTokens: 3 } },
      { usage: { input_tokens: 2, input_tokens_details: { cached_tokens: null, cache_write_tokens: 0 } }, expected: { cacheWriteTokens: 0 } },
      { usage: undefined, expected: undefined },
    ]
    let responseIndex = 0
    const gateway = await wireFixture(t, {
      ...mode === 'fallback' ? { status: 404 } : {},
      events: (model, text) => {
        const events = responseEvents(model, text)
        record(events[0]!.response).usage = { input_tokens: 900, output_tokens: 900 }
        const response = record(events.at(-1)!.response)
        const usage = cases[responseIndex++]!.usage
        if (usage === undefined) delete response.usage
        else response.usage = { ...usage, debug: 'fixture-private-value', total_tokens: 900 }
        return events
      },
    })
    const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, {
      fallbackAfterFailures: 0,
      ...mode === 'sse' ? { transport: 'sse' } : {},
    })
    for (const { expected } of cases) {
      const chunks = await collect(client.stream(request()))
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish' && finish.reason.kind === 'stop')
      const diagnostics = client.diagnostics()
      const row = diagnostics.requests.at(-1)!
      assert.equal(row.attempts.length, 1)
      const attempt = row.attempts[0]!
      assert.equal(attempt.transport, mode === 'websocket' ? 'websocket' : 'sse')
      assert.equal(Object.hasOwn(attempt, 'fallbackReason'), mode === 'fallback')
      assert.equal(Object.hasOwn(row, 'usage'), expected !== undefined)
      assert.deepEqual(row.usage, expected)
      assert.doesNotMatch(JSON.stringify(row), /fixture-private-value|fixture answer|integration input|credential:gateway-ws/u)
    }
    assert.equal(responseIndex, cases.length)
    assert.equal(gateway.upgrades.length, mode === 'sse' ? 0 : cases.length)
    assert.equal(gateway.posts.length, mode === 'websocket' ? 0 : cases.length)
  })
}

test('a later terminal snapshot replaces an earlier SSE snapshot without merging or summing counters', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { events: (model, text) => {
    const events = responseEvents(model, text)
    const first = events.at(-1)!
    return [...events, { ...first, sequence_number: 5, response: { ...record(first.response), usage: { output_tokens: 0 } } }]
  } })
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, { transport: 'sse' })
  const chunks = await collect(client.stream(request()))
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'stop')
  const { requests } = client.diagnostics()
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]!.usage, { outputTokens: 0 })
})

test('repeated unsupported upgrades cool WS even when same-attempt SSE fallback succeeds', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { status: 404 })
  const raw = declaration(gateway.baseURL)
  raw.providers['gateway-ws'].fallbackAfterFailures = 5
  raw.providers['gateway-ws'].fallbackCooldownMs = 60_000
  const reports: Array<{ provider: string; event: Report }> = []
  const openings: Array<{ provider: string; failures: number }> = []
  const client = new GatewayAdapter(resolveRoutes(Config(raw)), {
    resolveApiKey: async () => 'credential:gateway-ws',
    report: (provider, event) => reports.push({ provider, event }),
    onCircuitOpen: (provider, failures) => openings.push({ provider, failures }),
  })
  t.after(() => client.dispose())

  for (let attempt = 0; attempt < 5; attempt++) {
    await collect(client.stream(request()))
  }
  assert.equal(gateway.upgrades.length, 5)
  assert.equal(gateway.posts.length, 5)
  assert.deepEqual(openings, [{ provider: 'gateway-ws', failures: 5 }])

  assertSuccess(await collect(client.stream(request())))
  assert.equal(gateway.upgrades.length, 5, 'the sixth attempt uses SSE instead of another upgrade')
  assert.equal(gateway.posts.length, 6)
  const diagnostics = client.diagnostics().requests
  assert.deepEqual(diagnostics.slice(0, 5).map(row => row.attempts.map(attempt => attempt.fallbackReason)), Array.from({ length: 5 }, () => ['INVALID_REQUEST']))
  assert.equal(Object.hasOwn(diagnostics[5]!.attempts[0]!, 'fallbackReason'), false)
  assert.equal(reports.some(report => report.event.transport === 'sse' && report.event.phase === 'request'), true)
})

test('an unsupported WS handshake preserves semantic DSH output through SSE fallback', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { status: 404 })
  const { client, reports } = adapter(t, gateway.baseURL)
  assertSuccess(await collect(client.stream(request())))
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 1)
  assert.equal(gateway.posts[0]!.payload.stream, true)
  assert.equal(gateway.posts[0]!.payload.type, undefined)
  assert.deepEqual(gateway.posts[0]!.payload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'integration input' }] }])
  assert.deepEqual(reports, [{ provider: 'gateway-ws', event: { transport: 'sse', phase: 'fallback', code: 'INVALID_REQUEST' } }])
  const [attempt] = client.diagnostics().requests[0]!.attempts
  assert.ok(attempt)
  assert.equal(attempt.transport, 'sse')
  assert.equal(attempt.fallbackReason, 'INVALID_REQUEST')
  assert.equal(attempt.requestBytes, gateway.posts[0]!.bytes)
  assert.equal(attempt.fullBytes, gateway.posts[0]!.bytes)
  assert.equal(client.diagnostics().requests[0]!.attempts.length, 1, 'the handshake rejection sent no WS body')
})

test('a rejected WebSocket upgrade reports SERVER before sending a generation', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { status: 503 })
  const { client } = adapter(t, gateway.baseURL)
  const finish = (await collect(client.stream(request()))).at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  assert.equal(finish.reason.failure.code, 'SERVER')
  assert.equal(finish.reason.failure.status, 503)
  const policy = client.providerRetryPolicy('gateway-ws')
  assert.equal(policy.mode, 'normal')
  assert.ok(policy.retryableCodes.includes('SERVER'))
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(client.diagnostics().requests[0]?.attempts, [])
})

for (const transport of ['auto', 'sse'] as const) {
  const frames = ['failed-without-output', 'failed-after-output', 'error-frame'] as const
  for (const frame of transport === 'auto' ? frames : frames.slice(0, 2)) {
    test(`overload on ${transport} (${frame}) stays a provider failure without replay`, { timeout: CASE_TIMEOUT_MS }, async t => {
      const gateway = await wireFixture(t, { events: (model, text) => {
        const error = { code: 'server_error', message: 'fixture private upstream detail' }
        if (frame === 'error-frame') return [{ type: 'error', ...error }]
        const progress = frame === 'failed-after-output' ? responseEvents(model, text).slice(0, 3) : []
        return [...progress, { type: 'response.failed', sequence_number: 5, response: { id: 'resp_fixture', model, status: 'failed', output: [], error } }]
      } })
      const { client } = adapter(t, gateway.baseURL, undefined, undefined, { transport, fallbackAfterFailures: 1 })
      const chunks = await collect(client.stream(request()))
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
      assert.equal(finish.reason.failure.code, 'UPSTREAM_SERVER_ERROR')
      assert.doesNotMatch(finish.reason.failure.message, /fixture private/)
      assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), frame === 'failed-after-output')
      assert.equal(finish.replayState, undefined)
      const policy = client.providerRetryPolicy('gateway-ws')
      assert.equal(policy.mode, 'normal')
      assert.equal(policy.retryableCodes.includes(finish.reason.failure.code), false)
      const diagnostics = client.diagnostics()
      assert.deepEqual(diagnostics.requests.map(row => [row.code, row.providerErrorCode, row.attempts.map(attempt => [attempt.transport, attempt.fallbackReason])]),
        [['UPSTREAM_SERVER_ERROR', 'server_error', [[transport === 'auto' ? 'websocket' : 'sse', undefined]]]])
      assert.equal(diagnostics.routes[0]?.circuit.failures, 0)
      assert.equal(gateway.posts.length, transport === 'sse' ? 1 : 0)
      if (transport === 'auto') {
        assert.equal(gateway.upgrades.length, 1)
        await assertClosed(await gateway.nextCreate())
      } else assert.equal(gateway.upgrades.length, 0)
    })
  }
}

test('structured terminal codes distinguish rate limiting, quota, authentication, and unknown failures', { timeout: CASE_TIMEOUT_MS }, async t => {
  let wireCode = ''
  const gateway = await wireFixture(t, { events: model => [{ type: 'response.failed', response: { model, status: 'failed', output: [], error: { code: wireCode, message: 'fixture text' } } }] })
  const { client } = adapter(t, gateway.baseURL, undefined, undefined, { transport: 'sse' })
  for (const [code, expected, safeCode] of [
    ['rate_limit_exceeded', 'UPSTREAM_RATE_LIMIT', 'rate_limit_exceeded'],
    ['insufficient_quota', 'QUOTA', 'insufficient_quota'],
    ['invalid_api_key', 'AUTH', 'invalid_api_key'],
    ['arbitrary_upstream_value', 'PI_AI_ERROR', undefined],
  ] as const) {
    wireCode = code
    const finish = (await collect(client.stream(request()))).at(-1)
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
    assert.equal(finish.reason.failure.code, expected)
    assert.equal(client.diagnostics().requests.at(-1)?.providerErrorCode, safeCode)
  }
  assert.equal(gateway.posts.length, 4)
})

test('a generation with unknown outcome retains OUTCOME_UNKNOWN after PI error conversion', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { onCreate: sent => sent.socket.close(1011, 'fixture unknown outcome') })
  const { client } = adapter(t, gateway.baseURL)
  const chunks = await collect(client.stream(request()))
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
  assert.equal(finish.reason.failure.code, 'OUTCOME_UNKNOWN')
  assert.match(finish.reason.failure.message, /outcome is unknown/i)
  assert.equal(finish.replayState, undefined)
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  assert.equal(gateway.posts.length, 0)
  await assertClosed(await gateway.nextCreate())
})

test('an unknown model is refused before credentials or network dispatch', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client, credentials, reports } = adapter(t, gateway.baseURL)
  await assert.rejects(collect(client.stream(request('gateway-ws', 'gpt-not-configured'))), llmCode('UNKNOWN_MODEL'))
  await assert.rejects(client.prepareCall('gateway-ws', 'gpt-not-configured'), llmCode('UNKNOWN_MODEL'))
  assert.deepEqual(credentials, [])
  assert.deepEqual(reports, [])
  assert.equal(gateway.upgrades.length, 0)
  assert.equal(gateway.posts.length, 0)
})

test('dispose drains a consumer paused at a yielded chunk without requiring another next', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, {
    onCreate: sent => {
      for (const event of responseEvents('gpt-fixture', 'partial').slice(0, 3)) sent.socket.send(JSON.stringify(event))
    },
  })
  const { client } = adapter(t, gateway.baseURL)
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.ok(!first.done)
  assert.equal(first.value.type, 'block-start')
  const sent = await gateway.nextCreate()
  gateway.expectCancellation()
  await client.dispose()
  await assertClosed(sent)
  await expectAbortedThenDone(iterator)
  assert.throws(() => client.stream(request()), llmCode('ABORTED'))
  assert.equal(gateway.posts.length, 0)
})

test('dispose cancels an active model wait and waits for its peer connection to close', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { onCreate: sent => sent.socket.send(JSON.stringify(responseEvents('gpt-fixture', '').at(0))) })
  const { client } = adapter(t, gateway.baseURL)
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  const pending = iterator.next().then(value => ({ type: 'value' as const, value }), error => ({ type: 'error' as const, error }))
  const sent = await gateway.nextCreate()
  gateway.expectCancellation()
  await client.dispose()
  await assertClosed(sent)
  const result = await pending
  if (result.type === 'error') {
    llmCode('ABORTED')(result.error)
    await expectAbortedThenDone(iterator)
  } else {
    assert.ok(!result.value.done)
    if (result.value.value.type === 'finish') {
      assertAborted(result.value.value)
      assert.equal((await iterator.next()).done, true)
    } else await expectAbortedThenDone(iterator)
  }
  assert.equal(gateway.posts.length, 0)
})

test('dispose rejects new and previously prepared calls and drains an unstarted admitted stream', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client, credentials } = adapter(t, gateway.baseURL)
  const prepared = await client.prepareCall('gateway-ws', 'gpt-fixture')
  const unused = await client.prepareCall('gateway-ws', 'gpt-fixture')
  const admitted = prepared.stream(request())[Symbol.asyncIterator]()
  const preparing = client.prepareCall('gateway-ws', 'gpt-fixture')
  const disposing = client.dispose()
  assert.equal(client.dispose(), disposing)
  await disposing
  await assert.rejects(client.prepareCall('gateway-ws', 'gpt-fixture'), llmCode('ABORTED'))
  assert.throws(() => unused.stream(request()), llmCode('ABORTED'))
  assert.throws(() => prepared.stream(request()), llmCode('ABORTED'))
  assert.throws(() => client.stream(request()), llmCode('ABORTED'))
  const racedPrepared = await preparing
  assert.throws(() => racedPrepared.stream(request()), llmCode('ABORTED'))
  await expectAbortedThenDone(admitted)
  assert.deepEqual(credentials, [])
  assert.equal(gateway.upgrades.length, 0)
  assert.equal(gateway.posts.length, 0)
})

test('dispose waits for an admitted credential lookup before completing and sends no late request', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  let released = false
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], async () => { entered.resolve(); return release.promise })
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  const pending = iterator.next().then(value => ({ type: 'value' as const, value }), error => ({ type: 'error' as const, error }))
  await entered.promise
  const disposing = client.dispose().then(() => assert.equal(released, true, 'disposal retained the admitted credential operation'))
  await assert.rejects(client.prepareCall('gateway-ws', 'gpt-fixture'), llmCode('ABORTED'))
  released = true
  release.resolve('fixture-released-key')
  await disposing
  await pending
  await expectAbortedThenDone(iterator)
  assert.equal(gateway.upgrades.length, 0)
  assert.equal(gateway.posts.length, 0)
})

test('dispose after usage but before finish leaves one visible aborted terminal instead of silent completion', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL)
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  for (;;) {
    const next = await iterator.next()
    assert.ok(!next.done, 'usage is delivered before the terminal response')
    assert.notEqual(next.value.type, 'finish')
    if (next.value.type === 'usage') break
  }
  await assertClosed(await gateway.nextCreate())
  await client.dispose()
  await expectAbortedThenDone(iterator)
  assert.equal(gateway.posts.length, 0)
})

test('an explicit consumer return suppresses any supplemental terminal when the plugin disposes', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, {
    onCreate: sent => {
      for (const event of responseEvents('gpt-fixture', 'partial').slice(0, 3)) sent.socket.send(JSON.stringify(event))
    },
  })
  const { client } = adapter(t, gateway.baseURL)
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  assert.ok(!(await iterator.next()).done)
  const sent = await gateway.nextCreate()
  gateway.expectCancellation()
  assert.ok(iterator.return)
  assert.equal((await iterator.return()).done, true)
  await assertClosed(sent)
  await client.dispose()
  assert.equal((await iterator.next()).done, true)
  assert.equal((await iterator.next()).done, true)
  assert.equal(gateway.posts.length, 0)
})

test('dispose after an already delivered successful terminal does not append an aborted terminal', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL)
  const iterator = client.stream(request())[Symbol.asyncIterator]()
  for (;;) {
    const next = await iterator.next()
    assert.ok(!next.done)
    if (next.value.type === 'finish') {
      assert.equal(next.value.reason.kind, 'stop')
      break
    }
  }
  await client.dispose()
  await assertClosed(await gateway.nextCreate())
  assert.equal((await iterator.next()).done, true)
  assert.equal((await iterator.next()).done, true)
  assert.equal(gateway.posts.length, 0)
})

test('parallel routes retain independent credentials, profile headers and output', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t, { onCreate: () => {} })
  const { client, credentials } = adapter(t, gateway.baseURL, ['first-ws', 'second-ws'])
  const first = collect(client.stream(request('first-ws')))
  const second = collect(client.stream(request('second-ws')))
  const requests = await Promise.all([gateway.nextCreate(), gateway.nextCreate()])
  const firstRequest = requests.find(sent => sent.headers['x-gateway-route'] === 'first-ws')
  const secondRequest = requests.find(sent => sent.headers['x-gateway-route'] === 'second-ws')
  assert.ok(firstRequest)
  assert.ok(secondRequest)
  assert.equal(firstRequest.headers.authorization, 'Bearer credential:first-ws')
  assert.equal(secondRequest.headers.authorization, 'Bearer credential:second-ws')
  assert.notEqual(firstRequest.socket, secondRequest.socket)
  sendEvents(secondRequest, 'SECOND_ONLY')
  sendEvents(firstRequest, 'FIRST_ONLY')
  const [firstChunks, secondChunks] = await Promise.all([first, second])
  assertSuccess(firstChunks, 'FIRST_ONLY')
  assertSuccess(secondChunks, 'SECOND_ONLY')
  assert.deepEqual(credentials.map(entry => entry.provider).sort(), ['first-ws', 'second-ws'])
  assert.equal(gateway.upgrades.length, 2)
  assert.equal(gateway.posts.length, 0)
  await Promise.all(requests.map(assertClosed))
})

function reasoningRoute(overrides: Partial<GatewayInput> = {}): Partial<GatewayInput> {
  return { models: [{ id: 'gpt-fixture', contextWindow: 32_000, maxTokens: 512, reasoningEfforts: ['high', 'xhigh', 'max'] }], ...overrides }
}

for (const mode of ['websocket', 'sse', 'fallback'] as const) {
  test(`reasoning defaults and explicit overrides survive ${mode}`, { timeout: CASE_TIMEOUT_MS }, async t => {
    const gateway = await wireFixture(t, mode === 'fallback' ? { status: 404 } : {})
    const provider = 'gateway-ws'
    const { client } = adapter(t, gateway.baseURL, [provider], undefined, reasoningRoute({ reasoning: 'xhigh', transport: mode === 'sse' ? 'sse' : 'auto' }))
    assert.equal((await client.resolveModel(provider, 'gpt-fixture')).reasoning?.defaultEffort, 'xhigh')
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    t.after(llm.registerAdapter([provider], client))
    for (const [selection, expected] of [[undefined, 'xhigh'], ['high', 'high'], ['max', 'max']] as const) {
      const { messages, ...config } = request()
      const prepared = await llm.prepareCall({ ...config, ...selection === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection) } })
      assert.equal(prepared.config.reasoningEffort, expected)
      assert.equal(prepared.adapterDefaults.reasoningEffort, selection === undefined ? true : undefined)
      assertSuccess(await collect(prepared.stream({ ...prepared.config, messages })))
      const created = mode === 'websocket' ? await gateway.nextCreate() : undefined
      const sent = created ?? gateway.posts.at(-1)!
      assert.deepEqual(sent.payload.reasoning, { effort: expected, summary: 'auto' })
      assert.deepEqual(sent.payload.include, ['reasoning.encrypted_content'])
      assert.equal(sent.payload.max_output_tokens, 64)
      const diagnostic = client.diagnostics().requests.at(-1)!
      assert.equal(diagnostic.requestedReasoningEffort, expected)
      assert.deepEqual(diagnostic.attempts.map(attempt => [attempt.transport, attempt.sentReasoningEffort, attempt.maxOutputTokens]), [
        [mode === 'websocket' ? 'websocket' : 'sse', expected, 64],
      ])
      if (created !== undefined) await assertClosed(created)
    }
    if (mode === 'websocket') assert.equal(gateway.posts.length, 0)
    else {
      assert.equal(gateway.posts.length, 3)
      assert.equal(gateway.upgrades.length, mode === 'fallback' ? 3 : 0)
    }
  })
}

test('reasoning capabilities without a default do not synthesize an effort', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, reasoningRoute())
  assert.equal((await client.resolveModel('gateway-ws', 'gpt-fixture')).reasoning?.defaultEffort, undefined)
  assertSuccess(await collect(client.stream(request())))
  const sent = await gateway.nextCreate()
  assert.equal(sent.payload.reasoning, undefined)
  assert.equal(sent.payload.reasoning_effort, undefined)
  const diagnostic = client.diagnostics().requests.at(-1)!
  assert.equal(Object.hasOwn(diagnostic, 'requestedReasoningEffort'), false)
  assert.equal(Object.hasOwn(diagnostic.attempts[0]!, 'sentReasoningEffort'), false)
  await assertClosed(sent)
})

test('reasoning diagnostics omit an unsupported effort and a suppressed output cap', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, reasoningRoute({ supportsMaxOutputTokens: false }))
  await assert.rejects(collect(client.stream({ ...request(), reasoningEffort: ReasoningEffortId('fixture-private-value') })), llmCode('UNSUPPORTED_REASONING_EFFORT'))
  const rejected = client.diagnostics().requests.at(-1)!
  assert.equal(Object.hasOwn(rejected, 'requestedReasoningEffort'), false)
  assert.deepEqual(rejected.attempts, [])

  assertSuccess(await collect(client.stream({ ...request(), reasoningEffort: ReasoningEffortId('high') })))
  const sent = await gateway.nextCreate()
  assert.equal(Object.hasOwn(sent.payload, 'max_output_tokens'), false)
  const diagnostic = client.diagnostics().requests.at(-1)!
  assert.equal(diagnostic.requestedReasoningEffort, 'high')
  assert.equal(diagnostic.attempts[0]?.sentReasoningEffort, 'high')
  assert.equal(Object.hasOwn(diagnostic.attempts[0]!, 'maxOutputTokens'), false)
  await assertClosed(sent)
})

test('an explicit off never falls back to the configured reasoning default', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, reasoningRoute({ reasoning: 'high' }))
  await assert.rejects(collect(client.stream({ ...request(), reasoningEffort: ReasoningEffortId('off') })), llmCode('UNSUPPORTED_REASONING_EFFORT'))
  assert.equal(gateway.upgrades.length, 0)
  assert.equal(gateway.posts.length, 0)
})

test('off on a non-reasoning model does not force a wire none effort', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await wireFixture(t)
  const { client } = adapter(t, gateway.baseURL, ['gateway-ws'], undefined, { reasoning: 'off' })
  assertSuccess(await collect(client.stream({ ...request(), reasoningEffort: ReasoningEffortId('off') })))
  const sent = await gateway.nextCreate()
  assert.equal(sent.payload.reasoning, undefined)
  await assertClosed(sent)
})
