/** Loopback wire tests for request-owned Responses WebSocket/SSE dispatch. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { ResponsesTransport, TransportFailure } from '../src/transport.ts'
import type { ResponsesTransportOptions, TransportFailureCode } from '../src/transport.ts'

const CASE_TIMEOUT_MS = 15_000

type Report = Parameters<ResponsesTransportOptions['report']>[0]
type JsonRecord = Record<string, unknown>

interface AcceptedConnection {
  socket: WebSocket
  request: IncomingMessage
  closed: Promise<void>
}

interface CreatedRequest extends AcceptedConnection {
  payload: JsonRecord
}

interface UpgradeAttempt {
  request: IncomingMessage
  closed: Promise<void>
}

interface HttpAttempt {
  request: IncomingMessage
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
    if (value !== undefined) return Promise.resolve(value)
    return new Promise(resolve => this.readers.push(resolve))
  }
}

function record(value: unknown): JsonRecord {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as JsonRecord
}

function completed(model: string, text = `ws:${model}`): JsonRecord {
  return {
    type: 'response.completed',
    sequence_number: 2,
    response: {
      id: `resp_${model}`,
      object: 'response',
      model,
      status: 'completed',
      output: [{ id: `msg_${model}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
  }
}

function created(model: string): JsonRecord {
  return {
    type: 'response.created',
    sequence_number: 0,
    response: { id: `resp_${model}`, object: 'response', model, status: 'in_progress', output: [] },
  }
}

function delta(text: string): JsonRecord {
  return { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: text }
}

interface FixtureOptions {
  upgrade?: 'accept' | 'stall' | number
  onCreate?: (request: CreatedRequest) => void
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const upgrades: UpgradeAttempt[] = []
  const accepted: AcceptedConnection[] = []
  const posts: HttpAttempt[] = []
  const errors: unknown[] = []
  const upgradeQueue = new Queue<UpgradeAttempt>()
  const createQueue = new Queue<CreatedRequest>()
  const rawSockets = new Map<Socket, Promise<void>>()
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', error => errors.push(error))
    request.on('end', () => {
      try {
        const payload = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        posts.push({ request, payload })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`event: response.completed\ndata: ${JSON.stringify(completed(String(payload.model), `sse:${String(payload.model)}`))}\n\n`)
      } catch (error: unknown) {
        errors.push(error)
        response.writeHead(500).end()
      }
    })
  })
  server.on('connection', socket => {
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    rawSockets.set(socket, closed)
    socket.on('error', error => errors.push(error))
  })
  server.on('upgrade', (request, socket, head) => {
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    const attempt = { request, closed }
    upgrades.push(attempt)
    upgradeQueue.push(attempt)
    if (options.upgrade === 'stall') {
      socket.once('end', () => socket.end())
      socket.resume()
      return
    }
    if (typeof options.upgrade === 'number') {
      socket.end(`HTTP/1.1 ${options.upgrade} Fixture rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const connection = { socket: ws, request, closed: new Promise<void>(resolve => ws.once('close', () => resolve())) }
      accepted.push(connection)
      ws.on('error', error => errors.push(error))
      ws.on('message', data => {
        try {
          const message = { ...connection, payload: record(JSON.parse(data.toString())) }
          createQueue.push(message)
          options.onCreate?.(message)
        } catch (error: unknown) {
          errors.push(error)
          ws.terminate()
        }
      })
    })
  })
  let stopped = false
  async function close(): Promise<void> {
    if (stopped) return
    stopped = true
    const wsClosed = new Promise<void>((resolve, reject) => wss.close(error => error === undefined ? resolve() : reject(error)))
    const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    for (const connection of accepted) connection.socket.terminate()
    server.closeAllConnections()
    for (const socket of rawSockets.keys()) socket.destroy()
    await Promise.all([wsClosed, httpClosed, ...accepted.map(connection => connection.closed), ...rawSockets.values()])
  }
  t.after(async () => {
    await close()
    assert.deepEqual(errors, [], 'the fixture did not encounter server or socket errors')
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
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    upgrades,
    accepted,
    posts,
    nextUpgrade: () => upgradeQueue.next(),
    nextCreate: () => createQueue.next(),
  }
}

function transport(t: TestContext, baseURL: string, overrides: Partial<ResponsesTransportOptions> = {}) {
  const reports: Report[] = []
  const abort = new AbortController()
  const client = new ResponsesTransport({
    mode: 'auto',
    baseURL,
    apiKey: 'fixture-key',
    signal: abort.signal,
    connectTimeoutMs: 3_000,
    closeTimeoutMs: 200,
    maxFrameBytes: 1024 * 1024,
    maxBufferedEvents: 64,
    report: event => reports.push(event),
    ...overrides,
  })
  t.after(() => client.close())
  return { client, abort, reports }
}

function dispatch(client: ResponsesTransport, baseURL: string, model = 'gpt-fixture', key = 'fixture-key'): Promise<Response> {
  return client.fetch(`${baseURL}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-fixture-model': model },
    body: JSON.stringify({ model, input: `input:${model}`, stream: true, background: false }),
  })
}

function failureCode(expected: TransportFailureCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TransportFailure)
    assert.equal(error.code, expected)
    return true
  }
}

async function assertClosed(connection: AcceptedConnection): Promise<void> {
  await connection.closed
  assert.equal(connection.socket.readyState, WebSocket.CLOSED)
}

test('WS success preserves the serialized payload and closes without sending SSE', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, {
    onCreate: request => {
      request.socket.send(JSON.stringify(created(String(request.payload.model))))
      request.socket.send(JSON.stringify(delta('fixture answer')))
      request.socket.send(JSON.stringify(completed(String(request.payload.model))))
    },
  })
  const { client, reports } = transport(t, gateway.baseURL)
  const response = await dispatch(client, gateway.baseURL)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const text = await response.text()
  const request = await gateway.nextCreate()
  assert.equal(request.request.url, '/v1/responses')
  assert.equal(request.request.headers.authorization, 'Bearer fixture-key')
  assert.equal(request.request.headers['x-fixture-model'], 'gpt-fixture')
  assert.deepEqual(request.payload, { type: 'response.create', model: 'gpt-fixture', input: 'input:gpt-fixture' })
  assert.match(text, /response\.created/)
  assert.match(text, /fixture answer/)
  assert.match(text, /response\.completed/)
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [{ transport: 'websocket', phase: 'connected' }])
  await assertClosed(request)
})

test('404 during the WS handshake falls back once to the original SSE request', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { upgrade: 404 })
  const { client, reports } = transport(t, gateway.baseURL)
  const response = await dispatch(client, gateway.baseURL)
  assert.match(await response.text(), /sse:gpt-fixture/)
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.accepted.length, 0)
  assert.equal(gateway.posts.length, 1)
  assert.deepEqual(gateway.posts[0]!.payload, { model: 'gpt-fixture', input: 'input:gpt-fixture', stream: true, background: false })
  assert.equal(gateway.posts[0]!.request.headers.authorization, 'Bearer fixture-key')
  assert.deepEqual(reports, [{ transport: 'sse', phase: 'fallback', code: 'INVALID_REQUEST' }])
  await gateway.upgrades[0]!.closed
})

test('401 during the WS handshake reports AUTH without a second SSE request', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { upgrade: 401 })
  const { client, reports } = transport(t, gateway.baseURL)
  await assert.rejects(dispatch(client, gateway.baseURL), failureCode('AUTH'))
  assert.equal(client.failure?.status, 401)
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [])
  await gateway.upgrades[0]!.closed
})

test('a flat invalid_api_key WS event reports AUTH without SSE or raw provider diagnostics', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, {
    onCreate: request => request.socket.send(JSON.stringify({ type: 'error', code: 'invalid_api_key', message: 'private gateway diagnostic' })),
  })
  const { client, reports } = transport(t, gateway.baseURL)
  await assert.rejects(dispatch(client, gateway.baseURL), error => {
    failureCode('AUTH')(error)
    assert.ok(error instanceof TransportFailure)
    assert.equal(error.fallbackAllowed, false)
    assert.doesNotMatch(error.message, /private gateway diagnostic/)
    return true
  })
  assert.equal(client.failure?.code, 'AUTH')
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [{ transport: 'websocket', phase: 'connected' }])
  await assertClosed(await gateway.nextCreate())
})

test('a nested insufficient_quota WS event reports QUOTA without SSE even with status 429', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, {
    onCreate: request => request.socket.send(JSON.stringify({ type: 'error', status: 429, error: { code: 'insufficient_quota', message: 'private quota diagnostic' } })),
  })
  const { client, reports } = transport(t, gateway.baseURL)
  await assert.rejects(dispatch(client, gateway.baseURL), error => {
    failureCode('QUOTA')(error)
    assert.ok(error instanceof TransportFailure)
    assert.equal(error.status, 429)
    assert.equal(error.fallbackAllowed, false)
    assert.doesNotMatch(error.message, /private quota diagnostic/)
    return true
  })
  assert.equal(client.failure?.code, 'QUOTA')
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [{ transport: 'websocket', phase: 'connected' }])
  await assertClosed(await gateway.nextCreate())
})

test('an expired WS handshake falls back to SSE and releases the stalled socket', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { upgrade: 'stall' })
  const { client, reports } = transport(t, gateway.baseURL, { connectTimeoutMs: 150 })
  const response = await dispatch(client, gateway.baseURL)
  assert.match(await response.text(), /sse:gpt-fixture/)
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 1)
  assert.deepEqual(reports, [{ transport: 'sse', phase: 'fallback', code: 'TIMEOUT' }])
  await gateway.upgrades[0]!.closed
})

test('cancelling a pending handshake closes it without falling back to SSE', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { upgrade: 'stall' })
  const { client, abort, reports } = transport(t, gateway.baseURL)
  const rejected = assert.rejects(dispatch(client, gateway.baseURL), failureCode('ABORTED'))
  const upgrade = await gateway.nextUpgrade()
  abort.abort(new Error('fixture cancellation'))
  await rejected
  await upgrade.closed
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [])
})

test('closing after response.create but before any event reports OUTCOME_UNKNOWN without SSE', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { onCreate: request => request.socket.close(1011, 'fixture unknown outcome') })
  const { client } = transport(t, gateway.baseURL)
  await assert.rejects(dispatch(client, gateway.baseURL), failureCode('OUTCOME_UNKNOWN'))
  const request = await gateway.nextCreate()
  assert.equal(request.payload.type, 'response.create')
  assert.equal(gateway.upgrades.length, 1)
  assert.equal(gateway.posts.length, 0)
  await assertClosed(request)
})

test('closing after created and partial output fails that stream without appending SSE', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, {
    onCreate: request => {
      request.socket.send(JSON.stringify(created('gpt-fixture')))
      request.socket.send(JSON.stringify(delta('partial fixture text')))
      request.socket.close(1011, 'fixture partial stream')
    },
  })
  const { client, reports } = transport(t, gateway.baseURL)
  const response = await dispatch(client, gateway.baseURL)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  await assert.rejects(async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
  }, failureCode('OUTCOME_UNKNOWN'))
  const partial = Buffer.concat(chunks).toString('utf8')
  assert.match(partial, /response\.created/)
  assert.match(partial, /partial fixture text/)
  assert.doesNotMatch(partial, /sse:|response\.completed/)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(reports, [{ transport: 'websocket', phase: 'connected' }])
  await assertClosed(await gateway.nextCreate())
})

test('SSE mode dispatches HTTP directly without attempting a WS upgrade', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t)
  const { client, reports } = transport(t, gateway.baseURL, { mode: 'sse' })
  const response = await dispatch(client, gateway.baseURL)
  assert.match(await response.text(), /sse:gpt-fixture/)
  assert.equal(gateway.upgrades.length, 0)
  assert.equal(gateway.posts.length, 1)
  assert.deepEqual(reports, [{ transport: 'sse', phase: 'request' }])
})

test('concurrent transport instances isolate credentials, payloads and response bodies', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t)
  const first = transport(t, gateway.baseURL, { apiKey: 'fixture-first' })
  const second = transport(t, gateway.baseURL, { apiKey: 'fixture-second' })
  const firstResponse = dispatch(first.client, gateway.baseURL, 'gpt-first', 'fixture-first')
  const secondResponse = dispatch(second.client, gateway.baseURL, 'gpt-second', 'fixture-second')
  const requests = await Promise.all([gateway.nextCreate(), gateway.nextCreate()])
  const firstRequest = requests.find(request => request.payload.model === 'gpt-first')
  const secondRequest = requests.find(request => request.payload.model === 'gpt-second')
  assert.ok(firstRequest)
  assert.ok(secondRequest)
  assert.notEqual(firstRequest.socket, secondRequest.socket)
  assert.equal(firstRequest.request.headers.authorization, 'Bearer fixture-first')
  assert.equal(secondRequest.request.headers.authorization, 'Bearer fixture-second')
  assert.equal(firstRequest.request.headers['x-fixture-model'], 'gpt-first')
  assert.equal(secondRequest.request.headers['x-fixture-model'], 'gpt-second')
  secondRequest.socket.send(JSON.stringify(completed('gpt-second', 'SECOND_ONLY')))
  firstRequest.socket.send(JSON.stringify(completed('gpt-first', 'FIRST_ONLY')))
  const [firstText, secondText] = await Promise.all([firstResponse.then(response => response.text()), secondResponse.then(response => response.text())])
  assert.match(firstText, /FIRST_ONLY/)
  assert.doesNotMatch(firstText, /SECOND_ONLY/)
  assert.match(secondText, /SECOND_ONLY/)
  assert.doesNotMatch(secondText, /FIRST_ONLY/)
  assert.equal(gateway.upgrades.length, 2)
  assert.equal(gateway.posts.length, 0)
  assert.deepEqual(first.reports, [{ transport: 'websocket', phase: 'connected' }])
  assert.deepEqual(second.reports, [{ transport: 'websocket', phase: 'connected' }])
  await Promise.all(requests.map(assertClosed))
})

test('cancelling response consumption waits for the owned WS connection to close', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { onCreate: request => request.socket.send(JSON.stringify(created('gpt-fixture'))) })
  const { client } = transport(t, gateway.baseURL)
  const response = await dispatch(client, gateway.baseURL)
  assert.ok(response.body)
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel('fixture consumer stopped')
  await assertClosed(await gateway.nextCreate())
  assert.equal(gateway.posts.length, 0)
})

test('caller cancellation rejects an active WS stream and closes it without SSE', { timeout: CASE_TIMEOUT_MS }, async t => {
  const gateway = await fixture(t, { onCreate: request => request.socket.send(JSON.stringify(created('gpt-fixture'))) })
  const { client, abort } = transport(t, gateway.baseURL)
  const response = await dispatch(client, gateway.baseURL)
  assert.ok(response.body)
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  const rejected = assert.rejects(reader.read(), failureCode('ABORTED'))
  abort.abort(new Error('fixture active-stream cancellation'))
  await rejected
  await assertClosed(await gateway.nextCreate())
  assert.equal(gateway.posts.length, 0)
})

for (const mode of ['websocket', 'sse', 'fallback'] as const) {
  test(`Responses reasoning and nested fields are preserved over ${mode}`, { timeout: CASE_TIMEOUT_MS }, async t => {
    const gateway = await fixture(t, {
      upgrade: mode === 'fallback' ? 404 : 'accept',
      onCreate: request => {
        request.socket.send(JSON.stringify(created(String(request.payload.model))))
        request.socket.send(JSON.stringify(completed(String(request.payload.model))))
      },
    })
    const { client } = transport(t, gateway.baseURL, { mode: mode === 'sse' ? 'sse' : 'auto' })
    const payload = {
      model: 'gpt-fixture', input: 'input:gpt-fixture', stream: true, background: false,
      reasoning: { effort: 'xhigh', summary: 'auto' }, include: ['reasoning.encrypted_content'],
      text: { format: { type: 'text' } }, metadata: { trace: 'reasoning-wire-fixture' },
    }
    const response = await client.fetch(`${gateway.baseURL}/responses`, {
      method: 'POST', headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 200)
    await response.text()
    if (mode === 'websocket') {
      const sent = await gateway.nextCreate()
      const { stream: _stream, background: _background, ...body } = payload
      assert.deepEqual(sent.payload, { ...body, type: 'response.create' })
      assert.equal(Object.hasOwn(sent.payload, 'reasoning_effort'), false)
      assert.equal(gateway.posts.length, 0)
      await assertClosed(sent)
    } else {
      assert.deepEqual(gateway.posts[0]!.payload, payload)
      assert.equal(gateway.posts.length, 1)
      assert.equal(gateway.upgrades.length, mode === 'fallback' ? 1 : 0)
      if (mode === 'fallback') await gateway.upgrades[0]!.closed
    }
  })
}
