/** Gateway model discovery over a real loopback /v1/models endpoint and WS wire. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config, resolveRoutes } from '../src/config.ts'
import type { ConfigInput, GatewayInput } from '../src/config.ts'
import { GatewayAdapter } from '../src/adapter.ts'

const CASE_TIMEOUT_MS = 15_000

interface DiscoveryFixture {
  baseURL: string
  modelRequests: number
  dispose: () => Promise<void>
}

function responseEvents(text = 'discovered answer') {
  const item = { id: 'msg_discovered', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_discovered', object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_discovered', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    {
      type: 'response.completed', sequence_number: 4,
      response: {
        id: 'resp_discovered', object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 },
      },
    },
  ]
}

async function discoveryFixture(t: TestContext, options: { models: unknown[]; failModels?: boolean }): Promise<DiscoveryFixture> {
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<Socket>()
  const peers = new Set<WebSocket>()
  let modelRequests = 0
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      modelRequests++
      if (options.failModels === true) {
        response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"fixture discovery failure"}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: options.models }))
      return
    }
    response.writeHead(404).end()
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    wss.handleUpgrade(request, socket, head, peer => {
      peers.add(peer)
      peer.once('close', () => peers.delete(peer))
      peer.on('message', (data: Buffer) => {
        const payload = JSON.parse(data.toString()) as { model?: string }
        for (const event of responseEvents()) peer.send(JSON.stringify(event))
        void payload
      })
    })
  })
  t.after(async () => {
    for (const peer of peers) peer.terminate()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => wss.close(error => error === undefined ? resolve() : reject(error)))
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
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
    get modelRequests() { return modelRequests },
    dispose: async () => { /* teardown is registered on the test context */ },
  }
}

function declaration(baseURL: string, overrides: Partial<GatewayInput> = {}): ConfigInput {
  return {
    providers: {
      'gateway-discovery': {
        displayName: 'Gateway discovery',
        baseURL,
        apiKeyEnv: 'GATEWAY_DISCOVERY_KEY',
        transport: 'auto',
        discover: true,
        discovery: { contextWindow: 500_000, maxTokens: 128_000, input: ['text'], reasoningEfforts: ['high', 'xhigh'] },
        models: [{ id: 'gpt-6.1-sol', contextWindow: 1_000, maxTokens: 256, input: ['text'], reasoningEfforts: ['high'] }],
        ...overrides,
      },
    },
  }
}

function adapter(t: TestContext, baseURL: string, overrides: Partial<GatewayInput> = {}) {
  const errors: Array<{ provider: string; message: string }> = []
  const client = new GatewayAdapter(resolveRoutes(Config(declaration(baseURL, overrides))), {
    resolveApiKey: async () => 'discovery-test-key',
    onDiscoveryError: (provider, message) => errors.push({ provider, message }),
    report: () => { /* transport reports are covered by adapter.test.ts */ },
  })
  t.after(() => client.dispose())
  return { client, errors }
}

test('discovery appends new GPT models, filters non-GPT and keeps explicit metadata', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await discoveryFixture(t, {
    models: [
      { id: 'gpt-6.1-sol', display_name: 'Explicit Sol' },
      { id: 'gpt-6.2-new', display_name: 'GPT-6.2 New' },
      { id: 'deepseek-v4.1-flash', display_name: 'DeepSeek' },
      { id: 'openai/gpt-6.1-terra', display_name: 'GPT Terra' },
      { id: 'gpt-image-2.6-flare', display_name: 'Image model' },
      { id: 'gpt-4o-audio-preview', display_name: 'Audio model' },
    ],
  })
  const { client, errors } = adapter(t, fixture.baseURL)
  const models = await client.listModels('gateway-discovery')
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6.2-new', 'openai/gpt-6.1-terra'])
  assert.equal(models.some(model => model.id === 'deepseek-v4.1-flash'), false)
  assert.equal(fixture.modelRequests, 1)
  assert.deepEqual(errors, [])

  const explicit = await client.resolveModel('gateway-discovery', 'gpt-6.1-sol')
  assert.equal(explicit.context?.contextWindow, 1_000)
  assert.equal(explicit.defaultMaxTokens, 256)
  assert.deepEqual(explicit.reasoning?.efforts.map(effort => effort.id), ['high'])

  const discovered = await client.resolveModel('gateway-discovery', 'gpt-6.2-new')
  assert.equal(discovered.context?.contextWindow, 500_000)
  assert.equal(discovered.defaultMaxTokens, 128_000)
  assert.deepEqual(discovered.reasoning?.efforts.map(effort => effort.id), ['high', 'xhigh'])
  assert.equal(fixture.modelRequests, 1, 'the second catalog read reuses the discovery cache')
})

test('a discovered model dispatches over the real WS transport', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await discoveryFixture(t, { models: [{ id: 'gpt-6.2-new', display_name: 'GPT-6.2 New' }] })
  const { client } = adapter(t, fixture.baseURL)
  await client.listModels('gateway-discovery')
  const chunks: StreamChunk[] = []
  for await (const chunk of client.stream({
    provider: 'gateway-discovery',
    model: 'gpt-6.2-new',
    maxTokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'discovery input' }] }],
  })) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'discovered answer')
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('a failed discovery keeps explicit models and reports one safe warning', { timeout: CASE_TIMEOUT_MS }, async t => {
  const fixture = await discoveryFixture(t, { models: [], failModels: true })
  const { client, errors } = adapter(t, fixture.baseURL)
  const models = await client.listModels('gateway-discovery')
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.provider, 'gateway-discovery')
  assert.match(errors[0]?.message ?? '', /HTTP 500/u)
})

test('discovery-only configuration needs no explicit models and still rejects a non-GPT explicit id', () => {
  const base = declaration('http://127.0.0.1:1/v1')
  const discoveryOnly = structuredClone(base)
  discoveryOnly.providers!['gateway-discovery'].models = []
  assert.equal(resolveRoutes(Config(discoveryOnly)).get('gateway-discovery')?.models.length, 0)

  const noDiscovery = structuredClone(base)
  noDiscovery.providers!['gateway-discovery'].models = []
  noDiscovery.providers!['gateway-discovery'].discover = false
  assert.throws(() => resolveRoutes(Config(noDiscovery)), (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CONFIG')

  const nonGpt = structuredClone(base)
  nonGpt.providers!['gateway-discovery'].models = [{ id: 'deepseek-v4.1-flash', contextWindow: 1, maxTokens: 1, input: ['text'], reasoningEfforts: [] }]
  assert.throws(() => resolveRoutes(Config(nonGpt)), (error: unknown) => error instanceof LlmError && error.code === 'INVALID_CONFIG')
})
