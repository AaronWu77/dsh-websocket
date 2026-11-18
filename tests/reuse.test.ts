/** Loopback WS rounds through the public adapter, actual serializer and native replay. */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GatewayAdapter } from '../src/adapter.ts'
import { Config, resolveRoutes } from '../src/config.ts'
import type { GatewayInput } from '../src/config.ts'
import { object } from '../src/continuation.ts'

type Json = Record<string, unknown>
function events(model: string, n: number, output?: Json[], terminalOutput = output) {
  const result = output ?? [{ id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'amber', annotations: [] }] }]
  const all: Json[] = [{ type: 'response.created', response: { id: `resp_${n}`, model, status: 'in_progress', output: [] } }]
  result.forEach((item, index) => {
    all.push({ type: 'response.output_item.added', output_index: index, item: item.type === 'function_call' ? { ...item, arguments: '' } : item })
    if (item.type === 'message') all.push({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: 'amber' })
    if (item.type === 'function_call') all.push({ type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments })
    all.push({ type: 'response.output_item.done', output_index: index, item })
  })
  all.push({ type: 'response.completed', response: { id: `resp_${n}`, model, status: 'completed', output: terminalOutput ?? result, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
  return all
}
async function setup(t: TestContext, options: { config?: Partial<GatewayInput>; rejectUpgrade?: boolean; onRequest?: (payload: Json, ws: WebSocket, n: number) => boolean } = {}) {
  const sockets = new Set<Socket>(), peers = new Set<WebSocket>(), closed: Promise<void>[] = []
  const messages: { payload: Json; bytes: number; connection: number }[] = [], posts: Json[] = []
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as Json; posts.push(payload)
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events(String(payload.model), 100 + posts.length).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  server.on('connection', socket => { sockets.add(socket); closed.push(new Promise(resolve => socket.once('close', () => resolve()))) })
  let upgrades = 0
  server.on('upgrade', (request, socket, head) => {
    if (options.rejectUpgrade) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    wss.handleUpgrade(request, socket, head, ws => {
    const connection = ++upgrades; peers.add(ws); closed.push(new Promise(resolve => ws.once('close', () => resolve())))
    ws.on('message', bytes => {
      const raw = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
      const payload = JSON.parse(raw.toString()) as Json; messages.push({ payload, bytes: raw.byteLength, connection })
      if (options.onRequest?.(payload, ws, messages.length)) return
      for (const event of events(String(payload.model), messages.length)) ws.send(JSON.stringify(event))
    })
    })
  })
  t.after(async () => {
    const http = new Promise<void>(resolve => server.close(() => resolve())), websocket = new Promise<void>(resolve => wss.close(() => resolve()))
    for (const peer of peers) peer.terminate(); for (const socket of sockets) socket.destroy()
    await Promise.all([http, websocket, ...closed])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const config = Config({ providers: { fixture: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'FIXTURE', models: [{ id: 'gpt-fixture', contextWindow: 100000, maxTokens: 512 }], closeTimeoutMs: 100, ...options.config } } })
  let credential = 'key-a'
  const adapter = new GatewayAdapter(resolveRoutes(config), { resolveApiKey: async () => credential, report: () => {} })
  t.after(() => adapter.dispose())
  const call = async (history: RequestMessage[], id = 'session-a', tools?: GenerateOptions['tools']) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'fixture', model: 'gpt-fixture', messages: history, sessionId: id as NonNullable<GenerateOptions['sessionId']>, maxTokens: 128, ...tools === undefined ? {} : { tools } })) chunks.push(chunk)
    const finish = chunks.findLast(c => c.type === 'finish'); assert.ok(finish?.type === 'finish')
    return { chunks, finish }
  }
  return { adapter, messages, posts, peers, call, config, upgrades: () => upgrades, credential: (value: string) => { credential = value } }
}
const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
function replay(chunks: StreamChunk[]): RequestMessage {
  const finish = chunks.findLast(c => c.type === 'finish'); assert.ok(finish?.type === 'finish')
  return { id: randomUUID() as Extract<RequestMessage, { role: 'assistant' }>['id'], role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'gpt-fixture', replayState: finish.replayState }, content: chunks.flatMap(c => c.type === 'block-end' ? [c.block] : []) }
}

test('three serialized rounds reuse one WS and upload only added context after completion', { timeout: 15000 }, async t => {
  const wire = await setup(t), history = [user('你好 '.repeat(1000))]
  const a = await wire.call(history); history.push(replay(a.chunks), user('next'))
  const b = await wire.call(history); history.push(replay(b.chunks), user('last')); await wire.call(history)
  assert.equal(wire.upgrades(), 1); assert.equal(wire.posts.length, 0)
  assert.equal(wire.messages[0]!.payload.previous_response_id, undefined)
  assert.equal(wire.messages[1]!.payload.previous_response_id, 'resp_1'); assert.equal(wire.messages[2]!.payload.previous_response_id, 'resp_2')
  assert.equal((wire.messages[1]!.payload.input as unknown[]).length, 1)
  const diagnostics = wire.adapter.diagnostics()
  for (let i = 0; i < 3; i++) assert.equal(diagnostics.requests[i]!.attempts[0]!.requestBytes, wire.messages[i]!.bytes)
  const totals = diagnostics.requests.flatMap(r => r.attempts).reduce((sum, a) => ({ sent: sum.sent + a.requestBytes, full: sum.full + a.fullBytes }), { sent: 0, full: 0 })
  assert.ok(totals.sent < totals.full * 0.5)
  assert.equal(diagnostics.routes[0]!.pool.busy, 0)
  await wire.adapter.dispose(); assert.equal(wire.adapter.diagnostics().routes[0]!.pool.connections, 0)
})
for (const { name, logprobs, delta } of [
  { name: 'empty output logprobs do not block continuation', logprobs: [], delta: true },
  { name: 'nonempty output logprobs require a full request if replay omits them', logprobs: [{ token: 'amber', logprob: -0.1, bytes: [97, 109, 98, 101, 114], top_logprobs: [] }], delta: false },
]) test(name, { timeout: 15000 }, async t => {
  const content = { type: 'output_text', text: 'amber', annotations: [] }
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'final_answer', content: [content] }
  const wire = await setup(t, { onRequest: (payload, ws, n) => {
    if (n !== 1) return false
    const terminalOutput = [{ ...item, content: [{ ...content, logprobs }] }]
    for (const event of events(String(payload.model), n, [item], terminalOutput)) ws.send(JSON.stringify(event))
    return true
  } })
  const history = [user('first')], a = await wire.call(history)
  history.push(replay(a.chunks), user('next'))
  assert.equal((await wire.call(history)).finish.reason.kind, 'stop')
  assert.equal(wire.upgrades(), 1); assert.equal(wire.posts.length, 0)
  const attempt = wire.adapter.diagnostics().requests[1]!.attempts[0]!
  const frame = wire.messages[1]!.payload
  assert.equal(attempt.reused, true)
  assert.equal(attempt.delta, delta)
  assert.equal(attempt.resetReason, delta ? undefined : 'context-changed')
  assert.deepEqual(attempt.continuationComparison, delta ? undefined : {
    kind: 'item-mismatch', inputLength: 3, previousInputLength: 1, previousOutputLength: 1,
    firstDifference: {
      index: 1, section: 'prior-output', previousType: 'message', currentType: 'message',
      fields: [{ name: 'content[].logprobs', previousPresent: true, currentPresent: false }],
    },
  })
  assert.equal(frame.previous_response_id, delta ? 'resp_1' : undefined)
  assert.ok(Array.isArray(frame.input))
  assert.equal(frame.input.length, delta ? 1 : 3)
})

for (const testCase of ['standard', 'codex', 'fallback', 'instructions', 'instructions-fallback'] as const) {
  test(`${testCase}: request layout preserves instructions, cache identity and transport intent`, { timeout: 15000 }, async t => {
    const lifted = testCase.startsWith('instructions')
    const fallback = testCase.endsWith('fallback')
    const wire = await setup(t, { config: { requestFormat: lifted ? 'codex-instructions' : testCase === 'standard' ? 'standard' : 'codex', models: [{ id: 'gpt-fixture', contextWindow: 100000, maxTokens: 512, reasoningEfforts: ['high'] }] }, rejectUpgrade: fallback })
    const history: RequestMessage[] = [createSystemMessage('Stable instructions.'), user('first')]
    const first = await wire.call(history)
    assert.equal(first.finish.reason.kind, 'stop')
    const payload = fallback ? wire.posts[0]! : wire.messages[0]!.payload
    assert.equal(payload.store, false)
    assert.equal(payload.previous_response_id, undefined)
    assert.ok(Array.isArray(payload.input))
    assert.equal(payload.instructions, lifted ? 'Stable instructions.' : undefined)
    assert.equal(wire.adapter.diagnostics().requests[0]?.attempts[0]?.hasTopLevelInstructions, lifted ? true : undefined)
    assert.deepEqual(payload.input[0], lifted
      ? { role: 'user', content: [{ type: 'input_text', text: 'first' }] }
      : testCase === 'standard'
        ? { role: 'developer', content: 'Stable instructions.' }
        : { role: 'developer', type: 'message', content: [{ type: 'input_text', text: 'Stable instructions.' }] })
    history.push(replay(first.chunks), user('second'))
    if (!fallback) {
      await wire.call(history)
      assert.equal(wire.upgrades(), 1)
      assert.equal(wire.messages[1]!.payload.previous_response_id, 'resp_1')
      assert.equal(wire.messages[1]!.payload.prompt_cache_key, payload.prompt_cache_key)
      assert.deepEqual(wire.messages[1]!.payload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'second' }] }])
      assert.equal(wire.messages[1]!.payload.instructions, payload.instructions)
      assert.equal(wire.adapter.diagnostics().requests[1]?.attempts[0]?.hasTopLevelInstructions, lifted ? true : undefined)
      if (lifted) {
        history[0] = createSystemMessage('Changed instructions.')
        await wire.call(history)
        assert.equal(wire.messages[2]!.payload.instructions, 'Changed instructions.')
        assert.equal(wire.messages[2]!.payload.previous_response_id, undefined)
        assert.equal(wire.adapter.diagnostics().requests[2]?.attempts[0]?.resetReason, 'parameters-changed')
      }
    } else {
      assert.equal(wire.messages.length, 0)
      assert.ok(wire.adapter.diagnostics().requests[0]?.attempts[0]?.fallbackReason)
    }
  })
}

test('history edits and separate sessions never reuse a mismatched continuation head', { timeout: 15000 }, async t => {
  const wire = await setup(t), a = await wire.call([user('old history')])
  await wire.call([user('summary replaces old history'), replay(a.chunks), user('next')]); assert.equal(wire.messages[1]!.payload.previous_response_id, undefined)
  await wire.call([user('unrelated')], 'session-b'); assert.equal(wire.messages[2]!.payload.previous_response_id, undefined)
  assert.notEqual(wire.messages[2]!.connection, wire.messages[1]!.connection)
})
test('credential rotation, reset and peer disconnect create new full-context chains', { timeout: 15000 }, async t => {
  const wire = await setup(t), history = [user('remember')], a = await wire.call(history)
  history.push(replay(a.chunks), user('next')); wire.credential('key-b'); const b = await wire.call(history)
  assert.equal(wire.messages[1]!.payload.previous_response_id, undefined)
  await wire.adapter.reset('fixture'); history.push(replay(b.chunks), user('more')); const c = await wire.call(history)
  assert.equal(wire.messages[2]!.payload.previous_response_id, undefined)
  const peer = [...wire.peers].at(-1)!, closed = new Promise<void>(resolve => peer.once('close', () => resolve())); peer.close(); await closed
  history.push(replay(c.chunks), user('after disconnect')); await wire.call(history)
  assert.equal(wire.messages[3]!.payload.previous_response_id, undefined); assert.equal(wire.upgrades(), 4)
})
test('a missing parent allows one full rebuild before generation, with both attempts measured', { timeout: 15000 }, async t => {
  const wire = await setup(t, { onRequest: (_payload, ws, n) => {
    if (n === 2) { ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'gone' } })); return true }
    return false
  } })
  const history = [user('remember')], a = await wire.call(history); history.push(replay(a.chunks), user('next')); const b = await wire.call(history)
  assert.equal(b.finish.reason.kind, 'stop'); assert.equal(wire.messages.length, 3)
  assert.equal(wire.messages[1]!.payload.previous_response_id, 'resp_1'); assert.equal(wire.messages[2]!.payload.previous_response_id, undefined)
  assert.equal(wire.adapter.diagnostics().requests[1]!.attempts.length, 2)
})
test('two pending same-session calls cannot consume each other\'s WS response', { timeout: 15000 }, async t => {
  let start!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const wire = await setup(t, { onRequest: (payload, ws, n) => {
    if (n === 1) { start(); finish = () => { for (const event of events(String(payload.model), n)) ws.send(JSON.stringify(event)) }; return true }
    return false
  } })
  const pending = wire.call([user('first')]); await started
  assert.equal((await wire.call([user('second')])).finish.reason.kind, 'stop'); assert.equal(wire.posts.length, 1)
  const fallback = wire.adapter.diagnostics().requests[1]!.attempts
  assert.deepEqual(fallback.map(attempt => attempt.transport), ['sse'])
  assert.equal(Object.hasOwn(fallback[0]!, 'fallbackReason'), false)
  finish(); assert.equal((await pending).finish.reason.kind, 'stop'); assert.equal(wire.upgrades(), 1)
})
test('Codex-style tool replay retains ids while sending only newly added tool results', { timeout: 15000 }, async t => {
  const wire = await setup(t, { config: { requestFormat: 'codex' }, onRequest: (payload, ws, n) => {
    if (n === 1) { for (const event of events(String(payload.model), n, [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'read', status: 'completed', arguments: '{"path":"a"}' }])) ws.send(JSON.stringify(event)); return true }
    return false
  } })
  const tools = [{ name: 'read', description: 'Read a test file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
  const history = [user('read a')], a = await wire.call(history, 'session-a', tools), call = a.chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(wire.messages[0]!.payload.tool_choice, 'auto')
  assert.ok(Array.isArray(wire.messages[0]!.payload.tools) && wire.messages[0]!.payload.tools.length === 1)
  assert.ok(call?.type === 'block-end' && call.block.type === 'tool-call')
  history.push(replay(a.chunks), { role: 'tool', id: 'tool_result' as Extract<RequestMessage, { role: 'tool' }>['id'], source: { kind: 'tool', callId: call.block.id }, toolCallId: call.block.id, content: [{ type: 'text', text: 'file contents' }] })
  await wire.call(history, 'session-a', tools); assert.equal(wire.messages[1]!.payload.previous_response_id, 'resp_1')
  const input = wire.messages[1]!.payload.input as unknown[]
  assert.equal(input.length, 1); assert.equal(object(input[0])?.type, 'function_call_output'); assert.equal(object(input[0])?.call_id, 'call_fixture')
})
test('a post-send idle deadline is an unknown outcome and never dispatches SSE', { timeout: 15000 }, async t => {
  const wire = await setup(t, { config: { streamIdleTimeoutMs: 250 }, onRequest: (_payload, ws) => { ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_stalled', status: 'in_progress', output: [] } })); return true } })
  await assert.rejects(wire.call([user('stalled')]), (error: unknown) => object(error)?.code === 'OUTCOME_UNKNOWN')
  assert.equal(wire.messages.length, 1); assert.equal(wire.posts.length, 0)
  assert.equal(wire.adapter.diagnostics().requests[0]!.code, 'OUTCOME_UNKNOWN')
})
test('idle retention expires by closing the owned peer, and the next request sends full context', { timeout: 15000 }, async t => {
  const wire = await setup(t, { config: { connectionIdleMs: 20 } }), a = await wire.call([user('first')])
  const peer = [...wire.peers][0]!
  if (peer.readyState !== peer.CLOSED) await new Promise<void>(resolve => peer.once('close', () => resolve()))
  await wire.call([user('first'), replay(a.chunks), user('next')])
  assert.equal(wire.upgrades(), 2); assert.equal(wire.messages[1]!.payload.previous_response_id, undefined)
})
for (const policy of [{ reuseConnection: false }, { continuation: false }]) test(`connection reuse and continuation are independently configurable: ${JSON.stringify(policy)}`, { timeout: 15000 }, async t => {
  const wire = await setup(t, { config: policy }), history = [user('first')], a = await wire.call(history)
  history.push(replay(a.chunks), user('next')); await wire.call(history)
  assert.equal(wire.messages[1]!.payload.previous_response_id, undefined)
  assert.equal(wire.upgrades(), policy.reuseConnection === false ? 2 : 1)
})
test('prepared calls retain their captured route after live settings change', { timeout: 15000 }, async t => {
  const wire = await setup(t), prepared = await wire.adapter.prepareCall('fixture', 'gpt-fixture')
  const next = Config({ providers: { fixture: { ...wire.config.providers.fixture!, transport: 'sse' } } })
  wire.adapter.updateRoutes(resolveRoutes(next))
  for await (const _chunk of prepared.stream({ provider: 'fixture', model: 'gpt-fixture', messages: [user('prepared')], sessionId: 'prepared-session' as NonNullable<GenerateOptions['sessionId']> })) { /* Drain the captured generation. */ }
  assert.equal(wire.messages.length, 1); assert.equal(wire.posts.length, 0)
  await wire.call([user('new settings')]); assert.equal(wire.posts.length, 1)
})

test('closing connections still count against the route capacity and eviction falls back instead of oversubscribing', { timeout: 15000 }, async t => {
  const wire = await setup(t, { config: { maxConnections: 1 } })
  await wire.call([user('first')], 'capacity-a')
  assert.equal(wire.adapter.diagnostics().routes[0]!.pool.connections, 1)
  await wire.call([user('second')], 'capacity-b')
  assert.equal(wire.upgrades(), 1, 'the evicted socket must finish closing before a replacement WS is admitted')
  assert.equal(wire.posts.length, 1)
  await wire.adapter.reset('fixture')
  await wire.call([user('third')], 'capacity-c')
  assert.equal(wire.upgrades(), 2)
  assert.equal(wire.adapter.diagnostics().routes[0]!.pool.connections, 1)
})
